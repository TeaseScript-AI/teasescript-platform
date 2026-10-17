import assert from "node:assert/strict";
import test from "node:test";

import { serializeCheckpoint } from "../src/runtime/checkpoint.js";
import {
  createFreshRuntimeSession,
  deserializeRuntimeSession,
  restoreRuntimeSession,
  type RuntimeSession,
} from "../src/runtime/session.js";
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

/*
 * A list holds at most 1,000,000 elements, a set 1,000,000 members, and a dict 1,000,000 keys, and an operation that
 * would make one longer is runtime error `TSR088` (owner decision, 2026-10-17). Each case makes a collection of exactly
 * the limit through an operation, says its length, and makes it one longer through the same operation.
 */

const list = (operation: string, length: string): string =>
  `List too long: ${operation} would make a list of ${length} elements, but a list can hold at most 1,000,000. Build a shorter list.`;
const set = (operation: string, length: string): string =>
  `Set too long: ${operation} would make a set of ${length} members, but a set can hold at most 1,000,000. Build a shorter set.`;
const dict = (operation: string, length: string): string =>
  `Dict too long: ${operation} would make a dict of ${length} keys, but a dict can hold at most 1,000,000. Build a shorter dict.`;

/** JSON of an object with the keys `k1` to `k<count>`, written in TeaseScript. */
const jsonKeys = (count: number): string =>
  `let keys = (1..=${count}).toList()\nlet text = "{\\"k" + keys.join("\\": 0, \\"k") + "\\": 0}"`;

/** What `session` said when it ran, and how it failed: code, message, and the source its span covers. */
function ranUntilFailure(
  session: RuntimeSession,
  source: string,
): [string[], [string, string, string] | null] {
  const said = session.run().events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
  const failure = session.view().failure;
  return [
    said,
    failure === null
      ? null
      : [
          failure.code,
          failure.message,
          source.slice(failure.span.start.offset, failure.span.end.offset),
        ],
  ];
}

const LIMIT_CASES: readonly (readonly [string, readonly string[], string, string])[] = [
  [
    "let half = (1..=500000).toList()\nlet xs = half + half\nsay xs.length\nlet ys = xs + [0]",
    ["1000000"],
    list("joining with +", "1,000,001"),
    "xs + [0]",
  ],
  [
    "let xs = (1..=500000).toList()\nxs += xs\nsay xs.length\nxs += [0]",
    ["1000000"],
    list("joining with +", "1,000,001"),
    "xs += [0]",
  ],
  [
    "let xs = (1..=999999).toList()\nxs.add(0)\nsay xs.length\nxs.add(0)",
    ["1000000"],
    list("add(...)", "1,000,001"),
    "xs.add(0)",
  ],
  [
    "let xs = (1..=999998).toList()\nxs.addAll([0, 0])\nsay xs.length\nxs.addAll(xs)",
    ["1000000"],
    list("addAll(...)", "2,000,000"),
    "xs.addAll(xs)",
  ],
  // A character of two UTF-16 code units is one part.
  [
    'let text = "\u{1F600}".repeat(1000000)\nsay text.split("").length\nlet parts = (text + "x").split("")',
    ["1000000"],
    list("split(...)", "1,000,001"),
    '(text + "x").split("")',
  ],
  [
    'let text = ",".repeat(999999)\nsay text.split(",").length\nlet parts = (text + ",").split(",")',
    ["1000000"],
    list("split(...)", "1,000,001"),
    '(text + ",").split(",")',
  ],
  // Text that is not JSON gives the default, however long its arrays are.
  [
    'let text = "[" + "0,".repeat(999999) + "0]"\nsay fromJson(text, default: null).length\nsay fromJson(text + "]", default: "not JSON")\nlet read = fromJson("[0," + text.substring(1), default: null)',
    ["1000000", "not JSON"],
    list("fromJson(...)", "1,000,001"),
    'fromJson("[0," + text.substring(1), default: null)',
  ],
  [
    'let text = "[" + "0,".repeat(999999) + "0]"\nsay fromJson(text, default: null, files: false).length\nlet read = fromJson("[0," + text.substring(1), default: null, files: false)',
    ["1000000"],
    list("fromJson(...)", "1,000,001"),
    'fromJson("[0," + text.substring(1), default: null, files: false)',
  ],
  [
    "let low = (1..=600000).toList()\nlet xs = low.union((400001..=1000000).toList())\nsay xs.length\nlet ys = xs.union([0])",
    ["1000000"],
    list("union(...)", "1,000,001"),
    "xs.union([0])",
  ],
  // Adding a member the set has already makes it no longer.
  [
    "let members = (1..=999999).toList().toSet()\nmembers.add(0)\nmembers.add(5)\nsay members.length\nmembers.add(-1)",
    ["1000000"],
    set("add(...)", "1,000,001"),
    "members.add(-1)",
  ],
  [
    "let members = (1..=1000000).toList().toSet()\nsay members.length\nlet more = members.union([0, -1])",
    ["1000000"],
    set("union(...)", "1,000,002"),
    "members.union([0, -1])",
  ],
  // Assigning to a key the dict has already makes it no longer.
  [
    `${jsonKeys(999999)}\nlet scores = fromJson(text, default: null)\nscores["new"] = 1\nscores["k5"] = 2\nsay scores.length\nscores["other"] = 1`,
    ["1000000"],
    dict("assigning to a new key", "1,000,001"),
    'scores["other"]',
  ],
  // A repeated key keeps its first position, so it makes the dict no longer.
  [
    `${jsonKeys(1000000)}\nsay fromJson(text.substring(0, text.length - 1) + ", \\"k1\\": 1}", default: null).length\nlet read = fromJson("{\\"k0\\": 0, " + text.substring(1), default: null)`,
    ["1000000"],
    dict("fromJson(...)", "1,000,001"),
    'fromJson("{\\"k0\\": 0, " + text.substring(1), default: null)',
  ],
];

test("each operation makes a list, set, or dict of exactly the limit and refuses one longer with TSR088", () => {
  for (const [lines, said, message, marked] of LIMIT_CASES) {
    const source = `${lines}\nexit`;
    const session = createFreshRuntimeSession(compileValidPlan(source), IMMEDIATE);
    assert.deepEqual(ranUntilFailure(session, source), [said, ["TSR088", message, marked]], source);
  }
});

// `toSet()` checks the set it makes, which only a list longer than the limit can make too long.
test("a checkpoint holding a longer list restores, and toSet() of that list is refused", () => {
  const source =
    "let xs = (1..=1000000).toList()\nwait 1 s\nsay xs.length\nlet members = xs.toSet()\nexit";
  const session = createFreshRuntimeSession(compileValidPlan(source), IMMEDIATE);
  session.run();
  // A session saved before the limit, holding one element more.
  const checkpoint = JSON.parse(serializeCheckpoint(session.exportCheckpoint()));
  checkpoint.snapshot.frames[0].bindings
    .find((binding: { name: string }) => binding.name === "xs")
    .value.items.push(1000001);
  const restored = deserializeRuntimeSession(JSON.stringify(checkpoint));
  restored.observeTime(1_000);
  assert.deepEqual(ranUntilFailure(restored, source), [
    ["1000001"],
    ["TSR088", set("toSet()", "1,000,001"), "xs.toSet()"],
  ]);
});
