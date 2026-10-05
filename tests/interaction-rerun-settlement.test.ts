import assert from "node:assert/strict";
import test from "node:test";

import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { compileSource } from "../src/compiler.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { executeInstruction, run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { validateRuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { sayTexts } from "./helpers/runtime-events.js";

type Plan = ReturnType<typeof compileValidPlan>;
type Snapshot = ReturnType<typeof createImmediatePacingRuntimeSnapshot>;

/**
 * Completes the pending interaction by its second option, its activation, or its unchanged default answer, and runs to
 * the next wait.
 */
function answerSecond(plan: Plan, snapshot: Snapshot) {
  const action = snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  const completed = completeAction(plan, snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: action.interactionKind,
    payload:
      action.ui.kind === "text" || action.ui.kind === "number"
        ? { kind: "submittedText", submittedText: action.ui.prefill! }
        : action.ui.kind === "choice"
          ? { kind: "selectedOption", optionIndex: 1 }
          : { kind: "activate" },
  });
  assert.equal(completed.outcome.kind, "completed");
  assert.equal(validateRuntimeSnapshot(completed.snapshot, plan).valid, true);
  return { presented: action.ui, next: run(plan, completed.snapshot) };
}

const SCENARIOS = [
  {
    name: "a choice with written values in a loop",
    source:
      'for pair in [["Low", "High"], ["Plug", "Clamps"]] {\n    let pick = choose 0: pair[0], 1: pair[1]\n    say "Picked ${pick}"\n}\nexit',
    said: ["Picked 1", "Picked 1"],
  },
  {
    name: "a choice in a function called twice",
    source:
      'function ask(first, second) {\n    return choose first, second\n}\nlet x = ask("A", "B")\nlet y = ask("C", "D")\nsay "${x} ${y}"\nexit',
    said: ["B D"],
  },
  {
    name: "a choice from lists of different lengths in a loop",
    source:
      'for options in [["Low", "High"], ["Plug", "Clamps", "Rope"]] {\n    let pick = choose options\n    say "Picked ${pick}"\n}\nexit',
    said: ["Picked High", "Picked Clamps"],
  },
  {
    name: "a computed button label in a loop",
    source: 'for word in ["Go", "Run"] {\n    showButton word\n}\nsay "done"\nexit',
    said: ["done"],
  },
  {
    name: "a computed default answer in a loop",
    source:
      'for minutes in [10, 20] {\n    let answer = askNumber "Minutes?", default: minutes * 2\n    say "Answered ${answer}"\n}\nexit',
    // Each run asks its question again.
    said: ["Minutes?", "Answered 20", "Minutes?", "Answered 40"],
  },
] as const;

test("an interaction that runs again with other texts completes every time", () => {
  for (const scenario of SCENARIOS) {
    const plan = compileValidPlan(scenario.source);
    const first = run(plan, createImmediatePacingRuntimeSnapshot(plan));
    const { next: second } = answerSecond(plan, first.snapshot);
    assert.equal(validateRuntimeSnapshot(second.snapshot, plan).valid, true, scenario.name);
    const { next: done } = answerSecond(plan, second.snapshot);
    assert.equal(done.snapshot.status, "halted", scenario.name);
    assert.deepEqual(
      [...sayTexts(first), ...sayTexts(second), ...sayTexts(done)],
      scenario.said,
      scenario.name,
    );
  }
});

test("a checkpoint taken between the two runs resumes to the same result", () => {
  for (const scenario of SCENARIOS) {
    const plan = compileValidPlan(scenario.source);
    const first = run(plan, createImmediatePacingRuntimeSnapshot(plan));
    const { next: second } = answerSecond(plan, first.snapshot);
    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(plan, second.snapshot)),
    );
    assert.deepEqual(restored.snapshot, second.snapshot, scenario.name);
    const uninterrupted = answerSecond(plan, second.snapshot).next;
    const resumed = answerSecond(restored.plan, restored.snapshot).next;
    assert.deepEqual(resumed.snapshot, uninterrupted.snapshot, scenario.name);
    assert.deepEqual(resumed.events, uninterrupted.events, scenario.name);
  }
});

test("a forged retained choice is still rejected right after the second completion", () => {
  const plan = compileValidPlan(SCENARIOS[0].source);
  const first = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  const second = answerSecond(plan, first.snapshot).next;
  const action = second.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  const completed = completeAction(plan, second.snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "selectedOption", optionIndex: 1 },
  });
  const checkpoint = structuredClone(createCheckpoint(plan, completed.snapshot));
  assert.ok(checkpoint.snapshot.lastSettlement?.actionKind === "interaction");
  assert.equal(checkpoint.snapshot.lastSettlement.transcriptText, "Clamps");
  // EVIDENCE: fixture changes only the retained transcript to the other option presented with value 0.
  (checkpoint.snapshot.lastSettlement as { transcriptText: string }).transcriptText = "Plug";
  assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)));
});

test("a forged retained choice is rejected until cleanup clears the presented options", () => {
  const plan = compileValidPlan(
    'let x = "Alpha"\nlet y = "Beta"\nlet pick = choose first: x, second: y\nsay pick, instant\nexit',
  );
  const pending = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  const action = pending.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  const completed = completeAction(plan, pending, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "selectedOption", optionIndex: 0 },
  }).snapshot;
  // The result is handed off, but the cleanup that clears the presented options has not run yet.
  const consumed = executeInstruction(plan, completed).snapshot;
  assert.equal(validateRuntimeSnapshot(consumed, plan).valid, true);
  const checkpoint = structuredClone(createCheckpoint(plan, consumed));
  assert.ok(checkpoint.snapshot.lastSettlement?.actionKind === "interaction");
  // EVIDENCE: fixture changes only the retained transcript to the other presented option.
  (checkpoint.snapshot.lastSettlement as { transcriptText: string }).transcriptText = "Beta";
  assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)));
});

