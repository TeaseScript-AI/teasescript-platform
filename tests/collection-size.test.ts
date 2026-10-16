import assert from "node:assert/strict";
import test from "node:test";

import { createFreshRuntimeSession, restoreRuntimeSession } from "../src/runtime/session.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

const IMMEDIATE = { seed: 5, baseDelayMs: 0, delayPerWordMs: 0, delayPerCharacterMs: 0 } as const;

/**
 * V8 refuses an array past 134,217,728 elements and a `Set` or `Map` past 16,777,216 entries, which take seconds and
 * gigabytes to reach. Each case makes the native that its operation grows with fail the same way past `CAP` instead.
 */
const CAP = 1_000;

type GrowingNative = "push" | "concat" | "Array.from" | "Set.add" | "Map.set";

/** Makes `native` fail as V8 does past its limit, past `CAP` instead, until the returned function restores it. */
function failPastCap(native: GrowingNative): () => void {
  switch (native) {
    case "push": {
      const push = Array.prototype.push;
      return replace(Array.prototype, "push", function (this: unknown[], ...items: unknown[]) {
        if (this.length + items.length > CAP) throw new RangeError("Invalid array length");
        return push.call(this, ...items);
      });
    }
    case "concat": {
      const concat = Array.prototype.concat;
      return replace(Array.prototype, "concat", function (this: unknown[], ...parts: unknown[]) {
        const joined = concat.call(this, ...parts);
        if (joined.length > CAP) throw new RangeError("Invalid array length");
        return joined;
      });
    }
    case "Array.from": {
      const from = Array.from;
      // EVIDENCE: test: `split("")` calls `Array.from` with one iterable, which this replacement passes on.
      return replace(Array, "from", ((source: Iterable<unknown>) => {
        const made = from(source);
        if (made.length > CAP) throw new RangeError("Invalid array length");
        return made;
      }) as typeof Array.from);
    }
    case "Set.add": {
      const add = Set.prototype.add;
      return replace(Set.prototype, "add", function (this: Set<unknown>, value: unknown) {
        if (!this.has(value) && this.size >= CAP) throw new RangeError("Set maximum size exceeded");
        return add.call(this, value);
      });
    }
    case "Map.set": {
      const set = Map.prototype.set;
      return replace(
        Map.prototype,
        "set",
        function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
          if (!this.has(key) && this.size >= CAP) throw new RangeError("Map maximum size exceeded");
          return set.call(this, key, value);
        },
      );
    }
  }
}

/** Replaces a method; `node:test` mocks no method of `Array.prototype`, which is an array. */
function replace<T extends object, K extends keyof T>(
  object: T,
  name: K,
  method: T[K],
): () => void {
  const original = Object.getOwnPropertyDescriptor(object, name)!;
  Object.defineProperty(object, name, { ...original, value: method });
  return () => Object.defineProperty(object, name, original);
}

const CASES: readonly (readonly [GrowingNative, string, number])[] = [
  ["push", "let xs = [1]\nrepeat 11 {\n  xs = xs + xs\n}\nexit", 3],
  ["push", "let xs = [1]\nrepeat 11 {\n  xs += xs\n}\nexit", 3],
  ["push", "let xs = [1]\nrepeat 11 {\n  xs.addAll(xs)\n}\nexit", 3],
  ["concat", "let xs = (1..=600).toList()\nlet ys = xs + xs\nexit", 2],
  ["Array.from", 'let text = "x".repeat(1500)\nlet parts = text.split("")\nexit', 2],
  ["push", 'let text = ",".repeat(1500)\nlet parts = text.split(",")\nexit', 2],
  [
    "push",
    'let text = "[" + "0,".repeat(1500) + "0]"\nlet read = fromJson(text, default: null)\nexit',
    2,
  ],
  [
    "Map.set",
    'let keys = (1..=1500).toList()\nlet text = "{\\"k" + keys.join("\\": 0, \\"k") + "\\": 0}"\nlet read = fromJson(text, default: null)\nexit',
    3,
  ],
  ["Set.add", "let xs = (1..=1500).toList()\nlet members = xs.toSet()\nexit", 2],
  [
    "Set.add",
    "let xs = (1..=800).toList()\nlet ys = (801..=1600).toList()\nlet both = xs.union(ys)\nexit",
    3,
  ],
];

test("a list, set, or dict that grows past what V8 holds fails with TSR088, and the session stays usable", () => {
  for (const [native, source, line] of CASES) {
    const plan = compileValidPlan(source);
    const session = createFreshRuntimeSession(plan, IMMEDIATE);
    const restore = failPastCap(native);
    try {
      session.run();
    } finally {
      restore();
    }
    const failure = session.view().failure;
    assert.deepEqual(
      [failure?.code, failure === null ? null : failure.span.start.line + 1, failure?.message],
      [
        "TSR088",
        line,
        "Collection too large: this line would make a list, set, or dict larger than this browser can hold. Build a smaller one.",
      ],
      source,
    );
    assert.deepEqual(restoreRuntimeSession(session.exportCheckpoint()).view().failure, failure);
  }
});
