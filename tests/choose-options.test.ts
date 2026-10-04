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

test("a choice that returns text and numbers needs a place declared with a union type", () => {
  // #511 C2: a declared union keeps every button's value, with its type.
  const source = 'let rounds: integer | string = choose "None", [5, 10]\nsay [rounds]';
  for (const [index, said] of [
    [0, '["None"]'],
    [1, "[5]"],
  ] as const) {
    const { plan, pending } = start(source);
    assert.deepEqual(sayTexts(select(plan, pending.snapshot, index).finished), [said]);
  }
  assert.deepEqual(
    compileSource(
      'function take(value: integer | string) {\n    say "x"\n}\ntake(choose "None", 5)',
    ).diagnostics,
    [],
  );
  // Without a declared union, the message names the annotation to write.
  const message = (source: string) =>
    compileSource(source).diagnostics.map((d) => [d.code, d.message]);
  assert.deepEqual(message('let rounds = choose "None", [5, 10]'), [
    [
      "TSV044",
      "This choose returns text (string) or a whole number (integer). A place keeps one type; to keep both, declare a union type, as in 'let rounds: string | integer = choose ...'.",
    ],
  ]);
  assert.deepEqual(message('function pick {\n    return choose "None", 5\n}'), [
    [
      "TSV044",
      "This choose returns text (string) or a whole number (integer). A place keeps one type; to keep both, declare the result type, as in 'function pick(...): string | integer'.",
    ],
  ]);
  assert.deepEqual(message('function take(value) {\n    say "x"\n}\ntake(choose "None", 5)'), [
    [
      "TSV044",
      "This choose returns text (string) or a whole number (integer). A place keeps one type; to keep both, declare the parameter as 'value: string | integer'.",
    ],
  ]);
  assert.deepEqual(
    compileSource('let rounds = 5\nrounds = choose "None", 5').diagnostics.map((d) => d.code),
    ["TSV041"],
  );
  // A property has no declared type, and an option that already holds a union mixes its result as well.
  const spans = (source: string) =>
    compileSource(source).diagnostics.map((d) => [
      d.code,
      source.slice(d.span.start.offset, d.span.end.offset),
    ]);
  assert.deepEqual(spans('let box = { answer: choose "a", 1 }'), [["TSV044", 'choose "a", 1']]);
  const choices = 'let choices: (string | integer)[] = ["a", 1]\n';
  assert.deepEqual(spans(`${choices}let answer = choose choices`), [["TSV044", "choose choices"]]);
  assert.deepEqual(spans(`${choices}let answer: string | integer = choose choices`), []);
  // A copy of a value of a union type keeps the plain union, not the button values.
  const answer = 'let answer: string | integer = choose "a", 1\n';
  assert.deepEqual(spans(`${answer}let copy = answer\ncopy = "z"`), []);
  assert.deepEqual(spans(`${answer}let copies = [answer]\ncopies.add("z")`), []);
  // Values of one union type join, whatever values each may be.
  assert.deepEqual(
    spans(`${answer}let other: string | integer = choose "b", 2\nlet both = [answer, other]`),
    [],
  );
  // A place whose type is not written needs a written union, also when it already holds a union, and options of
  // unknown type do not hide the known ones.
  assert.deepEqual(message(`${answer}let copied = answer\ncopied = choose "b", 2`), [
    [
      "TSV044",
      "This choose returns text (string) or a whole number (integer). A place keeps one type; to keep both, declare it as 'let copied: string | integer = ...'.",
    ],
  ]);
  // A parameter without a type, also where a test narrowed it, a value of unknown type, and a property of an `object`
  // have no written type either; the caller's declared union does not declare the parameter.
  const values = 'let values: (string | integer)[] = ["old"]\n';
  for (const source of [
    `function probe(p) {\n    if p is (string | integer)[] {\n        p.add(choose "new", 2)\n    }\n}\n${values}probe(values)`,
    `function probe(p) {\n    if p is (string | integer)[][] {\n        p.first.add(choose "new", 2)\n    }\n}`,
    `function probe(p) {\n    p.add(choose "new", 2)\n}\n${values}probe(values)`,
    `function probe(p) {\n    p[0] = choose "new", 2\n}`,
    `function probe(p) {\n    p.answer = choose "new", 2\n}`,
    `${values}let box: object = { values: values }\nbox.values.add(choose "new", 2)`,
    'function probe(p: speaker | object) {\n    p.firstName = choose "new", 2\n}',
  ])
    assert.deepEqual(spans(source), [["TSV044", 'choose "new", 2']], source);
  // A speaker shows its text property as text.
  assert.deepEqual(
    spans(
      'function probe(p: speaker | object) {\n    if p is speaker {\n        p.firstName = choose "new", 2\n    }\n}',
    ),
    [],
  );
  assert.deepEqual(
    spans(
      `function probe(p: (string | integer)[]) {\n    p.add(choose "new", 2)\n}\n${values}probe(values)`,
    ),
    [],
  );
  for (const options of ['v, "a", 1', '"a", v, 1', '"a", 1, v'])
    assert.deepEqual(
      message(`function pick(v) {\n    let answer = choose ${options}\n}`),
      [
        [
          "TSV044",
          "This choose returns text (string) or a whole number (integer). A place keeps one type; to keep both, declare a union type, as in 'let answer: string | integer = choose ...'.",
        ],
      ],
      options,
    );
});

