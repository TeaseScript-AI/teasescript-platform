import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
