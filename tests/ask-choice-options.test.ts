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
} from "../src/runtime/snapshot/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { createSerializableList } from "../src/runtime/values/serializable-values.js";
import type { RuntimeSnapshot } from "../src/runtime/snapshot/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { sayTexts } from "./helpers/runtime-events.js";
import { validateRuntimeSnapshot } from "../src/runtime/snapshot/snapshot-validation.js";

const OFFENSES = [
  'let offenses = [{ value: "spank", text: "Spanking", background: "seagreen" }, { text: "Corner" }]',
  'let answer = askChoice back: "Back", offenses, "Lines"',
  "say [answer]",
  "exit",
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

test("choose is now askChoice: the earlier name is a compile error that names the fix, and is read as askChoice", () => {
  const source = "let rounds = choose as mistress 5 10\nexit";
  const start = source.indexOf("choose");
  assert.deepEqual(
    compileSource(source).diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.message,
      diagnostic.span.start.offset,
      diagnostic.span.end.offset,
    ]),
    [
      [
        "TSP032",
        "'choose' is now called 'askChoice', like the other asks that wait for the player's answer. Write 'askChoice' instead.",
        start,
        start + "choose".length,
      ],
      // The options after it are read as those of an askChoice, so a missing comma is reported too.
      [
        "TSP031",
        "Expected ',' or the end of the statement after a choice option.",
        source.indexOf("10"),
        source.indexOf("10") + 2,
      ],
    ],
  );
  // Names that only start with the word stay ordinary identifiers.
  assert.deepEqual(
    compileSource('let chooseOne = askChoice "A", "B"\nsay chooseOne\nexit').diagnostics,
    [],
  );
});

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

test("a list joined with + gives one button per element, in order", () => {
  const source = [
    'let options = ["Red", "Blue"]',
    'let answer = askChoice ["Back"] + options',
    "say [answer]",
    "exit",
  ].join("\n");
  assert.deepEqual(buttons(start(source).pending.snapshot), [
    { text: "Back", value: "Back" },
    { text: "Red", value: "Red" },
    { text: "Blue", value: "Blue" },
  ]);
  assertEachButtonResumes(source, [
    ["Back", '["Back"]'],
    ["Red", '["Red"]'],
    ["Blue", '["Blue"]'],
  ]);
});

test("buttons may return the same value, and each button completes as itself", () => {
  const source = [
    'let answer = askChoice win: "Open a door", lose: "Open a door", lose: "Open a door"',
    "say [answer]",
    "exit",
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
    'let none = null\nlet answer = askChoice [{ text: "A", value: none }, { text: "B", value: none }]\nexit',
  );
  assert.equal(computed.pending.snapshot.status, "waiting");
  assert.deepEqual(
    computed.pending.events.filter((event) => event.kind === "developerWarning"),
    [],
  );
});

test("a value written before a list option is the value of every button from that list", () => {
  const source = [
    'let answer = askChoice win: "Open a door", lose: ["Open a door", "Open a door"]',
    "say [answer]",
    "exit",
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
    'let empty = []\nlet answer = askChoice k: [{ text: "A", background: "gold" }], k: "B", none: empty\nexit',
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
    "let answer = askChoice tags, key: set[1, 2], gone: none",
    "say [answer]",
    "exit",
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

  const result = compileSource("let x = askChoice set[]");
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
    [["TSV029", "A choice needs at least one button, but its option lists are empty."]],
  );
});

