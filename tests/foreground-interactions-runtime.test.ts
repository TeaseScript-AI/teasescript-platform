import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  interactionUtf8ByteLength,
  MAX_INTERACTION_AGGREGATE_UTF8_BYTES,
  MAX_INTERACTION_OPTION_ENTRIES,
  MAX_INTERACTION_STRING_UTF8_BYTES,
} from "../src/interaction-limits.js";
import type {
  InstructionPlan,
  InteractionInstruction,
  InteractionUiPayload,
} from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeBindingSnapshot,
  type RuntimeScopeFrameSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { withValidationTestStatistics } from "../src/validation-testing.js";

type Mutable<T> = T extends readonly (infer Item)[]
  ? Array<Mutable<Item>>
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

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

function buttonPlanFromSource(source: string): InstructionPlan {
  const compiled = compileSource(source);
  assert.deepEqual(compiled.diagnostics, []);
  const base = compiled.plan!;
  const waitIndex = base.instructions.findIndex((instruction) => instruction.kind === "wait");
  const interaction: InteractionInstruction = {
    kind: "interaction",
    interactionKind: "button",
    target: "standardChat",
    speaker: null,
    destinationTemporary: null,
    expectedResult: "none",
    ui: { kind: "button", buttonLabel: "Continue", accessibleName: defaults.button },
    span: base.instructions[waitIndex]!.span,
  };
  const instructions = base.instructions.map((instruction, index) =>
    index === waitIndex ? interaction : instruction,
  );
  const plan = { ...base, instructions };
  assert.equal(validateInstructionPlan(plan).valid, true);
  return plan;
}

const defaults = {
  button: { kind: "localizedDefault", key: "continue" },
  text: { kind: "localizedDefault", key: "answer" },
  number: { kind: "localizedDefault", key: "number" },
  choice: { kind: "localizedDefault", key: "chooseOption" },
} as const;

function waiting(plan: InstructionPlan) {
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  assert.equal(result.snapshot.status, "waiting");
  assert.equal(result.snapshot.foregroundAction?.kind, "interaction");
  return result;
}

function complete(
  plan: InstructionPlan,
  payload: unknown,
  interactionKind: InteractionInstruction["interactionKind"],
) {
  const pending = waiting(plan);
  const actionId = pending.snapshot.foregroundAction!.actionId;
  return completeAction(plan, pending.snapshot, {
    actionId,
    actionKind: "interaction",
    interactionKind,
    payload,
  });
}

test("button and text complete through one interaction family with canonical transcript ordering", () => {
  const buttonPlan = interactionPlan("button", {
    kind: "button",
    buttonLabel: "Ready",
    accessibleName: defaults.button,
  });
  const button = complete(buttonPlan, { kind: "activate" }, "button");
  assert.equal(button.outcome.kind, "completed");
  assert.deepEqual(
    button.events.map((event) => event.kind),
    ["playerTranscript", "actionCompleted"],
  );
  const buttonTranscript = button.events[0]!;
  assert.equal(buttonTranscript.kind === "playerTranscript" && buttonTranscript.text, "Ready");

  const textPlan = interactionPlan("text", {
    kind: "text",
    hint: "Answer",
    accessibleName: defaults.text,
  });
  const text = complete(textPlan, { kind: "submittedText", submittedText: "  A\r\nB\r  " }, "text");
  assert.equal(text.outcome.kind, "completed");
  assert.equal(text.snapshot.temporaries[0]?.value, "  A\nB\n  ");
  const textTranscript = text.events[0]!;
  assert.equal(textTranscript.kind === "playerTranscript" && textTranscript.text, "  A\nB\n  ");
});
test("text rejects versioned whitespace-only input without any canonical-state mutation", () => {
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const pending = waiting(plan);
  const before = JSON.stringify(pending.snapshot);
  const rejected = completeAction(plan, pending.snapshot, {
    actionId: pending.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: " \t\r\n" },
  });
  assert.equal(rejected.outcome.kind, "invalidPayload");
  assert.deepEqual(rejected.events, []);
  assert.equal(JSON.stringify(rejected.snapshot), before);
});

test("number accepts TeaseScript decimal/scientific text and preserves its trimmed transcript", () => {
  const plan = interactionPlan("number", {
    kind: "number",
    hint: null,
    accessibleName: defaults.number,
  });
  const result = complete(plan, { kind: "submittedText", submittedText: "  -0e2  " }, "number");
  assert.equal(result.snapshot.temporaries[0]?.value, 0);
  assert.equal(Object.is(result.snapshot.temporaries[0]?.value, -0), false);
  const numberTranscript = result.events[0]!;
  assert.equal(numberTranscript.kind === "playerTranscript" && numberTranscript.text, "-0e2");
  for (const submittedText of [
    "1\n2",
    "\u20281",
    "1\u2029",
    "1,5",
    "1 000",
    "1px",
    "Infinity",
    "1e999",
    "one",
    "+",
  ]) {
    const pending = waiting(plan);
    const before = JSON.stringify(pending.snapshot);
    const rejected = completeAction(plan, pending.snapshot, {
      actionId: pending.snapshot.foregroundAction!.actionId,
      actionKind: "interaction",
      interactionKind: "number",
      payload: { kind: "submittedText", submittedText },
    });
    assert.equal(rejected.outcome.kind, "invalidPayload", submittedText);
    assert.equal(JSON.stringify(rejected.snapshot), before, submittedText);
  }
});

test("choice supports unlabelled, identifier, numeric, exact typed, and ambiguous labelled behavior", () => {
  const unlabelled = interactionPlan("choice", {
    kind: "choice",
    labelType: "none",
    options: [
      { text: "Alpha", label: null },
      { text: "Beta", label: null },
    ],
    accessibleName: defaults.choice,
  });
  assert.equal(
    complete(unlabelled, { kind: "selectedText", selectedText: "Beta" }, "choice").snapshot
      .temporaries[0]?.value,
    "Beta",
  );
  assert.equal(
    complete(unlabelled, { kind: "submittedText", submittedText: "Alpha" }, "choice").snapshot
      .temporaries[0]?.value,
    "Alpha",
  );

  const labelled = interactionPlan("choice", {
    kind: "choice",
    labelType: "identifier",
    options: [
      { text: "Same", label: "first" },
      { text: "Same", label: "second" },
    ],
    accessibleName: defaults.choice,
  });
  const ambiguous = waiting(labelled);
  const before = JSON.stringify(ambiguous.snapshot);
  const rejected = completeAction(labelled, ambiguous.snapshot, {
    actionId: ambiguous.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "submittedText", submittedText: "Same" },
  });
  assert.equal(rejected.outcome.kind, "invalidPayload");
  assert.equal(JSON.stringify(rejected.snapshot), before);
  const selected = complete(labelled, { kind: "selectedLabel", selectedLabel: "second" }, "choice");
  assert.equal(selected.snapshot.temporaries[0]?.value, "second");
  const choiceTranscript = selected.events[0]!;
  assert.equal(choiceTranscript.kind === "playerTranscript" && choiceTranscript.text, "Same");

  const numeric = interactionPlan("choice", {
    kind: "choice",
    labelType: "number",
    options: [
      { text: "One", label: 1 },
      { text: "Two", label: 2 },
    ],
    accessibleName: defaults.choice,
  });
  const numericCompleted = complete(numeric, { kind: "selectedLabel", selectedLabel: 2 }, "choice");
  assert.equal(numericCompleted.snapshot.temporaries[0]?.value, 2);
  assert.equal(validateRuntimeSnapshot(numericCompleted.snapshot, numeric).valid, true);
  const numericRestored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(numeric, numericCompleted.snapshot)),
  );
  assert.equal(numericRestored.snapshot.temporaries[0]?.value, 2);
  assert.equal(run(numericRestored.plan, numericRestored.snapshot).snapshot.status, "halted");
});