test("a valid plan that refills a button label and jumps back to its continuation keeps running", () => {
  const compiled = compileSource(
    'let word = "Go"\nshowButton word\nword = "Run"\nsay "end", instant\nexit',
  );
  const plan = structuredClone(compiled.plan!);
  const continuation =
    plan.instructions.findIndex((instruction) => instruction.kind === "interaction") + 1;
  const assignIndex = plan.instructions.findIndex((instruction) => instruction.kind === "assign");
  const assign = plan.instructions[assignIndex];
  const interaction = plan.instructions[continuation - 1];
  assert.ok(
    assign?.kind === "assign" && interaction?.kind === "interaction" && "preparedUi" in interaction,
  );
  assert.ok(interaction.preparedUi.kind === "button");
  // EVIDENCE: fixture refills the label temporary and jumps back to the settled button's continuation.
  (plan.instructions as unknown[])[assignIndex] = {
    kind: "storeTemporary",
    temporaryId: interaction.preparedUi.buttonLabelTemporary,
    value: assign.value,
    expectBoolean: false,
    span: assign.span,
  };
  // EVIDENCE: fixture replaces only the following instruction with a jump to the old continuation.
  (plan.instructions as unknown[])[assignIndex + 1] = {
    kind: "jump",
    target: continuation,
    span: assign.span,
  };
  assert.equal(validateInstructionPlan(plan).valid, true);

  const pending = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.ok(pending.foregroundAction?.kind === "interaction");
  let snapshot = completeAction(plan, pending, {
    actionId: pending.foregroundAction.actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  }).snapshot;
  // Run until execution stands at the old continuation with the refilled label, then validate it.
  let steps = 0;
  do {
    snapshot = executeInstruction(plan, snapshot).snapshot;
    steps += 1;
  } while (snapshot.nextInstruction !== continuation && steps < 8);
  assert.equal(snapshot.nextInstruction, continuation);
  assert.ok(snapshot.temporaries.some((temporary) => temporary.value === "Run"));
  assert.equal(validateRuntimeSnapshot(snapshot, plan).valid, true);
  assert.doesNotThrow(() => executeInstruction(plan, snapshot));
});

test("a valid plan that overwrites the button label right after the settlement keeps running", () => {
  const compiled = compileSource(
    'let word = "Go"\nshowButton word\nword = "Run"\nsay "end", instant\nexit',
  );
  const plan = structuredClone(compiled.plan!);
  const owning = plan.instructions.findIndex((instruction) => instruction.kind === "interaction");
  const interaction = plan.instructions[owning];
  const assign = plan.instructions.find((instruction) => instruction.kind === "assign");
  assert.ok(interaction?.kind === "interaction" && "preparedUi" in interaction);
  assert.ok(interaction.preparedUi.kind === "button" && assign?.kind === "assign");
  // EVIDENCE: fixture replaces only the first cleanup with a store of new text into the button-label temporary.
  (plan.instructions as unknown[])[owning + 1] = {
    kind: "storeTemporary",
    temporaryId: interaction.preparedUi.buttonLabelTemporary,
    value: assign.value,
    expectBoolean: false,
    span: assign.span,
  };
  assert.equal(validateInstructionPlan(plan).valid, true);

  const pending = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.ok(pending.foregroundAction?.kind === "interaction");
  const settled = completeAction(plan, pending, {
    actionId: pending.foregroundAction.actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  }).snapshot;
  const overwritten = executeInstruction(plan, settled).snapshot;
  assert.equal(validateRuntimeSnapshot(overwritten, plan).valid, true);
  assert.doesNotThrow(() =>
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, overwritten))),
  );
  assert.doesNotThrow(() => executeInstruction(plan, overwritten));
});

test("a forged button transcript is rejected at its first completion even when the plan jumps back later", () => {
  const compiled = compileSource(
    'let word = "Go"\nshowButton word\nword = "Run"\nsay "end", instant\nexit',
  );
  const plan = structuredClone(compiled.plan!);
  const continuation =
    plan.instructions.findIndex((instruction) => instruction.kind === "interaction") + 1;
  const assignIndex = plan.instructions.findIndex((instruction) => instruction.kind === "assign");
  const assign = plan.instructions[assignIndex];
  assert.ok(assign?.kind === "assign");
  // EVIDENCE: fixture adds a later jump back to the settled button's continuation.
  (plan.instructions as unknown[])[assignIndex + 1] = {
    kind: "jump",
    target: continuation,
    span: assign.span,
  };
  assert.equal(validateInstructionPlan(plan).valid, true);
  const pending = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.ok(pending.foregroundAction?.kind === "interaction");
  const settled = completeAction(plan, pending, {
    actionId: pending.foregroundAction.actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  }).snapshot;
  const checkpoint = structuredClone(createCheckpoint(plan, settled));
  assert.ok(checkpoint.snapshot.lastSettlement?.actionKind === "interaction");
  // EVIDENCE: fixture changes only the retained transcript to a label that was never presented.
  (checkpoint.snapshot.lastSettlement as { transcriptText: string }).transcriptText =
    "Never presented";
  assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)));
});
