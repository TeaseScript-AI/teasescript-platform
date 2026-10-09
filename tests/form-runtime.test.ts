import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOpaqueColor } from "../src/color.js";
import type { FormUi, InstructionPlan, PreparedFormShape } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { updateInteraction } from "../src/runtime/operations/update-interaction.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import type { RuntimeFormStateSnapshot } from "../src/runtime/actions/model.js";
import { formSummaryOf } from "../src/runtime/actions/form.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../src/temporal.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { runUntilExit } from "./helpers/run-until-exit.js";

/**
 * A plan whose `choose` is replaced by a prepared form reading the local `request`, as the compiler lowers `askForm`
 * once its source form exists. `prefix` runs first; the form's result is bound to `result`.
 */
function formPlan(request: string, shape: PreparedFormShape, prefix = ""): InstructionPlan {
  const base = compileValidPlan(
    `${prefix}let request = ${request}\nlet result = choose request, "placeholder"\nexit`,
  );
  const index = base.instructions.findIndex(
    (instruction) => instruction.kind === "interaction" && "preparedUi" in instruction,
  );
  const interaction = base.instructions[index]!;
  assert.ok(interaction.kind === "interaction" && "preparedUi" in interaction);
  assert.ok(interaction.preparedUi.kind === "choice");
  const requestTemporary = interaction.preparedUi.optionsTemporary;
  const instructions = base.instructions.map((instruction, position) => {
    if (instruction.kind === "storeTemporary" && instruction.temporaryId === requestTemporary) {
      assert.ok(instruction.value.kind === "list");
      return { ...instruction, value: instruction.value.elements[0]! };
    }
    if (position !== index) return instruction;
    return {
      ...interaction,
      interactionKind: "form" as const,
      expectedResult: "form" as const,
      preparedUi: {
        kind: "form" as const,
        requestTemporary,
        shape,
        accessibleName: { kind: "localizedDefault" as const, key: "answer" as const },
      },
    };
  });
  const plan = { ...base, instructions };
  const validation = validateInstructionPlan(plan);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  return plan;
}

const OBJECT: PreparedFormShape = {
  kind: "object",
  numericKinds: [
    { name: "impact", numericKind: "integer" },
    { name: "weight", numericKind: "number" },
  ],
  answers: [],
};

const SETTINGS = `{
  hint: "Change values, then continue",
  submit: { text: "Continue", background: "seagreen" },
  fields: {
    enabled: false,
    access: { value: true, text: "Access", options: [{ value: false, text: "Off", background: "firebrick" }, { value: true, text: "On", background: "seagreen" }] },
    intensity: [{ text: "Low", background: "seagreen" }, { text: "Medium", background: "orange" }, { text: "High", background: "red" }],
    level: { type: "cycle", options: ["Low", "Medium", "High"], value: "Medium", text: "Level" },
    impact: { value: 5, min: 1, max: 10, text: "Impact" },
    weight: 2.5,
    name: "Ada",
    day: toDate("2026-10-05"),
    note: { type: "text", optional: true, hint: "Anything else?" },
    count: { type: "integer" }
  }
}`;

function started(plan: InstructionPlan): RuntimeSnapshot {
  const snapshot = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  assert.equal(snapshot.status, "waiting", snapshot.failure?.message);
  return snapshot;
}

function pendingForm(snapshot: RuntimeSnapshot): {
  actionId: number;
  ui: FormUi;
  form: RuntimeFormStateSnapshot;
} {
  const action = snapshot.foregroundAction;
  assert.ok(
    action?.kind === "interaction" && action.ui.kind === "form" && action.form !== undefined,
  );
  return { actionId: action.actionId, ui: action.ui, form: action.form };
}

function update(plan: InstructionPlan, snapshot: RuntimeSnapshot, edit: Record<string, unknown>) {
  return updateInteraction(plan, snapshot, {
    actionId: pendingForm(snapshot).actionId,
    actionKind: "interaction",
    interactionKind: "form",
    update: edit,
  });
}

