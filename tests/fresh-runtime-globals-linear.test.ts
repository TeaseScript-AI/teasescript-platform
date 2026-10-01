import assert from "node:assert/strict";
import test from "node:test";

import {
  compileSource,
  createFreshRuntimeSnapshot,
  type SerializableRuntimeValue,
} from "../src/index.js";

test("fresh global initialization binds every external global in order", () => {
  const compiled = compileSource("exit");
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);

  const globals: Record<string, SerializableRuntimeValue> = Object.create(null);
  const count = 2_000;
  for (let index = 0; index < count; index += 1) {
    globals[`global${index}`] = index;
  }

  const snapshot = createFreshRuntimeSnapshot(compiled.plan!, { globals });
  assert.deepEqual(
    snapshot.frames[0]?.bindings,
    Array.from({ length: count }, (_, index) => ({ name: `global${index}`, value: index })),
  );
});
