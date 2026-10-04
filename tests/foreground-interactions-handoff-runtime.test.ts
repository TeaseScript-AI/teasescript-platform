import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type {
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
import { executeInstruction, run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import type { RuntimeDelayActionSettlementSnapshot } from "../src/runtime/actions/model.js";
import { type RuntimeSnapshot, validateRuntimeSnapshot } from "../src/runtime/state.js";
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
      : interactionKind === "number"
        ? "number"
        : interactionKind === "choice"
          ? "choice"
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

test("a transferred interaction result is ordinary state that later writes may change", () => {
  const plan = compiledTextInteraction(
    'let answer = askText\nanswer = "changed"\nwait 1 ms\nsay answer\nexit',
  ).plan;
  const pending = waiting(plan);
  const completed = completeAction(plan, pending.snapshot, textCompletionRequest(pending.snapshot));
  assert.equal(completed.outcome.kind, "completed");

  // At the wait the interaction settlement is still the retained one, but the binding already
  // holds an ordinary reassignment that carries no interaction provenance.
  const delay = run(plan, completed.snapshot);
  assert.equal(delay.snapshot.foregroundAction?.kind, "delay");
  assert.equal(delay.snapshot.interactionResultHandoff, null);
  assert.equal(delay.snapshot.lastSettlement?.actionKind, "interaction");
  assert.equal(bindingValue(delay.snapshot, "answer"), "changed");
  assert.equal(validateRuntimeSnapshot(delay.snapshot, plan).valid, true);
  const restored = checkpointJsonRoundTrip(plan, delay.snapshot);
  assert.deepEqual(restored.snapshot, delay.snapshot);

  const settled = observeTime(restored.plan, restored.snapshot, 1);
  const final = run(restored.plan, settled.snapshot);
  assert.equal(final.snapshot.status, "halted");
  assert.deepEqual(
    final.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["changed"],
  );
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
    interactionKind === "number" ? "number" : interactionKind === "choice" ? "choice" : "string";
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

/** Locates the compiler's canonical `interaction -> storeTemporary -> clearTemporary` handoff in real source. */
function compiledTextInteraction(source: string): InjectedInteractionPlan {
  const compiled = compileSource(source);
  assert.deepEqual(compiled.diagnostics, [], source);
  assert.notEqual(compiled.plan, null, source);
  const plan = compiled.plan!;
  const interactionInstruction = plan.instructions.findIndex(
    (instruction) => instruction.kind === "interaction",
  );
  const interaction = plan.instructions[interactionInstruction];
  assert.ok(
    interaction?.kind === "interaction" && interaction.destinationTemporary !== null,
    source,
  );
  return {
    plan,
    destinationTemporary: interaction.destinationTemporary,
    interactionInstruction,
    handoffInstruction: interactionInstruction + 1,
    clearInstruction: interactionInstruction + 2,
  };
}

interface CanonicalHandoffRow {
  readonly id: string;
  readonly kind: "storeTemporary" | "clearTemporary" | "exit" | "returnVoid" | "returnValue";
  readonly build: () => InjectedInteractionPlan;
  /** Direct consumers remove the destination themselves; a transfer leaves it to the cleanup. */
  readonly needsCleanup: boolean;
  /** Bounded replay is checked at every boundary of this row only. */
  readonly replay?: true;
  readonly assertResult?: (
    snapshot: RuntimeSnapshot,
    events: readonly InterpreterEvent[],
    handoff: InjectedInteractionPlan,
  ) => void;
  readonly assertFinal?: (snapshot: RuntimeSnapshot, events: readonly InterpreterEvent[]) => void;
}

function withHandoffInstruction(
  injected: InjectedInteractionPlan,
  instruction: Instruction,
): InjectedInteractionPlan {
  return { ...injected, plan: replaceHandoffInstruction(injected, instruction) };
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

test("each validator-accepted handoff category consumes the result once", () => {
  // One row per handoff category that ADR 0018 accepts (consume, transfer, discard, exit, return).
  // The transfer row also covers consume: both are one local instruction reading the destination,
  // validated by the same shape check and dropped on the same engine path. The compiler emits only
  // the transfer shape; the other rows are validator-accepted plans that no producer emits yet.
  const rows: readonly CanonicalHandoffRow[] = [
    {
      id: "PR194-category-transfer",
      kind: "storeTemporary",
      build: () => compiledTextInteraction("let answer = askText\nsay answer\nexit"),
      needsCleanup: true,
      replay: true,
      assertResult: (snapshot, _events, handoff) => {
        const transfer = handoff.plan.instructions[handoff.handoffInstruction];
        assert.ok(transfer?.kind === "storeTemporary");
        assert.equal(temporaryValue(snapshot, transfer.temporaryId), "committed");
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
      id: "PR194-category-discard",
      kind: "clearTemporary",
      build: () => {
        const injected = injectTextInteraction('let answer = "__interaction_result__"\nexit');
        return withHandoffInstruction(injected, {
          kind: "clearTemporary",
          temporaryId: injected.destinationTemporary,
          span: handoffInstructionSpan(injected),
        });
      },
      needsCleanup: false,
    },
    {
      id: "PR194-category-exit",
      kind: "exit",
      build: () => {
        const injected = injectTextInteraction('let answer = "__interaction_result__"\nexit');
        return withHandoffInstruction(injected, {
          kind: "exit",
          span: handoffInstructionSpan(injected),
        });
      },
      needsCleanup: false,
      assertResult: (snapshot, events) => {
        assert.equal(snapshot.status, "halted");
        assert.equal(events.filter((event) => event.kind === "exit").length, 1);
      },
    },
    {
      id: "PR194-category-return-void",
      kind: "returnVoid",
      build: () => {
        const injected = injectTextInteraction(
          'function prompt { let ignored = "__interaction_result__"\nreturn }\nprompt()\nsay "after"\nexit',
        );
        return withHandoffInstruction(injected, {
          kind: "returnVoid",
          span: handoffInstructionSpan(injected),
        });
      },
      needsCleanup: false,
      assertResult: (snapshot) => {
        assert.equal(snapshot.callFrames.length, 0);
      },
      assertFinal: (_snapshot, events) =>
        assert.ok(events.some((event) => event.kind === "say" && event.text === "after")),
    },
    {
      id: "PR194-category-return-value",
      kind: "returnValue",
      build: () =>
        injectTextInteraction(
          'function prompt { return "__interaction_result__" }\nlet answer = prompt()\nsay answer\nexit',
        ),
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
  ];

  for (const row of rows) {
    const handoff = row.build();
    const plan = handoff.plan;
    const planBefore = structuredClone(plan);
    const validation = validateInstructionPlan(plan);
    assert.equal(validation.valid, true, `${row.id}: ${JSON.stringify(validation.errors)}`);
    assert.deepEqual(plan, planBefore, row.id);
    assert.equal(plan.instructions[handoff.handoffInstruction]?.kind, row.kind, row.id);

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
    assert.equal(committed.nextInstruction, handoff.handoffInstruction, row.id);
    assert.equal(temporaryValue(committed, handoff.destinationTemporary), "committed", row.id);
    assert.equal(
      committed.frames[0]?.bindings.find((binding) => binding.name === "answer"),
      undefined,
      row.id,
    );
    const committedHandoff = committed.interactionResultHandoff;
    assert.ok(committedHandoff !== null, row.id);
    assert.equal(committedHandoff.destinationTemporary, handoff.destinationTemporary, row.id);
    assert.equal(committedHandoff.result, "committed", row.id);
    assert.equal(committedHandoff.ownerCallFrameId, action.ownerCallFrameId, `${row.id}: owner`);

    const continued = assertInteractionResumeEquivalent(
      plan,
      committed,
      executeInstruction,
      `${row.id}: committed`,
    ).uninterrupted;
    assert.equal(continued.snapshot.interactionResultHandoff, null, row.id);
    assert.equal(
      continued.snapshot.temporaries.some((entry) => entry.id === handoff.destinationTemporary),
      row.needsCleanup,
      `${row.id}: destination after consumption`,
    );
    row.assertResult?.(continued.snapshot, continued.events, handoff);

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
        settled.temporaries.some((entry) => entry.id === handoff.destinationTemporary),
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

    // Replay classification does not depend on the handoff category, so one row checks that bounded
    // replay reports the recorded settlement at every later boundary, before and after a JSON
    // checkpoint, and that an action that was never issued is unknown.
    if (row.replay !== true) continue;
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

function temporaryExpression(temporaryId: number, span: PlanSourceLocation): ExpressionPlan {
  return { kind: "temporary", temporaryId, span };
}

function literalExpression(
  value: string | number | boolean | null,
  span: PlanSourceLocation,
): ExpressionPlan {
  return { kind: "literal", value, span };
}

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
  /**
   * A deliberately assembled persisted-state fixture: it combines the
   * runtime-produced committed interaction with the later runtime-produced
   * delay settlement.  The validator and checkpoint boundaries accept it.
   * Public operations cannot reach it, so it serves only as validation input
   * and as the control for rows that corrupt it; it is never executed.
   */
  readonly validatedCompositeWithNewerSettlement: RuntimeSnapshot;
}

interface RejectedSettlementHandoffRow {
  readonly id: string;
  readonly category:
    | "settlement presence"
    | "malformed settlement"
    | "malformed handoff"
    | "handoff ownership"
    | "handoff disagreement"
    | "destination"
    | "incompatible lifecycle"
    | "counter"
    | "chronology";
  /**
   * The row keeps the settlement and the handoff individually valid without a plan, so planless
   * validation isolates the one check the row names from the plan-bound checks that also reject it.
   */
  readonly planless?: true;
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
    validatedCompositeWithNewerSettlement,
  };
}

function assertRejectedSettlementHandoffSnapshot(
  plan: InstructionPlan,
  validSnapshot: RuntimeSnapshot,
  invalidSnapshot: ExternalRecord,
  id: string,
  planless = false,
): void {
  const beforeValidation = structuredClone(invalidSnapshot);
  assert.equal(validateRuntimeSnapshot(invalidSnapshot, plan).valid, false, id);
  if (planless)
    assert.equal(validateRuntimeSnapshot(invalidSnapshot).valid, false, `${id}: planless`);
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

test("validation accepts matching settlement and handoff records and rejects inconsistent ones", () => {
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

  const rows: readonly RejectedSettlementHandoffRow[] = [
    {
      id: "PR194-settlement-null",
      category: "settlement presence",
      mutate: (snapshot) => {
        snapshot.lastSettlement = null;
      },
    },
    {
      id: "PR194-settlement-older-valid",
      category: "settlement presence",
      mutate: (snapshot, current) => {
        snapshot.lastSettlement = structuredClone(current.olderDelaySettlement);
      },
    },
    // Each agreement row changes one field that the retained settlement with the handoff's action
    // ID must share with the handoff, while both records stay individually valid without a plan.
    // A non-interaction settlement has no owner, destination or result fields, so those field
    // comparisons also reject the action-kind row.
    {
      id: "PR194-agreement-action-kind",
      category: "handoff disagreement",
      planless: true,
      mutate: (snapshot, current) => {
        const handoff = externalRecord(snapshot.interactionResultHandoff, "handoff");
        snapshot.lastSettlement = {
          ...structuredClone(current.olderDelaySettlement),
          actionId: handoff.actionId,
        };
      },
    },
    {
      id: "PR194-agreement-owning-instruction",
      category: "handoff disagreement",
      planless: true,
      mutate: (snapshot) => {
        externalRecord(snapshot.interactionResultHandoff, "handoff").owningInstruction = 0;
      },
    },
    {
      id: "PR194-agreement-continuation",
      category: "handoff disagreement",
      planless: true,
      mutate: (snapshot, current) => {
        const continuation = current.injected.handoffInstruction + 1;
        externalRecord(snapshot.interactionResultHandoff, "handoff").continuationInstruction =
          continuation;
        snapshot.nextInstruction = continuation;
      },
    },
    {
      id: "PR194-agreement-owner",
      category: "handoff disagreement",
      planless: true,
      mutate: (snapshot) => {
        externalRecord(snapshot.lastSettlement, "settlement").ownerCallFrameId = 1;
        snapshot.nextCallFrameId = 2;
      },
    },
    {
      id: "PR194-agreement-destination",
      category: "handoff disagreement",
      planless: true,
      mutate: (snapshot, current) => {
        externalRecord(snapshot.lastSettlement, "settlement").destinationTemporary =
          current.injected.destinationTemporary + 1;
      },
    },
    {
      id: "PR194-agreement-result",
      category: "handoff disagreement",
      planless: true,
      mutate: (snapshot) => {
        // A text settlement stays self-consistent when its result and transcript change together.
        const settlement = externalRecord(snapshot.lastSettlement, "settlement");
        settlement.result = "forged";
        settlement.transcriptText = "forged";
      },
    },
    {
      id: "PR194-settlement-equal-wrong-interaction-kind",
      category: "malformed settlement",
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
      id: "PR194-settlement-wrong-transcript",
      category: "malformed settlement",
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
      id: "PR194-handoff-owner-not-active-frame",
      category: "handoff ownership",
      planless: true,
      mutate: (snapshot) => {
        // The settlement agrees with the forged owner, so only the active-frame ownership check rejects it.
        externalRecord(snapshot.interactionResultHandoff, "handoff").ownerCallFrameId = 99;
        externalRecord(snapshot.lastSettlement, "settlement").ownerCallFrameId = 99;
        snapshot.nextCallFrameId = 100;
      },
    },
    {
      id: "PR194-handoff-destination-missing",
      category: "destination",
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
      category: "destination",
      mutate: (snapshot, current) => {
        externalTemporary(snapshot, current.injected.destinationTemporary).value = "forged";
      },
    },
    {
      id: "PR194-handoff-next-instruction",
      category: "malformed handoff",
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
  // The root-owned committed snapshot is also valid without a plan, the baseline for planless rows.
  assert.equal(validateRuntimeSnapshot(committed).valid, true);
  for (const row of rows) {
    const invalid = externalRecord(structuredClone(committed), row.id);
    row.mutate(invalid, fixture);
    assertRejectedSettlementHandoffSnapshot(
      injected.plan,
      committed,
      invalid,
      `${row.category}: ${row.id}`,
      row.planless === true,
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
  readonly request: TextInteractionCompletionRequest;
  readonly expected:
    | { readonly kind: "alreadySettled" }
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
    case "unknownAction":
      assert.equal(replay.outcome.kind, "unknownAction", row.id);
      assert.equal(replay.outcome.actionId, row.expected.actionId, `${row.id}: unknown action ID`);
      break;
  }
}

test("a failed canonical continuation retains the handoff atomically", () => {
  // The transfer expects a boolean, so it fails after reading the destination and before writing
  // its target temporary.
  const injected = injectTextInteraction('let answer = "__interaction_result__"\nexit');
  const target = injected.destinationTemporary + 1;
  const plan = replaceHandoffInstruction(
    injected,
    {
      kind: "storeTemporary",
      temporaryId: target,
      value: temporaryExpression(injected.destinationTemporary, injected.plan.sourceSpan),
      expectBoolean: true,
      span: handoffInstructionSpan(injected),
    },
    injected.plan.temporaryCount + 1,
  );
  assert.equal(validateInstructionPlan(plan).valid, true);
  const pending = waiting(plan);
  const request = textCompletionRequest(pending.snapshot);
  const completed = completeAction(plan, pending.snapshot, request);
  assert.equal(completed.outcome.kind, "completed");
  const committed = checkpointJsonRoundTrip(plan, completed.snapshot).snapshot;
  const planBefore = structuredClone(plan);
  const committedBefore = structuredClone(committed);
  const failed = executeInstruction(plan, committed);
  assert.deepEqual(plan, planBefore, "plan input");
  assert.deepEqual(committed, committedBefore, "snapshot input");
  assert.equal(failed.snapshot.status, "failed");
  assert.equal(failed.snapshot.nextInstruction, committed.nextInstruction);
  assert.deepEqual(failed.snapshot.interactionResultHandoff, committed.interactionResultHandoff);
  assert.equal(temporaryValue(failed.snapshot, injected.destinationTemporary), "committed");
  assert.deepEqual(failed.snapshot.lastSettlement, committed.lastSettlement);
  assert.equal(failed.events.length, 1);
  const failure = failed.events[0];
  assert.ok(failure !== undefined && failure.kind === "runtimeFailure");
  assert.equal(failure.code, "TSR026");
  assert.equal(
    failed.snapshot.temporaries.some((temporary) => temporary.id === target),
    false,
    "untouched target",
  );
  assert.equal(validateRuntimeSnapshot(failed.snapshot, plan).valid, true);
  assert.deepEqual(checkpointJsonRoundTrip(plan, failed.snapshot).snapshot, failed.snapshot);
  assertReplayRow({
    id: "PR194-failed-continuation-replay",
    plan,
    snapshot: failed.snapshot,
    request,
    expected: { kind: "alreadySettled" },
  });
  const failedPlanBefore = structuredClone(plan);
  const failedBefore = structuredClone(failed.snapshot);
  const repeatedExecute = executeInstruction(plan, failed.snapshot);
  assert.deepEqual(repeatedExecute.snapshot, failedBefore, "execute snapshot noop");
  assert.deepEqual(repeatedExecute.events, [], "execute events noop");
  assert.equal(repeatedExecute.instructionsExecuted, 0, "execute instruction noop");
  assert.deepEqual(plan, failedPlanBefore, "execute plan input");
  assert.deepEqual(failed.snapshot, failedBefore, "execute snapshot input");
  const repeatedRun = run(plan, failed.snapshot);
  assert.deepEqual(repeatedRun.snapshot, failedBefore, "run snapshot noop");
  assert.deepEqual(repeatedRun.events, [], "run events noop");
  assert.equal(repeatedRun.instructionsExecuted, 0, "run instruction noop");
  assert.deepEqual(plan, failedPlanBefore, "run plan input");
  assert.deepEqual(failed.snapshot, failedBefore, "run snapshot input");
});

test("handoff shapes that would reach invalid runtime states are rejected", () => {
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
  const mutated = (mutate: (plan: ExternalRecord) => void, source = injected.plan) => {
    const plan = externalRecord(structuredClone(source), "plan");
    mutate(plan);
    return plan;
  };

  const targetInjected = injectTextInteraction(
    [
      'if true { say "before" } else { say "other" }',
      'let answer = "__interaction_result__"',
      "say answer",
      "exit",
    ].join("\n"),
  );
  const jumpIndex = targetInjected.plan.instructions.findIndex(
    (instruction) => instruction.kind === "jump",
  );
  assert.notEqual(jumpIndex, -1);

  // Accepting any of the invariant rows lets a validated plan reach a snapshot that validation
  // then rejects: a handoff missing at the next commit boundary, a destination still occupied when
  // the interaction runs again, or a handoff entered without its completed interaction.
  const rows: readonly {
    readonly id: string;
    readonly plan: ExternalRecord;
    readonly paths: readonly string[];
  }[] = [
    {
      id: "PR194-second-blocking-action",
      plan: mutated((plan) => {
        externalInstructions(plan)[injected.handoffInstruction] = { ...validWait, span };
      }),
      paths: [handoffPath],
    },
    {
      id: "PR194-missing-clear",
      plan: mutated((plan) => {
        externalInstructions(plan)[injected.clearInstruction] = { ...validSay, span };
      }),
      paths: [clearPath],
    },
    {
      id: "PR194-wrong-clear",
      plan: mutated((plan) => {
        plan.temporaryCount = injected.plan.temporaryCount + 1;
        externalRecord(externalInstructions(plan)[injected.clearInstruction], "clear").temporaryId =
          injected.destinationTemporary + 1;
      }),
      paths: [clearPath],
    },
    {
      id: "PR194-second-producer",
      plan: mutated((plan) => {
        externalInstructions(plan)[injected.clearInstruction] = {
          kind: "storeTemporary",
          temporaryId: injected.destinationTemporary,
          value: literalExpression("x", span),
          expectBoolean: false,
          span,
        };
      }),
      // Replacing the cleanup with a producer breaks both owner-only production and cleanup.
      paths: [`$.instructions[${injected.interactionInstruction}].destinationTemporary`, clearPath],
    },
    {
      id: "PR194-handoff-entry-target",
      plan: mutated((plan) => {
        externalRecord(externalInstructions(plan)[jumpIndex], "jump").target =
          targetInjected.handoffInstruction;
      }, targetInjected.plan),
      paths: [`$.instructions[${targetInjected.handoffInstruction}]`],
    },
  ];
  for (const row of rows) {
    const before = structuredClone(row.plan);
    assert.deepEqual(
      validateInstructionPlan(row.plan).errors.map((error) => [error.code, error.path]),
      row.paths.map((path) => ["TSC002", path]),
      row.id,
    );
    assert.deepEqual(row.plan, before, row.id);
  }
});

interface OwnershipResumeRow {
  readonly id: string;
  readonly source: string;
  readonly assertPending: (snapshot: RuntimeSnapshot) => void;
  readonly finalSay: string;
}

test("ownership contexts resume from pending and committed boundaries", () => {
  const rows: readonly OwnershipResumeRow[] = [
    {
      id: "PR194-resume-context-nested-return-value",
      source: [
        "function inner { return askText }",
        "function outer { let answer = inner()",
        "say answer",
        "return }",
        "outer()",
        "exit",
      ].join("\n"),
      assertPending: (snapshot) => assert.equal(snapshot.callFrames.length, 2),
      finalSay: "committed",
    },
    {
      id: "PR194-resume-context-suspended-caller",
      source: [
        "function prompt { return askText }",
        'function send(before, answer) { say "${before}:${answer}"',
        "return }",
        'send("first", prompt())',
        "exit",
      ].join("\n"),
      assertPending: (snapshot) => {
        assert.equal(snapshot.callFrames.length, 1);
        const caller = snapshot.callFrames[0];
        assert.ok(caller !== undefined);
        assert.ok(caller.callerTemporaries.some((temporary) => temporary.value === "first"));
      },
      finalSay: "first:committed",
    },
  ];

  for (const row of rows) {
    const plan = compiledTextInteraction(row.source).plan;
    const pending = waiting(plan).snapshot;
    const action = pending.foregroundAction;
    assert.ok(action !== null && action.kind === "interaction", row.id);
    // The innermost active call frame owns the interaction.
    assert.notEqual(action.ownerCallFrameId, null, `${row.id}: action owner`);
    assert.equal(action.ownerCallFrameId, pending.callFrames.at(-1)?.id, `${row.id}: action owner`);
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
    assert.equal(final.snapshot.callFrames.length, 0, `${row.id}: final frames`);
    assert.deepEqual(
      final.events.filter((event) => event.kind === "say").map((event) => event.text),
      [row.finalSay],
      `${row.id}: final output`,
    );
  }
});

test("later settlement preserves ordinary result and makes old replay stale", () => {
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
