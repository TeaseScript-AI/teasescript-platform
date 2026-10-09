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
    {
      name: "exit as the last statement",
      source: 'say "done"\nexit',
      expectedKinds: ["say", "exit"],
    },
    { name: "only exit", source: "exit", expectedKinds: ["exit"] },
    {
      name: "root exit",
      source: 'say "before"\nexit\nsay "after"',
      expectedKinds: ["say", "exit"],
    },
    {
      name: "function exit",
      // A call counts as returning, so the root still needs its own exit.
      source: ["function stop { exit }", 'say "before"', "stop()", 'say "after"', "exit"].join(
        "\n",
      ),
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
        "exit",
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

test("validates loops paused in their bodies with or without the plan", () => {
  const compiled = plan(
    "for k, v in dict{ a: 1, b: 2 } {\n  repeat 2 {\n    wait 5 s\n  }\n}\nexit",
  );
  const { snapshot } = run(compiled, createImmediatePacingRuntimeSnapshot(compiled));
  assert.equal(snapshot.status, "waiting");
  assert.equal(snapshot.loopFrames.length, 2);
  const copy = structuredClone(snapshot);
  assert.deepEqual(validateRuntimeSnapshot(copy, compiled), { valid: true, errors: [] });
  assert.deepEqual(validateRuntimeSnapshot(copy), { valid: true, errors: [] });
  // Without the plan, a loop that runs twice in one context is still refused.
  // EVIDENCE: fixture: expose the readonly loop ID on a cloned snapshot to repeat the outer loop's ID.
  (copy.loopFrames[1] as { loopId: number }).loopId = copy.loopFrames[0]!.loopId;
  assert.deepEqual(validateRuntimeSnapshot(copy).errors, [
    "Runtime loop frame does not belong to its call context.",
  ]);
});

test("validates allocator counters across the safe-integer boundary at snapshot and checkpoint entry", () => {
  const compiled = plan('say "one"\nsay "two"\nexit');
  const fields = ["nextEventSequence", "nextScopeId", "nextSpeakerId", "nextCallFrameId"] as const;
  const accepted = [1, MAX_SAFE - 1, MAX_SAFE];
  const rejected = [
    { name: "first unsafe integer", value: MAX_SAFE + 1, checkpoint: true },
    { name: "NaN", value: Number.NaN, checkpoint: false },
    { name: "Infinity", value: Number.POSITIVE_INFINITY, checkpoint: false },
    { name: "fractional", value: 1.5, checkpoint: false },
    { name: "negative", value: -1, checkpoint: false },
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
      const checkpoint = mutableCheckpoint(
        createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled)),
      );
      checkpoint.snapshot[field] = entry.value;
      assert.equal(
        validateRuntimeSnapshot(checkpoint.snapshot, compiled).valid,
        false,
        `${field} should reject ${entry.name}`,
      );
      if (entry.checkpoint) assertCheckpointRejected(checkpoint, "TSK002");
    }
  }
});

test("rejects event-sequence exhaustion before emitting a duplicate sequence", () => {
  const compiled = plan('say "one"\nsay "two"\nexit');
  const snapshot = createImmediatePacingRuntimeSnapshot(compiled);
  snapshot.nextEventSequence = MAX_SAFE;
  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true);
  const before = structuredClone(snapshot);

  assert.throws(() => executeInstruction(compiled, snapshot), isAllocatorError);
  assert.deepEqual(snapshot, before);
  assert.equal(snapshot.nextEventSequence, MAX_SAFE);
});

