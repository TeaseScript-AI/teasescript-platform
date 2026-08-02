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
  BinaryExpressionPlan,
  ExpressionPlan,
  Instruction,
  InstructionPlan,
  InteractionAccessibleName,
  InteractionInstruction,
  InteractionUiPayload,
} from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { CheckpointError, createCheckpoint, deserializeCheckpoint, restoreCheckpoint, serializeCheckpoint } from "../src/runtime/checkpoint.js";
import { completeAction, executeInstruction, observeTime, run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import type {
  RuntimeDelayActionSettlementSnapshot,
} from "../src/runtime/actions/model.js";
import { getSerializableProperty, type SerializableRuntimeObject } from "../src/runtime/serializable-values.js";
import { createFreshRuntimeSnapshot, type RuntimeSnapshot, validateRuntimeSnapshot } from "../src/runtime/state.js";
import type { SourceSpan } from "../src/source.js";
import { withValidationTestStatistics } from "../src/validation-testing.js";

function interactionPlan(interactionKind: InteractionInstruction["interactionKind"], ui: InteractionUiPayload, options: { speaker?: string | null } = {}): InstructionPlan {
  const source = options.speaker === undefined ? "wait 1\nexit" : `speaker ${options.speaker} {}\nspeaker ${options.speaker}\nwait 1\nexit`;
  const compiled = compileSource(source);
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  const base = compiled.plan!;
  const waitIndex = base.instructions.findIndex((instruction) => instruction.kind === "wait");
  assert.notEqual(waitIndex, -1);
  const expectedResult = interactionKind === "button"
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
  const plan = { ...base, temporaryCount: interactionKind === "button" ? 0 : 1, instructions: base.instructions.map((instruction, index) => index === waitIndex ? interaction : instruction) };
  assert.equal(validateInstructionPlan(plan).valid, true, JSON.stringify(validateInstructionPlan(plan).errors));
  return plan;
}

function buttonPlanFromSource(source: string): InstructionPlan {
  const compiled = compileSource(source);
  assert.deepEqual(compiled.diagnostics, []);
  const base = compiled.plan!;
  const waitIndex = base.instructions.findIndex((instruction) => instruction.kind === "wait");
  const interaction: InteractionInstruction = { kind: "interaction", interactionKind: "button", target: "standardChat", speaker: null, destinationTemporary: null, expectedResult: "none", ui: { kind: "button", buttonLabel: "Continue", accessibleName: defaults.button }, span: base.instructions[waitIndex]!.span };
  const plan = { ...base, instructions: base.instructions.map((instruction, index) => index === waitIndex ? interaction : instruction) };
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

function complete(plan: InstructionPlan, payload: unknown, interactionKind: InteractionInstruction["interactionKind"]) {
  const pending = waiting(plan);
  const actionId = pending.snapshot.foregroundAction!.actionId;
  return completeAction(plan, pending.snapshot, { actionId, actionKind: "interaction", interactionKind, payload });
}

test("button and text complete through one interaction family with canonical transcript ordering", () => {
  const buttonPlan = interactionPlan("button", { kind: "button", buttonLabel: "Ready", accessibleName: defaults.button });
  const button = complete(buttonPlan, { kind: "activate" }, "button");
  assert.equal(button.outcome.kind, "completed");
  assert.deepEqual(button.events.map((event) => event.kind), ["playerTranscript", "actionCompleted"]);
  const buttonTranscript = button.events[0]!;
  assert.equal(buttonTranscript.kind === "playerTranscript" && buttonTranscript.text, "Ready");

  const textPlan = interactionPlan("text", { kind: "text", hint: "Answer", accessibleName: defaults.text });
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
  const rejected = completeAction(plan, pending.snapshot, { actionId: pending.snapshot.foregroundAction!.actionId, actionKind: "interaction", interactionKind: "text", payload: { kind: "submittedText", submittedText: " \t\r\n" } });
  assert.equal(rejected.outcome.kind, "invalidPayload");
  assert.deepEqual(rejected.events, []);
  assert.equal(JSON.stringify(rejected.snapshot), before);
});

test("number accepts TeaseScript decimal/scientific text and preserves its trimmed transcript", () => {
  const plan = interactionPlan("number", { kind: "number", hint: null, accessibleName: defaults.number });
  const result = complete(plan, { kind: "submittedText", submittedText: "  -0e2  " }, "number");
  assert.equal(result.snapshot.temporaries[0]?.value, 0);
  assert.equal(Object.is(result.snapshot.temporaries[0]?.value, -0), false);
  const numberTranscript = result.events[0]!;
  assert.equal(numberTranscript.kind === "playerTranscript" && numberTranscript.text, "-0e2");
  for (const submittedText of ["1\n2", "\u20281", "1\u2029", "1,5", "1 000", "1px", "Infinity", "1e999", "one", "+"] ) {
    const pending = waiting(plan);
    const before = JSON.stringify(pending.snapshot);
    const rejected = completeAction(plan, pending.snapshot, { actionId: pending.snapshot.foregroundAction!.actionId, actionKind: "interaction", interactionKind: "number", payload: { kind: "submittedText", submittedText } });
    assert.equal(rejected.outcome.kind, "invalidPayload", submittedText);
    assert.equal(JSON.stringify(rejected.snapshot), before, submittedText);
  }
});

test("choice supports unlabelled, identifier, numeric, exact typed, and ambiguous labelled behavior", () => {
  const unlabelled = interactionPlan("choice", { kind: "choice", labelType: "none", options: [{ text: "Alpha", label: null }, { text: "Beta", label: null }], accessibleName: defaults.choice });
  assert.equal(complete(unlabelled, { kind: "selectedText", selectedText: "Beta" }, "choice").snapshot.temporaries[0]?.value, "Beta");
  assert.equal(complete(unlabelled, { kind: "submittedText", submittedText: "Alpha" }, "choice").snapshot.temporaries[0]?.value, "Alpha");

  const labelled = interactionPlan("choice", { kind: "choice", labelType: "identifier", options: [{ text: "Same", label: "first" }, { text: "Same", label: "second" }], accessibleName: defaults.choice });
  const ambiguous = waiting(labelled);
  const before = JSON.stringify(ambiguous.snapshot);
  const rejected = completeAction(labelled, ambiguous.snapshot, { actionId: ambiguous.snapshot.foregroundAction!.actionId, actionKind: "interaction", interactionKind: "choice", payload: { kind: "submittedText", submittedText: "Same" } });
  assert.equal(rejected.outcome.kind, "invalidPayload");
  assert.equal(JSON.stringify(rejected.snapshot), before);
  const selected = complete(labelled, { kind: "selectedLabel", selectedLabel: "second" }, "choice");
  assert.equal(selected.snapshot.temporaries[0]?.value, "second");
  const choiceTranscript = selected.events[0]!;
  assert.equal(choiceTranscript.kind === "playerTranscript" && choiceTranscript.text, "Same");

  const numeric = interactionPlan("choice", { kind: "choice", labelType: "number", options: [{ text: "One", label: 1 }, { text: "Two", label: 2 }], accessibleName: defaults.choice });
  const numericCompleted = complete(numeric, { kind: "selectedLabel", selectedLabel: 2 }, "choice");
  assert.equal(numericCompleted.snapshot.temporaries[0]?.value, 2);
  assert.equal(validateRuntimeSnapshot(numericCompleted.snapshot, numeric).valid, true);
  const numericRestored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(numeric, numericCompleted.snapshot)));
  assert.equal(numericRestored.snapshot.temporaries[0]?.value, 2);
  assert.equal(run(numericRestored.plan, numericRestored.snapshot).snapshot.status, "halted");
});

test("choice completion snapshots validate without a plan for every result domain", () => {
  const cases = [
    interactionPlan("choice", { kind: "choice", labelType: "none", options: [{ text: "Visible", label: null }], accessibleName: defaults.choice }),
    interactionPlan("choice", { kind: "choice", labelType: "identifier", options: [{ text: "Visible", label: "named" }], accessibleName: defaults.choice }),
    interactionPlan("choice", { kind: "choice", labelType: "number", options: [{ text: "Visible", label: 1 }], accessibleName: defaults.choice }),
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
      const malformed = structuredClone(completed.snapshot) as any;
      malformed.lastSettlement.result = malformedResult;
      malformed.interactionResultHandoff.result = malformedResult;
      malformed.temporaries[0].value = malformedResult;
      assert.equal(validateRuntimeSnapshot(malformed).valid, false);
    }
  }
  const identifier = complete(cases[1], payloads[1], "choice");
  const wrongForExactPlan = structuredClone(identifier.snapshot) as any;
  wrongForExactPlan.lastSettlement.result = 1;
  wrongForExactPlan.interactionResultHandoff.result = 1;
  wrongForExactPlan.temporaries[0].value = 1;
  assert.equal(validateRuntimeSnapshot(wrongForExactPlan).valid, true);
  assert.equal(validateRuntimeSnapshot(wrongForExactPlan, cases[1]).valid, false);
  const wrongChoiceDestination = structuredClone(identifier.snapshot) as any;
  wrongChoiceDestination.temporaries[0].value = "other";
  assert.equal(validateRuntimeSnapshot(wrongChoiceDestination, cases[1]).valid, false);
});

test("numeric choice rejects negative-zero labels and stores JSON-stable zero results", () => {
  const valid = interactionPlan("choice", { kind: "choice", labelType: "number", options: [{ text: "Zero", label: 0 }], accessibleName: defaults.choice });
  const negativeZeroPlan = structuredClone(valid) as any;
  negativeZeroPlan.instructions[0].ui.options[0].label = -0;
  assert.equal(validateInstructionPlan(negativeZeroPlan).valid, false);

  const pending = waiting(valid);
  const negativeZeroAction = structuredClone(pending.snapshot) as any;
  negativeZeroAction.foregroundAction.ui.options[0].label = -0;
  assert.equal(validateRuntimeSnapshot(negativeZeroAction).valid, false);
  assert.equal(validateRuntimeSnapshot(negativeZeroAction, valid).valid, false);

  for (const payload of [
    { kind: "selectedLabel", selectedLabel: -0 },
    { kind: "submittedText", submittedText: "Zero" },
  ]) {
    const completed = complete(valid, payload, "choice");
    assert.equal(Object.is((completed.snapshot.lastSettlement as any)?.result, -0), false);
    assert.equal(validateRuntimeSnapshot(completed.snapshot, valid).valid, true);
    const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(valid, completed.snapshot)));
    assert.equal(Object.is((restored.snapshot.lastSettlement as any)?.result, -0), false);
    assert.equal(run(restored.plan, restored.snapshot).snapshot.status, "halted");
  }
});

test("duplicate, stale, unknown, wrong-kind, and over-limit completion preserve ADR 0016 classification", () => {
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const pending = waiting(plan);
  const actionId = pending.snapshot.foregroundAction!.actionId;
  const wrong = completeAction(plan, pending.snapshot, { actionId, actionKind: "delay", payload: { kind: "time", currentSessionTimeMs: 1 } });
  assert.equal(wrong.outcome.kind, "wrongActionKind");
  assert.deepEqual(wrong.snapshot, pending.snapshot);
  const over = completeAction(plan, pending.snapshot, { actionId, actionKind: "interaction", interactionKind: "text", payload: { kind: "submittedText", submittedText: "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES + 1) } });
  assert.equal(over.outcome.kind, "invalidPayload");
  assert.deepEqual(over.snapshot, pending.snapshot);
  const done = completeAction(plan, pending.snapshot, { actionId, actionKind: "interaction", interactionKind: "text", payload: { kind: "submittedText", submittedText: "ok" } });
  const duplicate = completeAction(plan, done.snapshot, { actionId, actionKind: "interaction", interactionKind: "text", payload: { kind: "submittedText", submittedText: "different" } });
  assert.equal(duplicate.outcome.kind, "alreadySettled");
  assert.deepEqual(duplicate.events, []);
  const seeded = createFreshRuntimeSnapshot(plan);
  seeded.nextActionId = 2;
  const laterPending = run(plan, seeded);
  assert.equal(completeAction(plan, laterPending.snapshot, { actionId: 1, actionKind: "interaction" }).outcome.kind, "staleAction");
  assert.equal(completeAction(plan, done.snapshot, { actionId: done.snapshot.nextActionId, actionKind: "interaction" }).outcome.kind, "unknownAction");
});

test("pending interaction survives JSON checkpoint restore with monotonic events and speaker provenance", () => {
  const plan = interactionPlan("button", { kind: "button", buttonLabel: "Continue", accessibleName: defaults.button }, { speaker: "mistress" });
  const pending = waiting(plan);
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, pending.snapshot)));
  assert.deepEqual(restored.snapshot, pending.snapshot);
  const completed = completeAction(restored.plan, restored.snapshot, { actionId: restored.snapshot.foregroundAction!.actionId, actionKind: "interaction", interactionKind: "button", payload: { kind: "activate" } });
  assert.equal(completed.events[0]!.kind, "playerTranscript");
  const transcript = completed.events[0]!;
  assert.equal(transcript.kind === "playerTranscript" && transcript.requestingSpeakerId, 1);
  assert.deepEqual(completed.events.map((event) => event.sequence), [pending.snapshot.nextEventSequence, pending.snapshot.nextEventSequence + 1]);
  assert.equal(observeTime(restored.plan, restored.snapshot, 10).snapshot.status, "waiting");
});

