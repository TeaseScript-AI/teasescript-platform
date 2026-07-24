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
  assert.ok(keys.every((key) => /checkpoint-v3:/u.test(key)));
});

test("the functions example is allowlisted and visibly exercises the milestone", async () => {
  assert.equal(PLAYGROUND_EXAMPLES.functions.file, "functions.tease");
  const source = await readFile("examples/playground/functions.tease", "utf8");
  const compilation = compileSource(source);

  assert.deepEqual(compilation.diagnostics, []);
  const result = run(
    compilation.plan!,
    createFreshRuntimeSnapshot(compilation.plan!),
  );
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    [
      "Kneel.",
      "Hello, pet Alex.",
      "Hello, puppy Alex.",
      "Two plus three is 5.",
      "A nested result is 6.",
      "Loop result: 5",
      "Loop result: 5",
      "Stopped early.",
      "Countdown 3",
      "Countdown 2",
      "Countdown 1",
      "Done.",
    ],
  );
});

test("playground restore refuses detached source plans and renders source safely", async () => {
  const browserSource = await readFile("playground/browser.ts", "utf8");

  assert.match(browserSource, /does not match the currently displayed example source/u);
  assert.match(browserSource, /elements\.source\.textContent = source/u);
  assert.doesNotMatch(browserSource, /source\.innerHTML/u);
  assert.match(
    browserSource,
    /plan = null;\s+snapshot = null;\s+source = "";\s+eventLog = \[\];/u,
  );
});
