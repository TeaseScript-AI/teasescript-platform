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

export interface PropertyBoundaryMeasurement<T> {
  readonly value: T;
  readonly boundaries: readonly string[];
}

let activeBoundaryTrace: string[] | null = null;

export function measurePropertyBoundaryWork<T>(
  operation: () => T,
): PropertyBoundaryMeasurement<T> {
  assert.equal(activeBoundaryTrace, null, "Property boundary measurement cannot be nested.");
  const boundaries: string[] = [];
  activeBoundaryTrace = boundaries;
  try {
    return Object.freeze({
      value: operation(),
      boundaries: Object.freeze([...boundaries]),
    });
  } finally {
    activeBoundaryTrace = null;
  }
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

type CapturedPrimitive =
  | null
  | undefined
  | string
  | number
  | boolean
  | bigint
  | symbol
  | ((...argumentsValue: never[]) => unknown);

type CapturedValue =
  | { readonly kind: "primitive"; readonly value: CapturedPrimitive }
  | { readonly kind: "reference"; readonly id: number };

type CapturedPrototype =
  | null
  | "Object.prototype"
  | "Array.prototype"
  | { readonly kind: "reference"; readonly id: number };

interface CapturedDataDescriptor {
  readonly kind: "data";
  readonly key: PropertyKey;
  readonly configurable: boolean;
  readonly enumerable: boolean;
  readonly writable: boolean;
  readonly value: CapturedValue;
}

interface CapturedAccessorDescriptor {
  readonly kind: "accessor";
  readonly key: PropertyKey;
  readonly configurable: boolean;
  readonly enumerable: boolean;
  readonly get: (() => unknown) | undefined;
  readonly set: ((value: unknown) => void) | undefined;
}

type CapturedDescriptor = CapturedDataDescriptor | CapturedAccessorDescriptor;

interface CapturedNode {
  readonly id: number;
  readonly prototype: CapturedPrototype;
  readonly descriptors: readonly CapturedDescriptor[];
}

export interface PropertyValueSnapshot {
  readonly root: CapturedValue;
  readonly nodes: readonly CapturedNode[];
}

/**
 * Capture object topology, prototypes, own keys, and property descriptors without
 * invoking accessors or normalizing non-plain objects. Aliases and cycles are
 * represented by stable node references.
 */
export function capturePropertyValue(value: unknown): PropertyValueSnapshot {
  const identifiers = new WeakMap<object, number>();
  const nodes: CapturedNode[] = [];

  function capture(current: unknown): CapturedValue {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      return Object.freeze({ kind: "primitive", value: current as CapturedPrimitive });
    }
    if (typeof current === "function") {
      return Object.freeze({ kind: "primitive", value: current as CapturedPrimitive });
    }

    const known = identifiers.get(current);
    if (known !== undefined) return Object.freeze({ kind: "reference", id: known });

    const id = nodes.length;
    identifiers.set(current, id);
    nodes.push(undefined as unknown as CapturedNode);

    const prototypeValue = Object.getPrototypeOf(current) as object | null;
    const prototype: CapturedPrototype = prototypeValue === null
      ? null
      : prototypeValue === Object.prototype
        ? "Object.prototype"
        : prototypeValue === Array.prototype
          ? "Array.prototype"
          : capture(prototypeValue) as { readonly kind: "reference"; readonly id: number };

    const descriptors = Reflect.ownKeys(current).map((key): CapturedDescriptor => {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      assert.notEqual(descriptor, undefined);
      const present = descriptor!;
      if ("value" in present) {
        return Object.freeze({
          kind: "data",
          key,
          configurable: present.configurable ?? false,
          enumerable: present.enumerable ?? false,
          writable: present.writable ?? false,
          value: capture(present.value),
        });
      }
      return Object.freeze({
        kind: "accessor",
        key,
        configurable: present.configurable ?? false,
        enumerable: present.enumerable ?? false,
        get: present.get,
        set: present.set,
      });
    });

    nodes[id] = Object.freeze({ id, prototype, descriptors: Object.freeze(descriptors) });
    return Object.freeze({ kind: "reference", id });
  }

  return Object.freeze({ root: capture(value), nodes: Object.freeze(nodes) });
}