test("choice completion snapshots validate without a plan for every result domain", () => {
  const cases = [
    interactionPlan("choice", {
      kind: "choice",
      labelType: "none",
      options: [{ text: "Visible", label: null }],
      accessibleName: defaults.choice,
    }),
    interactionPlan("choice", {
      kind: "choice",
      labelType: "identifier",
      options: [{ text: "Visible", label: "named" }],
      accessibleName: defaults.choice,
    }),
    interactionPlan("choice", {
      kind: "choice",
      labelType: "number",
      options: [{ text: "Visible", label: 1 }],
      accessibleName: defaults.choice,
    }),
  ] as const;
  const payloads = [
    { kind: "selectedText", selectedText: "Visible" },
    { kind: "selectedLabel", selectedLabel: "named" },
    { kind: "selectedLabel", selectedLabel: 1 },
  ] as const;
  for (let index = 0; index < cases.length; index += 1) {
    const completed = complete(cases[index]!, payloads[index], "choice");
    assert.equal(validateRuntimeSnapshot(completed.snapshot).valid, true);
    for (const malformedResult of [null, { kind: "object", properties: [] }, -0]) {
      const malformed: any = structuredClone(completed.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture rewrites the interaction result across settlement, handoff, and destination to values excluded by the canonical snapshot type.
      malformed.lastSettlement.result = malformedResult;
      malformed.interactionResultHandoff.result = malformedResult;
      malformed.temporaries[0].value = malformedResult;
      assert.equal(validateRuntimeSnapshot(malformed).valid, false);
    }
  }
  const identifier = complete(cases[1], payloads[1], "choice");
  const wrongForExactPlan: any = structuredClone(identifier.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture changes an identifier-labelled result to the numeric domain for exact-plan validation.
  wrongForExactPlan.lastSettlement.result = 1;
  wrongForExactPlan.interactionResultHandoff.result = 1;
  wrongForExactPlan.temporaries[0].value = 1;
  assert.equal(validateRuntimeSnapshot(wrongForExactPlan).valid, true);
  assert.equal(validateRuntimeSnapshot(wrongForExactPlan, cases[1]).valid, false);
  const wrongChoiceDestination: any = structuredClone(identifier.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture makes the stored destination disagree with its retained choice settlement.
  wrongChoiceDestination.temporaries[0].value = "other";
  assert.equal(validateRuntimeSnapshot(wrongChoiceDestination, cases[1]).valid, false);
});

test("numeric choice rejects negative-zero labels and stores JSON-stable zero results", () => {
  const valid = interactionPlan("choice", {
    kind: "choice",
    labelType: "number",
    options: [{ text: "Zero", label: 0 }],
    accessibleName: defaults.choice,
  });
  const negativeZeroPlan: any = structuredClone(valid); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture injects negative zero into a numeric choice label rejected by plan validation.
  negativeZeroPlan.instructions[0].ui.options[0].label = -0;
  assert.equal(validateInstructionPlan(negativeZeroPlan).valid, false);

  const pending = waiting(valid);
  const negativeZeroAction: any = structuredClone(pending.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture injects negative zero into persisted choice UI data rejected by snapshot validation.
  negativeZeroAction.foregroundAction.ui.options[0].label = -0;
  assert.equal(validateRuntimeSnapshot(negativeZeroAction).valid, false);
  assert.equal(validateRuntimeSnapshot(negativeZeroAction, valid).valid, false);

  for (const payload of [
    { kind: "selectedLabel", selectedLabel: -0 },
    { kind: "submittedText", submittedText: "Zero" },
  ]) {
    const completed = complete(valid, payload, "choice");
    assert.ok(completed.snapshot.lastSettlement?.actionKind === "interaction");
    assert.equal(Object.is(completed.snapshot.lastSettlement.result, -0), false);
    assert.equal(validateRuntimeSnapshot(completed.snapshot, valid).valid, true);
    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(valid, completed.snapshot)),
    );
    assert.ok(restored.snapshot.lastSettlement?.actionKind === "interaction");
    assert.equal(Object.is(restored.snapshot.lastSettlement.result, -0), false);
    assert.equal(run(restored.plan, restored.snapshot).snapshot.status, "halted");
  }
});

test("duplicate, stale, unknown, wrong-kind, and over-limit completion preserve ADR 0016 classification", () => {
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const pending = waiting(plan);
  const actionId = pending.snapshot.foregroundAction!.actionId;
  const wrong = completeAction(plan, pending.snapshot, {
    actionId,
    actionKind: "delay",
    payload: { kind: "time", currentSessionTimeMs: 1 },
  });
  assert.equal(wrong.outcome.kind, "wrongActionKind");
  assert.deepEqual(wrong.snapshot, pending.snapshot);
  const over = completeAction(plan, pending.snapshot, {
    actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: {
      kind: "submittedText",
      submittedText: "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES + 1),
    },
  });
  assert.equal(over.outcome.kind, "invalidPayload");
  assert.deepEqual(over.snapshot, pending.snapshot);
  const done = completeAction(plan, pending.snapshot, {
    actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "ok" },
  });
  const duplicate = completeAction(plan, done.snapshot, {
    actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "different" },
  });
  assert.equal(duplicate.outcome.kind, "alreadySettled");
  assert.deepEqual(duplicate.events, []);
  const seeded = createFreshRuntimeSnapshot(plan);
  seeded.nextActionId = 2;
  const laterPending = run(plan, seeded);
  const stale = completeAction(plan, laterPending.snapshot, {
    actionId: 1,
    actionKind: "interaction",
  });
  assert.equal(stale.outcome.kind, "staleAction");
  const unknown = completeAction(plan, done.snapshot, {
    actionId: done.snapshot.nextActionId,
    actionKind: "interaction",
  });
  assert.equal(unknown.outcome.kind, "unknownAction");
});

test("pending interaction survives JSON checkpoint restore with monotonic events and speaker provenance", () => {
  const plan = interactionPlan(
    "button",
    { kind: "button", buttonLabel: "Continue", accessibleName: defaults.button },
    { speaker: "mistress" },
  );
  const pending = waiting(plan);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, pending.snapshot)),
  );
  assert.deepEqual(restored.snapshot, pending.snapshot);
  const completed = completeAction(restored.plan, restored.snapshot, {
    actionId: restored.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  });
  assert.equal(completed.events[0]!.kind, "playerTranscript");
  const transcript = completed.events[0]!;
  assert.equal(transcript.kind === "playerTranscript" && transcript.requestingSpeakerId, 1);
  assert.deepEqual(
    completed.events.map((event) => event.sequence),
    [pending.snapshot.nextEventSequence, pending.snapshot.nextEventSequence + 1],
  );
  assert.equal(observeTime(restored.plan, restored.snapshot, 10).snapshot.status, "waiting");
});

test("interaction definitions preflight each field against remaining aggregate bytes", () => {
  assert.equal(
    interactionUtf8ByteLength("x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES + 4_464)),
    70_000,
  );
  const exact = interactionPlan("button", {
    kind: "button",
    buttonLabel: "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES),
    accessibleName: defaults.button,
  });
  assert.equal(validateInstructionPlan(exact).valid, true);
  const tooLong = structuredClone(exact);
  const tooLongInteraction = tooLong.instructions.find(
    (instruction) => instruction.kind === "interaction",
  );
  assert.ok(
    tooLongInteraction?.kind === "interaction" &&
      "ui" in tooLongInteraction &&
      tooLongInteraction.ui.kind === "button",
  );
  const tooLongUi = tooLongInteraction.ui;
  // EVIDENCE: fixture extends only the button label beyond its accepted byte limit.
  (tooLongUi as { buttonLabel: string }).buttonLabel += "x";
  assert.equal(validateInstructionPlan(tooLong).valid, false);

  const options = Array.from({ length: MAX_INTERACTION_OPTION_ENTRIES }, (_, index) => ({
    text: "",
    label: index,
  }));
  const exactOptions = interactionPlan("choice", {
    kind: "choice",
    labelType: "number",
    options,
    accessibleName: defaults.choice,
  });
  assert.equal(validateInstructionPlan(exactOptions).valid, true);
  const overOptions = structuredClone(exactOptions);
  const overOptionsInteraction = overOptions.instructions.find(
    (instruction) => instruction.kind === "interaction",
  );
  assert.ok(
    overOptionsInteraction?.kind === "interaction" &&
      "ui" in overOptionsInteraction &&
      overOptionsInteraction.ui.kind === "choice",
  );
  const ui = overOptionsInteraction.ui;
  // EVIDENCE: fixture appends one choice beyond the accepted option-count limit.
  Object.assign(ui, {
    options: [...ui.options, { text: "", label: MAX_INTERACTION_OPTION_ENTRIES }],
  });
  assert.equal(validateInstructionPlan(overOptions).valid, false);

  const completionPlan = interactionPlan("text", {
    kind: "text",
    hint: null,
    accessibleName: defaults.text,
  });
  const accepted = complete(
    completionPlan,
    { kind: "submittedText", submittedText: "é".repeat(MAX_INTERACTION_STRING_UTF8_BYTES / 2) },
    "text",
  );
  assert.equal(accepted.outcome.kind, "completed");
  const overUtf8 = waiting(completionPlan);
  const rejected = completeAction(completionPlan, overUtf8.snapshot, {
    actionId: overUtf8.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: {
      kind: "submittedText",
      submittedText: `${"é".repeat(MAX_INTERACTION_STRING_UTF8_BYTES / 2)}x`,
    },
  });
  assert.equal(rejected.outcome.kind, "invalidPayload");
  assert.deepEqual(rejected.snapshot, overUtf8.snapshot);

  const exactAggregate = interactionPlan("text", {
    kind: "text",
    hint: "h".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES - 1),
    accessibleName: { kind: "text", text: "a" },
  });
  assert.equal(validateInstructionPlan(exactAggregate).valid, true);
  const overAggregate = structuredClone(exactAggregate);
  const overAggregateInteraction = overAggregate.instructions[0];
  assert.ok(
    overAggregateInteraction?.kind === "interaction" &&
      "ui" in overAggregateInteraction &&
      overAggregateInteraction.ui.kind === "text" &&
      overAggregateInteraction.ui.hint !== null,
  );
  // EVIDENCE: fixture extends only the text hint beyond the aggregate byte limit.
  (overAggregateInteraction.ui as { hint: string }).hint += "h";
  assert.equal(validateInstructionPlan(overAggregate).valid, false);

  const choiceWithinAggregate = interactionPlan("choice", {
    kind: "choice",
    labelType: "none",
    accessibleName: defaults.choice,
    options: [
      { text: "a".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES - 1), label: null },
      { text: "b", label: null },
    ],
  });
  assert.equal(validateInstructionPlan(choiceWithinAggregate).valid, true);
  const choiceOverAggregate = structuredClone(choiceWithinAggregate);
  const choiceOverInteraction = choiceOverAggregate.instructions[0];
  assert.ok(
    choiceOverInteraction?.kind === "interaction" &&
      "ui" in choiceOverInteraction &&
      choiceOverInteraction.ui.kind === "choice" &&
      choiceOverInteraction.ui.options[1] !== undefined,
  );
  // EVIDENCE: fixture extends only the second choice text beyond the aggregate byte limit.
  (choiceOverInteraction.ui.options[1] as { text: string }).text += "b";
  assert.equal(validateInstructionPlan(choiceOverAggregate).valid, false);

  const hugePending = waiting(completionPlan);
  const huge = completeAction(completionPlan, hugePending.snapshot, {
    actionId: hugePending.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: {
      kind: "submittedText",
      submittedText: "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES * 16),
    },
  });
  assert.equal(huge.outcome.kind, "invalidPayload");
  assert.deepEqual(huge.snapshot, hugePending.snapshot);
});

