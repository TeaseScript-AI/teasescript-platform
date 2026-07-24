import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/instructions.js";
import {
  run,
  type RuntimeBuiltinFunction,
} from "../src/runtime/engine.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";

test("requires explicit own registration for an inherited builtin name", () => {
  const compiled = compile("valueOf()", ["valueOf"]);
  const missing = run(compiled, createFreshRuntimeSnapshot(compiled));

  assert.equal(missing.snapshot.failure?.code, "TSR011");
  assert.match(
    missing.snapshot.failure?.message ?? "",
    /Unknown built-in function 'valueOf'/u,
  );

  let calls = 0;
  const valueOf: RuntimeBuiltinFunction = () => {
    calls += 1;
    return "registered";
  };
  const injected = run(
    compiled,
    createFreshRuntimeSnapshot(compiled),
    { builtins: { valueOf } },
  );

  assert.equal(injected.snapshot.status, "halted");
  assert.equal(injected.snapshot.failure, null);
  assert.equal(calls, 1);
});

test("keeps core builtin precedence over injected names", () => {
  const compiled = compile("random()", []);
  let injectedCalls = 0;
  let randomCalls = 0;
  const result = run(
    compiled,
    createFreshRuntimeSnapshot(compiled),
    {
      builtins: {
        random: () => {
          injectedCalls += 1;
          return 0.75;
        },
      },
      random: {
        next: () => {
          randomCalls += 1;
          return 0.25;
        },
      },
    },
  );

  assert.equal(result.snapshot.status, "halted");
  assert.equal(result.snapshot.failure, null);
  assert.equal(injectedCalls, 0);
  assert.equal(randomCalls, 1);
});

function compile(source: string, builtins: readonly string[]): InstructionPlan {
  const result = compileSource(source, { builtins });
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}
