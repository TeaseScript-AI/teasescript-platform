import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PLAYGROUND_EXAMPLES,
  checkpointStorageKey,
} from "../playground/examples.js";
import { compileSource } from "../src/compiler.js";
import { run } from "../src/runtime/engine.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";

test("executes the repository playground example deterministically", async () => {
  const source = await readFile("examples/playground/main.tease", "utf8");
  const compilation = compileSource(source);

  assert.deepEqual(compilation.diagnostics, []);
  assert.notEqual(compilation.plan, null);
  const plan = compilation.plan!;
  const first = run(plan, createFreshRuntimeSnapshot(plan));
  const second = run(plan, createFreshRuntimeSnapshot(plan));

  assert.deepEqual(second.events, first.events);
  assert.equal(first.snapshot.status, "halted");
  assert.deepEqual(
    first.events.filter((event) => event.kind === "say").map((event) => event.text),
    [
      "Welcome. I am Vera.",
      "Your ordered set contains 2 qualities.",
      "Your deterministic score is 2.",
      "The example is complete.",
    ],
  );
  assert.deepEqual(first.events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
});

test("every fixed repository playground example compiles and completes", async () => {
  for (const [name, example] of Object.entries(PLAYGROUND_EXAMPLES)) {
    const source = await readFile(`examples/playground/${example.file}`, "utf8");
    const compilation = compileSource(source);
    assert.deepEqual(compilation.diagnostics, [], name);
    assert.notEqual(compilation.plan, null, name);
    const result = run(
      compilation.plan!,
      createFreshRuntimeSnapshot(compilation.plan!),
    );
    assert.equal(result.snapshot.status, "halted", name);
  }
});

test("checkpoint storage keys are format-versioned and example-specific", () => {
  const keys = Object.keys(PLAYGROUND_EXAMPLES).map((name) =>
    checkpointStorageKey(name as keyof typeof PLAYGROUND_EXAMPLES)
  );
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every((key) => /checkpoint-v2:/u.test(key)));
});
