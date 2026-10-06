import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import {
  deserializeCheckpoint,
  createCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { updateInteraction } from "../src/runtime/operations/update-interaction.js";
import type { RuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { runUntilExit } from "./helpers/run-until-exit.js";

const SPEAKER = 'speaker mistress {\n  displayName: "Mistress"\n}\n';

function opened(plan: InstructionPlan) {
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  const action = result.snapshot.foregroundAction;
  const ui = action?.kind === "interaction" ? action.ui : null;
  assert.ok(
    ui?.kind === "form",
    result.snapshot.failure?.message ?? `expected a form, got ${action?.kind}`,
  );
  return { ...result, actionId: action!.actionId, ui };
}

function select(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  fieldId: string,
  optionIndex: number,
) {
  const actionId = snapshot.foregroundAction!.actionId;
  const result = updateInteraction(plan, snapshot, {
    actionId,
    actionKind: "interaction",
    interactionKind: "form",
    update: { kind: "select", fieldId, optionIndex },
  });
  assert.equal(result.outcome.kind, "updated");
  return result.snapshot;
}

function submitted(plan: InstructionPlan, snapshot: RuntimeSnapshot) {
  const result = completeAction(plan, snapshot, {
    actionId: snapshot.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "form",
    payload: { kind: "submit" },
  });
  assert.equal(result.outcome.kind, "completed");
  return { ...result, finished: runUntilExit(plan, result.snapshot) };
}

function said(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "say"
      ? [`${event.presentation.kind} ${event.speaker?.identifier ?? "nobody"}: ${event.text}`]
      : event.kind === "actionRequested"
        ? ["form opens"]
        : [],
  );
}

const SETTINGS = `askForm as mistress "Adjust your settings", hint: "Change values", fields: {
    enabled: { value: false, description: "Turn it on" },
    intensity: [{ text: "Low", background: "seagreen" }, { text: "High", background: "red" }],
    level: { options: [{ text: "Low", value: 1 }, { text: "High", value: 3 }], value: 3, description: "How *hard*" }
}, submit: "Continue", outro: "Then press Continue."`;

test("askForm says its question, then its descriptions and outro as prose, and returns typed answers", () => {
  const plan = compileValidPlan(
    `${SPEAKER}let settings = ${SETTINGS}\nlet next: integer = settings.level + 1\nlet on: boolean = settings.enabled\nlet name: string = settings.intensity\nexit`,
  );
  const { snapshot, events, ui } = opened(plan);
  assert.deepEqual(said(events), [
    "bubble mistress: Adjust your settings",
    "prose mistress: enabled — Turn it on\nlevel — How hard\n\nThen press Continue.",
    "form opens",
  ]);
  assert.equal(ui.hint, "Change values");
  assert.deepEqual(ui.submit, { text: "Continue" });
  assert.deepEqual(
    ui.fields.map((field) => [field.id, field.kind]),
    [
      ["enabled", "boolean"],
      ["intensity", "cycle"],
      ["level", "cycle"],
    ],
  );
  // The question and prose are not said again after a restore.
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, snapshot)),
  ).snapshot;
  const edited = select(plan, select(plan, restored, "enabled", 1), "intensity", 1);
  const { events: settled, finished } = submitted(plan, edited);
  assert.deepEqual(
    settled.flatMap((event) => (event.kind === "playerTranscript" ? [event.text] : [])),
    ["3 of 3 fields set"],
  );
  assert.deepEqual(said(finished.events), []);
  const bindings = new Map(
    finished.snapshot.frames[0]!.bindings.map((binding) => [binding.name, binding.value]),
  );
  assert.equal(bindings.get("next"), 4);
  assert.equal(bindings.get("on"), true);
  assert.equal(bindings.get("name"), "High");
});

test("the compact and parenthesized forms mean the same, and evaluate their arguments once in written order", () => {
  const source = (form: string) =>
    `${SPEAKER}let order: string[] = []\nfunction mark(name: string): string {\n  order.add(name)\n  return name\n}\nlet answers = ${form}\nexit`;
  const compact = compileValidPlan(
    source(
      `askForm as mistress mark("Question"), submit: mark("Go"), fields: { on: mark("x") == "x" }, hint: mark("Help")`,
    ),
  );
  const bounded = compileValidPlan(
    source(
      `askForm as mistress (mark("Question"), submit: mark("Go"), fields: { on: mark("x") == "x" }, hint: mark("Help"))`,
    ),
  );
  for (const plan of [compact, bounded]) {
    const { snapshot, ui, events } = opened(plan);
    assert.deepEqual(said(events), ["bubble mistress: Question", "form opens"]);
    assert.equal(ui.hint, "Help");
    assert.deepEqual(ui.submit, { text: "Go" });
    const order = snapshot.frames[0]!.bindings.find((binding) => binding.name === "order")!.value;
    assert.deepEqual(order, { kind: "list", items: ["Question", "Go", "x", "Help"] });
  }
  // Without a question, descriptions, or outro, nothing is said before the form opens.
  const silent = compileValidPlan("let answers = askForm fields: { on: false }\nexit");
  assert.deepEqual(said(opened(silent).events), ["form opens"]);
});

test("askForm reports what the compiler can see is wrong", () => {
  const cases: readonly (readonly [string, string])[] = [
    ['askForm "Q"', "askForm needs its fields, as in 'fields: { enabled: false }'."],
    ['askForm "Q", fields: { on: false }, cancel: "Back"', "Unknown askForm option 'cancel'"],
    [
      'askForm fields: { level: { type: "intger" } }',
      "askForm field 'level': unknown type 'intger' (use 'integer').",
    ],
    [
      'askForm fields: { on: { value: false, label: "On" } }',
      "askForm field 'on': unknown property 'label'.",
    ],
    ["askForm fields: 5", "'fields:' takes an object of fields"],
    [
      'askForm fields: { name: "Ada" }',
      "askForm field 'name': fields typed in the composer are not supported yet",
    ],
    ['askForm fields: dict { "on": false }', "A dict of fields is not supported yet"],
    ['askForm fields: { on: false }, hint: ["a"]', "A list cannot be an input hint."],
  ];
  for (const [form, message] of cases) {
    const diagnostics = compileSource(`let answers = ${form}\nexit`).diagnostics;
    assert.ok(
      diagnostics.some((diagnostic) => diagnostic.message.includes(message)),
      `${form}: ${JSON.stringify(diagnostics.map((diagnostic) => diagnostic.message))}`,
    );
  }
});