test("shared exact string and option boundaries are accepted and over-limit plans are rejected linearly", () => {
  assert.equal(interactionUtf8ByteLength("x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES + 4_464)), 70_000);
  const exact = interactionPlan("button", { kind: "button", buttonLabel: "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES), accessibleName: defaults.button });
  assert.equal(validateInstructionPlan(exact).valid, true);
  const tooLong = structuredClone(exact) as unknown as { instructions: Array<Record<string, unknown>> };
  (tooLong.instructions.find((instruction) => instruction.kind === "interaction")!.ui as { buttonLabel: string }).buttonLabel += "x";
  assert.equal(validateInstructionPlan(tooLong).valid, false);

  const options = Array.from({ length: MAX_INTERACTION_OPTION_ENTRIES }, (_, index) => ({ text: "", label: index }));
  const exactOptions = interactionPlan("choice", { kind: "choice", labelType: "number", options, accessibleName: defaults.choice });
  assert.equal(validateInstructionPlan(exactOptions).valid, true);
  const overOptions = structuredClone(exactOptions) as unknown as { instructions: Array<Record<string, unknown>> };
  const ui = overOptions.instructions.find((instruction) => instruction.kind === "interaction")!.ui as { options: Array<{ text: string; label: number }> };
  ui.options.push({ text: "", label: MAX_INTERACTION_OPTION_ENTRIES });
  assert.equal(validateInstructionPlan(overOptions).valid, false);

  const completionPlan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const accepted = complete(completionPlan, { kind: "submittedText", submittedText: "é".repeat(MAX_INTERACTION_STRING_UTF8_BYTES / 2) }, "text");
  assert.equal(accepted.outcome.kind, "completed");
  const overUtf8 = waiting(completionPlan);
  const rejected = completeAction(completionPlan, overUtf8.snapshot, { actionId: overUtf8.snapshot.foregroundAction!.actionId, actionKind: "interaction", interactionKind: "text", payload: { kind: "submittedText", submittedText: `${"é".repeat(MAX_INTERACTION_STRING_UTF8_BYTES / 2)}x` } });
  assert.equal(rejected.outcome.kind, "invalidPayload");
  assert.deepEqual(rejected.snapshot, overUtf8.snapshot);

  const exactAggregate = interactionPlan("text", {
    kind: "text",
    hint: "h".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES - 1),
    accessibleName: { kind: "text", text: "a" },
  });
  assert.equal(validateInstructionPlan(exactAggregate).valid, true);
  const overAggregate = structuredClone(exactAggregate) as any;
  overAggregate.instructions[0].ui.hint += "h";
  assert.equal(validateInstructionPlan(overAggregate).valid, false);

  const hugePending = waiting(completionPlan);
  const huge = completeAction(completionPlan, hugePending.snapshot, { actionId: hugePending.snapshot.foregroundAction!.actionId, actionKind: "interaction", interactionKind: "text", payload: { kind: "submittedText", submittedText: "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES * 16) } });
  assert.equal(huge.outcome.kind, "invalidPayload");
  assert.deepEqual(huge.snapshot, hugePending.snapshot);
});

test("malformed interaction snapshot and settlement data are rejected", () => {
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const pending = waiting(plan);
  for (const mutate of [
    (snapshot: any) => { snapshot.foregroundAction.interactionKind = "number"; },
    (snapshot: any) => { snapshot.foregroundAction.destinationTemporary = null; },
    (snapshot: any) => { snapshot.foregroundAction.speakerId = 999; },
    (snapshot: any) => { snapshot.foregroundAction.ui.kind = "button"; },
  ]) {
    const malformed = structuredClone(pending.snapshot) as any;
    mutate(malformed);
    assert.equal(validateRuntimeSnapshot(malformed, plan).valid, false);
  }
  const done = complete(plan, { kind: "submittedText", submittedText: "ok" }, "text");
  const malformedSettlement = structuredClone(done.snapshot) as any;
  malformedSettlement.lastSettlement.result = 1;
  assert.equal(validateRuntimeSnapshot(malformedSettlement, plan).valid, false);
  const wrongTranscript = structuredClone(done.snapshot) as any;
  wrongTranscript.lastSettlement.transcriptText = "different";
  assert.equal(validateRuntimeSnapshot(wrongTranscript, plan).valid, false);
  const wrongDestination = structuredClone(done.snapshot) as any;
  wrongDestination.temporaries.find((temporary: any) => temporary.id === 1).value = "other";
  assert.equal(validateRuntimeSnapshot(wrongDestination, plan).valid, false);

  const standaloneUi = structuredClone(pending.snapshot) as any;
  standaloneUi.foregroundAction.ui.accessibleName.key = "continue";
  assert.equal(validateRuntimeSnapshot(standaloneUi).valid, false);
});

test("planless pending result interactions require positive destination temporary IDs", () => {
  for (const [kind, ui] of [
    ["text", { kind: "text", hint: null, accessibleName: defaults.text }],
    ["number", { kind: "number", hint: null, accessibleName: defaults.number }],
    ["choice", { kind: "choice", labelType: "none", options: [{ text: "One", label: null }], accessibleName: defaults.choice }],
  ] as const) {
    const plan = interactionPlan(kind, ui);
    const pending = waiting(plan);
    for (const destination of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
      const hostile = structuredClone(pending.snapshot) as any;
      hostile.foregroundAction.destinationTemporary = destination;
      assert.equal(validateRuntimeSnapshot(hostile).valid, false, `${kind}:${destination}`);
      assert.throws(() => restoreCheckpoint({ ...createCheckpoint(plan, pending.snapshot), snapshot: hostile }), `${kind}:${destination}`);
    }
  }
  const button = interactionPlan("button", { kind: "button", buttonLabel: "Continue", accessibleName: defaults.button });
  const pendingButton = waiting(button);
  const hostileButton = structuredClone(pendingButton.snapshot) as any;
  hostileButton.foregroundAction.destinationTemporary = 1;
  assert.equal(validateRuntimeSnapshot(hostileButton).valid, false);
});

test("planless interaction settlements enforce intrinsic transcript and result semantics", () => {
  const textPlan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const text = complete(textPlan, { kind: "submittedText", submittedText: "answer" }, "text").snapshot;
  assert.equal(validateRuntimeSnapshot(JSON.parse(JSON.stringify(text))).valid, true);
  const wrongText = structuredClone(text) as any;
  wrongText.lastSettlement.result = "different";
  wrongText.temporaries[0].value = "different";
  assert.equal(validateRuntimeSnapshot(wrongText).valid, false);

  const numberPlan = interactionPlan("number", { kind: "number", hint: null, accessibleName: defaults.number });
  const number = complete(numberPlan, { kind: "submittedText", submittedText: "1e1" }, "number").snapshot;
  assert.equal(validateRuntimeSnapshot(JSON.parse(JSON.stringify(number))).valid, true);
  for (const [result, transcript] of [[10, "nonsense"], [10, "1\u2028"], [11, "1e1"], [-0, "-0"]] as const) {
    const hostile = structuredClone(number) as any;
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
  const speakerPlan = { ...base, instructions: base.instructions.map((instruction, index) => index === waitIndex ? interaction : instruction) };
  const pending = waiting(speakerPlan);
  const bob = pending.snapshot.speakers.find((speaker) => speaker.identifier === "bob")!;
  const mutated = structuredClone(pending.snapshot) as any;
  mutated.foregroundAction.speakerId = bob.id;
  assert.equal(validateRuntimeSnapshot(mutated, speakerPlan).valid, false);

  const swappedIdentifiers = structuredClone(pending.snapshot) as any;
  const alice = swappedIdentifiers.speakers.find((speaker: any) => speaker.identifier === "alice");
  const swappedBob = swappedIdentifiers.speakers.find((speaker: any) => speaker.identifier === "bob");
  [alice.identifier, swappedBob.identifier] = [swappedBob.identifier, alice.identifier];
  swappedIdentifiers.foregroundAction.speakerId = swappedBob.id;
  assert.equal(validateRuntimeSnapshot(swappedIdentifiers, speakerPlan).valid, false);

  const alteredBinding = structuredClone(pending.snapshot) as any;
  const aliceBinding = alteredBinding.frames.flatMap((frame: any) => frame.bindings).find((binding: any) => binding.name === "alice");
  aliceBinding.value.speakerId = bob.id;
  assert.equal(validateRuntimeSnapshot(alteredBinding, speakerPlan).valid, false);

  const bindingResolved = structuredClone(pending.snapshot) as any;
  const binding = bindingResolved.frames.flatMap((frame: any) => frame.bindings).find((candidate: any) => candidate.name === "alice");
  binding.value.speakerId = bob.id;
  bindingResolved.foregroundAction.speakerId = bob.id;
  assert.equal(validateRuntimeSnapshot(bindingResolved, speakerPlan).valid, true);

  const defaultSpeakerPlan = structuredClone(speakerPlan) as any;
  defaultSpeakerPlan.instructions[waitIndex].speaker = null;
  assert.equal(validateInstructionPlan(defaultSpeakerPlan).valid, true);
  const defaultPending = waiting(defaultSpeakerPlan);
  const defaultAction = defaultPending.snapshot.foregroundAction;
  assert.equal(defaultAction?.kind === "interaction" && defaultAction.speakerId, defaultPending.snapshot.defaultSpeaker);
  const wrongDefault = structuredClone(defaultPending.snapshot) as any;
  wrongDefault.foregroundAction.speakerId = bob.id;
  assert.equal(validateRuntimeSnapshot(wrongDefault, defaultSpeakerPlan).valid, false);

  const explicitMutations: Array<(snapshot: any) => void> = [
    (snapshot) => {
      const frame = snapshot.frames.find((candidate: any) => candidate.bindings.some((binding: any) => binding.name === "alice"));
      frame.bindings = frame.bindings.filter((binding: any) => binding.name !== "alice");
      snapshot.foregroundAction.speakerId = null;
    },
    (snapshot) => {
      snapshot.frames.flatMap((frame: any) => frame.bindings).find((binding: any) => binding.name === "alice").value = "ordinary";
      snapshot.foregroundAction.speakerId = null;
    },
    (snapshot) => {
      snapshot.frames.flatMap((frame: any) => frame.bindings).find((binding: any) => binding.name === "alice").value = { kind: "speakerReference", speakerId: "bad", identifier: "alice" };
      snapshot.foregroundAction.speakerId = null;
    },
    (snapshot) => {
      snapshot.frames.flatMap((frame: any) => frame.bindings).find((binding: any) => binding.name === "alice").value = { kind: "speakerReference", speakerId: 999, identifier: "alice" };
      snapshot.foregroundAction.speakerId = null;
    },
    (snapshot) => { snapshot.foregroundAction.speakerId = null; },
  ];
  for (const mutate of explicitMutations) {
    const hostile = structuredClone(pending.snapshot) as any;
    mutate(hostile);
    assert.equal(validateRuntimeSnapshot(hostile, speakerPlan).valid, false);
    assert.throws(() => restoreCheckpoint({ ...createCheckpoint(speakerPlan, pending.snapshot), snapshot: hostile }));
  }

  for (const source of [
    "speaker alice {}\nspeaker bob {}\nfunction prompt(requested) { wait 1 }\nprompt(bob)\nexit",
    "speaker alice {}\nfunction prompt { wait 1 }\nprompt()\nexit",
  ]) {
    const scoped = buttonPlanFromSource(source);
    const interaction = scoped.instructions.find((instruction) => instruction.kind === "interaction") as any;
    interaction.speaker = source.includes("requested") ? "requested" : "alice";
    assert.equal(validateInstructionPlan(scoped).valid, true);
    const scopedPending = waiting(scoped);
    const binding = scopedPending.snapshot.frames.slice().reverse().flatMap((frame) => frame.bindings).find((candidate) => candidate.name === interaction.speaker);
    assert.equal(scopedPending.snapshot.foregroundAction?.kind === "interaction" && scopedPending.snapshot.foregroundAction.speakerId, (binding?.value as any).speakerId);
    assert.equal(validateRuntimeSnapshot(scopedPending.snapshot, scoped).valid, true);
  }

  const nestedBase = buttonPlanFromSource("speaker root {}\nspeaker bob {}\nif true { wait 1 }\nexit");
  const nestedInstruction = nestedBase.instructions.find((instruction) => instruction.kind === "interaction") as any;
  nestedInstruction.speaker = "alice";
  const nestedPending = waiting({ ...nestedBase, instructions: nestedBase.instructions.map((instruction) => instruction.kind === "interaction" ? { ...instruction, speaker: null } : instruction) });
  const nested = structuredClone(nestedPending.snapshot) as any;
  const rootSpeaker = nested.speakers.find((speaker: any) => speaker.identifier === "root");
  const nestedBob = nested.speakers.find((speaker: any) => speaker.identifier === "bob");
  nested.frames[0].bindings.push({ name: "alice", value: { kind: "speakerReference", speakerId: rootSpeaker.id, identifier: "root" } });
  nested.frames.at(-1).bindings.push({ name: "alice", value: { kind: "speakerReference", speakerId: nestedBob.id, identifier: "bob" } });
  nested.foregroundAction.speakerId = nestedBob.id;
  assert.equal(validateRuntimeSnapshot(nested, nestedBase).valid, true);
  nested.foregroundAction.speakerId = rootSpeaker.id;
  assert.equal(validateRuntimeSnapshot(nested, nestedBase).valid, false);
});

test("explicit accessible names must contain non-whitespace content", () => {
  for (const text of ["", " \t\r\n", "\u2028\u2029"]) {
    const base = interactionPlan("button", { kind: "button", buttonLabel: "Continue", accessibleName: defaults.button });
    const malformed = structuredClone(base) as any;
    malformed.instructions[0].ui.accessibleName = { kind: "text", text };
    assert.equal(validateInstructionPlan(malformed).valid, false, JSON.stringify(text));
    const pending = waiting(base);
    const malformedSnapshot = structuredClone(pending.snapshot) as any;
    malformedSnapshot.foregroundAction.ui.accessibleName = { kind: "text", text };
    assert.equal(validateRuntimeSnapshot(malformedSnapshot, base).valid, false, JSON.stringify(text));
  }
});

test("very large regex-bearing interaction strings fast-reject at plan and snapshot boundaries", () => {
  const huge = "a".repeat(MAX_INTERACTION_STRING_UTF8_BYTES * 32);
  const button = interactionPlan("button", { kind: "button", buttonLabel: "Continue", accessibleName: defaults.button });
  const hugeAccessible = structuredClone(button) as any;
  hugeAccessible.instructions[0].ui.accessibleName = { kind: "text", text: huge };
  assert.equal(validateInstructionPlan(hugeAccessible).valid, false);

  const identifier = interactionPlan("choice", { kind: "choice", labelType: "identifier", options: [{ text: "Visible", label: "valid" }], accessibleName: defaults.choice });
  const hugeIdentifier = structuredClone(identifier) as any;
  hugeIdentifier.instructions[0].ui.options[0].label = huge;
  assert.equal(validateInstructionPlan(hugeIdentifier).valid, false);

  const pending = waiting(identifier);
  const hostile = structuredClone(pending.snapshot) as any;
  hostile.foregroundAction.ui.options[0].label = huge;
  assert.equal(validateRuntimeSnapshot(hostile).valid, false);
});

test("interaction validation measures each accepted field once and stops after aggregate exhaustion", () => {
  const accepted = interactionPlan("choice", { kind: "choice", labelType: "identifier", options: [{ text: "One", label: "one" }, { text: "Two", label: "two" }], accessibleName: defaults.choice });
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

  const exhausted = structuredClone(accepted) as any;
  exhausted.instructions[0].ui.options = [
    { text: "a".repeat(40_000), label: "b".repeat(30_000) },
    ...Array.from({ length: 128 }, (_, index) => ({ text: `text${index}`, label: `label${index}` })),
  ];
  const exhaustedPlanStats = withValidationTestStatistics((finish) => {
    assert.equal(validateInstructionPlan(exhausted).valid, false);
    return finish();
  });
  assert.equal(exhaustedPlanStats.counts.interactionUtf8Measurements, 2);

  const pending = waiting(accepted);
  const hostile = structuredClone(pending.snapshot) as any;
  hostile.foregroundAction.ui.options = exhausted.instructions[0].ui.options;
  const exhaustedSnapshotStats = withValidationTestStatistics((finish) => {
    assert.equal(validateRuntimeSnapshot(hostile).valid, false);
    return finish();
  });
  assert.equal(exhaustedSnapshotStats.counts.interactionUtf8Measurements, 2);
});

test("huge completion kind tokens are not reflected or allowed to mutate canonical state", () => {
  const plan = interactionPlan("button", { kind: "button", buttonLabel: "Continue", accessibleName: defaults.button });
  const pending = waiting(plan);
  const huge = "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES * 32);
  for (const request of [
    { actionId: pending.snapshot.foregroundAction!.actionId, actionKind: huge },
    { actionId: pending.snapshot.foregroundAction!.actionId, actionKind: "interaction", interactionKind: huge },
  ]) {
    const before = JSON.stringify(pending.snapshot);
    const rejected = completeAction(plan, pending.snapshot, request);
    assert.equal(rejected.outcome.kind, "wrongActionKind");
    assert.equal(rejected.outcome.kind === "wrongActionKind" && rejected.outcome.receivedActionKind, "<invalid>");
    assert.deepEqual(rejected.events, []);
    assert.equal(JSON.stringify(rejected.snapshot), before);
  }
});

test("a foreground action is strictly newer than the retained settlement", () => {
  const compiled = compileSource("wait 1\nwait 1\nexit");
  assert.deepEqual(compiled.diagnostics, []);
  const base = compiled.plan!;
  const instructions = base.instructions.map((instruction) => instruction.kind === "wait" ? {
    kind: "interaction" as const,
    interactionKind: "button" as const,
    target: "standardChat" as const,
    speaker: null,
    destinationTemporary: null,
    expectedResult: "none" as const,
    ui: { kind: "button" as const, buttonLabel: "Continue", accessibleName: defaults.button },
    span: instruction.span,
  } : instruction);
  const plan = { ...base, instructions };
  assert.equal(validateInstructionPlan(plan).valid, true);
  const first = waiting(plan);
  const completed = completeAction(plan, first.snapshot, { actionId: first.snapshot.foregroundAction!.actionId, actionKind: "interaction", interactionKind: "button", payload: { kind: "activate" } });
  const second = run(plan, completed.snapshot);
  assert.equal(second.snapshot.status, "waiting");
  assert.notEqual(second.snapshot.lastSettlement, null);
  assert.equal(validateRuntimeSnapshot(second.snapshot, plan).valid, true);
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, second.snapshot)));
  assert.deepEqual(restored.snapshot, second.snapshot);

  const mutations: Array<(snapshot: any) => void> = [
    (snapshot) => { snapshot.lastSettlement.actionId = snapshot.foregroundAction.actionId + 1; snapshot.nextActionId = snapshot.lastSettlement.actionId + 1; },
    (snapshot) => { snapshot.lastSettlement.actionId = snapshot.foregroundAction.actionId; },
    (snapshot) => { snapshot.foregroundAction.requestEventSequence = snapshot.lastSettlement.completionEventSequence - 1; },
    (snapshot) => { snapshot.foregroundAction.requestEventSequence = snapshot.lastSettlement.completionEventSequence; },
  ];
  for (const mutate of mutations) {
    const hostile = structuredClone(second.snapshot) as any;
    mutate(hostile);
    assert.equal(validateRuntimeSnapshot(hostile, plan).valid, false);
    assert.throws(() => restoreCheckpoint({ ...createCheckpoint(plan, second.snapshot), snapshot: hostile }));
  }
});

test("terminal button completion remains inspectable and continuation runs only on later entry", () => {
  const withExit = interactionPlan("button", { kind: "button", buttonLabel: "Done", accessibleName: defaults.button });
  const plan = { ...withExit, rootEndInstruction: 1, instructions: withExit.instructions.slice(0, 1) };
  assert.equal(validateInstructionPlan(plan).valid, true);
  const pending = waiting(plan);
  const completed = completeAction(plan, pending.snapshot, { actionId: pending.snapshot.foregroundAction!.actionId, actionKind: "interaction", interactionKind: "button", payload: { kind: "activate" } });
  assert.equal(completed.snapshot.status, "running");
  assert.equal(validateRuntimeSnapshot(completed.snapshot, plan).valid, true);
  assert.deepEqual(completed.events.map((event) => event.kind), ["playerTranscript", "actionCompleted"]);
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, completed.snapshot)));
  const resumed = run(restored.plan, restored.snapshot);
  assert.equal(resumed.snapshot.status, "halted");
  assert.equal(validateRuntimeSnapshot(resumed.snapshot, plan).valid, true);
  assert.deepEqual(resumed.events.map((event) => event.kind), ["complete"]);
});

test("result-bearing interactions require an in-region continuation while function continuations cleanly halt", () => {
  for (const [kind, ui, payload] of [
    ["text", { kind: "text", hint: null, accessibleName: defaults.text }, { kind: "submittedText", submittedText: "value" }],
    ["number", { kind: "number", hint: null, accessibleName: defaults.number }, { kind: "submittedText", submittedText: "1" }],
    ["choice", { kind: "choice", labelType: "none", options: [{ text: "One", label: null }], accessibleName: defaults.choice }, { kind: "selectedText", selectedText: "One" }],
  ] as const) {
    const root = interactionPlan(kind, ui);
    const terminalRoot = { ...root, rootEndInstruction: 1, instructions: root.instructions.slice(0, 1) };
    assert.equal(validateInstructionPlan(terminalRoot).valid, false, kind);
    assert.throws(() => run(terminalRoot, createFreshRuntimeSnapshot(terminalRoot)), kind);

    const base = buttonPlanFromSource("function prompt { wait 1\nreturn }\nprompt()\nexit");
    const interactionIndex = base.instructions.findIndex((instruction) => instruction.kind === "interaction");
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
    const functionPlan = { ...base, temporaryCount: destinationTemporary, instructions: base.instructions.map((candidate, index) => index === interactionIndex ? instruction : candidate) };
    assert.equal(validateInstructionPlan(functionPlan).valid, true, kind);
    const pending = waiting(functionPlan);
    const completed = completeAction(functionPlan, pending.snapshot, { actionId: pending.snapshot.foregroundAction!.actionId, actionKind: "interaction", interactionKind: kind, payload });
    assert.equal(completed.outcome.kind, "completed", kind);
    const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(functionPlan, completed.snapshot)));
    const halted = run(restored.plan, restored.snapshot).snapshot;
    assert.equal(halted.status, "halted", kind);
    assert.equal(validateRuntimeSnapshot(halted, functionPlan).valid, true, kind);
  }
});