test("malformed interaction snapshot and settlement data are rejected", () => {
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const pending = waiting(plan);
  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixture callbacks corrupt interaction kind, destination, speaker identity, and UI kind fields with incompatible values.
  const mutations: Array<(snapshot: any) => void> = [
    (snapshot) => {
      snapshot.foregroundAction.interactionKind = "number";
    },
    (snapshot) => {
      snapshot.foregroundAction.destinationTemporary = null;
    },
    (snapshot) => {
      snapshot.foregroundAction.speakerId = 999;
    },
    (snapshot) => {
      snapshot.foregroundAction.ui.kind = "button";
    },
  ];
  for (const mutate of mutations) {
    const malformed = structuredClone(pending.snapshot);
    mutate(malformed);
    assert.equal(validateRuntimeSnapshot(malformed, plan).valid, false);
  }
  const done = complete(plan, { kind: "submittedText", submittedText: "ok" }, "text");
  const malformedSettlement: any = structuredClone(done.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture replaces a text settlement result with a number for rejection.
  malformedSettlement.lastSettlement.result = 1;
  assert.equal(validateRuntimeSnapshot(malformedSettlement, plan).valid, false);
  const wrongTranscript: any = structuredClone(done.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture makes retained transcript text disagree with the completed interaction result.
  wrongTranscript.lastSettlement.transcriptText = "different";
  assert.equal(validateRuntimeSnapshot(wrongTranscript, plan).valid, false);
  // EVIDENCE: structuredClone preserves the runtime snapshot shape while this fixture changes one temporary value.
  const wrongDestination = structuredClone(done.snapshot) as Mutable<RuntimeSnapshot>;
  const wrongTemporary = wrongDestination.temporaries.find((temporary) => temporary.id === 1);
  assert.ok(wrongTemporary);
  wrongTemporary.value = "other";
  assert.equal(validateRuntimeSnapshot(wrongDestination, plan).valid, false);

  const standaloneUi: any = structuredClone(pending.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture adds an unsupported accessible-name key to persisted UI data.
  standaloneUi.foregroundAction.ui.accessibleName.key = "continue";
  assert.equal(validateRuntimeSnapshot(standaloneUi).valid, false);
});

test("planless pending result interactions require positive destination temporary IDs", () => {
  for (const [kind, ui] of [
    ["text", { kind: "text", hint: null, accessibleName: defaults.text }],
    ["number", { kind: "number", hint: null, accessibleName: defaults.number }],
    [
      "choice",
      {
        kind: "choice",
        labelType: "none",
        options: [{ text: "One", label: null }],
        accessibleName: defaults.choice,
      },
    ],
  ] as const) {
    const plan = interactionPlan(kind, ui);
    const pending = waiting(plan);
    for (const destination of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
      const hostile: any = structuredClone(pending.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture assigns an out-of-range interaction destination before validation and completion.
      hostile.foregroundAction.destinationTemporary = destination;
      assert.equal(validateRuntimeSnapshot(hostile).valid, false, `${kind}:${destination}`);
      assert.throws(
        () => restoreCheckpoint({ ...createCheckpoint(plan, pending.snapshot), snapshot: hostile }),
        `${kind}:${destination}`,
      );
    }
  }
  const button = interactionPlan("button", {
    kind: "button",
    buttonLabel: "Continue",
    accessibleName: defaults.button,
  });
  const pendingButton = waiting(button);
  const hostileButton: any = structuredClone(pendingButton.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture gives a result-free button an illegal destination temporary.
  hostileButton.foregroundAction.destinationTemporary = 1;
  assert.equal(validateRuntimeSnapshot(hostileButton).valid, false);
});

test("planless interaction settlements enforce intrinsic transcript and result semantics", () => {
  const textPlan = interactionPlan("text", {
    kind: "text",
    hint: null,
    accessibleName: defaults.text,
  });
  const text = complete(
    textPlan,
    { kind: "submittedText", submittedText: "answer" },
    "text",
  ).snapshot;
  assert.equal(validateRuntimeSnapshot(JSON.parse(JSON.stringify(text))).valid, true);
  const wrongText: any = structuredClone(text); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture makes the retained text result and destination disagree with the canonical transcript.
  wrongText.lastSettlement.result = "different";
  wrongText.temporaries[0].value = "different";
  assert.equal(validateRuntimeSnapshot(wrongText).valid, false);

  const numberPlan = interactionPlan("number", {
    kind: "number",
    hint: null,
    accessibleName: defaults.number,
  });
  const number = complete(
    numberPlan,
    { kind: "submittedText", submittedText: "1e1" },
    "number",
  ).snapshot;
  assert.equal(validateRuntimeSnapshot(JSON.parse(JSON.stringify(number))).valid, true);
  for (const [result, transcript] of [
    [10, "nonsense"],
    [10, "1\u2028"],
    [11, "1e1"],
    [-0, "-0"],
  ] as const) {
    const hostile: any = structuredClone(number); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture corrupts a numeric settlement, transcript, and destination with the supplied invalid result.
    hostile.lastSettlement.result = result;
    hostile.lastSettlement.transcriptText = transcript;
    hostile.temporaries[0].value = result;
    assert.equal(validateRuntimeSnapshot(hostile).valid, false, transcript);
  }
});

test("pending interaction speaker provenance is bound to the instructed speaker", () => {
  const compiled = compileSource("speaker alice {}\nspeaker bob {}\nspeaker alice\nwait 1\nexit");
  assert.deepEqual(compiled.diagnostics, []);
  const base = compiled.plan!;
  const waitIndex = base.instructions.findIndex((instruction) => instruction.kind === "wait");
  const interaction: InteractionInstruction = {
    kind: "interaction",
    interactionKind: "button",
    target: "standardChat",
    speaker: "alice",
    destinationTemporary: null,
    expectedResult: "none",
    ui: { kind: "button", buttonLabel: "Continue", accessibleName: defaults.button },
    span: base.instructions[waitIndex]!.span,
  };
  const instructions = base.instructions.map((instruction, index) =>
    index === waitIndex ? interaction : instruction,
  );
  const speakerPlan = { ...base, instructions };
  const pending = waiting(speakerPlan);
  const bob = pending.snapshot.speakers.find((speaker) => speaker.identifier === "bob")!;
  const mutated: any = structuredClone(pending.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture changes the requesting speaker identity after the action was prepared.
  mutated.foregroundAction.speakerId = bob.id;
  assert.equal(validateRuntimeSnapshot(mutated, speakerPlan).valid, false);

  // EVIDENCE: structuredClone preserves the runtime snapshot shape while this fixture swaps persisted identifiers.
  const swappedIdentifiers = structuredClone(pending.snapshot) as Mutable<RuntimeSnapshot>;
  const alice = swappedIdentifiers.speakers.find((speaker) => speaker.identifier === "alice");
  const swappedBob = swappedIdentifiers.speakers.find((speaker) => speaker.identifier === "bob");
  assert.ok(alice !== undefined && swappedBob !== undefined);
  assert.ok(swappedIdentifiers.foregroundAction?.kind === "interaction");
  [alice.identifier, swappedBob.identifier] = [swappedBob.identifier, alice.identifier];
  swappedIdentifiers.foregroundAction.speakerId = swappedBob.id;
  assert.equal(validateRuntimeSnapshot(swappedIdentifiers, speakerPlan).valid, false);

  // EVIDENCE: structuredClone preserves the runtime snapshot shape while this fixture changes one speaker reference.
  const alteredBinding = structuredClone(pending.snapshot) as Mutable<RuntimeSnapshot>;
  const aliceBinding = alteredBinding.frames
    .flatMap((frame) => frame.bindings)
    .find((binding) => binding.name === "alice");
  assert.ok(
    aliceBinding !== undefined &&
      typeof aliceBinding.value === "object" &&
      aliceBinding.value !== null &&
      aliceBinding.value.kind === "speakerReference",
  );
  aliceBinding.value.speakerId = bob.id;
  assert.equal(validateRuntimeSnapshot(alteredBinding, speakerPlan).valid, false);

  // EVIDENCE: structuredClone preserves the runtime snapshot shape while this fixture changes matching speaker IDs.
  const bindingResolved = structuredClone(pending.snapshot) as Mutable<RuntimeSnapshot>;
  const binding = bindingResolved.frames
    .flatMap((frame) => frame.bindings)
    .find((candidate) => candidate.name === "alice");
  assert.ok(
    binding !== undefined &&
      typeof binding.value === "object" &&
      binding.value !== null &&
      binding.value.kind === "speakerReference",
  );
  binding.value.speakerId = bob.id;
  assert.ok(bindingResolved.foregroundAction?.kind === "interaction");
  bindingResolved.foregroundAction.speakerId = bob.id;
  assert.equal(validateRuntimeSnapshot(bindingResolved, speakerPlan).valid, true);

  const defaultSpeakerPlan = structuredClone(speakerPlan);
  const defaultSpeakerInteraction = defaultSpeakerPlan.instructions[waitIndex];
  assert.ok(
    defaultSpeakerInteraction?.kind === "interaction" && "speaker" in defaultSpeakerInteraction,
  );
  // EVIDENCE: fixture changes only the static interaction speaker to exercise default-speaker resolution.
  (defaultSpeakerInteraction as { speaker: string | null }).speaker = null;
  assert.equal(validateInstructionPlan(defaultSpeakerPlan).valid, true);
  const defaultPending = waiting(defaultSpeakerPlan);
  const defaultAction = defaultPending.snapshot.foregroundAction;
  assert.equal(
    defaultAction?.kind === "interaction" && defaultAction.speakerId,
    defaultPending.snapshot.defaultSpeaker,
  );
  const wrongDefault: any = structuredClone(defaultPending.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture changes a default-speaker action to an unrelated speaker ID.
  wrongDefault.foregroundAction.speakerId = bob.id;
  assert.equal(validateRuntimeSnapshot(wrongDefault, defaultSpeakerPlan).valid, false);

  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixture callbacks remove or corrupt the explicit speaker binding and its resolved speaker identity.
  const explicitMutations: Array<(snapshot: any) => void> = [
    (snapshot) => {
      const frame = snapshot.frames.find((candidate: RuntimeScopeFrameSnapshot) =>
        candidate.bindings.some((binding: RuntimeBindingSnapshot) => binding.name === "alice"),
      );
      assert.ok(frame);
      frame.bindings = frame.bindings.filter(
        (binding: RuntimeBindingSnapshot) => binding.name !== "alice",
      );
      snapshot.foregroundAction.speakerId = null;
    },
    (snapshot) => {
      const binding = snapshot.frames
        .flatMap((frame: RuntimeScopeFrameSnapshot) => frame.bindings)
        .find((candidate: RuntimeBindingSnapshot) => candidate.name === "alice");
      assert.ok(binding);
      binding.value = "ordinary";
      snapshot.foregroundAction.speakerId = null;
    },
    (snapshot) => {
      const binding = snapshot.frames
        .flatMap((frame: RuntimeScopeFrameSnapshot) => frame.bindings)
        .find((candidate: RuntimeBindingSnapshot) => candidate.name === "alice");
      assert.ok(binding);
      binding.value = { kind: "speakerReference", speakerId: "bad", identifier: "alice" };
      snapshot.foregroundAction.speakerId = null;
    },
    (snapshot) => {
      const binding = snapshot.frames
        .flatMap((frame: RuntimeScopeFrameSnapshot) => frame.bindings)
        .find((candidate: RuntimeBindingSnapshot) => candidate.name === "alice");
      assert.ok(binding);
      binding.value = { kind: "speakerReference", speakerId: 999, identifier: "alice" };
      snapshot.foregroundAction.speakerId = null;
    },
    (snapshot) => {
      snapshot.foregroundAction.speakerId = null;
    },
  ];
  for (const mutate of explicitMutations) {
    const hostile = structuredClone(pending.snapshot);
    mutate(hostile);
    assert.equal(validateRuntimeSnapshot(hostile, speakerPlan).valid, false);
    assert.throws(() =>
      restoreCheckpoint({ ...createCheckpoint(speakerPlan, pending.snapshot), snapshot: hostile }),
    );
  }

  for (const source of [
    "speaker alice {}\nspeaker bob {}\nfunction prompt(requested) { wait 1 }\nprompt(bob)\nexit",
    "speaker alice {}\nfunction prompt { wait 1 }\nprompt()\nexit",
  ]) {
    const scoped = buttonPlanFromSource(source);
    const interaction = scoped.instructions.find(
      (instruction) => instruction.kind === "interaction",
    );
    assert.ok(interaction?.kind === "interaction" && "speaker" in interaction);
    // EVIDENCE: fixture changes only the static interaction's speaker expression before plan validation.
    (interaction as { speaker: string | null }).speaker = source.includes("requested")
      ? "requested"
      : "alice";
    assert.equal(validateInstructionPlan(scoped).valid, true);
    const scopedPending = waiting(scoped);
    const binding = scopedPending.snapshot.frames
      .slice()
      .reverse()
      .flatMap((frame) => frame.bindings)
      .find((candidate) => candidate.name === interaction.speaker);
    assert.ok(binding);
    assert.ok(
      typeof binding.value === "object" &&
        binding.value !== null &&
        binding.value.kind === "speakerReference",
    );
    const bindingSpeakerId = binding.value.speakerId;
    assert.equal(
      scopedPending.snapshot.foregroundAction?.kind === "interaction" &&
        scopedPending.snapshot.foregroundAction.speakerId,
      bindingSpeakerId,
    );
    assert.equal(validateRuntimeSnapshot(scopedPending.snapshot, scoped).valid, true);
  }

  const nestedBase = buttonPlanFromSource(
    "speaker root {}\nspeaker bob {}\nif true { wait 1 }\nexit",
  );
  const nestedInstruction = nestedBase.instructions.find(
    (instruction) => instruction.kind === "interaction",
  );
  assert.ok(nestedInstruction?.kind === "interaction" && "speaker" in nestedInstruction);
  // EVIDENCE: fixture changes only the static interaction's speaker binding for nested-scope resolution.
  (nestedInstruction as { speaker: string | null }).speaker = "alice";
  const nestedInstructions = nestedBase.instructions.map((instruction) =>
    instruction.kind === "interaction" ? { ...instruction, speaker: null } : instruction,
  );
  const nestedPending = waiting({ ...nestedBase, instructions: nestedInstructions });
  // EVIDENCE: structuredClone preserves the runtime snapshot shape while this fixture adds scoped speaker bindings.
  const nested = structuredClone(nestedPending.snapshot) as Mutable<RuntimeSnapshot>;
  const rootSpeaker = nested.speakers.find((speaker) => speaker.identifier === "root");
  const nestedBob = nested.speakers.find((speaker) => speaker.identifier === "bob");
  assert.ok(rootSpeaker !== undefined && nestedBob !== undefined);
  assert.ok(nested.frames[0] !== undefined);
  assert.ok(nested.frames.at(-1) !== undefined);
  nested.frames[0].bindings.push({
    name: "alice",
    value: { kind: "speakerReference", speakerId: rootSpeaker.id, identifier: "root" },
  });
  nested.frames
    .at(-1)!
    .bindings.push({
      name: "alice",
      value: { kind: "speakerReference", speakerId: nestedBob.id, identifier: "bob" },
    });
  assert.ok(nested.foregroundAction?.kind === "interaction");
  nested.foregroundAction.speakerId = nestedBob.id;
  assert.equal(validateRuntimeSnapshot(nested, nestedBase).valid, true);
  nested.foregroundAction.speakerId = rootSpeaker.id;
  assert.equal(validateRuntimeSnapshot(nested, nestedBase).valid, false);
});

test("explicit accessible names must contain non-whitespace content", () => {
  for (const text of ["", " \t\r\n", "\u2028\u2029"]) {
    const base = interactionPlan("button", {
      kind: "button",
      buttonLabel: "Continue",
      accessibleName: defaults.button,
    });
    const malformed = structuredClone(base);
    const malformedInteraction = malformed.instructions[0];
    assert.ok(
      malformedInteraction?.kind === "interaction" &&
        "ui" in malformedInteraction &&
        malformedInteraction.ui.kind === "button",
    );
    // EVIDENCE: fixture replaces only the button's accessible name with the candidate whitespace text.
    (
      malformedInteraction.ui as { accessibleName: InteractionUiPayload["accessibleName"] }
    ).accessibleName = { kind: "text", text };
    assert.equal(validateInstructionPlan(malformed).valid, false, JSON.stringify(text));
    const pending = waiting(base);
    const malformedSnapshot = structuredClone(pending.snapshot);
    assert.ok(malformedSnapshot.foregroundAction?.kind === "interaction");
    // EVIDENCE: fixture replaces only persisted interaction accessible-name text before validation.
    (
      malformedSnapshot.foregroundAction.ui as {
        accessibleName: InteractionUiPayload["accessibleName"];
      }
    ).accessibleName = { kind: "text", text };
    assert.equal(
      validateRuntimeSnapshot(malformedSnapshot, base).valid,
      false,
      JSON.stringify(text),
    );
  }
});

test("very large regex-bearing interaction strings fast-reject at plan and snapshot boundaries", () => {
  const huge = "a".repeat(MAX_INTERACTION_STRING_UTF8_BYTES * 32);
  const button = interactionPlan("button", {
    kind: "button",
    buttonLabel: "Continue",
    accessibleName: defaults.button,
  });
  const hugeAccessible = structuredClone(button);
  const hugeAccessibleInteraction = hugeAccessible.instructions[0];
  assert.ok(
    hugeAccessibleInteraction?.kind === "interaction" &&
      "ui" in hugeAccessibleInteraction &&
      hugeAccessibleInteraction.ui.kind === "button",
  );
  // EVIDENCE: fixture replaces only the button's accessible name with an oversized text value.
  (
    hugeAccessibleInteraction.ui as { accessibleName: InteractionUiPayload["accessibleName"] }
  ).accessibleName = { kind: "text", text: huge };
  assert.equal(validateInstructionPlan(hugeAccessible).valid, false);

  const identifier = interactionPlan("choice", {
    kind: "choice",
    labelType: "identifier",
    options: [{ text: "Visible", label: "valid" }],
    accessibleName: defaults.choice,
  });
  const hugeIdentifier = structuredClone(identifier);
  const hugeIdentifierInteraction = hugeIdentifier.instructions[0];
  assert.ok(
    hugeIdentifierInteraction?.kind === "interaction" &&
      "ui" in hugeIdentifierInteraction &&
      hugeIdentifierInteraction.ui.kind === "choice" &&
      hugeIdentifierInteraction.ui.options[0] !== undefined,
  );
  // EVIDENCE: fixture replaces only the first choice label with an oversized identifier.
  (hugeIdentifierInteraction.ui.options[0] as { label: string }).label = huge;
  assert.equal(validateInstructionPlan(hugeIdentifier).valid, false);

  const pending = waiting(identifier);
  const hostile = structuredClone(pending.snapshot);
  assert.ok(
    hostile.foregroundAction?.kind === "interaction" &&
      hostile.foregroundAction.ui.kind === "choice",
  );
  const hostileOption = hostile.foregroundAction.ui.options[0];
  assert.ok(hostileOption !== undefined);
  // EVIDENCE: fixture replaces only the persisted choice label with an oversized identifier.
  (hostileOption as { label: string | number | null }).label = huge;
  assert.equal(validateRuntimeSnapshot(hostile).valid, false);
});

test("interaction validation measures each accepted field once and stops after aggregate exhaustion", () => {
  const accepted = interactionPlan("choice", {
    kind: "choice",
    labelType: "identifier",
    options: [
      { text: "One", label: "one" },
      { text: "Two", label: "two" },
    ],
    accessibleName: defaults.choice,
  });
  const acceptedStats = withValidationTestStatistics((finish) => {
    assert.equal(validateInstructionPlan(accepted).valid, true);
    return finish();
  });
  assert.equal(acceptedStats.counts.interactionUtf8Measurements, 4);
  const acceptedPending = waiting(accepted);
  const acceptedSnapshotStats = withValidationTestStatistics((finish) => {
    assert.equal(validateRuntimeSnapshot(acceptedPending.snapshot).valid, true);
    return finish();
  });
  assert.equal(acceptedSnapshotStats.counts.interactionUtf8Measurements, 4);

  const exhausted = structuredClone(accepted);
  const exhaustedInteraction = exhausted.instructions[0];
  assert.ok(
    exhaustedInteraction?.kind === "interaction" &&
      "ui" in exhaustedInteraction &&
      exhaustedInteraction.ui.kind === "choice",
  );
  // EVIDENCE: fixture replaces only the choice options with aggregate-byte exhaustion data.
  Object.assign(exhaustedInteraction.ui, {
    options: [
      { text: "a".repeat(40_000), label: "b".repeat(30_000) },
      ...Array.from({ length: 128 }, (_, index) => ({
        text: `text${index}`,
        label: `label${index}`,
      })),
    ],
  });
  const exhaustedPlanStats = withValidationTestStatistics((finish) => {
    assert.equal(validateInstructionPlan(exhausted).valid, false);
    return finish();
  });
  assert.equal(exhaustedPlanStats.counts.interactionUtf8Measurements, 2);

  const pending = waiting(accepted);
  const hostile = structuredClone(pending.snapshot);
  assert.ok(
    hostile.foregroundAction?.kind === "interaction" &&
      hostile.foregroundAction.ui.kind === "choice",
  );
  // EVIDENCE: fixture copies the oversized validated-plan option array into persisted interaction UI.
  (hostile.foregroundAction.ui as { options: typeof exhaustedInteraction.ui.options }).options =
    exhaustedInteraction.ui.options;
  const exhaustedSnapshotStats = withValidationTestStatistics((finish) => {
    assert.equal(validateRuntimeSnapshot(hostile).valid, false);
    return finish();
  });
  assert.equal(exhaustedSnapshotStats.counts.interactionUtf8Measurements, 2);
});

test("huge completion kind tokens are not reflected or allowed to mutate canonical state", () => {
  const plan = interactionPlan("button", {
    kind: "button",
    buttonLabel: "Continue",
    accessibleName: defaults.button,
  });
  const pending = waiting(plan);
  const huge = "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES * 32);
  for (const request of [
    { actionId: pending.snapshot.foregroundAction!.actionId, actionKind: huge },
    {
      actionId: pending.snapshot.foregroundAction!.actionId,
      actionKind: "interaction",
      interactionKind: huge,
    },
  ]) {
    const before = JSON.stringify(pending.snapshot);
    const rejected = completeAction(plan, pending.snapshot, request);
    assert.equal(rejected.outcome.kind, "wrongActionKind");
    assert.equal(
      rejected.outcome.kind === "wrongActionKind" && rejected.outcome.receivedActionKind,
      "<invalid>",
    );
    assert.deepEqual(rejected.events, []);
    assert.equal(JSON.stringify(rejected.snapshot), before);
  }
});

test("a foreground action is strictly newer than the retained settlement", () => {
  const compiled = compileSource("wait 1\nwait 1\nexit");
  assert.deepEqual(compiled.diagnostics, []);
  const base = compiled.plan!;
  const instructions = base.instructions.map((instruction) =>
    instruction.kind === "wait"
      ? {
          kind: "interaction" as const,
          interactionKind: "button" as const,
          target: "standardChat" as const,
          speaker: null,
          destinationTemporary: null,
          expectedResult: "none" as const,
          ui: { kind: "button" as const, buttonLabel: "Continue", accessibleName: defaults.button },
          span: instruction.span,
        }
      : instruction,
  );
  const plan = { ...base, instructions };
  assert.equal(validateInstructionPlan(plan).valid, true);
  const first = waiting(plan);
  const completionRequest = {
    actionId: first.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  } as const;
  const completed = completeAction(plan, first.snapshot, completionRequest);
  const second = run(plan, completed.snapshot);
  assert.equal(second.snapshot.status, "waiting");
  assert.notEqual(second.snapshot.lastSettlement, null);
  assert.equal(validateRuntimeSnapshot(second.snapshot, plan).valid, true);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, second.snapshot)),
  );
  assert.deepEqual(restored.snapshot, second.snapshot);

  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixture callbacks create impossible active/settled action identity and event chronology relations.
  const mutations: Array<(snapshot: any) => void> = [
    (snapshot) => {
      snapshot.lastSettlement.actionId = snapshot.foregroundAction.actionId + 1;
      snapshot.nextActionId = snapshot.lastSettlement.actionId + 1;
    },
    (snapshot) => {
      snapshot.lastSettlement.actionId = snapshot.foregroundAction.actionId;
    },
    (snapshot) => {
      snapshot.foregroundAction.requestEventSequence =
        snapshot.lastSettlement.completionEventSequence - 1;
    },
    (snapshot) => {
      snapshot.foregroundAction.requestEventSequence =
        snapshot.lastSettlement.completionEventSequence;
    },
  ];
  for (const mutate of mutations) {
    const hostile = structuredClone(second.snapshot);
    mutate(hostile);
    assert.equal(validateRuntimeSnapshot(hostile, plan).valid, false);
    assert.throws(() =>
      restoreCheckpoint({ ...createCheckpoint(plan, second.snapshot), snapshot: hostile }),
    );
  }
});

test("terminal button completion remains inspectable and continuation runs only on later entry", () => {
  const withExit = interactionPlan("button", {
    kind: "button",
    buttonLabel: "Done",
    accessibleName: defaults.button,
  });
  const plan = {
    ...withExit,
    rootEndInstruction: 1,
    instructions: withExit.instructions.slice(0, 1),
  };
  assert.equal(validateInstructionPlan(plan).valid, true);
  const pending = waiting(plan);
  const completionRequest = {
    actionId: pending.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  } as const;
  const completed = completeAction(plan, pending.snapshot, completionRequest);
  assert.equal(completed.snapshot.status, "running");
  assert.equal(validateRuntimeSnapshot(completed.snapshot, plan).valid, true);
  assert.deepEqual(
    completed.events.map((event) => event.kind),
    ["playerTranscript", "actionCompleted"],
  );
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, completed.snapshot)),
  );
  const resumed = run(restored.plan, restored.snapshot);
  assert.equal(resumed.snapshot.status, "halted");
  assert.equal(validateRuntimeSnapshot(resumed.snapshot, plan).valid, true);
  assert.deepEqual(
    resumed.events.map((event) => event.kind),
    ["complete"],
  );
});

test("result-bearing interactions require an in-region continuation while function continuations cleanly halt", () => {
  for (const [kind, ui, payload] of [
    [
      "text",
      { kind: "text", hint: null, accessibleName: defaults.text },
      { kind: "submittedText", submittedText: "value" },
    ],
    [
      "number",
      { kind: "number", hint: null, accessibleName: defaults.number },
      { kind: "submittedText", submittedText: "1" },
    ],
    [
      "choice",
      {
        kind: "choice",
        labelType: "none",
        options: [{ text: "One", label: null }],
        accessibleName: defaults.choice,
      },
      { kind: "selectedText", selectedText: "One" },
    ],
  ] as const) {
    const root = interactionPlan(kind, ui);
    const terminalRoot = {
      ...root,
      rootEndInstruction: 1,
      instructions: root.instructions.slice(0, 1),
    };
    assert.equal(validateInstructionPlan(terminalRoot).valid, false, kind);
    assert.throws(() => run(terminalRoot, createFreshRuntimeSnapshot(terminalRoot)), kind);

    const base = buttonPlanFromSource("function prompt { wait 1\nreturn }\nprompt()\nexit");
    const interactionIndex = base.instructions.findIndex(
      (instruction) => instruction.kind === "interaction",
    );
    const destinationTemporary = base.temporaryCount + 1;
    const instruction: InteractionInstruction = {
      kind: "interaction",
      interactionKind: kind,
      target: "standardChat",
      speaker: null,
      destinationTemporary,
      expectedResult: kind === "number" ? "number" : "string",
      ui,
      span: base.instructions[interactionIndex]!.span,
    };
    const instructions = base.instructions.map((candidate, index) =>
      index === interactionIndex ? instruction : candidate,
    );
    const functionPlan = { ...base, temporaryCount: destinationTemporary, instructions };
    assert.equal(validateInstructionPlan(functionPlan).valid, true, kind);
    const pending = waiting(functionPlan);
    const completionRequest = {
      actionId: pending.snapshot.foregroundAction!.actionId,
      actionKind: "interaction",
      interactionKind: kind,
      payload,
    } as const;
    const completed = completeAction(functionPlan, pending.snapshot, completionRequest);
    assert.equal(completed.outcome.kind, "completed", kind);
    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(functionPlan, completed.snapshot)),
    );
    const halted = run(restored.plan, restored.snapshot).snapshot;
    assert.equal(halted.status, "halted", kind);
    assert.equal(validateRuntimeSnapshot(halted, functionPlan).valid, true, kind);
  }
});

