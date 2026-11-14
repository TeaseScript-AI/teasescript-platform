import assert from "node:assert/strict";
import test from "node:test";

import { fromCanonical, toCanonical } from "../../../src/runtime/native/values/codec.js";
import { copyNativeValue } from "../../../src/runtime/native/values/copy.js";
import { nativeEquals } from "../../../src/runtime/native/values/equality.js";
import { NativeSet } from "../../../src/runtime/native/values/native-set.js";
import {
  NativeDict,
  NativeObject,
  type NativeValue,
} from "../../../src/runtime/native/values/native-value.js";
import { nativeValueKey } from "../../../src/runtime/native/values/value-key.js";
import {
  addSerializableSetValue,
  clearSerializableSet,
  createCapturedSerializableSet,
  removeSerializableSetValue,
  serializableEquals,
  serializableSetContains,
  validateSerializableValue,
  valueKey,
  type SerializableRuntimeSet,
  type SerializableRuntimeValue,
} from "../../../src/runtime/values/serializable-values.js";

// The native values (`src/runtime/native/values/`) against today's canonical value functions, which decide what `==`,
// a set's members and a value's order are: every generated valid value converts both ways unchanged, has today's key,
// compares as today, copies without sharing a mutable part, and builds the sets today's functions build.

/** xorshift32: the same values for the same seed in every run. */
function random(seed: number): (bound: number) => number {
  let state = seed >>> 0 || 1;
  return (bound) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % bound;
  };
}

/**
 * Every leaf kind as separate objects: an unequal pair for each kind with fields, one camera view, and an extra
 * duration record forming an equal pair.
 */
const LEAVES: readonly SerializableRuntimeValue[] = [
  { kind: "duration", milliseconds: 2000 },
  { kind: "duration", milliseconds: 2000 },
  { kind: "duration", milliseconds: -0 },
  { kind: "calendarDuration", months: 1, days: 2, milliseconds: 3 },
  { kind: "calendarDuration", months: 1, days: 3, milliseconds: 3 },
  { kind: "angle", degrees: 90 },
  { kind: "angle", degrees: 45 },
  { kind: "date", year: 2026, month: 10, day: 4 },
  { kind: "date", year: 2026, month: 10, day: 5 },
  { kind: "time", hour: 14, minute: 30, second: 0, millisecond: 5 },
  { kind: "time", hour: 14, minute: 30, second: 1, millisecond: 5 },
  {
    kind: "datetime",
    year: 2026,
    month: 10,
    day: 4,
    hour: 1,
    minute: 2,
    second: 3,
    millisecond: 4,
  },
  {
    kind: "datetime",
    year: 2026,
    month: 10,
    day: 4,
    hour: 1,
    minute: 2,
    second: 3,
    millisecond: 5,
  },
  { kind: "absoluteDateTime", epochMilliseconds: 0 },
  { kind: "absoluteDateTime", epochMilliseconds: 1 },
  { kind: "script", path: "rooms/a.tease" },
  { kind: "script", path: "rooms/b.tease" },
  { kind: "regex", source: "x+", flags: "i" },
  { kind: "regex", source: "x+", flags: "" },
  { kind: "range", start: 1, end: 3, inclusive: true },
  { kind: "range", start: 1, end: 3, inclusive: false },
  { kind: "speakerReference", speakerId: 0, identifier: "anna" },
  { kind: "speakerReference", speakerId: 1, identifier: "bea" },
  { kind: "timerHandle", timerId: 1 },
  { kind: "timerHandle", timerId: 2 },
  { kind: "mediaHandle", mediaId: 1 },
  { kind: "mediaHandle", mediaId: 2 },
  { kind: "cameraView" },
  { kind: "permanentButtonHandle", buttonId: 2 },
  { kind: "permanentButtonHandle", buttonId: 3 },
  { kind: "messageHandle", messageId: 3 },
  { kind: "messageHandle", messageId: 4 },
];

/** Texts with a surrogate pair, a lone surrogate, integer-like names and a name longer than an exact set key. */
const TEXTS = ["", "a", "b", "0", "10", "2", "😀", "\ud800", "z".repeat(40), "n1;"] as const;
const SCALARS: readonly SerializableRuntimeValue[] = [
  0,
  -0,
  1,
  2.5,
  -7,
  1e21,
  true,
  false,
  null,
  ...TEXTS,
];

function generate(next: (bound: number) => number, depth: number): SerializableRuntimeValue {
  const choice = next(depth > 0 ? 10 : 6);
  if (choice < 4) return SCALARS[next(SCALARS.length)]!;
  if (choice < 6) return LEAVES[next(LEAVES.length)]!;
  const width = next(5);
  const parts = Array.from({ length: width }, () => generate(next, depth - 1));
  switch (choice) {
    case 6:
      return { kind: "list", items: parts };
    case 7:
      // Today's function decides which of equal items stays.
      return createCapturedSerializableSet(parts);
    case 8: {
      // An object's property names are not empty.
      const names = [...new Set(parts.map(() => TEXTS[1 + next(TEXTS.length - 1)]!))];
      return { kind: "object", properties: names.map((name, at) => ({ name, value: parts[at]! })) };
    }
    default: {
      const keys = [...new Set(parts.map(() => TEXTS[next(TEXTS.length)]!))];
      return { kind: "dict", entries: keys.map((key, at) => ({ key, value: parts[at]! })) };
    }
  }
}