export function assertPropertyValueUnchanged(
  value: unknown,
  before: PropertyValueSnapshot,
  message: string,
): void {
  assert.deepEqual(capturePropertyValue(value), before, message);
}

export function assertAcceptedPlan(plan: InstructionPlan): void {
  const before = capturePropertyValue(plan);
  atPropertyBoundary("validateInstructionPlan", () => {
    const validation = validateInstructionPlan(plan);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  });
  assertPropertyValueUnchanged(plan, before, "Plan validation mutated its input.");
}

export function assertAcceptedSnapshot(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): void {
  const beforePlan = capturePropertyValue(plan);
  const beforeSnapshot = capturePropertyValue(snapshot);
  atPropertyBoundary("validateRuntimeSnapshot", () => {
    const validation = validateRuntimeSnapshot(snapshot, plan);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  });
  assertPropertyValueUnchanged(plan, beforePlan, "Snapshot validation mutated its plan.");
  assertPropertyValueUnchanged(snapshot, beforeSnapshot, "Snapshot validation mutated its input.");
}

export function assertSuccessfulRuntimeOperation<T extends RuntimeOperationResult>(
  boundary: string,
  plan: InstructionPlan,
  inputSnapshot: RuntimeSnapshot,
  operation: () => T,
): T {
  const planBefore = capturePropertyValue(plan);
  const snapshotBefore = capturePropertyValue(inputSnapshot);
  try {
    const result = atPropertyBoundary(boundary, operation);
    assertAcceptedSnapshot(plan, result.snapshot);
    return result;
  } finally {
    atPropertyStage(boundary, () => {
      assertPropertyValueUnchanged(plan, planBefore, "Runtime operation mutated its input plan.");
      assertPropertyValueUnchanged(
        inputSnapshot,
        snapshotBefore,
        "Runtime operation mutated its input snapshot.",
      );
    });
  }
}

export function assertSuccessfulCompletionOperation(
  plan: InstructionPlan,
  inputSnapshot: RuntimeSnapshot,
  request: unknown,
): PendingActionOperationResult<ActionCompletionOutcome> {
  const requestBefore = capturePropertyValue(request);
  try {
    return assertSuccessfulRuntimeOperation(
      "completeAction",
      plan,
      inputSnapshot,
      () => completeAction(plan, inputSnapshot, request),
    );
  } finally {
    atPropertyStage("completeAction", () => {
      assertPropertyValueUnchanged(request, requestBefore, "Completion mutated its request.");
    });
  }
}

export function assertCompletionRejectedWithoutMutation(
  plan: InstructionPlan,
  inputSnapshot: RuntimeSnapshot,
  request: unknown,
  allowedOutcomes: readonly ActionCompletionOutcome["kind"][],
): PendingActionOperationResult<ActionCompletionOutcome> {
  const planBefore = capturePropertyValue(plan);
  const snapshotBefore = capturePropertyValue(inputSnapshot);
  const requestBefore = capturePropertyValue(request);
  try {
    const result = atPropertyBoundary(
      "completeAction",
      () => completeAction(plan, inputSnapshot, request),
    );
    atPropertyStage("completeAction", () => {
      assert.ok(
        allowedOutcomes.includes(result.outcome.kind),
        `Unexpected completion outcome: ${result.outcome.kind}`,
      );
      assert.deepEqual(
        result.snapshot,
        inputSnapshot,
        "Rejected completion mutated canonical state.",
      );
      assert.deepEqual(result.events, [], "Rejected completion emitted events.");
    });
    assertAcceptedSnapshot(plan, result.snapshot);
    return result;
  } finally {
    atPropertyStage("completeAction", () => {
      assertPropertyValueUnchanged(plan, planBefore, "Completion mutated the input plan.");
      assertPropertyValueUnchanged(
        inputSnapshot,
        snapshotBefore,
        "Completion mutated the input snapshot.",
      );
      assertPropertyValueUnchanged(request, requestBefore, "Completion mutated its request.");
    });
  }
}

