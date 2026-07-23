import assert from "node:assert/strict";
import test from "node:test";

import type { Expression } from "../src/ast.js";
import { parse } from "../src/parser.js";

test("parses and normalizes all accepted milestone numeric literals", () => {
  const source = [
    "let a = 5",
    "let b = 05",
    "let c = 2.5",
    "let d = .5",
    "let e = 5.",
    "let f = 1e6",
    "let g = 2e-4",
  ].join("\n");
  const result = parse(source);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.program.statements.map((statement) => {
      assert.equal(statement.kind, "letStatement");
      if (statement.kind !== "letStatement") return null;
      assert.equal(statement.initializer.kind, "numberLiteral");
      return statement.initializer.kind === "numberLiteral"
        ? [
            statement.initializer.raw,
            statement.initializer.value,
            statement.initializer.numericType,
          ]
        : null;
    }),
    [
      ["5", 5, "integer"],
      ["05", 5, "integer"],
      ["2.5", 2.5, "number"],
      [".5", 0.5, "number"],
      ["5.", 5, "number"],
      ["1e6", 1_000_000, "number"],
      ["2e-4", 0.0002, "number"],
    ],
  );
});

test("parses true, false, and null literals", () => {
  const result = parse(
    ["let yes = true", "let no = false", "let missing = null"].join("\n"),
  );

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.program.statements.map((statement) => {
      if (statement.kind !== "letStatement") return null;
      const initializer = statement.initializer;
      if (
        initializer.kind !== "booleanLiteral" &&
        initializer.kind !== "nullLiteral"
      ) {
        return null;
      }
      return [initializer.kind, initializer.value];
    }),
    [
      ["booleanLiteral", true],
      ["booleanLiteral", false],
      ["nullLiteral", null],
    ],
  );
});

test("builds V30 precedence with comparison stronger than not", () => {
  const expression = initializerOf(
    "let result = 1 + 2 * 3 == 7 and not false or false",
  );

  assert.equal(expression.kind, "binaryExpression");
  if (expression.kind !== "binaryExpression") return;
  assert.equal(expression.operator, "or");
  assert.equal(expression.left.kind, "binaryExpression");
  if (expression.left.kind !== "binaryExpression") return;
  assert.equal(expression.left.operator, "and");
  assert.equal(expression.left.left.kind, "binaryExpression");
  assert.equal(expression.left.right.kind, "unaryExpression");

  const notComparison = initializerOf("let result = not score == 5");
  assert.equal(notComparison.kind, "unaryExpression");
  if (notComparison.kind === "unaryExpression") {
    assert.equal(notComparison.operator, "not");
    assert.equal(notComparison.operand.kind, "binaryExpression");
  }
});

test("associates arithmetic left and unary operators right", () => {
  const subtraction = initializerOf("let result = 10 - 3 - 2");
  assert.equal(subtraction.kind, "binaryExpression");
  if (subtraction.kind === "binaryExpression") {
    assert.equal(subtraction.operator, "-");
    assert.equal(subtraction.left.kind, "binaryExpression");
  }

  const unary = initializerOf("let result = --value");
  assert.equal(unary.kind, "unaryExpression");
  if (unary.kind === "unaryExpression") {
    assert.equal(unary.operand.kind, "unaryExpression");
  }
});

test("parses left-associated property, index, and call postfix operations", () => {
  const expression = initializerOf("let result = player.toys[0].name.trim()");

  assert.equal(expression.kind, "callExpression");
  if (expression.kind !== "callExpression") return;
  assert.equal(expression.callee.kind, "propertyAccessExpression");
  if (expression.callee.kind !== "propertyAccessExpression") return;
  assert.equal(expression.callee.property.name, "trim");
  assert.equal(expression.callee.object.kind, "propertyAccessExpression");
});

test("parses positional and named arguments and rejects mixing", () => {
  const result = parse(
    [
      "moveTo(10, 20)",
      "moveTo(x: 10, y: 20)",
      "moveTo(10, y: 20)",
    ].join("\n"),
  );

  assert.deepEqual(
    result.program.statements.map((statement) =>
      statement.kind === "expressionStatement"
        ? statement.expression.argumentStyle
        : null,
    ),
    ["positional", "named", "named"],
  );
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSP019"],
  );
});

