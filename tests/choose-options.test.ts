import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOpaqueColor } from "../src/color.js";
import { MAX_INTERACTION_AGGREGATE_UTF8_BYTES } from "../src/interaction-limits.js";
import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { createSerializableList } from "../src/runtime/serializable-values.js";
import { validateRuntimeSnapshot, type RuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { sayTexts } from "./helpers/runtime-events.js";

const OFFENSES = [
  'let offenses = [{ value: "spank", text: "Spanking", background: "seagreen" }, { text: "Corner" }]',
  'let answer = choose back: "Back", offenses, "Lines"',
  "say [answer]",
].join("\n");

function start(source: string, seed?: number) {
  const plan = compileValidPlan(source);
  const pending = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, seed === undefined ? {} : { seed }),
  );
  return { plan, pending };
}

function buttons(snapshot: RuntimeSnapshot) {
  const action = snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.ui.kind === "choice");
  return action.ui.options;
}

/** Selects the rendered button at `optionIndex` and runs on. */
function select(plan: InstructionPlan, snapshot: RuntimeSnapshot, optionIndex: number) {
  return answer(plan, snapshot, { kind: "selectedOption", optionIndex });
}

function answer(plan: InstructionPlan, snapshot: RuntimeSnapshot, payload: unknown) {
  const action = snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction");
  const completed = completeAction(plan, snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload,
  });
  assert.equal(completed.outcome.kind, "completed");
  const transcript = completed.events.find((event) => event.kind === "playerTranscript");
  return {
    transcript: transcript?.kind === "playerTranscript" ? transcript.text : null,
    finished: run(plan, completed.snapshot),
  };
}

/** Completing each button, uninterrupted and after a checkpoint, gives the same result and transcript. */
function assertEachButtonResumes(source: string, expected: readonly (readonly [string, string])[]) {
  const { plan, pending } = start(source);
  assert.equal(pending.snapshot.status, "waiting", source);
  assert.deepEqual(
    pending.events.filter((event) => event.kind === "developerWarning"),
    [],
    source,
  );
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, pending.snapshot)),
  );
  expected.forEach(([text, said], index) => {
    const uninterrupted = select(plan, pending.snapshot, index);
    const resumed = select(restored.plan, restored.snapshot, index);
    assert.equal(uninterrupted.transcript, text, `${source} button ${index}`);
    assert.deepEqual(sayTexts(uninterrupted.finished), [said], `${source} button ${index}`);
    assert.deepEqual(resumed.finished.snapshot, uninterrupted.finished.snapshot);
    assert.deepEqual(resumed.finished.events, uninterrupted.finished.events);
  });
}

test("a list option gives one button per element, mixed with options with and without a written value", () => {
  const { plan, pending } = start(OFFENSES);
  assert.equal(pending.snapshot.status, "waiting");
  assert.deepEqual(buttons(pending.snapshot), [
    { text: "Back", value: "back" },
    { text: "Spanking", value: "spank", background: normalizeOpaqueColor("seagreen") },
    { text: "Corner", value: "Corner" },
    { text: "Lines", value: "Lines" },
  ]);
  assertEachButtonResumes(OFFENSES, [
    ["Back", '["back"]'],
    ["Spanking", '["spank"]'],
    ["Corner", '["Corner"]'],
    ["Lines", '["Lines"]'],
  ]);

  // Typed text completes the option whose button shows exactly that text.
  const typed = answer(plan, pending.snapshot, {
    kind: "submittedText",
    submittedText: "Spanking",
  });
  assert.deepEqual(sayTexts(typed.finished), ['["spank"]']);
});

test("buttons may return the same value, and each button completes as itself", () => {
  const source = [
    'let answer = choose win: "Open a door", lose: "Open a door", lose: "Open a door"',
    "say [answer]",
  ].join("\n");
  assert.deepEqual(compileSource(source).diagnostics, []);
  assertEachButtonResumes(source, [
    ["Open a door", '["win"]'],
    ["Open a door", '["lose"]'],
    ["Open a door", '["lose"]'],
  ]);

  // The same text on several buttons cannot be typed; the player selects a button.
  const { plan, pending } = start(source);
  const action = pending.snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction");
  const typed = completeAction(plan, pending.snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "submittedText", submittedText: "Open a door" },
  });
  assert.equal(typed.outcome.kind, "invalidPayload");

  // Values that only turn out equal at runtime are allowed as well.
  const computed = start(
    'let none = null\nlet answer = choose [{ text: "A", value: none }, { text: "B", value: none }]',
  );
  assert.equal(computed.pending.snapshot.status, "waiting");
  assert.deepEqual(
    computed.pending.events.filter((event) => event.kind === "developerWarning"),
    [],
  );
});

