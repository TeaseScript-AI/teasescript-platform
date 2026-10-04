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

test("a computed choice object's text that cannot be shown is an error", () => {
  // The object may lack any other property when the choice opens, which the runtime checks (ADR 0021 rule 1.8); a text
  // of a known type that cannot be shown fails whether it is there or missing.
  for (const source of SOURCES.slice(1).map((wrap) =>
    wrap("{ text: [1], value: 1 }", "let answer = choose @"),
  ))
    assert.ok(
      errors(source).some(([code]) => code === "TSV040"),
      `${source}\n${JSON.stringify(errors(source))}`,
    );
  assert.deepEqual(
    errors("let options = [{ text: [1], value: 1 }]\nlet answer = choose options").map(
      ([code]) => code,
    ),
    ["TSV040"],
  );
  assert.deepEqual(
    errors('let options = [{ text: "A", value: 1 }]\nlet answer = choose options'),
    [],
  );
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