test("hostile completion objects reject before getters, mutation, events, or RNG advancement", () => {
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const pending = waiting(plan);
  let invoked = false;
  const request = {
    actionId: pending.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    get payload() {
      invoked = true;
      return {};
    },
  };
  const rejected = completeAction(plan, pending.snapshot, request);
  assert.equal(rejected.outcome.kind, "invalidPayload");
  assert.equal(invoked, false);
  assert.deepEqual(rejected.snapshot, pending.snapshot);
  assert.deepEqual(rejected.events, []);
});

test("interaction plan and checkpoint boundaries reject malformed option domains and hostile shapes", () => {
  const base = interactionPlan("choice", {
    kind: "choice",
    labelType: "identifier",
    options: [
      { text: "One", label: "one" },
      { text: "Two", label: "two" },
    ],
    accessibleName: defaults.choice,
  });
  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixture callbacks corrupt choice labels, label domain, result domain, and target with incompatible plan values.
  const mutations: Array<(plan: any) => void> = [
    (plan) => {
      plan.instructions[0].ui.options[1].label = "one";
    },
    (plan) => {
      plan.instructions[0].ui.options[1].label = 2;
    },
    (plan) => {
      plan.instructions[0].ui.labelType = "number";
    },
    (plan) => {
      plan.instructions[0].expectedResult = "number";
    },
    (plan) => {
      plan.instructions[0].target = "other";
    },
  ];
  for (const mutate of mutations) {
    const malformed = structuredClone(base);
    mutate(malformed);
    assert.equal(validateInstructionPlan(malformed).valid, false);
    assert.throws(() =>
      restoreCheckpoint({
        ...createCheckpoint(base, createFreshRuntimeSnapshot(base)),
        plan: malformed,
      }),
    );
  }
  const cyclic = structuredClone(base);
  const cyclicInteraction = cyclic.instructions[0];
  assert.ok(
    cyclicInteraction?.kind === "interaction" &&
      "ui" in cyclicInteraction &&
      cyclicInteraction.ui.kind === "choice" &&
      cyclicInteraction.ui.options[0] !== undefined,
  );
  // EVIDENCE: fixture adds one cyclic option field to test recursive plan rejection.
  (
    cyclicInteraction.ui.options[0] as (typeof cyclicInteraction.ui.options)[0] & {
      cycle?: unknown;
    }
  ).cycle = cyclic;
  assert.equal(validateInstructionPlan(cyclic).valid, false);
  const sparse = structuredClone(base);
  const sparseInteraction = sparse.instructions[0];
  assert.ok(
    sparseInteraction?.kind === "interaction" &&
      "ui" in sparseInteraction &&
      sparseInteraction.ui.kind === "choice",
  );
  // EVIDENCE: fixture deletes the first array slot to create a sparse choice-option array.
  Reflect.deleteProperty(sparseInteraction.ui.options, "0");
  assert.equal(validateInstructionPlan(sparse).valid, false);
  let invoked = false;
  const accessor = structuredClone(base);
  const accessorInteraction = accessor.instructions[0];
  assert.ok(
    accessorInteraction?.kind === "interaction" &&
      "ui" in accessorInteraction &&
      accessorInteraction.ui.kind === "choice",
  );
  Object.defineProperty(accessorInteraction.ui, "options", {
    enumerable: true,
    get() {
      invoked = true;
      return [];
    },
  });
  assert.equal(validateInstructionPlan(accessor).valid, false);
  assert.equal(invoked, false);
});

