import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type {
  BinaryExpressionPlan,
  ExpressionPlan,
  Instruction,
  InstructionPlan,
  InteractionInstruction,
  InteractionUiPayload,
  PlanSourceLocation,
} from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  CheckpointError,
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { executeInstruction, run, RuntimeDataError } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import type { RuntimeDelayActionSettlementSnapshot } from "../src/runtime/actions/model.js";
import {
  getSerializableProperty,
  type SerializableRuntimeObject,
} from "../src/runtime/serializable-values.js";
import {
  createFreshRuntimeSnapshot,
  type RuntimeSnapshot,
  validateRuntimeSnapshot,
} from "../src/runtime/state.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

function interactionPlan(
  interactionKind: InteractionInstruction["interactionKind"],
  ui: InteractionUiPayload,
  options: { speaker?: string | null } = {},
): InstructionPlan {
  const source =
    options.speaker === undefined
      ? "wait 1\nexit"
      : `speaker ${options.speaker} {}\nspeaker ${options.speaker}\nwait 1\nexit`;
  const compiled = compileSource(source);
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  const base = compiled.plan!;
  const waitIndex = base.instructions.findIndex((instruction) => instruction.kind === "wait");
  assert.notEqual(waitIndex, -1);
  const expectedResult =
    interactionKind === "button"
      ? "none"
      : interactionKind === "number" || (ui.kind === "choice" && ui.labelType === "number")
        ? "number"
        : "string";
  const interaction: InteractionInstruction = {
    kind: "interaction",
    interactionKind,
    target: "standardChat",
    speaker: options.speaker ?? null,
    destinationTemporary: interactionKind === "button" ? null : 1,
    expectedResult,
    ui,
    span: base.instructions[waitIndex]!.span,
  };
  const instructions = base.instructions.map((instruction, index) =>
    index === waitIndex ? interaction : instruction,
  );
  const plan = { ...base, temporaryCount: interactionKind === "button" ? 0 : 1, instructions };
  assert.equal(
    validateInstructionPlan(plan).valid,
    true,
    JSON.stringify(validateInstructionPlan(plan).errors),
  );
  return plan;
}

const defaults = {
  button: { kind: "localizedDefault", key: "continue" },
  text: { kind: "localizedDefault", key: "answer" },
  number: { kind: "localizedDefault", key: "number" },
  choice: { kind: "localizedDefault", key: "chooseOption" },
} as const;

function waiting(plan: InstructionPlan) {
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(result.snapshot.status, "waiting");
  assert.equal(result.snapshot.foregroundAction?.kind, "interaction");
  return result;
}

test("result interaction destinations are produced only by the interaction and absent while pending", () => {
  const base = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const span = base.instructions[0]!.span;
  const occupiedPlan: InstructionPlan = {
    ...base,
    rootEndInstruction: 4,
    instructions: [
      {
        kind: "storeTemporary",
        temporaryId: 1,
        value: { kind: "literal", value: "old", span },
        expectBoolean: false,
        span,
      },
      base.instructions[0]!,
      { kind: "clearTemporary", temporaryId: 1, span },
      base.instructions[1]!,
    ],
  };
  assert.deepEqual(
    validateInstructionPlan(occupiedPlan).errors.map((error) => [error.code, error.path]),
    [["TSC002", "$.instructions[1].destinationTemporary"]],
  );

  for (const [owner, source] of [
    ["root", "let answer = askText\nexit"],
    ["function", "function prompt { let answer = askText\nreturn }\nprompt()\nexit"],
    ["loop", "repeat 1 { let answer = askText }\nexit"],
  ] as const) {
    const compiled = compileSource(source);
    assert.deepEqual(compiled.diagnostics, [], owner);
    const plan = compiled.plan!;
    let beforeInteraction = createImmediatePacingRuntimeSnapshot(plan);
    while (plan.instructions[beforeInteraction.nextInstruction]?.kind !== "interaction") {
      beforeInteraction = executeInstruction(plan, beforeInteraction).snapshot;
    }
    const interaction = plan.instructions[beforeInteraction.nextInstruction];
    assert.ok(interaction?.kind === "interaction" && interaction.destinationTemporary !== null);

    // An occupied destination is rejected before the interaction creates its pending action.
    const occupied = structuredClone(beforeInteraction);
    occupied.temporaries.push({ id: interaction.destinationTemporary, value: "old" });
    const occupiedBefore = structuredClone(occupied);
    assert.equal(validateRuntimeSnapshot(occupied, plan).valid, false, owner);
    assert.throws(() => run(plan, occupied), owner);
    assert.deepEqual(occupied, occupiedBefore, owner);

    const pending = run(plan, beforeInteraction);
    assert.equal(pending.snapshot.status, "waiting", owner);
    const action = pending.snapshot.foregroundAction;
    assert.ok(action?.kind === "interaction" && action.destinationTemporary !== null, owner);
    const destination = action.destinationTemporary;
    assert.equal(
      pending.snapshot.temporaries.some((temporary) => temporary.id === destination),
      false,
      owner,
    );
    const hostile = structuredClone(pending.snapshot);
    hostile.temporaries.push({ id: destination, value: "old" });
    assert.equal(validateRuntimeSnapshot(hostile).valid, false, owner);
    assert.equal(validateRuntimeSnapshot(hostile, plan).valid, false, owner);
    assert.throws(
      () => restoreCheckpoint({ ...createCheckpoint(plan, pending.snapshot), snapshot: hostile }),
      owner,
    );

    const completed = completeAction(plan, pending.snapshot, {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: "text",
      payload: { kind: "submittedText", submittedText: "new" },
    });
    assert.equal(completed.outcome.kind, "completed", owner);
    assert.equal(temporaryValue(completed.snapshot, destination), "new", owner);
  }
});

test("transferred interaction result is independent of the cleanup temporary", () => {
  const injected = injectTextInteraction('let answer = "__interaction_result__"\nsay answer\nexit');
  const pending = waiting(injected.plan);
  const completed = completeAction(
    injected.plan,
    pending.snapshot,
    textCompletionRequest(pending.snapshot),
  );
  const transferred = executeInstruction(injected.plan, completed.snapshot);

  assert.equal(transferred.snapshot.nextInstruction, injected.clearInstruction);
  assert.equal(transferred.snapshot.interactionResultHandoff, null);
  assert.equal(bindingValue(transferred.snapshot, "answer"), "committed");
  assert.equal(temporaryValue(transferred.snapshot, injected.destinationTemporary), "committed");

  const changedCleanupTemporary = structuredClone(transferred.snapshot);
  changedCleanupTemporary.temporaries.find(
    (temporary) => temporary.id === injected.destinationTemporary,
  )!.value = "changed cleanup value";
  const changedBeforeValidation = structuredClone(changedCleanupTemporary);
  assert.equal(validateRuntimeSnapshot(changedCleanupTemporary, injected.plan).valid, true);
  assert.deepEqual(changedCleanupTemporary, changedBeforeValidation);
  assert.doesNotThrow(() => createCheckpoint(injected.plan, changedCleanupTemporary));

  const cleaned = executeInstruction(injected.plan, changedCleanupTemporary);
  assert.equal(
    cleaned.snapshot.temporaries.some(
      (temporary) => temporary.id === injected.destinationTemporary,
    ),
    false,
  );
  assert.equal(bindingValue(cleaned.snapshot, "answer"), "committed");

  const ordinaryMutation = structuredClone(cleaned.snapshot);
  ordinaryMutation.frames[0]!.bindings.find((binding) => binding.name === "answer")!.value =
    "ordinary replacement";
  assert.equal(validateRuntimeSnapshot(ordinaryMutation, injected.plan).valid, true);
  assert.doesNotThrow(() => createCheckpoint(injected.plan, ordinaryMutation));
});

test("removed lifecycle fields are rejected structurally", () => {
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const snapshot = createFreshRuntimeSnapshot(plan);

  const oldLifecycle = { ...structuredClone(snapshot), lastSettlementResultState: "none" };
  assert.equal(validateRuntimeSnapshot(oldLifecycle, plan).valid, false);
  assert.throws(() => createCheckpoint(plan, oldLifecycle));
});

interface InjectedInteractionPlan {
  readonly plan: InstructionPlan;
  readonly destinationTemporary: number;
  readonly interactionInstruction: number;
  readonly handoffInstruction: number;
  readonly clearInstruction: number;
}

function injectTextInteraction(source: string): InjectedInteractionPlan {
  return injectInteraction(source, "text", {
    kind: "text",
    hint: null,
    accessibleName: defaults.text,
  });
}

function injectInteraction(
  source: string,
  interactionKind: "text" | "number" | "choice",
  ui: InteractionUiPayload,
): InjectedInteractionPlan {
  const compiled = compileSource(source);
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  const base = structuredClone(compiled.plan!);
  const marker = "__interaction_result__";
  const targetIndex = base.instructions.findIndex((instruction) =>
    containsLiteralMarker(instruction, marker),
  );
  assert.notEqual(targetIndex, -1, source);
  assert.equal(
    base.instructions.filter((instruction) => containsLiteralMarker(instruction, marker)).length,
    1,
    source,
  );

  const destinationTemporary = base.temporaryCount + 1;
  const markerInstruction = base.instructions[targetIndex]!;
  const callTransferTemporary =
    markerInstruction.kind === "callFunction" ? destinationTemporary + 1 : null;
  const insertedInstructionCount = callTransferTemporary === null ? 2 : 3;
  // EVIDENCE: replaceLiteralMarker recursively preserves this compiler-produced instruction except for its marker.
  const original = shiftInstructionTargets(
    replaceLiteralMarker(
      base.instructions[targetIndex],
      marker,
      callTransferTemporary ?? destinationTemporary,
    ) as Instruction,
    targetIndex,
    insertedInstructionCount,
  );
  const span = original.span;
  const expectedResult =
    interactionKind === "number" || (ui.kind === "choice" && ui.labelType === "number")
      ? "number"
      : "string";
  const interaction: InteractionInstruction = {
    kind: "interaction",
    interactionKind,
    target: "standardChat",
    speaker: null,
    destinationTemporary,
    expectedResult,
    ui,
    span,
  };
  const plan: InstructionPlan = {
    ...base,
    temporaryCount: callTransferTemporary ?? destinationTemporary,
    rootEndInstruction: shiftBoundary(
      base.rootEndInstruction,
      targetIndex,
      insertedInstructionCount,
    ),
    functions: base.functions.map((definition) => ({
      ...definition,
      entryInstruction: shiftBoundary(
        definition.entryInstruction,
        targetIndex,
        insertedInstructionCount,
      ),
      bodyEntryInstruction: shiftBoundary(
        definition.bodyEntryInstruction,
        targetIndex,
        insertedInstructionCount,
      ),
      implicitReturnInstruction: shiftBoundary(
        definition.implicitReturnInstruction,
        targetIndex,
        insertedInstructionCount,
      ),
      endInstruction: shiftBoundary(
        definition.endInstruction,
        targetIndex,
        insertedInstructionCount,
      ),
    })),
    instructions: [
      ...base.instructions
        .slice(0, targetIndex)
        .map((instruction) =>
          shiftInstructionTargets(instruction, targetIndex, insertedInstructionCount),
        ),
      interaction,
      ...(callTransferTemporary === null
        ? [original]
        : [
            {
              kind: "storeTemporary" as const,
              temporaryId: callTransferTemporary,
              value: temporaryExpression(destinationTemporary, span),
              expectBoolean: false,
              span,
            },
          ]),
      { kind: "clearTemporary", temporaryId: destinationTemporary, span },
      ...(callTransferTemporary === null ? [] : [original]),
      ...base.instructions
        .slice(targetIndex + 1)
        .map((instruction) =>
          shiftInstructionTargets(instruction, targetIndex, insertedInstructionCount),
        ),
    ],
  };

  const validation = validateInstructionPlan(plan);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  return {
    plan,
    destinationTemporary,
    interactionInstruction: targetIndex,
    handoffInstruction: targetIndex + 1,
    clearInstruction: targetIndex + 2,
  };
}

