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
  InteractionChoiceOption,
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
import { executeInstruction, run } from "../src/runtime/engine.js";
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
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

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

/** A runtime-produced completion after its handoff was consumed, so no handoff or destination remains. */
function consumedCompletion(
  plan: InstructionPlan,
  payload: unknown,
  interactionKind: InteractionInstruction["interactionKind"],
): RuntimeSnapshot {
  const completed = complete(plan, payload, interactionKind);
  assert.equal(completed.outcome.kind, "completed");
  const consumed = run(plan, completed.snapshot).snapshot;
  assert.equal(consumed.interactionResultHandoff, null);
  assert.deepEqual(consumed.temporaries, []);
  assert.equal(consumed.lastSettlement?.actionKind, "interaction");
  assert.equal(validateRuntimeSnapshot(consumed).valid, true);
  assert.equal(validateRuntimeSnapshot(consumed, plan).valid, true);
  return consumed;
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

/** One choice UI per result domain; the identifier labels share visible text to expose ambiguity. */
const choiceUis = {
  unlabelled: {
    kind: "choice",
    labelType: "none",
    options: [
      { text: "Alpha", label: null },
      { text: "Beta", label: null },
    ],
    accessibleName: defaults.choice,
  },
  identifier: {
    kind: "choice",
    labelType: "identifier",
    options: [
      { text: "Same", label: "first" },
      { text: "Same", label: "second" },
    ],
    accessibleName: defaults.choice,
  },
  numeric: {
    kind: "choice",
    labelType: "number",
    options: [
      { text: "One", label: 1 },
      { text: "Two", label: 2 },
    ],
    accessibleName: defaults.choice,
  },
} as const satisfies Record<string, InteractionUiPayload>;

test("choice supports unlabelled, identifier, numeric, exact typed, and ambiguous labelled behavior", () => {
  const unlabelled = interactionPlan("choice", choiceUis.unlabelled);
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

  const labelled = interactionPlan("choice", choiceUis.identifier);
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

  const numeric = interactionPlan("choice", choiceUis.numeric);
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
    [choiceUis.unlabelled, { kind: "selectedText", selectedText: "Beta" }],
    [choiceUis.identifier, { kind: "selectedLabel", selectedLabel: "second" }],
    [choiceUis.numeric, { kind: "selectedLabel", selectedLabel: 2 }],
  ] as const;
  for (const [ui, payload] of cases) {
    const completed = complete(interactionPlan("choice", ui), payload, "choice");
    assert.equal(validateRuntimeSnapshot(completed.snapshot).valid, true);
    for (const malformedResult of [null, { kind: "object", properties: [] }, -0]) {
      const malformed: any = structuredClone(completed.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture rewrites the interaction result across settlement, handoff, and destination to values excluded by the canonical snapshot type.
      malformed.lastSettlement.result = malformedResult;
      malformed.interactionResultHandoff.result = malformedResult;
      malformed.temporaries[0].value = malformedResult;
      assert.equal(validateRuntimeSnapshot(malformed).valid, false);
    }
  }
  const identifierPlan = interactionPlan("choice", choiceUis.identifier);
  const identifier = complete(identifierPlan, cases[1][1], "choice");
  const wrongForExactPlan: any = structuredClone(identifier.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture changes an identifier-labelled result to the numeric domain for exact-plan validation.
  wrongForExactPlan.lastSettlement.result = 1;
  wrongForExactPlan.interactionResultHandoff.result = 1;
  wrongForExactPlan.temporaries[0].value = 1;
  assert.equal(validateRuntimeSnapshot(wrongForExactPlan).valid, true);
  assert.equal(validateRuntimeSnapshot(wrongForExactPlan, identifierPlan).valid, false);
  const wrongChoiceDestination: any = structuredClone(identifier.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture makes the stored destination disagree with its retained choice settlement.
  wrongChoiceDestination.temporaries[0].value = "other";
  assert.equal(validateRuntimeSnapshot(wrongChoiceDestination, identifierPlan).valid, false);
});

test("numeric interaction results store canonical zero and reject negative zero at every boundary", () => {
  const numberPlan = interactionPlan("number", {
    kind: "number",
    hint: null,
    accessibleName: defaults.number,
  });
  const zeroChoicePlan = interactionPlan("choice", {
    kind: "choice",
    labelType: "number",
    options: [{ text: "Zero", label: 0 }],
    accessibleName: defaults.choice,
  });
  const negativeZeroPlan: any = structuredClone(zeroChoicePlan); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture injects negative zero into a numeric choice label rejected by plan validation.
  negativeZeroPlan.instructions[0].ui.options[0].label = -0;
  assert.equal(validateInstructionPlan(negativeZeroPlan).valid, false);
  const pending = waiting(zeroChoicePlan);
  const negativeZeroAction: any = structuredClone(pending.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture injects negative zero into persisted choice UI data rejected by snapshot validation.
  negativeZeroAction.foregroundAction.ui.options[0].label = -0;
  assert.equal(validateRuntimeSnapshot(negativeZeroAction).valid, false);
  assert.equal(validateRuntimeSnapshot(negativeZeroAction, zeroChoicePlan).valid, false);

  // Host negative zero resolves to the stored canonical zero; an Object.is-sensitive
  // negative-zero destination is rejected where ordinary equality would accept it.
  for (const [plan, payload, kind] of [
    [numberPlan, { kind: "submittedText", submittedText: "-0" }, "number"],
    [zeroChoicePlan, { kind: "selectedLabel", selectedLabel: -0 }, "choice"],
    [zeroChoicePlan, { kind: "submittedText", submittedText: "Zero" }, "choice"],
  ] as const) {
    const label = JSON.stringify(payload);
    const completed = complete(plan, payload, kind);
    assert.ok(completed.snapshot.lastSettlement?.actionKind === "interaction", label);
    assert.ok(Object.is(completed.snapshot.lastSettlement.result, 0), label);
    assert.ok(Object.is(completed.snapshot.temporaries[0]?.value, 0), label);
    assert.equal(validateRuntimeSnapshot(completed.snapshot, plan).valid, true, label);
    const hostile = structuredClone(completed.snapshot);
    assert.ok(hostile.temporaries[0] !== undefined);
    hostile.temporaries[0].value = -0;
    assert.equal(validateRuntimeSnapshot(hostile, plan).valid, false, label);
    assert.throws(() => createCheckpoint(plan, hostile), label);
    assert.throws(
      () => restoreCheckpoint({ ...createCheckpoint(plan, completed.snapshot), snapshot: hostile }),
      label,
    );
    const roundTrip = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(plan, completed.snapshot)),
    );
    assert.ok(roundTrip.snapshot.lastSettlement?.actionKind === "interaction", label);
    assert.ok(Object.is(roundTrip.snapshot.lastSettlement.result, 0), label);
    assert.ok(Object.is(roundTrip.snapshot.temporaries[0]?.value, 0), label);
    assert.equal(run(roundTrip.plan, roundTrip.snapshot).snapshot.status, "halted", label);
  }
});

test("wrong-kind and over-limit completions reject without mutating canonical state", () => {
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const pending = waiting(plan);
  const actionId = pending.snapshot.foregroundAction!.actionId;
  const before = structuredClone(pending.snapshot);
  for (const [expected, request] of [
    [
      "wrongActionKind",
      { actionId, actionKind: "delay", payload: { kind: "time", currentSessionTimeMs: 1 } },
    ],
    [
      "invalidPayload",
      {
        actionId,
        actionKind: "interaction",
        interactionKind: "text",
        payload: {
          kind: "submittedText",
          submittedText: "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES + 1),
        },
      },
    ],
  ] as const) {
    const result = completeAction(plan, pending.snapshot, request);
    assert.equal(result.outcome.kind, expected);
    assert.deepEqual(result.events, [], expected);
    assert.deepEqual(result.snapshot, before, expected);
    assert.deepEqual(pending.snapshot, before, `${expected}: input`);
  }
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
  const exact = interactionPlan("button", {
    kind: "button",
    buttonLabel: "x".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES),
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
  // EVIDENCE: fixture extends only the button label beyond the aggregate byte limit.
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

test("malformed pending interaction snapshot data is rejected", () => {
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

test("consumed interaction settlements enforce intrinsic text and number semantics at every boundary", () => {
  // Consumed snapshots have no handoff or destination left to disagree with a mutated settlement,
  // so each row can be rejected only by the intrinsic transcript/result rule it names.
  const textPlan = interactionPlan("text", {
    kind: "text",
    hint: null,
    accessibleName: defaults.text,
  });
  const numberPlan = interactionPlan("number", {
    kind: "number",
    hint: null,
    accessibleName: defaults.number,
  });
  const text = consumedCompletion(
    textPlan,
    { kind: "submittedText", submittedText: "answer" },
    "text",
  );
  const number = consumedCompletion(
    numberPlan,
    { kind: "submittedText", submittedText: "1e1" },
    "number",
  );
  const rows = [
    ["text result differs from transcript", textPlan, text, "different", "answer"],
    ["empty text", textPlan, text, "", ""],
    ["whitespace-only text", textPlan, text, " \t\n", " \t\n"],
    ["text with CR", textPlan, text, "\rvalue", "\rvalue"],
    ["text with CRLF", textPlan, text, "value\r\n", "value\r\n"],
    ["non-numeric transcript", numberPlan, number, 10, "nonsense"],
    ["hexadecimal transcript", numberPlan, number, 16, "0x10"],
    ["line-separator transcript", numberPlan, number, 1, "1\u2028"],
    ["result differs from parsed transcript", numberPlan, number, 11, "1e1"],
    ["negative-zero result", numberPlan, number, -0, "-0"],
  ] as const;
  for (const [name, plan, consumed, result, transcript] of rows) {
    const hostile = structuredClone(consumed);
    assert.ok(hostile.lastSettlement?.actionKind === "interaction", name);
    // EVIDENCE: fixture replaces only the retained settlement result and transcript text.
    const settlement = hostile.lastSettlement as {
      result: string | number | null;
      transcriptText: string | null;
    };
    settlement.result = result;
    settlement.transcriptText = transcript;
    assert.equal(validateRuntimeSnapshot(hostile).valid, false, name);
    assert.equal(validateRuntimeSnapshot(hostile, plan).valid, false, name);
    assert.throws(
      () => restoreCheckpoint({ ...createCheckpoint(plan, consumed), snapshot: hostile }),
      name,
    );
    assert.throws(() => run(plan, hostile), name);
  }
});

/** A validated-plan-only speaker reference: compact source accepts only declared speakers here. */
function withInteractionSpeaker(plan: InstructionPlan, speaker: string): InstructionPlan {
  return {
    ...plan,
    instructions: plan.instructions.map((instruction) =>
      instruction.kind === "interaction" ? { ...instruction, speaker } : instruction,
    ),
  };
}

test("pending interaction speaker provenance is bound to the instructed speaker", () => {
  const speakers = "speaker alice {}\nspeaker bob {}\nspeaker alice\n";
  const explicitPlan = compileValidPlan(`${speakers}showButton as alice "Continue"\nexit`);
  const pending = waiting(explicitPlan);
  const bob = pending.snapshot.speakers.find((speaker) => speaker.identifier === "bob")!;
  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixture helpers corrupt persisted speaker bindings and action speaker IDs with values outside the snapshot type.
  type HostileSnapshot = any;
  const aliceBinding = (snapshot: HostileSnapshot) => {
    const binding = snapshot.frames
      .flatMap((frame: RuntimeScopeFrameSnapshot) => frame.bindings)
      .find((candidate: RuntimeBindingSnapshot) => candidate.name === "alice");
    assert.ok(binding?.value?.kind === "speakerReference");
    return binding;
  };

  // A coherent rebinding of `alice` to bob, resolved by the action, remains valid.
  const rebound: HostileSnapshot = structuredClone(pending.snapshot);
  aliceBinding(rebound).value.speakerId = bob.id;
  rebound.foregroundAction.speakerId = bob.id;
  assert.equal(validateRuntimeSnapshot(rebound, explicitPlan).valid, true);

  const rejected: readonly [string, (snapshot: HostileSnapshot) => void][] = [
    ["action names another speaker", (snapshot) => (snapshot.foregroundAction.speakerId = bob.id)],
    [
      "speaker identifiers swapped",
      (snapshot) => {
        const alice = snapshot.speakers.find(
          (speaker: { identifier: string }) => speaker.identifier === "alice",
        );
        const swappedBob = snapshot.speakers.find(
          (speaker: { identifier: string }) => speaker.identifier === "bob",
        );
        [alice.identifier, swappedBob.identifier] = [swappedBob.identifier, alice.identifier];
        snapshot.foregroundAction.speakerId = swappedBob.id;
      },
    ],
    [
      "binding names another speaker",
      (snapshot) => (aliceBinding(snapshot).value.speakerId = bob.id),
    ],
    [
      "binding removed",
      (snapshot) => {
        const frame = snapshot.frames.find((candidate: RuntimeScopeFrameSnapshot) =>
          candidate.bindings.some((binding) => binding.name === "alice"),
        );
        frame.bindings = frame.bindings.filter(
          (binding: RuntimeBindingSnapshot) => binding.name !== "alice",
        );
        snapshot.foregroundAction.speakerId = null;
      },
    ],
    [
      "binding is not a speaker",
      (snapshot) => {
        aliceBinding(snapshot).value = "ordinary";
        snapshot.foregroundAction.speakerId = null;
      },
    ],
    [
      "binding speaker ID is malformed",
      (snapshot) => {
        aliceBinding(snapshot).value.speakerId = "bad";
        snapshot.foregroundAction.speakerId = null;
      },
    ],
    [
      "binding speaker is unknown",
      (snapshot) => {
        aliceBinding(snapshot).value.speakerId = 999;
        snapshot.foregroundAction.speakerId = null;
      },
    ],
    ["action speaker missing", (snapshot) => (snapshot.foregroundAction.speakerId = null)],
  ];
  for (const [name, mutate] of rejected) {
    const hostile: HostileSnapshot = structuredClone(pending.snapshot);
    mutate(hostile);
    assert.equal(validateRuntimeSnapshot(hostile, explicitPlan).valid, false, name);
    assert.throws(
      () =>
        restoreCheckpoint({
          ...createCheckpoint(explicitPlan, pending.snapshot),
          snapshot: hostile,
        }),
      name,
    );
  }

  const defaultPlan = compileValidPlan(`${speakers}showButton "Continue"\nexit`);
  const defaultPending = waiting(defaultPlan);
  const alice = defaultPending.snapshot.speakers.find((speaker) => speaker.identifier === "alice");
  assert.equal(defaultPending.snapshot.defaultSpeaker, alice?.id);
  const defaultAction = defaultPending.snapshot.foregroundAction;
  assert.ok(defaultAction?.kind === "interaction");
  assert.equal(defaultAction.speakerId, alice?.id);
  const wrongDefault: HostileSnapshot = structuredClone(defaultPending.snapshot);
  wrongDefault.foregroundAction.speakerId = bob.id;
  assert.equal(validateRuntimeSnapshot(wrongDefault, defaultPlan).valid, false);

  // Function scopes resolve a root-declared speaker and, in a validated plan, a speaker parameter.
  for (const [scoped, name] of [
    [
      compileValidPlan(
        'speaker alice {}\nfunction prompt { showButton as alice "Continue" }\nprompt()\nexit',
      ),
      "alice",
    ],
    [
      withInteractionSpeaker(
        compileValidPlan(
          'speaker alice {}\nspeaker bob {}\nfunction prompt(requested) { showButton "Continue" }\nprompt(bob)\nexit',
        ),
        "requested",
      ),
      "requested",
    ],
  ] as const) {
    assert.equal(validateInstructionPlan(scoped).valid, true, name);
    const scopedPending = waiting(scoped);
    const binding = scopedPending.snapshot.frames
      .slice()
      .reverse()
      .flatMap((frame) => frame.bindings)
      .find((candidate) => candidate.name === name);
    assert.ok(
      typeof binding?.value === "object" &&
        binding.value !== null &&
        binding.value.kind === "speakerReference",
      name,
    );
    const scopedAction = scopedPending.snapshot.foregroundAction;
    assert.ok(scopedAction?.kind === "interaction", name);
    assert.equal(scopedAction.speakerId, binding.value.speakerId, name);
    assert.equal(validateRuntimeSnapshot(scopedPending.snapshot, scoped).valid, true, name);
  }

  // The nearest scope's binding decides a validated plan's speaker reference.
  const nestedRun = compileValidPlan(
    'speaker root {}\nspeaker bob {}\nif true { showButton "Continue" }\nexit',
  );
  const nestedPlan = withInteractionSpeaker(nestedRun, "alice");
  const nested: HostileSnapshot = structuredClone(waiting(nestedRun).snapshot);
  const rootSpeaker = nested.speakers.find(
    (speaker: { identifier: string }) => speaker.identifier === "root",
  );
  const nestedBob = nested.speakers.find(
    (speaker: { identifier: string }) => speaker.identifier === "bob",
  );
  nested.frames[0].bindings.push({
    name: "alice",
    value: { kind: "speakerReference", speakerId: rootSpeaker.id, identifier: "root" },
  });
  nested.frames
    .at(-1)
    .bindings.push({
      name: "alice",
      value: { kind: "speakerReference", speakerId: nestedBob.id, identifier: "bob" },
    });
  nested.foregroundAction.speakerId = nestedBob.id;
  assert.equal(validateRuntimeSnapshot(nested, nestedPlan).valid, true);
  nested.foregroundAction.speakerId = rootSpeaker.id;
  assert.equal(validateRuntimeSnapshot(nested, nestedPlan).valid, false);
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

test("oversized accessible names and identifier labels are rejected at plan and snapshot boundaries", () => {
  const huge = "a".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES + 1);
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

  // Measurements made while the plan and planless snapshot reject the replacement options. A
  // trailing sentinel option would add measurements if validation continued after exhaustion.
  const rejectedMeasurements = (
    base: InstructionPlan,
    options: readonly InteractionChoiceOption[],
    label: string,
  ) => {
    const hostilePlan = structuredClone(base);
    const hostileInteraction = hostilePlan.instructions[0];
    assert.ok(
      hostileInteraction?.kind === "interaction" &&
        "ui" in hostileInteraction &&
        hostileInteraction.ui.kind === "choice",
      label,
    );
    // EVIDENCE: fixture replaces only the choice options of the validated plan.
    Object.assign(hostileInteraction.ui, { options });
    const planStats = withValidationTestStatistics((finish) => {
      assert.equal(validateInstructionPlan(hostilePlan).valid, false, label);
      return finish();
    });
    const hostileSnapshot = structuredClone(waiting(base).snapshot);
    assert.ok(hostileSnapshot.foregroundAction?.kind === "interaction", label);
    // EVIDENCE: fixture replaces only the persisted choice options of the pending interaction.
    Object.assign(hostileSnapshot.foregroundAction.ui, { options });
    const snapshotStats = withValidationTestStatistics((finish) => {
      assert.equal(validateRuntimeSnapshot(hostileSnapshot).valid, false, label);
      return finish();
    });
    return [
      planStats.counts.interactionUtf8Measurements,
      snapshotStats.counts.interactionUtf8Measurements,
    ];
  };
  // The first text fits the aggregate budget and the following label exceeds what remains.
  assert.deepEqual(
    rejectedMeasurements(
      accepted,
      [
        { text: "a".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES - 1), label: "bb" },
        { text: "sentinel", label: "sentinel" },
      ],
      "aggregate exhaustion",
    ),
    [2, 2],
  );
  // Three-byte characters pass the UTF-16 length precheck but exceed the budget once encoded.
  const multibyte = "€".repeat(Math.floor(MAX_INTERACTION_AGGREGATE_UTF8_BYTES / 3) + 1);
  assert.ok(multibyte.length <= MAX_INTERACTION_AGGREGATE_UTF8_BYTES);
  assert.ok(interactionUtf8ByteLength(multibyte) > MAX_INTERACTION_AGGREGATE_UTF8_BYTES);
  const unlabelled = interactionPlan("choice", {
    kind: "choice",
    labelType: "none",
    options: [{ text: "ok", label: null }],
    accessibleName: defaults.choice,
  });
  assert.deepEqual(
    rejectedMeasurements(
      unlabelled,
      [
        { text: multibyte, label: null },
        { text: "sentinel", label: null },
      ],
      "multibyte exhaustion",
    ),
    [1, 1],
  );
});

test("huge completion kind tokens are not reflected or allowed to mutate canonical state", () => {
  const plan = interactionPlan("button", {
    kind: "button",
    buttonLabel: "Continue",
    accessibleName: defaults.button,
  });
  const pending = waiting(plan);
  const actionId = pending.snapshot.foregroundAction!.actionId;
  const before = structuredClone(pending.snapshot);
  // Two different oversized lengths must yield bounded tokens whose length does not follow the input.
  for (const field of ["actionKind", "interactionKind"] as const) {
    const tokens = [16, 32].map((multiple) => {
      const huge = "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES * multiple);
      const request =
        field === "actionKind"
          ? { actionId, actionKind: huge }
          : { actionId, actionKind: "interaction", interactionKind: huge };
      const rejected = completeAction(plan, pending.snapshot, request);
      assert.ok(rejected.outcome.kind === "wrongActionKind", field);
      assert.deepEqual(rejected.events, [], field);
      assert.deepEqual(rejected.snapshot, before, field);
      return rejected.outcome.receivedActionKind;
    });
    assert.equal(tokens[0]!.length, tokens[1]!.length, field);
    assert.ok(tokens[0]!.length < MAX_INTERACTION_STRING_UTF8_BYTES, field);
  }
  assert.deepEqual(pending.snapshot, before);
});

test("a foreground action keeps identities distinct from the retained settlement", () => {
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

test("result-bearing interactions require an in-region continuation", () => {
  for (const [kind, ui] of [
    ["text", { kind: "text", hint: null, accessibleName: defaults.text }],
    ["number", { kind: "number", hint: null, accessibleName: defaults.number }],
    ["choice", choiceUis.unlabelled],
  ] as const) {
    const root = interactionPlan(kind, ui);
    const terminalRoot = {
      ...root,
      rootEndInstruction: 1,
      instructions: root.instructions.slice(0, 1),
    };
    assert.equal(validateInstructionPlan(terminalRoot).valid, false, kind);
    assert.throws(() => run(terminalRoot, createFreshRuntimeSnapshot(terminalRoot)), kind);
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
  const base = interactionPlan("choice", {
    kind: "choice",
    labelType: "identifier",
    options: [{ text: "One", label: "one" }],
    accessibleName: defaults.choice,
  });
  const pending = waiting(base);
  const completed = complete(base, { kind: "selectedLabel", selectedLabel: "one" }, "choice");
  const request = {
    actionId: pending.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "selectedLabel", selectedLabel: "one" },
  } as const;
  const assertSnapshotRejected = (
    plan: InstructionPlan,
    valid: RuntimeSnapshot,
    hostile: RuntimeSnapshot,
    label: string,
    completionRequest?: unknown,
  ) => {
    assert.equal(validateRuntimeSnapshot(hostile, plan).valid, false, label);
    assert.throws(
      () => restoreCheckpoint({ ...createCheckpoint(plan, valid), snapshot: hostile }),
      label,
    );
    if (completionRequest !== undefined) {
      assert.throws(() => completeAction(plan, hostile, completionRequest), label);
    }
  };

  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: each target selects the persisted interaction record that receives an unsupported field.
  const interactionTargets: readonly [string, (interaction: any) => Record<string, unknown>][] = [
    ["interaction", (interaction) => interaction],
    ["UI", (interaction) => interaction.ui],
    ["accessible name", (interaction) => interaction.ui.accessibleName],
    ["option", (interaction) => interaction.ui.options[0]],
  ];
  for (const [name, target] of interactionTargets) {
    const hostilePlan = structuredClone(base);
    target(hostilePlan.instructions[0]).extra = true;
    assert.equal(validateInstructionPlan(hostilePlan).valid, false, `plan ${name}`);
    assert.throws(() => run(hostilePlan, createFreshRuntimeSnapshot(base)), `plan ${name}`);
    const hostile = structuredClone(pending.snapshot);
    target(hostile.foregroundAction).extra = true;
    assertSnapshotRejected(base, pending.snapshot, hostile, `pending ${name}`, request);
  }

  const settlementHostile = structuredClone(completed.snapshot);
  // EVIDENCE: fixture adds one unsupported field to the completed interaction settlement.
  (
    settlementHostile.lastSettlement as typeof settlementHostile.lastSettlement & { extra?: true }
  ).extra = true;
  assertSnapshotRejected(base, completed.snapshot, settlementHostile, "settlement", request);

  const delayPlan = compileValidPlan("wait 1\nexit");
  const delayPending = run(delayPlan, createFreshRuntimeSnapshot(delayPlan)).snapshot;
  const delayCompleted = observeTime(delayPlan, delayPending, 1_000).snapshot;
  const delayActionHostile = structuredClone(delayPending);
  assert.ok(delayActionHostile.foregroundAction?.kind === "delay");
  // EVIDENCE: fixture adds one unsupported field to the pending delay action.
  (
    delayActionHostile.foregroundAction as typeof delayActionHostile.foregroundAction & {
      extra?: true;
    }
  ).extra = true;
  assertSnapshotRejected(delayPlan, delayPending, delayActionHostile, "delay action");
  const delaySettlementHostile = structuredClone(delayCompleted);
  assert.ok(delaySettlementHostile.lastSettlement?.actionKind === "delay");
  // EVIDENCE: fixture adds one unsupported field to the completed delay settlement.
  (
    delaySettlementHostile.lastSettlement as typeof delaySettlementHostile.lastSettlement & {
      extra?: true;
    }
  ).extra = true;
  assertSnapshotRejected(delayPlan, delayCompleted, delaySettlementHostile, "delay settlement");
});

test("interaction ownership and pending result destinations hold in root, function, and loop frames", () => {
  const contexts = [
    { name: "root", text: "let before = 1\nlet answer = askText", button: 'showButton "Continue"' },
    {
      name: "function",
      text: "function prompt { let answer = askText\nreturn answer }\nlet result = prompt()",
      button: 'function prompt { showButton "Continue"\nreturn }\nprompt()',
    },
    {
      name: "loop",
      text: "repeat 1 { let answer = askText }",
      button: 'repeat 1 { showButton "Continue" }',
    },
  ] as const;
  for (const context of contexts) {
    for (const [interactionKind, source] of [
      ["text", context.text],
      ["button", context.button],
    ] as const) {
      const label = `${context.name} ${interactionKind}`;
      const plan = compileValidPlan(source);
      const pending = waiting(plan);
      const action = pending.snapshot.foregroundAction;
      assert.ok(action?.kind === "interaction", label);
      assert.equal(pending.snapshot.callFrames.length, context.name === "function" ? 1 : 0, label);
      assert.equal(pending.snapshot.loopFrames.length, context.name === "loop" ? 1 : 0, label);
      assert.equal(action.ownerCallFrameId, pending.snapshot.callFrames.at(-1)?.id ?? null, label);
      assert.equal(action.scopeDepth, pending.snapshot.frames.length, label);
      assert.equal(action.loopDepth, pending.snapshot.loopFrames.length, label);

      const destination = action.destinationTemporary;
      if (interactionKind === "button") {
        assert.equal(destination, null, label);
      } else {
        assert.ok(destination !== null, label);
        assert.equal(
          pending.snapshot.temporaries.some((temporary) => temporary.id === destination),
          false,
          `${label}: pending destination`,
        );
        // An occupied destination is rejected before the request is created ...
        let beforeRequest = createFreshRuntimeSnapshot(plan);
        for (
          let step = 0;
          plan.instructions[beforeRequest.nextInstruction]?.kind !== "interaction";
          step += 1
        ) {
          assert.ok(step < plan.instructions.length, `${label}: reaches the interaction`);
          beforeRequest = executeInstruction(plan, beforeRequest).snapshot;
          assert.equal(beforeRequest.status, "running", label);
        }
        beforeRequest.temporaries.push({ id: destination, value: "old" });
        const occupiedInput = structuredClone(beforeRequest);
        assert.equal(validateRuntimeSnapshot(beforeRequest, plan).valid, false, label);
        assert.throws(() => run(plan, beforeRequest), label);
        assert.deepEqual(beforeRequest, occupiedInput, `${label}: occupied input`);
        // ... and while the request is pending.
        const occupiedPending = structuredClone(pending.snapshot);
        occupiedPending.temporaries.push({ id: destination, value: "old" });
        assert.equal(validateRuntimeSnapshot(occupiedPending).valid, false, label);
        assert.equal(validateRuntimeSnapshot(occupiedPending, plan).valid, false, label);
        assert.throws(
          () =>
            restoreCheckpoint({
              ...createCheckpoint(plan, pending.snapshot),
              snapshot: occupiedPending,
            }),
          label,
        );
      }

      const restored = deserializeCheckpoint(
        serializeCheckpoint(createCheckpoint(plan, pending.snapshot)),
      );
      assert.deepEqual(restored.snapshot, pending.snapshot, label);
      const completed = completeAction(restored.plan, restored.snapshot, {
        actionId: action.actionId,
        actionKind: "interaction",
        interactionKind,
        payload:
          interactionKind === "text"
            ? { kind: "submittedText", submittedText: "new" }
            : { kind: "activate" },
      });
      assert.equal(completed.outcome.kind, "completed", label);
      if (destination !== null) {
        assert.equal(
          completed.snapshot.temporaries.find((temporary) => temporary.id === destination)?.value,
          "new",
          label,
        );
      }
      assert.equal(run(restored.plan, completed.snapshot).snapshot.status, "halted", label);
    }
  }

  // A second producer of the destination before the request is rejected at the plan boundary.
  const rootPlan = compileValidPlan(contexts[0].text);
  const interactionIndex = rootPlan.instructions.findIndex(
    (instruction) => instruction.kind === "interaction",
  );
  const interaction = rootPlan.instructions[interactionIndex];
  assert.ok(interaction?.kind === "interaction" && interaction.destinationTemporary !== null);
  assert.ok(interactionIndex > 0);
  const occupiedPlan: InstructionPlan = {
    ...rootPlan,
    instructions: rootPlan.instructions.map((instruction, index) =>
      index === 0
        ? {
            kind: "storeTemporary",
            temporaryId: interaction.destinationTemporary!,
            value: { kind: "literal", value: "old", span: instruction.span },
            expectBoolean: false,
            span: instruction.span,
          }
        : instruction,
    ),
  };
  assert.deepEqual(
    validateInstructionPlan(occupiedPlan).errors.map((error) => [error.code, error.path]),
    [["TSC002", `$.instructions[${interactionIndex}].destinationTemporary`]],
  );
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