test("an option returns its value with its own type", () => {
  const cases = [
    ["let n = askChoice [5, 10, 15]", 1, "10", "[10]"],
    ["let n = askChoice 5, 10", 1, "10", "[10]"],
    ["let n = askChoice [1 min, 90 seconds]", 1, "1 minute 30 seconds", "[1 minute 30 seconds]"],
    ["let n = askChoice [90 deg, pi rad]", 1, "180°", "[180°]"],
    ["let n = askChoice 90 deg, pi rad", 1, "180°", "[180°]"],
    ["let n = askChoice true, false", 1, "false", "[false]"],
    ["let n = askChoice null", 0, "null", "[null]"],
    ['let n = askChoice [{ text: 5, background: "gold" }]', 0, "5", "[5]"],
    ['let n = askChoice [{ text: "Five", value: 5 }]', 0, "Five", "[5]"],
    ['let n = askChoice { text: "Nothing", value: null }', 0, "Nothing", "[null]"],
  ] as const;
  for (const [source, index, text, said] of cases) {
    const { plan, pending } = start(`${source}\nsay [n]\nexit`);
    const selected = select(plan, pending.snapshot, index);
    assert.equal(selected.transcript, text, source);
    assert.deepEqual(sayTexts(selected.finished), [said], source);
    assert.equal(validateRuntimeSnapshot(selected.finished.snapshot, plan).valid, true, source);
  }
});

test("an empty option list contributes no buttons, and a choice without buttons is an error", () => {
  const { pending } = start('let none = []\nlet answer = askChoice none, "Only"\nexit');
  assert.deepEqual(buttons(pending.snapshot), [{ text: "Only", value: "Only" }]);

  for (const source of ["let answer = askChoice []", 'let answer = askChoice [], []\nsay "x"']) {
    const result = compileSource(source);
    assert.equal(result.plan, null, source);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [["TSV029", "A choice needs at least one button, but its option lists are empty."]],
      source,
    );
  }

  const empty = start("let none = []\nlet answer = askChoice none, none\nexit");
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
    "let pick = askChoice keep: text, more: more",
    "wait 1 s",
    "exit",
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
  const plan = compileValidPlan("let x = askChoice option\nexit", { globals: ["option"] });
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
    'let answer = askChoice replies, "Maybe"',
    "say [answer]",
    "exit",
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
      'let x = askChoice [["a"]]\nexit',
      "TSV029",
      "A choice list element must be a value or a choice object { value?, text, background? }, not a list or set.",
    ],
    [
      'let x = askChoice a: { text: "A", value: "b" }',
      "TSV029",
      "This choice option has two values, one before ':' and one in its value property. Keep one.",
    ],
    [
      'let x = askChoice a: [{ text: "A", value: "b" }]',
      "TSV029",
      "This choice option has two values, one before ':' and one in its value property. Keep one.",
    ],
    [
      'let x = askChoice [{ text: "A", value: ["b"] }]\nexit',
      "TSV029",
      "A choice value must be text, a number, true, false, null, a duration, an angle, or a date or time value.",
    ],
    [
      'let x = askChoice [{ text: "A", color: "red" }]',
      "TSV029",
      "A choice object can only have 'value', 'text', and 'background', but this one has 'color'. Remove it.",
    ],
    [
      "let x = askChoice [{ value: 1 }]",
      "TSV029",
      "A choice object needs a 'text' property to label its button.",
    ],
    [
      'let x = askChoice [{ text: "A", value: 1..2 }]\nexit',
      "TSV029",
      "A choice value must be text, a number, true, false, null, a duration, an angle, or a date or time value.",
    ],
    [
      "let x = askChoice [{ text: {} }]\nexit",
      "TSV042",
      "The text of a choice option cannot be an object.",
    ],
    [
      'let x = askChoice [{ text: "A", background: ["red"] }]\nexit',
      "TSV029",
      'A button background must be an opaque CSS colour, such as "#336699", but this is a list (string[]).',
    ],
    [
      "let x = askChoice [1..2]\nexit",
      "TSV029",
      "A choice option must be a value, a choice object { value?, text, background? }, a list, or a set.",
    ],
    [
      `let x = askChoice [${Array.from({ length: 4097 }, (_, index) => index).join(", ")}]\nexit`,
      "TSV029",
      "A choice can show at most 4096 buttons.",
    ],
    [
      `let x = askChoice [${Array.from({ length: 4096 }, (_, index) => index).join(", ")}], 4096 + 1\nexit`,
      "TSV029",
      "A choice can show at most 4096 buttons.",
    ],
    [
      `let extra: integer? = 1\nlet x = askChoice [${Array.from({ length: 4096 }, (_, index) => index).join(", ")}], extra\nexit`,
      "TSV029",
      "A choice can show at most 4096 buttons.",
    ],
    [
      "speaker vera {}\nlet x = askChoice [vera]\nexit",
      "TSV029",
      "A choice option must be a value, a choice object { value?, text, background? }, a list, or a set.",
    ],
    [
      "speaker vera {}\nlet x = askChoice [{ text: vera }]\nexit",
      "TSV042",
      "The text of a choice option cannot be a speaker.",
    ],
    [
      'let names = ["a"]\nlet x = askChoice [names]\nexit',
      "TSV029",
      "A choice list element must be a value or a choice object { value?, text, background? }, not a list or set.",
    ],
    [
      'let x = askChoice { text: "A", background: 1 second }',
      "TSV029",
      'A button background must be an opaque CSS colour, such as "#336699", but this is a duration.',
    ],
    [
      'let shade: duration? = 1 s\nshowButton "Go", background: shade\nexit',
      "TSV029",
      'A button background must be an opaque CSS colour, such as "#336699", but this is a duration.',
    ],
    [
      'speaker vera {}\nlet x = askChoice as vera speaker, "B"\nexit',
      "TSV029",
      "A choice option must be a value, a choice object { value?, text, background? }, a list, or a set.",
    ],
    [
      'let x = askChoice [set["B"]]\nexit',
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
    compileSource('playAudio(file: "x.mp3", startAt: (askChoice { text: 1 second }))\nexit')
      .diagnostics,
    [],
  );
  for (const source of [
    "let x = (askChoice [{ text: -1 s }])..3\nexit",
    'let x = (askChoice [{ text: "A", value: 1 s + 2 s }])..3\nexit',
  ]) {
    const result = compileSource(source);
    assert.equal(result.plan, null, source);
    // A duration is no range bound.
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["TSV010"],
      source,
    );
  }
  assert.deepEqual(compileSource("let x = (askChoice 4 s / 2 s, 3)..5\nexit").diagnostics, []);
});