test("hostile completion objects reject before getters, mutation, events, or RNG advancement", () => {
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const pending = waiting(plan);
  let invoked = false;
  const request = { actionId: pending.snapshot.foregroundAction!.actionId, actionKind: "interaction", interactionKind: "text", get payload() { invoked = true; return {}; } };
  const rejected = completeAction(plan, pending.snapshot, request);
  assert.equal(rejected.outcome.kind, "invalidPayload");
  assert.equal(invoked, false);
  assert.deepEqual(rejected.snapshot, pending.snapshot);
  assert.deepEqual(rejected.events, []);
});

test("interaction plan and checkpoint boundaries reject malformed option domains and hostile shapes", () => {
  const base = interactionPlan("choice", { kind: "choice", labelType: "identifier", options: [{ text: "One", label: "one" }, { text: "Two", label: "two" }], accessibleName: defaults.choice });
  const mutations: Array<(plan: any) => void> = [
    (plan) => { plan.instructions[0].ui.options[1].label = "one"; },
    (plan) => { plan.instructions[0].ui.options[1].label = 2; },
    (plan) => { plan.instructions[0].ui.labelType = "number"; },
    (plan) => { plan.instructions[0].expectedResult = "number"; },
    (plan) => { plan.instructions[0].target = "other"; },
  ];
  for (const mutate of mutations) {
    const malformed = structuredClone(base) as any;
    mutate(malformed);
    assert.equal(validateInstructionPlan(malformed).valid, false);
    assert.throws(() => restoreCheckpoint({ ...createCheckpoint(base, createFreshRuntimeSnapshot(base)), plan: malformed }));
  }
  const cyclic = structuredClone(base) as any;
  cyclic.instructions[0].ui.options[0].cycle = cyclic;
  assert.equal(validateInstructionPlan(cyclic).valid, false);
  const sparse = structuredClone(base) as any;
  delete sparse.instructions[0].ui.options[0];
  assert.equal(validateInstructionPlan(sparse).valid, false);
  let invoked = false;
  const accessor = structuredClone(base) as any;
  Object.defineProperty(accessor.instructions[0].ui, "options", { enumerable: true, get() { invoked = true; return []; } });
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
    if (pending.snapshot.callFrames.length > 0) assert.equal(action.ownerCallFrameId, pending.snapshot.callFrames.at(-1)!.id);
    assert.equal(action.scopeDepth, pending.snapshot.frames.length);
    assert.equal(action.loopDepth, pending.snapshot.loopFrames.length);
    const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, pending.snapshot)));
    const completed = completeAction(restored.plan, restored.snapshot, { actionId: action.actionId, actionKind: "interaction", interactionKind: "button", payload: { kind: "activate" } });
    assert.equal(completed.outcome.kind, "completed");
    assert.equal(run(restored.plan, completed.snapshot).snapshot.status, "halted");
  }
});

test("one multibyte per-string failure stops all later interaction UTF-8 measurement", () => {
  const base = interactionPlan("choice", { kind: "choice", labelType: "none", options: [{ text: "ok", label: null }], accessibleName: defaults.choice });
  const overLimit = "\u20ac".repeat(30_000);
  assert.ok(overLimit.length <= MAX_INTERACTION_STRING_UTF8_BYTES);
  assert.ok(interactionUtf8ByteLength(overLimit) > MAX_INTERACTION_STRING_UTF8_BYTES);
  const hostile = structuredClone(base) as any;
  hostile.instructions[0].ui.options = Array.from({ length: MAX_INTERACTION_OPTION_ENTRIES }, () => ({ text: overLimit, label: null }));
  const planStats = withValidationTestStatistics((finish) => {
    assert.equal(validateInstructionPlan(hostile).valid, false);
    return finish();
  });
  assert.equal(planStats.counts.interactionUtf8Measurements, 1);

  const pending = waiting(base);
  const hostileSnapshot = structuredClone(pending.snapshot) as any;
  hostileSnapshot.foregroundAction.ui.options = hostile.instructions[0].ui.options;
  const snapshotStats = withValidationTestStatistics((finish) => {
    assert.equal(validateRuntimeSnapshot(hostileSnapshot).valid, false);
    return finish();
  });
  assert.equal(snapshotStats.counts.interactionUtf8Measurements, 1);
});

test("numeric settlement destinations distinguish canonical zero from negative zero", () => {
  for (const [plan, payload, kind] of [
    [interactionPlan("number", { kind: "number", hint: null, accessibleName: defaults.number }), { kind: "submittedText", submittedText: "-0" }, "number"],
    [interactionPlan("choice", { kind: "choice", labelType: "number", options: [{ text: "Zero", label: 0 }], accessibleName: defaults.choice }), { kind: "selectedLabel", selectedLabel: 0 }, "choice"],
  ] as const) {
    const completed = complete(plan, payload, kind);
    assert.equal(Object.is(completed.snapshot.temporaries[0]?.value, -0), false);
    assert.equal(validateRuntimeSnapshot(completed.snapshot, plan).valid, true);
    const hostile = structuredClone(completed.snapshot) as any;
    hostile.temporaries[0].value = -0;
    assert.equal(validateRuntimeSnapshot(hostile, plan).valid, false);
    assert.throws(() => createCheckpoint(plan, hostile));
    assert.throws(() => restoreCheckpoint({ ...createCheckpoint(plan, completed.snapshot), snapshot: hostile }));

    const roundTrip = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, completed.snapshot)));
    assert.equal(Object.is(roundTrip.snapshot.temporaries[0]?.value, -0), false);
    assert.equal(run(roundTrip.plan, roundTrip.snapshot).snapshot.status, "halted");
  }
});

test("completed text settlements retain only canonical non-whitespace LF text", () => {
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const completed = complete(plan, { kind: "submittedText", submittedText: "value" }, "text").snapshot;
  for (const text of ["", " \t\n", "\rvalue", "value\r\n"]) {
    const hostile = structuredClone(completed) as any;
    hostile.lastSettlement.result = text;
    hostile.lastSettlement.transcriptText = text;
    hostile.temporaries[0].value = text;
    assert.equal(validateRuntimeSnapshot(hostile).valid, false, JSON.stringify(text));
    assert.equal(validateRuntimeSnapshot(hostile, plan).valid, false, JSON.stringify(text));
    assert.throws(() => restoreCheckpoint({ ...createCheckpoint(plan, completed), snapshot: hostile }), JSON.stringify(text));
    assert.throws(() => run(plan, hostile), JSON.stringify(text));
  }
});

test("pending actions reserve their complete event sequence capacity", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const interaction = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const exactInteraction = createFreshRuntimeSnapshot(interaction);
  exactInteraction.nextEventSequence = max - 3;
  const pendingInteraction = run(interaction, exactInteraction);
  assert.equal(pendingInteraction.snapshot.status, "waiting");
  assert.equal(pendingInteraction.snapshot.nextEventSequence, max - 2);
  assert.doesNotThrow(() => createCheckpoint(interaction, pendingInteraction.snapshot));
  const completedInteraction = completeAction(interaction, pendingInteraction.snapshot, { actionId: pendingInteraction.snapshot.foregroundAction!.actionId, actionKind: "interaction", interactionKind: "text", payload: { kind: "submittedText", submittedText: "ok" } });
  assert.equal(completedInteraction.outcome.kind, "completed");
  assert.equal(completedInteraction.snapshot.nextEventSequence, max);
  const impossibleCompletion = structuredClone(pendingInteraction.snapshot) as any;
  impossibleCompletion.nextEventSequence = max - 1;
  const impossibleBefore = structuredClone(impossibleCompletion);
  assert.equal(validateRuntimeSnapshot(impossibleCompletion, interaction).valid, false);
  assert.throws(() => createCheckpoint(interaction, impossibleCompletion));
  assert.throws(() => completeAction(interaction, impossibleCompletion, { actionId: impossibleCompletion.foregroundAction.actionId, actionKind: "interaction", interactionKind: "text", payload: { kind: "submittedText", submittedText: "no write" } }));
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
  const base = interactionPlan("choice", { kind: "choice", labelType: "identifier", options: [{ text: "One", label: "one" }], accessibleName: defaults.choice });
  for (const mutate of [
    (instruction: any) => { instruction.extra = huge; },
    (instruction: any) => { instruction.ui.extra = huge; },
    (instruction: any) => { instruction.ui.accessibleName.extra = huge; },
    (instruction: any) => { instruction.ui.options[0].extra = huge; },
  ]) {
    const hostile = structuredClone(base) as any;
    mutate(hostile.instructions[0]);
    assert.equal(validateInstructionPlan(hostile).valid, false);
    assert.throws(() => run(hostile, createFreshRuntimeSnapshot(base)));
  }

  const pending = waiting(base);
  for (const mutate of [
    (snapshot: any) => { snapshot.foregroundAction.extra = huge; },
    (snapshot: any) => { snapshot.foregroundAction.ui.extra = huge; },
    (snapshot: any) => { snapshot.foregroundAction.ui.accessibleName.extra = huge; },
    (snapshot: any) => { snapshot.foregroundAction.ui.options[0].extra = huge; },
  ]) {
    const hostile = structuredClone(pending.snapshot) as any;
    mutate(hostile);
    assert.equal(validateRuntimeSnapshot(hostile, base).valid, false);
    assert.throws(() => restoreCheckpoint({ ...createCheckpoint(base, pending.snapshot), snapshot: hostile }));
    assert.throws(() => completeAction(base, hostile, { actionId: pending.snapshot.foregroundAction!.actionId, actionKind: "interaction", interactionKind: "choice", payload: { kind: "selectedLabel", selectedLabel: "one" } }));
  }

  const completed = complete(base, { kind: "selectedLabel", selectedLabel: "one" }, "choice");
  const settlementHostile = structuredClone(completed.snapshot) as any;
  settlementHostile.lastSettlement.extra = huge;
  assert.equal(validateRuntimeSnapshot(settlementHostile, base).valid, false);
  assert.throws(() => restoreCheckpoint({ ...createCheckpoint(base, completed.snapshot), snapshot: settlementHostile }));
  assert.throws(() => completeAction(base, settlementHostile, { actionId: completed.snapshot.lastSettlement!.actionId, actionKind: "interaction", interactionKind: "choice", payload: { kind: "selectedLabel", selectedLabel: "one" } }));

  const requested = pending.events.find((event) => event.kind === "actionRequested")!;
  assert.equal(requested.kind === "actionRequested" && Object.hasOwn(requested.action, "extra"), false);
  const duplicate = completeAction(base, completed.snapshot, { actionId: completed.snapshot.lastSettlement!.actionId, actionKind: "interaction", interactionKind: "choice", payload: { kind: "selectedLabel", selectedLabel: "one" } });
  assert.equal(duplicate.outcome.kind, "alreadySettled");
  assert.equal(duplicate.outcome.kind === "alreadySettled" && Object.hasOwn(duplicate.outcome.settlement, "extra"), false);

  const delayPlan = compileSource("wait 1\nexit").plan!;
  const delayPending = run(delayPlan, createFreshRuntimeSnapshot(delayPlan));
  const delayActionHostile = structuredClone(delayPending.snapshot) as any;
  delayActionHostile.foregroundAction.extra = huge;
  assert.equal(validateRuntimeSnapshot(delayActionHostile, delayPlan).valid, false);
  assert.throws(() => restoreCheckpoint({ ...createCheckpoint(delayPlan, delayPending.snapshot), snapshot: delayActionHostile }));
  const delayCompleted = observeTime(delayPlan, delayPending.snapshot, 1_000);
  const delaySettlementHostile = structuredClone(delayCompleted.snapshot) as any;
  delaySettlementHostile.lastSettlement.extra = huge;
  assert.equal(validateRuntimeSnapshot(delaySettlementHostile, delayPlan).valid, false);
  assert.throws(() => restoreCheckpoint({ ...createCheckpoint(delayPlan, delayCompleted.snapshot), snapshot: delaySettlementHostile }));
});

test("pending result destinations are absent in root, function, and loop execution", () => {
  const root = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  const functionPlan = (() => {
    const plan = buttonPlanFromSource("function prompt { wait 1\nreturn }\nprompt()\nexit");
    const index = plan.instructions.findIndex((instruction) => instruction.kind === "interaction");
    const destinationTemporary = plan.temporaryCount + 1;
    return { ...plan, temporaryCount: destinationTemporary, instructions: plan.instructions.map((instruction, instructionIndex) => instructionIndex === index ? { ...root.instructions[0], span: instruction.span, destinationTemporary } : instruction) } as InstructionPlan;
  })();
  const loopPlan = (() => {
    const plan = buttonPlanFromSource("repeat 1 { wait 1 }\nexit");
    const index = plan.instructions.findIndex((instruction) => instruction.kind === "interaction");
    const result = structuredClone({ ...plan, temporaryCount: 1, instructions: plan.instructions.map((instruction, instructionIndex) => instructionIndex === index ? { ...root.instructions[0], span: instruction.span } : instruction) }) as any;
    result.instructions.splice(index + 1, 0, { kind: "clearTemporary", temporaryId: 1, span: result.instructions[index].span });
    result.rootEndInstruction += 1;
    result.instructions[0].target += 1;
    return result as InstructionPlan;
  })();
  for (const plan of [root, functionPlan, loopPlan]) {
    assert.equal(validateInstructionPlan(plan).valid, true, JSON.stringify(validateInstructionPlan(plan).errors));
    const pending = waiting(plan);
    const destination = (pending.snapshot.foregroundAction as any).destinationTemporary;
    const hostile = structuredClone(pending.snapshot) as any;
    hostile.temporaries.push({ id: destination, value: "old" });
    assert.equal(validateRuntimeSnapshot(hostile).valid, false);
    assert.equal(validateRuntimeSnapshot(hostile, plan).valid, false);
    assert.throws(() => restoreCheckpoint({ ...createCheckpoint(plan, pending.snapshot), snapshot: hostile }));
    const completed = completeAction(plan, pending.snapshot, { actionId: pending.snapshot.foregroundAction!.actionId, actionKind: "interaction", interactionKind: "text", payload: { kind: "submittedText", submittedText: "new" } });
    assert.equal(completed.outcome.kind, "completed");
    assert.equal(completed.snapshot.temporaries.find((temporary) => temporary.id === destination)?.value, "new");
  }
});

test("accepted text completions perform one bounded UTF-8 measurement before normalization", () => {
  const plan = interactionPlan("text", { kind: "text", hint: null, accessibleName: defaults.text });
  for (const submittedText of ["ordinary", "a\r\nb\rc"]) {
    const pending = waiting(plan);
    const stats = withValidationTestStatistics((finish) => {
      const completed = completeAction(plan, pending.snapshot, { actionId: pending.snapshot.foregroundAction!.actionId, actionKind: "interaction", interactionKind: "text", payload: { kind: "submittedText", submittedText } });
      assert.equal(completed.outcome.kind, "completed");
      return finish();
    });
    assert.equal(stats.counts.interactionUtf8Measurements, 1, JSON.stringify(submittedText));
  }
});