/** An equal value written another way: object, dict and set parts reversed, `0` and `-0` swapped, leaves copied. */
function rewritten(value: SerializableRuntimeValue): SerializableRuntimeValue {
  if (value === 0) return Object.is(value, -0) ? 0 : -0;
  if (value === null || typeof value !== "object") return value;
  switch (value.kind) {
    case "list":
      return { kind: "list", items: value.items.map(rewritten) };
    case "set":
      return { kind: "set", items: value.items.map(rewritten).reverse() };
    case "object":
      return {
        kind: "object",
        properties: value.properties
          .map((p) => ({ name: p.name, value: rewritten(p.value) }))
          .reverse(),
      };
    case "dict":
      return {
        kind: "dict",
        entries: value.entries.map((e) => ({ key: e.key, value: rewritten(e.value) })).reverse(),
      };
    default:
      return { ...value };
  }
}

/** Changes every mutable part of a native value in place, so a shared part would show in another value's form. */
function changeEverything(value: NativeValue): void {
  const work: NativeValue[] = [value];
  while (work.length > 0) {
    const current = work.pop()!;
    if (Array.isArray(current)) {
      work.push(...current);
      current.push("changed");
    } else if (current instanceof NativeObject) {
      work.push(...current.properties.values());
      current.properties.set("changed", 1);
    } else if (current instanceof NativeDict) {
      work.push(...current.entries.values());
      current.entries.set("changed", 1);
    } else if (current instanceof NativeSet) {
      // Its members are changed too, which a set never does, to find a member shared with another value.
      work.push(...current.items);
      current.add("changed-member");
    }
  }
}

const json = (value: SerializableRuntimeValue): string => JSON.stringify(value);

function sample(seed: number, count: number, depth: number): SerializableRuntimeValue[] {
  const next = random(seed);
  const values = Array.from({ length: count }, () => generate(next, depth));
  for (const value of values) assert.equal(validateSerializableValue(value), null, json(value));
  return values;
}

test("a valid value converts to native and back unchanged, with today's key", () => {
  for (const value of sample(1, 3000, 4)) {
    const before = json(value);
    const native = fromCanonical(value);
    assert.equal(json(toCanonical(native)), before);
    assert.equal(nativeValueKey(native), valueKey(value));
    assert.equal(validateSerializableValue(toCanonical(native)), null);
  }
});

test("== on native values decides as today, and equal values have equal keys", () => {
  const values = sample(2, 1500, 3);
  const next = random(3);
  for (const value of values) {
    const others = [
      rewritten(value),
      values[next(values.length)]!,
      rewritten(values[next(values.length)]!),
    ];
    for (const other of others) {
      const expected = serializableEquals(value, other);
      const left = fromCanonical(value);
      const right = fromCanonical(other);
      assert.equal(nativeEquals(left, right), expected, `${json(value)} == ${json(other)}`);
      assert.equal(nativeEquals(right, left), expected, `${json(other)} == ${json(value)}`);
      assert.equal(nativeValueKey(left) === nativeValueKey(right), expected);
    }
  }
});

test("conversions and copies share no mutable part with their source", () => {
  for (const value of sample(4, 1500, 4)) {
    const before = json(value);
    const native = fromCanonical(value);
    const copy = copyNativeValue(native);
    assert.ok(nativeEquals(copy, native));
    assert.equal(json(toCanonical(copy)), before);
    changeEverything(copy);
    assert.equal(json(toCanonical(native)), before, "the copy shares a part with its source");
    const exported = toCanonical(native);
    changeEverything(native);
    assert.equal(json(value), before, "the native value shares a part with its canonical source");
    assert.equal(json(exported), before, "the canonical form shares a part with its native source");
  }
});

test("sets add, find, remove and clear members as today's sets do", () => {
  const next = random(5);
  // Members that repeat by `==` in other forms, and long ones, whose keys are hashed.
  const pool = sample(6, 60, 2).flatMap((value) => [value, rewritten(value)]);
  pool.push(
    { kind: "list", items: ["z".repeat(40)] },
    { kind: "list", items: ["z".repeat(40), 1] },
  );
  for (let round = 0; round < 40; round += 1) {
    const items = Array.from({ length: next(30) }, () => pool[next(pool.length)]!);
    const canonical: SerializableRuntimeSet = createCapturedSerializableSet(items);
    const native = NativeSet.of(items.map(fromCanonical));
    assert.equal(json(toCanonical(native)), json(canonical));
    for (let step = 0; step < 60; step += 1) {
      const member = pool[next(pool.length)]!;
      const operation = next(10);
      if (operation < 4)
        assert.equal(native.add(fromCanonical(member)), addSerializableSetValue(canonical, member));
      else if (operation < 7)
        assert.equal(
          native.remove(fromCanonical(member)),
          removeSerializableSetValue(canonical, member),
        );
      else if (operation < 9)
        assert.equal(native.has(fromCanonical(member)), serializableSetContains(canonical, member));
      else {
        native.clear();
        clearSerializableSet(canonical);
      }
      assert.equal(json(toCanonical(native)), json(canonical));
    }
  }
});