test("interaction ownership survives active call, scope, and loop frames", () => {
  for (const plan of [
    buttonPlanFromSource("function prompt { wait 1\nreturn }\nprompt()\nexit"),
    buttonPlanFromSource("repeat 1 { wait 1 }\nexit"),
  ]) {
    const pending = waiting(plan);
    const action = pending.snapshot.foregroundAction!;
    if (pending.snapshot.callFrames.length > 0)
      assert.equal(action.ownerCallFrameId, pending.snapshot.callFrames.at(-1)!.id);
    assert.equal(action.scopeDepth, pending.snapshot.frames.length);
    assert.equal(action.loopDepth, pending.snapshot.loopFrames.length);
    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(plan, pending.snapshot)),
    );
    const completionRequest = {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: "button",
      payload: { kind: "activate" },
    } as const;
    const completed = completeAction(restored.plan, restored.snapshot, completionRequest);
    assert.equal(completed.outcome.kind, "completed");
    assert.equal(run(restored.plan, completed.snapshot).snapshot.status, "halted");
  }
});

test("one multibyte per-string failure stops all later interaction UTF-8 measurement", () => {
  const base = interactionPlan("choice", {
    kind: "choice",
    labelType: "none",
    options: [{ text: "ok", label: null }],
    accessibleName: defaults.choice,
  });
  const overLimit = "\u20ac".repeat(30_000);
  assert.ok(overLimit.length <= MAX_INTERACTION_STRING_UTF8_BYTES);
  assert.ok(interactionUtf8ByteLength(overLimit) > MAX_INTERACTION_STRING_UTF8_BYTES);
  const hostile = structuredClone(base);
  const hostileInteraction = hostile.instructions[0];
  assert.ok(
    hostileInteraction?.kind === "interaction" &&
      "ui" in hostileInteraction &&
      hostileInteraction.ui.kind === "choice",
  );
  // EVIDENCE: fixture replaces only the choice options with per-string oversized values.
  Object.assign(hostileInteraction.ui, {
    options: Array.from({ length: MAX_INTERACTION_OPTION_ENTRIES }, () => ({
      text: overLimit,
      label: null,
    })),
  });
  const planStats = withValidationTestStatistics((finish) => {
    assert.equal(validateInstructionPlan(hostile).valid, false);
    return finish();
  });
  assert.equal(planStats.counts.interactionUtf8Measurements, 1);

  const pending = waiting(base);
  const hostileSnapshot = structuredClone(pending.snapshot);
  assert.ok(
    hostileSnapshot.foregroundAction?.kind === "interaction" &&
      hostileSnapshot.foregroundAction.ui.kind === "choice",
  );
  // EVIDENCE: fixture copies the oversized option array into persisted interaction UI.
  (
    hostileSnapshot.foregroundAction.ui as { options: typeof hostileInteraction.ui.options }
  ).options = hostileInteraction.ui.options;
  const snapshotStats = withValidationTestStatistics((finish) => {
    assert.equal(validateRuntimeSnapshot(hostileSnapshot).valid, false);
    return finish();
  });
  assert.equal(snapshotStats.counts.interactionUtf8Measurements, 1);
});

