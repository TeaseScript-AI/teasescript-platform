import assert from "node:assert/strict";

import {
  MAX_INTERACTION_STRING_UTF8_BYTES,
  completeAction,
  createFreshRuntimeSnapshot,
  executeInstruction,
  observeTime,
  run,
  type InstructionPlan,
  type RuntimeSnapshot,
} from "../../src/index.js";
import {
  createExactLimitButtonPlan,
  createExactLimitChoicePlan,
  createInteractionPlan,
  createOverLimitButtonPlan,
  createOverLimitChoicePlan,
  summarizeFixture,
  type PropertyFixtureCatalog,
} from "./fixtures.js";
import {
  assertAcceptedPlan,
  assertAcceptedSnapshot,
  assertCheckpointRoundTrip,
  assertCompletionRejectedWithoutMutation,
  assertResumeEquivalent,
  assertSuccessfulRuntimeOperation,
  cloneCheckpointValue,
  observeCheckpointBoundary,
  observePlanBoundary,
  observeRuntimeBoundary,
  observeSnapshotBoundary,
  stableObservation,
} from "./invariants.js";

export interface PropertyCaseVariant {
  readonly first: number;
  readonly second: number;
  readonly third: number;
}

export interface PropertyCaseObservation {
  readonly detail: string;
  readonly fixtureSummary: string;
}

export interface PropertyCaseDefinition {
  readonly id: string;
  readonly property: string;
  readonly boundary: string;
  readonly repeatable: boolean;
  readonly execute: (
    fixtures: PropertyFixtureCatalog,
    variant: PropertyCaseVariant,
  ) => PropertyCaseObservation;
}

function observation(
  detail: string,
  fixtureSummary: string,
): PropertyCaseObservation {
  return Object.freeze({ detail, fixtureSummary });
}

function structuredPlanCase(
  id: string,
  mutate: (
    value: Record<string, unknown>,
    fixtures: PropertyFixtureCatalog,
    variant: PropertyCaseVariant,
  ) => void,
  options: {
    readonly repeatable?: boolean;
    readonly fixture?: "simple" | "interaction";
    readonly expected?: "accepted" | "rejected";
  } = {},
): PropertyCaseDefinition {
  return Object.freeze({
    id,
    property: "structured external plan boundary",
    boundary: "validateInstructionPlan",
    repeatable: options.repeatable ?? true,
    execute(fixtures: PropertyFixtureCatalog, variant: PropertyCaseVariant) {
      const source = options.fixture === "interaction"
        ? fixtures.waitingText.plan
        : fixtures.simplePlan;
      const value = cloneRecord(source);
      mutate(value, fixtures, variant);
      const before = comparableClone(value);
      const first = observePlanBoundary(value);
      const second = observePlanBoundary(value);
      assert.deepEqual(second, first);
      assertComparableUnchanged(value, before, "Plan boundary mutated its input.");
      assert.equal(first.kind, options.expected ?? "rejected");
      return observation(stableObservation(first), `plan:${options.fixture ?? "simple"}`);
    },
  });
}

function structuredSnapshotCase(
  id: string,
  fixtureName: keyof Pick<
    PropertyFixtureCatalog,
    | "fresh"
    | "running"
    | "halted"
    | "failed"
    | "waitingDelay"
    | "settledDelay"
    | "waitingText"
    | "settledText"
    | "activeSpeaker"
    | "activeScope"
    | "activeLoop"
    | "activeCall"
  >,
  mutate: (
    value: Record<string, unknown>,
    fixtures: PropertyFixtureCatalog,
    variant: PropertyCaseVariant,
  ) => void,
  options: {
    readonly repeatable?: boolean;
    readonly expected?: "accepted" | "rejected";
  } = {},
): PropertyCaseDefinition {
  return Object.freeze({
    id,
    property: "structured external snapshot boundary",
    boundary: "validateRuntimeSnapshot",
    repeatable: options.repeatable ?? true,
    execute(fixtures: PropertyFixtureCatalog, variant: PropertyCaseVariant) {
      const fixture = fixtures[fixtureName];
      const value = cloneRecord(fixture.snapshot);
      mutate(value, fixtures, variant);
      const before = comparableClone(value);
      const first = observeSnapshotBoundary(value, fixture.plan);
      const second = observeSnapshotBoundary(value, fixture.plan);
      assert.deepEqual(second, first);
      assertComparableUnchanged(value, before, "Snapshot boundary mutated its input.");
      assert.equal(first.kind, options.expected ?? "rejected");
      return observation(stableObservation(first), summarizeFixture(fixture));
    },
  });
}