/** Applies edits that must each be accepted, and returns the snapshot after the last. */
function edited(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  edits: Record<string, unknown>[],
) {
  let current = snapshot;
  for (const edit of edits) {
    const result = update(plan, current, edit);
    assert.ok(
      result.outcome.kind === "updated" || result.outcome.kind === "unchanged",
      `${JSON.stringify(edit)}: ${JSON.stringify(result.outcome)}`,
    );
    assert.deepEqual(result.events, []);
    current = result.snapshot;
  }
  return current;
}

function submit(plan: InstructionPlan, snapshot: RuntimeSnapshot) {
  return completeAction(plan, snapshot, {
    actionId: pendingForm(snapshot).actionId,
    actionKind: "interaction",
    interactionKind: "form",
    payload: { kind: "submit" },
  });
}

function binding(snapshot: RuntimeSnapshot, name: string) {
  return snapshot.frames[0]?.bindings.find((candidate) => candidate.name === name)?.value;
}

function roundTrip(plan: InstructionPlan, snapshot: RuntimeSnapshot): RuntimeSnapshot {
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot)));
  assert.deepEqual(restored.snapshot, snapshot);
  return restored.snapshot;
}

test("a form opens with each field's kind, label, colours, and start, and keeps its definition in its request", () => {
  const plan = formPlan(SETTINGS, OBJECT);
  const snapshot = started(plan);
  const { ui, form } = pendingForm(snapshot);
  assert.equal(ui.hint, "Change values, then continue");
  assert.deepEqual(ui.submit, { text: "Continue", background: normalizeOpaqueColor("seagreen") });
  assert.deepEqual(
    ui.fields.map((field) => [field.id, field.kind, field.text]),
    [
      ["enabled", "boolean", "enabled"],
      ["access", "boolean", "Access"],
      ["intensity", "cycle", "intensity"],
      ["level", "cycle", "Level"],
      ["impact", "integer", "Impact"],
      ["weight", "number", "weight"],
      ["name", "text", "name"],
      ["day", "date", "day"],
      ["note", "text", "note"],
      ["count", "integer", "count"],
    ],
  );
  const access = ui.fields[1]!;
  assert.ok(access.kind === "boolean");
  assert.deepEqual(
    access.options?.map((option) => [option.value, option.background]),
    [
      [false, normalizeOpaqueColor("firebrick")],
      [true, normalizeOpaqueColor("seagreen")],
    ],
  );
  assert.deepEqual(ui.fields[4], {
    id: "impact",
    text: "Impact",
    kind: "integer",
    optional: false,
    min: 1,
    max: 10,
    hint: null,
  });
  // Toggles hold their state, cycles their option index, and typed fields their value or null while unset.
  assert.deepEqual(form, {
    values: [
      false,
      true,
      0,
      1,
      5,
      2.5,
      "Ada",
      { kind: "date", year: 2026, month: 10, day: 5 },
      null,
      null,
    ],
    editor: null,
  });
  assert.equal(validateRuntimeSnapshot(snapshot, plan).valid, true);
  // A restore checks the open form against the definition its request keeps.
  const tampered = structuredClone(snapshot);
  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: the test edits a persisted record to break its lineage.
  (tampered.foregroundAction as any).ui.fields[0].text = "Changed";
  assert.equal(validateRuntimeSnapshot(tampered, plan).valid, false);
});

