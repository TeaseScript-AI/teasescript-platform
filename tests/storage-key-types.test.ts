import assert from "node:assert/strict";
import test from "node:test";

import {
  applyExternalStorageEdit,
  compileProject,
  compileSource,
  createFreshRuntimeSnapshot,
  observeTime,
  run,
  validateInstructionPlan,
  type ExpressionPlan,
  type InterpreterEvent,
  type RuntimeSnapshot,
  type SerializableRuntimeValue,
} from "../src/index.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

/*
 * Storage keys written as string literals (ADR 0021 §6, V30 §25): every load has a default and reads the stored value
 * as the declared type of the variable that receives it, or as its default's type; loads of one key agree, saves fit
 * every load, and a stored value of another type is ignored with a warning.
 */

/** The errors of a source: code, message, and the source text they point at. */
function errors(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((item) => [
    item.code,
    item.message,
    source.slice(item.span.start.offset, item.span.end.offset),
  ]);
}

function codes(source: string): string[] {
  return compileSource(source).diagnostics.map((item) => item.code);
}

function binding(snapshot: RuntimeSnapshot, name: string): SerializableRuntimeValue {
  const found = snapshot.frames[0]?.bindings.find((item) => item.name === name);
  assert.ok(found !== undefined, `binding ${name} exists`);
  return found.value;
}

function warnings(events: readonly InterpreterEvent[]): [string, string][] {
  const found: [string, string][] = [];
  for (const event of events)
    if (event.kind === "developerWarning") found.push([event.code, event.message]);
  return found;
}

test("every load needs a default, and null says the value may be missing", () => {
  assert.deepEqual(errors('let visits = load("visits")\nexit'), [
    [
      "TSV020",
      'A load needs default:, the value to use while the key has not been saved, as in load("visits", default: 0). Write default: null to check for a missing value with != null.',
      'load("visits")',
    ],
  ]);
  assert.equal(
    errors('let prefix = "a"\nlet value = load prefix + "b"\nexit')[0]?.[1],
    "A load needs default:, the value to use while the key has not been saved, as in load(key, default: 0). Write default: null to check for a missing value with != null.",
  );
  // With a declared type, a default of null makes the value optional, and a use needs a check.
  assert.deepEqual(
    errors('let visits: integer? = load("visits", default: null)\nsay visits + 1\nexit'),
    [["TSV043", "'visits' may be null. Check it first: if visits != null { ... }", "visits"]],
  );
  assert.deepEqual(
    codes(
      'let visits: integer? = load("visits", default: null)\nif visits != null { say visits + 1 }\nexit',
    ),
    [],
  );
  // A declared type that takes no null does not take a default of null either.
  assert.deepEqual(codes('let visits: integer = load("visits", default: null)\nexit'), ["TSV041"]);
  // A default of null needs a type that a load of the key declares, here or elsewhere.
  assert.deepEqual(errors('let name = load("name", default: null)\nexit'), [
    [
      "TSV041",
      `default: null needs a declared type, as in 'let value: string? = load("name", default: null)'.`,
      'load("name", default: null)',
    ],
  ]);
  assert.deepEqual(
    errors(
      'let name = load("name", default: null)\nsay name + "!"\nlet given: string = load("name", default: "")\nexit',
    ),
    [["TSV043", "'name' may be null. Check it first: if name != null { ... }", "name"]],
  );
});

test("a default that cannot be saved is a compile error", () => {
  const unsaveable =
    "Speakers, camera views, permanent buttons, and timer, media, or message handles cannot be saved.";
  assert.deepEqual(errors('let t = timer async 10 s\nlet x = load("k", default: t)\nexit'), [
    [
      "TSV043",
      `A load's default must be a value that can be saved, because 'load' gives the default in place of a saved value. This default is a timer handle. ${unsaveable} Give a default such as a number, a text, or a list of numbers or texts.`,
      "t",
    ],
  ]);
  // Also inside a list, as a button, or for a variable or key with a declared type, which reports no second error.
  for (const source of [
    'let t = timer async 10 s\nlet x = load "k", default: [t]\nexit',
    'let x = load "k", default: (showPermanentButton "Stop" { exit })\nexit',
    'let t = timer async 10 s\nlet x: integer = load "k", default: t\nexit',
    'let t = timer async 10 s\nlet x: integer = 0\nx = load "k", default: t\nexit',
    'let x: integer = load "k", default: 0\nlet t = timer async 10 s\nlet y = load "k", default: t\nexit',
  ])
    assert.deepEqual(codes(source), ["TSV043"], source);
  // A message handle gets the text to use instead, named after the variable that holds it.
  assert.match(
    errors('let greeting = say "Hi"\nlet x = load "k", default: greeting\nexit')[0]?.[1] ?? "",
    /cannot be saved\. Use the message's text instead, as in 'default: greeting\.text'\.$/u,
  );
  assert.match(
    errors('let greeting = say "Hi"\nlet x = load "k", default: [greeting]\nexit')[0]?.[1] ?? "",
    /cannot be saved\. Use the message's text instead\.$/u,
  );
  // A list of plain values, such as the options of a button, can be saved.
  assert.deepEqual(codes('let options = load "options", default: ["Yes", "No"]\nexit'), []);
});