function shiftBoundary(value: number, insertionIndex: number, amount = 2): number {
  return value > insertionIndex ? value + amount : value;
}

function shiftInstructionTargets(
  instruction: Instruction,
  insertionIndex: number,
  amount = 2,
): Instruction {
  switch (instruction.kind) {
    case "jump":
    case "jumpIfFalse":
    case "loopControl":
    case "prepareParameterDefault":
      return { ...instruction, target: shiftBoundary(instruction.target, insertionIndex, amount) };
    case "loopStart":
      return {
        ...instruction,
        continueTarget: shiftBoundary(instruction.continueTarget, insertionIndex, amount),
        target: shiftBoundary(instruction.target, insertionIndex, amount),
      };
    case "callFunction":
      return {
        ...instruction,
        returnInstruction: shiftBoundary(instruction.returnInstruction, insertionIndex, amount),
      };
    default:
      return instruction;
  }
}

function containsLiteralMarker(value: unknown, marker: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsLiteralMarker(item, marker));
  if (typeof value !== "object" || value === null) return false;
  // EVIDENCE: after array and null checks, this read-only traversal examines the remaining object's enumerable values.
  const record = value as Record<string, unknown>;
  if (record.kind === "literal" && record.value === marker) return true;
  return Object.values(record).some((nested) => containsLiteralMarker(nested, marker));
}

function replaceLiteralMarker(
  value: unknown,
  marker: string,
  destinationTemporary: number,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: recursive heterogeneous plan transformation returns unknown until its instruction caller restores and checks the contract.
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => replaceLiteralMarker(item, marker, destinationTemporary));
  }
  if (typeof value !== "object" || value === null) return value;
  // EVIDENCE: after array and null checks, replacement copies the remaining object's own enumerable fields.
  const record = value as Record<string, unknown>;
  if (record.kind === "literal" && record.value === marker) {
    // oxlint-disable-next-line anti-slop/no-known-value-widening -- EVIDENCE: marker replacement returns an unvalidated temporary expression through this recursive unknown-data transformer.
    return {
      kind: "temporary",
      temporaryId: destinationTemporary,
      span: structuredClone(record.span),
    };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, nested]) => [
      key,
      replaceLiteralMarker(nested, marker, destinationTemporary),
    ]),
  );
}

type CanonicalHandoffKind =
  | "clearTemporary"
  | "exit"
  | "returnVoid"
  | "returnValue"
  | "declareBinding"
  | "assign"
  | "evaluate"
  | "storeTemporary"
  | "say"
  | "setDeclaredSpeakerProperty"
  | "prepareReference";

interface CanonicalHandoffRow {
  readonly id: string;
  readonly kind: CanonicalHandoffKind;
  readonly source: string;
  readonly makePlan: (injected: InjectedInteractionPlan) => InstructionPlan;
  /** Direct consumers remove the destination themselves; the others leave it to the cleanup. */
  readonly needsCleanup: boolean;
  readonly assertResult?: (
    snapshot: RuntimeSnapshot,
    events: readonly InterpreterEvent[],
    injected: InjectedInteractionPlan,
  ) => void;
  readonly assertFinal?: (snapshot: RuntimeSnapshot, events: readonly InterpreterEvent[]) => void;
  /**
   * The same consumer with its canonical expression field replaced and the destination moved to
   * an unsupported sibling field, which must not count as consumption.
   */
  readonly siblingFieldOnly?: (injected: InjectedInteractionPlan) => ExternalRecord;
}

function replaceHandoffInstruction(
  injected: InjectedInteractionPlan,
  instruction: Instruction,
  temporaryCount = injected.plan.temporaryCount,
): InstructionPlan {
  return {
    ...injected.plan,
    temporaryCount,
    instructions: injected.plan.instructions.map((current, index) =>
      index === injected.handoffInstruction ? instruction : current,
    ),
  };
}

function handoffInstructionSpan(injected: InjectedInteractionPlan): PlanSourceLocation {
  return injected.plan.instructions[injected.handoffInstruction]!.span;
}

function completeCommittedTextInteraction(plan: InstructionPlan) {
  const pending = waiting(plan);
  const before = structuredClone(pending.snapshot);
  const action = pending.snapshot.foregroundAction;
  assert.ok(action !== null);
  const completed = completeAction(plan, pending.snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "committed" },
  });
  assert.deepEqual(pending.snapshot, before);
  assert.equal(completed.outcome.kind, "completed");
  assert.deepEqual(
    completed.events.map((event) => event.kind),
    ["playerTranscript", "actionCompleted"],
  );
  return { pending, completed };
}

function checkpointJsonRoundTrip(plan: InstructionPlan, snapshot: RuntimeSnapshot) {
  const planBefore = structuredClone(plan);
  const before = structuredClone(snapshot);
  const checkpoint = createCheckpoint(plan, snapshot);
  assert.deepEqual(plan, planBefore, "checkpoint plan input");
  assert.deepEqual(snapshot, before);
  return deserializeCheckpoint(serializeCheckpoint(checkpoint));
}

function assertInteractionResumeEquivalent<T>(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  operation: (plan: InstructionPlan, snapshot: RuntimeSnapshot) => T,
  label: string,
): { readonly uninterrupted: T; readonly restored: T } {
  const planBefore = structuredClone(plan);
  const snapshotBefore = structuredClone(snapshot);
  const restoredBoundary = checkpointJsonRoundTrip(plan, snapshot);
  assert.deepEqual(restoredBoundary.plan, plan, `${label}: restored plan`);
  assert.deepEqual(restoredBoundary.snapshot, snapshot, `${label}: restored snapshot`);
  const restoredPlanBefore = structuredClone(restoredBoundary.plan);
  const restoredSnapshotBefore = structuredClone(restoredBoundary.snapshot);
  const uninterrupted = operation(plan, snapshot);
  const restored = operation(restoredBoundary.plan, restoredBoundary.snapshot);
  assert.deepEqual(restored, uninterrupted, `${label}: resumed operation`);
  assert.deepEqual(plan, planBefore, `${label}: original plan input`);
  assert.deepEqual(snapshot, snapshotBefore, `${label}: original snapshot input`);
  assert.deepEqual(restoredBoundary.plan, restoredPlanBefore, `${label}: restored plan input`);
  assert.deepEqual(
    restoredBoundary.snapshot,
    restoredSnapshotBefore,
    `${label}: restored snapshot input`,
  );
  return { uninterrupted, restored };
}

function temporaryValue(snapshot: RuntimeSnapshot, temporaryId: number) {
  const temporary = snapshot.temporaries.find((entry) => entry.id === temporaryId);
  assert.ok(temporary !== undefined, `missing temporary ${temporaryId}`);
  return temporary.value;
}

function bindingValue(snapshot: RuntimeSnapshot, name: string) {
  const binding = snapshot.frames[0]?.bindings.find((entry) => entry.name === name);
  assert.ok(binding !== undefined, `missing binding ${name}`);
  return binding.value;
}

function assertPreparedReference(value: unknown): void {
  assert.notEqual(value, null);
  assert.equal(typeof value, "object");
  // EVIDENCE: the assertions above establish an object; the following kind/property checks verify its serialized shape.
  const reference = value as SerializableRuntimeObject;
  assert.equal(reference.kind, "object");
  assert.equal(getSerializableProperty(reference, "marker"), "preparedReference");
  assert.equal(getSerializableProperty(reference, "rootFrameId"), null);
  assert.equal(getSerializableProperty(reference, "rootName"), null);
  assert.deepEqual(getSerializableProperty(reference, "path"), { kind: "list", items: [] });
  assert.equal(getSerializableProperty(reference, "capturedRoot"), "committed");
  assert.equal(getSerializableProperty(reference, "detached"), true);
}

type ExternalRecord = Record<string, unknown>;