test("edits change only the form's answers, absolutely, and refused ones change nothing", () => {
  const plan = formPlan(SETTINGS, OBJECT);
  const opened = started(plan);
  const before = JSON.stringify(opened);
  let snapshot = edited(plan, opened, [
    { kind: "select", fieldId: "enabled", optionIndex: 1 },
    { kind: "select", fieldId: "access", optionIndex: 0 },
    { kind: "select", fieldId: "intensity", optionIndex: 2 },
  ]);
  assert.equal(JSON.stringify(opened), before, "an update does not mutate its input");
  assert.deepEqual(pendingForm(snapshot).form.values.slice(0, 3), [true, false, 2]);
  // A repeated selection is harmless.
  const repeated = update(plan, snapshot, { kind: "select", fieldId: "enabled", optionIndex: 1 });
  assert.equal(repeated.outcome.kind, "unchanged");
  assert.equal(snapshot.nextEventSequence, opened.nextEventSequence);
  assert.equal(snapshot.status, "waiting");

  // The composer opens with the field's value, keeps any draft text, and commits only a valid answer.
  snapshot = edited(plan, snapshot, [{ kind: "edit", fieldId: "impact" }]);
  assert.deepEqual(pendingForm(snapshot).form.editor, { fieldId: "impact", text: "5" });
  for (const [text, message] of [
    ["2.5", "That is wrong. I asked for a whole number."],
    ["11", "That is wrong. Impact must be from 1 to 10."],
    ["", "That is wrong. Impact needs a value."],
  ] as const) {
    const drafted = edited(plan, snapshot, [{ kind: "draft", fieldId: "impact", text }]);
    const refused = update(plan, drafted, { kind: "commit", fieldId: "impact" });
    assert.deepEqual(refused.outcome, { kind: "invalidPayload", message }, text);
    assert.deepEqual(refused.snapshot, drafted, text);
  }
  // Switching to another field or submitting first commits the draft; an invalid draft, also a blank one for a
  // required field, refuses both, so a cleared value is never submitted unnoticed.
  let drafted = snapshot;
  for (const text of ["-", "", "  "]) {
    drafted = edited(plan, snapshot, [{ kind: "draft", fieldId: "impact", text }]);
    const blocked = update(plan, drafted, { kind: "select", fieldId: "enabled", optionIndex: 0 });
    assert.equal(blocked.outcome.kind, "invalidPayload", text);
    assert.deepEqual(blocked.snapshot, drafted, text);
    const unsent = submit(plan, drafted);
    assert.equal(unsent.outcome.kind, "invalidPayload", text);
    assert.deepEqual(unsent.snapshot, drafted, text);
  }
  drafted = edited(plan, snapshot, [
    { kind: "draft", fieldId: "impact", text: " 7 " },
    { kind: "edit", fieldId: "weight" },
  ]);
  assert.equal(pendingForm(drafted).form.values[4], 7);
  assert.deepEqual(pendingForm(drafted).form.editor, { fieldId: "weight", text: "2.5" });
  // Dismissing drops the draft and keeps the last value; blank text unsets an optional field.
  drafted = edited(plan, drafted, [
    { kind: "draft", fieldId: "weight", text: "9" },
    { kind: "dismiss", fieldId: "weight" },
    { kind: "edit", fieldId: "note" },
    { kind: "draft", fieldId: "note", text: "Later" },
    { kind: "commit", fieldId: "note" },
    { kind: "commit", fieldId: "note" },
  ]);
  assert.deepEqual(pendingForm(drafted).form, {
    values: [
      true,
      false,
      2,
      1,
      7,
      2.5,
      "Ada",
      { kind: "date", year: 2026, month: 10, day: 5 },
      "Later",
      null,
    ],
    editor: null,
  });
  drafted = edited(plan, drafted, [{ kind: "clear", fieldId: "note" }]);
  assert.equal(pendingForm(drafted).form.values[8], null);
  assert.deepEqual(update(plan, drafted, { kind: "clear", fieldId: "name" }).outcome, {
    kind: "invalidPayload",
    message: "That is wrong. name needs a value.",
  });
  for (const malformed of [
    { kind: "select", fieldId: "missing", optionIndex: 0 },
    { kind: "select", fieldId: "level", optionIndex: 3 },
    { kind: "select", fieldId: "impact", optionIndex: 0 },
    { kind: "edit", fieldId: "enabled" },
    { kind: "draft", fieldId: "name", text: "Bo" },
    { kind: "select", fieldId: "enabled", optionIndex: 1, extra: true },
    { kind: "reset", fieldId: "enabled" },
  ]) {
    const result = update(plan, drafted, malformed);
    assert.equal(result.outcome.kind, "invalidPayload", JSON.stringify(malformed));
    assert.deepEqual(result.snapshot, drafted);
  }
});