test("parses list, object, and set literals", () => {
  const result = parse(
    'let value = { items: ["key", 2], unique: set[1, 2, 2] }',
  );

  assert.deepEqual(result.diagnostics, []);
  const initializer = initializerFromResult(result);
  assert.equal(initializer.kind, "objectLiteral");
  if (initializer.kind === "objectLiteral") {
    assert.equal(initializer.properties[0]?.value.kind, "listLiteral");
    assert.equal(initializer.properties[1]?.value.kind, "setLiteral");
  }
});

test("preserves scalar, list, optional, and set type annotations", () => {
  const result = parse(
    [
      "let score: number = 10",
      "let names: string[] = []",
      "let alias: string? = null",
      "let values: integer set = set[]",
    ].join("\n"),
  );

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.program.statements.map((statement) => {
      const annotation =
        statement.kind === "letStatement" ? statement.typeAnnotation : null;
      return annotation === null
        ? null
        : {
            name: annotation.name,
            collection: annotation.collection,
            optional: annotation.optional,
          };
    }),
    [
      typeShape("number", null, false),
      typeShape("string", "list", false),
      typeShape("string", null, true),
      typeShape("integer", "set", false),
    ],
  );
});

test("parses direct, property, and index assignments", () => {
  const result = parse(
    [
      "score = 20",
      "door.locked = false",
      'items[0] = "key"',
    ].join("\n"),
  );

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.program.statements.map((statement) =>
      statement.kind === "assignmentStatement" ? statement.target.kind : null,
    ),
    ["identifier", "propertyAccessExpression", "indexExpression"],
  );
});

test("parses lexical if and else blocks without consuming the next statement", () => {
  const source = [
    "if condition {",
    "  let local = 1",
    "} else {",
    "  localCall()",
    "}",
    'say "after"',
  ].join("\n");
  const result = parse(source);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.program.statements.map((statement) => statement.kind),
    ["ifStatement", "sayStatement"],
  );
  const first = result.program.statements[0];
  assert.equal(first?.kind, "ifStatement");
  if (first?.kind === "ifStatement") {
    assert.equal(first.thenBlock.kind, "block");
    assert.equal(first.elseBlock?.kind, "block");
    assert.equal(first.thenBlock.statements[0]?.kind, "letStatement");
  }
});

test("reports invalid assignment targets with an exact target span", () => {
  const result = parse("(score + 1) = 20\nexit");

  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.span.start.offset,
      diagnostic.span.end.offset,
    ]),
    [["TSP015", 0, 11]],
  );
  assert.deepEqual(
    result.program.statements.map((statement) => statement.kind),
    ["exitStatement"],
  );
});

test("bounds malformed-expression recovery at the next statement", () => {
  const result = parse('let broken = (1 + )\nsay "recovered"\nexit');

  assert.ok(result.diagnostics.length > 0);
  assert.ok(result.diagnostics.length <= 3);
  assert.deepEqual(
    result.program.statements.map((statement) => statement.kind),
    ["sayStatement", "exitStatement"],
  );
});

test("keeps set assignment-keyword syntax invalid", () => {
  const result = parse("set score = 20\nexit");

  assert.ok(result.diagnostics.length > 0);
  assert.deepEqual(
    result.program.statements.map((statement) => statement.kind),
    ["exitStatement"],
  );
});

test("does not invent trailing-comma set syntax", () => {
  const result = parse("let values = set[1,]");

  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSP012"],
  );
});

function initializerOf(source: string): Expression {
  const result = parse(source);
  assert.deepEqual(result.diagnostics, []);
  return initializerFromResult(result);
}

function initializerFromResult(result: ReturnType<typeof parse>): Expression {
  const statement = result.program.statements[0];
  assert.equal(statement?.kind, "letStatement");
  if (statement?.kind !== "letStatement") {
    throw new Error("Expected a let statement.");
  }
  return statement.initializer;
}

function typeShape(
  name: string,
  collection: "list" | "set" | null,
  optional: boolean,
): object {
  return {
    name,
    collection,
    optional,
  };
}