test("result interactions reject occupied destinations before pending-action creation", () => {
  const base = interactionPlan("text", {
    kind: "text",
    hint: null,
    accessibleName: defaults.text,
  });
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
  const planValidation = validateInstructionPlan(occupiedPlan);
  assert.equal(planValidation.valid, false);
  assert.ok(planValidation.errors.some((error) =>
    error.message.includes("produced only by their owning interaction")
  ));

  const hostileSnapshot = createFreshRuntimeSnapshot(base);
  hostileSnapshot.temporaries.push({ id: 1, value: "old" });
  const before = structuredClone(hostileSnapshot);
  assert.equal(validateRuntimeSnapshot(hostileSnapshot, base).valid, false);
  assert.throws(() => run(base, hostileSnapshot));
  assert.deepEqual(hostileSnapshot, before);
  assert.equal(hostileSnapshot.foregroundAction, null);
  assert.equal(hostileSnapshot.nextActionId, before.nextActionId);
  assert.equal(hostileSnapshot.nextEventSequence, before.nextEventSequence);
});

test("result interactions use one bounded local handoff instead of future-path liveness", () => {
  const injected = injectTextInteraction(
    'let answer = "__interaction_result__"\nsay answer\nexit',
  );
  assert.equal(
    validateInstructionPlan(injected.plan).valid,
    true,
    JSON.stringify(validateInstructionPlan(injected.plan).errors),
  );

  const branch = structuredClone(injected.plan) as any;
  branch.instructions[injected.handoffInstruction] = {
    kind: "jump",
    target: injected.clearInstruction,
    span: branch.instructions[injected.handoffInstruction].span,
  };
  assert.equal(validateInstructionPlan(branch).valid, false);

  const secondBlockingAction = structuredClone(injected.plan) as any;
  secondBlockingAction.instructions[injected.handoffInstruction] = {
    kind: "wait",
    duration: {
      kind: "literal",
      value: 1,
      span: secondBlockingAction.instructions[injected.handoffInstruction].span,
    },
    unit: "ms",
    span: secondBlockingAction.instructions[injected.handoffInstruction].span,
  };
  assert.equal(validateInstructionPlan(secondBlockingAction).valid, false);

  const missingClear = structuredClone(injected.plan) as any;
  missingClear.instructions[injected.clearInstruction] = {
    kind: "say",
    speaker: null,
    value: {
      kind: "literal",
      value: "not a clear",
      span: missingClear.instructions[injected.clearInstruction].span,
    },
    span: missingClear.instructions[injected.clearInstruction].span,
  };
  assert.equal(validateInstructionPlan(missingClear).valid, false);

  const duplicateProducer = structuredClone(injected.plan) as any;
  duplicateProducer.instructions[injected.clearInstruction] = {
    kind: "storeTemporary",
    temporaryId: injected.destinationTemporary,
    value: {
      kind: "literal",
      value: "replacement",
      span: duplicateProducer.instructions[injected.clearInstruction].span,
    },
    expectBoolean: false,
    span: duplicateProducer.instructions[injected.clearInstruction].span,
  };
  assert.equal(validateInstructionPlan(duplicateProducer).valid, false);

  const targeted = injectTextInteraction([
    'function first { return "first" }',
    'let ignored = first()',
    'let answer = "__interaction_result__"',
    'say answer',
    'exit',
  ].join("\n"));
  const arbitraryUserCall = structuredClone(targeted.plan) as any;
  const existingCall = arbitraryUserCall.instructions.find(
    (instruction: any) => instruction.kind === "callFunction",
  );
  assert.notEqual(existingCall, undefined);
  arbitraryUserCall.instructions[targeted.handoffInstruction] = {
    ...structuredClone(existingCall),
    returnInstruction: targeted.clearInstruction,
    span: arbitraryUserCall.instructions[targeted.handoffInstruction].span,
  };
  assert.equal(validateInstructionPlan(arbitraryUserCall).valid, false);

  const targetedEntry = structuredClone(targeted.plan) as any;
  const call = targetedEntry.instructions.find(
    (instruction: any) => instruction.kind === "callFunction",
  );
  assert.notEqual(call, undefined);
  call.returnInstruction = targeted.handoffInstruction;
  assert.equal(validateInstructionPlan(targetedEntry).valid, false);

  const targetedCleanup = structuredClone(targeted.plan) as any;
  const cleanupCall = targetedCleanup.instructions.find(
    (instruction: any) => instruction.kind === "callFunction",
  );
  assert.notEqual(cleanupCall, undefined);
  cleanupCall.returnInstruction = targeted.clearInstruction;
  assert.equal(validateInstructionPlan(targetedCleanup).valid, false);

  const preparedReference = structuredClone(injected.plan) as any;
  preparedReference.temporaryCount += 1;
  preparedReference.instructions[injected.handoffInstruction] = {
    kind: "prepareReference",
    expression: {
      kind: "temporary",
      temporaryId: injected.destinationTemporary,
      span: preparedReference.instructions[injected.handoffInstruction].span,
    },
    destinationTemporary: preparedReference.temporaryCount,
    span: preparedReference.instructions[injected.handoffInstruction].span,
  };
  assert.equal(
    validateInstructionPlan(preparedReference).valid,
    true,
    JSON.stringify(validateInstructionPlan(preparedReference).errors),
  );

  const evaluated = structuredClone(injected.plan) as any;
  evaluated.instructions[injected.handoffInstruction] = {
    kind: "evaluate",
    expression: {
      kind: "temporary",
      temporaryId: injected.destinationTemporary,
      span: evaluated.instructions[injected.handoffInstruction].span,
    },
    span: evaluated.instructions[injected.handoffInstruction].span,
  };
  assert.equal(
    validateInstructionPlan(evaluated).valid,
    true,
    JSON.stringify(validateInstructionPlan(evaluated).errors),
  );

  const shortCircuited = structuredClone(injected.plan) as any;
  const shortCircuitSpan = shortCircuited.instructions[injected.handoffInstruction].span;
  shortCircuited.instructions[injected.handoffInstruction].value = {
    kind: "binary",
    operator: "and",
    left: { kind: "literal", value: false, span: shortCircuitSpan },
    right: {
      kind: "temporary",
      temporaryId: injected.destinationTemporary,
      span: shortCircuitSpan,
    },
    span: shortCircuitSpan,
  };
  assert.equal(validateInstructionPlan(shortCircuited).valid, false);

  const guaranteedLeft = structuredClone(injected.plan) as any;
  guaranteedLeft.instructions[injected.handoffInstruction].value = {
    ...shortCircuited.instructions[injected.handoffInstruction].value,
    left: shortCircuited.instructions[injected.handoffInstruction].value.right,
    right: shortCircuited.instructions[injected.handoffInstruction].value.left,
  };
  assert.equal(
    validateInstructionPlan(guaranteedLeft).valid,
    true,
    JSON.stringify(validateInstructionPlan(guaranteedLeft).errors),
  );

  const ignoredExtraField = structuredClone(injected.plan) as any;
  ignoredExtraField.instructions[injected.handoffInstruction].value = {
    kind: "literal",
    value: false,
    span: shortCircuitSpan,
    ignored: {
      kind: "temporary",
      temporaryId: injected.destinationTemporary,
      span: shortCircuitSpan,
    },
  };
  assert.equal(validateInstructionPlan(ignoredExtraField).valid, false);
});

test("completion commits atomically and every short handoff checkpoint boundary validates", () => {
  const injected = injectTextInteraction(
    'let answer = "__interaction_result__"\nsay answer\nexit',
  );
  const pending = waiting(injected.plan);
  const pendingBefore = structuredClone(pending.snapshot);
  const completed = completeAction(injected.plan, pending.snapshot, {
    actionId: pending.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "committed" },
  });

  assert.deepEqual(pending.snapshot, pendingBefore);
  assert.equal(completed.outcome.kind, "completed");
  assert.deepEqual(
    completed.events.map((event) => event.kind),
    ["playerTranscript", "actionCompleted"],
  );
  assert.equal(completed.snapshot.nextInstruction, injected.handoffInstruction);
  assert.deepEqual(completed.snapshot.interactionResultHandoff, {
    actionId: completed.snapshot.lastSettlement!.actionId,
    owningInstruction: injected.interactionInstruction,
    continuationInstruction: injected.handoffInstruction,
    ownerCallFrameId: null,
    destinationTemporary: injected.destinationTemporary,
    result: "committed",
  });
  assert.equal(completed.snapshot.frames[0]!.bindings.some((binding) => binding.name === "answer"), false);
  assert.equal(
    completed.snapshot.temporaries.find((temporary) =>
      temporary.id === injected.destinationTemporary
    )?.value,
    "committed",
  );
  assert.doesNotThrow(() => createCheckpoint(injected.plan, completed.snapshot));

  const forgedAtCommit = structuredClone(completed.snapshot);
  forgedAtCommit.temporaries.find((temporary) =>
    temporary.id === injected.destinationTemporary
  )!.value = "forged";
  assert.equal(validateRuntimeSnapshot(forgedAtCommit, injected.plan).valid, false);
  assert.throws(() => createCheckpoint(injected.plan, forgedAtCommit));

  const missingHandoff = structuredClone(completed.snapshot);
  missingHandoff.interactionResultHandoff = null;
  assert.equal(validateRuntimeSnapshot(missingHandoff, injected.plan).valid, false);
  assert.throws(() => createCheckpoint(injected.plan, missingHandoff));

  const forgedOwnerAtCommit = structuredClone(completed.snapshot) as any;
  forgedOwnerAtCommit.lastSettlement.ownerCallFrameId = 1;
  forgedOwnerAtCommit.interactionResultHandoff.ownerCallFrameId = 1;
  forgedOwnerAtCommit.nextCallFrameId = 2;
  assert.equal(validateRuntimeSnapshot(forgedOwnerAtCommit, injected.plan).valid, false);

  const extendedHandoff = structuredClone(completed.snapshot) as any;
  extendedHandoff.interactionResultHandoff.extra = true;
  assert.equal(validateRuntimeSnapshot(extendedHandoff, injected.plan).valid, false);

  const transferred = executeInstruction(injected.plan, completed.snapshot);
  assert.equal(transferred.snapshot.nextInstruction, injected.clearInstruction);
  assert.equal(transferred.snapshot.interactionResultHandoff, null);
  assert.equal(
    transferred.snapshot.frames[0]!.bindings.find((binding) => binding.name === "answer")?.value,
    "committed",
  );
  assert.doesNotThrow(() => createCheckpoint(injected.plan, transferred.snapshot));

  const forgedBeforeClear = structuredClone(transferred.snapshot);
  forgedBeforeClear.temporaries.find((temporary) =>
    temporary.id === injected.destinationTemporary
  )!.value = "forged";
  assert.equal(validateRuntimeSnapshot(forgedBeforeClear, injected.plan).valid, true);
  assert.doesNotThrow(() => createCheckpoint(injected.plan, forgedBeforeClear));
  const clearedForged = executeInstruction(injected.plan, forgedBeforeClear);
  assert.equal(
    clearedForged.snapshot.frames[0]!.bindings.find((binding) =>
      binding.name === "answer"
    )?.value,
    "committed",
  );

  const cleared = executeInstruction(injected.plan, transferred.snapshot);
  assert.equal(
    cleared.snapshot.temporaries.some((temporary) =>
      temporary.id === injected.destinationTemporary
    ),
    false,
  );
  assert.doesNotThrow(() => createCheckpoint(injected.plan, cleared.snapshot));

  const ordinaryMutation = structuredClone(cleared.snapshot);
  ordinaryMutation.frames[0]!.bindings.find((binding) => binding.name === "answer")!.value = "ordinary replacement";
  assert.equal(validateRuntimeSnapshot(ordinaryMutation, injected.plan).valid, true);
  assert.doesNotThrow(() => createCheckpoint(injected.plan, ordinaryMutation));
});

test("removed lifecycle fields and previous persisted versions are rejected structurally", () => {
  const plan = interactionPlan("text", {
    kind: "text",
    hint: null,
    accessibleName: defaults.text,
  });
  const snapshot = createFreshRuntimeSnapshot(plan);

  const oldLifecycle = structuredClone(snapshot) as any;
  oldLifecycle.lastSettlementResultState = "none";
  assert.equal(validateRuntimeSnapshot(oldLifecycle, plan).valid, false);
  assert.throws(() => createCheckpoint(plan, oldLifecycle));

  const oldPlan = structuredClone(plan) as any;
  oldPlan.version -= 1;
  assert.equal(validateInstructionPlan(oldPlan).valid, false);

  const oldSnapshot = structuredClone(snapshot) as any;
  oldSnapshot.version -= 1;
  assert.equal(validateRuntimeSnapshot(oldSnapshot, plan).valid, false);

  const oldCheckpoint = structuredClone(createCheckpoint(plan, snapshot)) as any;
  oldCheckpoint.version -= 1;
  assert.throws(() => restoreCheckpoint(oldCheckpoint));
});

test("a newer settlement cannot corrupt or orphan an unconsumed interaction handoff", () => {
  const injected = injectTextInteraction(
    'let answer = "__interaction_result__"\nwait 1 ms\nsay answer\nexit',
  );
  const waitIndex = injected.plan.instructions.findIndex(
    (instruction, index) => index > injected.clearInstruction && instruction.kind === "wait",
  );
  assert.notEqual(waitIndex, -1);

  const pending = waiting(injected.plan);
  const completed = completeAction(injected.plan, pending.snapshot, {
    actionId: pending.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "survives" },
  });
  const completedCheckpoint = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(injected.plan, completed.snapshot)),
  );

  const newer = structuredClone(completedCheckpoint.snapshot) as any;
  newer.lastSettlement = {
    actionId: 2,
    actionKind: "delay",
    settlementKind: "completed",
    owningInstruction: waitIndex,
    continuationInstruction: waitIndex + 1,
    requestEventSequence: 4,
    completionEventSequence: 5,
    deadlineMs: 0,
    completedAtMs: 0,
  };
  newer.nextActionId = 3;
  newer.nextEventSequence = 6;
  assert.equal(
    validateRuntimeSnapshot(newer, injected.plan).valid,
    true,
    JSON.stringify(validateRuntimeSnapshot(newer, injected.plan).errors),
  );

  const forged = structuredClone(newer);
  forged.temporaries.find((temporary: any) =>
    temporary.id === injected.destinationTemporary
  )!.value = "FORGED";
  assert.equal(validateRuntimeSnapshot(forged, injected.plan).valid, false);
  assert.throws(() => createCheckpoint(injected.plan, forged));

  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(injected.plan, newer)),
  );
  const transferred = executeInstruction(restored.plan, restored.snapshot);
  const cleared = executeInstruction(restored.plan, transferred.snapshot);
  assert.equal(
    cleared.snapshot.frames[0]!.bindings.find((binding) => binding.name === "answer")?.value,
    "survives",
  );
  assert.equal(
    cleared.snapshot.temporaries.some((temporary) =>
      temporary.id === injected.destinationTemporary
    ),
    false,
  );
  assert.equal(cleared.snapshot.lastSettlement?.actionKind, "delay");

  const roundTrip = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(restored.plan, cleared.snapshot)),
  );
  assert.deepEqual(roundTrip.snapshot, cleared.snapshot);
});

test("an active interaction handoff requires its settlement or a genuinely newer one", () => {
  const injected = injectTextInteraction(
    'wait 1 ms\nlet answer = "__interaction_result__"\nwait 1 ms\nsay answer\nexit',
  );
  const delayPending = run(
    injected.plan,
    createFreshRuntimeSnapshot(injected.plan),
  );
  assert.equal(delayPending.snapshot.foregroundAction?.kind, "delay");
  const delayCompleted = observeTime(injected.plan, delayPending.snapshot, 1);
  assert.equal(delayCompleted.snapshot.lastSettlement?.actionKind, "delay");
  const olderSettlement = structuredClone(delayCompleted.snapshot.lastSettlement!);

  const interactionPending = run(injected.plan, delayCompleted.snapshot);
  assert.equal(interactionPending.snapshot.foregroundAction?.kind, "interaction");
  const completed = completeAction(injected.plan, interactionPending.snapshot, {
    actionId: interactionPending.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "committed" },
  });
  assert.equal(completed.outcome.kind, "completed");
  assert.equal(
    validateRuntimeSnapshot(completed.snapshot, injected.plan).valid,
    true,
    JSON.stringify(validateRuntimeSnapshot(completed.snapshot, injected.plan).errors),
  );

  const laterWaitInstruction = injected.plan.instructions.findIndex(
    (instruction, index) =>
      index > injected.clearInstruction && instruction.kind === "wait",
  );
  assert.notEqual(laterWaitInstruction, -1);
  const equalWrongKind = structuredClone(completed.snapshot) as any;
  equalWrongKind.lastSettlement = {
    ...olderSettlement,
    actionId: completed.snapshot.interactionResultHandoff!.actionId,
    owningInstruction: laterWaitInstruction,
    continuationInstruction: laterWaitInstruction + 1,
  };
  for (const lastSettlement of [null, olderSettlement, equalWrongKind.lastSettlement]) {
    const malformed = structuredClone(completed.snapshot);
    malformed.lastSettlement = lastSettlement;
    assert.equal(validateRuntimeSnapshot(malformed, injected.plan).valid, false);
    assert.throws(() => createCheckpoint(injected.plan, malformed));
  }
});