test("submitting requires every required field and returns the answers once, with every field's state", () => {
  const plan = formPlan(SETTINGS, OBJECT);
  let snapshot = started(plan);
  const missing = submit(plan, snapshot);
  assert.deepEqual(missing.outcome, {
    kind: "invalidPayload",
    message: "That is wrong. count needs a value.",
  });
  assert.deepEqual(missing.snapshot, snapshot);
  snapshot = edited(plan, snapshot, [
    { kind: "select", fieldId: "level", optionIndex: 2 },
    { kind: "edit", fieldId: "count" },
    { kind: "draft", fieldId: "count", text: "3" },
  ]);
  // The draft being edited is part of the submission.
  const submitted = submit(plan, snapshot);
  assert.equal(submitted.outcome.kind, "completed");
  assert.deepEqual(
    submitted.events.map((event) => (event.kind === "playerTranscript" ? event.text : event.kind)),
    [
      "✗ enabled, Access: On, intensity: Low, Level: High, Impact: 5, weight: 2.5, name: Ada, day: 2026-10-05, note: Not set, count: 3",
      "actionCompleted",
    ],
  );
  // A player rebuilds the same summary, one line per field, from the settlement, and none from a foreign result.
  const completion = submitted.events.find((event) => event.kind === "actionCompleted");
  assert.ok(
    completion?.kind === "actionCompleted" &&
      completion.settlement.actionKind === "interaction" &&
      completion.settlement.ui.kind === "form",
  );
  const { ui, result } = completion.settlement;
  const presentation = DEFAULT_TEMPORAL_CONTEXT.presentation;
  assert.deepEqual(
    formSummaryOf(ui, result, presentation)?.map((line) =>
      line.kind === "toggle" ? `${line.label} ${line.on}` : `${line.label}: ${line.value}`,
    ),
    [
      "enabled false",
      "Access: On",
      "intensity: Low",
      "Level: High",
      "Impact: 5",
      "weight: 2.5",
      "name: Ada",
      "day: 2026-10-05",
      "note: Not set",
      "count: 3",
    ],
  );
  assert.equal(formSummaryOf(ui, { kind: "list", items: [] }, presentation), null);
  const actionId = pendingForm(snapshot).actionId;
  const repeated = completeAction(plan, submitted.snapshot, {
    actionId,
    actionKind: "interaction",
    interactionKind: "form",
    payload: { kind: "submit" },
  });
  assert.equal(repeated.outcome.kind, "alreadySettled");
  const late = updateInteraction(plan, submitted.snapshot, {
    actionId,
    actionKind: "interaction",
    interactionKind: "form",
    update: { kind: "select", fieldId: "enabled", optionIndex: 1 },
  });
  assert.deepEqual(late.outcome, { kind: "staleAction", actionId });
  // The handoff survives a checkpoint before the script consumes it.
  const finished = runUntilExit(plan, roundTrip(plan, submitted.snapshot)).snapshot;
  assert.deepEqual(binding(finished, "result"), {
    kind: "object",
    properties: [
      { name: "enabled", value: false },
      { name: "access", value: true },
      { name: "intensity", value: "Low" },
      { name: "level", value: "High" },
      { name: "impact", value: 5 },
      { name: "weight", value: 2.5 },
      { name: "name", value: "Ada" },
      { name: "day", value: { kind: "date", year: 2026, month: 10, day: 5 } },
      { name: "note", value: null },
      { name: "count", value: 3 },
    ],
  });
});