test("a load reads the declared type of its variable, or else its default's type", () => {
  assert.deepEqual(
    codes(
      [
        'let level: integer | string = load("level", default: "1")',
        "if level is integer { say level + 1 }",
        'let visits = load("visits", default: 0)',
        "say visits + 1",
        "let assigned: number = 0",
        'assigned = load("score", default: 0)',
        'global start = load("start", default: [1])',
        "start.add(2)",
        "exit",
      ].join("\n"),
    ),
    [],
  );
  // The default's type gives the variable its type.
  assert.deepEqual(codes('let visits = load("visits", default: 0)\nvisits = "many"\nexit'), [
    "TSV041",
  ]);
  // Without a declared type, a default of a type the compiler cannot know gives a value it cannot know.
  assert.deepEqual(
    codes(
      [
        "function keep(given) {",
        '  let loaded = load("kept", default: given)',
        "  say loaded + 1",
        "}",
        "exit",
      ].join("\n"),
    ),
    [],
  );
});

test("loads of one key agree on its type, across files", () => {
  const project = compileProject([
    { path: "main.tease", source: 'let level = load("level", default: 1)\nshow()\nexit' },
    {
      path: "b.tease",
      source: 'global function show {\n  let shown = load("level", default: "high")\n}',
    },
  ]);
  assert.deepEqual(
    project.diagnostics.map((item) => [item.path, item.code, item.message]),
    [
      [
        "b.tease",
        "TSV041",
        `Storage key "level" is loaded as a whole number (integer) on line 1 of main.tease, so it cannot be loaded as text (string) here. To allow both, declare its type at one load, as in 'let value: integer | string = load(...)'.`,
      ],
    ],
  );
  // A type declared at one load is every load's type, also in another file; its defaults must fit it.
  const declared = compileProject([
    { path: "main.tease", source: 'let level = load("level", default: 1)\nshow()\nexit' },
    {
      path: "b.tease",
      source:
        'global function show {\n  let shown: integer | string = load("level", default: "high")\n  let flag = load("level", default: true)\n}',
    },
  ]);
  assert.deepEqual(
    declared.diagnostics.map((item) => [item.path, item.message]),
    [
      [
        "b.tease",
        'Storage key "level" is declared as a whole number (integer) or text (string) on line 2, so its default cannot be true or false (boolean).',
      ],
    ],
  );
  assert.deepEqual(
    errors(
      'let level: integer | string = load("level", default: 1)\nlet strict: integer = load("level", default: 0)\nexit',
    ),
    [
      [
        "TSV041",
        'Storage key "level" is declared as a whole number (integer) or text (string) on line 1, so it cannot be declared as a whole number (integer) here. Declare its type at one load only. The other loads use that type.',
        'load("level", default: 0)',
      ],
    ],
  );
  // Without a declared type, a type that accepts every value of the other agrees with it.
  assert.deepEqual(
    codes(
      [
        'let whole = load("score", default: 0)',
        'let any: number = load("score", default: 0)',
        'let mixed = load("mixed", default: [1])',
        'let numbers = load("mixed", default: [1.5])',
        "exit",
      ].join("\n"),
    ),
    [],
  );
});