function structuredCheckpointCase(
  id: string,
  mutate: (
    value: Record<string, unknown>,
    fixtures: PropertyFixtureCatalog,
    variant: PropertyCaseVariant,
  ) => void,
  options: {
    readonly repeatable?: boolean;
    readonly expected?: "accepted" | "rejected";
  } = {},
): PropertyCaseDefinition {
  return Object.freeze({
    id,
    property: "structured external checkpoint boundary",
    boundary: "restoreCheckpoint",
    repeatable: options.repeatable ?? true,
    execute(fixtures: PropertyFixtureCatalog, variant: PropertyCaseVariant) {
      const value = cloneCheckpointValue(fixtures.textCheckpoint);
      mutate(value, fixtures, variant);
      const before = comparableClone(value);
      const first = observeCheckpointBoundary(value);
      const second = observeCheckpointBoundary(value);
      assert.deepEqual(second, first);
      assertComparableUnchanged(value, before, "Checkpoint boundary mutated its input.");
      assert.equal(first.kind, options.expected ?? "rejected");
      return observation(stableObservation(first), "checkpoint:waiting-text");
    },
  });
}

const CASES: readonly PropertyCaseDefinition[] = Object.freeze([
  Object.freeze({
    id: "runtime-run-closes-over-validator",
    property: "successful runtime operation closes over validator",
    boundary: "run",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const operation = assertSuccessfulRuntimeOperation(
        fixtures.fresh.plan,
        fixtures.fresh.snapshot,
        () => run(fixtures.fresh.plan, fixtures.fresh.snapshot),
      );
      return observation(operation.snapshot.status, summarizeFixture(fixtures.fresh));
    },
  }),
  Object.freeze({
    id: "runtime-execute-instruction-closes-over-validator",
    property: "successful runtime operation closes over validator",
    boundary: "executeInstruction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const operation = assertSuccessfulRuntimeOperation(
        fixtures.running.plan,
        fixtures.running.snapshot,
        () => executeInstruction(fixtures.running.plan, fixtures.running.snapshot),
      );
      return observation(operation.snapshot.status, summarizeFixture(fixtures.running));
    },
  }),
  Object.freeze({
    id: "delay-observation-closes-over-validator",
    property: "successful runtime operation closes over validator",
    boundary: "observeTime",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const operation = assertSuccessfulRuntimeOperation(
        fixtures.waitingDelay.plan,
        fixtures.waitingDelay.snapshot,
        () => observeTime(
          fixtures.waitingDelay.plan,
          fixtures.waitingDelay.snapshot,
          1_000,
        ),
      );
      assert.equal(operation.outcome.kind, "observed");
      return observation("observed", summarizeFixture(fixtures.waitingDelay));
    },
  }),
  Object.freeze({
    id: "delay-completion-request-closes-over-validator",
    property: "successful runtime operation closes over validator",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const operation = assertSuccessfulRuntimeOperation(
        fixtures.waitingDelay.plan,
        fixtures.waitingDelay.snapshot,
        () => completeAction(
          fixtures.waitingDelay.plan,
          fixtures.waitingDelay.snapshot,
          fixtures.validDelayCompletion,
        ),
      );
      assert.equal(operation.outcome.kind, "completed");
      return observation("completed", summarizeFixture(fixtures.waitingDelay));
    },
  }),
  Object.freeze({
    id: "interaction-completion-closes-over-validator",
    property: "successful runtime operation closes over validator",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const operation = assertSuccessfulRuntimeOperation(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        () => completeAction(
          fixtures.waitingText.plan,
          fixtures.waitingText.snapshot,
          fixtures.validTextCompletion,
        ),
      );
      assert.equal(operation.outcome.kind, "completed");
      return observation("completed", summarizeFixture(fixtures.waitingText));
    },
  }),
  Object.freeze({
    id: "invalid-completion-preserves-state",
    property: "invalid completion does not mutate canonical state",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog, variant: PropertyCaseVariant) {
      const request = {
        ...fixtures.validTextCompletion,
        payload: {
          kind: "submittedText",
          submittedText: variant.first % 2 === 0 ? "   " : "\r\n\t",
        },
      };
      const result = assertCompletionRejectedWithoutMutation(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        request,
        ["invalidPayload"],
      );
      return observation(result.outcome.kind, summarizeFixture(fixtures.waitingText));
    },
  }),
  Object.freeze({
    id: "duplicate-completion-preserves-state",
    property: "duplicate completion does not mutate canonical state",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const result = assertCompletionRejectedWithoutMutation(
        fixtures.settledText.plan,
        fixtures.settledText.snapshot,
        fixtures.duplicateTextCompletion,
        ["alreadySettled"],
      );
      return observation(result.outcome.kind, summarizeFixture(fixtures.settledText));
    },
  }),
  Object.freeze({
    id: "checkpoint-json-roundtrip-equivalent",
    property: "checkpoint JSON round trip is canonical",
    boundary: "serializeCheckpoint/deserializeCheckpoint",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const restored = assertCheckpointRoundTrip(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
      );
      return observation(restored.snapshot.status, summarizeFixture(fixtures.waitingText));
    },
  }),
  Object.freeze({
    id: "delay-restore-resume-equivalent",
    property: "restored execution equals uninterrupted execution",
    boundary: "checkpoint/observeTime/run",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      assertResumeEquivalent(
        fixtures.waitingDelay.plan,
        fixtures.waitingDelay.snapshot,
        (plan, snapshot) => observeTime(plan, snapshot, 1_000),
      );
      return observation("equivalent", summarizeFixture(fixtures.waitingDelay));
    },
  }),
  Object.freeze({
    id: "interaction-restore-resume-equivalent",
    property: "restored execution equals uninterrupted execution",
    boundary: "checkpoint/completeAction/run",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      assertResumeEquivalent(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        (plan, snapshot) => completeAction(plan, snapshot, fixtures.validTextCompletion),
      );
      return observation("equivalent", summarizeFixture(fixtures.waitingText));
    },
  }),

  structuredPlanCase("plan-missing-format", (value) => {
    delete value.format;
  }),
  structuredPlanCase("plan-extra-root-field", (value, _fixtures, variant) => {
    value.extra = `retained-${variant.first.toString(16)}`;
  }, { expected: "accepted" }),
  structuredPlanCase("plan-wrong-version", (value, _fixtures, variant) => {
    value.version = 6 + (variant.first % 10_000);
  }),
  structuredPlanCase("plan-wrong-instructions-type", (value) => {
    value.instructions = "not-an-array";
  }),
  structuredPlanCase("plan-non-finite-temporary-count", (value, _fixtures, variant) => {
    value.temporaryCount = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY][
      variant.first % 3
    ];
  }),
  structuredPlanCase("plan-unsafe-root-end", (value) => {
    value.rootEndInstruction = Number.MAX_SAFE_INTEGER + 1;
  }),
  structuredPlanCase("plan-negative-zero-boundary", (value) => {
    value.rootEndInstruction = -0;
  }),
  structuredPlanCase("plan-invalid-jump-target", (value, fixtures, variant) => {
    const scopePlan = cloneRecord(fixtures.activeScope.plan);
    const instructions = arrayValue(scopePlan.instructions);
    const jump = instructions.find(
      (instruction) => recordValue(instruction).kind === "jumpIfFalse",
    );
    assert.notEqual(jump, undefined);
    recordValue(jump).target = instructions.length + 1 + (variant.first % 1_000);
    replaceRecord(value, scopePlan);
  }),
  structuredPlanCase("plan-invalid-result-destination", (value) => {
    const instruction = interactionInstructionRecord(value);
    instruction.destinationTemporary = 0;
  }, { fixture: "interaction" }),
  Object.freeze({
    id: "plan-exact-string-limit-accepted",
    property: "exact technical string boundary is accepted",
    boundary: "validateInstructionPlan",
    repeatable: false,
    execute() {
      const plan = createExactLimitButtonPlan();
      assertAcceptedPlan(plan);
      return observation("accepted", "plan:exact-button-string-limit");
    },
  }),
  Object.freeze({
    id: "plan-over-string-limit-structured",
    property: "over-limit string is rejected structurally",
    boundary: "validateInstructionPlan",
    repeatable: false,
    execute() {
      const result = observePlanBoundary(createOverLimitButtonPlan());
      assert.equal(result.kind, "rejected");
      return observation(stableObservation(result), "plan:over-button-string-limit");
    },
  }),
  Object.freeze({
    id: "plan-exact-option-limit-accepted",
    property: "exact technical collection boundary is accepted",
    boundary: "validateInstructionPlan",
    repeatable: false,
    execute() {
      const plan = createExactLimitChoicePlan();
      assertAcceptedPlan(plan);
      return observation("accepted", "plan:exact-choice-option-limit");
    },
  }),
  Object.freeze({
    id: "plan-over-option-limit-structured",
    property: "over-limit collection is rejected structurally",
    boundary: "validateInstructionPlan",
    repeatable: false,
    execute() {
      const result = observePlanBoundary(createOverLimitChoicePlan());
      assert.equal(result.kind, "rejected");
      return observation(stableObservation(result), "plan:over-choice-option-limit");
    },
  }),
  Object.freeze({
    id: "plan-over-aggregate-string-limit-structured",
    property: "aggregate technical string limit is enforced",
    boundary: "validateInstructionPlan",
    repeatable: false,
    execute() {
      const plan = createInteractionPlan("button", {
        kind: "button",
        buttonLabel: "x",
        accessibleName: { kind: "localizedDefault", key: "continue" },
      });
      const mutated = structuredClone(plan) as InstructionPlan;
      const instruction = mutated.instructions.find(
        (candidate) => candidate.kind === "interaction",
      );
      assert.ok(instruction !== undefined && instruction.kind === "interaction");
      assert.equal(instruction.ui.kind, "button");
      const ui = instruction.ui as unknown as {
        buttonLabel: string;
        accessibleName: { kind: "text"; text: string };
      };
      ui.buttonLabel = "x".repeat((MAX_INTERACTION_STRING_UTF8_BYTES / 2) + 1);
      ui.accessibleName = {
        kind: "text",
        text: "y".repeat(MAX_INTERACTION_STRING_UTF8_BYTES / 2),
      };
      const result = observePlanBoundary(mutated);
      assert.equal(result.kind, "rejected");
      return observation(stableObservation(result), "plan:over-aggregate-string-limit");
    },
  }),
  structuredPlanCase("plan-sparse-instructions", (value) => {
    const instructions = arrayValue(value.instructions);
    delete instructions[0];
  }),
  structuredPlanCase("plan-cycle", (value) => {
    value.cycle = value;
  }),
  structuredPlanCase("plan-accessor", (value) => {
    defineThrowingAccessor(value, "format");
  }),
  structuredPlanCase("plan-non-plain-object", (value) => {
    Object.setPrototypeOf(value, { inherited: true });
  }),
  structuredPlanCase("plan-prototype-sensitive-own-key", (value) => {
    Object.defineProperty(value, "__proto__", {
      value: "own-data",
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }, { expected: "accepted" }),

  structuredSnapshotCase("snapshot-missing-status", "running", (value) => {
    delete value.status;
  }),
  structuredSnapshotCase("snapshot-extra-root-field", "running", (value, _fixtures, variant) => {
    value.extra = `retained-${variant.first.toString(16)}`;
  }, { expected: "accepted" }),
  structuredSnapshotCase("snapshot-wrong-version", "running", (value, _fixtures, variant) => {
    value.version = 7 + (variant.first % 10_000);
  }),
  structuredSnapshotCase("snapshot-wrong-frames-type", "running", (value) => {
    value.frames = "not-an-array";
  }),
  structuredSnapshotCase("snapshot-unsafe-event-sequence", "running", (value) => {
    value.nextEventSequence = Number.MAX_SAFE_INTEGER + 1;
  }),
  Object.freeze({
    id: "snapshot-exact-numeric-boundaries-accepted",
    property: "exact numeric boundaries receive documented treatment",
    boundary: "validateRuntimeSnapshot",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const snapshot = structuredClone(fixtures.running.snapshot) as RuntimeSnapshot;
      snapshot.currentSessionTimeMs = Number.MAX_SAFE_INTEGER;
      snapshot.nextActionId = Number.MAX_SAFE_INTEGER;
      snapshot.nextEventSequence = Number.MAX_SAFE_INTEGER;
      const result = observeSnapshotBoundary(snapshot, fixtures.running.plan);
      assert.equal(result.kind, "accepted");
      return observation(stableObservation(result), summarizeFixture(fixtures.running));
    },
  }),
  structuredSnapshotCase("snapshot-zero-session-time", "running", (value) => {
    value.currentSessionTimeMs = 0;
  }, { expected: "accepted" }),
  structuredSnapshotCase("snapshot-negative-zero-action-id", "waitingText", (value) => {
    recordValue(value.foregroundAction).actionId = -0;
  }),
  structuredSnapshotCase("snapshot-negative-zero-request-sequence", "waitingText", (value) => {
    recordValue(value.foregroundAction).requestEventSequence = -0;
  }),
  structuredSnapshotCase("snapshot-duplicate-speaker-id", "activeSpeaker", (value) => {
    const speakers = arrayValue(value.speakers);
    assert.ok(speakers.length > 0);
    speakers.push(structuredClone(speakers[0]));
  }),
  structuredSnapshotCase("snapshot-duplicate-scope-id", "activeScope", (value) => {
    const frames = arrayValue(value.frames);
    assert.ok(frames.length > 1);
    recordValue(frames[1]).id = recordValue(frames[0]).id;
  }),
  structuredSnapshotCase("snapshot-invalid-loop-id", "activeLoop", (value) => {
    const loops = arrayValue(value.loopFrames);
    assert.ok(loops.length > 0);
    recordValue(loops[0]).loopId = 0;
  }),
  structuredSnapshotCase("snapshot-invalid-call-frame-id", "activeCall", (value) => {
    const calls = arrayValue(value.callFrames);
    assert.ok(calls.length > 0);
    recordValue(calls[0]).id = 0;
  }),
  structuredSnapshotCase("snapshot-invalid-temporary-id", "settledText", (value) => {
    const temporaries = arrayValue(value.temporaries);
    assert.ok(temporaries.length > 0);
    recordValue(temporaries[0]).id = 0;
  }),
  structuredSnapshotCase("snapshot-invalid-instruction-target", "running", (value, fixtures, variant) => {
    value.nextInstruction = fixtures.running.plan.instructions.length + 1 +
      (variant.first % 1_000);
  }),
  structuredSnapshotCase("snapshot-invalid-continuation-owner", "activeCall", (value) => {
    recordValue(value.foregroundAction).ownerCallFrameId = null;
  }),
  structuredSnapshotCase("snapshot-missing-pending-destination", "waitingText", (value) => {
    recordValue(value.foregroundAction).destinationTemporary = 2;
  }),
  structuredSnapshotCase("snapshot-settlement-result-mismatch", "settledText", (value, _fixtures, variant) => {
    recordValue(value.lastSettlement).result = `different-${variant.first.toString(16)}`;
  }),
  structuredSnapshotCase("snapshot-status-action-chronology", "waitingText", (value) => {
    value.status = "running";
  }),
  structuredSnapshotCase("snapshot-settlement-chronology", "settledText", (value, _fixtures, variant) => {
    const settlement = recordValue(value.lastSettlement);
    value.nextActionId = Math.max(1, Number(settlement.actionId) - (variant.first % 2));
  }),
  structuredSnapshotCase("snapshot-sparse-frames", "activeScope", (value) => {
    const frames = arrayValue(value.frames);
    delete frames[0];
  }),
  structuredSnapshotCase("snapshot-cycle", "running", (value) => {
    value.cycle = value;
  }),
  structuredSnapshotCase("snapshot-accessor", "running", (value) => {
    defineThrowingAccessor(value, "status");
  }),
  structuredSnapshotCase("snapshot-non-plain-object", "running", (value) => {
    Object.setPrototypeOf(value, { inherited: true });
  }),
  structuredSnapshotCase("snapshot-prototype-sensitive-own-key", "running", (value) => {
    Object.defineProperty(value, "constructor", {
      value: "own-data",
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }, { expected: "accepted" }),

  structuredCheckpointCase("checkpoint-wrong-version", (value, _fixtures, variant) => {
    value.version = 7 + (variant.first % 10_000);
  }),
  structuredCheckpointCase("checkpoint-nested-plan-version", (value, _fixtures, variant) => {
    recordValue(value.plan).version = 6 + (variant.first % 10_000);
  }),
  structuredCheckpointCase("checkpoint-nested-snapshot-version", (value, _fixtures, variant) => {
    recordValue(value.snapshot).version = 7 + (variant.first % 10_000);
  }),
  structuredCheckpointCase("checkpoint-plan-snapshot-mismatch", (value, fixtures) => {
    value.plan = structuredClone(fixtures.simplePlan);
  }),
  structuredCheckpointCase("checkpoint-extra-root-field", (value, _fixtures, variant) => {
    value.extra = `retained-${variant.first.toString(16)}`;
  }, { expected: "accepted" }),
  structuredCheckpointCase("checkpoint-non-finite-number", (value, _fixtures, variant) => {
    recordValue(value.snapshot).currentSessionTimeMs = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ][variant.first % 3];
  }),
  structuredCheckpointCase("checkpoint-cycle", (value) => {
    value.cycle = value;
  }),
  structuredCheckpointCase("checkpoint-accessor", (value) => {
    defineThrowingAccessor(value, "format");
  }),
  structuredCheckpointCase("checkpoint-non-plain-object", (value) => {
    Object.setPrototypeOf(value, { inherited: true });
  }),

  Object.freeze({
    id: "completion-missing-action-id",
    property: "malformed completion is structured and non-mutating",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const request = cloneRecord(fixtures.validTextCompletion);
      delete request.actionId;
      const result = assertCompletionRejectedWithoutMutation(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        request,
        ["invalidPayload"],
      );
      return observation(result.outcome.kind, summarizeFixture(fixtures.waitingText));
    },
  }),
  Object.freeze({
    id: "completion-extra-field",
    property: "extra completion fields receive documented treatment",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const request = cloneRecord(fixtures.validTextCompletion);
      request.extra = "ignored-or-rejected-by-contract";
      const before = structuredClone(fixtures.waitingText.snapshot);
      const result = completeAction(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        request,
      );
      assert.deepEqual(fixtures.waitingText.snapshot, before);
      assertAcceptedSnapshot(fixtures.waitingText.plan, result.snapshot);
      return observation(result.outcome.kind, summarizeFixture(fixtures.waitingText));
    },
  }),
  Object.freeze({
    id: "completion-wrong-primitive-type",
    property: "malformed completion is structured and non-mutating",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const result = assertCompletionRejectedWithoutMutation(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        "not-an-object",
        ["invalidPayload"],
      );
      return observation(result.outcome.kind, summarizeFixture(fixtures.waitingText));
    },
  }),
  ...[Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, -0].map(
    (actionId, index): PropertyCaseDefinition => Object.freeze({
      id: [
        "completion-unsafe-action-id",
        "completion-non-finite-action-id",
        "completion-negative-zero-action-id",
      ][index]!,
      property: "malformed completion is structured and non-mutating",
      boundary: "completeAction",
      repeatable: true,
      execute(fixtures: PropertyFixtureCatalog) {
        const request = { ...fixtures.validTextCompletion, actionId };
        const result = assertCompletionRejectedWithoutMutation(
          fixtures.waitingText.plan,
          fixtures.waitingText.snapshot,
          request,
          ["invalidPayload"],
        );
        return observation(result.outcome.kind, summarizeFixture(fixtures.waitingText));
      },
    }),
  ),
  Object.freeze({
    id: "completion-wrong-action-kind",
    property: "wrong completion kind is non-mutating",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const request = { ...fixtures.validTextCompletion, actionKind: "delay" };
      const result = assertCompletionRejectedWithoutMutation(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        request,
        ["wrongActionKind"],
      );
      return observation(result.outcome.kind, summarizeFixture(fixtures.waitingText));
    },
  }),
  Object.freeze({
    id: "completion-unknown-action-id",
    property: "unknown completion is non-mutating",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog, variant: PropertyCaseVariant) {
      const request = {
        ...fixtures.validTextCompletion,
        actionId: fixtures.waitingText.snapshot.nextActionId + 1 +
          (variant.first % 10_000),
      };
      const result = assertCompletionRejectedWithoutMutation(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        request,
        ["unknownAction"],
      );
      return observation(result.outcome.kind, summarizeFixture(fixtures.waitingText));
    },
  }),
  Object.freeze({
    id: "completion-stale-action-id",
    property: "stale completion is non-mutating",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const snapshot = createFreshRuntimeSnapshot(fixtures.simplePlan, { seed: 12345 });
      snapshot.nextActionId = 3;
      assertAcceptedSnapshot(fixtures.simplePlan, snapshot);
      const result = assertCompletionRejectedWithoutMutation(
        fixtures.simplePlan,
        snapshot,
        { actionId: 1, actionKind: "interaction", interactionKind: "text", payload: {} },
        ["staleAction"],
      );
      return observation(result.outcome.kind, "snapshot:stale-classification");
    },
  }),
  Object.freeze({
    id: "completion-over-limit-text",
    property: "over-limit completion is non-mutating",
    boundary: "completeAction",
    repeatable: false,
    execute(fixtures: PropertyFixtureCatalog) {
      const request = {
        ...fixtures.validTextCompletion,
        payload: {
          kind: "submittedText",
          submittedText: "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES + 1),
        },
      };
      const result = assertCompletionRejectedWithoutMutation(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        request,
        ["invalidPayload"],
      );
      return observation(result.outcome.kind, summarizeFixture(fixtures.waitingText));
    },
  }),
  Object.freeze({
    id: "completion-cycle",
    property: "hostile completion is structured and non-mutating",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const request = cloneRecord(fixtures.validTextCompletion);
      request.cycle = request;
      const result = assertCompletionRejectedWithoutMutation(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        request,
        ["invalidPayload"],
      );
      return observation(result.outcome.kind, summarizeFixture(fixtures.waitingText));
    },
  }),
  Object.freeze({
    id: "completion-accessor",
    property: "hostile completion is structured and non-mutating",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const request = cloneRecord(fixtures.validTextCompletion);
      defineThrowingAccessor(request, "actionId");
      const result = assertCompletionRejectedWithoutMutation(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        request,
        ["invalidPayload"],
      );
      return observation(result.outcome.kind, summarizeFixture(fixtures.waitingText));
    },
  }),
  Object.freeze({
    id: "completion-non-plain-object",
    property: "hostile completion is structured and non-mutating",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const request = cloneRecord(fixtures.validTextCompletion);
      Object.setPrototypeOf(request, { inherited: true });
      const result = assertCompletionRejectedWithoutMutation(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        request,
        ["invalidPayload"],
      );
      return observation(result.outcome.kind, summarizeFixture(fixtures.waitingText));
    },
  }),
  Object.freeze({
    id: "runtime-malformed-plan-structured",
    property: "runtime malformed external data is structured and non-mutating",
    boundary: "run",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const plan = structuredClone(fixtures.simplePlan) as InstructionPlan;
      (plan as unknown as { version: number }).version = 999;
      const result = observeRuntimeBoundary(plan, fixtures.fresh.snapshot);
      assert.equal(result.kind, "rejected");
      return observation(stableObservation(result), summarizeFixture(fixtures.fresh));
    },
  }),
  Object.freeze({
    id: "runtime-malformed-snapshot-structured",
    property: "runtime malformed external data is structured and non-mutating",
    boundary: "run",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const snapshot = structuredClone(fixtures.fresh.snapshot) as RuntimeSnapshot;
      (snapshot as unknown as { version: number }).version = 999;
      const result = observeRuntimeBoundary(fixtures.simplePlan, snapshot);
      assert.equal(result.kind, "rejected");
      return observation(stableObservation(result), summarizeFixture(fixtures.fresh));
    },
  }),
]);

