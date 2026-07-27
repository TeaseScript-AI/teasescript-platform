import assert from "node:assert/strict";

import {
  CheckpointError,
  RuntimeDataError,
  completeAction,
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  run,
  serializeCheckpoint,
  validateInstructionPlan,
  validateRuntimeSnapshot,
  type ActionCompletionOutcome,
  type InstructionPlan,
  type PendingActionOperationResult,
  type RuntimeCheckpoint,
  type RuntimeOperationResult,
  type RuntimeSnapshot,
} from "../../src/index.js";

export interface StructuredBoundaryObservation {
  readonly kind: "accepted" | "rejected";
  readonly detail: string;
}

export function assertAcceptedPlan(plan: InstructionPlan): void {
  const validation = validateInstructionPlan(plan);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
}

export function assertAcceptedSnapshot(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): void {
  const validation = validateRuntimeSnapshot(snapshot, plan);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
}

export function assertSuccessfulRuntimeOperation<T extends RuntimeOperationResult>(
  plan: InstructionPlan,
  inputSnapshot: RuntimeSnapshot,
  operation: () => T,
): T {
  const planBefore = structuredClone(plan);
  const snapshotBefore = structuredClone(inputSnapshot);
  const result = operation();
  assert.deepEqual(plan, planBefore, "Runtime operation mutated its input plan.");
  assert.deepEqual(
    inputSnapshot,
    snapshotBefore,
    "Runtime operation mutated its input snapshot.",
  );
  assertAcceptedSnapshot(plan, result.snapshot);
  return result;
}

export function assertCompletionRejectedWithoutMutation(
  plan: InstructionPlan,
  inputSnapshot: RuntimeSnapshot,
  request: unknown,
  allowedOutcomes: readonly ActionCompletionOutcome["kind"][],
): PendingActionOperationResult<ActionCompletionOutcome> {
  const planBefore = structuredClone(plan);
  const before = structuredClone(inputSnapshot);
  const result = completeAction(plan, inputSnapshot, request);
  assert.ok(
    allowedOutcomes.includes(result.outcome.kind),
    `Unexpected completion outcome: ${result.outcome.kind}`,
  );
  assert.deepEqual(plan, planBefore, "Completion mutated the input plan.");
  assert.deepEqual(inputSnapshot, before, "Completion mutated the input snapshot.");
  assert.deepEqual(result.snapshot, before, "Rejected completion mutated canonical state.");
  assert.deepEqual(result.events, [], "Rejected completion emitted events.");
  assertAcceptedSnapshot(plan, result.snapshot);
  return result;
}

export function assertCheckpointRoundTrip(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): RuntimeCheckpoint {
  const planBefore = structuredClone(plan);
  const snapshotBefore = structuredClone(snapshot);
  const checkpoint = createCheckpoint(plan, snapshot);
  const serialized = serializeCheckpoint(checkpoint);
  const restored = deserializeCheckpoint(serialized);
  assert.deepEqual(plan, planBefore, "Checkpoint creation mutated its input plan.");
  assert.deepEqual(
    snapshot,
    snapshotBefore,
    "Checkpoint creation mutated its input snapshot.",
  );
  assert.deepEqual(restored.plan, checkpoint.plan);
  assert.deepEqual(restored.snapshot, checkpoint.snapshot);
  assert.equal(serializeCheckpoint(restored), serialized);
  return restored;
}

export function assertResumeEquivalent(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  continueExecution: (
    currentPlan: InstructionPlan,
    currentSnapshot: RuntimeSnapshot,
  ) => RuntimeOperationResult,
): void {
  const planBefore = structuredClone(plan);
  const snapshotBefore = structuredClone(snapshot);
  const uninterruptedFirst = continueExecution(plan, snapshot);
  assert.deepEqual(plan, planBefore, "Resume comparison mutated its input plan.");
  assert.deepEqual(
    snapshot,
    snapshotBefore,
    "Resume comparison mutated its input snapshot.",
  );
  const uninterruptedRest = run(plan, uninterruptedFirst.snapshot);

  const restored = assertCheckpointRoundTrip(plan, snapshot);
  const resumedFirst = continueExecution(restored.plan, restored.snapshot);
  const resumedRest = run(restored.plan, resumedFirst.snapshot);

  assert.deepEqual(
    [...resumedFirst.events, ...resumedRest.events],
    [...uninterruptedFirst.events, ...uninterruptedRest.events],
  );
  assert.deepEqual(resumedRest.snapshot, uninterruptedRest.snapshot);
}

export function observePlanBoundary(value: unknown): StructuredBoundaryObservation {
  let validation;
  try {
    validation = validateInstructionPlan(value);
  } catch (error) {
    assert.fail(`Plan validation leaked ${nativeErrorDescription(error)}.`);
  }
  return validation.valid
    ? Object.freeze({ kind: "accepted", detail: "valid" })
    : Object.freeze({
        kind: "rejected",
        detail: validation.errors.map((error) => `${error.code}:${error.path}`).join(","),
      });
}

export function observeSnapshotBoundary(
  value: unknown,
  plan?: InstructionPlan,
): StructuredBoundaryObservation {
  let validation;
  try {
    validation = validateRuntimeSnapshot(value, plan);
  } catch (error) {
    assert.fail(`Snapshot validation leaked ${nativeErrorDescription(error)}.`);
  }
  return validation.valid
    ? Object.freeze({ kind: "accepted", detail: "valid" })
    : Object.freeze({
        kind: "rejected",
        detail: validation.errors.join(","),
      });
}

export function observeCheckpointBoundary(
  value: unknown,
): StructuredBoundaryObservation {
  try {
    restoreCheckpoint(value);
    return Object.freeze({ kind: "accepted", detail: "valid" });
  } catch (error) {
    assert.ok(
      error instanceof CheckpointError,
      `Checkpoint restoration leaked ${nativeErrorDescription(error)}.`,
    );
    return Object.freeze({
      kind: "rejected",
      detail: `${error.info.code}:${error.info.path}`,
    });
  }
}

export function observeRuntimeBoundary(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): StructuredBoundaryObservation {
  const beforePlan = structuredClone(plan);
  const beforeSnapshot = structuredClone(snapshot);
  try {
    const operation = run(plan, snapshot);
    assert.deepEqual(plan, beforePlan);
    assert.deepEqual(snapshot, beforeSnapshot);
    assertAcceptedSnapshot(plan, operation.snapshot);
    return Object.freeze({
      kind: "accepted",
      detail: `${operation.snapshot.status}:${operation.events.length}`,
    });
  } catch (error) {
    assert.ok(
      error instanceof RuntimeDataError,
      `Runtime boundary leaked ${nativeErrorDescription(error)}.`,
    );
    assert.deepEqual(plan, beforePlan);
    assert.deepEqual(snapshot, beforeSnapshot);
    return Object.freeze({
      kind: "rejected",
      detail: `${error.code}:${error.message}`,
    });
  }
}

export function cloneCheckpointValue(
  checkpoint: RuntimeCheckpoint,
): Record<string, unknown> {
  return JSON.parse(serializeCheckpoint(checkpoint)) as Record<string, unknown>;
}

export function stableObservation(
  observation: StructuredBoundaryObservation,
): string {
  return `${observation.kind}:${observation.detail}`;
}

function nativeErrorDescription(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