test("every interim edit, including a draft, survives a checkpoint and resumes as if uninterrupted", () => {
  const plan = formPlan(SETTINGS, OBJECT);
  const edits = [
    { kind: "select", fieldId: "enabled", optionIndex: 1 },
    { kind: "edit", fieldId: "impact" },
    { kind: "draft", fieldId: "impact", text: "1" },
    { kind: "draft", fieldId: "impact", text: "1e" },
    { kind: "draft", fieldId: "impact", text: "9" },
    { kind: "edit", fieldId: "count" },
    { kind: "draft", fieldId: "count", text: "-" },
    { kind: "draft", fieldId: "count", text: "-4" },
  ];
  let direct = started(plan);
  let restored = roundTrip(plan, direct);
  for (const edit of edits) {
    direct = edited(plan, direct, [edit]);
    restored = roundTrip(plan, edited(plan, restored, [edit]));
    assert.deepEqual(restored, direct, JSON.stringify(edit));
  }
  assert.deepEqual(pendingForm(restored).form.editor, { fieldId: "count", text: "-4" });
  const finishedDirect = runUntilExit(plan, submit(plan, direct).snapshot);
  const finishedRestored = runUntilExit(plan, roundTrip(plan, submit(plan, restored).snapshot));
  assert.deepEqual(finishedRestored.snapshot, finishedDirect.snapshot);
});

test("a submitted form lists toggles that are off, and answers too long for one line are refused", () => {
  const listPlan = formPlan(`{ texts: ["A", "B"], defaults: [false, false] }`, {
    kind: "booleanList",
  });
  const nothing = submit(listPlan, started(listPlan));
  assert.deepEqual(
    nothing.events.flatMap((event) => (event.kind === "playerTranscript" ? [event.text] : [])),
    ["✗ A, ✗ B"],
  );
  const notesPlan = formPlan(
    `{ fields: { first: { type: "text", text: "First" }, second: { type: "text", text: "Second" } } }`,
    { kind: "object", numericKinds: [], answers: [] },
  );
  const long = "x".repeat(40_000);
  const drafted = edited(notesPlan, started(notesPlan), [
    { kind: "edit", fieldId: "first" },
    { kind: "draft", fieldId: "first", text: long },
    { kind: "edit", fieldId: "second" },
    { kind: "draft", fieldId: "second", text: long },
  ]);
  const refused = submit(notesPlan, drafted);
  assert.deepEqual(refused.outcome, {
    kind: "invalidPayload",
    message: "That is wrong. These answers are too long to send at once.",
  });
  assert.deepEqual(refused.snapshot, drafted);
});

test("a dict form keeps its keys and order, and a boolean list shows each state", () => {
  const dictPlan = formPlan(
    `{ fields: dict { "12": { value: 5, min: 1, max: 10, text: "Rope" }, "3": { value: 2, text: "Cuffs" } } }`,
    { kind: "dict", numericKind: "integer", answer: null },
  );
  const dictForm = submit(dictPlan, started(dictPlan));
  assert.equal(dictForm.outcome.kind, "completed");
  assert.deepEqual(binding(runUntilExit(dictPlan, dictForm.snapshot).snapshot, "result"), {
    kind: "dict",
    entries: [
      { key: "12", value: 5 },
      { key: "3", value: 2 },
    ],
  });
  const listPlan = formPlan(`{ texts: ["A", "B", "A"], defaults: [true, false, false] }`, {
    kind: "booleanList",
  });
  const opened = started(listPlan);
  assert.deepEqual(
    pendingForm(opened).ui.fields.map((field) => [field.id, field.text]),
    [
      ["0", "A"],
      ["1", "B"],
      ["2", "A"],
    ],
  );
  const selected = submit(
    listPlan,
    edited(listPlan, opened, [{ kind: "select", fieldId: "2", optionIndex: 1 }]),
  );
  assert.deepEqual(
    selected.events.flatMap((event) => (event.kind === "playerTranscript" ? [event.text] : [])),
    ["✓ A, ✗ B, ✓ A"],
  );
  assert.deepEqual(binding(runUntilExit(listPlan, selected.snapshot).snapshot, "result"), {
    kind: "list",
    items: [true, false, true],
  });
});

