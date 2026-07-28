import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import {
  CheckpointError,
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
  type RuntimeCheckpoint,
} from "../src/runtime/checkpoint.js";
import {
  executeInstruction,
  run,
  RuntimeDataError,
} from "../src/runtime/engine.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

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

test("validates allocator counters across the JavaScript safe-integer boundary", () => {
  const compiled = plan("exit");
  const fields = [
    "nextEventSequence",
    "nextScopeId",
    "nextSpeakerId",
    "nextCallFrameId",
  ] as const;
  const accepted = [1, MAX_SAFE - 1, MAX_SAFE];
  const rejected = [
    { name: "MAX_SAFE_INTEGER + 1", value: MAX_SAFE + 1 },
    { name: "2 ** 53", value: 2 ** 53 },
    { name: "NaN", value: Number.NaN },
    { name: "Infinity", value: Number.POSITIVE_INFINITY },
    { name: "fractional", value: 1.5 },
    { name: "negative", value: -1 },
  ];

  for (const field of fields) {
    for (const value of accepted) {
      const snapshot = createFreshRuntimeSnapshot(compiled);
      snapshot[field] = value;
      assert.equal(
        validateRuntimeSnapshot(snapshot, compiled).valid,
        true,
        `${field} should accept ${value}`,
      );
    }
    for (const entry of rejected) {
      const snapshot = createFreshRuntimeSnapshot(compiled);
      snapshot[field] = entry.value;
      assert.equal(
        validateRuntimeSnapshot(snapshot, compiled).valid,
        false,
        `${field} should reject ${entry.name}`,
      );
    }
  }
});

test("rejects unsafe counters through direct snapshot and checkpoint boundaries", () => {
  const compiled = plan('say "one"\nsay "two"\nexit');
  for (const field of [
    "nextEventSequence",
    "nextScopeId",
    "nextSpeakerId",
    "nextCallFrameId",
  ] as const) {
    const checkpoint = mutableCheckpoint(
      createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled)),
    );
    checkpoint.snapshot[field] = 2 ** 53;

    assert.equal(validateRuntimeSnapshot(checkpoint.snapshot, compiled).valid, false, field);
    assertCheckpointRejected(checkpoint, "TSK002");
  }
});

test("rejects event-sequence exhaustion before emitting a duplicate sequence", () => {
  const compiled = plan('say "one"\nsay "two"\nexit');
  const snapshot = createFreshRuntimeSnapshot(compiled);
  snapshot.nextEventSequence = MAX_SAFE;
  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true);

  assert.throws(
    () => executeInstruction(compiled, snapshot),
    (error: unknown) =>
      error instanceof RuntimeDataError &&
      error.code === "TSR101" &&
      error.message === "Runtime nextEventSequence cannot be advanced safely.",
  );
  assert.equal(snapshot.nextEventSequence, MAX_SAFE);
  assert.equal(snapshot.status, "ready");
});

test("rejects exhausted scope, speaker, and call-frame allocators before collision", () => {
  const scopePlan = plan('if true {\n  say "inside"\n}\nexit');
  let scopeSnapshot = createFreshRuntimeSnapshot(scopePlan);
  scopeSnapshot.nextScopeId = MAX_SAFE;
  scopeSnapshot = executeInstruction(scopePlan, scopeSnapshot).snapshot;
  assert.equal(scopePlan.instructions[scopeSnapshot.nextInstruction]?.kind, "enterScope");
  assert.throws(
    () => executeInstruction(scopePlan, scopeSnapshot),
    allocatorError("nextScopeId"),
  );
  assert.equal(scopeSnapshot.frames.length, 1);
  assert.equal(scopeSnapshot.nextScopeId, MAX_SAFE);

  const speakerPlan = plan("speaker vera {}\nexit");
  const speakerSnapshot = createFreshRuntimeSnapshot(speakerPlan);
  speakerSnapshot.nextSpeakerId = MAX_SAFE;
  assert.throws(
    () => executeInstruction(speakerPlan, speakerSnapshot),
    allocatorError("nextSpeakerId"),
  );
  assert.deepEqual(speakerSnapshot.speakers, []);
  assert.equal(speakerSnapshot.nextSpeakerId, MAX_SAFE);

  const callPlan = plan("function value { return 1 }\nvalue()");
  let callSnapshot = createFreshRuntimeSnapshot(callPlan);
  while (callPlan.instructions[callSnapshot.nextInstruction]?.kind !== "callFunction") {
    callSnapshot = executeInstruction(callPlan, callSnapshot).snapshot;
  }
  callSnapshot.nextCallFrameId = MAX_SAFE;
  assert.throws(
    () => executeInstruction(callPlan, callSnapshot),
    allocatorError("nextCallFrameId"),
  );
  assert.deepEqual(callSnapshot.callFrames, []);
  assert.equal(callSnapshot.nextCallFrameId, MAX_SAFE);
});

