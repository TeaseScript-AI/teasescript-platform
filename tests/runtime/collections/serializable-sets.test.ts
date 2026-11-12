import assert from "node:assert/strict";
import test from "node:test";

import {
  createSerializableSet,
  type SerializableRuntimeScalar,
  type SerializableRuntimeValue,
} from "../../../src/index.js";
import { validateSerializableValue } from "../../../src/runtime/values/serializable-values.js";
import { withValidationTestStatistics } from "../../../src/validation-testing.js";
import { COLLIDING_A, COLLIDING_B } from "../../helpers/colliding-texts.js";
import { firstDuplicate, nestedSetFamily } from "../../helpers/nested-set-family.js";

test("serializable-set validation does not impose the removed capture-work threshold", () => {
  const acceptedSize = 100_001;
  const accepted = Array.from({ length: acceptedSize }, (_, index) => index);

  assert.equal(validateSerializableValue({ kind: "set", items: accepted }), null);
  const constructed = createSerializableSet(accepted).items;
  assert.equal(constructed.length, acceptedSize);
  for (let index = 0; index < acceptedSize; index += 1) {
    assert.equal(constructed[index], index, `item ${index}`);
  }
});

test("serializable-set validation rejects early and late duplicates consistently", () => {
  const unique = Array.from({ length: 4096 }, (_, index) => index);
  for (const { name, items, duplicate } of [
    { name: "small unique control", items: [1, 2, 3], duplicate: false },
    { name: "early duplicate", items: [1, 1, 2, 3], duplicate: true },
    { name: "large unique control", items: unique, duplicate: false },
    { name: "late duplicate", items: [...unique, 0], duplicate: true },
  ]) {
    const failure = validateSerializableValue({ kind: "set", items });
    if (duplicate) {
      assert.ok(failure?.startsWith("$.items "), name);
    } else {
      assert.equal(failure, null, name);
    }
  }
});

test("serializable-set construction preserves scalar equality and insertion order", () => {
  const values: SerializableRuntimeScalar[] = [1, "1", true, false, null, 0, -0, 1, "1", true];

  assert.deepEqual(createSerializableSet(values).items, [1, "1", true, false, null, 0]);
  // The shared snapshot validator keeps scalars of different kinds distinct as well.
  assert.equal(validateSerializableValue(createSerializableSet(values)), null);
});

test("a constructed set owns copies of the caller's items and keeps the first of equal ones", () => {
  const inner = { kind: "list" as const, items: [1] };
  const items = [
    inner,
    { kind: "list" as const, items: [1] },
    { kind: "list" as const, items: [2] },
  ];
  const set = createSerializableSet(items);
  inner.items.push(9);
  items.push({ kind: "list", items: [3] });
  assert.equal(
    JSON.stringify(set),
    JSON.stringify({
      kind: "set",
      items: [
        { kind: "list", items: [1] },
        { kind: "list", items: [2] },
      ],
    }),
  );
  assert.equal(validateSerializableValue(set), null);
});

const list = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
  kind: "list",
  items,
});
const set = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
  kind: "set",
  items,
});
const object = (...parts: [string, SerializableRuntimeValue][]): SerializableRuntimeValue => ({
  kind: "object",
  properties: parts.map(([name, value]) => ({ name, value })),
});
const dict = (...parts: [string, SerializableRuntimeValue][]): SerializableRuntimeValue => ({
  kind: "dict",
  entries: parts.map(([key, value]) => ({ key, value })),
});

/** The failure and the print work of validating `value`. */
function validationWork(value: SerializableRuntimeValue): {
  failure: string | null;
  work: Record<string, number>;
} {
  return withValidationTestStatistics((finish) => {
    const failure = validateSerializableValue(value);
    const work = Object.fromEntries(
      Object.entries(finish().counts).filter(([name]) => name.startsWith("setValidation")),
    );
    return { failure, work };
  });
}

/** The length of a number's or a text's key, which a print hashes: `n<number>;` and `s<length>:<text>`. */
const numberKeyLength = (value: number): number => String(value).length + 2;
const textKeyLength = (text: string): number => String(text.length).length + 2 + text.length;

