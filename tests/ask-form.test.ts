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
    ["askForm fields: 5", "'fields:' takes an object or dict of fields"],
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

test("a form checks when it opens that each field answers within the type the compiler gave it", () => {
  /** Runs the script, submitting each form as it opens, until it ends or fails. */
  const outcome = (source: string) => {
    const plan = compileValidPlan(source);
    let current = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
    while (current.status === "waiting" && current.foregroundAction?.kind === "interaction")
      current = run(plan, submitted(plan, current).snapshot).snapshot;
    return current;
  };
  const failure = (source: string) => {
    const ended = outcome(source);
    assert.equal(ended.status, "failed", source);
    return [ended.failure?.code, ended.failure?.message];
  };
  // A descriptor that gains `type:` later opens a number field where the compiler saw an integer one.
  assert.deepEqual(
    failure(
      'let f = { value: 1 }\nfor i in [1, 2] {\n  let a = askForm fields: { x: f }\n  let n: integer = a.x\n  repeat n {}\n  f.type = "number"\n}\nexit',
    ),
    [
      "TSR058",
      "askForm field 'x' was checked to answer a whole number (integer), but it can answer a number. Write type: where the field's starting object is created, so the compiler sees its kind.",
    ],
  );
  // A parameter may bring properties its default does not show.
  assert.equal(
    failure(
      'function ask(desc = { value: 1 }) {\n  let a = askForm fields: { x: desc }\n  let n: integer = a.x\n}\nask({ value: 1, type: "number" })\nexit',
    )[0],
    "TSR058",
  );
  // A cycle that becomes a text field, and a choice object that brings a value its type does not show.
  assert.equal(
    failure(
      'let f = { x: { options: [1, 2] } }\nfor i in [1, 2] {\n  let a = askForm fields: f\n  let n: integer = a.x\n  repeat n {}\n  f.x = { value: "Ada" }\n}\nexit',
    )[0],
    "TSR058",
  );
  assert.equal(
    failure(
      'function edit(opt = { text: "One" }) {\n  let a = askForm fields: { x: [opt] }\n  let n: string = a.x\n  say n.length, instant\n}\nedit({ text: "One", value: 1 })\nexit',
    )[0],
    "TSR058",
  );
  // Data that matches what the compiler saw opens and answers as typed.
  const matching = outcome(
    'let f = { value: false, text: "Owned" }\nlet a = askForm fields: { x: f, y: [{ text: "One", value: 1 }, { text: "Two", value: 2 }] }\nlet owned: boolean = a.x\nlet n: integer = a.y\nexit',
  );
  assert.equal(matching.status, "halted", matching.failure?.message);
  // A computed choice object in a written list may return its value or its text.
  assert.deepEqual(
    compileSource(
      'let option = { text: "One", value: 1 }\nlet answers = askForm fields: { x: [option] }\nlet n: integer | string = answers.x\nexit',
    ).diagnostics,
    [],
  );
  // A parenthesized `optional: false` is still false, and an integer field does not start with a decimal number.
  assert.deepEqual(
    compileSource(
      'let a = askForm fields: { x: { type: "text", value: "A", optional: (false) } }\nlet n: string = a.x\nexit',
    ).diagnostics,
    [],
  );
  assert.deepEqual(
    compileSource(
      'let a = askForm fields: { x: { type: "integer", value: 5.0 } }\nexit',
    ).diagnostics.map((diagnostic) => diagnostic.message),
    ["askForm field 'x': an integer field starts with a whole number (integer), not a number."],
  );
});

test("a dict of fields keeps its keys and order, labels its buttons by text, and types its answers", () => {
  const plan = compileValidPlan(
    [
      'let toyIds = ["12", "3", "x"]',
      'let names = dict { "12": "Rope", "3": "Cuffs", "x": "Gag" }',
      "let toys = dict {}",
      "for id in toyIds {",
      '  let owned: boolean = load "toys.${id}", default: false',
      "  toys[id] = { value: owned, text: names[id] }",
      "}",
      'let selected = askForm "Which toys do you own?", fields: toys',
      'let rope: boolean = selected["12"]',
      "let levels = dict {}",
      'for category in ["pain", "speed"] { levels[category] = { value: 5, min: 1, max: 10 } }',
      'let ratings = askForm("Set levels", fields: levels)',
      'let pain: integer = ratings["pain"]',
      "exit",
    ].join("\n"),
  );
  const first = opened(plan);
  // The keys identify the fields, in the dict's order; `text:` only labels them.
  assert.deepEqual(
    first.ui.fields.map((field) => [field.id, field.text]),
    [
      ["12", "Rope"],
      ["3", "Cuffs"],
      ["x", "Gag"],
    ],
  );
  const toys = submitted(plan, select(plan, first.snapshot, "3", 1)).finished.snapshot;
  const binding = (snapshot: RuntimeSnapshot, name: string) =>
    snapshot.frames[0]!.bindings.find((candidate) => candidate.name === name)?.value;
  assert.deepEqual(binding(toys, "selected"), {
    kind: "dict",
    entries: [
      { key: "12", value: false },
      { key: "3", value: true },
      { key: "x", value: false },
    ],
  });
  // The compiler knows the dict's numbers are integers, so a level is a whole number within its bounds.
  assert.deepEqual(edit(plan, toys, "pain", "2.5").refused, {
    kind: "invalidPayload",
    message: "That is wrong. I asked for a whole number.",
  });
  const rated = submitted(plan, edit(plan, toys, "pain", "7").snapshot).finished.snapshot;
  assert.equal(binding(rated, "pain"), 7);
});