test("pending, committed, transferred, and cleared interaction boundaries restore equivalently", () => {
  const cases = [
    {
      kind: "text" as const,
      ui: { kind: "text" as const, hint: null, accessibleName: defaults.text },
      payload: { kind: "submittedText", submittedText: "text" },
      expected: "text",
    },
    {
      kind: "number" as const,
      ui: { kind: "number" as const, hint: null, accessibleName: defaults.number },
      payload: { kind: "submittedText", submittedText: "12.5" },
      expected: 12.5,
    },
    {
      kind: "choice" as const,
      ui: {
        kind: "choice" as const,
        labelType: "identifier" as const,
        options: [{ text: "Visible", label: "stored" }],
        accessibleName: defaults.choice,
      },
      payload: { kind: "selectedLabel", selectedLabel: "stored" },
      expected: "stored",
    },
  ];

  for (const entry of cases) {
    const injected = injectInteraction(
      'let answer = "__interaction_result__"\nsay answer\nexit',
      entry.kind,
      entry.ui,
    );
    const pending = waiting(injected.plan);
    const restoredPending = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(injected.plan, pending.snapshot)),
    );
    const request = {
      actionId: pending.snapshot.foregroundAction!.actionId,
      actionKind: "interaction" as const,
      interactionKind: entry.kind,
      payload: entry.payload,
    };
    const uninterruptedCompleted = completeAction(injected.plan, pending.snapshot, request);
    const restoredCompleted = completeAction(restoredPending.plan, restoredPending.snapshot, request);
    assert.deepEqual(restoredCompleted, uninterruptedCompleted, entry.kind);

    const committedRoundTrip = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(injected.plan, uninterruptedCompleted.snapshot)),
    );
    const transferred = executeInstruction(committedRoundTrip.plan, committedRoundTrip.snapshot);
    const transferredRoundTrip = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(committedRoundTrip.plan, transferred.snapshot)),
    );
    const cleared = executeInstruction(transferredRoundTrip.plan, transferredRoundTrip.snapshot);
    const clearedRoundTrip = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(transferredRoundTrip.plan, cleared.snapshot)),
    );
    assert.equal(
      clearedRoundTrip.snapshot.frames[0]!.bindings.find((binding) => binding.name === "answer")?.value,
      entry.expected,
      entry.kind,
    );
  }
});

test("compiler-shaped binding, assignment, argument, nested function, and source order use the same handoff", () => {
  const cases = [
    {
      name: "binding",
      source: 'let answer = "__interaction_result__"\nsay answer\nexit',
    },
    {
      name: "assignment",
      source: 'let answer = "before"\nanswer = "__interaction_result__"\nsay answer\nexit',
    },
    {
      name: "function argument",
      source: 'function sendAnswer(value) { say value\nreturn }\nsendAnswer("__interaction_result__")\nexit',
    },
    {
      name: "nested function",
      source: 'function prompt { let answer = "__interaction_result__"\nsay answer\nreturn }\nprompt()\nexit',
    },
  ];

  for (const entry of cases) {
    const injected = injectTextInteraction(entry.source);
    const pending = waiting(injected.plan);
    const completed = completeAction(injected.plan, pending.snapshot, {
      actionId: pending.snapshot.foregroundAction!.actionId,
      actionKind: "interaction",
      interactionKind: "text",
      payload: { kind: "submittedText", submittedText: entry.name },
    });
    assert.equal(completed.snapshot.nextInstruction, injected.handoffInstruction, entry.name);
    assert.deepEqual(
      completed.events.map((event) => event.kind),
      ["playerTranscript", "actionCompleted"],
      entry.name,
    );
    const final = run(injected.plan, completed.snapshot);
    assert.equal(final.snapshot.status, "halted", entry.name);
    assert.ok(
      final.events.some((event) => event.kind === "say" && event.text === entry.name),
      entry.name,
    );
    assert.equal(validateRuntimeSnapshot(final.snapshot, injected.plan).valid, true, entry.name);
  }

  const complex = injectTextInteraction([
    'function foo { say "foo"\nreturn "first" }',
    'function bar { say "bar"\nreturn "third" }',
    'function send(first, answer, third) { say `${first}:${answer}:${third}`\nreturn }',
    'send(foo(), "__interaction_result__", bar())',
    'exit',
  ].join("\n"));
  const beforeInteraction = run(complex.plan, createFreshRuntimeSnapshot(complex.plan));
  assert.equal(beforeInteraction.snapshot.status, "waiting");
  assert.deepEqual(
    beforeInteraction.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["foo"],
  );
  const completed = completeAction(complex.plan, beforeInteraction.snapshot, {
    actionId: beforeInteraction.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "middle" },
  });
  assert.equal(
    completed.events.some((event) => event.kind === "say" && event.text === "bar"),
    false,
  );
  const final = run(complex.plan, completed.snapshot);
  assert.deepEqual(
    final.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["bar", "first:middle:third"],
  );

  const suspendedCaller = injectTextInteraction([
    'function first { return "first" }',
    'function prompt { return "__interaction_result__" }',
    'function send(before, answer) { say `${before}:${answer}`\nreturn }',
    'send(first(), prompt())',
    'exit',
  ].join("\n"));
  const suspendedPending = waiting(suspendedCaller.plan);
  assert.equal(suspendedPending.snapshot.callFrames.length, 1);
  assert.ok(
    suspendedPending.snapshot.callFrames[0]!.callerTemporaries.some(
      (temporary) => temporary.value === "first",
    ),
  );
  const suspendedCompleted = completeAction(
    suspendedCaller.plan,
    suspendedPending.snapshot,
    {
      actionId: suspendedPending.snapshot.foregroundAction!.actionId,
      actionKind: "interaction",
      interactionKind: "text",
      payload: { kind: "submittedText", submittedText: "middle" },
    },
  );
  const suspendedFinal = run(suspendedCaller.plan, suspendedCompleted.snapshot);
  assert.ok(
    suspendedFinal.events.some(
      (event) => event.kind === "say" && event.text === "first:middle",
    ),
  );
  assert.equal(
    validateRuntimeSnapshot(suspendedFinal.snapshot, suspendedCaller.plan).valid,
    true,
  );
});

test("a later foreground settlement replaces replay data without changing the ordinary result", () => {
  const injected = injectTextInteraction(
    'let answer = "__interaction_result__"\nwait 1 ms\nsay answer\nexit',
  );
  const pending = waiting(injected.plan);
  const completed = completeAction(injected.plan, pending.snapshot, {
    actionId: pending.snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "kept" },
  });
  const cleared = executeInstruction(
    injected.plan,
    executeInstruction(injected.plan, completed.snapshot).snapshot,
  );
  const delayPending = run(injected.plan, cleared.snapshot);
  assert.equal(delayPending.snapshot.foregroundAction?.kind, "delay");
  const delayCompleted = observeTime(injected.plan, delayPending.snapshot, 1);
  assert.equal(delayCompleted.snapshot.lastSettlement?.actionKind, "delay");
  assert.equal(
    delayCompleted.snapshot.frames[0]!.bindings.find((binding) => binding.name === "answer")?.value,
    "kept",
  );
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(injected.plan, delayCompleted.snapshot)),
  );
  const final = run(restored.plan, restored.snapshot);
  assert.ok(final.events.some((event) => event.kind === "say" && event.text === "kept"));
});

interface InjectedInteractionPlan {
  readonly plan: InstructionPlan;
  readonly destinationTemporary: number;
  readonly interactionInstruction: number;
  readonly handoffInstruction: number;
  readonly clearInstruction: number;
}

function injectTextInteraction(source: string): InjectedInteractionPlan {
  return injectInteraction(
    source,
    "text",
    { kind: "text", hint: null, accessibleName: defaults.text },
  );
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
    containsLiteralMarker(instruction, marker)
  );
  assert.notEqual(targetIndex, -1, source);
  assert.equal(
    base.instructions.filter((instruction) =>
      containsLiteralMarker(instruction, marker)
    ).length,
    1,
    source,
  );

  const destinationTemporary = base.temporaryCount + 1;
  const original = replaceLiteralMarker(
    base.instructions[targetIndex],
    marker,
    destinationTemporary,
  ) as Instruction;
  const span = original.span;
  const expectedResult = interactionKind === "number" ||
    (ui.kind === "choice" && ui.labelType === "number")
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
    temporaryCount: destinationTemporary,
    rootEndInstruction: shiftBoundary(base.rootEndInstruction, targetIndex),
    functions: base.functions.map((definition) => ({
      ...definition,
      entryInstruction: shiftBoundary(definition.entryInstruction, targetIndex),
      bodyEntryInstruction: shiftBoundary(definition.bodyEntryInstruction, targetIndex),
      implicitReturnInstruction: shiftBoundary(definition.implicitReturnInstruction, targetIndex),
      endInstruction: shiftBoundary(definition.endInstruction, targetIndex),
    })),
    instructions: [
      ...base.instructions.slice(0, targetIndex).map((instruction) =>
        shiftInstructionTargets(instruction, targetIndex)),
      interaction,
      original,
      { kind: "clearTemporary", temporaryId: destinationTemporary, span },
      ...base.instructions.slice(targetIndex + 1).map((instruction) =>
        shiftInstructionTargets(instruction, targetIndex)),
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

function shiftBoundary(value: number, insertionIndex: number): number {
  return value > insertionIndex ? value + 2 : value;
}

function shiftInstructionTargets(instruction: Instruction, insertionIndex: number): Instruction {
  switch (instruction.kind) {
    case "jump":
    case "jumpIfFalse":
    case "loopControl":
    case "prepareParameterDefault":
      return { ...instruction, target: shiftBoundary(instruction.target, insertionIndex) };
    case "loopStart":
      return {
        ...instruction,
        continueTarget: shiftBoundary(instruction.continueTarget, insertionIndex),
        target: shiftBoundary(instruction.target, insertionIndex),
      };
    case "callFunction":
      return {
        ...instruction,
        returnInstruction: shiftBoundary(instruction.returnInstruction, insertionIndex),
      };
    default:
      return instruction;
  }
}

function containsLiteralMarker(value: unknown, marker: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsLiteralMarker(item, marker));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "literal" && record.value === marker) return true;
  return Object.values(record).some((nested) => containsLiteralMarker(nested, marker));
}

function replaceLiteralMarker(
  value: unknown,
  marker: string,
  destinationTemporary: number,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => replaceLiteralMarker(item, marker, destinationTemporary));
  }
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record.kind === "literal" && record.value === marker) {
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

// Phase 1 deliberately retains the earlier focused regressions above.  These
// tables make the local handoff boundary explicit without replacing them.
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
  readonly needsCleanup: boolean;
  readonly assertResult: (
    snapshot: RuntimeSnapshot,
    events: readonly InterpreterEvent[],
    injected: InjectedInteractionPlan,
  ) => void;
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
      index === injected.handoffInstruction ? instruction : current),
  };
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
  assert.deepEqual(completed.events.map((event) => event.kind), [
    "playerTranscript",
    "actionCompleted",
  ]);
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
  assert.deepEqual(restoredBoundary.snapshot, restoredSnapshotBefore, `${label}: restored snapshot input`);
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
      makePlan: (injected) => replaceHandoffInstruction(injected, {
        kind: "clearTemporary",
        temporaryId: injected.destinationTemporary,
        span: injected.plan.instructions[injected.handoffInstruction]!.span,
      }),
      needsCleanup: false,
      assertResult: () => undefined,
    },
    {
      id: "PR194-form-exit",
      kind: "exit",
      source: 'let answer = "__interaction_result__"\nexit',
      makePlan: (injected) => replaceHandoffInstruction(injected, {
        kind: "exit",
        span: injected.plan.instructions[injected.handoffInstruction]!.span,
      }),
      needsCleanup: false,
      assertResult: (snapshot, events) => {
        assert.equal(snapshot.status, "halted");
        assert.ok(events.some((event) => event.kind === "exit"));
      },
    },
    {
      id: "PR194-form-return-void",
      kind: "returnVoid",
      source: 'function prompt { let ignored = "__interaction_result__"\nreturn }\nprompt()\nsay "after"\nexit',
      makePlan: (injected) => replaceHandoffInstruction(injected, {
        kind: "returnVoid",
        span: injected.plan.instructions[injected.handoffInstruction]!.span,
      }),
      needsCleanup: false,
      assertResult: (snapshot) => {
        assert.equal(snapshot.callFrames.length, 0);
      },
    },
    {
      id: "PR194-form-return-value",
      kind: "returnValue",
      source: 'function prompt { return "__interaction_result__" }\nlet answer = prompt()\nsay answer\nexit',
      makePlan: (injected) => injected.plan,
      needsCleanup: false,
      assertResult: (snapshot) => {
        assert.equal(snapshot.callFrames.length, 0);
      },
    },
    {
      id: "PR194-form-declare-binding",
      kind: "declareBinding",
      source: 'let answer = "__interaction_result__"\nsay answer\nexit',
      makePlan: (injected) => injected.plan,
      needsCleanup: true,
      assertResult: (snapshot) => assert.equal(bindingValue(snapshot, "answer"), "committed"),
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
      makePlan: (injected) => replaceHandoffInstruction(injected, {
        kind: "evaluate",
        expression: { kind: "temporary", temporaryId: injected.destinationTemporary, span: injected.plan.instructions[injected.handoffInstruction]!.span },
        span: injected.plan.instructions[injected.handoffInstruction]!.span,
      }),
      needsCleanup: true,
      assertResult: (snapshot) => assert.equal(snapshot.status, "running"),
    },
    {
      id: "PR194-form-store-temporary",
      kind: "storeTemporary",
      source: 'let answer = "__interaction_result__"\nexit',
      makePlan: (injected) => replaceHandoffInstruction(injected, {
        kind: "storeTemporary",
        temporaryId: injected.destinationTemporary + 1,
        value: { kind: "temporary", temporaryId: injected.destinationTemporary, span: injected.plan.instructions[injected.handoffInstruction]!.span },
        expectBoolean: false,
        span: injected.plan.instructions[injected.handoffInstruction]!.span,
      }, injected.plan.temporaryCount + 1),
      needsCleanup: true,
      assertResult: (snapshot, _events, injected) => assert.equal(
        temporaryValue(snapshot, injected.destinationTemporary + 1),
        "committed",
      ),
    },
    {
      id: "PR194-form-say",
      kind: "say",
      source: 'let answer = "__interaction_result__"\nexit',
      makePlan: (injected) => replaceHandoffInstruction(injected, {
        kind: "say",
        speaker: null,
        value: { kind: "temporary", temporaryId: injected.destinationTemporary, span: injected.plan.instructions[injected.handoffInstruction]!.span },
        span: injected.plan.instructions[injected.handoffInstruction]!.span,
      }),
      needsCleanup: true,
      assertResult: (_snapshot, events) => assert.ok(
        events.some((event) => event.kind === "say" && event.text === "committed"),
      ),
    },
    {
      id: "PR194-form-set-declared-speaker-property",
      kind: "setDeclaredSpeakerProperty",
      source: 'speaker guide {}\nspeaker guide\nlet answer = "__interaction_result__"\nexit',
      makePlan: (injected) => replaceHandoffInstruction(injected, {
        kind: "setDeclaredSpeakerProperty",
        speaker: "guide",
        name: "answer",
        value: { kind: "temporary", temporaryId: injected.destinationTemporary, span: injected.plan.instructions[injected.handoffInstruction]!.span },
        span: injected.plan.instructions[injected.handoffInstruction]!.span,
      }),
      needsCleanup: true,
      assertResult: (snapshot) => {
        const speaker = snapshot.speakers.find((entry) => entry.identifier === "guide");
        assert.ok(speaker !== undefined);
        assert.equal(speaker.properties.find((property) => property.name === "answer")?.value, "committed");
      },
    },
    {
      id: "PR194-form-prepare-reference",
      kind: "prepareReference",
      source: 'let answer = "__interaction_result__"\nexit',
      makePlan: (injected) => replaceHandoffInstruction(injected, {
        kind: "prepareReference",
        expression: { kind: "temporary", temporaryId: injected.destinationTemporary, span: injected.plan.instructions[injected.handoffInstruction]!.span },
        destinationTemporary: injected.destinationTemporary + 1,
        span: injected.plan.instructions[injected.handoffInstruction]!.span,
      }, injected.plan.temporaryCount + 1),
      needsCleanup: true,
      assertResult: (snapshot, _events, injected) => assertPreparedReference(
        temporaryValue(snapshot, injected.destinationTemporary + 1),
      ),
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
    const { completed } = completeCommittedTextInteraction(plan);
    const handoff = completed.snapshot.interactionResultHandoff;
    assert.ok(handoff !== null, row.id);
    assert.equal(handoff.destinationTemporary, injected.destinationTemporary, row.id);
    assert.equal(handoff.result, "committed", row.id);
    const restored = checkpointJsonRoundTrip(plan, completed.snapshot);
    const continuationBefore = structuredClone(restored.snapshot);
    const continued = executeInstruction(restored.plan, restored.snapshot);
    assert.deepEqual(restored.snapshot, continuationBefore, row.id);
    assert.equal(continued.snapshot.interactionResultHandoff, null, row.id);
    if (!row.needsCleanup) {
      assert.equal(
        continued.snapshot.temporaries.some((entry) => entry.id === injected.destinationTemporary),
        false,
        row.id,
      );
    }
    row.assertResult(continued.snapshot, continued.events, injected);
    assert.doesNotThrow(() => createCheckpoint(restored.plan, continued.snapshot), row.id);
    if (row.needsCleanup) {
      const cleanupBefore = structuredClone(continued.snapshot);
      const cleaned = executeInstruction(restored.plan, continued.snapshot);
      assert.deepEqual(continued.snapshot, cleanupBefore, row.id);
      assert.equal(cleaned.snapshot.temporaries.some((entry) => entry.id === injected.destinationTemporary), false, row.id);
    }
    if (row.kind === "returnVoid" || row.kind === "returnValue") {
      const final = run(restored.plan, continued.snapshot);
      assert.equal(final.snapshot.callFrames.length, 0, row.id);
      if (row.kind === "returnVoid") assert.ok(final.events.some((event) => event.kind === "say" && event.text === "after"), row.id);
      else {
        assert.equal(bindingValue(final.snapshot, "answer"), "committed", row.id);
        assert.ok(final.events.some((event) => event.kind === "say" && event.text === "committed"), row.id);
      }
    }
  }
});

