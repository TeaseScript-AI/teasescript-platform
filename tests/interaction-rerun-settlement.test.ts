import assert from "node:assert/strict";
import test from "node:test";

import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { validateRuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { sayTexts } from "./helpers/runtime-events.js";

type Plan = ReturnType<typeof compileValidPlan>;
type Snapshot = ReturnType<typeof createImmediatePacingRuntimeSnapshot>;

/** Completes the pending interaction by its second option (or activation) and runs to the next wait. */
function answerSecond(plan: Plan, snapshot: Snapshot) {
  const action = snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  const option = action.ui.kind === "choice" ? action.ui.options[1]! : null;
  const completed = completeAction(plan, snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: action.interactionKind,
    payload:
      option === null
        ? { kind: "activate" }
        : option.label === null
          ? { kind: "selectedText", selectedText: option.text }
          : { kind: "selectedLabel", selectedLabel: option.label },
  });
  assert.equal(completed.outcome.kind, "completed");
  assert.equal(validateRuntimeSnapshot(completed.snapshot, plan).valid, true);
  return { presented: action.ui, next: run(plan, completed.snapshot) };
}

const SCENARIOS = [
  {
    name: "a labelled choice in a loop",
    source:
      'for pair in [["Low", "High"], ["Plug", "Clamps"]] {\n    let pick = choose 0: pair[0], 1: pair[1]\n    say "Picked ${pick}"\n}',
    said: ["Picked 1", "Picked 1"],
  },
  {
    name: "a choice in a function called twice",
    source:
      'function ask(first, second) {\n    return choose first, second\n}\nlet x = ask("A", "B")\nlet y = ask("C", "D")\nsay "${x} ${y}"',
    said: ["B D"],
  },
  {
    name: "a computed button label in a loop",
    source: 'for word in ["Go", "Run"] {\n    showButton word\n}\nsay "done"',
    said: ["done"],
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
    payload: { kind: "selectedLabel", selectedLabel: 1 },
  });
  const checkpoint = structuredClone(createCheckpoint(plan, completed.snapshot));
  assert.ok(checkpoint.snapshot.lastSettlement?.actionKind === "interaction");
  assert.equal(checkpoint.snapshot.lastSettlement.transcriptText, "Clamps");
  // EVIDENCE: fixture changes only the retained transcript to the other option presented with label 0.
  (checkpoint.snapshot.lastSettlement as { transcriptText: string }).transcriptText = "Plug";
  assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)));
});
