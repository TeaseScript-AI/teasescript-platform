import assert from "node:assert/strict";
import test from "node:test";

import type { InstructionPlan } from "../src/plan/model.js";
import {
  CheckpointError,
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
  type RuntimeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { executeInstruction, run, RuntimeDataError } from "../src/runtime/engine.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { assertCheckpointRejected } from "./helpers/checkpoint-rejection.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

test("rejects a fresh non-empty snapshot changed only to halted", () => {
  const compiled = plan('say "must run"\nexit');
  const checkpoint = mutableCheckpoint(
    createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled)),
  );
  checkpoint.snapshot.status = "halted";

  const validation = validateRuntimeSnapshot(checkpoint.snapshot, compiled);
  assert.equal(validation.valid, false);
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
    { name: "normal root completion", source: 'say "done"', expectedKinds: ["say", "complete"] },
    { name: "empty root", source: "", expectedKinds: [] },
    {
      name: "root exit",
      source: 'say "before"\nexit\nsay "after"',
      expectedKinds: ["say", "exit"],
    },
    {
      name: "function exit",
      source: ["function stop { exit }", 'say "before"', "stop()", 'say "after"'].join("\n"),
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
    const result = run(compiled, createImmediatePacingRuntimeSnapshot(compiled));
    assert.equal(result.snapshot.status, "halted", scenario.name);
    assert.deepEqual(
      result.events.map((event) => event.kind),
      scenario.expectedKinds,
      scenario.name,
    );
    assert.equal(validateRuntimeSnapshot(result.snapshot, compiled).valid, true, scenario.name);

    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(compiled, result.snapshot)),
    );
    assert.deepEqual(restored.snapshot, result.snapshot, scenario.name);
    assert.equal(
      validateRuntimeSnapshot(restored.snapshot, restored.plan).valid,
      true,
      scenario.name,
    );
  }
});

test("keeps valid halted execution resume-equivalent", () => {
  const result = assertRuntimeResumeEquivalent(
    ["function inner { return 2 }", 'say "value:${inner()}"', "exit"].join("\n"),
    { scenarioName: "runtime snapshot invariant resume equivalence" },
  );

  assert.equal(result.finalSnapshot.status, "halted");
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ["say", "exit"],
  );
});

