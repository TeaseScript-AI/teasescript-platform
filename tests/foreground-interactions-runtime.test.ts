import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  MAX_INTERACTION_OPTION_ENTRIES,
  MAX_INTERACTION_STRING_UTF8_BYTES,
} from "../src/interaction-limits.js";
import type { InstructionPlan, InteractionInstruction, InteractionUiPayload } from "../src/instructions.js";
import { validateInstructionPlan } from "../src/instructions.js";
import { createCheckpoint, deserializeCheckpoint, serializeCheckpoint } from "../src/runtime/checkpoint.js";
import { completeAction, observeTime, run } from "../src/runtime/engine.js";
import { createFreshRuntimeSnapshot, validateRuntimeSnapshot } from "../src/runtime/state.js";

function interactionPlan(interactionKind: InteractionInstruction["interactionKind"], ui: InteractionUiPayload, options: { speaker?: string | null } = {}): InstructionPlan {
  const source = options.speaker === undefined ? "wait 1\nexit" : `speaker ${options.speaker} {}\nspeaker ${options.speaker}\nwait 1\nexit`;
  const compiled = compileSource(source);
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  const base = compiled.plan!;
  const waitIndex = base.instructions.findIndex((instruction) => instruction.kind === "wait");
  assert.notEqual(waitIndex, -1);
  const expectedResult = interactionKind === "button" ? "none" : interactionKind === "number" ? "number" : "string";
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
  for (const submittedText of ["1\n2", "1,5", "1 000", "1px", "Infinity", "1e999", "one", "+"] ) {
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
  assert.equal(complete(numeric, { kind: "selectedLabel", selectedLabel: 2 }, "choice").snapshot.temporaries[0]?.value, 2);
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
});