test("a save fits every load of its key, and a key that is never loaded is not checked", () => {
  assert.deepEqual(errors('let level = load("level", default: 1)\nsave "high" as "level"\nexit'), [
    [
      "TSV041",
      `Storage key "level" is loaded as a whole number (integer) on line 1, so it cannot save text (string). To allow it, declare a type that includes it, as in 'let value: integer | string = load(...)'.`,
      '"high"',
    ],
  ]);
  // A declared type decides; without one, the narrowest load does: a number does not fit a load of a whole number.
  assert.deepEqual(
    errors('let any: number = load("score", default: 0)\nsave "high" as "score"\nexit')[0]?.[1],
    `Storage key "score" is declared as a number on line 1, so it cannot save text (string). To allow it, declare a type that includes it, as in 'let value: number | string = load(...)'.`,
  );
  assert.deepEqual(
    errors(
      'let any = load("score", default: 0.5)\nlet whole = load("score", default: 0)\nsave 2.5 as "score"\nexit',
    )[0]?.[1],
    `Storage key "score" is loaded as a whole number (integer) on line 2, so it cannot save a number. To allow it, declare a type that includes it, as in 'let value: number = load(...)'.`,
  );
  // A save checked before the load in checking order is checked too, and a list literal element by element.
  assert.deepEqual(
    errors('save [1, "x"] as "items"\nlet items = load("items", default: [0])\nexit')[0]?.[2],
    '"x"',
  );
  assert.deepEqual(
    codes(
      [
        'let level: integer | string = load("level", default: "1")',
        'save 5 as "level"',
        'save "expert" as "level"',
        'save null as "level"',
        'save "anything" as "never-loaded"',
        'save 5 as "never-loaded"',
        "exit",
      ].join("\n"),
    ),
    [],
  );
});

test("a key computed at runtime has no type", () => {
  assert.deepEqual(
    codes(
      [
        'let level = load("level", default: 1)',
        'let id = "a"',
        'let owned = load("toys.${id}", default: false)',
        'save "x" as "lev" + "el"',
        'let other = load("lev" + "el", default: "text")',
        "exit",
      ].join("\n"),
    ),
    [],
  );
  const compiled = plan(
    'let id = "a"\nlet owned = load("toys.${id}", default: false)\nlet count = load("count", default: 0)\nexit',
  );
  assert.deepEqual(compiled.storageTypes, [{ key: "count", type: { kind: "integer" } }]);
});

test("the plan gives each load its type and each key the type its saves fit", () => {
  const compiled = plan(
    [
      'let any: number = load("score", default: 0)',
      'let whole = load("score", default: 0)',
      'let names: string[] = load("names", default: [])',
      'let maybe: boolean? = load("maybe", default: null)',
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(compiled.storageTypes, [
    { key: "maybe", type: { kind: "boolean" } },
    { key: "names", type: { kind: "list", element: { kind: "string" } } },
    { key: "score", type: { kind: "number" } },
  ]);
  const loads: (ExpressionPlan & { kind: "storageLoad" })[] = [];
  for (const instruction of compiled.instructions)
    if (instruction.kind === "declareBinding" && instruction.value.kind === "storageLoad")
      loads.push(instruction.value);
  assert.deepEqual(
    loads.map((load) => load.type),
    [
      { kind: "number" },
      { kind: "number" },
      { kind: "list", element: { kind: "string" } },
      { kind: "boolean" },
    ],
  );
});

test("a stored value of another type is ignored with a warning, kept, and replaced only by a save", () => {
  const source = [
    'let level = load("level", default: 1)',
    'let raw: integer? = load("level", default: null)',
    'let untyped = load("le" + "vel", default: 2)',
    'save 4 as "level"',
    'let saved = load("level", default: 1)',
    "exit",
  ].join("\n");
  const result = assertRuntimeResumeEquivalent(source, {
    scriptStorage: [{ key: "level", value: "high" }],
  });
  const warning =
    'Storage key "level" is loaded as a whole number (integer) here, but the saved value is text (string). This load uses its default, and the saved value is kept.';
  // A load through a computed key has no type, so it returns the stored value as it is.
  assert.deepEqual(warnings(result.events), [
    ["TSW016", warning],
    ["TSW016", warning],
  ]);
  assert.equal(binding(result.finalSnapshot, "level"), 1);
  assert.equal(binding(result.finalSnapshot, "raw"), null);
  assert.equal(binding(result.finalSnapshot, "untyped"), "high");
  assert.equal(binding(result.finalSnapshot, "saved"), 4);
  assert.deepEqual(result.finalSnapshot.scriptStorage, [{ key: "level", value: 4 }]);

  // A global's start value is read the same way, before the story runs.
  const startValue = assertRuntimeResumeEquivalent(
    'global level = load("level", default: 1)\nexit',
    { scriptStorage: [{ key: "level", value: "high" }] },
  );
  assert.deepEqual(warnings(startValue.events), [["TSW016", warning]]);
  assert.equal(
    startValue.finalSnapshot.globals.find((global) => global.name === "level")?.value,
    1,
  );

  // Without a save, the stored value stays as it was; a nested mismatch names its place, and a union takes both.
  const kept = assertRuntimeResumeEquivalent(
    [
      'let scores = load("scores", default: [0])',
      'let level: integer | string = load("mixed", default: 0)',
      "exit",
    ].join("\n"),
    {
      scriptStorage: [
        { key: "mixed", value: "expert" },
        { key: "scores", value: { kind: "list", items: [1, "two"] } },
      ],
    },
  );
  assert.deepEqual(warnings(kept.events), [
    [
      "TSW016",
      'Storage key "scores" is loaded as a list (integer[]) here, but the saved value has text (string) at [1]. This load uses its default, and the saved value is kept.',
    ],
  ]);
  assert.deepEqual(binding(kept.finalSnapshot, "scores"), { kind: "list", items: [0] });
  assert.equal(binding(kept.finalSnapshot, "level"), "expert");
  assert.deepEqual(kept.finalSnapshot.scriptStorage, [
    { key: "mixed", value: "expert" },
    { key: "scores", value: { kind: "list", items: [1, "two"] } },
  ]);
});

test("an ignored stored value runs a waiting default after its warning, at every instruction boundary", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "let calls = 0",
      "function backup {",
      "  calls = calls + 1",
      "  wait 1 ms",
      '  return "Ada"',
      "}",
      'let name: string = load("name", default: backup())',
      'save "Bea" as "other"',
      "exit",
    ].join("\n"),
    { scriptStorage: [{ key: "name", value: 3 }] },
  );
  assert.ok(result.boundaries.some((snapshot) => snapshot.status === "waiting"));
  assert.equal(binding(result.finalSnapshot, "name"), "Ada");
  assert.equal(binding(result.finalSnapshot, "calls"), 1);
  // The warning comes before the default's wait.
  const kinds = result.events.map((event) => event.kind);
  assert.ok(kinds.indexOf("developerWarning") < kinds.indexOf("actionRequested"));
  assert.deepEqual(result.finalSnapshot.scriptStorage, [
    { key: "name", value: 3 },
    { key: "other", value: "Bea" },
  ]);
});