test("a timer block suspends the form with its draft, which takes no edits until the block returns", () => {
  const plan = formPlan(SETTINGS, OBJECT, "timer async 1 {\n  wait 1\n}\n");
  const snapshot = edited(plan, started(plan), [
    { kind: "edit", fieldId: "name" },
    { kind: "draft", fieldId: "name", text: "Bo" },
  ]);
  const { actionId } = pendingForm(snapshot);
  const interrupted = roundTrip(
    plan,
    run(plan, observeTime(plan, snapshot, 1500).snapshot).snapshot,
  );
  assert.equal(interrupted.foregroundAction?.kind, "delay");
  const inert = updateInteraction(plan, interrupted, {
    actionId,
    actionKind: "interaction",
    interactionKind: "form",
    update: { kind: "commit", fieldId: "name" },
  });
  assert.deepEqual(inert.outcome, { kind: "suspendedAction", actionId });
  const resumed = run(plan, observeTime(plan, interrupted, 2500).snapshot).snapshot;
  assert.equal(pendingForm(resumed).actionId, actionId);
  assert.deepEqual(pendingForm(resumed).form.editor, { fieldId: "name", text: "Bo" });
});

test("a form that cannot be built fails when it opens, with a message that names the field", () => {
  const cases: readonly (readonly [string, string])[] = [
    [
      `{ impact: { type: "intger" } }`,
      "askForm field 'impact': unknown type 'intger' (use 'integer').",
    ],
    [
      `{ impact: { type: "integer", min: 10, max: 1 } }`,
      "askForm field 'impact': min 10 exceeds max 1.",
    ],
    [
      `{ impact: { value: 12, min: 1, max: 10 } }`,
      "askForm field 'impact': its value 12 is outside from 1 to 10.",
    ],
    [
      `{ ratio: 0.5 }`,
      `askForm field 'ratio': add type: "integer" or type: "number" for its number.`,
    ],
    [
      `{ level: { type: "cycle", options: ["Low", "High"], value: "Mid" } }`,
      "askForm field 'level': its value is not one of its options.",
    ],
    [
      `{ level: mixed }`,
      "askForm field 'level': the options of a cycle must all have the same type.",
    ],
    [
      `{ on: { value: true, options: ["Yes", "No"] } }`,
      "askForm field 'on': a toggle's options are one with value: false and one with value: true.",
    ],
    [
      `{ on: { value: true, optional: true } }`,
      "askForm field 'on': optional: is for fields typed in the composer, not a toggle.",
    ],
    [
      `{ name: { type: "text", min: 1 } }`,
      "askForm field 'name': min: is for integer and number fields, not a text.",
    ],
    [
      `{ name: { value: "Ada", label: "Name" } }`,
      "askForm field 'name': unknown property 'label'. A field has type, value, text, options, optional, min, max, hint, background, and description.",
    ],
    [
      `{ when: { type: "date", value: "2026-10-05" } }`,
      "askForm field 'when': a date field cannot start as text (string).",
    ],
    // A failure inside a field's options also names the field.
    [
      `{ level: { type: "cycle", options: [{ text: "Low", background: "not-a-colour" }] } }`,
      `askForm field 'level': A button background must be an opaque CSS colour, such as "#336699", but this is text (string) "not-a-colour".`,
    ],
    // A text start longer than any answer would make a form that could not be saved.
    [
      `{ name: long + "x" }`,
      "askForm field 'name': its text is longer than an answer may be (65536 UTF-8 bytes).",
    ],
  ];
  for (const [fields, message] of cases) {
    const plan = formPlan(
      `{ fields: ${fields} }`,
      OBJECT,
      'let mixed: (string | integer)[] = ["Low", 2]\nlet long = "x".repeat(65536)\n',
    );
    const snapshot = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
    assert.equal(snapshot.status, "failed", fields);
    assert.equal(snapshot.failure?.message, message, fields);
    roundTrip(plan, snapshot);
  }
  // The longest text start opens, and the form can be saved.
  const longest = formPlan(`{ fields: { name: "x".repeat(65536) } }`, OBJECT);
  roundTrip(longest, started(longest));
  const empty = formPlan(`{ fields: dict {} }`, { kind: "dict", numericKind: null, answer: null });
  assert.equal(
    run(empty, createFreshRuntimeSnapshot(empty)).snapshot.failure?.message,
    "A form needs at least one field.",
  );
});

