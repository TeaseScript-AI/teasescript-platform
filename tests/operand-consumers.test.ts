import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

// ADR 0021 rule 1.8 (#552): an operand whose type the compiler knows, and that the operation can never take, is a
// compile error instead of a runtime failure. Each consumer is checked with the operand written as a literal, held in a
// variable, returned by a function, and read as an element or a property, against valid and unknown controls.

/** The error codes of a source with the source text each one marks. */
function errors(source: string): [string, string][] {
  return compileSource(source)
    .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => [
      diagnostic.code,
      source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
    ]);
}

/** A source that compiles and runs to its end without a failure, with what it says. */
function says(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, JSON.stringify(result.snapshot.failure));
  return sayTexts(result);
}

/** The operand sources: a statement that uses `@` becomes a program that gives `@` the value another way. */
const SOURCES: readonly ((value: string, use: string) => string)[] = [
  (value, use) => use.replaceAll("@", value),
  (value, use) => `let held = ${value}\n${use.replaceAll("@", "held")}`,
  (value, use) => `function make {\n    return ${value}\n}\n${use.replaceAll("@", "make()")}`,
  (value, use) => `let items = [${value}]\n${use.replaceAll("@", "items[0]")}`,
  (value, use) => `let box = { part: ${value} }\n${use.replaceAll("@", "box.part")}`,
];

test("built-ins with fixed arguments check their number and names", () => {
  for (const [source, code] of [
    ["say chance()", "TSV020"],
    ["say chance(1, 2)", "TSV020"],
    ["say chance(percent: 5)", "TSV022"],
    ["say randomInteger()", "TSV020"],
    ['say escapeMarkup("a", "b")', "TSV020"],
    ["say random(1)", "TSV020"],
  ] as const)
    assert.deepEqual(
      errors(source).map(([found]) => found),
      [code],
      source,
    );
  assert.equal(says('let roll = randomInteger(1..=6)\nsay "${chance(50) or roll > 0}"').length, 1);
});

test("a choice object that is not written in the option is checked by its known properties", () => {
  for (const [value, message] of [
    ["{ value: 1 }", "requires text"],
    ["{ text: [1], value: 1 }", "A list cannot be the text"],
    ['{ text: "A", value: [1] }', "A choice value must be"],
    ['{ text: "A", extra: 1 }', "value, text, and background only"],
  ] as const)
    for (const source of SOURCES.slice(1).map((wrap) => wrap(value, "let answer = choose @"))) {
      const diagnostics = compileSource(source).diagnostics;
      assert.ok(
        diagnostics.some((diagnostic) => diagnostic.message.includes(message)),
        `${source}\n${JSON.stringify(diagnostics)}`,
      );
    }
  assert.deepEqual(
    errors('let option = { text: "A", value: 1 }\nlet answer = choose k: option').map(
      ([code]) => code,
    ),
    ["TSV029"],
  );
  // A valid computed choice object, and properties that a store adds later or may not add at all, still compile.
  for (const source of [
    'let options = [{ text: "A", value: 1 }]\nlet answer = choose options',
    'let option = { value: 1 }\ntimer async 1 s {\n    option.text = "late"\n}\nwait 2 s\nlet answer = choose option',
    'let option = { text: "A" }\nif false {\n    option.value = [1]\n}\nlet answer = choose option',
    'function pick(option = { value: 1 }) {\n    let answer = choose option\n}\npick({ text: "A", value: 1 })',
  ])
    assert.deepEqual(errors(source), [], source);
});

test("a property that a known object never gets is an error where it is read", () => {
  for (const source of SOURCES.slice(1).map((wrap) => wrap("{ a: 1 }", "say @.missing")))
    assert.deepEqual(errors(source), [["TSV043", "missing"]], source);
  // A store adds a property wherever it runs: later in a loop, in a timer block, or in a function. A parameter may
  // get an argument with more properties than its default.
  assert.deepEqual(
    says(
      'let box = { a: 1 }\nrepeat 2 {\n    if box.a > 1 {\n        say "${box.b}"\n    }\n    box.a = 2\n    box.b = 3\n}',
    ),
    ["3"],
  );
  for (const source of [
    'let box = { a: 1 }\ntimer async 1 s {\n    box.b = 2\n}\nwait 2 s\nsay "${box.b}"',
    'let box = { a: 1 }\nfunction add {\n    box.b = 2\n}\nadd()\nsay "${box.b}"',
    'function read(record = {}) {\n    return record.item\n}\nsay "${read({ item: 1 })}"',
  ])
    assert.deepEqual(errors(source), [], source);
});