test("a saved value the compiler cannot know is checked against its key's type when it runs", () => {
  const failureOf = (
    source: string,
    storage: { key: string; value: SerializableRuntimeValue }[] = [],
  ) => {
    const compiled = plan(source);
    const result = run(
      compiled,
      createImmediatePacingRuntimeSnapshot(compiled, { scriptStorage: storage }),
    );
    return [result.snapshot.failure?.code, result.snapshot.failure?.message];
  };
  const misfit = [
    "TSR058",
    'Storage key "level" holds a whole number (integer), so it cannot take text (string) "x".',
  ];
  // A value of unknown type, also under a computed key that equals a key a load gives a type.
  assert.deepEqual(
    failureOf(
      'let level = load("level", default: 1)\nsave load("sou" + "rce", default: null) as "level"\nexit',
      [{ key: "source", value: "x" }],
    ),
    misfit,
  );
  assert.deepEqual(
    failureOf('let level = load("level", default: 1)\nsave "x" as "le" + "vel"\nexit'),
    misfit,
  );
});

test("a debugging edit of another type is ignored by the next load and kept", () => {
  const compiled = plan('wait 1 s\nlet count = load("count", default: 0)\nexit');
  const started = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.equal(started.snapshot.status, "waiting");
  const edited = applyExternalStorageEdit(compiled, started.snapshot, {
    key: "count",
    value: "many",
  });
  assert.equal(edited.outcome.kind, "applied");
  const observed = observeTime(compiled, edited.snapshot, 1_000);
  const finished = run(compiled, observed.snapshot);
  assert.equal(binding(finished.snapshot, "count"), 0);
  assert.deepEqual(
    warnings(finished.events).map(([code]) => code),
    ["TSW016"],
  );
  assert.deepEqual(finished.snapshot.scriptStorage, [{ key: "count", value: "many" }]);
});

