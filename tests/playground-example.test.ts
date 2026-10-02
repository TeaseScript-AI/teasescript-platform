import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PLAYGROUND_EXAMPLES, checkpointStorageKey } from "../playground/examples.js";
import { compileSource } from "../src/compiler.js";
import { run } from "../src/runtime/engine.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

test("every fixed repository playground example compiles and reaches its intended boundary", async () => {
  for (const [name, example] of Object.entries(PLAYGROUND_EXAMPLES)) {
    const source = await readFile(`examples/playground/${example.file}`, "utf8");
    const compilation = compileSource(source);
    assert.deepEqual(compilation.diagnostics, [], name);
    assert.notEqual(compilation.plan, null, name);
    const result = run(compilation.plan!, createImmediatePacingRuntimeSnapshot(compilation.plan!));
    assert.equal(result.snapshot.status, name === "player-controls" ? "waiting" : "halted", name);
  }
});

test("checkpoint storage keys are example-specific", () => {
  const keys = Object.keys(PLAYGROUND_EXAMPLES).map((name) =>
    checkpointStorageKey(
      /* EVIDENCE: Object.keys returns only own keys of PLAYGROUND_EXAMPLES. */ name as keyof typeof PLAYGROUND_EXAMPLES,
    ),
  );
  // A checkpoint saved in one example must not replace another example's saved checkpoint.
  assert.equal(new Set(keys).size, keys.length);
});
