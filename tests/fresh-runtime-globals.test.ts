import assert from "node:assert/strict";
import test from "node:test";

import {
  compileSource,
  createFreshRuntimeSnapshot,
  type SerializableRuntimeValue,
} from "../src/index.js";

test("fresh global initialization preserves imported value kinds in binding order", () => {
  const compiled = compileSource("exit");
  assert.notEqual(compiled.plan, null);
  const globals: Record<string, SerializableRuntimeValue> = {
    title: "Session",
    count: 3,
    enabled: false,
    missing: null,
    tags: { kind: "list", items: ["a", 1] },
    profile: { kind: "object", properties: [{ name: "level", value: 2 }] },
  };

  const snapshot = createFreshRuntimeSnapshot(compiled.plan!, { globals });

  assert.deepEqual(snapshot.frames[0]?.bindings, [
    { name: "title", value: "Session" },
    { name: "count", value: 3 },
    { name: "enabled", value: false },
    { name: "missing", value: null },
    { name: "tags", value: { kind: "list", items: ["a", 1] } },
    { name: "profile", value: { kind: "object", properties: [{ name: "level", value: 2 }] } },
  ]);
});