test("an object that a whole store, a dict, or an unknown value reaches may lack or have properties", () => {
  // A whole object replaces the value: the properties it does not write may be missing, and the ones it adds too.
  for (const source of [
    'let option = { text: "A", value: [1] }\noption = { text: "B" }\nlet answer = choose option',
    'let option = { text: "A" }\nlet other = { text: "B", value: [1] }\nif false {\n    option = other\n}\nlet answer = choose option',
  ])
    assert.deepEqual(errors(source), [], source);
  assert.deepEqual(
    errors(
      'let option = { text: "A", value: [1] }\noption = { text: "B", value: [2] }\nlet answer = choose option',
    ).map(([code]) => code),
    ["TSV029"],
  );
  assert.deepEqual(errors("let box = { a: 1 }\nbox = { b: 2 }\nsay box.c"), [["TSV043", "c"]]);
  // A dict parameter's objects, and a place that took an unknown value before a later value decided its type, may have
  // more properties than the compiler knows.
  const dynamic = "function dynamic(value) {\n    return value\n}\n";
  for (const source of [
    'function read(table = dict{ a: {} }) {\n    say table["a"].b\n}\nread(dict{ a: { b: 1 } })',
    `${dynamic}let items = []\nitems.add(dynamic({ b: 1 }))\nif false {\n    items.add({ a: 1 })\n}\nsay items[0].b`,
    `${dynamic}let items = []\nitems.add(dynamic({ b: 1 }))\nlet copy = items\nif false {\n    copy.add({ a: 1 })\n}\nsay copy[0].b`,
    `${dynamic}let box = null\nbox = dynamic({ b: 1 })\nif false {\n    box = { a: 1 }\n}\nif box != null {\n    say box.b\n}`,
  ])
    assert.deepEqual(says(source), ["1"], source);
});

test("join checks the element type of a computed list", () => {
  for (const value of ["{ x: 1 }", "[1]"])
    for (const source of SOURCES.slice(1).map((wrap) => wrap(`[${value}]`, 'say @.join(", ")')))
      assert.deepEqual(
        errors(source).map(([code]) => code),
        ["TSV043"],
        source,
      );
  assert.deepEqual(says('let names = ["a", "b"]\nsay names.join(", ")'), ["a, b"]);
});

test("a speaker's defaultSaySkippable is true or false where it is declared or set", () => {
  // A null element or property is a slot that a later value decides, so it is not known to be null (rule 1.4).
  for (const [value, wraps] of [
    ["1", SOURCES],
    ['"no"', SOURCES],
    ["[true]", SOURCES],
    ["null", SOURCES.slice(0, 3)],
  ] as const)
    for (const wrap of wraps) {
      const set = wrap(value, 'speaker guide { firstName: "a" }\nguide.defaultSaySkippable = @');
      assert.equal(errors(set)[0]?.[0], "TSV043", set);
      const declared = wrap(
        value,
        "let flag = @\nspeaker guide {\n    defaultSaySkippable: flag\n}",
      );
      assert.equal(errors(declared)[0]?.[0], "TSV043", declared);
    }
  assert.deepEqual(
    says(
      'speaker guide {\n    defaultSaySkippable: true\n}\nguide.defaultSaySkippable = false\nsay as guide "hi"',
    ),
    ["hi"],
  );
  // A value the compiler cannot know is checked when the script runs.
  const plan = compileSource("speaker guide {\n    defaultSaySkippable: flag\n}", {
    globals: ["flag"],
  }).plan;
  assert.notEqual(plan, null);
});

test("null beside an operand of unknown type is an impossible operand", () => {
  for (const [source, code] of [
    ["function f(other) {\n    say null + other\n}\nf(1)", "TSV043"],
    ["function f(other) {\n    say null < other\n}\nf(1)", "TSV043"],
    ["function f(other) {\n    let total = null\n    total += other\n}\nf(1)", "TSV041"],
  ] as const)
    assert.deepEqual(
      errors(source).map(([found]) => found),
      [code],
      source,
    );
  assert.deepEqual(says("function f(other) {\n    say 1 + other\n}\nf(2)"), ["3"]);
});

test("a set operation's argument that may be null names the check", () => {
  const maybe = "function others: integer[]? {\n    return [2]\n}\nlet other = others()\n";
  assert.deepEqual(errors(`${maybe}say [1].union(other)`), [["TSV043", "other"]]);
  assert.deepEqual(says(`${maybe}if other != null {\n    say [1].union(other)\n}`), ["[1, 2]"]);
});

test("on a union with a dict, contains and remove take a text key", () => {
  for (const method of ["contains", "remove"])
    assert.deepEqual(
      errors(`function f(value: string[] | integer dict) {\n    say value.${method}(1)\n}`),
      [["TSV043", "1"]],
      method,
    );
  assert.deepEqual(
    errors('function f(value: string[] | integer dict) {\n    say value.contains("a")\n}'),
    [],
  );
});