test("plan validation rejects malformed storage types and load types", () => {
  const compiled = plan(
    'let b = load("b", default: 1)\nlet a = load("a", default: 2)\nlet waited: integer = load("a", default: f())\nexit\nfunction f { wait 1 ms\nreturn 1 }',
  );
  assert.equal(validateInstructionPlan(compiled).valid, true);
  const errorsOf = (changed: unknown) =>
    validateInstructionPlan(changed).errors.map((error) => [error.code, error.path]);
  const [first, second] = compiled.storageTypes;
  assert.deepEqual(errorsOf({ ...compiled, storageTypes: [second, first] }), [
    ["TSC002", "$.storageTypes[1].key"],
  ]);
  assert.deepEqual(errorsOf({ ...compiled, storageTypes: [first, first] }), [
    ["TSC002", "$.storageTypes[1].key"],
  ]);
  assert.deepEqual(
    errorsOf({ ...compiled, storageTypes: [{ key: "a", type: { kind: "whole" } }] })[0]?.[0],
    "TSC002",
  );
  assert.deepEqual(errorsOf({ ...compiled, storageTypes: [{ key: "a" }] }), [
    ["TSC002", "$.storageTypes[0]"],
  ]);
  const { storageTypes: _omitted, ...withoutTypes } = compiled;
  assert.deepEqual(errorsOf(withoutTypes), [["TSC002", "$.storageTypes"]]);
  // A load's type is a valid type or null, and the load has exactly its fields.
  const text = JSON.stringify(compiled);
  const malformed: unknown = JSON.parse(
    text.replace('"type":{"kind":"integer"}', '"type":{"kind":"whole"}'),
  );
  assert.deepEqual(errorsOf(malformed)[0]?.[0], "TSC002");
  const withoutType: unknown = JSON.parse(text.replace(',"type":{"kind":"integer"}', ""));
  assert.deepEqual(errorsOf(withoutType)[0]?.[0], "TSC002");
});

test("loaded parts that no type decided stay checked where they are used", () => {
  // Regression (#690 review): a value added to a loaded empty list decided the type of the stored elements too.
  for (const [fallback, element] of [
    ["[]", "a[0]"],
    ["set[]", "a.toList()[0]"],
  ] as const) {
    const compiled = plan(
      `let a = load("k", default: ${fallback})\na.add(1)\nlet n: integer = ${element}\nexit`,
    );
    const stored = fallback === "[]" ? "list" : "set";
    const result = run(
      compiled,
      createFreshRuntimeSnapshot(compiled, {
        scriptStorage: [{ key: "k", value: { kind: stored, items: ["bad"] } }],
      }),
    );
    assert.equal(result.snapshot.failure?.code, "TSR058", fallback);
  }
});

test("a default the compiler cannot know takes the key's declared type and is checked", () => {
  // Regression (#690 review): an unknown default dropped the type another load declares.
  const source =
    'function f(raw) {\n  let x = load("k", default: raw)\n  save x as "seen"\n}\nf("bad")\nlet declared: integer = load("k", default: 0)\nexit';
  const compiled = plan(source);
  const result = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.deepEqual(
    [result.snapshot.failure?.code, result.snapshot.failure?.message],
    [
      "TSR058",
      'Storage key "k" holds a whole number (integer) or null, so it cannot take text (string) "bad".',
    ],
  );
  assert.deepEqual(result.snapshot.scriptStorage, []);
  assert.deepEqual(
    codes(
      'function f(raw) {\n  let x = load("k", default: raw)\n  x = true\n}\nlet declared: integer = load("k", default: 0)\nexit',
    ),
    ["TSV041"],
  );
  // The same check covers a default that waits.
  const waiting = plan(
    'function slow(raw) {\n  wait 1 ms\n  return raw\n}\nfunction f(raw) {\n  let x = load("k", default: slow(raw))\n}\nf("bad")\nlet declared: integer = load("k", default: 0)\nexit',
  );
  let snapshot = run(waiting, createImmediatePacingRuntimeSnapshot(waiting)).snapshot;
  snapshot = run(waiting, observeTime(waiting, snapshot, 10).snapshot).snapshot;
  assert.equal(snapshot.failure?.code, "TSR058");
});

test("every pair of loads without a declared type agrees, not only each with the narrowest", () => {
  // Regression (#690 review): a narrower first load hid two unions that do not accept each other.
  assert.deepEqual(
    errors(
      'let base = load("k", default: 0)\nfunction f(raw: integer | string) {\n  let a = load("k", default: raw)\n}\nfunction g(raw: integer | boolean) {\n  let b = load("k", default: raw)\n}\nexit',
    ).map(([code, message]) => [code, message]),
    [
      [
        "TSV041",
        `Storage key "k" is loaded as a whole number (integer) or text (string) on line 3, so it cannot be loaded as a whole number (integer) or true or false (boolean) here. To allow both, declare its type at one load, as in 'let value: integer | string | boolean = load(...)'.`,
      ],
    ],
  );
});