export function assertCheckpointRoundTrip(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): RuntimeCheckpoint {
  const planBefore = structuredClone(plan);
  const snapshotBefore = structuredClone(snapshot);
  const planGraphBefore = capturePropertyValue(plan);
  const snapshotGraphBefore = capturePropertyValue(snapshot);
  let checkpoint: RuntimeCheckpoint;
  try {
    checkpoint = atPropertyBoundary(
      "createCheckpoint",
      () => createCheckpoint(plan, snapshot),
    );
  } finally {
    atPropertyStage("createCheckpoint", () => {
      assertPropertyValueUnchanged(plan, planGraphBefore, "Checkpoint creation mutated its input plan.");
      assertPropertyValueUnchanged(
        snapshot,
        snapshotGraphBefore,
        "Checkpoint creation mutated its input snapshot.",
      );
    });
  }
  atPropertyStage("createCheckpoint", () => {
    assert.deepEqual(checkpoint.plan, planBefore, "Checkpoint creation changed the canonical plan.");
    assert.deepEqual(
      checkpoint.snapshot,
      snapshotBefore,
      "Checkpoint creation changed the canonical snapshot.",
    );
  });

  const checkpointBeforeSerialization = capturePropertyValue(checkpoint);
  let serialized: string;
  try {
    serialized = atPropertyBoundary(
      "serializeCheckpoint",
      () => serializeCheckpoint(checkpoint),
    );
  } finally {
    atPropertyStage("serializeCheckpoint", () => {
      assertPropertyValueUnchanged(
        checkpoint,
        checkpointBeforeSerialization,
        "Checkpoint serialization mutated its input.",
      );
    });
  }

  const restored = atPropertyBoundary(
    "deserializeCheckpoint",
    () => deserializeCheckpoint(serialized),
  );
  atPropertyStage("deserializeCheckpoint", () => {
    assert.deepEqual(restored.plan, planBefore);
    assert.deepEqual(restored.snapshot, snapshotBefore);
  });

  const restoredBeforeSerialization = capturePropertyValue(restored);
  try {
    atPropertyBoundary("serializeCheckpoint", () => {
      assert.equal(serializeCheckpoint(restored), serialized);
    });
  } finally {
    atPropertyStage("serializeCheckpoint", () => {
      assertPropertyValueUnchanged(
        restored,
        restoredBeforeSerialization,
        "Restored checkpoint serialization mutated its input.",
      );
    });
  }
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
  const planBefore = capturePropertyValue(plan);
  const snapshotBefore = capturePropertyValue(snapshot);
  let uninterruptedFirst: RuntimeOperationResult;
  try {
    uninterruptedFirst = atPropertyBoundary(
      `${continueBoundary}:uninterrupted`,
      () => continueExecution(plan, snapshot),
    );
  } finally {
    atPropertyStage(`${continueBoundary}:uninterrupted`, () => {
      assertPropertyValueUnchanged(plan, planBefore, "Resume comparison mutated its input plan.");
      assertPropertyValueUnchanged(
        snapshot,
        snapshotBefore,
        "Resume comparison mutated its input snapshot.",
      );
    });
  }
  assertAcceptedSnapshot(plan, uninterruptedFirst.snapshot);

  const uninterruptedRest = atPropertyBoundary(
    "run:uninterrupted-remainder",
    () => run(plan, uninterruptedFirst.snapshot),
  );
  assertAcceptedSnapshot(plan, uninterruptedRest.snapshot);

  const restored = assertCheckpointRoundTrip(plan, snapshot);
  const resumedFirst = atPropertyBoundary(
    `${continueBoundary}:resumed`,
    () => continueExecution(restored.plan, restored.snapshot),
  );
  assertAcceptedSnapshot(restored.plan, resumedFirst.snapshot);
  const resumedRest = atPropertyBoundary(
    "run:resumed-remainder",
    () => run(restored.plan, resumedFirst.snapshot),
  );
  assertAcceptedSnapshot(restored.plan, resumedRest.snapshot);

  atPropertyStage("resume-equivalence:first-operation", () => {
    assert.deepEqual(resumedFirst, uninterruptedFirst);
  });
  atPropertyStage("resume-equivalence:remainder", () => {
    assert.deepEqual(resumedRest, uninterruptedRest);
  });
}