test("nested sets are validated once: a print per value below a set, not its whole key at every level", () => {
  const chain = (depth: number): SerializableRuntimeValue => {
    let value: SerializableRuntimeValue = 1;
    for (let level = 0; level < depth; level += 1) value = set(value);
    return value;
  };
  // Each set below the root has one part; the leaf is hashed once; one print is held at a time.
  for (const depth of [1024, 2048, 10_000]) {
    assert.deepEqual(validationWork(chain(depth)), {
      failure: null,
      work: {
        setValidationPrints: depth - 1,
        setValidationPrintParts: depth - 1,
        setValidationPrintTextUnits: numberKeyLength(1),
        setValidationPrintsRetainedPeak: 1,
      },
    });
  }

  // Lists, objects, dicts, and sets in turn below a set: one print each.
  const mixed = (depth: number): SerializableRuntimeValue => {
    let value: SerializableRuntimeValue = 1;
    for (let level = 1; level < depth; level += 1) {
      const kind = level % 4;
      value =
        kind === 0
          ? list(value)
          : kind === 1
            ? object(["v", value])
            : kind === 2
              ? dict(["k", value])
              : set(value);
    }
    return set(value);
  };
  for (const depth of [1024, 2048]) {
    const below = depth - 1;
    const labelled = Math.floor((below + 2) / 4) + Math.floor((below + 1) / 4);
    assert.deepEqual(validationWork(mixed(depth)), {
      failure: null,
      work: {
        setValidationPrints: below,
        setValidationPrintParts: below,
        setValidationPrintTextUnits: numberKeyLength(1) + labelled * textKeyLength("v"),
        setValidationPrintsRetainedPeak: 1,
      },
    });
  }

  // A wide set of lists holds a print per list; so does a set of wide sets, whose members are hashed, not held.
  for (const width of [4096, 8192]) {
    const members = Array.from({ length: width }, (_, index) => list(index, "x"));
    let textUnits = 0;
    for (let index = 0; index < width; index += 1)
      textUnits += numberKeyLength(index) + textKeyLength("x");
    assert.deepEqual(validationWork(set(...members)), {
      failure: null,
      work: {
        setValidationPrints: width,
        setValidationPrintParts: 2 * width,
        setValidationPrintTextUnits: textUnits,
        setValidationPrintsRetainedPeak: width,
      },
    });
  }
  for (const width of [64, 128]) {
    const members = Array.from({ length: width }, (_, outer) =>
      set(...Array.from({ length: width }, (_, inner) => outer * width + inner)),
    );
    let textUnits = 0;
    for (let index = 0; index < width * width; index += 1) textUnits += numberKeyLength(index);
    assert.deepEqual(validationWork(set(...members)), {
      failure: null,
      work: {
        setValidationPrints: width,
        setValidationPrintParts: width * width,
        setValidationPrintTextUnits: textUnits,
        setValidationPrintsRetainedPeak: width,
      },
    });
  }

  // Longer texts and names cost only the units hashed.
  for (const length of [8, 16]) {
    const name = "p".repeat(length);
    const text = "t".repeat(length);
    assert.deepEqual(validationWork(set(object([name, text]))), {
      failure: null,
      work: {
        setValidationPrints: 1,
        setValidationPrintParts: 1,
        setValidationPrintTextUnits: textKeyLength(name) + textKeyLength(text),
        setValidationPrintsRetainedPeak: 1,
      },
    });
  }

  // A comb of lists eight wide: while its deepest list is validated, every list above it holds the prints of its seven
  // finished lists.
  for (const depth of [8, 16]) {
    let value = list(1);
    for (let level = 0; level < depth; level += 1)
      value = list(...Array.from({ length: 7 }, (_, index) => list(index)), value);
    const { failure, work } = validationWork(set(value));
    assert.equal(failure, null);
    assert.equal(work.setValidationPrints, 8 * depth + 1);
    assert.equal(work.setValidationPrintsRetainedPeak, 7 * depth + 1);
    assert.equal(work.setValidationExactKeys, undefined);
  }

  // A set of values that hold no other values compares their keys and computes no print.
  assert.deepEqual(validationWork(set(...Array.from({ length: 1000 }, (_, index) => index))), {
    failure: null,
    work: {},
  });
});

test("a wide object or dict below a set is validated without sorting its parts", () => {
  // The base keyed such a member once, sorting its names (width - 1 comparisons when they are already in order).
  let comparisons = 0;
  const sort = Array.prototype.sort;
  const counted = (value: SerializableRuntimeValue) => {
    Array.prototype.sort = function <T>(this: T[], compare?: (left: T, right: T) => number): T[] {
      // EVIDENCE: invariant: Array.prototype.sort sorts its receiver, a T[], in place and returns it.
      return sort.call(
        this,
        compare === undefined
          ? undefined
          : (left: T, right: T) => {
              comparisons += 1;
              return compare(left, right);
            },
      ) as T[];
    };
    try {
      return validationWork(value);
    } finally {
      Array.prototype.sort = sort;
    }
  };
  for (const kind of ["object", "dict"] as const) {
    for (const width of [2048, 4096, 8192]) {
      const names = Array.from({ length: width }, (_, index) => String(index).padStart(6, "0"));
      const parts = names.map((name): [string, SerializableRuntimeValue] => [name, 0]);
      comparisons = 0;
      assert.deepEqual(counted(set(kind === "object" ? object(...parts) : dict(...parts))), {
        failure: null,
        work: {
          setValidationPrints: 1,
          setValidationPrintParts: width,
          setValidationPrintTextUnits: width * (textKeyLength("000000") + numberKeyLength(0)),
          setValidationPrintsRetainedPeak: 1,
        },
      });
      assert.equal(comparisons, 0, `${kind} ${width}`);
    }
  }
});