test("validates allocator counters across the JavaScript safe-integer boundary", () => {
  const compiled = plan("exit");
  const fields = ["nextEventSequence", "nextScopeId", "nextSpeakerId", "nextCallFrameId"] as const;
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
  const snapshot = createImmediatePacingRuntimeSnapshot(compiled);
  snapshot.nextEventSequence = MAX_SAFE;
  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true);

  assert.throws(
    () => executeInstruction(compiled, snapshot),
    (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR101",
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
  assert.throws(() => executeInstruction(scopePlan, scopeSnapshot), allocatorError);
  assert.equal(scopeSnapshot.frames.length, 1);
  assert.equal(scopeSnapshot.nextScopeId, MAX_SAFE);

  const speakerPlan = plan("speaker vera {}\nexit");
  const speakerSnapshot = createFreshRuntimeSnapshot(speakerPlan);
  speakerSnapshot.nextSpeakerId = MAX_SAFE;
  assert.throws(() => executeInstruction(speakerPlan, speakerSnapshot), allocatorError);
  assert.deepEqual(speakerSnapshot.speakers, []);
  assert.equal(speakerSnapshot.nextSpeakerId, MAX_SAFE);

  const callPlan = plan("function value { return 1 }\nvalue()");
  let callSnapshot = createFreshRuntimeSnapshot(callPlan);
  while (callPlan.instructions[callSnapshot.nextInstruction]?.kind !== "callFunction") {
    callSnapshot = executeInstruction(callPlan, callSnapshot).snapshot;
  }
  callSnapshot.nextCallFrameId = MAX_SAFE;
  assert.throws(() => executeInstruction(callPlan, callSnapshot), allocatorError);
  assert.deepEqual(callSnapshot.callFrames, []);
  assert.equal(callSnapshot.nextCallFrameId, MAX_SAFE);
});

test("rejects unsafe source-span positions independently of span order", () => {
  const failedPlan = plan("let value = []\nsay value.first\nexit");
  const failed = run(failedPlan, createFreshRuntimeSnapshot(failedPlan)).snapshot;
  assert.equal(failed.status, "failed");
  assert.equal(validateRuntimeSnapshot(failed, failedPlan).valid, true);

  for (const field of ["offset", "line", "column"] as const) {
    const candidate = structuredClone(failed);
    // EVIDENCE: fixture: only this end-position field leaves the safe-integer domain; the end stays after the start.
    (candidate.failure!.span.end as Record<typeof field, number>)[field] = MAX_SAFE + 1;
    assert.equal(validateRuntimeSnapshot(candidate, failedPlan).valid, false, field);
  }

  const reversed = structuredClone(failed);
  // EVIDENCE: fixture: expose the readonly failure start; a safe start after the end reverses the span.
  (reversed.failure!.span.start as { offset: number }).offset = failed.failure!.span.end.offset + 1;
  assert.equal(validateRuntimeSnapshot(reversed, failedPlan).valid, false, "reversed span");
});

test("rejects nested identities at their allocators and parameter progress beyond the parameters", () => {
  const speakerPlan = plan('speaker vera {}\nsay as vera "hello"\nexit');
  const declared = executeInstruction(
    speakerPlan,
    createFreshRuntimeSnapshot(speakerPlan),
  ).snapshot;
  assert.equal(validateRuntimeSnapshot(declared, speakerPlan).valid, true);
  const speakerSnapshot = structuredClone(declared);
  // EVIDENCE: fixture: expose the readonly speaker ID; an oversized ID is not below nextSpeakerId.
  (speakerSnapshot.speakers[0] as { id: number }).id = 2 ** 53;
  assert.equal(validateRuntimeSnapshot(speakerSnapshot, speakerPlan).valid, false);

  const scopePlan = plan('if true {\n  say "inside"\n}\nexit');
  const enteredScope = executeUntil(
    scopePlan,
    createFreshRuntimeSnapshot(scopePlan),
    (snapshot) => snapshot.frames.length === 2,
  );
  assert.equal(validateRuntimeSnapshot(enteredScope, scopePlan).valid, true);
  // EVIDENCE: fixture: expose the readonly scope ID; an oversized ID is not below nextScopeId.
  (enteredScope.frames[1] as { id: number }).id = 2 ** 53;
  enteredScope.nextScopeId = MAX_SAFE;
  assert.equal(validateRuntimeSnapshot(enteredScope, scopePlan).valid, false);

  const callPlan = plan("function value(input = 1) { return input }\nvalue()");
  const activeCall = executeUntil(
    callPlan,
    createFreshRuntimeSnapshot(callPlan),
    (snapshot) => snapshot.callFrames.length === 1,
  );
  assert.equal(validateRuntimeSnapshot(activeCall, callPlan).valid, true);
  const oversizedCall = structuredClone(activeCall);
  // EVIDENCE: fixture: expose the readonly call-frame ID; an oversized ID is not below nextCallFrameId.
  (oversizedCall.callFrames[0] as { id: number }).id = 2 ** 53;
  oversizedCall.nextCallFrameId = MAX_SAFE;
  assert.equal(validateRuntimeSnapshot(oversizedCall, callPlan).valid, false);

  const parameterSnapshot = structuredClone(activeCall);
  // The function declares one parameter, so progress beyond it is malformed.
  parameterSnapshot.callFrames[0]!.parameterState.parameterIndex = 2 ** 53;
  assert.equal(validateRuntimeSnapshot(parameterSnapshot, callPlan).valid, false);
});

/** Executes ordinary instructions until the target state, failing instead of looping on an unexpected path. */
function executeUntil(
  compiled: InstructionPlan,
  initial: RuntimeSnapshot,
  reached: (snapshot: RuntimeSnapshot) => boolean,
): RuntimeSnapshot {
  let snapshot = initial;
  for (let step = 0; step < 32; step += 1) {
    if (reached(snapshot)) return snapshot;
    assert.ok(
      snapshot.status === "ready" || snapshot.status === "running",
      `runtime ${snapshot.status} before reaching the target state`,
    );
    snapshot = executeInstruction(compiled, snapshot).snapshot;
  }
  assert.fail("runtime did not reach the target state within 32 instructions");
}

function allocatorError(error: unknown): boolean {
  return error instanceof RuntimeDataError && error.code === "TSR101";
}

function mutableCheckpoint(checkpoint: RuntimeCheckpoint): {
  format: RuntimeCheckpoint["format"];
  version: RuntimeCheckpoint["version"];
  plan: InstructionPlan;
  snapshot: RuntimeSnapshot;
} {
  return structuredClone(checkpoint);
}
