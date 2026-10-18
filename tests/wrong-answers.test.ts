import assert from "node:assert/strict";
import test from "node:test";

import {
  commitPlayerRuntimeFormField,
  createPlayerRuntimeSession,
  stepPlayerRuntimeFormField,
  submitPlayerRuntimeComposer,
} from "../player/runtime-adapter.js";
import { MAX_INTERACTION_STRING_UTF8_BYTES } from "../src/interaction-limits.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { updateInteraction } from "../src/runtime/operations/update-interaction.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/snapshot-construction.js";

// V30 §20 "Invalid input handling" gives the defaults; `askText` has its own for blank text.
const NUMBER = "That is wrong. I asked for a number.";
const WHOLE_NUMBER = "That is wrong. I asked for a whole number.";
const DATE = "That is wrong. I asked for a date.";
const TIME = "That is wrong. I asked for a time.";
const DATE_TIME = "That is wrong. I asked for a date and time.";

const FORM = [
  "let answers = askForm fields: {",
  '  note: { type: "text" }, weight: 2.5, count: 2,',
  '  day: { type: "date" }, at: { type: "time" }, when: { type: "datetime" }',
  "}",
  "exit",
].join("\n");

test("a wrong answer to a typed ask or form field tells the player what was asked for", () => {
  for (const [ask, text, message] of [
    ["askText", "   ", "That is wrong. I asked for some text."],
    ["askText", "\n", "That is wrong. I asked for some text."],
    ["askNumber", "ten", NUMBER],
    ["askNumber", "1e999", NUMBER],
    ["askNumber", "1\n2", NUMBER],
    ["askInteger", "2.5", WHOLE_NUMBER],
    ["askDate", "5 October", DATE],
    ["askTime", "noon", TIME],
    ["askDateTime", "2026-10-05", DATE_TIME],
  ] as const) {
    const session = createPlayerRuntimeSession(`let answer = ${ask} "Question?"\nexit`);
    const rejected = submitPlayerRuntimeComposer(session, text);
    assert.deepEqual(rejected?.outcome, { kind: "invalidPayload", message }, `${ask} ${text}`);
  }
  for (const [field, text, message] of [
    ["note", "   ", "That is wrong. note needs a value."],
    ["weight", "ten", NUMBER],
    ["weight", "1e999", NUMBER],
    ["count", "2.5", WHOLE_NUMBER],
    ["day", "5 October", DATE],
    ["at", "noon", TIME],
    ["when", "2026-10-05", DATE_TIME],
  ] as const) {
    const opened = stepPlayerRuntimeFormField(createPlayerRuntimeSession(FORM), field);
    assert.equal(opened?.outcome.kind, "updated", field);
    const rejected = commitPlayerRuntimeFormField(opened.session, text);
    assert.deepEqual(rejected?.outcome, { kind: "invalidPayload", message }, `${field} ${text}`);
  }
});

test("typed text that matches no button or more than one tells the player to use the buttons", () => {
  const session = createPlayerRuntimeSession(
    'let answer = askChoice kneel: "Kneel", down: "Kneel", "Stand"\nexit',
  );
  for (const [text, message] of [
    ["Sit", "That is wrong. Type the exact text of one button, or use the buttons above."],
    ["Kneel", "More than one button has this text. Use the buttons above."],
  ] as const) {
    const rejected = submitPlayerRuntimeComposer(session, text);
    assert.deepEqual(rejected?.outcome, { kind: "invalidPayload", message }, text);
  }
});

test("a malformed host payload is not reported as a wrong answer", () => {
  const oversized = "1".repeat(MAX_INTERACTION_STRING_UTF8_BYTES + 1);
  for (const ask of ["askText", "askNumber", "askInteger", "askDate", "askTime", "askDateTime"]) {
    const plan = compileValidPlan(`let answer = ${ask} "Question?"\nexit`);
    const { snapshot } = run(plan, createFreshRuntimeSnapshot(plan));
    const action = snapshot.foregroundAction;
    assert.ok(action?.kind === "interaction", ask);
    for (const payload of [
      { kind: "submittedText", submittedText: 5 },
      { kind: "selectedOption", optionIndex: 0 },
      { kind: "submittedText", submittedText: oversized },
    ]) {
      const { outcome } = completeAction(plan, snapshot, {
        actionId: action.actionId,
        actionKind: "interaction",
        interactionKind: action.interactionKind,
        payload,
      });
      assert.equal(
        outcome.kind,
        "invalidPayload",
        `${ask} ${JSON.stringify(payload).slice(0, 60)}`,
      );
      assert.doesNotMatch(
        outcome.kind === "invalidPayload" ? outcome.message : "",
        /^That is wrong/,
      );
    }
  }
  const choicePlan = compileValidPlan('let answer = askChoice "Kneel", "Stand"\nexit');
  const choice = run(choicePlan, createFreshRuntimeSnapshot(choicePlan)).snapshot;
  const choiceAction = choice.foregroundAction;
  assert.ok(choiceAction?.kind === "interaction");
  for (const payload of [
    { kind: "submittedText", submittedText: 5 },
    { kind: "submittedText", submittedText: oversized },
    { kind: "selectedOption", optionIndex: 2 },
  ]) {
    const { outcome } = completeAction(choicePlan, choice, {
      actionId: choiceAction.actionId,
      actionKind: "interaction",
      interactionKind: choiceAction.interactionKind,
      payload,
    });
    assert.deepEqual(
      outcome,
      {
        kind: "invalidPayload",
        message: "Choice completion payload does not match the offered options.",
      },
      JSON.stringify(payload).slice(0, 60),
    );
  }
  const plan = compileValidPlan(FORM);
  const { snapshot } = run(plan, createFreshRuntimeSnapshot(plan));
  const action = snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction");
  const request = (update: Record<string, unknown>) => ({
    actionId: action.actionId,
    actionKind: "interaction" as const,
    interactionKind: "form" as const,
    update,
  });
  const editing = updateInteraction(plan, snapshot, request({ kind: "edit", fieldId: "weight" }));
  assert.equal(editing.outcome.kind, "updated");
  for (const text of [5, oversized]) {
    const { outcome } = updateInteraction(
      plan,
      editing.snapshot,
      request({ kind: "draft", fieldId: "weight", text }),
    );
    assert.equal(outcome.kind, "invalidPayload");
    assert.doesNotMatch(outcome.kind === "invalidPayload" ? outcome.message : "", /^That is wrong/);
  }
});