test("numeric settlement destinations distinguish canonical zero from negative zero", () => {
  for (const [plan, payload, kind] of [
    [
      interactionPlan("number", { kind: "number", hint: null, accessibleName: defaults.number }),
      { kind: "submittedText", submittedText: "-0" },
      "number",
    ],
    [
      interactionPlan("choice", {
        kind: "choice",
        labelType: "number",
        options: [{ text: "Zero", label: 0 }],
        accessibleName: defaults.choice,
      }),
      { kind: "selectedLabel", selectedLabel: 0 },
      "choice",
    ],
  ] as const) {
    const completed = complete(plan, payload, kind);
    assert.equal(Object.is(completed.snapshot.temporaries[0]?.value, -0), false);
    assert.equal(validateRuntimeSnapshot(completed.snapshot, plan).valid, true);
    const hostile = structuredClone(completed.snapshot);
    assert.ok(hostile.temporaries[0] !== undefined);
    hostile.temporaries[0].value = -0;
    assert.equal(validateRuntimeSnapshot(hostile, plan).valid, false);
    assert.throws(() => createCheckpoint(plan, hostile));
    assert.throws(() =>
      restoreCheckpoint({ ...createCheckpoint(plan, completed.snapshot), snapshot: hostile }),
    );

    const roundTrip = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(plan, completed.snapshot)),
    );
    assert.equal(Object.is(roundTrip.snapshot.temporaries[0]?.value, -0), false);
    assert.equal(run(roundTrip.plan, roundTrip.snapshot).snapshot.status, "halted");
  }
});

