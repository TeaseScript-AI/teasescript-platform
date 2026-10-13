import assert from "node:assert/strict";
import test from "node:test";

import { run } from "../src/index.js";
import { parse } from "../src/parser.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

// Inside `()`, `[]`, and object literals a line break does not end an expression (V30 §1), so a binary operator may also
// start the continued line, and the expression means what it means on one line. At top level and in a block body the
// line break ends the statement, and an operator may not start the next line.

const BREAK = "\n    ";

// The parsed program without source positions.
function shape(source: string): string {
  return JSON.stringify(parse(source).program, (key, value: unknown) =>
    /span$/iu.test(key) ? undefined : value,
  );
}

function assertParsesAsOneLine(continued: string): void {
  assert.deepEqual(parse(continued).diagnostics, [], continued);
  assert.equal(shape(continued), shape(continued.replaceAll(BREAK, " ")), continued);
}

function diagnosticCodes(source: string): string[] {
  return parse(source).diagnostics.map((diagnostic) => diagnostic.code);
}

test("every binary operator may start a continued line inside parentheses", () => {
  const operators = [
    ...["*", "/", "%", "+", "-", "..", "..=", "otherwise"],
    ...["==", "!=", "<", "<=", ">", ">=", "and", "or"],
  ];
  for (const operator of operators) assertParsesAsOneLine(`let r = (a${BREAK}${operator} b)`);
  assertParsesAsOneLine(`let r = (a${BREAK}is integer)`);
  assertParsesAsOneLine(`let r = (a${BREAK}is not string)`);
  // After a type test, which ends without an arithmetic operand.
  assertParsesAsOneLine(`let r = (a is integer${BREAK}and b)`);
});

test("an operator may start a continued line in every bracket context", () => {
  for (const source of [
    `let r = [a${BREAK}+ b]`,
    `let r = set[a${BREAK}+ b]`,
    `let r = xs[a${BREAK}+ b]`,
    `let r = max(a${BREAK}+ b, 0)`,
    `let r = f(x: a${BREAK}+ b)`,
    `function f(x: integer = a${BREAK}+ b) { }`,
    `say("Hello "${BREAK}+ name)`,
    `let r = { v: a${BREAK}+ b }`,
    `let r = dict{ v: a${BREAK}+ b }`,
    `let r = dict{ [a${BREAK}+ b]: 1 }`,
    `let r = findImages(where: "bedroom"${BREAK}and "punishment")`,
  ])
    assertParsesAsOneLine(source);
});

test("a sign that starts a continued line after a value subtracts, as on one line", () => {
  // A line break inside `[]` separates no elements: commas do (V30 §16).
  const source = `let r = [1, 2${BREAK}-3]`;
  assertParsesAsOneLine(source);
  const statement = parse(source).program.statements[0];
  assert.ok(statement?.kind === "letStatement");
  const list = statement.initializer;
  assert.ok(list.kind === "listLiteral");
  assert.deepEqual(
    list.elements.map((element) => element.kind),
    ["numberLiteral", "binaryExpression"],
  );
});

test("an operator that starts a continued line gets the errors it gets on one line", () => {
  for (const source of [
    `let r = (a < b${BREAK}< c)`,
    `let r = (a .. b${BREAK}.. c)`,
    `let r = (p${BREAK}&& q)`,
    `let r = (n${BREAK}?? 0)`,
  ]) {
    const codes = diagnosticCodes(source);
    assert.notDeepEqual(codes, [], source);
    assert.deepEqual(codes, diagnosticCodes(source.replaceAll(BREAK, " ")), source);
  }
});

test("an operator may not start a statement line, also in a block inside brackets", () => {
  for (const source of [
    `let total = score${BREAK}+ bonus`,
    `let total = score${BREAK}* bonus`,
    `if ready {\n    let total = score${BREAK}and bonus\n}`,
    `let t = (timer 5 s {\n    let total = score${BREAK}- bonus\n})`,
  ]) {
    const first = parse(source).diagnostics[0];
    assert.equal(first?.span.start.offset, source.lastIndexOf(BREAK) + BREAK.length, source);
  }
});

test("'not' negates only the value after it, so it cannot continue a value on the next line", () => {
  assert.notDeepEqual(diagnosticCodes(`let r = (p${BREAK}not q)`), []);
  assert.notDeepEqual(diagnosticCodes(`let r = [p${BREAK}not q]`), []);
});

test("operators that start continued lines inside brackets run like the one-line expressions", () => {
  const plan = compileValidPlan(
    [
      "let a = 7",
      "let b = 2",
      "let n: integer? = null",
      "let values = [",
      "    a",
      "        - b,",
      "    a",
      "        / b,",
      "    n",
      "        otherwise 3",
      "]",
      "say values.join()",
      "let checks = {",
      "    larger: a",
      "        > b",
      "        and b",
      "        >= 2",
      "}",
      "say checks.larger",
      "say max(a",
      "    % b, 0)",
      "let total = 0",
      "for i in (1",
      "    ..= 3) { total += i }",
      "say total",
      "let signs = [1, 2",
      "    -3]",
      "say signs",
      "exit",
    ].join("\n"),
  );
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { seed: 1 }));
  assert.equal(result.snapshot.status, "halted");
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["5, 3.5, 3", "true", "1", "6", "[1, -1]"],
  );
});
