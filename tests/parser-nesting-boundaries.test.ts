import assert from "node:assert/strict";
import test from "node:test";

import type { Expression } from "../src/ast.js";
import { parse } from "../src/parser.js";

test("deep malformed nesting reports the missing closer at EOF with structured recovery", () => {
  const source = `${"(".repeat(2_000)}1`;
  // Returning at all, rather than throwing a native RangeError, is the termination evidence.
  const first = parse(source);
  const second = parse(source);
  assert.deepEqual(first.diagnostics, second.diagnostics);
  const [root] = first.diagnostics;
  assert.deepEqual(
    [root?.code, root?.span.start.offset, root?.span.end.offset],
    ["TSP017", source.length, source.length],
  );
  // Secondary unwinding may improve, but must stay structured and source-associated.
  for (const diagnostic of first.diagnostics) {
    assert.match(diagnostic.code, /^TSP\d{3}$/u);
    assert.ok(diagnostic.span.start.offset <= diagnostic.span.end.offset);
    assert.ok(diagnostic.span.end.offset <= source.length);
  }
});

test("parenthesis-chain parsing preserves grouping spans and statement boundaries", () => {
  const source = "let value = ((1))\n+2";
  const parsed = parse(source);
  assert.deepEqual(
    parsed.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSP016"],
  );
  const statement = parsed.program.statements[0];
  assert.equal(statement?.kind, "letStatement");
  if (statement?.kind !== "letStatement") return;
  assert.equal(statement.initializer.kind, "parenthesizedExpression");
  assert.deepEqual(
    [statement.initializer.span.start.offset, statement.initializer.span.end.offset],
    [12, 17],
  );
  if (statement.initializer.kind !== "parenthesizedExpression") return;
  assert.equal(statement.initializer.expression.kind, "parenthesizedExpression");
  assert.deepEqual(
    [
      statement.initializer.expression.span.start.offset,
      statement.initializer.expression.span.end.offset,
    ],
    [13, 16],
  );
});

test("deep malformed collection chains recover every missing closer at EOF", () => {
  const depth = 2_000;
  const openings = Array.from({ length: depth }, (_, index) =>
    index % 2 === 0 ? "[" : "set[",
  ).join("");
  const source = `let value = ${openings}1`;
  const parsed = parse(source);
  assert.equal(parsed.diagnostics.length, depth);
  assert.ok(parsed.diagnostics.every((diagnostic) => diagnostic.code === "TSP017"));
  assert.ok(
    parsed.diagnostics.every(
      (diagnostic) =>
        diagnostic.span.start.offset === source.length &&
        diagnostic.span.end.offset === source.length,
    ),
  );
});

test("mixed collection chains preserve kinds, spans, and the following statement", () => {
  const source = "let value = [set[[1]]]\nexit";
  const parsed = parse(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(
    parsed.program.statements.map((statement) => statement.kind),
    ["letStatement", "exitStatement"],
  );
  const statement = parsed.program.statements[0];
  assert.equal(statement?.kind, "letStatement");
  if (statement?.kind !== "letStatement") return;
  const outer = statement.initializer;
  assert.equal(outer.kind, "listLiteral");
  if (outer.kind !== "listLiteral") return;
  const set = outer.elements[0];
  assert.equal(set?.kind, "setLiteral");
  if (set?.kind !== "setLiteral") return;
  const inner = set.elements[0];
  assert.equal(inner?.kind, "listLiteral");
  assert.deepEqual(
    [outer, set, inner].map((expression) =>
      expression === undefined ? null : [expression.span.start.offset, expression.span.end.offset],
    ),
    [
      [12, 22],
      [13, 21],
      [17, 20],
    ],
  );
});

test("deep collection chains retain ordinary innermost expressions", () => {
  const depth = 1_024;
  const rows: readonly (readonly [string, readonly ExpressionShape[]])[] = [
    ['"text"', [["string", "text"]]],
    ["-1", [["-", 1]]],
    ["1 + 2", [["+", 1, 2]]],
    ["sample()", [["call", "sample"]]],
    ["source[0]", [["index", "source", 0]]],
    ["{ value: 1 }", [["object", ["value", 1]]]],
    ["1, 2", [1, 2]],
  ];
  for (const [inner, innermostElements] of rows) {
    const expression = `${"[".repeat(depth)}${inner}${"]".repeat(depth)}`;
    const source = `let value = ${expression}\nexit`;
    const parsed = parse(source);
    assert.deepEqual(parsed.diagnostics, [], expression);
    assert.deepEqual(
      parsed.program.statements.map((statement) => statement.kind),
      ["letStatement", "exitStatement"],
      expression,
    );
    const statement = parsed.program.statements[0];
    if (statement?.kind !== "letStatement") continue;
    let current = statement.initializer;
    let lists = 1;
    while (
      current.kind === "listLiteral" &&
      current.elements.length === 1 &&
      current.elements[0]!.kind === "listLiteral"
    ) {
      current = current.elements[0]!;
      lists += 1;
    }
    assert.equal(lists, depth, inner);
    assert.deepEqual(
      current.kind === "listLiteral" ? current.elements.map(expressionShape) : current.kind,
      innermostElements,
      inner,
    );
  }
});

test("sibling-nested collections do not trigger repeated chain parsing", () => {
  const depth = 96;
  let expression = "1";
  for (let index = 0; index < depth; index += 1) expression = `[[0, ${expression}]]`;
  const parsed = parse(`let value = ${expression}`);
  assert.deepEqual(parsed.diagnostics, []);

  const statement = parsed.program.statements[0];
  assert.equal(statement?.kind, "letStatement");
  if (statement?.kind !== "letStatement") return;
  let current = statement.initializer;
  let observedDepth = 0;
  while (current.kind === "listLiteral") {
    observedDepth += 1;
    const next = current.elements.at(-1);
    if (next === undefined) break;
    current = next;
  }
  assert.equal(observedDepth, depth * 2);
});

test("malformed sibling-nested collections do not retry failed chain parsing", () => {
  const depth = 96;
  let expression = "value[]";
  for (let index = 0; index < depth; index += 1) expression = `[[0, ${expression}]]`;
  const parsed = parse(`let value = ${expression}`);
  assert.deepEqual(
    parsed.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSP012", "TSP002"],
  );
});

type ExpressionShape = string | number | readonly ExpressionShape[];

// Compact projection: identifiers by name, literals by value, operators and postfix forms with their operands.
function expressionShape(expression: Expression): ExpressionShape {
  switch (expression.kind) {
    case "identifier":
      return expression.name;
    case "numberLiteral":
      return expression.value;
    case "stringLiteral":
      return [
        "string",
        ...expression.parts.map((part) => (part.kind === "stringText" ? part.value : part.kind)),
      ];
    case "unaryExpression":
      return [expression.operator, expressionShape(expression.operand)];
    case "binaryExpression":
      return [
        expression.operator,
        expressionShape(expression.left),
        expressionShape(expression.right),
      ];
    case "callExpression":
      return [
        "call",
        expressionShape(expression.callee),
        ...expression.arguments.map((argument) => expressionShape(argument.value)),
      ];
    case "indexExpression":
      return ["index", expressionShape(expression.object), expressionShape(expression.index)];
    case "objectLiteral":
      return [
        "object",
        ...expression.properties.map((property): ExpressionShape => [
          property.name.name,
          expressionShape(property.value),
        ]),
      ];
    default:
      return expression.kind;
  }
}