test("set members whose prints are equal are compared by their whole value", () => {
  const exactKeys = (value: SerializableRuntimeValue) => {
    const { failure, work } = validationWork(value);
    return [failure, work.setValidationExactKeys ?? 0];
  };
  const duplicate = "$.items contains a duplicate member.";
  const deep = (leaf: string): SerializableRuntimeValue => {
    let value: SerializableRuntimeValue = leaf;
    for (let level = 0; level < 1024; level += 1) value = list(value);
    return value;
  };
  for (const wrap of [
    (text: string) => list(text),
    (text: string) => set(text),
    (text: string) => object(["v", text]),
    (text: string) => dict(["k", text]),
    deep,
  ]) {
    const [a, b] = [wrap(COLLIDING_A), wrap(COLLIDING_B)];
    // Unequal values with one print: both stay.
    assert.deepEqual(exactKeys(set(a, b)), [null, 2]);
    // An equal value with the same print is a duplicate, also after a colliding one.
    assert.deepEqual(exactKeys(set(a, wrap(COLLIDING_A))), [duplicate, 2]);
    assert.deepEqual(exactKeys(set(a, b, wrap(COLLIDING_A))), [duplicate, 3]);
  }
  // The texts themselves are compared by their keys.
  assert.deepEqual(exactKeys(set(COLLIDING_A, COLLIDING_B)), [null, 0]);
  assert.deepEqual(exactKeys(set(set(list(COLLIDING_A)), set(list(COLLIDING_B)))), [null, 2]);
});

test("set validation reports the first problem in member order, inner sets first, and keeps == classes", () => {
  const timer = (timerId: number): SerializableRuntimeValue => ({ kind: "timerHandle", timerId });
  const speaker = (identifier: string): SerializableRuntimeValue => ({
    kind: "speakerReference",
    speakerId: 1,
    identifier,
  });
  const regex = (flags: string): SerializableRuntimeValue => ({
    kind: "regex",
    source: "a",
    flags,
  });
  // EVIDENCE: fixture: an unsupported kind deliberately violates the runtime-value contract.
  const unsupported = { kind: "unsupported" } as never;
  for (const [value, expected] of [
    // Every member is validated before the set compares them.
    [set(list(0), list(0), unsupported), "$.items[2].kind is unsupported."],
    [set(set(0, 0), set(0, 0)), "$.items[0].items contains a duplicate member."],
    [
      object(["v", set(list(1), list(1))]),
      "$.properties[0].value.items contains a duplicate member.",
    ],
    [list(set(list(1)), set(list(2), list(2))), "$.items[1].items contains a duplicate member."],
    // Equal by ==: sets, objects, and dicts in any order, -0 and 0, a speaker by its identity.
    [set(set(1, 2), set(2, 1)), "$.items contains a duplicate member."],
    [
      set(object(["a", 1], ["b", 2]), object(["b", 2], ["a", 1])),
      "$.items contains a duplicate member.",
    ],
    [
      set(dict(["a", 1], ["b", 2]), dict(["b", 2], ["a", 1])),
      "$.items contains a duplicate member.",
    ],
    [set(list(0), list(-0)), "$.items contains a duplicate member."],
    [set(list(speaker("a")), list(speaker("b"))), "$.items contains a duplicate member."],
    // Unequal: kinds of scalars, handles, regex flags, list order, an object and a dict.
    [set(list(1), list("1"), list(true), list(null)), null],
    [set(list(timer(1)), list(timer(2))), null],
    [set(list(regex("")), list(regex("i"))), null],
    [set(list(1, 2), list(2, 1)), null],
    [set(object(["a", 1]), dict(["a", 1]), list(set()), list(list())), null],
  ] as const) {
    assert.equal(validateSerializableValue(value), expected, JSON.stringify(value));
  }
});

test("set validation finds the duplicates an independent pairwise comparison finds", () => {
  let duplicates = 0;
  for (const value of nestedSetFamily(2026, 2000)) {
    const expected = firstDuplicate(value);
    if (expected !== null) duplicates += 1;
    assert.equal(validateSerializableValue(value), expected, JSON.stringify(value));
  }
  // Both outcomes are well represented.
  assert.ok(duplicates > 300 && duplicates < 1700, `${duplicates} duplicates`);
});
