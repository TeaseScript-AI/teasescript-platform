import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneSerializableValue,
  createSerializableSet,
  type SerializableRuntimeScalar,
  type SerializableRuntimeSet,
} from "../src/index.js";
import {
  SerializableValueError,
  addSerializableSetValue,
  validateSerializableValue,
} from "../src/runtime/serializable-values.js";

test("serializable-set validation and construction accept unique scalars", () => {
  const items: SerializableRuntimeScalar[] = ["alpha", 1, true, null, -2.5, false, "1"];

  assert.equal(validateSerializableValue({ kind: "set", items }), null);
  assert.deepEqual(createSerializableSet(items).items, items);
});

test("serializable-set validation does not impose the removed capture-work threshold", () => {
  const acceptedSize = 100_001;
  const accepted = Array.from({ length: acceptedSize }, (_, index) => index);

  assert.equal(validateSerializableValue({ kind: "set", items: accepted }), null);
  assert.deepEqual(createSerializableSet(accepted).items, accepted);
});

test("serializable-set validation rejects early and late duplicates consistently", () => {
  const broad = Array.from({ length: 4096 }, (_, index) => index);
  const cases: ReadonlyArray<
    readonly [string, readonly SerializableRuntimeScalar[], readonly SerializableRuntimeScalar[]]
  > = [
    ["early duplicate", [1, 2, 3], [1, 1, 2, 3]],
    ["late duplicate", broad, [...broad, 0]],
  ];
  for (const [name, unique, duplicated] of cases) {
    assert.equal(validateSerializableValue({ kind: "set", items: [...unique] }), null, name);
    assert.ok(
      validateSerializableValue({ kind: "set", items: [...duplicated] })?.startsWith("$.items "),
      name,
    );
    assert.throws(
      () => cloneSerializableValue({ kind: "set", items: [...duplicated] }),
      (error: unknown) => error instanceof SerializableValueError && error.code === "invalid",
      name,
    );
  }
});

test("serializable-set construction preserves scalar equality and insertion order", () => {
  const values: SerializableRuntimeScalar[] = [1, "1", true, false, null, 0, -0, 1, "1", true];

  assert.deepEqual(createSerializableSet(values).items, [1, "1", true, false, null, 0]);
});

test("serializable set mutation adds only new values without changing array order", () => {
  const set: SerializableRuntimeSet = { kind: "set", items: [1, 2] };
  const membership = new Set<SerializableRuntimeScalar>(set.items);
  assert.equal(addSerializableSetValue(set, 2, membership), false);
  assert.equal(addSerializableSetValue(set, 3, membership), true);
  assert.equal(addSerializableSetValue(set, 3, membership), false);

  assert.deepEqual(set.items, [1, 2, 3]);
});