test("requires safe integers for nested runtime identities, positions, and progress", () => {
  const speakerPlan = plan('speaker vera {}\nsay as vera "hello"\nexit');
  const declared = executeInstruction(
    speakerPlan,
    createFreshRuntimeSnapshot(speakerPlan),
  ).snapshot;
  const speakerSnapshot = structuredClone(declared);
  (speakerSnapshot.speakers[0] as { id: number }).id = 2 ** 53;
  assert.equal(validateRuntimeSnapshot(speakerSnapshot, speakerPlan).valid, false);

  const scopePlan = plan('if true {\n  say "inside"\n}\nexit');
  let enteredScope = createFreshRuntimeSnapshot(scopePlan);
  enteredScope = executeInstruction(scopePlan, enteredScope).snapshot;
  enteredScope = executeInstruction(scopePlan, enteredScope).snapshot;
  (enteredScope.frames[1] as { id: number }).id = 2 ** 53;
  enteredScope.nextScopeId = MAX_SAFE;
  assert.equal(validateRuntimeSnapshot(enteredScope, scopePlan).valid, false);

  const callPlan = plan("function value(input = 1) { return input }\nvalue()");
  let activeCall = createFreshRuntimeSnapshot(callPlan);
  while (activeCall.callFrames.length === 0) {
    activeCall = executeInstruction(callPlan, activeCall).snapshot;
  }
  (activeCall.callFrames[0] as { id: number }).id = 2 ** 53;
  activeCall.nextCallFrameId = MAX_SAFE;
  assert.equal(validateRuntimeSnapshot(activeCall, callPlan).valid, false);

  const parameterSnapshot = structuredClone(activeCall);
  (parameterSnapshot.callFrames[0] as { id: number }).id = 1;
  parameterSnapshot.nextCallFrameId = 2;
  parameterSnapshot.callFrames[0]!.parameterState.parameterIndex = 2 ** 53;
  assert.equal(validateRuntimeSnapshot(parameterSnapshot, callPlan).valid, false);

  const failedPlan = plan("let value = []\nsay value.first\nexit");
  const failed = run(failedPlan, createFreshRuntimeSnapshot(failedPlan)).snapshot;
  assert.equal(failed.status, "failed");
  const spanSnapshot = structuredClone(failed);
  (spanSnapshot.failure!.span.start as { offset: number }).offset = 2 ** 53;
  assert.equal(validateRuntimeSnapshot(spanSnapshot, failedPlan).valid, false);
});

test("emits only safe, unique, strictly increasing event sequences", () => {
  const compiled = plan('say "one"\nsay "two"\nexit');
  const result = run(compiled, createFreshRuntimeSnapshot(compiled));
  const sequences = result.events.map((event) => event.sequence);

  assert.ok(sequences.every(Number.isSafeInteger));
  assert.equal(new Set(sequences).size, sequences.length);
  for (let index = 1; index < sequences.length; index += 1) {
    assert.ok(sequences[index]! > sequences[index - 1]!);
  }
});

function allocatorError(field: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof RuntimeDataError &&
    error.code === "TSR101" &&
    error.message === `Runtime ${field} cannot be advanced safely.`;
}

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
