import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

// ADR 0021 rule 1.8 (#552): an operand whose type the compiler knows, and that the operation can never take, is a
// compile error instead of a runtime failure. Together the groups exercise representative operand sources, valid and
// unknown controls, and public compilation and execution.

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

/** A source that opens one choice, run to its end after its first button is selected, with what it says then. */
function saysAfterChoice(source: string): string[] {
  const plan = compileValidPlan(source);
  const pending = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  const action = pending.snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction", source);
  const completed = completeAction(plan, pending.snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "selectedOption", optionIndex: 0 },
  });
  assert.equal(completed.outcome.kind, "completed", source);
  const finished = run(plan, completed.snapshot);
  assert.equal(finished.snapshot.failure, null, JSON.stringify(finished.snapshot.failure));
  return sayTexts(finished);
}

/** The operand sources: a statement that uses `@` becomes a program that gives `@` the value another way. */
const SOURCES: readonly ((value: string, use: string) => string)[] = [
  (value, use) => `${use.replaceAll("@", value)}\nexit`,
  (value, use) => `let held = ${value}\n${use.replaceAll("@", "held")}\nexit`,
  (value, use) => `function make {\n    return ${value}\n}\n${use.replaceAll("@", "make()")}\nexit`,
  (value, use) => `let items = [${value}]\n${use.replaceAll("@", "items[0]")}\nexit`,
  (value, use) => `let box = { part: ${value} }\n${use.replaceAll("@", "box.part")}\nexit`,
];

/** The sources of {@link SOURCES} that a start value may use: a speaker is set up before the story (ADR 0022 §6). */
const START_SOURCES: readonly ((value: string, use: string) => string)[] = [
  (value, use) => use.replaceAll("@", value),
  (value, use) => `global held = ${value}\n${use.replaceAll("@", "held")}`,
  (value, use) => `global items = [${value}]\n${use.replaceAll("@", "items[0]")}`,
  (value, use) => `global box = { part: ${value} }\n${use.replaceAll("@", "box.part")}`,
];

test("built-ins with fixed arguments check their number and names", () => {
  for (const [source, code] of [
    ["say chance()\nexit", "TSV020"],
    ["say chance(1, 2)\nexit", "TSV020"],
    ["say chance(percent: 5)\nexit", "TSV022"],
    ["say randomInteger()\nexit", "TSV020"],
    ['say escapeMarkup("a", "b")\nexit', "TSV020"],
    ["say random(1)\nexit", "TSV020"],
  ] as const)
    assert.deepEqual(
      errors(source).map(([found]) => found),
      [code],
      source,
    );
  assert.equal(
    says('let roll = randomInteger(1..=6)\nsay "${chance(50) or roll > 0}"\nexit').length,
    1,
  );
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
    errors("let options = [{ text: [1], value: 1 }]\nlet answer = choose options\nexit").map(
      ([code]) => code,
    ),
    ["TSV040"],
  );
  assert.deepEqual(
    errors('let options = [{ text: "A", value: 1 }]\nlet answer = choose options\nexit'),
    [],
  );
  // A text that may still be null may give a button.
  for (const source of [
    'let options = [{ text: null }, { text: [1] }]\noptions.removeAt(1)\nlet answer = choose options\nsay "done"\nexit',
    'let option = { text: null }\nif false {\n    option.text = [1]\n}\nlet answer = choose option\nsay "done"\nexit',
  ])
    assert.deepEqual(saysAfterChoice(source), ["done"], source);
});

test("join checks the element type of a computed list", () => {
  for (const value of ["{ x: 1 }", "[1]"])
    for (const source of SOURCES.slice(1).map((wrap) => wrap(`[${value}]`, 'say @.join(", ")')))
      assert.deepEqual(
        errors(source).map(([code]) => code),
        ["TSV043"],
        source,
      );
  assert.deepEqual(says('let names = ["a", "b"]\nsay names.join(", ")\nexit'), ["a, b"]);
});

test("a speaker's defaultSaySkippable is true or false where it is declared or set", () => {
  // A null element or property is a slot that a later value decides, so it is not known to be null (rule 1.4).
  for (const [value, wraps, startWraps] of [
    ["1", SOURCES, START_SOURCES],
    ['"no"', SOURCES, START_SOURCES],
    ["[true]", SOURCES, START_SOURCES],
    ["null", SOURCES.slice(0, 3), START_SOURCES.slice(0, 2)],
  ] as const) {
    for (const wrap of wraps) {
      const set = wrap(value, 'speaker guide { firstName: "a" }\nguide.defaultSaySkippable = @');
      assert.equal(errors(set)[0]?.[0], "TSV043", set);
    }
    for (const wrap of startWraps) {
      const declared = wrap(
        value,
        "global flag = @\nspeaker guide {\n    defaultSaySkippable: flag\n}",
      );
      assert.equal(errors(declared)[0]?.[0], "TSV043", declared);
    }
  }
  assert.deepEqual(
    says(
      'speaker guide {\n    defaultSaySkippable: true\n}\nguide.defaultSaySkippable = false\nsay as guide "hi"\nexit',
    ),
    ["hi"],
  );
  // A value the compiler cannot know is checked when the script runs.
  const plan = compileSource("speaker guide {\n    defaultSaySkippable: flag\n}\nexit", {
    globals: ["flag"],
  }).plan;
  assert.notEqual(plan, null);
});

test("null beside an operand of unknown type is an impossible operand", () => {
  for (const [source, code] of [
    ["function f(other) {\n    say null + other\n}\nf(1)\nexit", "TSV043"],
    ["function f(other) {\n    say null < other\n}\nf(1)\nexit", "TSV043"],
    ["function f(other) {\n    let total = null\n    total += other\n}\nf(1)\nexit", "TSV041"],
  ] as const)
    assert.deepEqual(
      errors(source).map(([found]) => found),
      [code],
      source,
    );
  assert.deepEqual(says("function f(other) {\n    say 1 + other\n}\nf(2)\nexit"), ["3"]);
});

test("a set operation's argument that may be null names the check", () => {
  const maybe = "function others: integer[]? {\n    return [2]\n}\nlet other = others()\n";
  assert.deepEqual(errors(`${maybe}say [1].union(other)\nexit`), [["TSV043", "other"]]);
  assert.deepEqual(says(`${maybe}if other != null {\n    say [1].union(other)\n}\nexit`), [
    "[1, 2]",
  ]);
});

test("on a union with a dict, contains and remove take a text key", () => {
  for (const method of ["contains", "remove"])
    assert.deepEqual(
      errors(`function f(value: string[] | integer dict) {\n    say value.${method}(1)\n}\nexit`),
      [["TSV043", "1"]],
      method,
    );
  assert.deepEqual(
    errors('function f(value: string[] | integer dict) {\n    say value.contains("a")\n}\nexit'),
    [],
  );
});