export function propertyCases(): readonly PropertyCaseDefinition[] {
  return CASES;
}

export function repeatablePropertyCases(): readonly PropertyCaseDefinition[] {
  return CASES.filter((definition) => definition.repeatable);
}

const NOT_COMPARABLE = Symbol("property-not-comparable");

type ComparableClone = unknown | typeof NOT_COMPARABLE;

function comparableClone(value: unknown): ComparableClone {
  if (!hasComparableDescriptors(value, new WeakSet<object>())) return NOT_COMPARABLE;
  return structuredClone(value);
}

function assertComparableUnchanged(
  value: unknown,
  before: ComparableClone,
  message: string,
): void {
  if (before !== NOT_COMPARABLE) assert.deepEqual(value, before, message);
}

function hasComparableDescriptors(
  value: unknown,
  seen: WeakSet<object>,
): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (seen.has(value)) return true;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== null &&
    prototype !== Object.prototype &&
    prototype !== Array.prototype
  ) return false;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
    if ("value" in descriptor && !hasComparableDescriptors(descriptor.value, seen)) {
      return false;
    }
  }
  return true;
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}

function recordValue(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function interactionInstructionRecord(
  plan: Record<string, unknown>,
): Record<string, unknown> {
  const instruction = arrayValue(plan.instructions).find(
    (candidate) => recordValue(candidate).kind === "interaction",
  );
  assert.notEqual(instruction, undefined);
  return recordValue(instruction);
}

function defineThrowingAccessor(
  value: Record<string, unknown>,
  key: string,
): void {
  Object.defineProperty(value, key, {
    get(): never {
      throw new Error("property harness accessor must not run");
    },
    enumerable: true,
    configurable: true,
  });
}

function replaceRecord(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const key of Reflect.ownKeys(target)) {
    if (typeof key === "string") delete target[key];
  }
  for (const [key, value] of Object.entries(source)) target[key] = value;
}