test("a value written before a list option is the value of every button from that list", () => {
  const source = [
    'let answer = choose win: "Open a door", lose: ["Open a door", "Open a door"]',
    "say [answer]",
  ].join("\n");
  const { pending } = start(source);
  assert.deepEqual(buttons(pending.snapshot), [
    { text: "Open a door", value: "win" },
    { text: "Open a door", value: "lose" },
    { text: "Open a door", value: "lose" },
  ]);
  assertEachButtonResumes(source, [
    ["Open a door", '["win"]'],
    ["Open a door", '["lose"]'],
    ["Open a door", '["lose"]'],
  ]);

  // Choice objects in the list take the written value too, and an empty list adds no buttons.
  const objects = start(
    'let empty = []\nlet answer = choose k: [{ text: "A", background: "gold" }], k: "B", none: empty',
  );
  assert.deepEqual(
    buttons(objects.pending.snapshot).map((option) => [option.text, option.value]),
    [
      ["A", "k"],
      ["B", "k"],
    ],
  );
});

test("a set option gives one button per member, in insertion order, like a list", () => {
  const source = [
    'let tags = set["b", "a", "b"]',
    'tags.add("c")',
    "let none = set[]",
    "let answer = choose tags, key: set[1, 2], gone: none",
    "say [answer]",
  ].join("\n");
  const { pending } = start(source);
  assert.deepEqual(
    buttons(pending.snapshot).map((option) => [option.text, option.value]),
    [
      ["b", "b"],
      ["a", "a"],
      ["c", "c"],
      ["1", "key"],
      ["2", "key"],
    ],
  );
  assertEachButtonResumes(source, [
    ["b", '["b"]'],
    ["a", '["a"]'],
    ["c", '["c"]'],
    ["1", '["key"]'],
    ["2", '["key"]'],
  ]);

  const result = compileSource("let x = choose set[]");
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
    [["TSV029", "A choice needs at least one button, but its option lists are empty."]],
  );
});

test("an option returns its value with its own type", () => {
  const cases = [
    ["let n = choose [5, 10, 15]", 1, "10", "[10]"],
    ["let n = choose 5, 10", 1, "10", "[10]"],
    ["let n = choose [1 min, 90 seconds]", 1, "1 min 30 s", "[1 min 30 s]"],
    ["let n = choose true, false", 1, "false", "[false]"],
    ["let n = choose null", 0, "null", "[null]"],
    ['let n = choose [{ text: 5, background: "gold" }]', 0, "5", "[5]"],
    ['let n = choose [{ text: "Five", value: 5 }]', 0, "Five", "[5]"],
    ['let n = choose { text: "Nothing", value: null }', 0, "Nothing", "[null]"],
  ] as const;
  for (const [source, index, text, said] of cases) {
    const { plan, pending } = start(`${source}\nsay [n]`);
    const selected = select(plan, pending.snapshot, index);
    assert.equal(selected.transcript, text, source);
    assert.deepEqual(sayTexts(selected.finished), [said], source);
    assert.equal(validateRuntimeSnapshot(selected.finished.snapshot, plan).valid, true, source);
  }
});

test("an empty option list contributes no buttons, and a choice without buttons is an error", () => {
  const { pending } = start('let none = []\nlet answer = choose none, "Only"');
  assert.deepEqual(buttons(pending.snapshot), [{ text: "Only", value: "Only" }]);

  for (const source of ["let answer = choose []", 'let answer = choose [], []\nsay "x"']) {
    const result = compileSource(source);
    assert.equal(result.plan, null, source);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [["TSV029", "A choice needs at least one button, but its option lists are empty."]],
      source,
    );
  }

  const empty = start("let none = []\nlet answer = choose none, none");
  assert.equal(empty.pending.snapshot.status, "failed");
  assert.deepEqual(
    [empty.pending.snapshot.failure?.code, empty.pending.snapshot.failure?.message],
    ["TSR052", "A choice needs at least one button, but its option lists are empty."],
  );
});

test("a retained choice settlement keeps the values its plan wrote", () => {
  const source = [
    'let text = "Keep"',
    'let more = ["A", "B"]',
    "let pick = choose keep: text, more: more",
    "wait 1",
  ].join("\n");
  const { plan, pending } = start(source);
  const done = select(plan, pending.snapshot, 0).finished.snapshot;
  assert.equal(done.foregroundAction?.kind, "delay");
  assert.ok(done.lastSettlement?.actionKind === "interaction");
  assert.equal(validateRuntimeSnapshot(done, plan).valid, true);
  // A value no option wrote, and a written value out of the written order.
  for (const [index, value] of [
    [0, "impossible"],
    [2, "keep"],
  ] as const) {
    const forged = structuredClone(createCheckpoint(plan, done));
    const settlement = forged.snapshot.lastSettlement;
    assert.ok(settlement?.actionKind === "interaction" && settlement.ui.kind === "choice");
    // EVIDENCE: fixture changes a written value in the recorded UI.
    (settlement.ui.options[index] as { value: unknown }).value = value;
    if (index === 0) {
      // EVIDENCE: fixture changes the result to the forged value of the selected button.
      (settlement as { result: unknown }).result = value;
    }
    assert.equal(validateRuntimeSnapshot(forged.snapshot, plan).valid, false, `${index}`);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(forged)), `${index}`);
  }
});