function externalRecord(value: unknown, label: string): ExternalRecord {
  assert.equal(typeof value, "object", `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  // EVIDENCE: the preceding assertions exclude primitives and null before external fields are inspected.
  return value as ExternalRecord;
}

function externalArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function externalInstructions(plan: ExternalRecord): unknown[] {
  return externalArray(plan.instructions, "plan instructions");
}

test("PR194 matrix: every reachable canonical handoff form consumes exactly once", () => {
  const rows: readonly CanonicalHandoffRow[] = [
    {
      id: "PR194-form-clear-temporary",
      kind: "clearTemporary",
      source: 'let answer = "__interaction_result__"\nexit',
      makePlan: (injected) =>
        replaceHandoffInstruction(injected, {
          kind: "clearTemporary",
          temporaryId: injected.destinationTemporary,
          span: handoffInstructionSpan(injected),
        }),
      needsCleanup: false,
    },
    {
      id: "PR194-form-exit",
      kind: "exit",
      source: 'let answer = "__interaction_result__"\nexit',
      makePlan: (injected) =>
        replaceHandoffInstruction(injected, {
          kind: "exit",
          span: handoffInstructionSpan(injected),
        }),
      needsCleanup: false,
      assertResult: (snapshot, events) => {
        assert.equal(snapshot.status, "halted");
        assert.equal(events.filter((event) => event.kind === "exit").length, 1);
      },
    },
    {
      id: "PR194-form-return-void",
      kind: "returnVoid",
      source:
        'function prompt { let ignored = "__interaction_result__"\nreturn }\nprompt()\nsay "after"\nexit',
      makePlan: (injected) =>
        replaceHandoffInstruction(injected, {
          kind: "returnVoid",
          span: handoffInstructionSpan(injected),
        }),
      needsCleanup: false,
      assertResult: (snapshot) => {
        assert.equal(snapshot.callFrames.length, 0);
      },
      assertFinal: (_snapshot, events) =>
        assert.ok(events.some((event) => event.kind === "say" && event.text === "after")),
    },
    {
      id: "PR194-form-return-value",
      kind: "returnValue",
      source:
        'function prompt { return "__interaction_result__" }\nlet answer = prompt()\nsay answer\nexit',
      makePlan: (injected) => injected.plan,
      needsCleanup: false,
      assertResult: (snapshot) => {
        assert.equal(snapshot.callFrames.length, 0);
      },
      assertFinal: (snapshot, events) => {
        assert.equal(bindingValue(snapshot, "answer"), "committed");
        assert.deepEqual(
          events.filter((event) => event.kind === "say").map((event) => event.text),
          ["committed"],
        );
      },
    },
    {
      id: "PR194-form-declare-binding",
      kind: "declareBinding",
      source: 'let answer = "__interaction_result__"\nsay answer\nexit',
      makePlan: (injected) => injected.plan,
      needsCleanup: true,
      assertResult: (snapshot) => assert.equal(bindingValue(snapshot, "answer"), "committed"),
      assertFinal: (_snapshot, events) =>
        assert.deepEqual(
          events.filter((event) => event.kind === "say").map((event) => event.text),
          ["committed"],
        ),
      siblingFieldOnly: (injected) => ({
        kind: "declareBinding",
        name: "answer",
        value: literalExpression(false, handoffInstructionSpan(injected)),
        expression: temporaryExpression(
          injected.destinationTemporary,
          handoffInstructionSpan(injected),
        ),
        span: handoffInstructionSpan(injected),
      }),
    },
    {
      id: "PR194-form-assign",
      kind: "assign",
      source: 'let answer = "before"\nanswer = "__interaction_result__"\nsay answer\nexit',
      makePlan: (injected) => injected.plan,
      needsCleanup: true,
      assertResult: (snapshot) => assert.equal(bindingValue(snapshot, "answer"), "committed"),
    },
    {
      id: "PR194-form-evaluate",
      kind: "evaluate",
      source: 'let answer = "__interaction_result__"\nexit',
      makePlan: (injected) =>
        replaceHandoffInstruction(injected, {
          kind: "evaluate",
          expression: {
            kind: "temporary",
            temporaryId: injected.destinationTemporary,
            span: handoffInstructionSpan(injected),
          },
          span: handoffInstructionSpan(injected),
        }),
      needsCleanup: true,
      assertResult: (snapshot) => assert.equal(snapshot.status, "running"),
      siblingFieldOnly: (injected) => ({
        kind: "evaluate",
        expression: literalExpression(false, handoffInstructionSpan(injected)),
        value: temporaryExpression(injected.destinationTemporary, handoffInstructionSpan(injected)),
        span: handoffInstructionSpan(injected),
      }),
    },
    {
      id: "PR194-form-store-temporary",
      kind: "storeTemporary",
      source: 'let answer = "__interaction_result__"\nexit',
      makePlan: (injected) =>
        replaceHandoffInstruction(
          injected,
          {
            kind: "storeTemporary",
            temporaryId: injected.destinationTemporary + 1,
            value: {
              kind: "temporary",
              temporaryId: injected.destinationTemporary,
              span: handoffInstructionSpan(injected),
            },
            expectBoolean: false,
            span: handoffInstructionSpan(injected),
          },
          injected.plan.temporaryCount + 1,
        ),
      needsCleanup: true,
      assertResult: (snapshot, _events, injected) =>
        assert.equal(temporaryValue(snapshot, injected.destinationTemporary + 1), "committed"),
    },
    {
      id: "PR194-form-say",
      kind: "say",
      source: 'let answer = "__interaction_result__"\nexit',
      makePlan: (injected) =>
        replaceHandoffInstruction(injected, {
          kind: "say",
          presentation: null,
          speaker: null,
          value: {
            kind: "temporary",
            temporaryId: injected.destinationTemporary,
            span: handoffInstructionSpan(injected),
          },
          skipPolicy: null,
          pacing: "smart",
          span: handoffInstructionSpan(injected),
        }),
      needsCleanup: true,
      assertResult: (_snapshot, events) =>
        assert.ok(events.some((event) => event.kind === "say" && event.text === "committed")),
    },
    {
      id: "PR194-form-set-declared-speaker-property",
      kind: "setDeclaredSpeakerProperty",
      source: 'speaker guide {}\nspeaker guide\nlet answer = "__interaction_result__"\nexit',
      makePlan: (injected) =>
        replaceHandoffInstruction(injected, {
          kind: "setDeclaredSpeakerProperty",
          speaker: "guide",
          name: "answer",
          value: {
            kind: "temporary",
            temporaryId: injected.destinationTemporary,
            span: handoffInstructionSpan(injected),
          },
          span: handoffInstructionSpan(injected),
        }),
      needsCleanup: true,
      assertResult: (snapshot) => {
        const speaker = snapshot.speakers.find((entry) => entry.identifier === "guide");
        assert.ok(speaker !== undefined);
        assert.equal(
          speaker.properties.find((property) => property.name === "answer")?.value,
          "committed",
        );
      },
    },
    {
      id: "PR194-form-prepare-reference",
      kind: "prepareReference",
      source: 'let answer = "__interaction_result__"\nexit',
      makePlan: (injected) =>
        replaceHandoffInstruction(
          injected,
          {
            kind: "prepareReference",
            expression: {
              kind: "temporary",
              temporaryId: injected.destinationTemporary,
              span: handoffInstructionSpan(injected),
            },
            destinationTemporary: injected.destinationTemporary + 1,
            span: handoffInstructionSpan(injected),
          },
          injected.plan.temporaryCount + 1,
        ),
      needsCleanup: true,
      assertResult: (snapshot, _events, injected) =>
        assertPreparedReference(temporaryValue(snapshot, injected.destinationTemporary + 1)),
      siblingFieldOnly: (injected) => ({
        kind: "prepareReference",
        expression: literalExpression(false, handoffInstructionSpan(injected)),
        value: temporaryExpression(injected.destinationTemporary, handoffInstructionSpan(injected)),
        destinationTemporary: injected.destinationTemporary + 1,
        span: handoffInstructionSpan(injected),
      }),
    },
  ];

  for (const row of rows) {
    const injected = injectTextInteraction(row.source);
    const plan = row.makePlan(injected);
    const planBefore = structuredClone(plan);
    const validation = validateInstructionPlan(plan);
    assert.equal(validation.valid, true, `${row.id}: ${JSON.stringify(validation.errors)}`);
    assert.deepEqual(plan, planBefore, row.id);
    assert.equal(plan.instructions[injected.handoffInstruction]?.kind, row.kind, row.id);

    if (row.siblingFieldOnly !== undefined) {
      // Deliberately unsupported sibling fields exercise public malformed-plan validation.
      const misplaced = replaceHandoffInstruction(
        injected,
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: the row keeps the consumer shape and only moves the destination read to an unsupported sibling field.
        row.siblingFieldOnly(injected) as unknown as Instruction,
        plan.temporaryCount,
      );
      const misplacedBefore = structuredClone(misplaced);
      assert.deepEqual(
        validateInstructionPlan(misplaced).errors.map((error) => [error.code, error.path]),
        [["TSC002", `$.instructions[${injected.handoffInstruction}]`]],
        `${row.id}: sibling field`,
      );
      assert.deepEqual(misplaced, misplacedBefore, `${row.id}: sibling field plan input`);
    }

    const pending = waiting(plan).snapshot;
    const action = pending.foregroundAction;
    assert.ok(action !== null && action.kind === "interaction", row.id);
    // Root interactions have no owner; function interactions belong to the innermost call frame.
    assert.equal(action.ownerCallFrameId, pending.callFrames.at(-1)?.id ?? null, row.id);
    const request = textCompletionRequest(pending);
    const completion = assertInteractionResumeEquivalent(
      plan,
      pending,
      (currentPlan, snapshot) => completeAction(currentPlan, snapshot, request),
      `${row.id}: pending`,
    ).uninterrupted;
    assert.equal(completion.outcome.kind, "completed", row.id);
    assert.deepEqual(
      completion.events.map((event) => event.kind),
      ["playerTranscript", "actionCompleted"],
      row.id,
    );

    // Completion stops at the handoff: the continuation has not run and no ordinary binding holds
    // the result yet.
    const committed = completion.snapshot;
    assert.equal(committed.nextInstruction, injected.handoffInstruction, row.id);
    assert.equal(temporaryValue(committed, injected.destinationTemporary), "committed", row.id);
    assert.equal(
      committed.frames[0]?.bindings.find((binding) => binding.name === "answer")?.value,
      row.kind === "assign" ? "before" : undefined,
      row.id,
    );
    const handoff = committed.interactionResultHandoff;
    assert.ok(handoff !== null, row.id);
    assert.equal(handoff.destinationTemporary, injected.destinationTemporary, row.id);
    assert.equal(handoff.result, "committed", row.id);
    assert.equal(handoff.ownerCallFrameId, action.ownerCallFrameId, `${row.id}: handoff owner`);

    const continued = assertInteractionResumeEquivalent(
      plan,
      committed,
      executeInstruction,
      `${row.id}: committed`,
    ).uninterrupted;
    assert.equal(continued.snapshot.interactionResultHandoff, null, row.id);
    assert.equal(
      continued.snapshot.temporaries.some((entry) => entry.id === injected.destinationTemporary),
      row.needsCleanup,
      `${row.id}: destination after consumption`,
    );
    row.assertResult?.(continued.snapshot, continued.events, injected);

    const boundaries: [string, RuntimeSnapshot][] = [
      ["committed", committed],
      ["consumed", continued.snapshot],
    ];
    let settled = continued.snapshot;
    if (row.needsCleanup) {
      settled = assertInteractionResumeEquivalent(
        plan,
        continued.snapshot,
        executeInstruction,
        `${row.id}: consumed`,
      ).uninterrupted.snapshot;
      assert.equal(
        settled.temporaries.some((entry) => entry.id === injected.destinationTemporary),
        false,
        `${row.id}: cleaned destination`,
      );
      boundaries.push(["cleaned", settled]);
    }
    const final = assertInteractionResumeEquivalent(
      plan,
      settled,
      run,
      `${row.id}: settled`,
    ).uninterrupted;
    assert.equal(final.snapshot.status, "halted", `${row.id}: final status`);
    row.assertFinal?.(final.snapshot, final.events);
    boundaries.push(["halted", final.snapshot]);

    // Bounded replay reports the recorded settlement at every later boundary, before and after
    // a JSON checkpoint, and an action that was never issued is unknown.
    for (const [phase, snapshot] of boundaries) {
      for (const [label, replayed] of [
        ["original", snapshot],
        ["roundtrip", checkpointJsonRoundTrip(plan, snapshot).snapshot],
      ] as const) {
        assertReplayRow({
          id: `${row.id}: replay ${phase} ${label}`,
          plan,
          snapshot: replayed,
          request,
          expected: { kind: "alreadySettled" },
        });
      }
    }
    assertReplayRow({
      id: `${row.id}: replay next action`,
      plan,
      snapshot: final.snapshot,
      request: { ...request, actionId: final.snapshot.nextActionId },
      expected: { kind: "unknownAction", actionId: final.snapshot.nextActionId },
    });
  }
});

interface AcceptedExpressionGuaranteeRow {
  readonly id: string;
  readonly category: string;
  readonly expression: ExpressionPlan;
  readonly temporaryCount?: number;
  readonly runtimeWitness?: true;
}

interface RejectedExpressionGuaranteeRow {
  readonly id: string;
  readonly category: string;
  readonly expression: unknown;
  readonly temporaryCount?: number;
  /** Additional TSC002 rejections that share the handoff instruction path. */
  readonly sharedPathRejections?: number;
}

function temporaryExpression(temporaryId: number, span: PlanSourceLocation): ExpressionPlan {
  return { kind: "temporary", temporaryId, span };
}

function literalExpression(
  value: string | number | boolean | null,
  span: PlanSourceLocation,
): ExpressionPlan {
  return { kind: "literal", value, span };
}

function binaryExpression(
  operator: BinaryExpressionPlan["operator"],
  left: ExpressionPlan,
  right: ExpressionPlan,
  span: PlanSourceLocation,
): ExpressionPlan {
  return { kind: "binary", operator, left, right, span };
}

function handoffPlanWithExpression(
  injected: InjectedInteractionPlan,
  expression: ExpressionPlan,
  temporaryCount = injected.plan.temporaryCount,
): InstructionPlan {
  return replaceHandoffInstruction(
    injected,
    {
      kind: "declareBinding",
      name: "answer",
      value: expression,
      span: handoffInstructionSpan(injected),
    },
    temporaryCount,
  );
}

function handoffPlanWithMalformedExpression(
  injected: InjectedInteractionPlan,
  expression: unknown,
  temporaryCount = injected.plan.temporaryCount,
): InstructionPlan {
  const instruction = {
    kind: "declareBinding",
    name: "answer",
    value: expression,
    span: handoffInstructionSpan(injected),
  };
  // Deliberately malformed external plan data cannot be represented by Instruction.
  return replaceHandoffInstruction(
    injected,
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture injects an unvalidated expression into declareBinding to test malformed-plan rejection.
    instruction as unknown as Instruction,
    temporaryCount,
  );
}

test("PR194 matrix: expression consumption requires guaranteed evaluation", () => {
  const injected = injectTextInteraction('let answer = "__interaction_result__"\nexit');
  const span = handoffInstructionSpan(injected);
  const destination = injected.destinationTemporary;
  const matching = temporaryExpression(destination, span);
  // The alternate temporary is declared by widening the plan, so it is in range and only the
  // handoff rule can reject reading it instead of the destination.
  const widenedTemporaryCount = injected.plan.temporaryCount + 1;
  assert.ok(destination + 1 <= widenedTemporaryCount);
  const wrong = temporaryExpression(destination + 1, span);
  const propertyCallee: ExpressionPlan = {
    kind: "property",
    object: { kind: "list", elements: [], span },
    name: "contains",
    span,
  };
  const accepted: readonly AcceptedExpressionGuaranteeRow[] = [
    {
      id: "PR194-expression-direct-temporary",
      category: "temporary",
      expression: matching,
      runtimeWitness: true,
    },
    {
      id: "PR194-expression-list-element",
      category: "list",
      expression: { kind: "list", elements: [matching], span },
      runtimeWitness: true,
    },
    {
      id: "PR194-expression-set-element",
      category: "set",
      expression: { kind: "set", elements: [matching], span },
    },
    {
      id: "PR194-expression-object-property-value",
      category: "object",
      expression: { kind: "object", properties: [{ name: "answer", value: matching, span }], span },
    },
    {
      id: "PR194-expression-group",
      category: "group",
      expression: { kind: "group", expression: matching, span },
    },
    {
      id: "PR194-expression-template-part",
      category: "template",
      expression: {
        kind: "template",
        parts: [
          { kind: "text", value: "answer: ", span },
          { kind: "expression", expression: matching, span },
        ],
        span,
      },
    },
    {
      id: "PR194-expression-property-object",
      category: "property",
      expression: { kind: "property", object: matching, name: "length", span },
    },
    {
      id: "PR194-expression-index-object",
      category: "index",
      expression: { kind: "index", object: matching, index: literalExpression(0, span), span },
    },
    {
      id: "PR194-expression-index-index",
      category: "index",
      expression: {
        kind: "index",
        object: { kind: "list", elements: [literalExpression("value", span)], span },
        index: matching,
        span,
      },
    },
    {
      id: "PR194-expression-property-call-receiver",
      category: "call",
      expression: {
        kind: "call",
        callee: { kind: "property", object: matching, name: "contains", span },
        arguments: [],
        span,
      },
    },
    {
      id: "PR194-expression-positional-call-argument",
      category: "call",
      expression: {
        kind: "call",
        callee: propertyCallee,
        arguments: [{ kind: "positional", value: matching, span }],
        span,
      },
    },
    {
      id: "PR194-expression-named-call-argument",
      category: "call",
      expression: {
        kind: "call",
        callee: propertyCallee,
        arguments: [{ kind: "named", name: "value", value: matching, span }],
        span,
      },
    },
    {
      id: "PR194-expression-unary-operand",
      category: "unary",
      expression: { kind: "unary", operator: "not", operand: matching, span },
    },
    {
      id: "PR194-expression-eager-left",
      category: "binary",
      expression: binaryExpression("==", matching, literalExpression("committed", span), span),
    },
    {
      id: "PR194-expression-eager-right",
      category: "binary",
      expression: binaryExpression("==", literalExpression("committed", span), matching, span),
      runtimeWitness: true,
    },
    {
      id: "PR194-expression-range-start",
      category: "range",
      expression: {
        kind: "range",
        start: matching,
        end: literalExpression(2, span),
        inclusive: true,
        span,
      },
    },
    {
      id: "PR194-expression-range-end",
      category: "range",
      expression: {
        kind: "range",
        start: literalExpression(1, span),
        end: matching,
        inclusive: true,
        span,
      },
    },
    {
      id: "PR194-expression-and-left",
      category: "short-circuit",
      expression: binaryExpression("and", matching, literalExpression(true, span), span),
    },
    {
      id: "PR194-expression-or-left",
      category: "short-circuit",
      expression: binaryExpression("or", matching, literalExpression(false, span), span),
    },
    {
      id: "PR194-expression-multiple-guaranteed",
      category: "multiple",
      expression: { kind: "list", elements: [matching, matching], span },
      runtimeWitness: true,
    },
    {
      id: "PR194-expression-wrong-and-correct",
      category: "multiple",
      expression: { kind: "list", elements: [wrong, matching], span },
      temporaryCount: widenedTemporaryCount,
    },
  ];
  const rejected: readonly RejectedExpressionGuaranteeRow[] = [
    {
      id: "PR194-expression-no-occurrence",
      category: "missing",
      expression: literalExpression(false, span),
    },
    {
      id: "PR194-expression-wrong-temporary",
      category: "wrong temporary",
      expression: wrong,
      temporaryCount: widenedTemporaryCount,
    },
    {
      id: "PR194-expression-prepared-reference",
      category: "prepared reference",
      expression: { kind: "preparedReference", temporaryId: destination, span },
      sharedPathRejections: 1,
    },
    {
      id: "PR194-expression-and-right-false",
      category: "short-circuit",
      expression: binaryExpression("and", literalExpression(false, span), matching, span),
    },
    {
      id: "PR194-expression-and-right-true",
      category: "short-circuit",
      expression: binaryExpression("and", literalExpression(true, span), matching, span),
    },
    {
      id: "PR194-expression-or-right-false",
      category: "short-circuit",
      expression: binaryExpression("or", literalExpression(false, span), matching, span),
    },
    {
      id: "PR194-expression-or-right-true",
      category: "short-circuit",
      expression: binaryExpression("or", literalExpression(true, span), matching, span),
    },
    {
      id: "PR194-expression-nested-short-circuit-right",
      category: "short-circuit",
      expression: binaryExpression(
        "and",
        literalExpression(true, span),
        binaryExpression("or", literalExpression(false, span), matching, span),
        span,
      ),
    },
    {
      id: "PR194-expression-non-property-callee",
      category: "call",
      expression: { kind: "call", callee: matching, arguments: [], span },
    },
    {
      id: "PR194-expression-template-text-metadata",
      category: "metadata",
      // oxlint-disable-next-line anti-slop/no-known-value-widening -- EVIDENCE: fixture adds forbidden temporary metadata to a template text part for plan rejection.
      expression: {
        kind: "template",
        parts: [{ kind: "text", value: "ignored", span, temporaryId: destination }],
        span,
      } as unknown,
    },
    {
      id: "PR194-expression-ignored-extra-field",
      category: "ignored field",
      expression: { kind: "literal", value: false, span, ignored: matching },
    },
    {
      id: "PR194-expression-wrong-left-correct-right",
      category: "short-circuit",
      expression: binaryExpression("or", wrong, matching, span),
      temporaryCount: widenedTemporaryCount,
    },
  ];

  for (const row of accepted) {
    const plan = handoffPlanWithExpression(injected, row.expression, row.temporaryCount);
    const before = structuredClone(plan);
    const validation = validateInstructionPlan(plan);
    assert.equal(validation.valid, true, `${row.id}: ${row.category}`);
    assert.deepEqual(plan, before, row.id);
  }

  for (const row of rejected) {
    const plan = handoffPlanWithMalformedExpression(injected, row.expression, row.temporaryCount);
    const before = structuredClone(plan);
    const validation = validateInstructionPlan(plan);
    assert.equal(validation.valid, false, `${row.id}: ${row.category}`);
    const handoffRejection = ["TSC002", `$.instructions[${injected.handoffInstruction}]`];
    assert.deepEqual(
      validation.errors.map((error) => [error.code, error.path]),
      Array.from({ length: 1 + (row.sharedPathRejections ?? 0) }, () => handoffRejection),
      row.id,
    );
    assert.deepEqual(plan, before, row.id);
  }

  for (const row of accepted.filter((entry) => entry.runtimeWitness === true)) {
    const plan = handoffPlanWithExpression(injected, row.expression);
    const { completed } = completeCommittedTextInteraction(plan);
    const continued = executeInstruction(plan, completed.snapshot);
    assert.equal(continued.snapshot.interactionResultHandoff, null, row.id);
  }
});

interface SettlementHandoffFixture {
  readonly injected: InjectedInteractionPlan;
  /** Produced through the public interaction completion operation. */
  readonly runtimeProducedCommittedInteraction: RuntimeSnapshot;
  /** Produced through the public completion of the first delay. */
  readonly olderDelaySettlement: RuntimeDelayActionSettlementSnapshot;
  /** Produced through the public completion of the later delay. */
  readonly laterDelaySettlement: RuntimeDelayActionSettlementSnapshot;
  /** A real pending later delay, retained only to build an incompatible pair. */
  readonly runtimeProducedLaterPendingDelay: RuntimeSnapshot;
  /** The runtime-produced state retaining the later delay settlement. */
  readonly runtimeProducedLaterSettledDelay: RuntimeSnapshot;
  /**
   * A deliberately assembled persisted-state fixture: it combines the
   * runtime-produced committed interaction with the later runtime-produced
   * delay settlement.  The validator and checkpoint boundaries accept it.
   */
  readonly validatedCompositeWithNewerSettlement: RuntimeSnapshot;
}

interface RejectedSettlementHandoffRow {
  readonly id: string;
  readonly category:
    | "malformed settlement"
    | "malformed handoff"
    | "handoff disagreement"
    | "incompatible lifecycle"
    | "counter"
    | "chronology";
  readonly mutate: (snapshot: ExternalRecord, fixture: SettlementHandoffFixture) => void;
}

function externalTemporary(snapshot: ExternalRecord, temporaryId: number): ExternalRecord {
  const temporaries = externalArray(snapshot.temporaries, "temporaries");
  const temporary = temporaries.find(
    (entry) => externalRecord(entry, "temporary").id === temporaryId,
  );
  assert.ok(temporary !== undefined, `missing temporary ${temporaryId}`);
  return externalRecord(temporary, "temporary");
}

function settledHandoffFixture(): SettlementHandoffFixture {
  const injected = injectTextInteraction(
    'wait 1 ms\nlet answer = "__interaction_result__"\nwait 1 ms\nsay answer\nexit',
  );
  const firstDelay = run(injected.plan, createImmediatePacingRuntimeSnapshot(injected.plan));
  assert.equal(firstDelay.snapshot.foregroundAction?.kind, "delay");
  const firstSettled = observeTime(injected.plan, firstDelay.snapshot, 1);
  assert.equal(validateRuntimeSnapshot(firstSettled.snapshot, injected.plan).valid, true);
  const interactionPending = run(injected.plan, firstSettled.snapshot);
  const action = interactionPending.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  const completed = completeAction(injected.plan, interactionPending.snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "committed" },
  });
  assert.equal(completed.outcome.kind, "completed");
  assert.equal(validateRuntimeSnapshot(completed.snapshot, injected.plan).valid, true);
  const olderDelaySettlement = firstSettled.snapshot.lastSettlement;
  assert.ok(olderDelaySettlement !== null && olderDelaySettlement.actionKind === "delay");
  assert.ok(
    olderDelaySettlement.actionId < completed.snapshot.nextActionId - 1,
    "the retained delay settlement must be a positive, genuinely older action",
  );
  assert.doesNotThrow(() => checkpointJsonRoundTrip(injected.plan, completed.snapshot));

  const consumed = executeInstruction(injected.plan, completed.snapshot);
  const cleared = executeInstruction(injected.plan, consumed.snapshot);
  const laterDelay = run(injected.plan, cleared.snapshot);
  assert.equal(laterDelay.snapshot.foregroundAction?.kind, "delay");
  assert.equal(validateRuntimeSnapshot(laterDelay.snapshot, injected.plan).valid, true);
  const laterSettled = observeTime(injected.plan, laterDelay.snapshot, 2);
  const laterDelaySettlement = laterSettled.snapshot.lastSettlement;
  assert.ok(laterDelaySettlement !== null && laterDelaySettlement.actionKind === "delay");

  // This exact state is deliberately assembled as persisted data; it is not
  // claimed to arise from a single uninterrupted runtime path.
  const validatedCompositeWithNewerSettlement = structuredClone(completed.snapshot);
  validatedCompositeWithNewerSettlement.lastSettlement = structuredClone(laterDelaySettlement);
  validatedCompositeWithNewerSettlement.nextActionId = laterSettled.snapshot.nextActionId;
  validatedCompositeWithNewerSettlement.nextEventSequence = laterSettled.snapshot.nextEventSequence;
  validatedCompositeWithNewerSettlement.currentSessionTimeMs =
    laterSettled.snapshot.currentSessionTimeMs;
  validatedCompositeWithNewerSettlement.observedSessionTimeMs =
    laterSettled.snapshot.observedSessionTimeMs;
  const compositeValidation = validateRuntimeSnapshot(
    validatedCompositeWithNewerSettlement,
    injected.plan,
  );
  assert.equal(compositeValidation.valid, true, JSON.stringify(compositeValidation.errors));
  const compositeRoundTrip = checkpointJsonRoundTrip(
    injected.plan,
    validatedCompositeWithNewerSettlement,
  );
  assert.deepEqual(compositeRoundTrip.snapshot, validatedCompositeWithNewerSettlement);

  return {
    injected,
    runtimeProducedCommittedInteraction: completed.snapshot,
    olderDelaySettlement: structuredClone(olderDelaySettlement),
    laterDelaySettlement: structuredClone(laterDelaySettlement),
    runtimeProducedLaterPendingDelay: laterDelay.snapshot,
    runtimeProducedLaterSettledDelay: laterSettled.snapshot,
    validatedCompositeWithNewerSettlement,
  };
}

function assertRejectedSettlementHandoffSnapshot(
  plan: InstructionPlan,
  validSnapshot: RuntimeSnapshot,
  invalidSnapshot: ExternalRecord,
  id: string,
): void {
  const beforeValidation = structuredClone(invalidSnapshot);
  assert.equal(validateRuntimeSnapshot(invalidSnapshot, plan).valid, false, id);
  assert.deepEqual(invalidSnapshot, beforeValidation, `${id}: validation input`);

  const beforePlan = structuredClone(plan);
  const beforeCheckpoint = structuredClone(invalidSnapshot);
  // The external snapshot is deliberately malformed at this public boundary.
  assert.throws(
    () => {
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture passes the malformed external record through the typed checkpoint boundary to verify rejection.
      return createCheckpoint(plan, invalidSnapshot as unknown as RuntimeSnapshot);
    },
    (error: unknown) => error instanceof CheckpointError && error.info.code === "TSK002",
    id,
  );
  assert.deepEqual(plan, beforePlan, `${id}: checkpoint plan input`);
  assert.deepEqual(invalidSnapshot, beforeCheckpoint, `${id}: checkpoint snapshot input`);

  const validCheckpoint = createCheckpoint(plan, validSnapshot);
  const invalidCheckpoint = { ...validCheckpoint, snapshot: invalidSnapshot };
  const beforeRestore = structuredClone(invalidCheckpoint);
  assert.throws(
    () => restoreCheckpoint(invalidCheckpoint),
    (error: unknown) => error instanceof CheckpointError && error.info.code === "TSK002",
    id,
  );
  assert.deepEqual(invalidCheckpoint, beforeRestore, `${id}: restore checkpoint input`);
}

test("PR194 matrix: settlement and active handoff validation", () => {
  const fixture = settledHandoffFixture();
  const {
    injected,
    runtimeProducedCommittedInteraction: committed,
    validatedCompositeWithNewerSettlement,
  } = fixture;

  const accepted: readonly { readonly id: string; readonly snapshot: RuntimeSnapshot }[] = [
    { id: "PR194-settlement-exact-matching", snapshot: committed },
    {
      id: "PR194-settlement-validated-composite-newer-delay",
      snapshot: validatedCompositeWithNewerSettlement,
    },
  ];
  for (const row of accepted) {
    const beforePlan = structuredClone(injected.plan);
    const before = structuredClone(row.snapshot);
    assert.equal(validateRuntimeSnapshot(row.snapshot, injected.plan).valid, true, row.id);
    assert.doesNotThrow(() => createCheckpoint(injected.plan, row.snapshot), row.id);
    const restored = checkpointJsonRoundTrip(injected.plan, row.snapshot);
    assert.deepEqual(restored.plan, injected.plan, `${row.id}: restored plan`);
    assert.deepEqual(restored.snapshot, row.snapshot, `${row.id}: restored snapshot`);
    assert.deepEqual(injected.plan, beforePlan, `${row.id}: plan input`);
    assert.deepEqual(row.snapshot, before, row.id);
  }

  // The accepted composite consumes, cleans up and finishes equivalently after JSON restore while
  // keeping the newer retained settlement.
  const continued = assertInteractionResumeEquivalent(
    injected.plan,
    validatedCompositeWithNewerSettlement,
    executeInstruction,
    "PR194-newer-settlement-consume",
  ).uninterrupted;
  assert.equal(continued.snapshot.interactionResultHandoff, null, "PR194-newer-settlement-consume");
  assert.equal(bindingValue(continued.snapshot, "answer"), "committed");
  assert.deepEqual(continued.snapshot.lastSettlement, fixture.laterDelaySettlement);
  const cleaned = assertInteractionResumeEquivalent(
    injected.plan,
    continued.snapshot,
    executeInstruction,
    "PR194-newer-settlement-cleanup",
  ).uninterrupted;
  assert.equal(
    cleaned.snapshot.temporaries.some((entry) => entry.id === injected.destinationTemporary),
    false,
  );
  assert.deepEqual(cleaned.snapshot.lastSettlement, fixture.laterDelaySettlement);
  const final = assertInteractionResumeEquivalent(
    injected.plan,
    cleaned.snapshot,
    run,
    "PR194-newer-settlement-final",
  ).uninterrupted;
  assert.deepEqual(final.snapshot.lastSettlement, fixture.laterDelaySettlement);

  const rows: readonly RejectedSettlementHandoffRow[] = [
    {
      id: "PR194-settlement-null",
      category: "handoff disagreement",
      mutate: (snapshot) => {
        snapshot.lastSettlement = null;
      },
    },
    {
      id: "PR194-settlement-older-valid",
      category: "handoff disagreement",
      mutate: (snapshot, current) => {
        snapshot.lastSettlement = structuredClone(current.olderDelaySettlement);
      },
    },
    {
      id: "PR194-settlement-equal-wrong-action-kind",
      category: "handoff disagreement",
      mutate: (snapshot, current) => {
        const delay = structuredClone(current.laterDelaySettlement);
        const handoffActionId = externalRecord(
          snapshot.interactionResultHandoff,
          "handoff",
        ).actionId;
        const nextEventSequence = snapshot.nextEventSequence;
        if (typeof handoffActionId !== "number" || typeof nextEventSequence !== "number") {
          throw new Error("committed handoff fields must be numeric");
        }
        snapshot.nextActionId = delay.actionId + 1;
        snapshot.nextEventSequence = Math.max(nextEventSequence, delay.completionEventSequence + 1);
        snapshot.lastSettlement = { ...delay, actionId: handoffActionId };
      },
    },
    {
      id: "PR194-settlement-equal-wrong-interaction-kind",
      category: "handoff disagreement",
      mutate: (snapshot) => {
        externalRecord(snapshot.lastSettlement, "settlement").interactionKind = "number";
      },
    },
    {
      id: "PR194-settlement-equal-wrong-kind",
      category: "malformed settlement",
      mutate: (snapshot) => {
        externalRecord(snapshot.lastSettlement, "settlement").settlementKind = "rejected";
      },
    },
    {
      id: "PR194-settlement-wrong-owning-instruction",
      category: "handoff disagreement",
      mutate: (snapshot) => {
        externalRecord(snapshot.lastSettlement, "settlement").owningInstruction = 0;
      },
    },
    {
      id: "PR194-settlement-wrong-continuation",
      category: "handoff disagreement",
      mutate: (snapshot) => {
        externalRecord(snapshot.lastSettlement, "settlement").continuationInstruction = 0;
      },
    },
    {
      id: "PR194-settlement-wrong-owner",
      category: "handoff disagreement",
      mutate: (snapshot) => {
        externalRecord(snapshot.lastSettlement, "settlement").ownerCallFrameId = 1;
        snapshot.nextCallFrameId = 2;
      },
    },
    {
      id: "PR194-settlement-wrong-destination",
      category: "handoff disagreement",
      mutate: (snapshot, current) => {
        externalRecord(snapshot.lastSettlement, "settlement").destinationTemporary =
          current.injected.destinationTemporary + 1;
      },
    },
    {
      id: "PR194-settlement-wrong-result",
      category: "handoff disagreement",
      mutate: (snapshot) => {
        externalRecord(snapshot.lastSettlement, "settlement").result = "forged";
      },
    },
    {
      id: "PR194-settlement-wrong-transcript",
      category: "handoff disagreement",
      mutate: (snapshot) => {
        externalRecord(snapshot.lastSettlement, "settlement").transcriptText = "forged";
      },
    },
    {
      id: "PR194-settlement-missing-field",
      category: "malformed settlement",
      mutate: (snapshot) => {
        delete externalRecord(snapshot.lastSettlement, "settlement").result;
      },
    },
    {
      id: "PR194-settlement-extra-field",
      category: "malformed settlement",
      mutate: (snapshot) => {
        externalRecord(snapshot.lastSettlement, "settlement").extra = true;
      },
    },
    {
      id: "PR194-handoff-null",
      category: "malformed handoff",
      mutate: (snapshot) => {
        snapshot.interactionResultHandoff = null;
      },
    },
    {
      id: "PR194-handoff-missing-field",
      category: "malformed handoff",
      mutate: (snapshot) => {
        delete externalRecord(snapshot.interactionResultHandoff, "handoff").result;
      },
    },
    {
      id: "PR194-handoff-extra-field",
      category: "malformed handoff",
      mutate: (snapshot) => {
        externalRecord(snapshot.interactionResultHandoff, "handoff").extra = true;
      },
    },
    {
      id: "PR194-handoff-destination-missing",
      category: "handoff disagreement",
      mutate: (snapshot, current) => {
        const temporaries = externalArray(snapshot.temporaries, "temporaries");
        const index = temporaries.findIndex(
          (entry) =>
            externalRecord(entry, "temporary").id === current.injected.destinationTemporary,
        );
        assert.notEqual(index, -1);
        temporaries.splice(index, 1);
      },
    },
    {
      id: "PR194-handoff-destination-forged",
      category: "handoff disagreement",
      mutate: (snapshot, current) => {
        externalTemporary(snapshot, current.injected.destinationTemporary).value = "forged";
      },
    },
    {
      id: "PR194-handoff-next-instruction",
      category: "handoff disagreement",
      mutate: (snapshot) => {
        snapshot.nextInstruction = 0;
      },
    },
    {
      id: "PR194-handoff-active-foreground",
      category: "incompatible lifecycle",
      mutate: (snapshot, current) => {
        // The delay is a real runtime-produced pending action.  Pairing it
        // with an older active handoff deliberately combines incompatible
        // lifecycle states, including their distinct continuation positions.
        const pendingDelay = current.runtimeProducedLaterPendingDelay;
        snapshot.foregroundAction = structuredClone(pendingDelay.foregroundAction);
        snapshot.status = pendingDelay.status;
        snapshot.nextInstruction = pendingDelay.nextInstruction;
        snapshot.nextActionId = pendingDelay.nextActionId;
        snapshot.nextEventSequence = pendingDelay.nextEventSequence;
        snapshot.currentSessionTimeMs = pendingDelay.currentSessionTimeMs;
        snapshot.observedSessionTimeMs = pendingDelay.observedSessionTimeMs;
      },
    },
    {
      id: "PR194-exact-matching-handoff-settlement-counter",
      category: "counter",
      mutate: (snapshot) => {
        snapshot.nextActionId = externalRecord(
          snapshot.interactionResultHandoff,
          "handoff",
        ).actionId;
      },
    },
    {
      id: "PR194-settlement-request-nonpositive",
      category: "chronology",
      mutate: (snapshot) => {
        externalRecord(snapshot.lastSettlement, "settlement").requestEventSequence = 0;
      },
    },
    {
      id: "PR194-settlement-request-after-transcript",
      category: "chronology",
      mutate: (snapshot) => {
        const settlement = externalRecord(snapshot.lastSettlement, "settlement");
        settlement.requestEventSequence = settlement.transcriptEventSequence;
      },
    },
    {
      id: "PR194-settlement-transcript-after-completion",
      category: "chronology",
      mutate: (snapshot) => {
        const settlement = externalRecord(snapshot.lastSettlement, "settlement");
        settlement.transcriptEventSequence = settlement.completionEventSequence;
      },
    },
    {
      id: "PR194-settlement-completion-after-next-event",
      category: "chronology",
      mutate: (snapshot) => {
        const settlement = externalRecord(snapshot.lastSettlement, "settlement");
        snapshot.nextEventSequence = settlement.completionEventSequence;
      },
    },
  ];
  const equalIdDelayControl = structuredClone(fixture.runtimeProducedLaterSettledDelay);
  const exactHandoff = committed.interactionResultHandoff;
  assert.ok(exactHandoff !== null);
  assert.ok(equalIdDelayControl.lastSettlement !== null);
  equalIdDelayControl.lastSettlement = {
    ...equalIdDelayControl.lastSettlement,
    actionId: exactHandoff.actionId,
  };
  equalIdDelayControl.nextActionId = Math.max(
    equalIdDelayControl.nextActionId,
    exactHandoff.actionId + 1,
  );
  assert.equal(
    validateRuntimeSnapshot(equalIdDelayControl, injected.plan).valid,
    true,
    "PR194-settlement-equal-wrong-action-kind control: delay settlement alone",
  );
  for (const row of rows) {
    const invalid = externalRecord(structuredClone(committed), row.id);
    row.mutate(invalid, fixture);
    assertRejectedSettlementHandoffSnapshot(
      injected.plan,
      committed,
      invalid,
      `${row.category}: ${row.id}`,
    );
  }

  const retainedSettlementCounter = externalRecord(
    structuredClone(validatedCompositeWithNewerSettlement),
    "retained newer settlement counter",
  );
  retainedSettlementCounter.nextActionId = fixture.laterDelaySettlement.actionId;
  assertRejectedSettlementHandoffSnapshot(
    injected.plan,
    validatedCompositeWithNewerSettlement,
    retainedSettlementCounter,
    "counter: PR194-retained-newer-settlement-counter",
  );

  // With a newer retained settlement, the handoff alone still authorizes the destination value.
  const newerSettlementForgedDestination = externalRecord(
    structuredClone(validatedCompositeWithNewerSettlement),
    "newer settlement forged destination",
  );
  externalTemporary(newerSettlementForgedDestination, injected.destinationTemporary).value =
    "forged";
  assertRejectedSettlementHandoffSnapshot(
    injected.plan,
    validatedCompositeWithNewerSettlement,
    newerSettlementForgedDestination,
    "destination: PR194-newer-settlement-handoff-destination-forged",
  );
});

interface TextInteractionCompletionRequest {
  readonly actionId: number;
  readonly actionKind: "interaction";
  readonly interactionKind: "text";
  readonly payload: { readonly kind: "submittedText"; readonly submittedText: string };
}

interface ReplayRow {
  readonly id: string;
  readonly plan: InstructionPlan;
  readonly snapshot: RuntimeSnapshot;
  readonly request:
    | TextInteractionCompletionRequest
    | {
        readonly actionId: number;
        readonly actionKind: "delay";
        readonly payload: { readonly kind: "time"; readonly currentSessionTimeMs: number };
      };
  readonly expected:
    | { readonly kind: "alreadySettled" }
    | { readonly kind: "staleAction"; readonly actionId: number }
    | { readonly kind: "unknownAction"; readonly actionId: number };
}

function textCompletionRequest(snapshot: RuntimeSnapshot): TextInteractionCompletionRequest {
  const action = snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction" && action.interactionKind === "text");
  return {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "committed" },
  };
}

function assertReplayRow(row: ReplayRow): void {
  const planBefore = structuredClone(row.plan);
  const snapshotBefore = structuredClone(row.snapshot);
  const replay = completeAction(row.plan, row.snapshot, row.request);
  assert.equal(replay.outcome.kind, row.expected.kind, row.id);
  assert.deepEqual(replay.events, [], `${row.id}: no duplicate events`);
  assert.deepEqual(replay.snapshot, snapshotBefore, `${row.id}: returned state`);
  assert.deepEqual(row.plan, planBefore, `${row.id}: plan input`);
  assert.deepEqual(row.snapshot, snapshotBefore, `${row.id}: snapshot input`);
  switch (row.expected.kind) {
    case "alreadySettled":
      assert.equal(replay.outcome.kind, "alreadySettled", row.id);
      assert.deepEqual(
        replay.outcome.settlement,
        row.snapshot.lastSettlement,
        `${row.id}: settlement`,
      );
      break;
    case "staleAction":
      assert.equal(replay.outcome.kind, "staleAction", row.id);
      assert.equal(replay.outcome.actionId, row.expected.actionId, `${row.id}: stale action ID`);
      break;
    case "unknownAction":
      assert.equal(replay.outcome.kind, "unknownAction", row.id);
      assert.equal(replay.outcome.actionId, row.expected.actionId, `${row.id}: unknown action ID`);
      break;
  }
}

test("PR194 matrix: bounded replay classifies an older interaction as stale after a newer settlement", () => {
  const settlementFixture = settledHandoffFixture();
  const composite = settlementFixture.validatedCompositeWithNewerSettlement;
  const oldHandoff = composite.interactionResultHandoff;
  assert.ok(oldHandoff !== null);
  const oldRequest: TextInteractionCompletionRequest = {
    actionId: oldHandoff.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "committed" },
  };
  const compositeConsumed = executeInstruction(settlementFixture.injected.plan, composite).snapshot;
  const compositeCleaned = executeInstruction(
    settlementFixture.injected.plan,
    compositeConsumed,
  ).snapshot;
  const compositeAfterRun = run(settlementFixture.injected.plan, compositeCleaned).snapshot;
  const newerDelayRequest = {
    actionId: settlementFixture.laterDelaySettlement.actionId,
    actionKind: "delay" as const,
    payload: {
      kind: "time" as const,
      currentSessionTimeMs: settlementFixture.laterDelaySettlement.completedAtMs,
    },
  };
  const staleRows: readonly ReplayRow[] = [
    {
      id: "PR194-replay-old-interaction-newer-composite",
      plan: settlementFixture.injected.plan,
      snapshot: composite,
      request: oldRequest,
      expected: { kind: "staleAction", actionId: oldRequest.actionId },
    },
    {
      id: "PR194-replay-old-interaction-newer-composite-roundtrip",
      plan: settlementFixture.injected.plan,
      snapshot: checkpointJsonRoundTrip(settlementFixture.injected.plan, composite).snapshot,
      request: oldRequest,
      expected: { kind: "staleAction", actionId: oldRequest.actionId },
    },
    {
      id: "PR194-replay-old-interaction-after-consume",
      plan: settlementFixture.injected.plan,
      snapshot: compositeConsumed,
      request: oldRequest,
      expected: { kind: "staleAction", actionId: oldRequest.actionId },
    },
    {
      id: "PR194-replay-old-interaction-after-cleanup",
      plan: settlementFixture.injected.plan,
      snapshot: compositeCleaned,
      request: oldRequest,
      expected: { kind: "staleAction", actionId: oldRequest.actionId },
    },
    {
      id: "PR194-replay-old-interaction-cleanup-roundtrip",
      plan: settlementFixture.injected.plan,
      snapshot: checkpointJsonRoundTrip(settlementFixture.injected.plan, compositeCleaned).snapshot,
      request: oldRequest,
      expected: { kind: "staleAction", actionId: oldRequest.actionId },
    },
    {
      id: "PR194-replay-old-interaction-after-run",
      plan: settlementFixture.injected.plan,
      snapshot: compositeAfterRun,
      request: oldRequest,
      expected: { kind: "staleAction", actionId: oldRequest.actionId },
    },
    {
      id: "PR194-replay-current-newer-delay",
      plan: settlementFixture.injected.plan,
      snapshot: composite,
      request: newerDelayRequest,
      expected: { kind: "alreadySettled" },
    },
  ];
  for (const row of staleRows) assertReplayRow(row);
});

interface FailedContinuationRow {
  readonly id: string;
  readonly expectedCode: string;
  readonly makePlan: (injected: InjectedInteractionPlan) => InstructionPlan;
  readonly assertUntouchedTarget?: (
    snapshot: RuntimeSnapshot,
    injected: InjectedInteractionPlan,
  ) => void;
}

test("PR194 matrix: failed canonical continuations retain the handoff atomically", () => {
  const rows: readonly FailedContinuationRow[] = [
    {
      id: "PR194-failed-continuation-before-evaluation",
      expectedCode: "TSR023",
      makePlan: (injected) =>
        replaceHandoffInstruction(injected, {
          kind: "say",
          presentation: null,
          speaker: "missing",
          value: temporaryExpression(injected.destinationTemporary, injected.plan.sourceSpan),
          skipPolicy: null,
          pacing: "smart",
          span: injected.plan.instructions[injected.handoffInstruction]!.span,
        }),
      assertUntouchedTarget: (snapshot) => assert.equal(snapshot.speakers.length, 0),
    },
    {
      id: "PR194-failed-continuation-during-evaluation",
      expectedCode: "TSR026",
      makePlan: (injected) =>
        replaceHandoffInstruction(injected, {
          kind: "evaluate",
          expression: binaryExpression(
            "and",
            temporaryExpression(injected.destinationTemporary, injected.plan.sourceSpan),
            literalExpression(true, injected.plan.sourceSpan),
            injected.plan.sourceSpan,
          ),
          span: injected.plan.instructions[injected.handoffInstruction]!.span,
        }),
    },
    {
      id: "PR194-failed-continuation-before-target-mutation",
      expectedCode: "TSR026",
      makePlan: (injected) =>
        replaceHandoffInstruction(
          injected,
          {
            kind: "storeTemporary",
            temporaryId: injected.destinationTemporary + 1,
            value: temporaryExpression(injected.destinationTemporary, injected.plan.sourceSpan),
            expectBoolean: true,
            span: injected.plan.instructions[injected.handoffInstruction]!.span,
          },
          injected.plan.temporaryCount + 1,
        ),
      assertUntouchedTarget: (snapshot, injected) =>
        assert.equal(
          snapshot.temporaries.some(
            (temporary) => temporary.id === injected.destinationTemporary + 1,
          ),
          false,
        ),
    },
  ];
  for (const row of rows) {
    const injected = injectTextInteraction('let answer = "__interaction_result__"\nexit');
    const plan = row.makePlan(injected);
    assert.equal(validateInstructionPlan(plan).valid, true, row.id);
    const pending = waiting(plan);
    const request = textCompletionRequest(pending.snapshot);
    const completed = completeAction(plan, pending.snapshot, request);
    assert.equal(completed.outcome.kind, "completed", row.id);
    const committed = checkpointJsonRoundTrip(plan, completed.snapshot).snapshot;
    const planBefore = structuredClone(plan);
    const committedBefore = structuredClone(committed);
    const failed = executeInstruction(plan, committed);
    assert.deepEqual(plan, planBefore, `${row.id}: plan input`);
    assert.deepEqual(committed, committedBefore, `${row.id}: snapshot input`);
    assert.equal(failed.snapshot.status, "failed", row.id);
    assert.equal(failed.snapshot.nextInstruction, committed.nextInstruction, row.id);
    assert.deepEqual(
      failed.snapshot.interactionResultHandoff,
      committed.interactionResultHandoff,
      row.id,
    );
    assert.equal(
      temporaryValue(failed.snapshot, injected.destinationTemporary),
      "committed",
      row.id,
    );
    assert.deepEqual(failed.snapshot.lastSettlement, committed.lastSettlement, row.id);
    assert.equal(failed.events.length, 1, row.id);
    const failure = failed.events[0];
    assert.ok(failure !== undefined && failure.kind === "runtimeFailure", row.id);
    assert.equal(failure.code, row.expectedCode, row.id);
    row.assertUntouchedTarget?.(failed.snapshot, injected);
    assert.equal(validateRuntimeSnapshot(failed.snapshot, plan).valid, true, row.id);
    assert.deepEqual(
      checkpointJsonRoundTrip(plan, failed.snapshot).snapshot,
      failed.snapshot,
      row.id,
    );
    assertReplayRow({
      id: `${row.id}-replay`,
      plan,
      snapshot: failed.snapshot,
      request,
      expected: { kind: "alreadySettled" },
    });
    const failedPlanBefore = structuredClone(plan);
    const failedBefore = structuredClone(failed.snapshot);
    const repeatedExecute = executeInstruction(plan, failed.snapshot);
    assert.deepEqual(repeatedExecute.snapshot, failedBefore, `${row.id}: execute snapshot noop`);
    assert.deepEqual(repeatedExecute.events, [], `${row.id}: execute events noop`);
    assert.equal(repeatedExecute.instructionsExecuted, 0, `${row.id}: execute instruction noop`);
    assert.deepEqual(plan, failedPlanBefore, `${row.id}: execute plan input`);
    assert.deepEqual(failed.snapshot, failedBefore, `${row.id}: execute snapshot input`);
    const repeatedRun = run(plan, failed.snapshot);
    assert.deepEqual(repeatedRun.snapshot, failedBefore, `${row.id}: run snapshot noop`);
    assert.deepEqual(repeatedRun.events, [], `${row.id}: run events noop`);
    assert.equal(repeatedRun.instructionsExecuted, 0, `${row.id}: run instruction noop`);
    assert.deepEqual(plan, failedPlanBefore, `${row.id}: run plan input`);
    assert.deepEqual(failed.snapshot, failedBefore, `${row.id}: run snapshot input`);
  }
});

interface TypedResultBoundaryRow {
  readonly id: string;
  readonly interactionKind: "text" | "number" | "choice";
  readonly ui: InteractionUiPayload;
  readonly payload: Readonly<Record<string, string | number>>;
  readonly result: string | number;
  readonly transcript: string;
}

function completeTypedInteraction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  row: TypedResultBoundaryRow,
) {
  const action = snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction", `${row.id}: pending interaction`);
  return completeAction(plan, snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: row.interactionKind,
    payload: row.payload,
  });
}

test("PR194 matrix: checkpoint boundaries preserve typed interaction results", () => {
  const rows: readonly TypedResultBoundaryRow[] = [
    {
      id: "PR194-resume-domain-text",
      interactionKind: "text",
      ui: { kind: "text", hint: null, accessibleName: defaults.text },
      payload: { kind: "submittedText", submittedText: "typed text" },
      result: "typed text",
      transcript: "typed text",
    },
    {
      id: "PR194-resume-domain-number",
      interactionKind: "number",
      ui: { kind: "number", hint: null, accessibleName: defaults.number },
      payload: { kind: "submittedText", submittedText: " 12.5 " },
      result: 12.5,
      transcript: "12.5",
    },
    {
      id: "PR194-resume-domain-choice-visible-text",
      interactionKind: "choice",
      ui: {
        kind: "choice",
        labelType: "none",
        options: [{ text: "Visible", label: null }],
        accessibleName: defaults.choice,
      },
      payload: { kind: "selectedText", selectedText: "Visible" },
      result: "Visible",
      transcript: "Visible",
    },
    {
      id: "PR194-resume-domain-choice-identifier-label",
      interactionKind: "choice",
      ui: {
        kind: "choice",
        labelType: "identifier",
        options: [{ text: "Visible", label: "saved" }],
        accessibleName: defaults.choice,
      },
      payload: { kind: "selectedLabel", selectedLabel: "saved" },
      result: "saved",
      transcript: "Visible",
    },
    {
      id: "PR194-resume-domain-choice-numeric-label",
      interactionKind: "choice",
      ui: {
        kind: "choice",
        labelType: "number",
        options: [{ text: "Visible", label: 7 }],
        accessibleName: defaults.choice,
      },
      payload: { kind: "selectedLabel", selectedLabel: 7 },
      result: 7,
      transcript: "Visible",
    },
  ];

  for (const row of rows) {
    const injected = injectInteraction(
      'let answer = "__interaction_result__"\nsay answer\nexit',
      row.interactionKind,
      row.ui,
    );
    const pending = waiting(injected.plan).snapshot;
    assert.equal(pending.interactionResultHandoff, null, `${row.id}: pending handoff`);
    assert.equal(
      pending.temporaries.some((temporary) => temporary.id === injected.destinationTemporary),
      false,
      `${row.id}: pending destination`,
    );
    const pendingCompletion = assertInteractionResumeEquivalent(
      injected.plan,
      pending,
      (plan, snapshot) => completeTypedInteraction(plan, snapshot, row),
      `${row.id}: pending`,
    );
    assert.equal(pendingCompletion.uninterrupted.outcome.kind, "completed", row.id);
    const transcript = pendingCompletion.uninterrupted.events[0];
    assert.ok(transcript !== undefined && transcript.kind === "playerTranscript", row.id);
    assert.equal(transcript.text, row.transcript, `${row.id}: transcript`);
    const committed = pendingCompletion.uninterrupted.snapshot;
    assert.equal(
      temporaryValue(committed, injected.destinationTemporary),
      row.result,
      `${row.id}: committed result`,
    );
    assert.notEqual(committed.interactionResultHandoff, null, `${row.id}: committed handoff`);
    assert.notEqual(committed.lastSettlement, null, `${row.id}: committed settlement`);
    const transferred = assertInteractionResumeEquivalent(
      injected.plan,
      committed,
      executeInstruction,
      `${row.id}: committed`,
    ).uninterrupted.snapshot;
    assert.equal(transferred.interactionResultHandoff, null, `${row.id}: transferred handoff`);
    assert.equal(bindingValue(transferred, "answer"), row.result, `${row.id}: transferred value`);
    assert.equal(
      temporaryValue(transferred, injected.destinationTemporary),
      row.result,
      `${row.id}: retained interaction temporary`,
    );
    const cleaned = assertInteractionResumeEquivalent(
      injected.plan,
      transferred,
      executeInstruction,
      `${row.id}: transferred`,
    ).uninterrupted.snapshot;
    assert.equal(cleaned.interactionResultHandoff, null, `${row.id}: cleaned handoff`);
    assert.equal(
      cleaned.temporaries.some((temporary) => temporary.id === injected.destinationTemporary),
      false,
      `${row.id}: cleaned destination`,
    );
    assert.equal(bindingValue(cleaned, "answer"), row.result, `${row.id}: retained ordinary value`);
    const final = assertInteractionResumeEquivalent(
      injected.plan,
      cleaned,
      run,
      `${row.id}: cleaned`,
    );
    assert.deepEqual(
      final.uninterrupted.events.filter((event) => event.kind === "say").map((event) => event.text),
      [String(row.result)],
      `${row.id}: final say`,
    );
    assert.equal(final.uninterrupted.snapshot.status, "halted", `${row.id}: final status`);

    // The same typed result also resumes through a direct function return that consumes it.
    const directReturn = injectInteraction(
      'function prompt { let ignored = "__interaction_result__"\nreturn }\nprompt()\nsay "after"\nexit',
      row.interactionKind,
      row.ui,
    );
    const directPlan = replaceHandoffInstruction(directReturn, {
      kind: "returnVoid",
      span: handoffInstructionSpan(directReturn),
    });
    assert.equal(validateInstructionPlan(directPlan).valid, true, `${row.id}: direct return plan`);
    const directCommitted = assertInteractionResumeEquivalent(
      directPlan,
      waiting(directPlan).snapshot,
      (plan, snapshot) => completeTypedInteraction(plan, snapshot, row),
      `${row.id}: direct return pending`,
    ).uninterrupted.snapshot;
    assert.equal(
      temporaryValue(directCommitted, directReturn.destinationTemporary),
      row.result,
      `${row.id}: direct return committed result`,
    );
    const directFinal = assertInteractionResumeEquivalent(
      directPlan,
      directCommitted,
      run,
      `${row.id}: direct return committed`,
    ).uninterrupted;
    assert.equal(directFinal.snapshot.status, "halted", `${row.id}: direct return status`);
    assert.deepEqual(directFinal.snapshot.callFrames, [], `${row.id}: direct return frames`);
    assert.deepEqual(directFinal.snapshot.temporaries, [], `${row.id}: direct return temporaries`);
    assert.deepEqual(
      directFinal.events.filter((event) => event.kind === "say").map((event) => event.text),
      ["after"],
      `${row.id}: direct return output`,
    );
    assert.equal(validateRuntimeSnapshot(directFinal.snapshot, directPlan).valid, true, row.id);
  }
});

test("PR194 matrix: invalid local handoff shapes reject without mutating plans", () => {
  const injected = injectTextInteraction('let answer = "__interaction_result__"\nsay answer\nexit');
  const span = injected.plan.instructions[injected.handoffInstruction]!.span;
  assert.equal(validateInstructionPlan(injected.plan).valid, true);
  // Compiler-produced instructions are valid on their own, so rows using them are invalid only
  // through their local handoff position.
  const bases = compileSource('wait 1\nsay "x", instant');
  assert.deepEqual(bases.diagnostics, []);
  const [validWait, validSay] = bases.plan!.instructions;
  assert.ok(validWait?.kind === "wait" && validSay?.kind === "say");
  const handoffPath = `$.instructions[${injected.handoffInstruction}]`;
  const clearPath = `$.instructions[${injected.clearInstruction}]`;
  const mustConsume = "Interaction result handoff must consume the destination immediately.";
  const mustClear =
    "Interaction result handoff must clear its transient destination immediately after transfer.";
  const rows: readonly {
    readonly id: string;
    readonly mutate: (plan: ExternalRecord) => void;
    readonly errors: readonly (readonly [path: string, message: string])[];
  }[] = [
    {
      id: "PR194-jump-continuation",
      mutate: (plan) => {
        externalInstructions(plan)[injected.handoffInstruction] = {
          kind: "jump",
          target: injected.clearInstruction,
          span,
        };
      },
      errors: [[handoffPath, mustConsume]],
    },
    {
      id: "PR194-second-blocking-action",
      mutate: (plan) => {
        externalInstructions(plan)[injected.handoffInstruction] = { ...validWait, span };
      },
      errors: [[handoffPath, mustConsume]],
    },
    {
      id: "PR194-missing-clear",
      mutate: (plan) => {
        externalInstructions(plan)[injected.clearInstruction] = { ...validSay, span };
      },
      errors: [[clearPath, mustClear]],
    },
    {
      id: "PR194-wrong-clear",
      mutate: (plan) => {
        plan.temporaryCount = injected.plan.temporaryCount + 1;
        externalRecord(externalInstructions(plan)[injected.clearInstruction], "clear").temporaryId =
          injected.destinationTemporary + 1;
      },
      errors: [[clearPath, mustClear]],
    },
    {
      id: "PR194-second-producer",
      mutate: (plan) => {
        externalInstructions(plan)[injected.clearInstruction] = {
          kind: "storeTemporary",
          temporaryId: injected.destinationTemporary,
          value: { kind: "literal", value: "x", span },
          expectBoolean: false,
          span,
        };
      },
      // Replacing the cleanup with a producer breaks both owner-only production and cleanup.
      errors: [
        [
          `$.instructions[${injected.interactionInstruction}].destinationTemporary`,
          "Canonical interaction result destinations must be produced only by their owning interaction.",
        ],
        [clearPath, mustClear],
      ],
    },
  ];
  for (const row of rows) {
    const plan = externalRecord(structuredClone(injected.plan), row.id);
    row.mutate(plan);
    const beforeValidation = structuredClone(plan);
    const validation = validateInstructionPlan(plan);
    assert.deepEqual(
      validation.errors.map((error) => [error.code, error.path, error.message]),
      row.errors.map(([path, message]) => ["TSC002", path, message]),
      row.id,
    );
    assert.deepEqual(plan, beforeValidation, row.id);
  }

  const assertExactLocalHandoffError = (plan: InstructionPlan, id: string, path: string): void => {
    const before = structuredClone(plan);
    const validation = validateInstructionPlan(plan);
    assert.equal(validation.valid, false, id);
    assert.deepEqual(
      validation.errors.map((error) => [error.code, error.path]),
      [["TSC002", path]],
      id,
    );
    assert.deepEqual(plan, before, `${id}: plan input`);
  };

  const callInjected = injectTextInteraction(
    [
      'function helper { return "helper" }',
      "let ignored = helper()",
      'let answer = "__interaction_result__"',
      "say answer",
      "exit",
    ].join("\n"),
  );
  const compilerCall = callInjected.plan.instructions.find(
    (instruction) => instruction.kind === "callFunction",
  );
  assert.ok(compilerCall !== undefined && compilerCall.kind === "callFunction");
  const callDestinationTemporary = callInjected.plan.temporaryCount + 1;
  const callAtHandoff = replaceHandoffInstruction(
    callInjected,
    {
      ...structuredClone(compilerCall),
      destinationTemporary: callDestinationTemporary,
      returnInstruction: callInjected.clearInstruction,
      span: callInjected.plan.instructions[callInjected.handoffInstruction]!.span,
    },
    callDestinationTemporary,
  );
  assertExactLocalHandoffError(
    callAtHandoff,
    "PR194-call-function-as-handoff",
    `$.instructions[${callInjected.handoffInstruction}]`,
  );

  const targetInjected = injectTextInteraction(
    [
      'if true { say "before" } else { say "other" }',
      'let answer = "__interaction_result__"',
      "say answer",
      "exit",
    ].join("\n"),
  );
  assert.equal(
    validateInstructionPlan(targetInjected.plan).valid,
    true,
    JSON.stringify(validateInstructionPlan(targetInjected.plan).errors),
  );
  const jumpIndex = targetInjected.plan.instructions.findIndex(
    (instruction) => instruction.kind === "jump",
  );
  assert.notEqual(jumpIndex, -1);
  const jump = targetInjected.plan.instructions[jumpIndex];
  assert.ok(jump !== undefined && jump.kind === "jump");
  const targetedRows = [
    {
      id: "PR194-explicit-target-handoff-entry",
      target: targetInjected.handoffInstruction,
      path: `$.instructions[${targetInjected.handoffInstruction}]`,
    },
    {
      id: "PR194-explicit-target-handoff-cleanup",
      target: targetInjected.clearInstruction,
      path: `$.instructions[${targetInjected.clearInstruction}]`,
    },
  ] as const;
  for (const row of targetedRows) {
    const targeted: InstructionPlan = {
      ...structuredClone(targetInjected.plan),
      instructions: targetInjected.plan.instructions.map((instruction, index) =>
        index === jumpIndex && instruction.kind === "jump"
          ? { ...instruction, target: row.target }
          : instruction,
      ),
    };
    assertExactLocalHandoffError(targeted, row.id, row.path);
  }
});

test("PR194 matrix: rejected completion and snapshot operations preserve canonical state", () => {
  const injected = injectTextInteraction('let answer = "__interaction_result__"\nsay answer\nexit');
  const pending = waiting(injected.plan);
  const actionId = pending.snapshot.foregroundAction!.actionId;
  const requests = [
    {
      id: "PR194-invalid-payload",
      request: {
        actionId,
        actionKind: "interaction" as const,
        interactionKind: "text" as const,
        payload: { kind: "submittedText", submittedText: " \t" },
      },
      expectedOutcome: "invalidPayload",
    },
    {
      id: "PR194-wrong-action-kind",
      request: {
        actionId,
        actionKind: "delay" as const,
        payload: { kind: "time", currentSessionTimeMs: 0 },
      },
      expectedOutcome: "wrongActionKind",
    },
  ];
  for (const row of requests) {
    const before = structuredClone(pending.snapshot);
    const result = completeAction(injected.plan, pending.snapshot, row.request);
    assert.equal(result.outcome.kind, row.expectedOutcome, row.id);
    assert.deepEqual(result.snapshot, before, row.id);
    assert.deepEqual(result.events, [], row.id);
  }
  const completed = completeAction(injected.plan, pending.snapshot, {
    actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "committed" },
  });
  const malformedOperationRows: readonly {
    readonly id: string;
    readonly mutate: (snapshot: ExternalRecord) => void;
  }[] = [
    {
      id: "PR194-rejected-operation-handoff-null",
      mutate: (snapshot) => {
        snapshot.interactionResultHandoff = null;
      },
    },
    {
      id: "PR194-rejected-operation-handoff-owner",
      mutate: (snapshot) => {
        externalRecord(snapshot.interactionResultHandoff, "handoff").ownerCallFrameId = 99;
        snapshot.nextCallFrameId = 100;
      },
    },
    {
      id: "PR194-rejected-operation-handoff-extra-field",
      mutate: (snapshot) => {
        externalRecord(snapshot.interactionResultHandoff, "handoff").extra = true;
      },
    },
  ];
  for (const row of malformedOperationRows) {
    const snapshot = externalRecord(structuredClone(completed.snapshot), "malformed snapshot");
    row.mutate(snapshot);
    const before = structuredClone(snapshot);
    const planBefore = structuredClone(injected.plan);
    // Deliberately malformed external snapshot data must be rejected before completion mutates it.
    assert.throws(
      () => {
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture passes the malformed external record to completion to verify atomic rejection.
        return completeAction(injected.plan, snapshot as unknown as RuntimeSnapshot, {
          actionId,
          actionKind: "interaction",
          interactionKind: "text",
          payload: { kind: "submittedText", submittedText: "committed" },
        });
      },
      (error: unknown) => {
        assert.ok(error instanceof RuntimeDataError, row.id);
        assert.equal(error.code, "TSR101", row.id);
        return true;
      },
      row.id,
    );
    assert.deepEqual(injected.plan, planBefore, row.id);
    assert.deepEqual(snapshot, before, row.id);
  }
});

interface OwnershipResumeRow {
  readonly id: string;
  readonly source: string;
  readonly owner: "root" | "active-frame";
  readonly makePlan: (injected: InjectedInteractionPlan) => InstructionPlan;
  readonly assertPending: (snapshot: RuntimeSnapshot) => void;
  readonly assertFinal: (snapshot: RuntimeSnapshot, events: readonly InterpreterEvent[]) => void;
}

test("PR194 matrix: ownership contexts resume from pending and committed boundaries", () => {
  const rows: readonly OwnershipResumeRow[] = [
    {
      id: "PR194-resume-context-function-body",
      source:
        'function prompt { let answer = "__interaction_result__"\nsay answer\nreturn }\nprompt()\nexit',
      owner: "active-frame",
      makePlan: (injected) => injected.plan,
      assertPending: (snapshot) => assert.equal(snapshot.callFrames.length, 1),
      assertFinal: (snapshot, events) => {
        assert.equal(snapshot.callFrames.length, 0);
        assert.ok(events.some((event) => event.kind === "say" && event.text === "committed"));
      },
    },
    {
      id: "PR194-resume-context-function-argument",
      source: 'function send(value) { say value\nreturn }\nsend("__interaction_result__")\nexit',
      owner: "root",
      makePlan: (injected) => injected.plan,
      assertPending: (snapshot) => assert.equal(snapshot.callFrames.length, 0),
      assertFinal: (_snapshot, events) =>
        assert.ok(events.some((event) => event.kind === "say" && event.text === "committed")),
    },
    {
      id: "PR194-resume-context-nested-return-value",
      source:
        'function inner { return "__interaction_result__" }\nfunction outer { let answer = inner()\nsay answer\nreturn }\nouter()\nexit',
      owner: "active-frame",
      makePlan: (injected) => injected.plan,
      assertPending: (snapshot) => assert.equal(snapshot.callFrames.length, 2),
      assertFinal: (snapshot, events) => {
        assert.equal(snapshot.callFrames.length, 0);
        assert.ok(events.some((event) => event.kind === "say" && event.text === "committed"));
      },
    },
    {
      id: "PR194-resume-context-suspended-caller",
      source:
        'function prompt { return "__interaction_result__" }\nfunction send(before, answer) { say \"${before}:${answer}\"\nreturn }\nsend("first", prompt())\nexit',
      owner: "active-frame",
      makePlan: (injected) => injected.plan,
      assertPending: (snapshot) => {
        assert.equal(snapshot.callFrames.length, 1);
        const caller = snapshot.callFrames[0];
        const action = snapshot.foregroundAction;
        assert.ok(caller !== undefined && action?.kind === "interaction");
        assert.ok(caller.callerTemporaries.some((temporary) => temporary.value === "first"));
        assert.equal(action.ownerCallFrameId, caller.id);
        // The suspended caller's return destination stays distinct from the interaction destination.
        assert.equal(typeof caller.destinationTemporary, "number");
        assert.notEqual(caller.destinationTemporary, action.destinationTemporary);
      },
      assertFinal: (snapshot, events) => {
        assert.equal(snapshot.callFrames.length, 0);
        assert.ok(events.some((event) => event.kind === "say" && event.text === "first:committed"));
      },
    },
  ];

  for (const row of rows) {
    const injected = injectTextInteraction(row.source);
    const plan = row.makePlan(injected);
    assert.equal(validateInstructionPlan(plan).valid, true, row.id);
    const pending = waiting(plan).snapshot;
    const action = pending.foregroundAction;
    assert.ok(action !== null && action.kind === "interaction", row.id);
    assert.equal(action.ownerCallFrameId === null, row.owner === "root", `${row.id}: action owner`);
    row.assertPending(pending);
    const completed = assertInteractionResumeEquivalent(
      plan,
      pending,
      (currentPlan, snapshot) =>
        completeAction(currentPlan, snapshot, textCompletionRequest(snapshot)),
      `${row.id}: pending`,
    ).uninterrupted.snapshot;
    assert.equal(
      completed.interactionResultHandoff?.ownerCallFrameId,
      action.ownerCallFrameId,
      `${row.id}: handoff owner`,
    );
    const final = assertInteractionResumeEquivalent(
      plan,
      completed,
      run,
      `${row.id}: committed`,
    ).uninterrupted;
    assert.equal(final.snapshot.interactionResultHandoff, null, `${row.id}: final handoff`);
    assert.equal(final.snapshot.status, "halted", `${row.id}: final status`);
    row.assertFinal(final.snapshot, final.events);
  }
});

test("PR194 matrix: later settlement preserves ordinary result and makes old replay stale", () => {
  const injected = injectTextInteraction(
    'let answer = "__interaction_result__"\nwait 1 ms\nsay answer\nexit',
  );
  const pending = waiting(injected.plan);
  const request = textCompletionRequest(pending.snapshot);
  const completed = completeAction(injected.plan, pending.snapshot, request);
  assert.equal(completed.outcome.kind, "completed");

  const transferred = executeInstruction(injected.plan, completed.snapshot);
  assert.equal(transferred.snapshot.interactionResultHandoff, null);
  assert.equal(bindingValue(transferred.snapshot, "answer"), "committed");
  const cleaned = executeInstruction(injected.plan, transferred.snapshot);
  assert.equal(
    cleaned.snapshot.temporaries.some(
      (temporary) => temporary.id === injected.destinationTemporary,
    ),
    false,
  );
  assert.equal(bindingValue(cleaned.snapshot, "answer"), "committed");

  const delay = run(injected.plan, cleaned.snapshot);
  assert.equal(delay.snapshot.foregroundAction?.kind, "delay");
  const interactionSettlement = completed.snapshot.lastSettlement;
  assert.ok(interactionSettlement !== null && interactionSettlement.actionKind === "interaction");
  const newer = observeTime(injected.plan, delay.snapshot, 1);
  assert.equal(newer.snapshot.lastSettlement?.actionKind, "delay");
  assert.ok(
    newer.snapshot.lastSettlement !== null &&
      newer.snapshot.lastSettlement.actionId > interactionSettlement.actionId,
  );
  assert.equal(bindingValue(newer.snapshot, "answer"), "committed");

  const restored = checkpointJsonRoundTrip(injected.plan, newer.snapshot);
  assert.equal(bindingValue(restored.snapshot, "answer"), "committed");
  assert.deepEqual(restored.snapshot.lastSettlement, newer.snapshot.lastSettlement);
  const final = run(restored.plan, restored.snapshot);
  assert.ok(final.events.some((event) => event.kind === "say" && event.text === "committed"));
  assert.equal(bindingValue(final.snapshot, "answer"), "committed");

  const planBeforeReplay = structuredClone(injected.plan);
  const snapshotBeforeReplay = structuredClone(final.snapshot);
  const replay = completeAction(injected.plan, final.snapshot, request);
  assert.equal(replay.outcome.kind, "staleAction", "PR194-newer-settlement-replay");
  if (replay.outcome.kind === "staleAction") {
    assert.equal(replay.outcome.actionId, request.actionId);
  }
  assert.deepEqual(replay.events, []);
  assert.deepEqual(replay.snapshot, snapshotBeforeReplay);
  assert.deepEqual(injected.plan, planBeforeReplay);
  assert.deepEqual(final.snapshot, snapshotBeforeReplay);
});
