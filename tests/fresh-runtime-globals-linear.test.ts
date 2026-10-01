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
  globals.score = 3;
  globals.title = "Captain";
  globals.enabled = false;
  globals.missing = null;
  globals.items = { kind: "list", items: [1, "two"] };

  const snapshot = createFreshRuntimeSnapshot(compiled.plan!, { globals });
  assert.deepEqual(snapshot.frames[0]?.bindings, [
    { name: "score", value: 3 },
    { name: "title", value: "Captain" },
    { name: "enabled", value: false },
    { name: "missing", value: null },
    { name: "items", value: { kind: "list", items: [1, "two"] } },
  ]);
});