interface AcceptedExpressionGuaranteeRow {
  readonly id: string;
  readonly category: string;
  readonly expression: ExpressionPlan;
  readonly temporaryCount?: number;
  readonly valid: true;
}

interface RejectedExpressionGuaranteeRow {
  readonly id: string;
  readonly category: string;
  readonly expression: unknown;
  readonly valid: false;
}

function temporaryExpression(temporaryId: number, span: SourceSpan): ExpressionPlan {
  return { kind: "temporary", temporaryId, span };
}

function literalExpression(value: string | number | boolean | null, span: SourceSpan): ExpressionPlan {
  return { kind: "literal", value, span };
}

function binaryExpression(
  operator: BinaryExpressionPlan["operator"],
  left: ExpressionPlan,
  right: ExpressionPlan,
  span: SourceSpan,
): ExpressionPlan {
  return { kind: "binary", operator, left, right, span };
}

function handoffPlanWithExpression(
  injected: InjectedInteractionPlan,
  expression: ExpressionPlan,
  temporaryCount = injected.plan.temporaryCount,
): InstructionPlan {
  return replaceHandoffInstruction(injected, {
    kind: "declareBinding",
    name: "answer",
    value: expression,
    span: injected.plan.instructions[injected.handoffInstruction]!.span,
  }, temporaryCount);
}

function handoffPlanWithMalformedExpression(
  injected: InjectedInteractionPlan,
  expression: unknown,
): InstructionPlan {
  const instruction = {
    kind: "declareBinding",
    name: "answer",
    value: expression,
    span: injected.plan.instructions[injected.handoffInstruction]!.span,
  };
  // Deliberately malformed external plan data cannot be represented by Instruction.
  return replaceHandoffInstruction(
    injected,
    instruction as unknown as Instruction,
    injected.plan.temporaryCount,
  );
}

test("PR194 matrix: expression consumption requires guaranteed evaluation", () => {
  const injected = injectTextInteraction('let answer = "__interaction_result__"\nexit');
  const span = injected.plan.instructions[injected.handoffInstruction]!.span;
  const destination = injected.destinationTemporary;
  const matching = temporaryExpression(destination, span);
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
      valid: true,
    },
    {
      id: "PR194-expression-list-element",
      category: "list",
      expression: {
        kind: "list",
        elements: [matching],
        span,
      },
      valid: true,
    },
    {
      id: "PR194-expression-set-element",
      category: "set",
      expression: {
        kind: "set",
        elements: [matching],
        span,
      },
      valid: true,
    },
    {
      id: "PR194-expression-object-property-value",
      category: "object",
      expression: {
        kind: "object",
        properties: [
          {
            name: "answer",
            value: matching,
            span,
          },
        ],
        span,
      },
      valid: true,
    },
    {
      id: "PR194-expression-group",
      category: "group",
      expression: {
        kind: "group",
        expression: matching,
        span,
      },
      valid: true,
    },
    {
      id: "PR194-expression-template-part",
      category: "template",
      expression: {
        kind: "template",
        parts: [
          {
            kind: "text",
            value: "answer: ",
            span,
          },
          {
            kind: "expression",
            expression: matching,
            span,
          },
        ],
        span,
      },
      valid: true,
    },
    {
      id: "PR194-expression-property-object",
      category: "property",
      expression: {
        kind: "property",
        object: matching,
        name: "length",
        span,
      },
      valid: true,
    },
    {
      id: "PR194-expression-index-object",
      category: "index",
      expression: {
        kind: "index",
        object: matching,
        index: literalExpression(0, span),
        span,
      },
      valid: true,
    },
    { id: "PR194-expression-index-index", category: "index", expression: { kind: "index", object: { kind: "list", elements: [literalExpression("value", span)], span }, index: matching, span }, valid: true },
    { id: "PR194-expression-property-call-receiver", category: "call", expression: { kind: "call", callee: { kind: "property", object: matching, name: "contains", span }, arguments: [], span }, valid: true },
    { id: "PR194-expression-positional-call-argument", category: "call", expression: { kind: "call", callee: propertyCallee, arguments: [{ kind: "positional", value: matching, span }], span }, valid: true },
    { id: "PR194-expression-named-call-argument", category: "call", expression: { kind: "call", callee: propertyCallee, arguments: [{ kind: "named", name: "value", value: matching, span }], span }, valid: true },
    { id: "PR194-expression-unary-operand", category: "unary", expression: { kind: "unary", operator: "not", operand: matching, span }, valid: true },
    { id: "PR194-expression-eager-left", category: "binary", expression: binaryExpression("==", matching, literalExpression("committed", span), span), valid: true },
    { id: "PR194-expression-eager-right", category: "binary", expression: binaryExpression("==", literalExpression("committed", span), matching, span), valid: true },
    { id: "PR194-expression-range-start", category: "range", expression: { kind: "range", start: matching, end: literalExpression(2, span), inclusive: true, span }, valid: true },
    { id: "PR194-expression-range-end", category: "range", expression: { kind: "range", start: literalExpression(1, span), end: matching, inclusive: true, span }, valid: true },
    { id: "PR194-expression-and-left", category: "short-circuit", expression: binaryExpression("and", matching, literalExpression(true, span), span), valid: true },
    { id: "PR194-expression-or-left", category: "short-circuit", expression: binaryExpression("or", matching, literalExpression(false, span), span), valid: true },
    { id: "PR194-expression-multiple-guaranteed", category: "multiple", expression: { kind: "list", elements: [matching, matching], span }, valid: true },
    {
      id: "PR194-expression-wrong-and-correct",
      category: "multiple",
      expression: { kind: "list", elements: [wrong, matching], span },
      temporaryCount: injected.plan.temporaryCount + 1,
      valid: true,
    },
  ];
  const rejected: readonly RejectedExpressionGuaranteeRow[] = [
    { id: "PR194-expression-no-occurrence", category: "missing", expression: literalExpression(false, span), valid: false },
    { id: "PR194-expression-wrong-temporary", category: "wrong temporary", expression: wrong, valid: false },
    { id: "PR194-expression-prepared-reference", category: "prepared reference", expression: { kind: "preparedReference", temporaryId: destination, span }, valid: false },
    { id: "PR194-expression-and-right-false", category: "short-circuit", expression: binaryExpression("and", literalExpression(false, span), matching, span), valid: false },
    { id: "PR194-expression-and-right-true", category: "short-circuit", expression: binaryExpression("and", literalExpression(true, span), matching, span), valid: false },
    { id: "PR194-expression-or-right-false", category: "short-circuit", expression: binaryExpression("or", literalExpression(false, span), matching, span), valid: false },
    { id: "PR194-expression-or-right-true", category: "short-circuit", expression: binaryExpression("or", literalExpression(true, span), matching, span), valid: false },
    { id: "PR194-expression-nested-short-circuit-right", category: "short-circuit", expression: binaryExpression("and", literalExpression(true, span), binaryExpression("or", literalExpression(false, span), matching, span), span), valid: false },
    { id: "PR194-expression-non-property-callee", category: "call", expression: { kind: "call", callee: matching, arguments: [], span }, valid: false },
    { id: "PR194-expression-template-text-metadata", category: "metadata", expression: { kind: "template", parts: [{ kind: "text", value: "ignored", span, temporaryId: destination }], span } as unknown, valid: false },
    { id: "PR194-expression-ignored-extra-field", category: "ignored field", expression: { kind: "literal", value: false, span, ignored: matching }, valid: false },
    { id: "PR194-expression-wrong-left-correct-right", category: "short-circuit", expression: binaryExpression("or", wrong, matching, span), valid: false },
  ];

  for (const row of accepted) {
    const plan = handoffPlanWithExpression(
      injected,
      row.expression,
      row.temporaryCount,
    );
    const before = structuredClone(plan);
    const validation = validateInstructionPlan(plan);
    assert.equal(validation.valid, true, `${row.id}: ${row.category}`);
    assert.deepEqual(plan, before, row.id);
  }

  for (const row of rejected) {
    const plan = handoffPlanWithMalformedExpression(injected, row.expression);
    const before = structuredClone(plan);
    const validation = validateInstructionPlan(plan);
    assert.equal(validation.valid, false, `${row.id}: ${row.category}`);
    assert.ok(validation.errors.some((error) => error.code === "TSC002"), row.id);
    assert.deepEqual(plan, before, row.id);
  }

  for (const row of accepted.filter((entry) => [
    "PR194-expression-direct-temporary",
    "PR194-expression-list-element",
    "PR194-expression-eager-right",
    "PR194-expression-multiple-guaranteed",
  ].includes(entry.id))) {
    const plan = handoffPlanWithExpression(injected, row.expression);
    const { completed } = completeCommittedTextInteraction(plan);
    const continued = executeInstruction(plan, completed.snapshot);
    assert.equal(continued.snapshot.interactionResultHandoff, null, row.id);
  }
});