test("completed text settlements retain only canonical non-whitespace LF text", () => {
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const completed = complete(
    plan,
    { kind: "submittedText", submittedText: "value" },
    "text",
  ).snapshot;
  for (const text of ["", " \t\n", "\rvalue", "value\r\n"]) {
    const hostile = structuredClone(completed);
    assert.ok(hostile.lastSettlement?.actionKind === "interaction");
    assert.ok(hostile.temporaries[0] !== undefined);
    // EVIDENCE: fixture replaces only the retained text result and transcript with the candidate malformed text.
    const hostileSettlement = hostile.lastSettlement as {
      result: string | number | null;
      transcriptText: string | null;
    };
    hostileSettlement.result = text;
    hostileSettlement.transcriptText = text;
    hostile.temporaries[0].value = text;
    assert.equal(validateRuntimeSnapshot(hostile).valid, false, JSON.stringify(text));
    assert.equal(validateRuntimeSnapshot(hostile, plan).valid, false, JSON.stringify(text));
    assert.throws(
      () => restoreCheckpoint({ ...createCheckpoint(plan, completed), snapshot: hostile }),
      JSON.stringify(text),
    );
    assert.throws(() => run(plan, hostile), JSON.stringify(text));
  }
});

test("pending actions reserve their complete event sequence capacity", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const interaction = interactionPlan("text", {
    kind: "text",
    hint: null,
    accessibleName: defaults.text,
  });
  const exactInteraction = createFreshRuntimeSnapshot(interaction);
  exactInteraction.nextEventSequence = max - 3;
  const pendingInteraction = run(interaction, exactInteraction);
  assert.equal(pendingInteraction.snapshot.status, "waiting");
  assert.equal(pendingInteraction.snapshot.nextEventSequence, max - 2);
  assert.doesNotThrow(() => createCheckpoint(interaction, pendingInteraction.snapshot));
  const completedInteraction = completeAction(interaction, pendingInteraction.snapshot, {
    actionId: pendingInteraction.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "ok" },
  });
  assert.equal(completedInteraction.outcome.kind, "completed");
  assert.equal(completedInteraction.snapshot.nextEventSequence, max);
  const impossibleCompletion = structuredClone(pendingInteraction.snapshot);
  impossibleCompletion.nextEventSequence = max - 1;
  const impossibleBefore = structuredClone(impossibleCompletion);
  assert.equal(validateRuntimeSnapshot(impossibleCompletion, interaction).valid, false);
  assert.throws(() => createCheckpoint(interaction, impossibleCompletion));
  assert.ok(impossibleCompletion.foregroundAction?.kind === "interaction");
  const impossibleRequest = {
    actionId: impossibleCompletion.foregroundAction.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "no write" },
  };
  assert.throws(() => completeAction(interaction, impossibleCompletion, impossibleRequest));
  assert.deepEqual(impossibleCompletion, impossibleBefore);
  assert.deepEqual(impossibleCompletion.temporaries, []);

  const exhaustedInteraction = createFreshRuntimeSnapshot(interaction);
  exhaustedInteraction.nextEventSequence = max - 2;
  const beforeInteraction = structuredClone(exhaustedInteraction);
  const failedInteraction = run(interaction, exhaustedInteraction);
  assert.deepEqual(exhaustedInteraction, beforeInteraction);
  assert.equal(failedInteraction.snapshot.status, "failed");
  assert.equal(failedInteraction.snapshot.foregroundAction, null);
  assert.equal(failedInteraction.snapshot.nextActionId, beforeInteraction.nextActionId);
  assert.deepEqual(failedInteraction.snapshot.temporaries, []);

  const delayPlan = compileSource("wait 1\nexit").plan!;
  const exactDelay = createFreshRuntimeSnapshot(delayPlan);
  exactDelay.nextEventSequence = max - 2;
  const pendingDelay = run(delayPlan, exactDelay);
  assert.equal(pendingDelay.snapshot.status, "waiting");
  assert.equal(pendingDelay.snapshot.nextEventSequence, max - 1);
  assert.doesNotThrow(() => createCheckpoint(delayPlan, pendingDelay.snapshot));
  const completedDelay = observeTime(delayPlan, pendingDelay.snapshot, 1_000);
  assert.equal(completedDelay.outcome.kind, "observed");
  assert.equal(completedDelay.snapshot.nextEventSequence, max);

  const exhaustedDelay = createFreshRuntimeSnapshot(delayPlan);
  exhaustedDelay.nextEventSequence = max - 1;
  const beforeDelay = structuredClone(exhaustedDelay);
  const failedDelay = run(delayPlan, exhaustedDelay);
  assert.deepEqual(exhaustedDelay, beforeDelay);
  assert.equal(failedDelay.snapshot.status, "failed");
  assert.equal(failedDelay.snapshot.foregroundAction, null);
  assert.equal(failedDelay.snapshot.nextActionId, beforeDelay.nextActionId);
});