export function observePlanBoundary(value: unknown): StructuredBoundaryObservation {
  const before = capturePropertyValue(value);
  let validation;
  try {
    validation = atPropertyBoundary(
      "validateInstructionPlan",
      () => validateInstructionPlan(value),
    );
  } catch (error) {
    throw new PropertyBoundaryFailure(
      "validateInstructionPlan",
      new Error(`Plan validation leaked ${nativeErrorDescription(error)}.`),
    );
  } finally {
    assertPropertyValueUnchanged(value, before, "Plan boundary mutated its input.");
  }
  return validation.valid
    ? Object.freeze({ kind: "accepted", detail: "valid" })
    : Object.freeze({
        kind: "rejected",
        detail: validation.errors.map((error) => `${error.code}:${error.path}:${error.message}`).join(","),
      });
}

export function observeSnapshotBoundary(
  value: unknown,
  plan?: InstructionPlan,
): StructuredBoundaryObservation {
  const beforeValue = capturePropertyValue(value);
  const beforePlan = capturePropertyValue(plan);
  let validation;
  try {
    validation = atPropertyBoundary(
      "validateRuntimeSnapshot",
      () => validateRuntimeSnapshot(value, plan),
    );
  } catch (error) {
    throw new PropertyBoundaryFailure(
      "validateRuntimeSnapshot",
      new Error(`Snapshot validation leaked ${nativeErrorDescription(error)}.`),
    );
  } finally {
    assertPropertyValueUnchanged(value, beforeValue, "Snapshot boundary mutated its input.");
    assertPropertyValueUnchanged(plan, beforePlan, "Snapshot boundary mutated its plan.");
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
  const before = capturePropertyValue(value);
  recordPropertyBoundary("restoreCheckpoint");
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
      detail: `${error.info.code}:${error.info.path}:${error.info.message}`,
    });
  } finally {
    assertPropertyValueUnchanged(value, before, "Checkpoint boundary mutated its input.");
  }
}

export function observeRuntimeBoundary(
  plan: unknown,
  snapshot: unknown,
): StructuredBoundaryObservation {
  const beforePlan = capturePropertyValue(plan);
  const beforeSnapshot = capturePropertyValue(snapshot);
  recordPropertyBoundary("run");
  try {
    try {
      const operation = run(plan as InstructionPlan, snapshot as RuntimeSnapshot);
      assertAcceptedSnapshot(plan as InstructionPlan, operation.snapshot);
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
      return Object.freeze({
        kind: "rejected",
        detail: `${error.code}:${error.message}`,
      });
    }
  } finally {
    atPropertyStage("run", () => {
      assertPropertyValueUnchanged(plan, beforePlan, "Runtime boundary mutated its plan.");
      assertPropertyValueUnchanged(snapshot, beforeSnapshot, "Runtime boundary mutated its snapshot.");
    });
  }
}

export function cloneCheckpointValue(
  checkpoint: RuntimeCheckpoint,
): Record<string, unknown> {
  return JSON.parse(
    atPropertyBoundary("serializeCheckpoint", () => serializeCheckpoint(checkpoint)),
  ) as Record<string, unknown>;
}

export function stableObservation(
  observation: StructuredBoundaryObservation,
): string {
  return `${observation.kind}:${observation.detail}`;
}

export function atPropertyBoundary<T>(boundary: string, operation: () => T): T {
  recordPropertyBoundary(boundary);
  return atPropertyStage(boundary, operation);
}

function atPropertyStage<T>(boundary: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PropertyBoundaryFailure) throw error;
    throw new PropertyBoundaryFailure(boundary, error);
  }
}

function recordPropertyBoundary(boundary: string): void {
  activeBoundaryTrace?.push(boundary);
}

function nativeErrorDescription(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
