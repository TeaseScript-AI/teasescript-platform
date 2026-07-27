import assert from "node:assert/strict";
import test from "node:test";

import {
  compileSource,
  createFreshRuntimeSnapshot,
  type SerializableRuntimeValue,
} from "../src/index.js";

test("fresh global initialization does not rescan previously constructed bindings", () => {
  const compiled = compileSource("exit");
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);

  const globals: Record<string, SerializableRuntimeValue> = Object.create(null);
  const count = 2_000;
  for (let index = 0; index < count; index += 1) {
    globals[`global${index}`] = index;
  }

  const originalSome = Array.prototype.some;
  let bindingComparisons = 0;
  Array.prototype.some = function <T>(
    this: T[],
    predicate: (value: T, index: number, array: T[]) => unknown,
    thisArg?: unknown,
  ): boolean {
    return originalSome.call(this, (value: T, index: number, array: T[]) => {
      if (
        value !== null &&
        typeof value === "object" &&
        Object.hasOwn(value, "name") &&
        Object.hasOwn(value, "value")
      ) {
        bindingComparisons += 1;
      }
      return predicate.call(thisArg, value, index, array);
    });
  };
  try {
    const snapshot = createFreshRuntimeSnapshot(compiled.plan!, { globals });
    assert.equal(snapshot.frames[0]?.bindings.length, count);
    assert.deepEqual(
      snapshot.frames[0]?.bindings.slice(0, 3).map((binding) => binding.name),
      ["global0", "global1", "global2"],
    );
    assert.equal(snapshot.frames[0]?.bindings.at(-1)?.name, `global${count - 1}`);
  } finally {
    Array.prototype.some = originalSome;
  }
  assert.equal(bindingComparisons, 0);
});