test("a computed choice counts a value equal to its button text once", () => {
  const plan = compileValidPlan("let x = choose option", { globals: ["option"] });
  const pending = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, {
      globals: { option: "x".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES / 2 + 1) },
    }),
  );
  assert.equal(pending.snapshot.failure, null);
  assert.equal(pending.snapshot.status, "waiting");
});

test("list elements with interpolation select with a fixed seed, and checkpoint resume matches", () => {
  const source = [
    'let pets = ["pet", "toy", "puppy"]',
    'let replies = ["Yes, ${pets}", "No, ${pets}"]',
    'let answer = choose replies, "Maybe"',
    "say [answer]",
  ].join("\n");
  const seed = 0x1234_5678;
  const first = start(source, seed);
  const again = start(source, seed);
  assert.deepEqual(again.pending.snapshot, first.pending.snapshot);
  const options = buttons(first.pending.snapshot);
  assert.equal(options.length, 3);
  assert.deepEqual(options[2], { text: "Maybe", value: "Maybe" });

  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(first.plan, first.pending.snapshot)),
  );
  assert.deepEqual(restored.snapshot, first.pending.snapshot);
  for (const index of [0, 2]) {
    const uninterrupted = select(first.plan, first.pending.snapshot, index);
    const resumed = select(restored.plan, restored.snapshot, index);
    assert.deepEqual(resumed.finished.snapshot, uninterrupted.finished.snapshot);
    assert.deepEqual(resumed.finished.events, uninterrupted.finished.events);
  }
  assert.deepEqual(sayTexts(select(first.plan, first.pending.snapshot, 2).finished), ['["Maybe"]']);

  // A restored pending choice must still show the buttons its captured options produce.
  const forged = structuredClone(createCheckpoint(first.plan, first.pending.snapshot));
  const action = forged.snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.ui.kind === "choice");
  // EVIDENCE: fixture changes only the value of the last presented button.
  (action.ui.options[2] as { value: unknown }).value = "Never";
  assert.throws(() => deserializeCheckpoint(JSON.stringify(forged)));
});

test("choice options the compiler can see are checked when compiling", () => {
  const cases = [
    [
      'let x = choose [["a"]]',
      "TSV029",
      "A choice list element must be a value or a choice object { value?, text, background? }, not a list or set.",
    ],
    [
      'let x = choose a: { text: "A", value: "b" }',
      "TSV029",
      "This choice option has two values, one before ':' and one in its value property. Keep one.",
    ],
    [
      'let x = choose a: [{ text: "A", value: "b" }]',
      "TSV029",
      "This choice option has two values, one before ':' and one in its value property. Keep one.",
    ],
    [
      'let x = choose [{ text: "A", value: ["b"] }]',
      "TSV029",
      "A choice value must be text, a number, true, false, null, or a duration.",
    ],
    [
      'let x = choose [{ text: "A", color: "red" }]',
      "TSV029",
      "Choice objects support value, text, and background only.",
    ],
    ["let x = choose [{ value: 1 }]", "TSV029", "A choice object requires text."],
    [
      'let x = choose [{ text: "A", value: 1..2 }]',
      "TSV029",
      "A choice value must be text, a number, true, false, null, or a duration.",
    ],
    ["let x = choose [{ text: {} }]", "TSV042", "The text of a choice option cannot be an object."],
    [
      'let x = choose [{ text: "A", background: ["red"] }]',
      "TSV029",
      "Expected an opaque CSS button background colour.",
    ],
    [
      "let x = choose [1..2]",
      "TSV029",
      "A choice option must be a value, a choice object { value?, text, background? }, a list, or a set.",
    ],
    [
      `let x = choose [${Array.from({ length: 4097 }, (_, index) => index).join(", ")}]`,
      "TSV029",
      "A choice can show at most 4096 buttons.",
    ],
    [
      `let x = choose [${Array.from({ length: 4096 }, (_, index) => index).join(", ")}], 4096 + 1`,
      "TSV029",
      "A choice can show at most 4096 buttons.",
    ],
    [
      `let extra: integer? = 1\nlet x = choose [${Array.from({ length: 4096 }, (_, index) => index).join(", ")}], extra`,
      "TSV029",
      "A choice can show at most 4096 buttons.",
    ],
    [
      "speaker vera {}\nlet x = choose [vera]",
      "TSV029",
      "A choice option must be a value, a choice object { value?, text, background? }, a list, or a set.",
    ],
    [
      "speaker vera {}\nlet x = choose [{ text: vera }]",
      "TSV042",
      "The text of a choice option cannot be a speaker.",
    ],
    [
      'let names = ["a"]\nlet x = choose [names]',
      "TSV029",
      "A choice list element must be a value or a choice object { value?, text, background? }, not a list or set.",
    ],
    [
      'let x = choose { text: "A", background: 1 second }',
      "TSV029",
      "Expected an opaque CSS button background colour.",
    ],
    [
      'let shade: duration? = 1 s\nshowButton "Go", background: shade',
      "TSV029",
      "Expected an opaque CSS button background colour.",
    ],
    [
      'speaker vera {}\nlet x = choose as vera speaker, "B"',
      "TSV029",
      "A choice option must be a value, a choice object { value?, text, background? }, a list, or a set.",
    ],
    [
      'let x = choose [set["B"]]',
      "TSV029",
      "A choice list element must be a value or a choice object { value?, text, background? }, not a list or set.",
    ],
  ] as const;
  for (const [source, code, message] of cases) {
    const result = compileSource(source);
    assert.equal(result.plan, null, source);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [[code, message]],
      source,
    );
  }
});