test("rejects exhausted scope, speaker, and call-frame allocators before collision", () => {
  const scopePlan = plan('if true {\n  say "inside"\n}\nexit');
  let scopeSnapshot = createFreshRuntimeSnapshot(scopePlan);
  scopeSnapshot.nextScopeId = MAX_SAFE;
  scopeSnapshot = executeInstruction(scopePlan, scopeSnapshot).snapshot;
  assert.equal(scopePlan.instructions[scopeSnapshot.nextInstruction]?.kind, "enterScope");
  assert.throws(() => executeInstruction(scopePlan, scopeSnapshot), isAllocatorError);
  assert.equal(scopeSnapshot.frames.length, 1);
  assert.equal(scopeSnapshot.nextScopeId, MAX_SAFE);

  const speakerPlan = plan("speaker vera {}\nexit");
  const speakerSnapshot = createFreshRuntimeSnapshot(speakerPlan);
  speakerSnapshot.nextSpeakerId = MAX_SAFE;
  assert.throws(() => executeInstruction(speakerPlan, speakerSnapshot), isAllocatorError);
  assert.deepEqual(speakerSnapshot.speakers, []);
  assert.equal(speakerSnapshot.nextSpeakerId, MAX_SAFE);

  const callPlan = plan("function value { return 1 }\nvalue()\nexit");
  let callSnapshot = createFreshRuntimeSnapshot(callPlan);
  for (
    let steps = 0;
    callPlan.instructions[callSnapshot.nextInstruction]?.kind !== "callFunction";
    steps += 1
  ) {
    assert.ok(steps < callPlan.instructions.length, "fixture did not reach its call instruction");
    callSnapshot = executeInstruction(callPlan, callSnapshot).snapshot;
    assert.ok(
      callSnapshot.status === "running",
      `unexpected ${callSnapshot.status} before the call`,
    );
  }
  callSnapshot.nextCallFrameId = MAX_SAFE;
  assert.throws(() => executeInstruction(callPlan, callSnapshot), isAllocatorError);
  assert.deepEqual(callSnapshot.callFrames, []);
  assert.equal(callSnapshot.nextCallFrameId, MAX_SAFE);
});

test("rejects unsafe source positions and out-of-range nested identities", () => {
  const speakerPlan = plan('speaker vera {}\nsay as vera "hello"\nexit');
  const declared = executeInstruction(
    speakerPlan,
    createFreshRuntimeSnapshot(speakerPlan),
  ).snapshot;
  assert.equal(validateRuntimeSnapshot(declared, speakerPlan).valid, true);
  const speakerSnapshot = structuredClone(declared);
  // EVIDENCE: fixture: expose the readonly speaker ID on a cloned snapshot for unsafe-integer validation.
  (speakerSnapshot.speakers[0] as { id: number }).id = 2 ** 53;
  assert.equal(
    validateRuntimeSnapshot(speakerSnapshot, speakerPlan).valid,
    false,
    "speaker ID beyond its allocator and references",
  );

  const callPlan = plan("function value(input = 1) { return input }\nvalue()\nexit");
  let activeCall = createFreshRuntimeSnapshot(callPlan);
  for (let steps = 0; steps < 20 && activeCall.callFrames.length === 0; steps += 1) {
    activeCall = executeInstruction(callPlan, activeCall).snapshot;
  }
  assert.equal(activeCall.callFrames.length, 1);
  assert.equal(validateRuntimeSnapshot(activeCall, callPlan).valid, true);
  // EVIDENCE: fixture: expose the readonly call-frame ID on an active snapshot for unsafe-integer validation.
  (activeCall.callFrames[0] as { id: number }).id = 2 ** 53;
  activeCall.nextCallFrameId = MAX_SAFE;
  assert.equal(
    validateRuntimeSnapshot(activeCall, callPlan).valid,
    false,
    "call-frame ID beyond its allocator",
  );

  const failedPlan = plan("let value = []\nsay value.first\nexit");
  const failed = run(failedPlan, createFreshRuntimeSnapshot(failedPlan)).snapshot;
  assert.equal(failed.status, "failed");
  assert.equal(validateRuntimeSnapshot(failed, failedPlan).valid, true);
  const spanSnapshot = structuredClone(failed);
  // EVIDENCE: fixture: expose the readonly failure offset; both positions stay safe integers.
  (spanSnapshot.failure!.span.start as { offset: number }).offset =
    failed.failure!.span.end.offset + 1;
  assert.equal(
    validateRuntimeSnapshot(spanSnapshot, failedPlan).valid,
    false,
    "failure span starts after it ends",
  );

  // An unsafe start offset would also reverse the span, so the start is probed through line and column.
  const unsafePositions = [
    ["start", "line"],
    ["start", "column"],
    ["end", "offset"],
    ["end", "line"],
    ["end", "column"],
  ] as const;
  for (const [position, field] of unsafePositions) {
    const unsafe = structuredClone(failed);
    // EVIDENCE: fixture: expose one readonly position field; the span stays ordered.
    (unsafe.failure!.span[position] as Record<typeof field, number>)[field] = MAX_SAFE + 1;
    assert.equal(
      validateRuntimeSnapshot(unsafe, failedPlan).valid,
      false,
      `unsafe failure ${position} ${field}`,
    );
  }
});

function isAllocatorError(error: unknown): boolean {
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