test("comparing a choice result with a value no button returns is a warning", () => {
  // #511 C5: the possible button values follow the variable as narrowing does, until it is assigned again.
  const warnings = (source: string) =>
    compileSource(source).diagnostics.map((d) => [d.severity, d.code, d.message]);
  assert.deepEqual(
    warnings('let answer = choose "spank", "lines"\nif answer == "Open" {\n    say "x"\n}'),
    [
      [
        "warning",
        "TSV046",
        '\'answer\' is always "spank" or "lines" here, so this comparison is always false.',
      ],
    ],
  );
  assert.deepEqual(
    warnings(
      'let answer = choose spank: "Spanking", lines: "Lines"\nlet other = answer != "Lines"',
    )[0],
    [
      "warning",
      "TSV046",
      '\'answer\' is always "spank" or "lines" here, so this comparison is always true.',
    ],
  );
  for (const source of [
    'let answer = choose "spank", "lines"\nif answer == "spank" {\n    say "x"\n}',
    'let answer = choose "spank", "lines"\nanswer = "Open"\nif answer == "Open" {\n    say "x"\n}',
    "let n = choose [5, 10]\nlet five = n == 5.0",
    'let pets = ["pet", "toy"]\nlet pick = choose pets\nlet other = pick == "x"',
  ])
    assert.deepEqual(warnings(source), [], source);
  // The possible values survive copies, returns, and `-`, and a test or a wider variable keeps them where they apply.
  const answer = 'let answer = choose "a", "b"\n';
  for (const source of [
    `${answer}let copy = "init"\ncopy = answer\nlet same = copy == "z"`,
    'function pick {\n    return choose "a", "b"\n}\nlet answer = pick()\nlet same = answer == "z"',
    `${answer}let same = answer == null`,
    "let n = choose 1, 2\nlet negative = -n\nlet same = negative == 1",
    "let n = choose 1, 2\nlet same = n == 3\nn = 1.5",
  ])
    assert.deepEqual(
      warnings(source).map(([severity, code]) => [severity, code]),
      [["warning", "TSV046"]],
      source,
    );
  // A test leaves only the values that can pass or fail it, and button values decide a type test as well.
  const warned = (source: string) =>
    compileSource(source).diagnostics.map((d) => [
      d.code,
      source.slice(d.span.start.offset, d.span.end.offset),
      d.message,
    ]);
  assert.deepEqual(
    warned("let n = choose 1.0, 1.5\nif n is not integer {\n    let same = n == 1.0\n}"),
    [["TSV046", "n == 1.0", "'n' is always 1.5 here, so this comparison is always false."]],
  );
  assert.deepEqual(warned("let n = choose 1.0, 2.0\nlet whole = n is integer"), [
    ["TSV046", "n is integer", "'n' is always 1 or 2 here, so this test is always true."],
  ]);
  // Durations compare by length, never with numbers, also inside one union, and `choose null` is null.
  for (const source of [
    "let d = choose 1 s, 2 s\nlet same = d == 3 s",
    "let d = choose 1 s, 2 s\nlet same = d == 1000",
    "let n = choose 1000, 2000\nlet same = n == 1 s",
    "let value: duration | integer = choose 1 s, 2000\nlet same = value == 2 s",
    'let answer = choose null\nlet same = answer == "z"',
  ])
    assert.deepEqual(
      warnings(source).map(([severity, code]) => [severity, code]),
      [["warning", "TSV046"]],
      source,
    );
  assert.match(
    warnings("let d = choose 1 s, 2 s\nlet same = d == 3 s")[0]?.[2] ?? "",
    /1 s or 2 s/,
  );
  assert.deepEqual(
    warned("let value: duration | integer = choose 1 s, 2\nlet same = value == 3 s"),
    [
      [
        "TSV046",
        "value == 3 s",
        "'value' is always 1 s or 2 here, so this comparison is always false.",
      ],
    ],
  );
  // A literal `case` compares with `==` as well; a case that some button returns, and a range, are not warned about.
  assert.deepEqual(
    warned(
      'let answer = choose "spank", "lines"\nswitch answer {\n    case "Open" {\n        say "x"\n    }\n    case "spank" {\n        say "y"\n    }\n}',
    ),
    [
      [
        "TSV046",
        '"Open"',
        '\'answer\' is always "spank" or "lines" here, so this case never matches.',
      ],
    ],
  );
  assert.deepEqual(
    warned('let n = choose 1, 2\nswitch n {\n    case 1..3 {\n        say "x"\n    }\n}'),
    [],
  );
  for (const source of [
    "let d = choose 1 s, 2 s\nlet same = d == 1000 ms",
    "let value: duration | integer = choose 1 s, 2000\nlet same = value == 1000 ms",
    "let value: duration | integer = choose 1 s, 2000\nlet same = value == 2000",
    'let answer = choose null\nanswer = "z"\nlet same = answer == "z"',
    "let n = choose 1, 2\nlet negative = -n\nlet same = negative == -1",
    'let n = choose 1.0, 1.5\nlet items = ["zero", "one"]\nif n is integer {\n    say items[n]\n}',
  ])
    assert.deepEqual(warnings(source), [], source);
  assert.deepEqual(
    warnings('let n = choose 1, 2\nlet items = ["a", "b", "c"]\nsay items[n]\nn = 1.5').map(
      ([, code]) => code,
    ),
    ["TSV043"],
  );
  // The warning does not change what runs.
  const plan = compileSource(
    'let answer = choose "spank", "lines"\nsay "${answer == "Open"}"',
  ).plan;
  assert.ok(plan !== null);
  const pending = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.deepEqual(sayTexts(select(plan, pending.snapshot, 0).finished), ["false"]);
});
