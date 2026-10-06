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
    ['askForm "Q", fields: { on: false }, submt: "Go"', "Unknown askForm option 'submt'"],
    [
      'askForm fields: { level: { type: "intger" } }',
      "askForm field 'level': unknown type 'intger' (use 'integer').",
    ],
    [
      'askForm fields: { on: { value: false, label: "On" } }',
      "askForm field 'on': unknown property 'label'.",
    ],
    ["askForm fields: 5", "'fields:' takes an object of fields"],
    // An optional answer may be null, so it needs a place that takes null.
    [
      'askForm fields: { n: { type: "integer", optional: true } }\nlet m: integer = answers.n',
      "cannot start as a whole number (integer) or null",
    ],
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

/** Opens and commits typed fields through their editor, as the composer does. */
function edit(plan: InstructionPlan, snapshot: RuntimeSnapshot, fieldId: string, text: string) {
  let current = snapshot;
  for (const update of [
    { kind: "edit", fieldId },
    { kind: "draft", fieldId, text },
    { kind: "commit", fieldId },
  ]) {
    const result = updateInteraction(plan, current, {
      actionId: current.foregroundAction!.actionId,
      actionKind: "interaction",
      interactionKind: "form",
      update,
    });
    if (result.outcome.kind !== "updated" && result.outcome.kind !== "unchanged")
      return { refused: result.outcome, snapshot: current };
    current = result.snapshot;
  }
  return { refused: null, snapshot: current };
}

test("typed fields take their answers in the composer, with their numeric kind, bounds, and optional null", () => {
  const plan = compileValidPlan(
    [
      "let level = 5",
      "level = level + 0.5",
      "let details = askForm fields: {",
      '  impact: { value: 5, min: 1, max: 10, hint: "1 to 10" }, weight: 5.0, level: level,',
      '  note: { type: "text", optional: true }, day: { type: "date" }',
      "}",
      "let impact: integer = details.impact",
      "let weight: number = details.weight",
      "let note: string? = details.note",
      "let day: date = details.day",
      "exit",
    ].join("\n"),
  );
  const { snapshot, ui } = opened(plan);
  // `5.0`, and a variable that a later assignment makes a number, give number fields.
  assert.deepEqual(
    ui.fields.map((field) => [field.id, field.kind]),
    [
      ["impact", "integer"],
      ["weight", "number"],
      ["level", "number"],
      ["note", "text"],
      ["day", "date"],
    ],
  );
  assert.deepEqual(edit(plan, snapshot, "impact", "2.5").refused, {
    kind: "invalidPayload",
    message: "That is wrong. I asked for a whole number.",
  });
  assert.equal(edit(plan, snapshot, "impact", "11").refused?.kind, "invalidPayload");
  let current = edit(plan, snapshot, "impact", "7").snapshot;
  current = edit(plan, current, "weight", "2.5").snapshot;
  current = edit(plan, current, "day", "2026-10-05").snapshot;
  // A checkpoint taken while a field is edited keeps the unsent text, and the answer it gives after a restore.
  const drafting = updateInteraction(plan, edit(plan, current, "note", "Later").snapshot, {
    actionId: current.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "form",
    update: { kind: "edit", fieldId: "note" },
  }).snapshot;
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, drafting)),
  ).snapshot;
  assert.deepEqual(restored, drafting);
  const { finished } = submitted(plan, restored);
  const bindings = new Map(
    finished.snapshot.frames[0]!.bindings.map((binding) => [binding.name, binding.value]),
  );
  assert.equal(bindings.get("impact"), 7);
  assert.equal(bindings.get("weight"), 2.5);
  assert.equal(bindings.get("note"), "Later");
  assert.deepEqual(bindings.get("day"), { kind: "date", year: 2026, month: 10, day: 5 });
});

test("a cycle answer has the type of every option it may return", () => {
  const errors = (source: string) =>
    compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => diagnostic.message);
  // One option returns its value and another its text, so the answer may be 2.5.
  assert.notDeepEqual(
    errors(
      "let answers = askForm fields: { x: [{ text: 1, value: 7 }, { text: 2.5 }] }\nlet n: integer = answers.x",
    ),
    [],
  );
  // Computed choice objects may return their value or their text.
  assert.notDeepEqual(
    errors(
      'let options = [{ text: "One", value: 1 }]\nlet answers = askForm fields: { x: options }\nlet n: integer = answers.x',
    ),
    [],
  );
  assert.deepEqual(
    errors(
      'let answers = askForm fields: { x: [{ text: "One", value: 1 }, { text: "Two", value: 2 }] }\nlet n: integer = answers.x',
    ),
    [],
  );
  // A field whose kind only the runtime knows may be a cycle of durations, so a duration stays possible.
  assert.deepEqual(
    errors(
      'let tag = "cycle"\nlet answers = askForm fields: { x: { type: tag, options: [1 s, 2 s] } }\nlet value = answers.x\nif value is duration { say value }',
    ),
    [],
  );
  assert.notDeepEqual(
    errors(
      'let tag = "cycle"\nlet answers = askForm fields: { x: { type: tag, options: [1 s, 2 s] } }\nlet value = answers.x\nif value is boolean | string | date | time | datetime | null {} else {\n  let n: number = value + 1\n}',
    ),
    [],
  );
});
