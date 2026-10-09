import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  playerRuntimeForeground,
  playerRuntimeSnapshot,
  restorePlayerRuntimeSession,
  selectPlayerRuntimeChoice,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import { compileSource } from "../src/compiler.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { createCheckpoint, deserializeCheckpoint } from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { createFreshRuntimeSnapshot, validateRuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

/** The open buttons, a preselected one marked with `*`. */
function buttons(session: PlayerRuntimeSession): readonly string[] {
  const foreground = playerRuntimeForeground(session);
  assert.equal(foreground?.kind, "choose");
  return foreground.options.map((option) => `${option.label}${option.preselected ? "*" : ""}`);
}

function warnings(session: PlayerRuntimeSession): readonly string[] {
  return session.events.flatMap((event) =>
    event.kind === "developerWarning" ? [`${event.code} ${event.message}`] : [],
  );
}

const PRELUDE = 'function question { return "Ready?" }\n';

test("prefill: preselects the first button with its value, which the Player marks but never chooses", () => {
  // Each source, its buttons, and what choosing the last one returns.
  for (const [source, shown, last] of [
    ['let a = askBoolean "Ready?", prefill: true', ["Yes*", "No"], "false"],
    ['let a = askBoolean "Ready?", prefill: false', ["Yes", "No*"], "false"],
    ["let p = false\nlet a = askBoolean(question(), prefill: p)", ["Yes", "No*"], "false"],
    ['let a = askBoolean "Ready?"', ["Yes", "No"], "false"],
    ['let a = choose stay: "Stay", leave: "Leave", prefill: "leave"', ["Stay", "Leave*"], "leave"],
    ["let a = choose 5, 10, 15, prefill: 10", ["5", "10*", "15"], "15"],
    ["let a = choose 5, 10, prefill: 10.0", ["5", "10*"], "10"],
    ["let a = choose 6, [7, 7], prefill: 7", ["6", "7*", "7"], "7"],
    [
      'let a = choose { value: "prefill", text: "Saved" }, other: "Other", prefill: "prefill"',
      ["Saved*", "Other"],
      "other",
    ],
    ["let level: integer? = null\nlet a = choose 6, 7, prefill: level", ["6", "7"], "7"],
    ["let a = choose 6, 7", ["6", "7"], "7"],
  ] as const) {
    let session = createPlayerRuntimeSession(`${PRELUDE}${source}\nsay "\${a}", instant\nexit`);
    assert.deepEqual(buttons(session), shown, source);
    assert.deepEqual(warnings(session), [], source);
    // The last button is chosen, preselected or not.
    const foreground = playerRuntimeForeground(session);
    assert.equal(foreground?.kind, "choose");
    session = selectPlayerRuntimeChoice(session, foreground.options.at(-1)!.id)!.session;
    assert.equal(session.state.status, "halted", source);
    assert.equal(session.transcriptEntries.at(-1)?.text, last, source);
  }
});

test("a prefill no button has preselects none and warns in Debug, and the script goes on", () => {
  const session = createPlayerRuntimeSession(
    'let a = choose stay: "Stay", leave: "Leave", prefill: "Leave"\nexit',
  );
  assert.deepEqual(buttons(session), ["Stay", "Leave"]);
  assert.deepEqual(warnings(session), [
    "TSW017 No button has the prefill value (\"Leave\"), so none is preselected. 'prefill:' gives a button's value, not its text.",
  ]);
  assert.equal(session.state.status, "waiting");
});

test("a restored choice keeps its preselected button, and one that does not fit its prefill is rejected", () => {
  for (const source of [
    'let a = askBoolean "Ready?", prefill: false',
    "let p = 10\nlet a = choose 5, 10, prefill: p",
  ]) {
    const session = createPlayerRuntimeSession(`${source}\nexit`);
    const restored = restorePlayerRuntimeSession(
      JSON.parse(JSON.stringify(createPlayerRuntimeRestorePoint(session))),
    );
    assert.deepEqual(playerRuntimeForeground(restored), playerRuntimeForeground(session), source);
    assert.deepEqual(playerRuntimeSnapshot(restored), playerRuntimeSnapshot(session), source);

    const plan = compileValidPlan(`${source}\nexit`);
    const { snapshot } = run(plan, createFreshRuntimeSnapshot(plan));
    assert.equal(validateRuntimeSnapshot(snapshot, plan).valid, true, source);
    const action = snapshot.foregroundAction;
    assert.ok(action?.kind === "interaction" && action.ui.kind === "choice");
    for (const preselected of [0, 2, undefined]) {
      const tampered = structuredClone(snapshot);
      // EVIDENCE: fixture changes only the published preselected button, which the prefill no longer gives.
      const ui = (tampered.foregroundAction as typeof action).ui as { preselected?: number };
      if (preselected === undefined) delete ui.preselected;
      else ui.preselected = preselected;
      assert.equal(
        validateRuntimeSnapshot(tampered, plan).valid,
        false,
        `${source} ${preselected}`,
      );
    }
    // The settlement keeps the preselected button it showed, and its checkpoint restores.
    const completed = completeAction(plan, snapshot, {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: "choice",
      payload: { kind: "selectedOption", optionIndex: 0 },
    });
    assert.equal(completed.outcome.kind, "completed", source);
    assert.doesNotThrow(
      () => deserializeCheckpoint(JSON.stringify(createCheckpoint(plan, completed.snapshot))),
      source,
    );
  }
  // A static preselected button outside the buttons is an invalid plan.
  const plan = structuredClone(
    compileValidPlan('let a = askBoolean "Ready?", prefill: true\nexit'),
  );
  const interaction = plan.instructions.find((instruction) => instruction.kind === "interaction");
  assert.ok(interaction !== undefined && "ui" in interaction && interaction.ui.kind === "choice");
  // EVIDENCE: fixture moves only the static preselected position past the two buttons.
  (interaction.ui as { preselected: number }).preselected = 2;
  assert.equal(validateInstructionPlan(plan).valid, false);
});

test("choose takes prefill: once, after its options, and askBoolean's prefill is true or false", () => {
  const errors = (source: string) =>
    compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => diagnostic.message);
  assert.deepEqual(errors("let a = choose prefill: 1, 2"), [
    "choose takes one 'prefill:', after its options, as in 'choose 5, 10, prefill: 10'.",
  ]);
  assert.deepEqual(errors("let a = choose 1, 2, prefill: 1, prefill: 2"), [
    "choose takes one 'prefill:', after its options, as in 'choose 5, 10, prefill: 10'.",
  ]);
  assert.deepEqual(errors("let a = choose 1, 2, prefill: 1, 3"), [
    "choose takes one 'prefill:', after its options, as in 'choose 5, 10, prefill: 10'.",
  ]);
  assert.deepEqual(errors('let a = askBoolean "Q", prefill: null'), [
    "The prefill of askBoolean must be true or false, not null. Remove 'prefill:' to preselect no button.",
  ]);
  assert.deepEqual(errors('let a = askBoolean "Q", prefill: "yes"'), [
    "The prefill of askBoolean must be true or false, not text (string).",
  ]);
  assert.deepEqual(errors('let a = askBoolean "Q", default: true'), [
    "askBoolean has no 'default:'; use 'prefill:'.",
  ]);
});
