import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTERNAL_DATA_WORK_MESSAGE,
  MAX_EXTERNAL_RUNTIME_DATA_WORK,
  createSerializableSet,
  type SerializableRuntimeScalar,
  type SerializableRuntimeSet,
} from "../src/index.js";
import {
  addSerializableSetValue,
  fromHostRuntimeValue,
  toHostRuntimeValue,
  validateSerializableValue,
} from "../src/runtime/serializable-values.js";
import { createRuntimeSet } from "../src/runtime/values.js";

function countArraySomeCalls(operation: () => void): number {
  const original = Array.prototype.some;
  let calls = 0;
  Array.prototype.some = function countedSome<T>(
    this: T[],
    predicate: (value: T, index: number, array: T[]) => unknown,
    thisArg?: unknown,
  ): boolean {
    return original.call(this, (value: T, index: number, array: T[]) => {
      calls += 1;
      return predicate.call(thisArg, value, index, array);
    });
  } as typeof Array.prototype.some;
  try {
    operation();
  } finally {
    Array.prototype.some = original;
  }
  return calls;
}

test("serializable-set validation and construction avoid repeated linear scans", () => {
  const items = Array.from({ length: 4096 }, (_, index) => index);

  const validationSomeCalls = countArraySomeCalls(() => {
    assert.equal(validateSerializableValue({ kind: "set", items }), null);
  });
  const constructionSomeCalls = countArraySomeCalls(() => {
    assert.equal(createSerializableSet(items).items.length, items.length);
  });

  assert.equal(validationSomeCalls, 0);
  assert.equal(constructionSomeCalls, 0);
});

test("serializable-set validation accepts the largest unique set within the work limit", () => {
  const acceptedSize = MAX_EXTERNAL_RUNTIME_DATA_WORK - 3;
  const accepted = Array.from({ length: acceptedSize }, (_, index) => index);

  assert.equal(
    validateSerializableValue({ kind: "set", items: accepted }),
    null,
  );
  assert.equal(createSerializableSet(accepted).items.length, acceptedSize);

  const rejected = [...accepted, acceptedSize];
  assert.equal(
    validateSerializableValue({ kind: "set", items: rejected }),
    EXTERNAL_DATA_WORK_MESSAGE,
  );
});

test("serializable-set validation rejects early and late duplicates consistently", () => {
  assert.equal(
    validateSerializableValue({ kind: "set", items: [1, 1, 2, 3] }),
    "$.items contains a duplicate scalar.",
  );
  assert.equal(
    validateSerializableValue({
      kind: "set",
      items: [...Array.from({ length: 4096 }, (_, index) => index), 0],
    }),
    "$.items contains a duplicate scalar.",
  );
});

test("serializable-set construction preserves scalar equality and insertion order", () => {
  const values: SerializableRuntimeScalar[] = [
    1,
    "1",
    true,
    false,
    null,
    0,
    -0,
    1,
    "1",
    true,
  ];

  assert.deepEqual(createSerializableSet(values).items, [
    1,
    "1",
    true,
    false,
    null,
    0,
  ]);
});

test("serializable set mutation uses native membership without changing array order", () => {
  const set: SerializableRuntimeSet = { kind: "set", items: [1, 2] };
  const membership = new Set<SerializableRuntimeScalar>(set.items);
  const someCalls = countArraySomeCalls(() => {
    assert.equal(addSerializableSetValue(set, 2, membership), false);
    assert.equal(addSerializableSetValue(set, 3, membership), true);
  });

  assert.equal(someCalls, 0);
  assert.deepEqual(set.items, [1, 2, 3]);
});

test("host and runtime set conversion paths rebuild sets without array scans", () => {
  const values = Array.from({ length: 4096 }, (_, index) => index);

  const hostToSerializableSomeCalls = countArraySomeCalls(() => {
    const converted = fromHostRuntimeValue({ kind: "set", items: values });
    assert.equal(
      typeof converted === "object" && converted !== null && converted.kind === "set"
        ? converted.items.length
        : -1,
      values.length,
    );
  });
  const serializableToHostSomeCalls = countArraySomeCalls(() => {
    const converted = toHostRuntimeValue({ kind: "set", items: values });
    assert.equal(
      typeof converted === "object" && converted !== null && converted.kind === "set"
        ? converted.items.length
        : -1,
      values.length,
    );
  });
  const runtimeConstructionSomeCalls = countArraySomeCalls(() => {
    assert.equal(createRuntimeSet(values).items.length, values.length);
  });

  assert.equal(hostToSerializableSomeCalls, 0);
  assert.equal(serializableToHostSomeCalls, 0);
  assert.equal(runtimeConstructionSomeCalls, 0);
});