test("restore rejects form answers that its definition cannot hold", () => {
  const plan = formPlan(SETTINGS, OBJECT);
  const snapshot = edited(plan, started(plan), [{ kind: "edit", fieldId: "impact" }]);
  const tamper = (change: (form: { values: unknown[]; editor: unknown }) => void) => {
    const copy = structuredClone(snapshot);
    // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: the test edits a persisted record to an invalid state.
    change((copy.foregroundAction as any).form);
    return copy;
  };
  for (const [name, broken] of [
    ["cycle index", tamper((form) => (form.values[2] = 3))],
    ["toggle state", tamper((form) => (form.values[0] = 1))],
    ["out of bounds", tamper((form) => (form.values[4] = 11))],
    ["whole number", tamper((form) => (form.values[4] = 2.5))],
    ["editor on a toggle", tamper((form) => (form.editor = { fieldId: "enabled", text: "" }))],
    ["missing value", tamper((form) => form.values.pop())],
  ] as const) {
    assert.equal(validateRuntimeSnapshot(broken, plan).valid, false, name);
    assert.throws(
      () => restoreCheckpoint({ ...createCheckpoint(plan, snapshot), snapshot: broken }),
      name,
    );
  }
  const submitted = submit(
    plan,
    edited(plan, snapshot, [
      { kind: "draft", fieldId: "impact", text: "4" },
      { kind: "edit", fieldId: "count" },
      { kind: "draft", fieldId: "count", text: "1" },
    ]),
  ).snapshot;
  assert.equal(validateRuntimeSnapshot(submitted, plan).valid, true);
  const wrongResult = structuredClone(submitted);
  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: the test edits a persisted record to an invalid state.
  (wrongResult.lastSettlement as any).result.properties[4].value = 40;
  assert.equal(validateRuntimeSnapshot(wrongResult, plan).valid, false);
});

test("a form with a cancel button cancels as a whole, dropping its edits, and returns null once", () => {
  const plan = formPlan(
    `{ fields: { impact: { value: 5, min: 1, max: 10 }, on: false }, cancel: { text: "Back", background: "gray" } }`,
    OBJECT,
  );
  const opened = started(plan);
  assert.deepEqual(pendingForm(opened).ui.cancel, {
    text: "Back",
    background: normalizeOpaqueColor("gray"),
  });
  // Even text that is not an answer does not hold back the cancellation.
  const drafted = edited(plan, opened, [
    { kind: "select", fieldId: "on", optionIndex: 1 },
    { kind: "edit", fieldId: "impact" },
    { kind: "draft", fieldId: "impact", text: "x" },
  ]);
  const cancel = (snapshot: RuntimeSnapshot) =>
    completeAction(plan, snapshot, {
      actionId: pendingForm(opened).actionId,
      actionKind: "interaction",
      interactionKind: "form",
      payload: { kind: "cancel" },
    });
  const cancelled = cancel(drafted);
  assert.equal(cancelled.outcome.kind, "completed");
  assert.deepEqual(
    cancelled.events.map((event) => (event.kind === "playerTranscript" ? event.text : event.kind)),
    ["Back", "actionCompleted"],
  );
  assert.equal(cancel(cancelled.snapshot).outcome.kind, "alreadySettled");
  const finished = runUntilExit(plan, roundTrip(plan, cancelled.snapshot)).snapshot;
  assert.equal(binding(finished, "result"), null);
  // A settlement that claims a cancellation the form did not offer is rejected.
  const noCancel = formPlan(`{ fields: { on: false } }`, OBJECT);
  const pending = started(noCancel);
  assert.deepEqual(
    completeAction(noCancel, pending, {
      actionId: pendingForm(pending).actionId,
      actionKind: "interaction",
      interactionKind: "form",
      payload: { kind: "cancel" },
    }).outcome,
    {
      kind: "invalidPayload",
      message: "This form has no cancel button, so it can only be submitted.",
    },
  );
  const submittedNoCancel = submit(noCancel, pending).snapshot;
  const forged = structuredClone(submittedNoCancel);
  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: the test edits a persisted record to an invalid state.
  const settlement = forged.lastSettlement as any;
  settlement.result = null;
  settlement.transcriptText = "Back";
  assert.equal(validateRuntimeSnapshot(forged, noCancel).valid, false);
});
