import assert from "node:assert/strict";
import test from "node:test";

import type { Expression, Statement } from "../src/ast.js";
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
  const result = parse(["let yes = true", "let no = false", "let missing = null"].join("\n"));

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.program.statements.map((statement) => {
      if (statement.kind !== "letStatement") return null;
      const initializer = statement.initializer;
      if (initializer.kind !== "booleanLiteral" && initializer.kind !== "nullLiteral") {
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
  assert.deepEqual(
    expressionShape(initializerOf("let result = 1 + 2 * 3 == 7 and not false or false")),
    ["or", ["and", ["==", ["+", 1, ["*", 2, 3]], 7], ["not", false]], false],
  );
  assert.deepEqual(expressionShape(initializerOf("let result = not score == 5")), [
    "not",
    ["==", "score", 5],
  ]);
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
  assert.deepEqual(expressionShape(initializerOf("let result = player.toys[0].name.trim()")), [
    "call",
    [".", [".", ["index", [".", "player", "toys"], 0], "name"], "trim"],
  ]);
});

test("parses positional and named arguments and rejects mixing", () => {
  const result = parse(["moveTo(10, 20)", "moveTo(x: 10, y: 20)", "moveTo(10, y: 20)"].join("\n"));

  assert.deepEqual(
    result.program.statements.map((statement) =>
      statement.kind === "expressionStatement" ? statement.expression.argumentStyle : null,
    ),
    ["positional", "named", "named"],
  );
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSP019"],
  );
});

test("accepts every keyword as a property name in unambiguous property positions", () => {
  const keywords = [
    "speaker",
    "say",
    "wait",
    "as",
    "exit",
    "let",
    "if",
    "else",
    "true",
    "false",
    "null",
    "not",
    "and",
    "or",
    "set",
    "repeat",
    "for",
    "in",
    "while",
    "break",
    "continue",
    "function",
    "return",
  ];

  for (const keyword of keywords) {
    const sources = [
      `speaker vera { ${keyword}: "value" }`,
      `let object = { ${keyword}: 1 }`,
      `let property = object.${keyword}`,
      `invoke(${keyword}: 1)`,
    ];
    for (const source of sources) {
      const result = parse(source);
      assert.deepEqual(result.diagnostics, [], source);
      assert.equal(propertyPositionName(result.program.statements[0]), keyword, source);
    }
  }
});

test("parses list, object, and set literals", () => {
  const result = parse('let value = { items: ["key", 2], unique: set[1, 2, 2] }');

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
      const annotation = statement.kind === "letStatement" ? statement.typeAnnotation : null;
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
  const result = parse(["score = 20", "door.locked = false", 'items[0] = "key"'].join("\n"));

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

function propertyPositionName(statement: Statement | undefined): string | null {
  if (statement?.kind === "speakerDeclaration") return statement.properties[0]?.name.name ?? null;
  if (statement?.kind === "expressionStatement") {
    const argument = statement.expression.arguments[0];
    return argument?.kind === "namedArgument" ? argument.name.name : null;
  }
  if (statement?.kind !== "letStatement") return null;
  const initializer = statement.initializer;
  if (initializer.kind === "objectLiteral") return initializer.properties[0]?.name.name ?? null;
  return initializer.kind === "propertyAccessExpression" ? initializer.property.name : null;
}

type ExpressionShape = string | number | boolean | readonly ExpressionShape[];

/** Projects the expression forms used by the precedence and postfix fixtures. */
function expressionShape(expression: Expression): ExpressionShape {
  switch (expression.kind) {
    case "numberLiteral":
    case "booleanLiteral":
      return expression.value;
    case "identifier":
      return expression.name;
    case "unaryExpression":
      return [expression.operator, expressionShape(expression.operand)];
    case "binaryExpression":
      return [
        expression.operator,
        expressionShape(expression.left),
        expressionShape(expression.right),
      ];
    case "propertyAccessExpression":
      return [".", expressionShape(expression.object), expression.property.name];
    case "indexExpression":
      return ["index", expressionShape(expression.object), expressionShape(expression.index)];
    case "callExpression":
      return [
        "call",
        expressionShape(expression.callee),
        ...expression.arguments.map((argument) => argument.kind),
      ];
    default:
      return expression.kind;
  }
}

function typeShape(name: string, collection: "list" | "set" | null, optional: boolean) {
  return { name, collection, optional };
}
