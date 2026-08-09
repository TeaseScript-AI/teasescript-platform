import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

test("immediate-pacing snapshots preserve ordinary options while capturing zero pacing", () => {
  const compiled = compileSource("exit");
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);

  const snapshot = createImmediatePacingRuntimeSnapshot(compiled.plan!, {
    seed: 77,
    globals: { score: 3 },
    maxCallDepth: 12,
    initialSessionTimeMs: 9,
  });

  assert.deepEqual(snapshot.chatPacingSettings, {
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
  });
  assert.equal(snapshot.rng.state, 77);
  assert.deepEqual(snapshot.frames[0]?.bindings, [{ name: "score", value: 3 }]);
  assert.equal(snapshot.maxCallDepth, 12);
  assert.equal(snapshot.currentSessionTimeMs, 9);
});