test("a dict of fields of different kinds says each type, and answers in the union to narrow", () => {
  const menu = [
    'let settingId = "impact"',
    "let menu: object dict = dict {}",
    'menu[settingId] = { type: "number", value: 2.5, min: 1, max: 10 }',
    'menu["enabled"] = { type: "boolean", value: false, text: "Enabled" }',
    'menu["intensity"] = { type: "cycle", options: ["Low", "High"] }',
    'menu["day"] = { type: "date", optional: true }',
  ];
  const plan = compileValidPlan(
    [
      ...menu,
      "let answers = askForm(fields: menu)",
      "let answer = answers[settingId]",
      "let next: number = 0",
      "if answer is number { next = answer + 1 }",
      "exit",
    ].join("\n"),
  );
  const { snapshot, ui } = opened(plan);
  assert.deepEqual(
    ui.fields.map((field) => [field.id, field.kind]),
    [
      ["impact", "number"],
      ["enabled", "boolean"],
      ["intensity", "cycle"],
      ["day", "date"],
    ],
  );
  const { finished } = submitted(plan, snapshot);
  assert.equal(
    finished.snapshot.frames[0]!.bindings.find((binding) => binding.name === "next")?.value,
    3.5,
  );
  // Values of different shapes in one dict do not prove one kind: a field may be a number or a cycle here.
  const merged =
    'let levels = dict {}\nlevels["a"] = { value: 5 }\nlevels["b"] = { options: ["x", "y"] }\nlet r = askForm fields: levels\n';
  assert.deepEqual(compileSource(`${merged}exit`).diagnostics, []);
  assert.deepEqual(
    compileSource(`${merged}let n: integer = r["a"]\nexit`).diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.span.start.line,
    ]),
    [["TSV041", 4]],
  );
  // Without the compiler's knowledge of a number's kind, a field must say its type.
  const untyped = compileValidPlan(
    [...menu, 'menu["level"] = { value: 5 }', "let answers = askForm(fields: menu)", "exit"].join(
      "\n",
    ),
  );
  const failed = run(untyped, createImmediatePacingRuntimeSnapshot(untyped)).snapshot;
  assert.equal(
    failed.failure?.message,
    `askForm field 'level': add type: "integer" or type: "number" for its number.`,
  );
});

test("a written dict of fields types each entry by what it shows", () => {
  const diagnostics = (source: string) =>
    compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => diagnostic.message);
  // A written `optional: false` keeps the answers required, and a written type decides the kind.
  assert.deepEqual(
    diagnostics(
      'let r = askForm fields: dict { "n": { value: 1, optional: false } }\nlet n: integer = r["n"]',
    ),
    [],
  );
  const plan = compileValidPlan(
    'let r = askForm fields: dict { "n": { type: "number", value: 1 }, "m": { type: "number", value: 2 } }\nlet n: number = r["n"]\nexit',
  );
  assert.deepEqual(
    opened(plan).ui.fields.map((field) => [field.id, field.kind]),
    [
      ["n", "number"],
      ["m", "number"],
    ],
  );
  // A cycle of numbers takes no number in the composer, so it does not share the dict's number kind.
  assert.deepEqual(
    diagnostics(
      'let r = askForm fields: dict { "cycle": { options: [1.5, 2.5], value: 1.5 }, "level": { value: 2 } }',
    ),
    [],
  );
  // One dict has one number kind for fields without `type:`.
  assert.deepEqual(diagnostics('let r = askForm fields: dict { "a": 1, "b": 2.5 }'), [
    `askForm field 'a': its dict mixes whole and decimal numbers; add type: "integer" or type: "number".`,
    `askForm field 'b': its dict mixes whole and decimal numbers; add type: "integer" or type: "number".`,
  ]);
});

test("a dict of fields proves its answers only by metadata its values have when the form opens", () => {
  const diagnostics = (source: string) =>
    compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => diagnostic.message);
  // A toggle and a cycle of text in one dict answer in the generic union.
  assert.equal(
    diagnostics(
      'let d = dict {}\nd["a"] = { value: false }\nd["b"] = { options: ["x", "y"] }\nlet r = askForm fields: d\nlet n: boolean = r["b"]',
    ).length,
    1,
  );
  // A value with a type its dict's type does not show opens a field the compiler did not see, which fails at once.
  const plan = compileValidPlan(
    'let d = dict {}\nd["a"] = { value: 1 }\nfor i in [1, 2] {\n  let r = askForm fields: d\n  let n: integer = r["a"]\n  repeat n {}\n  d["a"] = { type: "number", value: 1 }\n}\nexit',
  );
  let current = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  while (current.status === "waiting" && current.foregroundAction?.kind === "interaction")
    current = run(plan, submitted(plan, current).snapshot).snapshot;
  assert.equal(current.status, "failed");
  assert.equal(current.failure?.code, "TSR058");
});

