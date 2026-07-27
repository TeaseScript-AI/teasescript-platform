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

export class PropertyBoundaryFailure extends Error {
  public readonly boundary: string;

  public constructor(boundary: string, cause: unknown) {
    const causeText = cause instanceof Error
      ? `${cause.name}: ${cause.message}`
      : String(cause);
    super(`Property boundary ${boundary} failed: ${causeText}`, { cause });
    this.name = "PropertyBoundaryFailure";
    this.boundary = boundary;
  }
}

export function assertAcceptedPlan(plan: InstructionPlan): void {
  atPropertyBoundary("validateInstructionPlan", () => {
    const validation = validateInstructionPlan(plan);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  });
}

export function assertAcceptedSnapshot(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): void {
  atPropertyBoundary("validateRuntimeSnapshot", () => {
    const validation = validateRuntimeSnapshot(snapshot, plan);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  });
}

export function assertSuccessfulRuntimeOperation<T extends RuntimeOperationResult>(
  boundary: string,
  plan: InstructionPlan,
  inputSnapshot: RuntimeSnapshot,
  operation: () => T,
): T {
  const planBefore = structuredClone(plan);
  const snapshotBefore = structuredClone(inputSnapshot);
  const result = atPropertyBoundary(boundary, operation);
  atPropertyBoundary(boundary, () => {
    assert.deepEqual(plan, planBefore, "Runtime operation mutated its input plan.");
    assert.deepEqual(
      inputSnapshot,
      snapshotBefore,
      "Runtime operation mutated its input snapshot.",
    );
  });
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
  const result = atPropertyBoundary(
    "completeAction",
    () => completeAction(plan, inputSnapshot, request),
  );
  atPropertyBoundary("completeAction", () => {
    assert.ok(
      allowedOutcomes.includes(result.outcome.kind),
      `Unexpected completion outcome: ${result.outcome.kind}`,
    );
    assert.deepEqual(plan, planBefore, "Completion mutated the input plan.");
    assert.deepEqual(inputSnapshot, before, "Completion mutated the input snapshot.");
    assert.deepEqual(result.snapshot, before, "Rejected completion mutated canonical state.");
    assert.deepEqual(result.events, [], "Rejected completion emitted events.");
  });
  assertAcceptedSnapshot(plan, result.snapshot);
  return result;
}

export function assertCheckpointRoundTrip(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): RuntimeCheckpoint {
  const planBefore = structuredClone(plan);
  const snapshotBefore = structuredClone(snapshot);
  const checkpoint = atPropertyBoundary("createCheckpoint", () => {
    const created = createCheckpoint(plan, snapshot);
    assert.deepEqual(plan, planBefore, "Checkpoint creation mutated its input plan.");
    assert.deepEqual(
      snapshot,
      snapshotBefore,
      "Checkpoint creation mutated its input snapshot.",
    );
    assert.deepEqual(
      created.plan,
      planBefore,
      "Checkpoint creation changed the canonical plan.",
    );
    assert.deepEqual(
      created.snapshot,
      snapshotBefore,
      "Checkpoint creation changed the canonical snapshot.",
    );
    return created;
  });
  const serialized = atPropertyBoundary(
    "serializeCheckpoint",
    () => serializeCheckpoint(checkpoint),
  );
  const restored = atPropertyBoundary(
    "deserializeCheckpoint",
    () => deserializeCheckpoint(serialized),
  );
  atPropertyBoundary("deserializeCheckpoint", () => {
    assert.deepEqual(restored.plan, planBefore);
    assert.deepEqual(restored.snapshot, snapshotBefore);
  });
  atPropertyBoundary("serializeCheckpoint", () => {
    assert.equal(serializeCheckpoint(restored), serialized);
  });
  return restored;
}

export function assertResumeEquivalent(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  continueExecution: (
    currentPlan: InstructionPlan,
    currentSnapshot: RuntimeSnapshot,
  ) => RuntimeOperationResult,
  continueBoundary: string,
): void {
  const planBefore = structuredClone(plan);
  const snapshotBefore = structuredClone(snapshot);
  const uninterruptedFirst = atPropertyBoundary(
    `${continueBoundary}:uninterrupted`,
    () => continueExecution(plan, snapshot),
  );
  atPropertyBoundary(`${continueBoundary}:uninterrupted`, () => {
    assert.deepEqual(plan, planBefore, "Resume comparison mutated its input plan.");
    assert.deepEqual(
      snapshot,
      snapshotBefore,
      "Resume comparison mutated its input snapshot.",
    );
  });
  const uninterruptedRest = atPropertyBoundary(
    "run:uninterrupted-remainder",
    () => run(plan, uninterruptedFirst.snapshot),
  );

  const restored = assertCheckpointRoundTrip(plan, snapshot);
  const resumedFirst = atPropertyBoundary(
    `${continueBoundary}:resumed`,
    () => continueExecution(restored.plan, restored.snapshot),
  );
  const resumedRest = atPropertyBoundary(
    "run:resumed-remainder",
    () => run(restored.plan, resumedFirst.snapshot),
  );

  atPropertyBoundary("resume-equivalence:comparison", () => {
    assert.deepEqual(
      [...resumedFirst.events, ...resumedRest.events],
      [...uninterruptedFirst.events, ...uninterruptedRest.events],
    );
    assert.deepEqual(resumedRest.snapshot, uninterruptedRest.snapshot);
  });
}

export function observePlanBoundary(value: unknown): StructuredBoundaryObservation {
  let validation;
  try {
    validation = validateInstructionPlan(value);
  } catch (error) {
    throw new PropertyBoundaryFailure(
      "validateInstructionPlan",
      new Error(`Plan validation leaked ${nativeErrorDescription(error)}.`),
    );
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
    throw new PropertyBoundaryFailure(
      "validateRuntimeSnapshot",
      new Error(`Snapshot validation leaked ${nativeErrorDescription(error)}.`),
    );
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
    if (!(error instanceof CheckpointError)) {
      throw new PropertyBoundaryFailure(
        "restoreCheckpoint",
        new Error(`Checkpoint restoration leaked ${nativeErrorDescription(error)}.`),
      );
    }
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
    if (!(error instanceof RuntimeDataError)) {
      throw new PropertyBoundaryFailure(
        "run",
        new Error(`Runtime boundary leaked ${nativeErrorDescription(error)}.`),
      );
    }
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

function atPropertyBoundary<T>(boundary: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PropertyBoundaryFailure) throw error;
    throw new PropertyBoundaryFailure(boundary, error);
  }
}

function nativeErrorDescription(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