test("a choice of durations is a duration where the compiler checks numbers and durations", () => {
  assert.deepEqual(
    compileSource('playAudio(file: "x.mp3", startAt: (choose { text: 1 second }))').diagnostics,
    [],
  );
  for (const source of [
    "let x = (choose [{ text: -1 s }])..3",
    'let x = (choose [{ text: "A", value: 1 s + 2 s }])..3',
  ]) {
    const result = compileSource(source);
    assert.equal(result.plan, null, source);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["TSV043"],
      source,
    );
  }
  assert.deepEqual(compileSource("let x = (choose 4 s / 2 s, 3)..5").diagnostics, []);
});

test("choice options known only at runtime are checked before the choice opens", () => {
  const cases = [
    // `dynamic` hides the element's type, so one list may hold text and a list.
    [
      'function dynamic(value) {\n    return value\n}\nlet o = [dynamic("a"), ["b"]]\nlet x = choose o',
      "not a list or set.",
    ],
    ['let o = { text: "A", value: "a" }\nlet x = choose k: o', "Keep one."],
    [
      'function options {\n    return [{ text: "A", value: "a" }]\n}\nlet x = choose k: options()',
      "Keep one.",
    ],
    ['let o = [{ value: "a" }]\nlet x = choose o', "A choice object requires text."],
    ['let o = [{ text: "A", value: ["a"] }]\nlet x = choose o', "or a duration."],
    // The compiler rejects a known set or range element itself; `dynamic` hides it until the choice opens.
    [
      "function dynamic(value) {\n    return value\n}\nlet o = [dynamic(set[1])]\nlet x = choose o",
      "not a list or set.",
    ],
    [
      "function dynamic(value) {\n    return value\n}\nlet o = [dynamic(1..2)]\nlet x = choose o",
      "a list, or a set.",
    ],
  ] as const;
  for (const [source, ending] of cases) {
    const { pending } = start(source);
    assert.equal(pending.snapshot.status, "failed", source);
    assert.equal(pending.snapshot.failure?.code, "TSR052", source);
    assert.ok(pending.snapshot.failure?.message.endsWith(ending), source);
    assert.equal(pending.snapshot.foregroundAction, null, source);
  }

  const tooManyPlan = compileValidPlan("let x = choose o", { globals: ["o"] });
  const tooMany = run(
    tooManyPlan,
    createImmediatePacingRuntimeSnapshot(tooManyPlan, {
      globals: { o: createSerializableList(Array.from({ length: 4097 }, (_, index) => index)) },
    }),
  );
  assert.equal(tooMany.snapshot.failure?.code, "TSR052");
  assert.equal(tooMany.snapshot.failure?.message, "A choice can show at most 4096 buttons.");
});

test("a computed list of choice objects returns their values, and a literal option list holds one type", () => {
  // The objects may return their value or their text, so the result type is not known here.
  const { plan, pending } = start(
    'let options = [{ text: "One", value: 1 }]\nlet result: integer = choose options\nsay [result]',
  );
  assert.deepEqual(sayTexts(select(plan, pending.snapshot, 0).finished), ["[1]"]);
  // A literal list or set of options mixes types like any other literal (ADR 0021 rule 1.3).
  for (const source of [
    'let result = choose [1, "A"]',
    'let result = choose set[1, "A"]',
    'let result = choose key: [1, "A"]',
  ])
    assert.deepEqual(
      compileSource(source).diagnostics.map((diagnostic) => diagnostic.code),
      ["TSV044"],
      source,
    );
});