test("choice options known only at runtime are checked before the choice opens", () => {
  const cases = [
    // `dynamic` hides the element's type, so one list may hold text and a list.
    [
      'function dynamic(value) {\n    return value\n}\nlet o = [dynamic("a"), ["b"]]\nlet x = askChoice o\nexit',
      "not a list or set.",
    ],
    ['let o = { text: "A", value: "a" }\nlet x = askChoice k: o\nexit', "Keep one."],
    [
      'function options {\n    return [{ text: "A", value: "a" }]\n}\nlet x = askChoice k: options()\nexit',
      "Keep one.",
    ],
    [
      'let o = [{ value: "a" }]\nlet x = askChoice o\nexit',
      "A choice object needs a 'text' property to label its button.",
    ],
    [
      'let o = [{ text: "A", value: ["a"] }]\nlet x = askChoice o\nexit',
      "or a date or time value.",
    ],
    // The compiler rejects a known set or range element itself; `dynamic` hides it until the choice opens.
    [
      "function dynamic(value) {\n    return value\n}\nlet o = [dynamic(set[1])]\nlet x = askChoice o\nexit",
      "not a list or set.",
    ],
    [
      "function dynamic(value) {\n    return value\n}\nlet o = [dynamic(1..2)]\nlet x = askChoice o\nexit",
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

  const tooManyPlan = compileValidPlan("let x = askChoice o\nexit", { globals: ["o"] });
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
    'let options = [{ text: "One", value: 1 }]\nlet result: integer = askChoice options\nsay [result]\nexit',
  );
  assert.deepEqual(sayTexts(select(plan, pending.snapshot, 0).finished), ["[1]"]);
  // A literal list or set of options mixes types like any other literal (ADR 0021 rule 1.3).
  for (const source of [
    'let result = askChoice [1, "A"]\nexit',
    'let result = askChoice set[1, "A"]\nexit',
    'let result = askChoice key: [1, "A"]\nexit',
  ])
    assert.deepEqual(
      compileSource(source).diagnostics.map((diagnostic) => diagnostic.code),
      ["TSV044"],
      source,
    );
});

test("a choice that returns text and numbers needs a place declared with a union type", () => {
  // #511 C2: a declared union keeps every button's value, with its type.
  const source = 'let rounds: integer | string = askChoice "None", [5, 10]\nsay [rounds]\nexit';
  for (const [index, said] of [
    [0, '["None"]'],
    [1, "[5]"],
  ] as const) {
    const { plan, pending } = start(source);
    assert.deepEqual(sayTexts(select(plan, pending.snapshot, index).finished), [said]);
  }
  assert.deepEqual(
    compileSource(
      'function take(value: integer | string) {\n    say "x"\n}\ntake(askChoice "None", 5)\nexit',
    ).diagnostics,
    [],
  );
  // Without a declared union, the message names the annotation to write.
  const message = (source: string) =>
    compileSource(source).diagnostics.map((d) => [d.code, d.message]);
  assert.deepEqual(message('let rounds = askChoice "None", [5, 10]\nexit'), [
    [
      "TSV044",
      "This askChoice returns text (string) or a whole number (integer). A place keeps one type. To keep both, declare a union type, as in 'let rounds: string | integer = askChoice ...'.",
    ],
  ]);
  assert.deepEqual(message('function pick {\n    return askChoice "None", 5\n}\nexit'), [
    [
      "TSV044",
      "This askChoice returns text (string) or a whole number (integer). A place keeps one type. To keep both, declare the result type, as in 'function pick: string | integer'.",
    ],
  ]);
  assert.deepEqual(
    message('function take(value) {\n    say "x"\n}\ntake(askChoice "None", 5)\nexit'),
    [
      [
        "TSV044",
        "This askChoice returns text (string) or a whole number (integer). A place keeps one type. To keep both, declare the parameter as 'value: string | integer'.",
      ],
    ],
  );
  assert.deepEqual(
    compileSource('let rounds = 5\nrounds = askChoice "None", 5\nexit').diagnostics.map(
      (d) => d.code,
    ),
    ["TSV041"],
  );
  // A property has no declared type, and an option that already holds a union mixes its result as well.
  const spans = (source: string) =>
    compileSource(source).diagnostics.map((d) => [
      d.code,
      source.slice(d.span.start.offset, d.span.end.offset),
    ]);
  assert.deepEqual(spans('let box = { answer: askChoice "a", 1 }\nexit'), [
    ["TSV044", 'askChoice "a", 1'],
  ]);
  const choices = 'let choices: (string | integer)[] = ["a", 1]\n';
  assert.deepEqual(spans(`${choices}let answer = askChoice choices\nexit`), [
    ["TSV044", "askChoice choices"],
  ]);
  assert.deepEqual(spans(`${choices}let answer: string | integer = askChoice choices\nexit`), []);
  // A copy of a value of a union type keeps the plain union, not the button values.
  const answer = 'let answer: string | integer = askChoice "a", 1\n';
  assert.deepEqual(spans(`${answer}let copy = answer\ncopy = "z"\nexit`), []);
  assert.deepEqual(spans(`${answer}let copies = [answer]\ncopies.add("z")\nexit`), []);
  // Values of one union type join, whatever values each may be.
  assert.deepEqual(
    spans(
      `${answer}let other: string | integer = askChoice "b", 2\nlet both = [answer, other]\nexit`,
    ),
    [],
  );
  // A place whose type is not written needs a written union, also when it already holds a union, and options of
  // unknown type do not hide the known ones.
  assert.deepEqual(message(`${answer}let copied = answer\ncopied = askChoice "b", 2\nexit`), [
    [
      "TSV044",
      "This askChoice returns text (string) or a whole number (integer). A place keeps one type. To keep both, declare it as 'let copied: string | integer = ...'.",
    ],
  ]);
  // A parameter without a type, also where a test narrowed it, a value of unknown type, and a property of an `object`
  // have no written type either; the caller's declared union does not declare the parameter.
  const values = 'let values: (string | integer)[] = ["old"]\n';
  for (const source of [
    `function probe(p) {\n    if p is (string | integer)[] {\n        p.add(askChoice "new", 2)\n    }\n}\n${values}probe(values)\nexit`,
    `function probe(p) {\n    if p is (string | integer)[][] {\n        p.first.add(askChoice "new", 2)\n    }\n}\nexit`,
    `function probe(p) {\n    p.add(askChoice "new", 2)\n}\n${values}probe(values)\nexit`,
    `function probe(p) {\n    p[0] = askChoice "new", 2\n}\nexit`,
    `function probe(p) {\n    p.answer = askChoice "new", 2\n}\nexit`,
    `${values}let box: object = { values: values }\nbox.values.add(askChoice "new", 2)\nexit`,
    'function probe(p: speaker | object) {\n    p.firstName = askChoice "new", 2\n}\nexit',
  ])
    assert.deepEqual(spans(source), [["TSV044", 'askChoice "new", 2']], source);
  // A function called before the speaker it stores into is declared is checked once the speaker is, so the store goes to
  // a speaker, which shows the value as text.
  const early =
    'function change(active = false) {\n    if active {\n        voice.firstName = askChoice "new", 2\n    }\n}\nchange()\nspeaker voice { firstName: "Old" }\nchange(true)\nsay voice.firstName\nexit';
  assert.deepEqual(spans(early), []);
  for (const [index, said] of [
    [0, "new"],
    [1, "2"],
  ] as const) {
    const { plan, pending } = start(early);
    assert.deepEqual(sayTexts(select(plan, pending.snapshot, index).finished), [said]);
  }
  // A speaker shows its text property as text.
  assert.deepEqual(
    spans(
      'function probe(p: speaker | object) {\n    if p is speaker {\n        p.firstName = askChoice "new", 2\n    }\n}\nexit',
    ),
    [],
  );
  assert.deepEqual(
    spans(
      `function probe(p: (string | integer)[]) {\n    p.add(askChoice "new", 2)\n}\n${values}probe(values)\nexit`,
    ),
    [],
  );
  for (const options of ['v, "a", 1', '"a", v, 1', '"a", 1, v'])
    assert.deepEqual(
      message(`function pick(v) {\n    let answer = askChoice ${options}\n}\nexit`),
      [
        [
          "TSV044",
          "This askChoice returns text (string) or a whole number (integer). A place keeps one type. To keep both, declare a union type, as in 'let answer: string | integer = askChoice ...'.",
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
    warnings(
      'let answer = askChoice "spank", "lines"\nif answer == "Open" {\n    say "x"\n}\nexit',
    ),
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
      'let answer = askChoice spank: "Spanking", lines: "Lines"\nlet other = answer != "Lines"\nexit',
    )[0],
    [
      "warning",
      "TSV046",
      '\'answer\' is always "spank" or "lines" here, so this comparison is always true.',
    ],
  );
  for (const source of [
    'let answer = askChoice "spank", "lines"\nif answer == "spank" {\n    say "x"\n}\nexit',
    'let answer = askChoice "spank", "lines"\nanswer = "Open"\nif answer == "Open" {\n    say "x"\n}\nexit',
    "let n = askChoice [5, 10]\nlet five = n == 5.0\nexit",
    'let pets = ["pet", "toy"]\nlet pick = askChoice pets\nlet other = pick == "x"\nexit',
  ])
    assert.deepEqual(warnings(source), [], source);
  // The possible values survive copies, returns, and `-`, and a test or a wider variable keeps them where they apply.
  const answer = 'let answer = askChoice "a", "b"\n';
  for (const source of [
    `${answer}let copy = "init"\ncopy = answer\nlet same = copy == "z"\nexit`,
    'function pick {\n    return askChoice "a", "b"\n}\nlet answer = pick()\nlet same = answer == "z"\nexit',
    `${answer}let same = answer == null\nexit`,
    "let n = askChoice 1, 2\nlet negative = -n\nlet same = negative == 1\nexit",
    "let n = askChoice 1, 2\nlet same = n == 3\nn = 1.5\nexit",
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
    warned("let n = askChoice 1.0, 1.5\nif n is not integer {\n    let same = n == 1.0\n}\nexit"),
    [["TSV046", "n == 1.0", "'n' is always 1.5 here, so this comparison is always false."]],
  );
  assert.deepEqual(warned("let n = askChoice 1.0, 2.0\nlet whole = n is integer\nexit"), [
    ["TSV046", "n is integer", "'n' is always 1 or 2 here, so this test is always true."],
  ]);
  // Durations compare by length, never with numbers, also inside one union, and `askChoice null` is null.
  for (const source of [
    "let d = askChoice 1 s, 2 s\nlet same = d == 3 s\nexit",
    "let d = askChoice 1 s, 2 s\nlet same = d == 1000\nexit",
    "let n = askChoice 1000, 2000\nlet same = n == 1 s\nexit",
    "let value: duration | integer = askChoice 1 s, 2000\nlet same = value == 2 s\nexit",
    'let answer = askChoice null\nlet same = answer == "z"\nexit',
  ])
    assert.deepEqual(
      warnings(source).map(([severity, code]) => [severity, code]),
      [["warning", "TSV046"]],
      source,
    );
  assert.match(
    warnings("let d = askChoice 1 s, 2 s\nlet same = d == 3 s\nexit")[0]?.[2] ?? "",
    /1 second or 2 seconds/,
  );
  assert.deepEqual(
    warned("let value: duration | integer = askChoice 1 s, 2\nlet same = value == 3 s\nexit"),
    [
      [
        "TSV046",
        "value == 3 s",
        "'value' is always 1 second or 2 here, so this comparison is always false.",
      ],
    ],
  );
  // A literal `case` compares with `==` as well; a case that some button returns, and a range, are not warned about.
  assert.deepEqual(
    warned(
      'let answer = askChoice "spank", "lines"\nswitch answer {\n    case "Open" {\n        say "x"\n    }\n    case "spank" {\n        say "y"\n    }\n}\nexit',
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
    warned('let n = askChoice 1, 2\nswitch n {\n    case 1..3 {\n        say "x"\n    }\n}\nexit'),
    [],
  );
  for (const source of [
    "let d = askChoice 1 s, 2 s\nlet same = d == 1000 ms\nexit",
    "let value: duration | integer = askChoice 1 s, 2000\nlet same = value == 1000 ms\nexit",
    "let value: duration | integer = askChoice 1 s, 2000\nlet same = value == 2000\nexit",
    'let answer = askChoice null\nanswer = "z"\nlet same = answer == "z"\nexit',
    "let n = askChoice 1, 2\nlet negative = -n\nlet same = negative == -1\nexit",
    'let n = askChoice 1.0, 1.5\nlet items = ["zero", "one"]\nif n is integer {\n    say items[n]\n}\nexit',
  ])
    assert.deepEqual(warnings(source), [], source);
  assert.deepEqual(
    warnings(
      'let n = askChoice 1, 2\nlet items = ["a", "b", "c"]\nsay items[n]\nn = 1.5\nexit',
    ).map(([, code]) => code),
    ["TSV043"],
  );
  // The warning does not change what runs.
  const plan = compileSource(
    'let answer = askChoice "spank", "lines"\nsay "${answer == "Open"}"\nexit',
  ).plan;
  assert.ok(plan !== null);
  const pending = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.deepEqual(sayTexts(select(plan, pending.snapshot, 0).finished), ["false"]);
});