test("PR194 matrix: continuation kinds read only their canonical expression field", () => {
  const injected = injectTextInteraction('let answer = "__interaction_result__"\nexit');
  const span = injected.plan.instructions[injected.handoffInstruction]!.span;
  const destination = temporaryExpression(injected.destinationTemporary, span);
  const ignored = literalExpression(false, span);
  const validRows: readonly { readonly id: string; readonly instruction: Instruction; readonly temporaryCount: number }[] = [
    {
      id: "PR194-dispatch-evaluate-expression",
      instruction: { kind: "evaluate", expression: destination, span },
      temporaryCount: injected.plan.temporaryCount,
    },
    {
      id: "PR194-dispatch-prepare-reference-expression",
      instruction: {
        kind: "prepareReference",
        expression: destination,
        destinationTemporary: injected.destinationTemporary + 1,
        span,
      },
      temporaryCount: injected.plan.temporaryCount + 1,
    },
    {
      id: "PR194-dispatch-declare-binding-value",
      instruction: { kind: "declareBinding", name: "answer", value: destination, span },
      temporaryCount: injected.plan.temporaryCount,
    },
  ];
  for (const row of validRows) {
    const plan = replaceHandoffInstruction(injected, row.instruction, row.temporaryCount);
    const before = structuredClone(plan);
    assert.equal(validateInstructionPlan(plan).valid, true, row.id);
    assert.deepEqual(plan, before, row.id);
  }

  const invalidRows: readonly { readonly id: string; readonly instruction: unknown }[] = [
    {
      id: "PR194-dispatch-evaluate-value-ignored",
      instruction: { kind: "evaluate", expression: ignored, value: destination, span },
    },
    {
      id: "PR194-dispatch-prepare-reference-value-ignored",
      instruction: {
        kind: "prepareReference",
        expression: ignored,
        value: destination,
        destinationTemporary: injected.destinationTemporary + 1,
        span,
      },
    },
    {
      id: "PR194-dispatch-declare-binding-expression-ignored",
      instruction: { kind: "declareBinding", name: "answer", value: ignored, expression: destination, span },
    },
  ];
  for (const row of invalidRows) {
    // Deliberately unsupported sibling fields exercise public malformed-plan validation.
    const plan = replaceHandoffInstruction(injected, row.instruction as Instruction);
    const before = structuredClone(plan);
    const validation = validateInstructionPlan(plan);
    assert.equal(validation.valid, false, row.id);
    assert.ok(validation.errors.some((error) => error.code === "TSC002"), row.id);
    assert.deepEqual(plan, before, row.id);
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
  readonly category: "malformed settlement" | "malformed handoff" | "handoff disagreement" | "incompatible lifecycle" | "counter" | "chronology";
  readonly mutate: (snapshot: ExternalRecord, fixture: SettlementHandoffFixture) => void;
}

function externalTemporary(snapshot: ExternalRecord, temporaryId: number): ExternalRecord {
  const temporaries = externalArray(snapshot.temporaries, "temporaries");
  const temporary = temporaries.find((entry) => externalRecord(entry, "temporary").id === temporaryId);
  assert.ok(temporary !== undefined, `missing temporary ${temporaryId}`);
  return externalRecord(temporary, "temporary");
}

function settledHandoffFixture(): SettlementHandoffFixture {
  const injected = injectTextInteraction(
    'wait 1 ms\nlet answer = "__interaction_result__"\nwait 1 ms\nsay answer\nexit',
  );
  const firstDelay = run(injected.plan, createFreshRuntimeSnapshot(injected.plan));
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
  validatedCompositeWithNewerSettlement.currentSessionTimeMs = laterSettled.snapshot.currentSessionTimeMs;
  const compositeValidation = validateRuntimeSnapshot(validatedCompositeWithNewerSettlement, injected.plan);
  assert.equal(compositeValidation.valid, true, JSON.stringify(compositeValidation.errors));
  const compositeRoundTrip = checkpointJsonRoundTrip(injected.plan, validatedCompositeWithNewerSettlement);
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
    () => createCheckpoint(plan, invalidSnapshot as unknown as RuntimeSnapshot),
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
      id: "PR194-settlement-exact-matching-roundtrip",
      snapshot: checkpointJsonRoundTrip(injected.plan, committed).snapshot,
    },
    {
      id: "PR194-settlement-validated-composite-newer-delay",
      snapshot: validatedCompositeWithNewerSettlement,
    },
    {
      id: "PR194-settlement-validated-composite-newer-delay-roundtrip",
      snapshot: checkpointJsonRoundTrip(
        injected.plan,
        validatedCompositeWithNewerSettlement,
      ).snapshot,
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

  const beforeContinuation = structuredClone(validatedCompositeWithNewerSettlement);
  const continued = executeInstruction(injected.plan, validatedCompositeWithNewerSettlement);
  assert.equal(continued.snapshot.interactionResultHandoff, null, "PR194-newer-settlement-consume");
  assert.equal(bindingValue(continued.snapshot, "answer"), "committed");
  assert.deepEqual(continued.snapshot.lastSettlement, fixture.laterDelaySettlement);
  assert.deepEqual(validatedCompositeWithNewerSettlement, beforeContinuation);
  const cleaned = executeInstruction(injected.plan, continued.snapshot);
  assert.equal(
    cleaned.snapshot.temporaries.some((entry) => entry.id === injected.destinationTemporary),
    false,
  );
  assert.deepEqual(cleaned.snapshot.lastSettlement, fixture.laterDelaySettlement);
  assert.deepEqual(
    checkpointJsonRoundTrip(injected.plan, cleaned.snapshot).snapshot,
    cleaned.snapshot,
  );

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
        const handoffActionId = externalRecord(snapshot.interactionResultHandoff, "handoff").actionId;
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
          (entry) => externalRecord(entry, "temporary").id === current.injected.destinationTemporary,
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
    assertRejectedSettlementHandoffSnapshot(injected.plan, committed, invalid, `${row.category}: ${row.id}`);
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
});

// Retained focused replay regression until phase-2 consolidation.
test("PR194 matrix: settlement authority and replay remain atomic", () => {
  const injected = injectTextInteraction(
    'let answer = "__interaction_result__"\nsay answer\nexit',
  );
  const pending = waiting(injected.plan);
  const action = pending.snapshot.foregroundAction;
  assert.ok(action !== null);
  const request = {
    actionId: action.actionId,
    actionKind: "interaction" as const,
    interactionKind: "text" as const,
    payload: { kind: "submittedText" as const, submittedText: "committed" },
  };
  const completed = completeAction(injected.plan, pending.snapshot, request);
  const consumed = executeInstruction(injected.plan, completed.snapshot);
  const cleaned = run(injected.plan, consumed.snapshot).snapshot;
  const boundaries = [
    completed.snapshot,
    checkpointJsonRoundTrip(injected.plan, completed.snapshot).snapshot,
    consumed.snapshot,
    cleaned,
  ];
  for (const boundary of boundaries) {
    const before = structuredClone(boundary);
    const replay = completeAction(injected.plan, boundary, request);
    assert.equal(replay.outcome.kind, "alreadySettled", "PR194-duplicate-replay");
    assert.deepEqual(replay.events, []);
    assert.deepEqual(replay.snapshot, before);
  }
});

interface TextInteractionCompletionRequest {
  readonly actionId: number;
  readonly actionKind: "interaction";
  readonly interactionKind: "text";
  readonly payload: {
    readonly kind: "submittedText";
    readonly submittedText: string;
  };
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
      readonly payload: {
        readonly kind: "time";
        readonly currentSessionTimeMs: number;
      };
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
    payload: {
      kind: "submittedText",
      submittedText: "committed",
    },
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
      assert.deepEqual(replay.outcome.settlement, row.snapshot.lastSettlement, `${row.id}: settlement`);
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

test("PR194 matrix: bounded replay is exact-once across ordinary and direct handoff boundaries", () => {
  const ordinary = injectTextInteraction('let answer = "__interaction_result__"\nsay answer\nexit');
  const pending = waiting(ordinary.plan);
  const request = textCompletionRequest(pending.snapshot);
  const completion = completeAction(ordinary.plan, pending.snapshot, request);
  assert.equal(completion.outcome.kind, "completed");
  assert.deepEqual(completion.events.map((event) => event.kind), ["playerTranscript", "actionCompleted"]);
  assert.equal(completion.events.some((event) => event.kind === "say"), false);
  const consumed = executeInstruction(ordinary.plan, completion.snapshot);
  const cleaned = executeInstruction(ordinary.plan, consumed.snapshot);
  const finalRun = run(ordinary.plan, cleaned.snapshot);
  const halted = finalRun.snapshot;
  assert.deepEqual(finalRun.events.filter((event) => event.kind === "say").map((event) => event.text), ["committed"]);

  const directClearInjected = injectTextInteraction('let answer = "__interaction_result__"\nexit');
  const directClearPlan = replaceHandoffInstruction(directClearInjected, {
    kind: "clearTemporary",
    temporaryId: directClearInjected.destinationTemporary,
    span: directClearInjected.plan.instructions[directClearInjected.handoffInstruction]!.span,
  });
  const directClearPending = waiting(directClearPlan);
  const directClearRequest = textCompletionRequest(directClearPending.snapshot);
  const directClearCommitted = completeAction(directClearPlan, directClearPending.snapshot, directClearRequest);
  const afterDirectClear = executeInstruction(directClearPlan, directClearCommitted.snapshot).snapshot;

  const directExitInjected = injectTextInteraction('let answer = "__interaction_result__"\nexit');
  const directExitPlan = replaceHandoffInstruction(directExitInjected, {
    kind: "exit",
    span: directExitInjected.plan.instructions[directExitInjected.handoffInstruction]!.span,
  });
  const directExitPending = waiting(directExitPlan);
  const directExitRequest = textCompletionRequest(directExitPending.snapshot);
  const directExitCommitted = completeAction(directExitPlan, directExitPending.snapshot, directExitRequest);
  const afterDirectExit = executeInstruction(directExitPlan, directExitCommitted.snapshot).snapshot;

  const directReturnInjected = injectTextInteraction(
    'function prompt { let ignored = "__interaction_result__"\nreturn }\nprompt()\nsay "after"\nexit',
  );
  const directReturnPlan = replaceHandoffInstruction(directReturnInjected, {
    kind: "returnVoid",
    span: directReturnInjected.plan.instructions[directReturnInjected.handoffInstruction]!.span,
  });
  const directReturnPending = waiting(directReturnPlan);
  const directReturnRequest = textCompletionRequest(directReturnPending.snapshot);
  const directReturnCommitted = completeAction(
    directReturnPlan,
    directReturnPending.snapshot,
    directReturnRequest,
  );
  const afterDirectReturn = executeInstruction(directReturnPlan, directReturnCommitted.snapshot).snapshot;

  const rows: readonly ReplayRow[] = [
    {
      id: "PR194-replay-committed",
      plan: ordinary.plan,
      snapshot: completion.snapshot,
      request,
      expected: { kind: "alreadySettled" },
    },
    {
      id: "PR194-replay-committed-roundtrip",
      plan: ordinary.plan,
      snapshot: checkpointJsonRoundTrip(ordinary.plan, completion.snapshot).snapshot,
      request,
      expected: { kind: "alreadySettled" },
    },
    {
      id: "PR194-replay-consumed",
      plan: ordinary.plan,
      snapshot: consumed.snapshot,
      request,
      expected: { kind: "alreadySettled" },
    },
    {
      id: "PR194-replay-consumed-roundtrip",
      plan: ordinary.plan,
      snapshot: checkpointJsonRoundTrip(ordinary.plan, consumed.snapshot).snapshot,
      request,
      expected: { kind: "alreadySettled" },
    },
    {
      id: "PR194-replay-cleaned",
      plan: ordinary.plan,
      snapshot: cleaned.snapshot,
      request,
      expected: { kind: "alreadySettled" },
    },
    {
      id: "PR194-replay-cleaned-roundtrip",
      plan: ordinary.plan,
      snapshot: checkpointJsonRoundTrip(ordinary.plan, cleaned.snapshot).snapshot,
      request,
      expected: { kind: "alreadySettled" },
    },
    {
      id: "PR194-replay-halted",
      plan: ordinary.plan,
      snapshot: halted,
      request,
      expected: { kind: "alreadySettled" },
    },
    {
      id: "PR194-replay-halted-roundtrip",
      plan: ordinary.plan,
      snapshot: checkpointJsonRoundTrip(ordinary.plan, halted).snapshot,
      request,
      expected: { kind: "alreadySettled" },
    },
    {
      id: "PR194-replay-direct-clear",
      plan: directClearPlan,
      snapshot: afterDirectClear,
      request: directClearRequest,
      expected: { kind: "alreadySettled" },
    },
    {
      id: "PR194-replay-direct-exit",
      plan: directExitPlan,
      snapshot: afterDirectExit,
      request: directExitRequest,
      expected: { kind: "alreadySettled" },
    },
    {
      id: "PR194-replay-direct-return",
      plan: directReturnPlan,
      snapshot: afterDirectReturn,
      request: directReturnRequest,
      expected: { kind: "alreadySettled" },
    },
    {
      id: "PR194-replay-next-action-unknown",
      plan: ordinary.plan,
      snapshot: cleaned.snapshot,
      request: {
        ...request,
        actionId: cleaned.snapshot.nextActionId,
      },
      expected: {
        kind: "unknownAction",
        actionId: cleaned.snapshot.nextActionId,
      },
    },
  ];
  for (const row of rows) assertReplayRow(row);

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
  const compositeCleaned = executeInstruction(settlementFixture.injected.plan, compositeConsumed).snapshot;
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
      expected: {
        kind: "staleAction",
        actionId: oldRequest.actionId,
      },
    },
    {
      id: "PR194-replay-old-interaction-newer-composite-roundtrip",
      plan: settlementFixture.injected.plan,
      snapshot: checkpointJsonRoundTrip(settlementFixture.injected.plan, composite).snapshot,
      request: oldRequest,
      expected: {
        kind: "staleAction",
        actionId: oldRequest.actionId,
      },
    },
    {
      id: "PR194-replay-old-interaction-after-consume",
      plan: settlementFixture.injected.plan,
      snapshot: compositeConsumed,
      request: oldRequest,
      expected: {
        kind: "staleAction",
        actionId: oldRequest.actionId,
      },
    },
    {
      id: "PR194-replay-old-interaction-after-cleanup",
      plan: settlementFixture.injected.plan,
      snapshot: compositeCleaned,
      request: oldRequest,
      expected: {
        kind: "staleAction",
        actionId: oldRequest.actionId,
      },
    },
    {
      id: "PR194-replay-old-interaction-cleanup-roundtrip",
      plan: settlementFixture.injected.plan,
      snapshot: checkpointJsonRoundTrip(
        settlementFixture.injected.plan,
        compositeCleaned,
      ).snapshot,
      request: oldRequest,
      expected: {
        kind: "staleAction",
        actionId: oldRequest.actionId,
      },
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
  readonly assertUntouchedTarget: (snapshot: RuntimeSnapshot, injected: InjectedInteractionPlan) => void;
}

test("PR194 matrix: failed canonical continuations retain the handoff atomically", () => {
  const rows: readonly FailedContinuationRow[] = [
    {
      id: "PR194-failed-continuation-before-evaluation",
      expectedCode: "TSR023",
      makePlan: (injected) => replaceHandoffInstruction(injected, {
        kind: "say",
        speaker: "missing",
        value: temporaryExpression(injected.destinationTemporary, injected.plan.sourceSpan),
        span: injected.plan.instructions[injected.handoffInstruction]!.span,
      }),
      assertUntouchedTarget: (snapshot) => assert.equal(snapshot.speakers.length, 0),
    },
    {
      id: "PR194-failed-continuation-during-evaluation",
      expectedCode: "TSR026",
      makePlan: (injected) => replaceHandoffInstruction(injected, {
        kind: "evaluate",
        expression: binaryExpression(
          "and",
          temporaryExpression(injected.destinationTemporary, injected.plan.sourceSpan),
          literalExpression(true, injected.plan.sourceSpan),
          injected.plan.sourceSpan,
        ),
        span: injected.plan.instructions[injected.handoffInstruction]!.span,
      }),
      assertUntouchedTarget: () => undefined,
    },
    {
      id: "PR194-failed-continuation-before-target-mutation",
      expectedCode: "TSR026",
      makePlan: (injected) => replaceHandoffInstruction(injected, {
        kind: "storeTemporary",
        temporaryId: injected.destinationTemporary + 1,
        value: temporaryExpression(injected.destinationTemporary, injected.plan.sourceSpan),
        expectBoolean: true,
        span: injected.plan.instructions[injected.handoffInstruction]!.span,
      }, injected.plan.temporaryCount + 1),
      assertUntouchedTarget: (snapshot, injected) => assert.equal(
        snapshot.temporaries.some((temporary) => temporary.id === injected.destinationTemporary + 1),
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
    assert.deepEqual(failed.snapshot.interactionResultHandoff, committed.interactionResultHandoff, row.id);
    assert.equal(temporaryValue(failed.snapshot, injected.destinationTemporary), "committed", row.id);
    assert.deepEqual(failed.snapshot.lastSettlement, committed.lastSettlement, row.id);
    assert.equal(failed.events.length, 1, row.id);
    const failure = failed.events[0];
    assert.ok(failure !== undefined && failure.kind === "runtimeFailure", row.id);
    assert.equal(failure.code, row.expectedCode, row.id);
    row.assertUntouchedTarget(failed.snapshot, injected);
    assert.equal(validateRuntimeSnapshot(failed.snapshot, plan).valid, true, row.id);
    assert.deepEqual(checkpointJsonRoundTrip(plan, failed.snapshot).snapshot, failed.snapshot, row.id);
    assertReplayRow({ id: `${row.id}-replay`, plan, snapshot: failed.snapshot, request, expected: { kind: "alreadySettled" } });
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

interface TypedResultBoundaryBase {
  readonly id: string;
  readonly transcript: string;
}

interface TextTypedResultBoundaryRow extends TypedResultBoundaryBase {
  readonly interactionKind: "text";
  readonly ui: {
    readonly kind: "text";
    readonly hint: string | null;
    readonly accessibleName: InteractionAccessibleName;
  };
  readonly payload: { readonly kind: "submittedText"; readonly submittedText: string };
  readonly result: string;
}

interface NumberTypedResultBoundaryRow extends TypedResultBoundaryBase {
  readonly interactionKind: "number";
  readonly ui: {
    readonly kind: "number";
    readonly hint: string | null;
    readonly accessibleName: InteractionAccessibleName;
  };
  readonly payload: { readonly kind: "submittedText"; readonly submittedText: string };
  readonly result: number;
}

interface VisibleChoiceTypedResultBoundaryRow extends TypedResultBoundaryBase {
  readonly interactionKind: "choice";
  readonly ui: {
    readonly kind: "choice";
    readonly labelType: "none";
    readonly options: readonly { readonly text: string; readonly label: null }[];
    readonly accessibleName: typeof defaults.choice;
  };
  readonly payload: { readonly kind: "selectedText"; readonly selectedText: string };
  readonly result: string;
}

interface IdentifierChoiceTypedResultBoundaryRow extends TypedResultBoundaryBase {
  readonly interactionKind: "choice";
  readonly ui: {
    readonly kind: "choice";
    readonly labelType: "identifier";
    readonly options: readonly { readonly text: string; readonly label: string }[];
    readonly accessibleName: typeof defaults.choice;
  };
  readonly payload: { readonly kind: "selectedLabel"; readonly selectedLabel: string };
  readonly result: string;
}

interface NumericChoiceTypedResultBoundaryRow extends TypedResultBoundaryBase {
  readonly interactionKind: "choice";
  readonly ui: {
    readonly kind: "choice";
    readonly labelType: "number";
    readonly options: readonly { readonly text: string; readonly label: number }[];
    readonly accessibleName: typeof defaults.choice;
  };
  readonly payload: { readonly kind: "selectedLabel"; readonly selectedLabel: number };
  readonly result: number;
}

type TypedResultBoundaryRow =
  | TextTypedResultBoundaryRow
  | NumberTypedResultBoundaryRow
  | VisibleChoiceTypedResultBoundaryRow
  | IdentifierChoiceTypedResultBoundaryRow
  | NumericChoiceTypedResultBoundaryRow;

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
      ui: {
        kind: "text",
        hint: null,
        accessibleName: defaults.text,
      },
      payload: {
        kind: "submittedText",
        submittedText: "typed text",
      },
      result: "typed text",
      transcript: "typed text",
    },
    {
      id: "PR194-resume-domain-number",
      interactionKind: "number",
      ui: {
        kind: "number",
        hint: null,
        accessibleName: defaults.number,
      },
      payload: {
        kind: "submittedText",
        submittedText: " 12.5 ",
      },
      result: 12.5,
      transcript: "12.5",
    },
    {
      id: "PR194-resume-domain-choice-visible-text",
      interactionKind: "choice",
      ui: {
        kind: "choice",
        labelType: "none",
        options: [
          {
            text: "Visible",
            label: null,
          },
        ],
        accessibleName: defaults.choice,
      },
      payload: {
        kind: "selectedText",
        selectedText: "Visible",
      },
      result: "Visible",
      transcript: "Visible",
    },
    {
      id: "PR194-resume-domain-choice-identifier-label",
      interactionKind: "choice",
      ui: {
        kind: "choice",
        labelType: "identifier",
        options: [
          {
            text: "Visible",
            label: "saved",
          },
        ],
        accessibleName: defaults.choice,
      },
      payload: {
        kind: "selectedLabel",
        selectedLabel: "saved",
      },
      result: "saved",
      transcript: "Visible",
    },
    {
      id: "PR194-resume-domain-choice-numeric-label",
      interactionKind: "choice",
      ui: {
        kind: "choice",
        labelType: "number",
        options: [
          {
            text: "Visible",
            label: 7,
          },
        ],
        accessibleName: defaults.choice,
      },
      payload: {
        kind: "selectedLabel",
        selectedLabel: 7,
      },
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
    assert.equal(pending.temporaries.some((temporary) => temporary.id === injected.destinationTemporary), false, `${row.id}: pending destination`);
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
    assert.equal(temporaryValue(committed, injected.destinationTemporary), row.result, `${row.id}: committed result`);
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
    assert.equal(temporaryValue(transferred, injected.destinationTemporary), row.result, `${row.id}: retained interaction temporary`);
    const cleaned = assertInteractionResumeEquivalent(
      injected.plan,
      transferred,
      executeInstruction,
      `${row.id}: transferred`,
    ).uninterrupted.snapshot;
    assert.equal(cleaned.interactionResultHandoff, null, `${row.id}: cleaned handoff`);
    assert.equal(cleaned.temporaries.some((temporary) => temporary.id === injected.destinationTemporary), false, `${row.id}: cleaned destination`);
    assert.equal(bindingValue(cleaned, "answer"), row.result, `${row.id}: retained ordinary value`);
    const final = assertInteractionResumeEquivalent(
      injected.plan,
      cleaned,
      run,
      `${row.id}: cleaned`,
    );
    assert.deepEqual(final.uninterrupted.events.filter((event) => event.kind === "say").map((event) => event.text), [String(row.result)], `${row.id}: final say`);
    assert.equal(final.uninterrupted.snapshot.status, "halted", `${row.id}: final status`);
  }
});

interface DirectResumeRow {
  readonly id: string;
  readonly kind: "clearTemporary" | "exit" | "returnVoid" | "returnValue";
  readonly source: string;
  readonly makePlan: (injected: InjectedInteractionPlan) => InstructionPlan;
  readonly assertContinuation: (snapshot: RuntimeSnapshot, events: readonly InterpreterEvent[]) => void;
  readonly assertFinal: (snapshot: RuntimeSnapshot, events: readonly InterpreterEvent[]) => void;
}

test("PR194 matrix: direct handoff forms resume equivalently", () => {
  const rows: readonly DirectResumeRow[] = [
    {
      id: "PR194-resume-direct-clear",
      kind: "clearTemporary",
      source: 'let answer = "__interaction_result__"\nexit',
      makePlan: (injected) => replaceHandoffInstruction(injected, {
        kind: "clearTemporary",
        temporaryId: injected.destinationTemporary,
        span: injected.plan.instructions[injected.handoffInstruction]!.span,
      }),
      assertContinuation: (snapshot) => {
        assert.equal(snapshot.interactionResultHandoff, null);
      },
      assertFinal: (snapshot) => assert.equal(snapshot.status, "halted"),
    },
    {
      id: "PR194-resume-direct-exit",
      kind: "exit",
      source: 'let answer = "__interaction_result__"\nexit',
      makePlan: (injected) => replaceHandoffInstruction(injected, {
        kind: "exit",
        span: injected.plan.instructions[injected.handoffInstruction]!.span,
      }),
      assertContinuation: (snapshot, events) => {
        assert.equal(snapshot.status, "halted");
        assert.equal(events.filter((event) => event.kind === "exit").length, 1);
      },
      assertFinal: (snapshot) => assert.equal(snapshot.status, "halted"),
    },
    {
      id: "PR194-resume-direct-return-void",
      kind: "returnVoid",
      source: 'function prompt { let ignored = "__interaction_result__"\nreturn }\nprompt()\nsay "after"\nexit',
      makePlan: (injected) => replaceHandoffInstruction(injected, {
        kind: "returnVoid",
        span: injected.plan.instructions[injected.handoffInstruction]!.span,
      }),
      assertContinuation: (snapshot) => assert.equal(snapshot.callFrames.length, 0),
      assertFinal: (snapshot, events) => {
        assert.equal(snapshot.status, "halted");
        assert.ok(events.some((event) => event.kind === "say" && event.text === "after"));
      },
    },
    {
      id: "PR194-resume-direct-return-value",
      kind: "returnValue",
      source: 'function prompt { return "__interaction_result__" }\nlet answer = prompt()\nsay answer\nexit',
      makePlan: (injected) => injected.plan,
      assertContinuation: (snapshot) => {
        assert.equal(snapshot.callFrames.length, 0);
      },
      assertFinal: (snapshot, events) => {
        assert.equal(snapshot.status, "halted");
        assert.ok(events.some((event) => event.kind === "say" && event.text === "committed"));
      },
    },
  ];

  for (const row of rows) {
    const injected = injectTextInteraction(row.source);
    const plan = row.makePlan(injected);
    assert.equal(validateInstructionPlan(plan).valid, true, row.id);
    assert.equal(plan.instructions[injected.handoffInstruction]?.kind, row.kind, row.id);
    const pending = waiting(plan).snapshot;
    const committed = assertInteractionResumeEquivalent(
      plan,
      pending,
      (currentPlan, snapshot) => completeAction(currentPlan, snapshot, textCompletionRequest(snapshot)),
      `${row.id}: pending`,
    ).uninterrupted.snapshot;
    assert.notEqual(committed.interactionResultHandoff, null, `${row.id}: committed handoff`);
    const continued = assertInteractionResumeEquivalent(
      plan,
      committed,
      executeInstruction,
      `${row.id}: committed`,
    ).uninterrupted;
    assert.equal(continued.snapshot.interactionResultHandoff, null, `${row.id}: consumed handoff`);
    assert.equal(continued.snapshot.temporaries.some((temporary) => temporary.id === injected.destinationTemporary), false, `${row.id}: destination removed`);
    row.assertContinuation(continued.snapshot, continued.events);
    const final = assertInteractionResumeEquivalent(plan, continued.snapshot, run, `${row.id}: final`).uninterrupted;
    row.assertFinal(final.snapshot, final.events);
  }
});

test("PR194 matrix: invalid local handoff shapes reject without mutating plans", () => {
  const injected = injectTextInteraction('let answer = "__interaction_result__"\nsay answer\nexit');
  const span = injected.plan.instructions[injected.handoffInstruction]!.span;
  const rows: readonly { readonly id: string; readonly mutate: (plan: ExternalRecord) => void }[] = [
    {
      id: "PR194-jump-continuation",
      mutate: (plan) => {
        externalInstructions(plan)[injected.handoffInstruction] = {
          kind: "jump",
          target: injected.clearInstruction,
          span,
        };
      },
    },
    {
      id: "PR194-second-blocking-action",
      mutate: (plan) => {
        externalInstructions(plan)[injected.handoffInstruction] = {
          kind: "wait",
          duration: {
            kind: "literal",
            value: 1,
            span,
          },
          unit: "ms",
          span,
        };
      },
    },
    {
      id: "PR194-consume-wrong-temporary",
      mutate: (plan) => {
        plan.temporaryCount = injected.plan.temporaryCount + 1;
        externalRecord(externalInstructions(plan)[injected.handoffInstruction], "handoff").value = {
          kind: "temporary",
          temporaryId: injected.destinationTemporary + 1,
          span,
        };
      },
    },
    {
      id: "PR194-missing-clear",
      mutate: (plan) => {
        externalInstructions(plan)[injected.clearInstruction] = {
          kind: "say",
          speaker: null,
          value: {
            kind: "literal",
            value: "x",
            span,
          },
          span,
        };
      },
    },
    {
      id: "PR194-wrong-clear",
      mutate: (plan) => {
        externalRecord(
          externalInstructions(plan)[injected.clearInstruction],
          "clear",
        ).temporaryId = injected.destinationTemporary + 1;
      },
    },
    {
      id: "PR194-second-producer",
      mutate: (plan) => {
        externalInstructions(plan)[injected.clearInstruction] = {
          kind: "storeTemporary",
          temporaryId: injected.destinationTemporary,
          value: {
            kind: "literal",
            value: "x",
            span,
          },
          expectBoolean: false,
          span,
        };
      },
    },
    {
      id: "PR194-return-value-not-guaranteed",
      mutate: (plan) => {
        externalRecord(
          externalInstructions(plan)[injected.handoffInstruction],
          "handoff",
        ).value = {
          kind: "binary",
          operator: "or",
          left: {
            kind: "literal",
            value: true,
            span,
          },
          right: {
            kind: "temporary",
            temporaryId: injected.destinationTemporary,
            span,
          },
          span,
        };
      },
    },
  ];
  for (const row of rows) {
    const plan = externalRecord(structuredClone(injected.plan), row.id);
    row.mutate(plan);
    const beforeValidation = structuredClone(plan);
    const validation = validateInstructionPlan(plan);
    assert.equal(validation.valid, false, row.id);
    assert.ok(validation.errors.some((error) => error.code === "TSC002"), row.id);
    assert.deepEqual(plan, beforeValidation, row.id);
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
        payload: {
          kind: "submittedText",
          submittedText: " \t",
        },
      },
    },
    {
      id: "PR194-wrong-action-kind",
      request: {
        actionId,
        actionKind: "delay" as const,
        payload: {
          kind: "time",
          currentSessionTimeMs: 0,
        },
      },
    },
  ];
  for (const row of requests) {
    const before = structuredClone(pending.snapshot);
    const result = completeAction(injected.plan, pending.snapshot, row.request);
    assert.deepEqual(result.snapshot, before, row.id);
    assert.deepEqual(result.events, [], row.id);
  }
  const completed = completeAction(injected.plan, pending.snapshot, {
    actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: {
      kind: "submittedText",
      submittedText: "committed",
    },
  });
  const mutations: readonly ((snapshot: ExternalRecord) => void)[] = [
    (snapshot) => {
      snapshot.interactionResultHandoff = null;
    },
    (snapshot) => {
      externalRecord(snapshot.interactionResultHandoff, "handoff").ownerCallFrameId = 99;
      snapshot.nextCallFrameId = 100;
    },
    (snapshot) => {
      externalRecord(snapshot.interactionResultHandoff, "handoff").extra = true;
    },
  ];
  for (const mutation of mutations) {
    const snapshot = externalRecord(structuredClone(completed.snapshot), "malformed snapshot");
    mutation(snapshot);
    const before = structuredClone(snapshot);
    // Deliberately malformed external snapshot data must be rejected before completion mutates it.
    assert.throws(() => completeAction(injected.plan, snapshot as unknown as RuntimeSnapshot, {
      actionId,
      actionKind: "interaction",
      interactionKind: "text",
      payload: {
        kind: "submittedText",
        submittedText: "committed",
      },
    }));
    assert.deepEqual(snapshot, before);
  }
});

test("PR194 matrix: root, function, argument, and suspended-caller ownership contexts", () => {
  const rows = [
    {
      id: "PR194-root-context",
      source: 'let answer = "__interaction_result__"\nsay answer\nexit',
      owner: null,
    },
    {
      id: "PR194-function-context",
      source: 'function prompt { let answer = "__interaction_result__"\nsay answer\nreturn }\nprompt()\nexit',
      owner: "frame",
    },
    {
      id: "PR194-argument-context",
      source: 'function send(value) { say value\nreturn }\nsend("__interaction_result__")\nexit',
      owner: null,
    },
    {
      id: "PR194-suspended-caller-context",
      source: 'function prompt { return "__interaction_result__" }\nfunction send(before, answer) { say `${before}:${answer}`\nreturn }\nsend("first", prompt())\nexit',
      owner: "frame",
    },
  ] as const;
  for (const row of rows) {
    const injected = injectTextInteraction(row.source);
    const pending = waiting(injected.plan);
    const action = pending.snapshot.foregroundAction!;
    if (row.owner === null) assert.equal(action.ownerCallFrameId, null, row.id);
    else assert.ok(action.ownerCallFrameId !== null, row.id);
    const completed = completeAction(injected.plan, pending.snapshot, { actionId: action.actionId, actionKind: "interaction", interactionKind: "text", payload: { kind: "submittedText", submittedText: "committed" } });
    assert.equal(completed.snapshot.interactionResultHandoff?.ownerCallFrameId, action.ownerCallFrameId, row.id);
    const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(injected.plan, completed.snapshot)));
    const final = run(injected.plan, restored.snapshot);
    assert.equal(final.snapshot.interactionResultHandoff, null, row.id);
    assert.ok(final.events.some((event) => event.kind === "say" && event.text.includes("committed")), row.id);
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
      id: "PR194-resume-context-root-binding",
      source: 'let answer = "__interaction_result__"\nsay answer\nexit',
      owner: "root",
      makePlan: (injected) => injected.plan,
      assertPending: (snapshot) => assert.equal(snapshot.callFrames.length, 0),
      assertFinal: (snapshot, events) => {
        assert.equal(bindingValue(snapshot, "answer"), "committed");
        assert.ok(events.some((event) => event.kind === "say" && event.text === "committed"));
      },
    },
    {
      id: "PR194-resume-context-function-body",
      source: 'function prompt { let answer = "__interaction_result__"\nsay answer\nreturn }\nprompt()\nexit',
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
      assertFinal: (_snapshot, events) => assert.ok(events.some((event) => event.kind === "say" && event.text === "committed")),
    },
    {
      id: "PR194-resume-context-nested-return-value",
      source: 'function inner { return "__interaction_result__" }\nfunction outer { let answer = inner()\nsay answer\nreturn }\nouter()\nexit',
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
      source: 'function prompt { return "__interaction_result__" }\nfunction send(before, answer) { say `${before}:${answer}`\nreturn }\nsend("first", prompt())\nexit',
      owner: "active-frame",
      makePlan: (injected) => injected.plan,
      assertPending: (snapshot) => {
        assert.equal(snapshot.callFrames.length, 1);
        assert.ok(snapshot.callFrames[0]?.callerTemporaries.some((temporary) => temporary.value === "first"));
      },
      assertFinal: (snapshot, events) => {
        assert.equal(snapshot.callFrames.length, 0);
        assert.ok(events.some((event) => event.kind === "say" && event.text === "first:committed"));
      },
    },
    {
      id: "PR194-resume-context-direct-return-void",
      source: 'function prompt { let ignored = "__interaction_result__"\nreturn }\nprompt()\nsay "after"\nexit',
      owner: "active-frame",
      makePlan: (injected) => replaceHandoffInstruction(injected, {
        kind: "returnVoid",
        span: injected.plan.instructions[injected.handoffInstruction]!.span,
      }),
      assertPending: (snapshot) => assert.equal(snapshot.callFrames.length, 1),
      assertFinal: (snapshot, events) => {
        assert.equal(snapshot.callFrames.length, 0);
        assert.ok(events.some((event) => event.kind === "say" && event.text === "after"));
      },
    },
    {
      id: "PR194-resume-context-direct-return-value",
      source: 'function prompt { return "__interaction_result__" }\nlet answer = prompt()\nsay answer\nexit',
      owner: "active-frame",
      makePlan: (injected) => injected.plan,
      assertPending: (snapshot) => assert.equal(snapshot.callFrames.length, 1),
      assertFinal: (snapshot, events) => {
        assert.equal(snapshot.callFrames.length, 0);
        assert.equal(bindingValue(snapshot, "answer"), "committed");
        assert.ok(events.some((event) => event.kind === "say" && event.text === "committed"));
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
      (currentPlan, snapshot) => completeAction(currentPlan, snapshot, textCompletionRequest(snapshot)),
      `${row.id}: pending`,
    ).uninterrupted.snapshot;
    assert.equal(completed.interactionResultHandoff?.ownerCallFrameId, action.ownerCallFrameId, `${row.id}: handoff owner`);
    const final = assertInteractionResumeEquivalent(plan, completed, run, `${row.id}: committed`).uninterrupted;
    assert.equal(final.snapshot.interactionResultHandoff, null, `${row.id}: final handoff`);
    assert.equal(final.snapshot.status, "halted", `${row.id}: final status`);
    row.assertFinal(final.snapshot, final.events);
  }
});

test("PR194 matrix: validated composite persisted state resumes equivalently", () => {
  const fixture = settledHandoffFixture();
  // This is a validator-accepted persisted-state composite, not a state claimed
  // to be produced by one uninterrupted runtime path.
  const composite = fixture.validatedCompositeWithNewerSettlement;
  const oldHandoff = composite.interactionResultHandoff;
  assert.ok(oldHandoff !== null);
  const oldRequest: TextInteractionCompletionRequest = {
    actionId: oldHandoff.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "committed" },
  };
  assertReplayRow({
    id: "PR194-resume-composite-old-replay-before",
    plan: fixture.injected.plan,
    snapshot: composite,
    request: oldRequest,
    expected: { kind: "staleAction", actionId: oldRequest.actionId },
  });
  const consumed = assertInteractionResumeEquivalent(
    fixture.injected.plan,
    composite,
    executeInstruction,
    "PR194-resume-composite-consume",
  ).uninterrupted.snapshot;
  assert.equal(bindingValue(consumed, "answer"), "committed");
  assert.equal(consumed.interactionResultHandoff, null);
  assert.deepEqual(consumed.lastSettlement, fixture.laterDelaySettlement);
  const cleaned = assertInteractionResumeEquivalent(
    fixture.injected.plan,
    consumed,
    executeInstruction,
    "PR194-resume-composite-cleanup",
  ).uninterrupted.snapshot;
  assert.equal(cleaned.temporaries.some((temporary) => temporary.id === oldHandoff.destinationTemporary), false);
  assert.deepEqual(cleaned.lastSettlement, fixture.laterDelaySettlement);
  const final = assertInteractionResumeEquivalent(
    fixture.injected.plan,
    cleaned,
    run,
    "PR194-resume-composite-final",
  ).uninterrupted;
  assert.deepEqual(final.snapshot.lastSettlement, fixture.laterDelaySettlement);
  assertReplayRow({
    id: "PR194-resume-composite-old-replay-after",
    plan: fixture.injected.plan,
    snapshot: final.snapshot,
    request: oldRequest,
    expected: { kind: "staleAction", actionId: oldRequest.actionId },
  });
});

test("PR194 matrix: newer settlement changes old interaction replay to staleAction", () => {
  const injected = injectTextInteraction('let answer = "__interaction_result__"\nwait 1 ms\nsay answer\nexit');
  const pending = waiting(injected.plan);
  const request = { actionId: pending.snapshot.foregroundAction!.actionId, actionKind: "interaction" as const, interactionKind: "text" as const, payload: { kind: "submittedText", submittedText: "committed" } };
  const completed = completeAction(injected.plan, pending.snapshot, request);
  const afterClear = executeInstruction(injected.plan, executeInstruction(injected.plan, completed.snapshot).snapshot).snapshot;
  const delay = run(injected.plan, afterClear);
  const newer = observeTime(injected.plan, delay.snapshot, 1);
  const before = structuredClone(newer.snapshot);
  const replay = completeAction(injected.plan, newer.snapshot, request);
  assert.equal(replay.outcome.kind, "staleAction", "PR194-newer-settlement-replay");
  assert.deepEqual(replay.events, []);
  assert.deepEqual(replay.snapshot, before);
});
