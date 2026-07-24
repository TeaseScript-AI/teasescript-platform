import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/instructions.js";
import {
  run,
  type RuntimeBuiltinFunction,
  type RuntimeOperationResult,
} from "../src/runtime/engine.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";

test("requires explicit own registration for an inherited builtin name", () => {
  const compiled = compile("say valueOf()", ["valueOf"]);
  const missing = run(compiled, createFreshRuntimeSnapshot(compiled));

  assert.equal(missing.snapshot.failure?.code, "TSR011");
  assert.match(
    missing.snapshot.failure?.message ?? "",
    /Unknown built-in function 'valueOf'/u,
  );

  const valueOf: RuntimeBuiltinFunction = () => "registered";
  const injected = run(
    compiled,
    createFreshRuntimeSnapshot(compiled),
    { builtins: { valueOf } },
  );

  assert.deepEqual(sayTexts(injected), ["registered"]);
});

test("keeps core builtin precedence over injected names", () => {
  const compiled = compile("say random()", []);
  const result = run(
    compiled,
    createFreshRuntimeSnapshot(compiled),
    {
      builtins: { random: () => 0.75 },
      random: { next: () => 0.25 },
    },
  );

  assert.deepEqual(sayTexts(result), ["0.25"]);
});

function compile(source: string, builtins: readonly string[]): InstructionPlan {
  const result = compileSource(source, { builtins });
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

function sayTexts(result: RuntimeOperationResult): string[] {
  return result.events
    .filter((event) => event.kind === "say")
    .map((event) => event.text);
}
