import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
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
import { run, RuntimeDataError } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { withValidationTestStatistics } from "../src/validation-testing.js";

type Mutable<T> = T extends readonly [infer First, infer Second]
  ? [Mutable<First>, Mutable<Second>]
  : T extends readonly (infer Item)[]
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

// One fixture per choice result domain; the options with written values share visible text on purpose.
const choiceDomains: Record<"text" | "identifier" | "numeric", InteractionUiPayload> = {
  text: {
    kind: "choice",
    options: [
      { text: "Alpha", value: "Alpha" },
      { text: "Beta", value: "Beta" },
    ],
    accessibleName: defaults.choice,
  },
  identifier: {
    kind: "choice",
    options: [
      { text: "Same", value: "first" },
      { text: "Same", value: "second" },
    ],
    accessibleName: defaults.choice,
  },
  numeric: {
    kind: "choice",
    options: [
      { text: "One", value: 1 },
      { text: "Two", value: 2 },
    ],
    accessibleName: defaults.choice,
  },
};

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

function completeAndConsume(
  plan: InstructionPlan,
  payload: unknown,
  interactionKind: InteractionInstruction["interactionKind"],
) {
  const consumed = run(plan, complete(plan, payload, interactionKind).snapshot).snapshot;
  // The `exit` continuation consumes the result handoff and cleanup removes its destination,
  // so the retained settlement is the only remaining result authority.
  assert.equal(consumed.status, "halted");
  assert.equal(consumed.interactionResultHandoff, null);
  assert.deepEqual(consumed.temporaries, []);
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
    "0x10",
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

test("choice supports text, identifier, and numeric values, exact typed text, and ambiguous text", () => {
  const textChoice = interactionPlan("choice", choiceDomains.text);
  assert.equal(
    complete(textChoice, { kind: "selectedOption", optionIndex: 1 }, "choice").snapshot
      .temporaries[0]?.value,
    "Beta",
  );
  assert.equal(
    complete(textChoice, { kind: "submittedText", submittedText: "Alpha" }, "choice").snapshot
      .temporaries[0]?.value,
    "Alpha",
  );

  const identifierChoice = interactionPlan("choice", choiceDomains.identifier);
  const ambiguous = waiting(identifierChoice);
  const before = JSON.stringify(ambiguous.snapshot);
  const rejected = completeAction(identifierChoice, ambiguous.snapshot, {
    actionId: ambiguous.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "submittedText", submittedText: "Same" },
  });
  assert.equal(rejected.outcome.kind, "invalidPayload");
  assert.equal(JSON.stringify(rejected.snapshot), before);
  const selected = complete(identifierChoice, { kind: "selectedOption", optionIndex: 1 }, "choice");
  assert.equal(selected.snapshot.temporaries[0]?.value, "second");
  const choiceTranscript = selected.events[0]!;
  assert.equal(choiceTranscript.kind === "playerTranscript" && choiceTranscript.text, "Same");

  const numeric = interactionPlan("choice", choiceDomains.numeric);
  const numericCompleted = complete(numeric, { kind: "selectedOption", optionIndex: 1 }, "choice");
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
    interactionPlan("choice", choiceDomains.text),
    interactionPlan("choice", choiceDomains.identifier),
    interactionPlan("choice", choiceDomains.numeric),
  ] as const;
  const payloads = [
    { kind: "selectedOption", optionIndex: 1 },
    { kind: "selectedOption", optionIndex: 1 },
    { kind: "selectedOption", optionIndex: 1 },
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
  const wrongForExactPlan: any = structuredClone(identifier.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture changes an identifier-valued result to the numeric domain for exact-plan validation.
  wrongForExactPlan.lastSettlement.result = 1;
  wrongForExactPlan.interactionResultHandoff.result = 1;
  wrongForExactPlan.temporaries[0].value = 1;
  // The settlement records the presented options, which offer no value 1, so this fails even without the plan.
  assert.equal(validateRuntimeSnapshot(wrongForExactPlan).valid, false);
  assert.equal(validateRuntimeSnapshot(wrongForExactPlan, cases[1]).valid, false);
  const wrongChoiceDestination: any = structuredClone(identifier.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture makes the stored destination disagree with its retained choice settlement.
  wrongChoiceDestination.temporaries[0].value = "other";
  assert.equal(validateRuntimeSnapshot(wrongChoiceDestination, cases[1]).valid, false);
});

test("numeric interactions reject negative-zero values and keep canonical zero results", () => {
  const zeroChoice = interactionPlan("choice", {
    kind: "choice",
    options: [{ text: "Zero", value: 0 }],
    accessibleName: defaults.choice,
  });
  const negativeZeroPlan: any = structuredClone(zeroChoice); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture injects negative zero into a numeric choice value rejected by plan validation.
  negativeZeroPlan.instructions[0].ui.options[0].value = -0;
  assert.equal(validateInstructionPlan(negativeZeroPlan).valid, false);

  const pending = waiting(zeroChoice);
  const negativeZeroAction: any = structuredClone(pending.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture injects negative zero into persisted choice UI data rejected by snapshot validation.
  negativeZeroAction.foregroundAction.ui.options[0].value = -0;
  assert.equal(validateRuntimeSnapshot(negativeZeroAction).valid, false);
  assert.equal(validateRuntimeSnapshot(negativeZeroAction, zeroChoice).valid, false);

  const askNumber = interactionPlan("number", {
    kind: "number",
    hint: null,
    accessibleName: defaults.number,
  });
  for (const [plan, payload, kind] of [
    [askNumber, { kind: "submittedText", submittedText: "-0" }, "number"],
    [zeroChoice, { kind: "selectedOption", optionIndex: 0 }, "choice"],
    [zeroChoice, { kind: "submittedText", submittedText: "Zero" }, "choice"],
  ] as const) {
    const label = `${kind} ${JSON.stringify(payload)}`;
    const completed = complete(plan, payload, kind);
    assert.ok(completed.snapshot.lastSettlement?.actionKind === "interaction", label);
    assert.equal(Object.is(completed.snapshot.lastSettlement.result, -0), false, label);
    assert.equal(Object.is(completed.snapshot.temporaries[0]?.value, -0), false, label);
    assert.equal(validateRuntimeSnapshot(completed.snapshot, plan).valid, true, label);

    // Only a negative-zero destination differs from the canonical zero result.
    const hostile = structuredClone(completed.snapshot);
    assert.ok(hostile.temporaries[0] !== undefined, label);
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
    assert.equal(Object.is(roundTrip.snapshot.lastSettlement.result, -0), false, label);
    assert.equal(Object.is(roundTrip.snapshot.temporaries[0]?.value, -0), false, label);
    assert.equal(run(roundTrip.plan, roundTrip.snapshot).snapshot.status, "halted", label);
  }
});

test("changed duplicate, stale, wrong-kind, and over-limit completion preserve ADR 0016 classification", () => {
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const planBefore = structuredClone(plan);
  const pending = waiting(plan);
  const pendingBefore = structuredClone(pending.snapshot);
  const actionId = pending.snapshot.foregroundAction!.actionId;
  const assertUnchanged = (
    rejected: ReturnType<typeof completeAction>,
    input: RuntimeSnapshot,
    before: RuntimeSnapshot,
    label: string,
  ) => {
    assert.deepEqual(rejected.events, [], label);
    assert.deepEqual(rejected.snapshot, before, `${label}: returned state`);
    assert.deepEqual(input, before, `${label}: snapshot input`);
    assert.deepEqual(plan, planBefore, `${label}: plan input`);
  };
  const wrong = completeAction(plan, pending.snapshot, {
    actionId,
    actionKind: "delay",
    payload: { kind: "time", currentSessionTimeMs: 1 },
  });
  assert.equal(wrong.outcome.kind, "wrongActionKind");
  assertUnchanged(wrong, pending.snapshot, pendingBefore, "wrong kind");
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
  assertUnchanged(over, pending.snapshot, pendingBefore, "over limit");
  const done = completeAction(plan, pending.snapshot, {
    actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "ok" },
  });
  assert.equal(done.outcome.kind, "completed");
  const doneBefore = structuredClone(done.snapshot);
  const duplicate = completeAction(plan, done.snapshot, {
    actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "different" },
  });
  assert.equal(duplicate.outcome.kind, "alreadySettled");
  assert.deepEqual(duplicate.outcome.settlement, doneBefore.lastSettlement);
  assertUnchanged(duplicate, done.snapshot, doneBefore, "duplicate");
  // Unknown and same-payload replay are classified at every handoff boundary in the handoff suite.
  const seeded = createFreshRuntimeSnapshot(plan);
  seeded.nextActionId = 2;
  const laterPending = run(plan, seeded);
  const laterPendingBefore = structuredClone(laterPending.snapshot);
  const stale = completeAction(plan, laterPending.snapshot, {
    actionId: 1,
    actionKind: "interaction",
  });
  assert.equal(stale.outcome.kind, "staleAction");
  assertUnchanged(stale, laterPending.snapshot, laterPendingBefore, "stale");
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
  const mistress = pending.snapshot.speakers.find((speaker) => speaker.identifier === "mistress");
  assert.ok(mistress !== undefined);
  assert.equal(
    transcript.kind === "playerTranscript" && transcript.requestingSpeakerId,
    mistress.id,
  );
  assert.deepEqual(
    completed.events.map((event) => event.sequence),
    [pending.snapshot.nextEventSequence, pending.snapshot.nextEventSequence + 1],
  );
  assert.equal(observeTime(restored.plan, restored.snapshot, 10).snapshot.status, "waiting");
});

test("interaction definitions preflight each field against remaining aggregate bytes", () => {
  // The label is the button's only authored definition string.
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
    value: index,
  }));
  const exactOptions = interactionPlan("choice", {
    kind: "choice",
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
    options: [...ui.options, { text: "", value: MAX_INTERACTION_OPTION_ENTRIES }],
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

  // A value equal to its button text is counted once.
  const longText = "a".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES - 1);
  const choiceWithinAggregate = interactionPlan("choice", {
    kind: "choice",
    accessibleName: defaults.choice,
    options: [
      { text: longText, value: longText },
      { text: "b", value: "b" },
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
  // Settlement result, transcript and destination disagreements are rejected with complete
  // boundary evidence by the handoff settlement matrix.
  const standaloneUi: any = structuredClone(pending.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture adds an unsupported accessible-name key to persisted UI data.
  standaloneUi.foregroundAction.ui.accessibleName.key = "continue";
  assert.equal(validateRuntimeSnapshot(standaloneUi).valid, false);
});

test("planless pending result interactions require positive destination temporary IDs", () => {
  // Every result-bearing kind uses the same destination predicate, so text represents them.
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const pending = waiting(plan);
  for (const destination of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    const hostile: any = structuredClone(pending.snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture assigns an out-of-range interaction destination before validation and completion.
    hostile.foregroundAction.destinationTemporary = destination;
    assert.equal(validateRuntimeSnapshot(hostile).valid, false, String(destination));
    assert.throws(
      () => restoreCheckpoint({ ...createCheckpoint(plan, pending.snapshot), snapshot: hostile }),
      String(destination),
    );
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

test("consumed interaction settlements enforce intrinsic text and number semantics", () => {
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
  const text = completeAndConsume(
    textPlan,
    { kind: "submittedText", submittedText: "answer" },
    "text",
  );
  const number = completeAndConsume(
    numberPlan,
    { kind: "submittedText", submittedText: "1e1" },
    "number",
  );
  assert.equal(validateRuntimeSnapshot(JSON.parse(JSON.stringify(text))).valid, true);
  assert.equal(validateRuntimeSnapshot(JSON.parse(JSON.stringify(number))).valid, true);
  // Each row changes only the retained settlement after the handoff and destination are gone.
  for (const [name, plan, consumed, result, transcript] of [
    ["text result differs from transcript", textPlan, text, "different", "answer"],
    ["empty text", textPlan, text, "", ""],
    ["whitespace-only text", textPlan, text, " \t\n", " \t\n"],
    ["leading CR text", textPlan, text, "\rvalue", "\rvalue"],
    ["CRLF text", textPlan, text, "value\r\n", "value\r\n"],
    ["non-numeric transcript", numberPlan, number, 10, "nonsense"],
    // Number() maps this transcript to the stored result, but it is not TeaseScript number text.
    ["hexadecimal transcript", numberPlan, number, 16, "0x10"],
    ["line-separator transcript", numberPlan, number, 10, "1\u2028"],
    ["result differs from parsed transcript", numberPlan, number, 11, "1e1"],
    ["negative-zero result", numberPlan, number, -0, "-0"],
  ] as const) {
    const hostile = structuredClone(consumed);
    assert.ok(hostile.lastSettlement?.actionKind === "interaction", name);
    // EVIDENCE: fixture replaces only the retained result and transcript with the candidate pair.
    const hostileSettlement = hostile.lastSettlement as {
      result: string | number | null;
      transcriptText: string | null;
    };
    hostileSettlement.result = result;
    hostileSettlement.transcriptText = transcript;
    assert.equal(validateRuntimeSnapshot(hostile).valid, false, name);
    assert.equal(validateRuntimeSnapshot(hostile, plan).valid, false, name);
    assert.throws(
      () => restoreCheckpoint({ ...createCheckpoint(plan, consumed), snapshot: hostile }),
      name,
    );
    assert.throws(() => run(plan, hostile), name);
  }
});

test("pending interaction speaker provenance is bound to the instructed speaker", () => {
  const compiledPlan = (source: string) => {
    const compiled = compileSource(source);
    assert.deepEqual(compiled.diagnostics, [], source);
    return compiled.plan!;
  };
  const speakerId = (snapshot: RuntimeSnapshot, identifier: string) => {
    const speaker = snapshot.speakers.find((candidate) => candidate.identifier === identifier);
    assert.ok(speaker !== undefined, identifier);
    return speaker.id;
  };
  // Returns the innermost visible speaker-reference binding with this name.
  const speakerBinding = (snapshot: Mutable<RuntimeSnapshot>, name: string) => {
    const binding = snapshot.frames
      .slice()
      .reverse()
      .flatMap((frame) => frame.bindings)
      .find((candidate) => candidate.name === name);
    assert.ok(
      binding !== undefined &&
        typeof binding.value === "object" &&
        binding.value !== null &&
        binding.value.kind === "speakerReference",
      name,
    );
    return binding.value;
  };
  const corrupted = (
    snapshot: RuntimeSnapshot,
    mutate: (copy: Mutable<RuntimeSnapshot>, action: { speakerId: number | null }) => void,
  ) => {
    // EVIDENCE: structuredClone preserves the runtime snapshot shape while each fixture changes speaker data.
    const copy = structuredClone(snapshot) as Mutable<RuntimeSnapshot>;
    assert.ok(copy.foregroundAction?.kind === "interaction");
    mutate(copy, copy.foregroundAction);
    return copy;
  };

  const speakerPlan = compiledPlan(
    'speaker alice {}\nspeaker bob {}\nspeaker alice\nshowButton as alice "Continue"\nexit',
  );
  const pending = waiting(speakerPlan).snapshot;
  const bob = speakerId(pending, "bob");
  const rejectedExplicit = [
    corrupted(pending, (_copy, action) => {
      action.speakerId = bob;
    }),
    corrupted(pending, (copy, action) => {
      const alice = copy.speakers.find((speaker) => speaker.identifier === "alice")!;
      const swappedBob = copy.speakers.find((speaker) => speaker.identifier === "bob")!;
      [alice.identifier, swappedBob.identifier] = [swappedBob.identifier, alice.identifier];
      action.speakerId = swappedBob.id;
    }),
    corrupted(pending, (copy) => {
      speakerBinding(copy, "alice").speakerId = bob;
    }),
  ];
  for (const hostile of rejectedExplicit) {
    assert.equal(validateRuntimeSnapshot(hostile, speakerPlan).valid, false);
  }
  // A coherent binding change moves the instructed speaker with it.
  const bindingResolved = corrupted(pending, (copy, action) => {
    speakerBinding(copy, "alice").speakerId = bob;
    action.speakerId = bob;
  });
  assert.equal(validateRuntimeSnapshot(bindingResolved, speakerPlan).valid, true);

  const defaultSpeakerPlan = compiledPlan(
    'speaker alice {}\nspeaker bob {}\nspeaker alice\nshowButton "Continue"\nexit',
  );
  const defaultPending = waiting(defaultSpeakerPlan).snapshot;
  const defaultAction = defaultPending.foregroundAction;
  assert.equal(
    defaultAction?.kind === "interaction" && defaultAction.speakerId,
    defaultPending.defaultSpeaker,
  );
  const wrongDefault = corrupted(defaultPending, (_copy, action) => {
    action.speakerId = speakerId(defaultPending, "bob");
  });
  assert.equal(validateRuntimeSnapshot(wrongDefault, defaultSpeakerPlan).valid, false);

  const removeAliceBinding = (copy: Mutable<RuntimeSnapshot>) => {
    const frame = copy.frames.find((candidate) =>
      candidate.bindings.some((binding) => binding.name === "alice"),
    );
    assert.ok(frame);
    frame.bindings = frame.bindings.filter((binding) => binding.name !== "alice");
  };
  const replaceAliceBinding = (copy: Mutable<RuntimeSnapshot>, value: unknown) => {
    const binding = copy.frames
      .flatMap((frame) => frame.bindings)
      .find((candidate) => candidate.name === "alice");
    assert.ok(binding);
    // EVIDENCE: fixture stores malformed external binding data excluded by the canonical snapshot type.
    (binding as { value: unknown }).value = value;
  };
  for (const mutateBinding of [
    removeAliceBinding,
    (copy: Mutable<RuntimeSnapshot>) => replaceAliceBinding(copy, "ordinary"),
    () => {},
  ]) {
    const hostile = corrupted(pending, (copy, action) => {
      mutateBinding(copy);
      action.speakerId = null;
    });
    assert.equal(validateRuntimeSnapshot(hostile, speakerPlan).valid, false);
    assert.throws(() =>
      restoreCheckpoint({ ...createCheckpoint(speakerPlan, pending), snapshot: hostile }),
    );
  }

  // A function-scoped explicit speaker resolves through the active frame's visible binding.
  const scopedPlan = compiledPlan(
    'speaker alice {}\nfunction prompt { showButton as alice "Continue" }\nprompt()\nexit',
  );
  const scopedPending = waiting(scopedPlan).snapshot;
  // EVIDENCE: structuredClone preserves the runtime snapshot shape for the read-only binding lookup.
  const scopedCopy = structuredClone(scopedPending) as Mutable<RuntimeSnapshot>;
  assert.equal(
    scopedPending.foregroundAction?.kind === "interaction" &&
      scopedPending.foregroundAction.speakerId,
    speakerBinding(scopedCopy, "alice").speakerId,
  );
  assert.equal(validateRuntimeSnapshot(scopedPending, scopedPlan).valid, true);
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

test("oversized authored interaction strings reject at plan and snapshot boundaries", () => {
  // Each oversized ASCII field exceeds the aggregate budget left by the other authored strings by one byte.
  const oversizedBeside = (otherAuthoredText: string) =>
    "a".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES - otherAuthoredText.length + 1);
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
  ).accessibleName = { kind: "text", text: oversizedBeside("Continue") };
  assert.equal(validateInstructionPlan(hugeAccessible).valid, false);

  const identifier = interactionPlan("choice", {
    kind: "choice",
    options: [{ text: "Visible", value: "valid" }],
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
  // EVIDENCE: fixture replaces only the first choice value with an oversized identifier.
  (hugeIdentifierInteraction.ui.options[0] as { value: string }).value = oversizedBeside("Visible");
  assert.equal(validateInstructionPlan(hugeIdentifier).valid, false);

  const pending = waiting(identifier);
  const hostile = structuredClone(pending.snapshot);
  assert.ok(
    hostile.foregroundAction?.kind === "interaction" &&
      hostile.foregroundAction.ui.kind === "choice",
  );
  const hostileOption = hostile.foregroundAction.ui.options[0];
  assert.ok(hostileOption !== undefined);
  // EVIDENCE: fixture replaces only the persisted choice value with an oversized identifier.
  (hostileOption as { value: string | number | null }).value = oversizedBeside("Visible");
  assert.equal(validateRuntimeSnapshot(hostile).valid, false);
});

/** Counts UTF-8 measurements while rejecting these choice options in a plan and a planless snapshot. */
function exhaustedMeasurementCounts(
  base: InstructionPlan,
  options: Extract<InteractionUiPayload, { kind: "choice" }>["options"],
) {
  const plan = structuredClone(base);
  const interaction = plan.instructions[0];
  assert.ok(interaction?.kind === "interaction" && "ui" in interaction);
  // EVIDENCE: fixture replaces only the choice options of the validated plan.
  Object.assign(interaction.ui, { options });
  const planStats = withValidationTestStatistics((finish) => {
    assert.equal(validateInstructionPlan(plan).valid, false);
    return finish();
  });
  const snapshot = structuredClone(waiting(base).snapshot);
  assert.ok(snapshot.foregroundAction?.kind === "interaction");
  // EVIDENCE: fixture replaces only the persisted choice options of the pending action.
  Object.assign(snapshot.foregroundAction.ui, { options });
  const snapshotStats = withValidationTestStatistics((finish) => {
    assert.equal(validateRuntimeSnapshot(snapshot).valid, false);
    return finish();
  });
  return {
    plan: planStats.counts.interactionUtf8Measurements,
    snapshot: snapshotStats.counts.interactionUtf8Measurements,
  };
}

test("interaction validation stops UTF-8 measurement once a field exhausts the aggregate", () => {
  // `interactionUtf8Measurements` is a scoped regression oracle for bounded validation work: after one field
  // exhausts the aggregate, later fields must not be encoded, or a hostile plan or checkpoint would cost its field
  // count times the byte budget. Exact measurement counts are not a requirement.
  const base = interactionPlan("choice", {
    kind: "choice",
    options: [{ text: "One", value: "one" }],
    accessibleName: defaults.choice,
  });
  const half = MAX_INTERACTION_AGGREGATE_UTF8_BYTES / 2;
  // Each euro sign is three UTF-8 bytes, so this text exceeds the aggregate while its UTF-16 length
  // passes the constant-time length precheck and must be encoded.
  const multibyte = "€".repeat(Math.floor(MAX_INTERACTION_AGGREGATE_UTF8_BYTES / 3) + 1);
  assert.ok(multibyte.length <= MAX_INTERACTION_AGGREGATE_UTF8_BYTES);
  const laterOptions = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      text: "later ".repeat(100),
      value: `later${index}`,
    }));
  for (const [name, exhausting] of [
    // The text fills half the aggregate and the value exceeds the remaining half by one byte.
    ["value after a half-budget text", { text: "a".repeat(half), value: "b".repeat(half + 1) }],
    ["multibyte first text", { text: multibyte, value: "first" }],
  ] as const) {
    const oneLater = exhaustedMeasurementCounts(base, [exhausting, ...laterOptions(1)]);
    const manyLater = exhaustedMeasurementCounts(base, [exhausting, ...laterOptions(1_000)]);
    assert.ok(
      (oneLater.plan ?? 0) > 0 && (oneLater.snapshot ?? 0) > 0,
      `${name}: exhausting field measured`,
    );
    assert.deepEqual(manyLater, oneLater, name);
  }
});

test("huge completion kind tokens are not reflected or allowed to mutate canonical state", () => {
  const plan = interactionPlan("button", {
    kind: "button",
    buttonLabel: "Continue",
    accessibleName: defaults.button,
  });
  const pending = waiting(plan);
  const actionId = pending.snapshot.foregroundAction!.actionId;
  const before = JSON.stringify(pending.snapshot);
  const shorter = "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES * 32);
  const longer = "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES * 64);
  for (const request of [
    (token: string) => ({ actionId, actionKind: token }),
    (token: string) => ({ actionId, actionKind: "interaction", interactionKind: token }),
  ]) {
    const receivedTokens = [shorter, longer].map((token) => {
      const rejected = completeAction(plan, pending.snapshot, request(token));
      assert.equal(rejected.outcome.kind, "wrongActionKind");
      assert.deepEqual(rejected.events, []);
      assert.equal(JSON.stringify(rejected.snapshot), before);
      const received =
        rejected.outcome.kind === "wrongActionKind" ? rejected.outcome.receivedActionKind : null;
      assert.equal(typeof received, "string");
      assert.notEqual(received, token);
      return received!;
    });
    // A sanitized token is bounded independently of the oversized input it replaces.
    assert.equal(receivedTokens[0]!.length, receivedTokens[1]!.length);
    assert.ok(receivedTokens[0]!.length < shorter.length);
  }
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

// Typed results resuming through a direct function return are covered by the handoff typed-domain matrix.
test("result-bearing interactions require an in-region continuation", () => {
  for (const [kind, ui] of [
    ["text", { kind: "text", hint: null, accessibleName: defaults.text }],
    ["number", { kind: "number", hint: null, accessibleName: defaults.number }],
    ["choice", choiceDomains.text],
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
    options: [
      { text: "One", value: "one" },
      { text: "Two", value: "two" },
    ],
    accessibleName: defaults.choice,
  });
  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixture callbacks corrupt choice values, the UI shape, result domain, and target with incompatible plan values.
  const mutations: Array<(plan: any) => void> = [
    (plan) => {
      delete plan.instructions[0].ui.options[1].value;
    },
    (plan) => {
      plan.instructions[0].ui.options[1].value = ["two"];
    },
    (plan) => {
      plan.instructions[0].ui.values = [];
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
  for (const source of [
    'function prompt { showButton "Continue"\nreturn }\nprompt()\nexit',
    'repeat 1 { showButton "Continue" }\nexit',
  ]) {
    const compiled = compileSource(source);
    assert.deepEqual(compiled.diagnostics, [], source);
    const plan = compiled.plan!;
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
  // The key, not its size, is unsupported; large-input non-reflection is covered by the
  // completion-kind token test.
  interface ExtraFieldTarget {
    extra?: string;
  }
  const addExtra = (target: ExtraFieldTarget | null) => {
    assert.ok(target !== null);
    target.extra = "x";
  };
  const base = interactionPlan("choice", {
    kind: "choice",
    options: [{ text: "One", value: "one" }],
    accessibleName: defaults.choice,
  });
  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: targets select nested interaction instruction records to receive an unsupported field.
  const instructionTargets: Record<string, (instruction: any) => ExtraFieldTarget> = {
    instruction: (instruction) => instruction,
    ui: (instruction) => instruction.ui,
    accessibleName: (instruction) => instruction.ui.accessibleName,
    option: (instruction) => instruction.ui.options[0],
  };
  for (const [name, target] of Object.entries(instructionTargets)) {
    const hostile = structuredClone(base);
    addExtra(target(hostile.instructions[0]));
    assert.equal(validateInstructionPlan(hostile).valid, false, name);
    assert.throws(() => run(hostile, createFreshRuntimeSnapshot(base)), name);
  }

  const pending = waiting(base).snapshot;
  const completed = complete(base, { kind: "selectedOption", optionIndex: 0 }, "choice");
  const delayPlan = compileSource("wait 1\nexit").plan!;
  const delayPending = run(delayPlan, createFreshRuntimeSnapshot(delayPlan)).snapshot;
  const delayCompleted = observeTime(delayPlan, delayPending, 1_000).snapshot;
  assert.equal(delayPending.foregroundAction?.kind, "delay");
  assert.equal(delayCompleted.lastSettlement?.actionKind, "delay");
  const snapshotTargets: Record<
    string,
    readonly [
      InstructionPlan,
      RuntimeSnapshot,
      // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: targets select nested persisted records to receive an unsupported field.
      (snapshot: any) => ExtraFieldTarget,
      completes: boolean,
    ]
  > = {
    action: [base, pending, (snapshot) => snapshot.foregroundAction, true],
    actionUi: [base, pending, (snapshot) => snapshot.foregroundAction.ui, true],
    actionAccessibleName: [
      base,
      pending,
      (snapshot) => snapshot.foregroundAction.ui.accessibleName,
      true,
    ],
    actionOption: [base, pending, (snapshot) => snapshot.foregroundAction.ui.options[0], true],
    settlement: [base, completed.snapshot, (snapshot) => snapshot.lastSettlement, true],
    delayAction: [delayPlan, delayPending, (snapshot) => snapshot.foregroundAction, false],
    delaySettlement: [delayPlan, delayCompleted, (snapshot) => snapshot.lastSettlement, false],
  };
  for (const [name, [plan, valid, target, completes]] of Object.entries(snapshotTargets)) {
    const hostile = structuredClone(valid);
    addExtra(target(hostile));
    assert.equal(validateRuntimeSnapshot(hostile, plan).valid, false, name);
    assert.throws(
      () => restoreCheckpoint({ ...createCheckpoint(plan, valid), snapshot: hostile }),
      name,
    );
    if (completes) {
      const request = {
        actionId: valid.foregroundAction?.actionId ?? valid.lastSettlement!.actionId,
        actionKind: "interaction",
        interactionKind: "choice",
        payload: { kind: "selectedOption", optionIndex: 0 },
      };
      assert.throws(
        () => completeAction(plan, hostile, request),
        (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR101",
        name,
      );
    }
  }
});

test("text completion limits the raw submitted string before line-ending normalization", () => {
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  // Each CRLF pair is two raw bytes but normalizes to one, so only the raw text exceeds the limit.
  const submittedText = `x${"\r\n".repeat(MAX_INTERACTION_STRING_UTF8_BYTES / 2)}`;
  assert.ok(submittedText.length > MAX_INTERACTION_STRING_UTF8_BYTES);
  assert.ok(submittedText.replace(/\r\n/gu, "\n").length <= MAX_INTERACTION_STRING_UTF8_BYTES);
  const pending = waiting(plan);
  const before = structuredClone(pending.snapshot);
  const rejected = completeAction(plan, pending.snapshot, {
    actionId: pending.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText },
  });
  assert.equal(rejected.outcome.kind, "invalidPayload");
  assert.deepEqual(rejected.events, []);
  assert.deepEqual(rejected.snapshot, before);
  assert.deepEqual(pending.snapshot, before);
});
