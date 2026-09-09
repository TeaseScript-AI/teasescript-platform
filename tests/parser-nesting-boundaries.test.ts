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