test("askForm with cancel: may return null, which the script checks before reading an answer", () => {
  const plan = compileValidPlan(
    [
      'let answers = askForm "Settings?", fields: { on: false }, cancel: "Back"',
      'let state = "cancelled"',
      'if answers != null { state = "${answers.on}" }',
      "exit",
    ].join("\n"),
  );
  const { snapshot, actionId, ui } = opened(plan);
  assert.deepEqual(ui.cancel, { text: "Back" });
  const cancelled = completeAction(plan, snapshot, {
    actionId,
    actionKind: "interaction",
    interactionKind: "form",
    payload: { kind: "cancel" },
  });
  const finished = runUntilExit(plan, cancelled.snapshot).snapshot;
  assert.equal(
    finished.frames[0]!.bindings.find((binding) => binding.name === "state")?.value,
    "cancelled",
  );
  assert.deepEqual(
    compileSource(
      'let a = askForm fields: { on: false }, cancel: "Back"\nlet b: boolean = a.on\nexit',
    ).diagnostics.map((diagnostic) => diagnostic.message),
    ["'a' may be null. Check it first: if a != null { ... }"],
  );
});

test("askBooleans asks with one toggle per text and returns their states in order, or null when cancelled", () => {
  const plan = compileValidPlan(
    [
      'let selected = askBooleans(message: "Choose all that apply", texts: ["A", "B", "A"], defaults: [true, false, false])',
      "let last: boolean = selected[2]",
      'let again = askBooleans("Again?", texts: ["X"], defaults: [false], cancel: "Back")',
      "exit",
    ].join("\n"),
  );
  const { snapshot, ui, events } = opened(plan);
  assert.deepEqual(said(events), ["bubble nobody: Choose all that apply", "form opens"]);
  // Repeated texts are separate toggles, numbered in order.
  assert.deepEqual(
    ui.fields.map((field) => [field.id, field.text, field.kind]),
    [
      ["0", "A", "boolean"],
      ["1", "B", "boolean"],
      ["2", "A", "boolean"],
    ],
  );
  const first = submitted(plan, select(plan, snapshot, "2", 1));
  assert.deepEqual(
    first.events.flatMap((event) => (event.kind === "playerTranscript" ? [event.text] : [])),
    ["2 of 3 selected"],
  );
  const binding = (state: RuntimeSnapshot, name: string) =>
    state.frames[0]!.bindings.find((candidate) => candidate.name === name)?.value;
  assert.deepEqual(binding(first.finished.snapshot, "selected"), {
    kind: "list",
    items: [true, false, true],
  });
  const second = first.finished.snapshot;
  const cancelled = completeAction(plan, second, {
    actionId: second.foregroundAction!.actionId,
    actionKind: "interaction",
    interactionKind: "form",
    payload: { kind: "cancel" },
  });
  assert.equal(binding(runUntilExit(plan, cancelled.snapshot).snapshot, "again"), null);

  const errors = (source: string) =>
    compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => diagnostic.message);
  assert.deepEqual(errors('let a = askBooleans(texts: ["A", "B"], defaults: [true])'), [
    "askBooleans has 2 texts but 1 defaults; give one default for each text.",
  ]);
  assert.deepEqual(errors('let a = askBooleans("Q", texts: ["A"])'), [
    'askBooleans() needs defaults:, such as askBooleans("Choose", texts: ["A", "B"], defaults: [true, false]).',
  ]);
  assert.deepEqual(
    errors(
      'let a = askBooleans(texts: ["A"], defaults: [true], cancel: "Back")\nlet b: boolean[] = a',
    ),
    [
      "'b' is declared as boolean[], so it cannot start as a list (boolean[]) or null. Check it first: if a != null { ... }",
    ],
  );
  // Lists of different lengths that the compiler cannot see fail when the form opens.
  const computed = compileValidPlan(
    'let texts = ["A", "B"]\nlet defaults = [true]\nlet a = askBooleans(texts: texts, defaults: defaults)\nexit',
  );
  const failure = run(computed, createImmediatePacingRuntimeSnapshot(computed)).snapshot.failure;
  assert.deepEqual(
    [failure?.code, failure?.message],
    ["TSR058", "askBooleans has 2 texts but 1 defaults; give one default for each text."],
  );
  // A host cannot configure the engine's name as its own.
  for (const option of ["builtins", "globals"] as const)
    assert.ok(
      compileSource('let a = askBooleans(texts: ["A"], defaults: [true])\nexit', {
        [option]: ["askBooleans"],
      }).diagnostics.some((diagnostic) => diagnostic.code === "TSV001"),
      option,
    );
});