/**
 * Two lists whose keys (46 long, so hashed) differ but share one cyrb53 hash: the second member of a hashed key's bucket
 * (found by a birthday search over three code units).
 */
const COLLIDING: readonly [SerializableRuntimeValue, SerializableRuntimeValue] = [
  { kind: "list", items: [`a\u5059\u375aa${"b".repeat(36)}`] },
  { kind: "list", items: [`a\u5179\u2caa\u6cd1${"b".repeat(36)}`] },
];

test("members whose long keys share a hash stay apart, as in today's sets", () => {
  const [first, second] = COLLIDING;
  assert.notEqual(valueKey(first), valueKey(second));
  const canonical = createCapturedSerializableSet([first]);
  const native = NativeSet.of([fromCanonical(first)]);
  const steps: Array<readonly [string, () => boolean, () => boolean]> = [
    [
      "has second",
      () => native.has(fromCanonical(second)),
      () => serializableSetContains(canonical, second),
    ],
    [
      "add second",
      () => native.add(fromCanonical(second)),
      () => addSerializableSetValue(canonical, second),
    ],
    [
      "add first again",
      () => native.add(fromCanonical(first)),
      () => addSerializableSetValue(canonical, first),
    ],
    [
      "add second again",
      () => native.add(fromCanonical(second)),
      () => addSerializableSetValue(canonical, second),
    ],
    [
      "remove first",
      () => native.remove(fromCanonical(first)),
      () => removeSerializableSetValue(canonical, first),
    ],
    [
      "has second after",
      () => native.has(fromCanonical(second)),
      () => serializableSetContains(canonical, second),
    ],
    [
      "has first after",
      () => native.has(fromCanonical(first)),
      () => serializableSetContains(canonical, first),
    ],
    [
      "remove first again",
      () => native.remove(fromCanonical(first)),
      () => removeSerializableSetValue(canonical, first),
    ],
  ];
  for (const [step, mine, today] of steps) {
    assert.equal(mine(), today(), step);
    assert.equal(json(toCanonical(native)), json(canonical), step);
  }
  const both: SerializableRuntimeValue = { kind: "set", items: [first, second] };
  const restored = fromCanonical(both);
  assert.ok(restored instanceof NativeSet);
  assert.ok(restored.remove(fromCanonical(second)));
  assert.equal(json(toCanonical(restored)), json({ kind: "set", items: [first] }));
  assert.equal(
    nativeEquals(
      fromCanonical({ kind: "set", items: [first] }),
      fromCanonical({ kind: "set", items: [second] }),
    ),
    false,
  );
});

test("values 10,000 deep convert, copy, compare and key without native recursion", () => {
  const kinds = ["list", "set", "object", "dict"] as const;
  let value: SerializableRuntimeValue = 1;
  for (let depth = 0; depth < 10_000; depth += 1) {
    const kind = kinds[depth % 4]!;
    value =
      kind === "list" || kind === "set"
        ? { kind, items: [value] }
        : kind === "object"
          ? { kind, properties: [{ name: "a", value }] }
          : { kind, entries: [{ key: "a", value }] };
  }
  const native = fromCanonical(value);
  const copy = copyNativeValue(native);
  assert.ok(nativeEquals(native, copy));
  assert.ok(serializableEquals(toCanonical(copy), value));
  assert.equal(nativeValueKey(copy), valueKey(value));
});

test("a set's members and index change only through its methods", () => {
  const set = NativeSet.of([1]);
  assert.ok(set.has(1));
  // Writes from outside that compiled before the storage was private; they never run.
  const typed = () => {
    // @ts-expect-error -- `items` is a read-only view.
    set.items.push(2);
    // @ts-expect-error -- `items` has no setter.
    set.items = [];
    // @ts-expect-error -- the index is private.
    set.membership = null;
  };
  assert.equal(typeof typed, "function");
  // Past the types, a `membership` written from outside is a property the set never reads.
  Object.assign(set, { membership: { scalars: new Set([2]), keyed: new Map() } });
  assert.equal(set.has(2), false);
  assert.ok(set.add(2));
  assert.deepEqual(set.items, [1, 2]);
});

test("a set of 10,000 distinct lists keeps each once", () => {
  const items: NativeValue[] = Array.from({ length: 10_000 }, (_, at) => [at, "z".repeat(at % 50)]);
  const set = NativeSet.of([...items, ...items.map(copyNativeValue)]);
  assert.equal(set.items.length, 10_000);
  for (const item of items) assert.ok(set.has(copyNativeValue(item)));
});
