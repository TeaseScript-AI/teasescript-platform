import assert from "node:assert/strict";

import {
  EXTERNAL_DATA_DEPTH_MESSAGE,
  EXTERNAL_DATA_WORK_MESSAGE,
  MAX_EXTERNAL_RUNTIME_DATA_DEPTH,
  MAX_EXTERNAL_RUNTIME_DATA_WORK,
  MAX_INTERACTION_STRING_UTF8_BYTES,
  completeAction,
  createFreshRuntimeSnapshot,
  executeInstruction,
  observeTime,
  restoreCheckpoint,
  run,
  type InstructionPlan,
  type RuntimeSnapshot,
} from "../../src/index.js";
import {
  exactUtf8String,
  summarizeFixture,
  type PropertyFixtureCatalog,
} from "./fixtures.js";
import {
  assertAcceptedSnapshot,
  assertCheckpointRoundTrip,
  assertCompletionRejectedWithoutMutation,
  assertResumeEquivalent,
  assertSuccessfulCompletionOperation,
  assertSuccessfulRuntimeOperation,
  capturePropertyValue,
  assertPropertyValueUnchanged,
  atPropertyBoundary,
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
  readonly workUnits: number;
  readonly mutationCount: number;
  readonly repeatable: boolean;
  readonly describe: (
    fixtures: PropertyFixtureCatalog,
    variant: PropertyCaseVariant,
  ) => string;
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
  ) => void | (() => void),
  options: {
    readonly repeatable?: boolean;
    readonly fixture?: "simple" | "interaction";
    readonly expected?: "accepted" | "rejected";
    readonly detailIncludes?: string;
    readonly mutationCount?: number;
  } = {},
): PropertyCaseDefinition {
  return Object.freeze({
    id,
    property: "structured external plan boundary",
    boundary: "validateInstructionPlan",
    workUnits: 2,
    mutationCount: options.mutationCount ?? 1,
    repeatable: options.repeatable ?? true,
    describe(fixtures: PropertyFixtureCatalog, variant: PropertyCaseVariant) {
      return caseContext(id, `plan:${options.fixture ?? "simple"}`, fixtures, variant);
    },
    execute(fixtures: PropertyFixtureCatalog, variant: PropertyCaseVariant) {
      const source = options.fixture === "interaction"
        ? fixtures.waitingText.plan
        : fixtures.simplePlan;
      const value = cloneRecord(source);
      const postcondition = mutate(value, fixtures, variant);
      const before = capturePropertyValue(value);
      const first = observePlanBoundary(value);
      const second = observePlanBoundary(value);
      assert.deepEqual(second, first);
      assertPropertyValueUnchanged(value, before, "Plan boundary mutated its input.");
      assert.equal(first.kind, options.expected ?? "rejected");
      if (options.detailIncludes !== undefined) assert.match(first.detail, new RegExp(options.detailIncludes));
      postcondition?.();
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
  ) => void | (() => void),
  options: {
    readonly repeatable?: boolean;
    readonly expected?: "accepted" | "rejected";
    readonly detailIncludes?: string;
    readonly mutationCount?: number;
  } = {},
): PropertyCaseDefinition {
  return Object.freeze({
    id,
    property: "structured external snapshot boundary",
    boundary: "validateRuntimeSnapshot",
    workUnits: 2,
    mutationCount: options.mutationCount ?? 1,
    repeatable: options.repeatable ?? true,
    describe(fixtures: PropertyFixtureCatalog, variant: PropertyCaseVariant) {
      return caseContext(id, summarizeFixture(fixtures[fixtureName]), fixtures, variant);
    },
    execute(fixtures: PropertyFixtureCatalog, variant: PropertyCaseVariant) {
      const fixture = fixtures[fixtureName];
      const value = cloneRecord(fixture.snapshot);
      const postcondition = mutate(value, fixtures, variant);
      const before = capturePropertyValue(value);
      const first = observeSnapshotBoundary(value, fixture.plan);
      const second = observeSnapshotBoundary(value, fixture.plan);
      assert.deepEqual(second, first);
      assertPropertyValueUnchanged(value, before, "Snapshot boundary mutated its input.");
      assert.equal(first.kind, options.expected ?? "rejected");
      if (options.detailIncludes !== undefined) assert.match(first.detail, new RegExp(options.detailIncludes));
      postcondition?.();
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
  ) => void | (() => void),
  options: {
    readonly repeatable?: boolean;
    readonly expected?: "accepted" | "rejected";
    readonly detailIncludes?: string;
    readonly mutationCount?: number;
  } = {},
): PropertyCaseDefinition {
  return Object.freeze({
    id,
    property: "structured external checkpoint boundary",
    boundary: "restoreCheckpoint",
    workUnits: 3,
    mutationCount: options.mutationCount ?? 1,
    repeatable: options.repeatable ?? true,
    describe(fixtures: PropertyFixtureCatalog, variant: PropertyCaseVariant) {
      return caseContext(id, "checkpoint:waiting-text", fixtures, variant);
    },
    execute(fixtures: PropertyFixtureCatalog, variant: PropertyCaseVariant) {
      const value = cloneCheckpointValue(fixtures.textCheckpoint);
      const postcondition = mutate(value, fixtures, variant);
      const before = capturePropertyValue(value);
      const first = observeCheckpointBoundary(value);
      const second = observeCheckpointBoundary(value);
      assert.deepEqual(second, first);
      assertPropertyValueUnchanged(value, before, "Checkpoint boundary mutated its input.");
      assert.equal(first.kind, options.expected ?? "rejected");
      if (options.detailIncludes !== undefined) assert.match(first.detail, new RegExp(options.detailIncludes));
      postcondition?.();
      return observation(stableObservation(first), "checkpoint:waiting-text");
    },
  });
}

function acceptedPlanCanonicalCase(
  id: string,
  mutate: (
    value: Record<string, unknown>,
    fixtures: PropertyFixtureCatalog,
    variant: PropertyCaseVariant,
  ) => void,
): PropertyCaseDefinition {
  return defineCase({
    id,
    property: "accepted extra plan data is canonically ignored",
    boundary: "run",
    workUnits: 4,
    mutationCount: 1,
    repeatable: true,
    describe(fixtures, variant) {
      return caseContext(id, summarizeFixture(fixtures.fresh), fixtures, variant);
    },
    execute(fixtures, variant) {
      const modifiedPlan = cloneRecord(fixtures.fresh.plan);
      mutate(modifiedPlan, fixtures, variant);
      const modifiedBefore = capturePropertyValue(modifiedPlan);
      const baseline = assertSuccessfulRuntimeOperation(
        "run:baseline",
        fixtures.fresh.plan,
        fixtures.fresh.snapshot,
        () => run(fixtures.fresh.plan, fixtures.fresh.snapshot),
      );
      const modified = assertSuccessfulRuntimeOperation(
        "run:accepted-extra-plan",
        modifiedPlan as unknown as InstructionPlan,
        fixtures.fresh.snapshot,
        () => run(modifiedPlan as unknown as InstructionPlan, fixtures.fresh.snapshot),
      );
      assert.deepEqual(modified, baseline);
      assertPropertyValueUnchanged(
        modifiedPlan,
        modifiedBefore,
        "Accepted plan boundary mutated the caller-owned plan.",
      );
      return observation("accepted:canonical-equivalent", summarizeFixture(fixtures.fresh));
    },
  });
}

function acceptedSnapshotCanonicalCase(
  id: string,
  mutate: (
    value: Record<string, unknown>,
    fixtures: PropertyFixtureCatalog,
    variant: PropertyCaseVariant,
  ) => void,
): PropertyCaseDefinition {
  return defineCase({
    id,
    property: "accepted extra snapshot data is canonically ignored",
    boundary: "run",
    workUnits: 4,
    mutationCount: 1,
    repeatable: true,
    describe(fixtures, variant) {
      return caseContext(id, summarizeFixture(fixtures.running), fixtures, variant);
    },
    execute(fixtures, variant) {
      const modifiedSnapshot = cloneRecord(fixtures.running.snapshot);
      mutate(modifiedSnapshot, fixtures, variant);
      const modifiedBefore = capturePropertyValue(modifiedSnapshot);
      const baseline = assertSuccessfulRuntimeOperation(
        "run:baseline",
        fixtures.running.plan,
        fixtures.running.snapshot,
        () => run(fixtures.running.plan, fixtures.running.snapshot),
      );
      const modified = assertSuccessfulRuntimeOperation(
        "run:accepted-extra-snapshot",
        fixtures.running.plan,
        modifiedSnapshot as unknown as RuntimeSnapshot,
        () => run(
          fixtures.running.plan,
          modifiedSnapshot as unknown as RuntimeSnapshot,
        ),
      );
      assert.deepEqual(modified, baseline);
      assertPropertyValueUnchanged(
        modifiedSnapshot,
        modifiedBefore,
        "Accepted snapshot boundary mutated the caller-owned snapshot.",
      );
      return observation("accepted:canonical-equivalent", summarizeFixture(fixtures.running));
    },
  });
}

function acceptedCheckpointCanonicalCase(
  id: string,
  mutate: (
    value: Record<string, unknown>,
    fixtures: PropertyFixtureCatalog,
    variant: PropertyCaseVariant,
  ) => void,
): PropertyCaseDefinition {
  return defineCase({
    id,
    property: "accepted extra checkpoint data is canonically ignored",
    boundary: "restoreCheckpoint",
    workUnits: 3,
    mutationCount: 1,
    repeatable: true,
    describe(fixtures, variant) {
      return caseContext(id, "checkpoint:waiting-text", fixtures, variant);
    },
    execute(fixtures, variant) {
      const modified = cloneCheckpointValue(fixtures.textCheckpoint);
      mutate(modified, fixtures, variant);
      const baselineBefore = capturePropertyValue(fixtures.textCheckpoint);
      const modifiedBefore = capturePropertyValue(modified);
      const baseline = atPropertyBoundary(
        "restoreCheckpoint:baseline",
        () => restoreCheckpoint(fixtures.textCheckpoint),
      );
      const restored = atPropertyBoundary(
        "restoreCheckpoint:accepted-extra",
        () => restoreCheckpoint(modified),
      );
      assert.deepEqual(restored, baseline);
      assertPropertyValueUnchanged(
        fixtures.textCheckpoint,
        baselineBefore,
        "Baseline checkpoint restore mutated its input.",
      );
      assertPropertyValueUnchanged(
        modified,
        modifiedBefore,
        "Accepted checkpoint restore mutated its input.",
      );
      return observation("accepted:canonical-equivalent", "checkpoint:waiting-text");
    },
  });
}

function defineCase(
  definition: Omit<PropertyCaseDefinition, "describe"> & {
    readonly describe?: PropertyCaseDefinition["describe"];
  },
): PropertyCaseDefinition {
  return Object.freeze({
    ...definition,
    describe: definition.describe ?? ((fixtures: PropertyFixtureCatalog, variant: PropertyCaseVariant) =>
      caseContext(
        definition.id,
        defaultFixtureContext(definition.id, fixtures),
        fixtures,
        variant,
      )),
  });
}

function defaultFixtureContext(
  caseId: string,
  fixtures: PropertyFixtureCatalog,
): string {
  if (caseId === "duplicate-completion-preserves-state") {
    return summarizeFixture(fixtures.settledText);
  }
  if (caseId.startsWith("delay-") || caseId === "action-id-capacity-operation") {
    return summarizeFixture(fixtures.waitingDelay);
  }
  if (
    caseId.startsWith("interaction-") ||
    caseId.startsWith("invalid-completion") ||
    caseId.startsWith("completion-") ||
    caseId.startsWith("checkpoint-")
  ) {
    return summarizeFixture(fixtures.waitingText);
  }
  if (caseId === "runtime-execute-instruction-closes-over-validator") {
    return summarizeFixture(fixtures.running);
  }
  if (caseId.startsWith("runtime-")) {
    return summarizeFixture(fixtures.fresh);
  }
  return `case:${caseId}`;
}

function caseContext(
  caseId: string,
  fixture: string,
  _fixtures: PropertyFixtureCatalog,
  variant: PropertyCaseVariant,
): string {
  return JSON.stringify({ caseId, fixture, variant });
}

const CASES: readonly PropertyCaseDefinition[] = Object.freeze([
  defineCase({
    id: "runtime-run-closes-over-validator",
    workUnits: 2,
    mutationCount: 0,
    property: "successful runtime operation closes over validator",
    boundary: "run",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const operation = assertSuccessfulRuntimeOperation(
        "run",
        fixtures.fresh.plan,
        fixtures.fresh.snapshot,
        () => run(fixtures.fresh.plan, fixtures.fresh.snapshot),
      );
      return observation(operation.snapshot.status, summarizeFixture(fixtures.fresh));
    },
  }),
  defineCase({
    id: "runtime-execute-instruction-closes-over-validator",
    workUnits: 2,
    mutationCount: 0,
    property: "successful runtime operation closes over validator",
    boundary: "executeInstruction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const operation = assertSuccessfulRuntimeOperation(
        "executeInstruction",
        fixtures.running.plan,
        fixtures.running.snapshot,
        () => executeInstruction(fixtures.running.plan, fixtures.running.snapshot),
      );
      return observation(operation.snapshot.status, summarizeFixture(fixtures.running));
    },
  }),
  defineCase({
    id: "delay-observation-closes-over-validator",
    workUnits: 2,
    mutationCount: 0,
    property: "successful runtime operation closes over validator",
    boundary: "observeTime",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const operation = assertSuccessfulRuntimeOperation(
        "observeTime",
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
  defineCase({
    id: "delay-completion-request-closes-over-validator",
    workUnits: 2,
    mutationCount: 0,
    property: "successful runtime operation closes over validator",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const operation = assertSuccessfulCompletionOperation(
        fixtures.waitingDelay.plan,
        fixtures.waitingDelay.snapshot,
        fixtures.validDelayCompletion,
      );
      assert.equal(operation.outcome.kind, "completed");
      return observation("completed", summarizeFixture(fixtures.waitingDelay));
    },
  }),
  defineCase({
    id: "interaction-completion-closes-over-validator",
    workUnits: 2,
    mutationCount: 0,
    property: "successful runtime operation closes over validator",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const operation = assertSuccessfulCompletionOperation(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        fixtures.validTextCompletion,
      );
      assert.equal(operation.outcome.kind, "completed");
      return observation("completed", summarizeFixture(fixtures.waitingText));
    },
  }),
  defineCase({
    id: "invalid-completion-preserves-state",
    workUnits: 2,
    mutationCount: 0,
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
  defineCase({
    id: "duplicate-completion-preserves-state",
    workUnits: 2,
    mutationCount: 0,
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
  defineCase({
    id: "checkpoint-json-roundtrip-equivalent",
    workUnits: 4,
    mutationCount: 0,
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
  defineCase({
    id: "delay-restore-resume-equivalent",
    workUnits: 12,
    mutationCount: 0,
    property: "restored execution equals uninterrupted execution",
    boundary: "checkpoint/observeTime/run",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      assertResumeEquivalent(
        fixtures.waitingDelay.plan,
        fixtures.waitingDelay.snapshot,
        (plan, snapshot) => observeTime(plan, snapshot, 1_000),
        "observeTime",
      );
      return observation("equivalent", summarizeFixture(fixtures.waitingDelay));
    },
  }),
  defineCase({
    id: "interaction-restore-resume-equivalent",
    workUnits: 12,
    mutationCount: 0,
    property: "restored execution equals uninterrupted execution",
    boundary: "checkpoint/completeAction/run",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      assertResumeEquivalent(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        (plan, snapshot) => completeAction(plan, snapshot, fixtures.validTextCompletion),
        "completeAction",
      );
      return observation("equivalent", summarizeFixture(fixtures.waitingText));
    },
  }),

  structuredPlanCase("plan-missing-format", (value) => {
    delete value.format;
  }),
  acceptedPlanCanonicalCase("plan-extra-root-field", (value, _fixtures, variant) => {
    value.extra = `retained-${variant.first.toString(16)}`;
  }),
  structuredPlanCase("plan-wrong-version", (value, _fixtures, variant) => {
    value.version = 7 + (variant.first % 10_000);
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
  defineCase({
    id: "plan-exact-string-limit-accepted",
    workUnits: 2,
    mutationCount: 1,
    property: "exact technical string boundary is accepted",
    boundary: "validateInstructionPlan",
    repeatable: false,
    execute(fixtures: PropertyFixtureCatalog) {
      const result = assertStablePlanBoundary(fixtures.exactLimitButtonPlan, "accepted");
      return observation(stableObservation(result), "plan:exact-button-string-limit:multibyte");
    },
  }),
  defineCase({
    id: "plan-over-string-limit-structured",
    workUnits: 2,
    mutationCount: 1,
    property: "over-limit string is rejected structurally",
    boundary: "validateInstructionPlan",
    repeatable: false,
    execute(fixtures: PropertyFixtureCatalog) {
      const result = assertStablePlanBoundary(fixtures.overLimitButtonPlan, "rejected");
      return observation(stableObservation(result), "plan:over-button-string-limit:multibyte");
    },
  }),
  defineCase({
    id: "plan-exact-option-limit-accepted",
    workUnits: 2,
    mutationCount: 1,
    property: "exact technical collection boundary is accepted",
    boundary: "validateInstructionPlan",
    repeatable: false,
    execute(fixtures: PropertyFixtureCatalog) {
      const result = assertStablePlanBoundary(fixtures.exactLimitChoicePlan, "accepted");
      return observation(stableObservation(result), "plan:exact-choice-option-limit");
    },
  }),
  defineCase({
    id: "plan-over-option-limit-structured",
    workUnits: 2,
    mutationCount: 1,
    property: "over-limit collection is rejected structurally",
    boundary: "validateInstructionPlan",
    repeatable: false,
    execute(fixtures: PropertyFixtureCatalog) {
      const result = assertStablePlanBoundary(fixtures.overLimitChoicePlan, "rejected");
      return observation(stableObservation(result), "plan:over-choice-option-limit");
    },
  }),
  defineCase({
    id: "plan-over-aggregate-string-limit-structured",
    workUnits: 2,
    mutationCount: 2,
    property: "aggregate technical string limit is enforced",
    boundary: "validateInstructionPlan",
    repeatable: false,
    execute(fixtures: PropertyFixtureCatalog) {
      const result = assertStablePlanBoundary(fixtures.overAggregateStringPlan, "rejected");
      return observation(stableObservation(result), "plan:over-aggregate-string-limit:multibyte");
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
    const calls = defineThrowingAccessor(value, "format");
    return () => assert.equal(calls(), 0, "Plan validation invoked an untrusted getter.");
  }),
  structuredPlanCase("plan-non-plain-object", (value) => {
    Object.setPrototypeOf(value, { inherited: true });
  }),
  acceptedPlanCanonicalCase("plan-prototype-sensitive-own-key", (value) => {
    Object.defineProperty(value, "__proto__", {
      value: "own-data",
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }),
  structuredPlanCase("plan-exact-depth-boundary-accepted", (value) => {
    value.padding = deepArray(MAX_EXTERNAL_RUNTIME_DATA_DEPTH - 1);
  }, { expected: "accepted", repeatable: false }),
  structuredPlanCase("plan-over-depth-boundary-structured", (value) => {
    value.padding = deepArray(MAX_EXTERNAL_RUNTIME_DATA_DEPTH);
  }, { expected: "rejected", repeatable: false, detailIncludes: EXTERNAL_DATA_DEPTH_MESSAGE }),
  structuredPlanCase("plan-exact-work-boundary-accepted", (value) => {
    value.padding = sparseArray(MAX_EXTERNAL_RUNTIME_DATA_WORK);
  }, { expected: "accepted", repeatable: false }),
  structuredPlanCase("plan-over-work-boundary-structured", (value) => {
    value.padding = sparseArray(MAX_EXTERNAL_RUNTIME_DATA_WORK + 1);
  }, { expected: "rejected", repeatable: false, detailIncludes: EXTERNAL_DATA_WORK_MESSAGE }),

  structuredSnapshotCase("snapshot-missing-status", "running", (value) => {
    delete value.status;
  }),
  acceptedSnapshotCanonicalCase("snapshot-extra-root-field", (value, _fixtures, variant) => {
    value.extra = `retained-${variant.first.toString(16)}`;
  }),
  structuredSnapshotCase("snapshot-wrong-version", "running", (value, _fixtures, variant) => {
    value.version = 7 + (variant.first % 10_000);
  }),
  structuredSnapshotCase("snapshot-wrong-frames-type", "running", (value) => {
    value.frames = "not-an-array";
  }),
  structuredSnapshotCase("snapshot-unsafe-event-sequence", "running", (value) => {
    value.nextEventSequence = Number.MAX_SAFE_INTEGER + 1;
  }),
  structuredSnapshotCase(
    "snapshot-exact-numeric-boundaries-accepted",
    "running",
    (value) => {
      value.currentSessionTimeMs = Number.MAX_SAFE_INTEGER;
      value.nextActionId = Number.MAX_SAFE_INTEGER;
      value.nextEventSequence = Number.MAX_SAFE_INTEGER;
    },
    { expected: "accepted", mutationCount: 3 },
  ),
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
    const action = recordValue(value.foregroundAction);
    action.destinationTemporary = Number(action.destinationTemporary) + 1;
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
    const calls = defineThrowingAccessor(value, "status");
    return () => assert.equal(calls(), 0, "Snapshot validation invoked an untrusted getter.");
  }),
  structuredSnapshotCase("snapshot-non-plain-object", "running", (value) => {
    Object.setPrototypeOf(value, { inherited: true });
  }),
  acceptedSnapshotCanonicalCase("snapshot-prototype-sensitive-own-key", (value) => {
    Object.defineProperty(value, "constructor", {
      value: "own-data",
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }),
  structuredSnapshotCase("snapshot-exact-depth-boundary-accepted", "running", (value) => {
    value.padding = deepArray(MAX_EXTERNAL_RUNTIME_DATA_DEPTH - 1);
  }, { expected: "accepted", repeatable: false }),
  structuredSnapshotCase("snapshot-over-depth-boundary-structured", "running", (value) => {
    value.padding = deepArray(MAX_EXTERNAL_RUNTIME_DATA_DEPTH);
  }, { expected: "rejected", repeatable: false, detailIncludes: EXTERNAL_DATA_DEPTH_MESSAGE }),
  structuredSnapshotCase("snapshot-exact-work-boundary-accepted", "running", (value) => {
    value.padding = sparseArray(MAX_EXTERNAL_RUNTIME_DATA_WORK);
  }, { expected: "accepted", repeatable: false }),
  structuredSnapshotCase("snapshot-over-work-boundary-structured", "running", (value) => {
    value.padding = sparseArray(MAX_EXTERNAL_RUNTIME_DATA_WORK + 1);
  }, { expected: "rejected", repeatable: false, detailIncludes: EXTERNAL_DATA_WORK_MESSAGE }),

  structuredCheckpointCase("checkpoint-wrong-version", (value, _fixtures, variant) => {
    value.version = 7 + (variant.first % 10_000);
  }),
  structuredCheckpointCase("checkpoint-nested-plan-version", (value, _fixtures, variant) => {
    recordValue(value.plan).version = 7 + (variant.first % 10_000);
  }),
  structuredCheckpointCase("checkpoint-nested-snapshot-version", (value, _fixtures, variant) => {
    recordValue(value.snapshot).version = 7 + (variant.first % 10_000);
  }),
  structuredCheckpointCase("checkpoint-plan-snapshot-mismatch", (value, fixtures) => {
    value.plan = structuredClone(fixtures.simplePlan);
  }),
  acceptedCheckpointCanonicalCase("checkpoint-extra-root-field", (value, _fixtures, variant) => {
    value.extra = `retained-${variant.first.toString(16)}`;
  }),
  acceptedCheckpointCanonicalCase("checkpoint-prototype-sensitive-own-key", (value) => {
    Object.defineProperty(value, "__proto__", {
      value: "own-data",
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }),
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
    const calls = defineThrowingAccessor(value, "format");
    return () => assert.equal(calls(), 0, "Checkpoint restore invoked an untrusted getter.");
  }),
  structuredCheckpointCase("checkpoint-non-plain-object", (value) => {
    Object.setPrototypeOf(value, { inherited: true });
  }),
  structuredCheckpointCase("checkpoint-exact-depth-boundary-accepted", (value) => {
    value.padding = deepArray(MAX_EXTERNAL_RUNTIME_DATA_DEPTH - 1);
  }, { expected: "accepted", repeatable: false }),
  structuredCheckpointCase("checkpoint-over-depth-boundary-structured", (value) => {
    value.padding = deepArray(MAX_EXTERNAL_RUNTIME_DATA_DEPTH);
  }, { expected: "rejected", repeatable: false, detailIncludes: EXTERNAL_DATA_DEPTH_MESSAGE }),
  structuredCheckpointCase("checkpoint-exact-work-boundary-accepted", (value) => {
    value.padding = sparseArray(MAX_EXTERNAL_RUNTIME_DATA_WORK);
  }, { expected: "accepted", repeatable: false }),
  structuredCheckpointCase("checkpoint-over-work-boundary-structured", (value) => {
    value.padding = sparseArray(MAX_EXTERNAL_RUNTIME_DATA_WORK + 1);
  }, { expected: "rejected", repeatable: false, detailIncludes: EXTERNAL_DATA_WORK_MESSAGE }),

  defineCase({
    id: "completion-missing-action-id",
    workUnits: 2,
    mutationCount: 1,
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
  defineCase({
    id: "completion-extra-field",
    workUnits: 4,
    mutationCount: 1,
    property: "extra completion fields receive documented treatment",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const request = cloneRecord(fixtures.validTextCompletion);
      request.extra = "ignored-by-version-1-contract";
      const requestBefore = capturePropertyValue(request);
      const expected = assertSuccessfulCompletionOperation(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        fixtures.validTextCompletion,
      );
      const actual = assertSuccessfulCompletionOperation(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        request,
      );
      assert.equal(actual.outcome.kind, "completed");
      assertPropertyValueUnchanged(
        request,
        requestBefore,
        "Accepted completion mutated the caller-owned request.",
      );
      assert.deepEqual(
        actual,
        expected,
        "An unknown completion field changed the canonical completion result.",
      );
      return observation(
        "accepted:completed-equivalent",
        summarizeFixture(fixtures.waitingText),
      );
    },
  }),
  defineCase({
    id: "completion-wrong-primitive-type",
    workUnits: 2,
    mutationCount: 1,
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
    (actionId, index): PropertyCaseDefinition => defineCase({
      id: [
        "completion-unsafe-action-id",
        "completion-non-finite-action-id",
        "completion-negative-zero-action-id",
      ][index]!,
      property: "malformed completion is structured and non-mutating",
      boundary: "completeAction",
      workUnits: 2,
      mutationCount: 1,
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
  defineCase({
    id: "completion-wrong-action-kind",
    workUnits: 2,
    mutationCount: 1,
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
  defineCase({
    id: "completion-unknown-action-id",
    workUnits: 2,
    mutationCount: 1,
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
  defineCase({
    id: "completion-stale-action-id",
    workUnits: 4,
    mutationCount: 1,
    property: "stale completion is non-mutating",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const snapshot = atPropertyBoundary(
        "createFreshRuntimeSnapshot",
        () => createFreshRuntimeSnapshot(fixtures.simplePlan, { seed: 12345 }),
      );
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
  defineCase({
    id: "completion-exact-multibyte-text-limit",
    workUnits: 2,
    mutationCount: 1,
    property: "exact multibyte completion byte limit is accepted",
    boundary: "completeAction",
    repeatable: false,
    execute(fixtures: PropertyFixtureCatalog) {
      const request = {
        ...fixtures.validTextCompletion,
        payload: {
          kind: "submittedText",
          submittedText: exactUtf8String(MAX_INTERACTION_STRING_UTF8_BYTES),
        },
      };
      const result = assertSuccessfulCompletionOperation(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        request,
      );
      assert.equal(result.outcome.kind, "completed");
      return observation(result.outcome.kind, summarizeFixture(fixtures.waitingText));
    },
  }),
  defineCase({
    id: "completion-over-limit-text",
    workUnits: 2,
    mutationCount: 1,
    property: "over-limit completion is non-mutating",
    boundary: "completeAction",
    repeatable: false,
    execute(fixtures: PropertyFixtureCatalog) {
      const request = {
        ...fixtures.validTextCompletion,
        payload: {
          kind: "submittedText",
          submittedText: exactUtf8String(MAX_INTERACTION_STRING_UTF8_BYTES + 1),
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
  defineCase({
    id: "completion-cycle",
    workUnits: 2,
    mutationCount: 1,
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
  defineCase({
    id: "completion-accessor",
    workUnits: 2,
    mutationCount: 1,
    property: "hostile completion is structured and non-mutating",
    boundary: "completeAction",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const request = cloneRecord(fixtures.validTextCompletion);
      const calls = defineThrowingAccessor(request, "actionId");
      const result = assertCompletionRejectedWithoutMutation(
        fixtures.waitingText.plan,
        fixtures.waitingText.snapshot,
        request,
        ["invalidPayload"],
      );
      assert.equal(calls(), 0, "Completion handling invoked an untrusted getter.");
      return observation(result.outcome.kind, summarizeFixture(fixtures.waitingText));
    },
  }),
  defineCase({
    id: "completion-non-plain-object",
    workUnits: 2,
    mutationCount: 1,
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
  defineCase({
    id: "runtime-malformed-plan-structured",
    workUnits: 1,
    mutationCount: 1,
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
  defineCase({
    id: "runtime-malformed-snapshot-structured",
    workUnits: 1,
    mutationCount: 1,
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
  defineCase({
    id: "runtime-hostile-plan-accessor-structured",
    workUnits: 1,
    mutationCount: 1,
    property: "hostile runtime plan reaches the structured run boundary",
    boundary: "run",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const plan = cloneRecord(fixtures.simplePlan);
      const calls = defineThrowingAccessor(plan, "format");
      const result = observeRuntimeBoundary(plan, fixtures.fresh.snapshot);
      assert.equal(result.kind, "rejected");
      assert.equal(calls(), 0, "Runtime plan capture invoked an untrusted getter.");
      return observation(stableObservation(result), "runtime-plan:accessor");
    },
  }),
  defineCase({
    id: "runtime-hostile-plan-non-plain-structured",
    workUnits: 1,
    mutationCount: 1,
    property: "hostile runtime plan reaches the structured run boundary",
    boundary: "run",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const plan = cloneRecord(fixtures.simplePlan);
      Object.setPrototypeOf(plan, { inherited: true });
      const result = observeRuntimeBoundary(plan, fixtures.fresh.snapshot);
      assert.equal(result.kind, "rejected");
      return observation(stableObservation(result), "runtime-plan:non-plain");
    },
  }),
  defineCase({
    id: "runtime-hostile-plan-cycle-structured",
    workUnits: 1,
    mutationCount: 1,
    property: "cyclic runtime plan reaches the structured run boundary",
    boundary: "run",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const plan = cloneRecord(fixtures.simplePlan);
      plan.cycle = plan;
      const result = observeRuntimeBoundary(plan, fixtures.fresh.snapshot);
      assert.equal(result.kind, "rejected");
      return observation(stableObservation(result), "runtime-plan:cycle");
    },
  }),
  defineCase({
    id: "runtime-hostile-snapshot-accessor-structured",
    workUnits: 1,
    mutationCount: 1,
    property: "hostile runtime snapshot reaches the structured run boundary",
    boundary: "run",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const snapshot = cloneRecord(fixtures.fresh.snapshot);
      const calls = defineThrowingAccessor(snapshot, "status");
      const result = observeRuntimeBoundary(fixtures.simplePlan, snapshot);
      assert.equal(result.kind, "rejected");
      assert.equal(calls(), 0, "Runtime snapshot capture invoked an untrusted getter.");
      return observation(stableObservation(result), "runtime-snapshot:accessor");
    },
  }),
  defineCase({
    id: "runtime-hostile-snapshot-non-plain-structured",
    workUnits: 1,
    mutationCount: 1,
    property: "hostile runtime snapshot reaches the structured run boundary",
    boundary: "run",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const snapshot = cloneRecord(fixtures.fresh.snapshot);
      Object.setPrototypeOf(snapshot, { inherited: true });
      const result = observeRuntimeBoundary(fixtures.simplePlan, snapshot);
      assert.equal(result.kind, "rejected");
      return observation(stableObservation(result), "runtime-snapshot:non-plain");
    },
  }),
  defineCase({
    id: "runtime-hostile-snapshot-cycle-structured",
    workUnits: 1,
    mutationCount: 1,
    property: "cyclic runtime snapshot reaches the structured run boundary",
    boundary: "run",
    repeatable: true,
    execute(fixtures: PropertyFixtureCatalog) {
      const snapshot = cloneRecord(fixtures.fresh.snapshot);
      snapshot.cycle = snapshot;
      const result = observeRuntimeBoundary(fixtures.simplePlan, snapshot);
      assert.equal(result.kind, "rejected");
      return observation(stableObservation(result), "runtime-snapshot:cycle");
    },
  }),
  defineCase({
    id: "interaction-event-capacity-exact-operation",
    workUnits: 5,
    mutationCount: 1,
    property: "near-limit interaction event capacity closes over execution",
    boundary: "run/completeAction",
    repeatable: false,
    execute(fixtures: PropertyFixtureCatalog) {
      const snapshot = atPropertyBoundary(
        "createFreshRuntimeSnapshot",
        () => createFreshRuntimeSnapshot(fixtures.waitingText.plan, { seed: 12345 }),
      );
      snapshot.nextEventSequence = Number.MAX_SAFE_INTEGER - 3;
      const pending = assertSuccessfulRuntimeOperation(
        "run", fixtures.waitingText.plan, snapshot,
        () => run(fixtures.waitingText.plan, snapshot),
      );
      assert.equal(pending.snapshot.status, "waiting");
      const action = pending.snapshot.foregroundAction;
      assert.ok(action !== null && action.kind === "interaction");
      const completionRequest = {
        actionId: action.actionId,
        actionKind: "interaction",
        interactionKind: "text",
        payload: { kind: "submittedText", submittedText: "ok" },
      };
      const completed = assertSuccessfulCompletionOperation(
        fixtures.waitingText.plan,
        pending.snapshot,
        completionRequest,
      );
      assert.equal(completed.outcome.kind, "completed");
      assert.equal(completed.snapshot.nextEventSequence, Number.MAX_SAFE_INTEGER);
      return observation("completed-at-event-limit", "capacity:interaction-exact");
    },
  }),
  defineCase({
    id: "interaction-event-capacity-exhausted-operation",
    workUnits: 3,
    mutationCount: 1,
    property: "insufficient interaction event capacity fails without partial state",
    boundary: "run",
    repeatable: false,
    execute(fixtures: PropertyFixtureCatalog) {
      const snapshot = atPropertyBoundary(
        "createFreshRuntimeSnapshot",
        () => createFreshRuntimeSnapshot(fixtures.waitingText.plan, { seed: 12345 }),
      );
      snapshot.nextEventSequence = Number.MAX_SAFE_INTEGER - 2;
      const result = assertSuccessfulRuntimeOperation(
        "run", fixtures.waitingText.plan, snapshot,
        () => run(fixtures.waitingText.plan, snapshot),
      );
      assert.equal(result.snapshot.status, "failed");
      assert.equal(result.snapshot.foregroundAction, null);
      assert.equal(result.snapshot.nextActionId, snapshot.nextActionId);
      return observation("failed-atomically", "capacity:interaction-exhausted");
    },
  }),
  defineCase({
    id: "delay-event-capacity-exact-operation",
    workUnits: 5,
    mutationCount: 1,
    property: "near-limit delay event capacity closes over execution",
    boundary: "run/observeTime",
    repeatable: false,
    execute(fixtures: PropertyFixtureCatalog) {
      const snapshot = atPropertyBoundary(
        "createFreshRuntimeSnapshot",
        () => createFreshRuntimeSnapshot(fixtures.waitingDelay.plan, { seed: 12345 }),
      );
      snapshot.nextEventSequence = Number.MAX_SAFE_INTEGER - 2;
      const pending = assertSuccessfulRuntimeOperation(
        "run", fixtures.waitingDelay.plan, snapshot,
        () => run(fixtures.waitingDelay.plan, snapshot),
      );
      const completed = assertSuccessfulRuntimeOperation(
        "observeTime", fixtures.waitingDelay.plan, pending.snapshot,
        () => observeTime(fixtures.waitingDelay.plan, pending.snapshot, 1_000),
      );
      assert.equal(completed.outcome.kind, "observed");
      assert.equal(completed.snapshot.nextEventSequence, Number.MAX_SAFE_INTEGER);
      return observation("observed-at-event-limit", "capacity:delay-exact");
    },
  }),
  defineCase({
    id: "action-id-capacity-operation",
    workUnits: 3,
    mutationCount: 1,
    property: "near-limit action IDs receive documented execution treatment",
    boundary: "run",
    repeatable: false,
    execute(fixtures: PropertyFixtureCatalog) {
      const snapshot = atPropertyBoundary(
        "createFreshRuntimeSnapshot",
        () => createFreshRuntimeSnapshot(fixtures.waitingDelay.plan, { seed: 12345 }),
      );
      snapshot.nextActionId = Number.MAX_SAFE_INTEGER - 1;
      const result = assertSuccessfulRuntimeOperation(
        "run", fixtures.waitingDelay.plan, snapshot,
        () => run(fixtures.waitingDelay.plan, snapshot),
      );
      assert.equal(result.snapshot.status, "waiting");
      assert.equal(result.snapshot.foregroundAction?.actionId, Number.MAX_SAFE_INTEGER - 1);
      assert.equal(result.snapshot.nextActionId, Number.MAX_SAFE_INTEGER);
      return observation("pending-at-action-limit", "capacity:action-id-exact");
    },
  }),
]);

export function propertyCases(): readonly PropertyCaseDefinition[] {
  return CASES;
}

export function repeatablePropertyCases(): readonly PropertyCaseDefinition[] {
  return CASES.filter((definition) => definition.repeatable);
}

function assertStablePlanBoundary(
  value: unknown,
  expected: "accepted" | "rejected",
) {
  const before = capturePropertyValue(value);
  const first = observePlanBoundary(value);
  const second = observePlanBoundary(value);
  assert.deepEqual(second, first);
  assertPropertyValueUnchanged(value, before, "Plan boundary mutated its input.");
  assert.equal(first.kind, expected);
  return first;
}

function deepArray(depth: number): unknown {
  let value: unknown = 0;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

function sparseArray(length: number): unknown[] {
  const value: unknown[] = [];
  value.length = length;
  return value;
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
): () => number {
  let calls = 0;
  Object.defineProperty(value, key, {
    get(): never {
      calls += 1;
      throw new Error("property harness accessor must not run");
    },
    enumerable: true,
    configurable: true,
  });
  return () => calls;
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
