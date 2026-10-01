import assert from "node:assert/strict";
import test from "node:test";

import {
  createSerializableSet,
  type SerializableRuntimeScalar,
  type SerializableRuntimeSet,
} from "../src/index.js";
import {
  addSerializableSetValue,
  validateSerializableValue,
} from "../src/runtime/serializable-values.js";

test("serializable-set validation and construction preserve many unique scalars", () => {
  const items = Array.from({ length: 4096 }, (_, index) => index);

  assert.equal(validateSerializableValue({ kind: "set", items }), null);
  assert.deepEqual(createSerializableSet(items).items, items);
});

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
});

test("serializable set mutation ignores existing values and appends new values in order", () => {
  const set: SerializableRuntimeSet = { kind: "set", items: [1, 2] };
  const membership = new Set<SerializableRuntimeScalar>(set.items);
  assert.equal(addSerializableSetValue(set, 2, membership), false);
  assert.equal(addSerializableSetValue(set, 3, membership), true);
  assert.deepEqual(set.items, [1, 2, 3]);

  assert.equal(addSerializableSetValue(set, 3, membership), false);
  assert.deepEqual(set.items, [1, 2, 3]);
});
