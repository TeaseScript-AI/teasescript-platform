import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "../src/parser.js";

test("deep malformed nesting retains structured parser diagnostics", () => {
  const source = `${"(".repeat(2_000)}1`;
  const first = parse(source);
  const second = parse(source);
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.equal(first.diagnostics.length, 2_000);
  assert.equal(first.diagnostics[0]?.code, "TSP017");
  assert.ok(first.diagnostics.slice(1).every((diagnostic) => diagnostic.code === "TSP012"));
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

test("deep malformed collection chains retain ordered delimiter diagnostics", () => {
  const depth = 2_000;
  const openings = Array.from({ length: depth }, (_, index) =>
    index % 2 === 0 ? "[" : "set[",
  ).join("");
  const source = `let value = ${openings}1`;
  const parsed = parse(source);
  assert.equal(parsed.diagnostics.length, depth);
  assert.ok(parsed.diagnostics.every((diagnostic) => diagnostic.code === "TSP017"));
  assert.equal(parsed.diagnostics[0]?.message, "Expected ']' after the set literal.");
  assert.equal(parsed.diagnostics.at(-1)?.message, "Expected ']' after the list literal.");
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
  for (const inner of ['"text"', "-1", "1 + 2", "sample()", "source[0]", "{ value: 1 }", "1, 2"]) {
    const expression = `${"[".repeat(depth)}${inner}${"]".repeat(depth)}`;
    const source = `let value = ${expression}\nexit`;
    const parsed = parse(source);
    assert.deepEqual(parsed.diagnostics, [], expression);
    assert.deepEqual(
      parsed.program.statements.map((statement) => statement.kind),
      ["letStatement", "exitStatement"],
      expression,
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
