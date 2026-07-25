import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/instructions.js";
import {
  CheckpointError,
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
  type RuntimeCheckpoint,
} from "../src/runtime/checkpoint.js";
import {
  run,
  RuntimeDataError,
} from "../src/runtime/engine.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

test("rejects a fresh non-empty snapshot changed only to halted", () => {
  const compiled = plan('say "must run"\nexit');
  const checkpoint = mutableCheckpoint(
    createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled)),
  );
  checkpoint.snapshot.status = "halted";

  const validation = validateRuntimeSnapshot(checkpoint.snapshot, compiled);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes("Halted runtime state is not at a legal halt position."));
  assertCheckpointRejected(checkpoint, "TSK002");
  assert.throws(
    () => deserializeCheckpoint(JSON.stringify(checkpoint)),
    (error: unknown) => error instanceof CheckpointError && error.info.code === "TSK002",
  );
  assert.throws(
    () => run(compiled, checkpoint.snapshot),
    (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR101",
  );
});

test("accepts and round-trips every runtime-produced halted shape", () => {
  const scenarios = [
    {
      name: "normal root completion",
      source: 'say "done"',
      expectedKinds: ["say", "complete"],
    },
    {
      name: "empty root",
      source: "",
      expectedKinds: [],
    },
    {
      name: "root exit",
      source: 'say "before"\nexit\nsay "after"',
      expectedKinds: ["say", "exit"],
    },
    {
      name: "function exit",
      source: [
        "function stop { exit }",
        'say "before"',
        "stop()",
        'say "after"',
      ].join("\n"),
      expectedKinds: ["say", "exit"],
    },
    {
      name: "nested function exit",
      source: [
        "function inner { exit }",
        "function outer {",
        "  inner()",
        '  say "unreachable function code"',
        "}",
        "outer()",
        'say "unreachable root code"',
      ].join("\n"),
      expectedKinds: ["exit"],
    },
  ] as const;

  for (const scenario of scenarios) {
    const compiled = plan(scenario.source);
    const result = run(compiled, createFreshRuntimeSnapshot(compiled));
    assert.equal(result.snapshot.status, "halted", scenario.name);
    assert.deepEqual(result.events.map((event) => event.kind), scenario.expectedKinds, scenario.name);
    assert.equal(validateRuntimeSnapshot(result.snapshot, compiled).valid, true, scenario.name);

    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(compiled, result.snapshot)),
    );
    assert.deepEqual(restored.snapshot, result.snapshot, scenario.name);
    assert.equal(validateRuntimeSnapshot(restored.snapshot, restored.plan).valid, true, scenario.name);
  }
});

test("keeps valid halted execution resume-equivalent", () => {
  const result = assertRuntimeResumeEquivalent([
    "function inner { return 2 }",
    'say `value:${inner()}`',
    "exit",
  ].join("\n"), {
    scenarioName: "runtime snapshot invariant resume equivalence",
  });

  assert.equal(result.finalSnapshot.status, "halted");
  assert.deepEqual(result.events.map((event) => event.kind), ["say", "exit"]);
});

function plan(source: string): InstructionPlan {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

function mutableCheckpoint(checkpoint: RuntimeCheckpoint): {
  format: RuntimeCheckpoint["format"];
  version: RuntimeCheckpoint["version"];
  plan: InstructionPlan;
  snapshot: RuntimeSnapshot;
} {
  return structuredClone(checkpoint);
}

function assertCheckpointRejected(value: unknown, code: string): void {
  assert.throws(() => restoreCheckpoint(value), (error: unknown) => {
    return error instanceof CheckpointError && error.info.code === code;
  });
}