test("unsupported persisted interaction fields are rejected at every boundary", () => {
  const huge = "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES * 16);
  const base = interactionPlan("choice", {
    kind: "choice",
    labelType: "identifier",
    options: [{ text: "One", label: "one" }],
    accessibleName: defaults.choice,
  });
  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixture callbacks add unsupported fields at the interaction, UI, accessible-name, and option levels.
  const planMutations: Array<(instruction: any) => void> = [
    (instruction) => {
      instruction.extra = huge;
    },
    (instruction) => {
      instruction.ui.extra = huge;
    },
    (instruction) => {
      instruction.ui.accessibleName.extra = huge;
    },
    (instruction) => {
      instruction.ui.options[0].extra = huge;
    },
  ];
  for (const mutate of planMutations) {
    const hostile = structuredClone(base);
    mutate(hostile.instructions[0]);
    assert.equal(validateInstructionPlan(hostile).valid, false);
    assert.throws(() => run(hostile, createFreshRuntimeSnapshot(base)));
  }

  const pending = waiting(base);
  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixture callbacks add unsupported persisted fields at the action, UI, accessible-name, and option levels.
  const snapshotMutations: Array<(snapshot: any) => void> = [
    (snapshot) => {
      snapshot.foregroundAction.extra = huge;
    },
    (snapshot) => {
      snapshot.foregroundAction.ui.extra = huge;
    },
    (snapshot) => {
      snapshot.foregroundAction.ui.accessibleName.extra = huge;
    },
    (snapshot) => {
      snapshot.foregroundAction.ui.options[0].extra = huge;
    },
  ];
  for (const mutate of snapshotMutations) {
    const hostile = structuredClone(pending.snapshot);
    mutate(hostile);
    assert.equal(validateRuntimeSnapshot(hostile, base).valid, false);
    assert.throws(() =>
      restoreCheckpoint({ ...createCheckpoint(base, pending.snapshot), snapshot: hostile }),
    );
    const completionRequest = {
      actionId: pending.snapshot.foregroundAction!.actionId,
      actionKind: "interaction",
      interactionKind: "choice",
      payload: { kind: "selectedLabel", selectedLabel: "one" },
    } as const;
    assert.throws(() => completeAction(base, hostile, completionRequest));
  }

  const completed = complete(base, { kind: "selectedLabel", selectedLabel: "one" }, "choice");
  const settlementHostile = structuredClone(completed.snapshot);
  assert.ok(settlementHostile.lastSettlement?.actionKind === "interaction");
  // EVIDENCE: fixture adds one unsupported field to a completed interaction settlement.
  (
    settlementHostile.lastSettlement as typeof settlementHostile.lastSettlement & { extra?: string }
  ).extra = huge;
  assert.equal(validateRuntimeSnapshot(settlementHostile, base).valid, false);
  assert.throws(() =>
    restoreCheckpoint({
      ...createCheckpoint(base, completed.snapshot),
      snapshot: settlementHostile,
    }),
  );
  const settlementCompletionRequest = {
    actionId: completed.snapshot.lastSettlement!.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "selectedLabel", selectedLabel: "one" },
  } as const;
  assert.throws(() => completeAction(base, settlementHostile, settlementCompletionRequest));

  const requested = pending.events.find((event) => event.kind === "actionRequested")!;
  assert.equal(
    requested.kind === "actionRequested" && Object.hasOwn(requested.action, "extra"),
    false,
  );
  const duplicate = completeAction(base, completed.snapshot, settlementCompletionRequest);
  assert.equal(duplicate.outcome.kind, "alreadySettled");
  assert.equal(
    duplicate.outcome.kind === "alreadySettled" &&
      Object.hasOwn(duplicate.outcome.settlement, "extra"),
    false,
  );

  const delayPlan = compileSource("wait 1\nexit").plan!;
  const delayPending = run(delayPlan, createFreshRuntimeSnapshot(delayPlan));
  const delayActionHostile = structuredClone(delayPending.snapshot);
  assert.ok(delayActionHostile.foregroundAction?.kind === "delay");
  // EVIDENCE: fixture adds one unsupported field to a pending delay action.
  (
    delayActionHostile.foregroundAction as typeof delayActionHostile.foregroundAction & {
      extra?: string;
    }
  ).extra = huge;
  assert.equal(validateRuntimeSnapshot(delayActionHostile, delayPlan).valid, false);
  assert.throws(() =>
    restoreCheckpoint({
      ...createCheckpoint(delayPlan, delayPending.snapshot),
      snapshot: delayActionHostile,
    }),
  );
  const delayCompleted = observeTime(delayPlan, delayPending.snapshot, 1_000);
  const delaySettlementHostile = structuredClone(delayCompleted.snapshot);
  assert.ok(delaySettlementHostile.lastSettlement?.actionKind === "delay");
  // EVIDENCE: fixture adds one unsupported field to a completed delay settlement.
  (
    delaySettlementHostile.lastSettlement as typeof delaySettlementHostile.lastSettlement & {
      extra?: string;
    }
  ).extra = huge;
  assert.equal(validateRuntimeSnapshot(delaySettlementHostile, delayPlan).valid, false);
  assert.throws(() =>
    restoreCheckpoint({
      ...createCheckpoint(delayPlan, delayCompleted.snapshot),
      snapshot: delaySettlementHostile,
    }),
  );
});

test("pending result destinations are absent in root, function, and loop execution", () => {
  const root = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const rootInteraction = root.instructions[0];
  assert.ok(rootInteraction?.kind === "interaction" && "ui" in rootInteraction);
  const functionPlan = (() => {
    const plan = buttonPlanFromSource("function prompt { wait 1\nreturn }\nprompt()\nexit");
    const index = plan.instructions.findIndex((instruction) => instruction.kind === "interaction");
    const destinationTemporary = plan.temporaryCount + 1;
    const replacement = (instruction: (typeof plan.instructions)[number]) => ({
      ...rootInteraction,
      span: instruction.span,
      destinationTemporary,
    });
    const instructions = plan.instructions.map((instruction, instructionIndex) =>
      instructionIndex === index ? replacement(instruction) : instruction,
    );
    // EVIDENCE: replacement preserves every plan field and substitutes one typed interaction instruction.
    return { ...plan, temporaryCount: destinationTemporary, instructions } as InstructionPlan;
  })();
  const loopPlan = (() => {
    const plan = buttonPlanFromSource("repeat 1 { wait 1 }\nexit");
    const index = plan.instructions.findIndex((instruction) => instruction.kind === "interaction");
    const replacement = (instruction: (typeof plan.instructions)[number]) => ({
      ...rootInteraction,
      span: instruction.span,
    });
    const instructions = plan.instructions.map((instruction, instructionIndex) =>
      instructionIndex === index ? replacement(instruction) : instruction,
    );
    const result = structuredClone({ ...plan, temporaryCount: 1, instructions });
    const interactionAtIndex = result.instructions[index];
    assert.ok(interactionAtIndex !== undefined);
    result.instructions.splice(index + 1, 0, {
      kind: "clearTemporary",
      temporaryId: 1,
      span: interactionAtIndex.span,
    });
    result.rootEndInstruction += 1;
    const rootEntry = result.instructions[0];
    assert.ok(rootEntry !== undefined && "target" in rootEntry);
    // EVIDENCE: fixture shifts only the root control-flow target after inserting one instruction.
    (rootEntry as { target: number }).target += 1;
    // EVIDENCE: result preserves the source plan and adds one typed clearTemporary after its interaction.
    return result as InstructionPlan;
  })();
  for (const plan of [root, functionPlan, loopPlan]) {
    assert.equal(
      validateInstructionPlan(plan).valid,
      true,
      JSON.stringify(validateInstructionPlan(plan).errors),
    );
    const pending = waiting(plan);
    assert.ok(pending.snapshot.foregroundAction?.kind === "interaction");
    const destination = pending.snapshot.foregroundAction.destinationTemporary;
    assert.ok(destination !== null);
    const hostile = structuredClone(pending.snapshot);
    hostile.temporaries.push({ id: destination, value: "old" });
    assert.equal(validateRuntimeSnapshot(hostile).valid, false);
    assert.equal(validateRuntimeSnapshot(hostile, plan).valid, false);
    assert.throws(() =>
      restoreCheckpoint({ ...createCheckpoint(plan, pending.snapshot), snapshot: hostile }),
    );
    const completionRequest = {
      actionId: pending.snapshot.foregroundAction!.actionId,
      actionKind: "interaction",
      interactionKind: "text",
      payload: { kind: "submittedText", submittedText: "new" },
    } as const;
    const completed = completeAction(plan, pending.snapshot, completionRequest);
    assert.equal(completed.outcome.kind, "completed");
    assert.equal(
      completed.snapshot.temporaries.find((temporary) => temporary.id === destination)?.value,
      "new",
    );
  }
});

test("accepted text completions perform one bounded UTF-8 measurement before normalization", () => {
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  for (const submittedText of ["ordinary", "a\r\nb\rc"]) {
    const pending = waiting(plan);
    const stats = withValidationTestStatistics((finish) => {
      const completionRequest = {
        actionId: pending.snapshot.foregroundAction!.actionId,
        actionKind: "interaction",
        interactionKind: "text",
        payload: { kind: "submittedText", submittedText },
      } as const;
      const completed = completeAction(plan, pending.snapshot, completionRequest);
      assert.equal(completed.outcome.kind, "completed");
      return finish();
    });
    assert.equal(stats.counts.interactionUtf8Measurements, 1, JSON.stringify(submittedText));
  }
});
