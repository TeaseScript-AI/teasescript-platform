import assert from "node:assert/strict";
import test from "node:test";

import type { Expression, Statement, TypeAnnotation } from "../src/ast.js";
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

test("parses positional, named, and positional-then-named arguments and rejects positional after named", () => {
  const result = parse(
    ["moveTo(10, 20)", "moveTo(x: 10, y: 20)", "moveTo(10, y: 20)", "moveTo(x: 10, 20)"].join("\n"),
  );

  assert.deepEqual(
    result.program.statements.map((statement) =>
      statement.kind === "expressionStatement" && statement.expression.kind === "callExpression"
        ? statement.expression.argumentStyle
        : null,
    ),
    ["positional", "named", "mixed", "mixed"],
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
    "is",
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
      assert.deepEqual(propertyPositionNames(result.program.statements[0]), [keyword], source);
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

test("parses dict literals with written, quoted, and computed keys, and reports a malformed entry", () => {
  const result = parse(
    'let toys = dict{ collar: 1, "soft cuffs": 2, [key]: 3, in: 4 }\nlet none = dict{}',
  );
  assert.deepEqual(result.diagnostics, []);
  const initializer = initializerFromResult(result);
  assert.ok(initializer.kind === "dictLiteral");
  // A written name is the key's own text, like quoted text; a computed key is any expression.
  assert.deepEqual(
    initializer.entries.map(({ key, value }) => [
      key.kind === "stringLiteral"
        ? key.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join("")
        : key.kind,
      value.kind === "numberLiteral" ? value.value : null,
    ]),
    [
      ["collar", 1],
      ["soft cuffs", 2],
      ["identifier", 3],
      ["in", 4],
    ],
  );
  for (const [source, code, message] of [
    ["let d = dict{ a: 1, }", "TSP004", "Expected a dict entry after ','."],
    ["let d = dict{ a 1 }", "TSP005", "Expected ':' after the dict key."],
    [
      "let d = dict{ 1: 2 }",
      "TSP004",
      "Expected a dict key: a name, quoted text, or [expression].",
    ],
    ["let d = dict{ [a: 1 }", "TSP017", "Expected ']' after the computed dict key."],
  ] as const) {
    const diagnostics = parse(source).diagnostics;
    assert.deepEqual(
      diagnostics.slice(0, 1).map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [[code, message]],
      source,
    );
  }
});

test("parses type names, unions, grouping, and postfix list, set, dict, and optional types in source order", () => {
  const types = [
    "number",
    "string[]",
    "string?",
    "integer set",
    "integer dict?",
    "(integer | string) dict",
    "integer[] dict",
    "integer dict[]",
    "integer | string[]",
    "(integer | string)[]",
    "integer? set",
    "integer set?",
    "integer?[]",
    "integer[]?",
    "integer[][]",
    "list | set | dict | object | null",
    "range | speaker | timer | media",
    "(integer |\n    string)?",
  ];
  const result = parse(types.map((type, index) => `let v${index}: ${type} = null`).join("\n"));

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.program.statements.map((statement) =>
      statement.kind === "letStatement" && statement.typeAnnotation !== null
        ? writtenType(statement.typeAnnotation)
        : null,
    ),
    [
      "number",
      "string[]",
      "string?",
      "integer set",
      "integer dict?",
      "(integer | string) dict",
      "integer[] dict",
      "integer dict[]",
      "(integer | string[])",
      "(integer | string)[]",
      "integer? set",
      "integer set?",
      "integer?[]",
      "integer[]?",
      "integer[][]",
      "(list | set | dict | object | null)",
      "(range | speaker | timer | media)",
      "(integer | string)?",
    ],
  );
  const signature = parse(
    "function f(p: (integer | string)[] = []): integer | null {\n    return null\n}",
  );
  assert.deepEqual(signature.diagnostics, []);
  const declaration = signature.program.statements[0];
  assert.ok(declaration?.kind === "functionDeclaration");
  assert.deepEqual(
    [declaration.parameters[0]?.typeAnnotation, declaration.returnTypeAnnotation].map((type) =>
      type === null || type === undefined ? null : writtenType(type),
    ),
    ["(integer | string)[]", "(integer | null)"],
  );
});

test("reports a missing or unknown type part at its location", () => {
  for (const [source, code, message] of [
    [
      "let x: foo = 1",
      "TSP021",
      "'foo' is not a type. Use a type such as string, integer, number, boolean, duration, or a list type such as string[].",
    ],
    ["let x: (integer = 1", "TSP017", "Expected ')' after the grouped type."],
    ["let x: integer[ = 1", "TSP017", "Expected ']' in the list type."],
    [
      "let x: integer | = 1",
      "TSP021",
      "Expected a type such as string, integer, number, boolean, duration, or a list type such as string[].",
    ],
  ] as const) {
    const diagnostic = parse(source).diagnostics[0];
    assert.deepEqual([diagnostic?.code, diagnostic?.message], [code, message], source);
  }
});

test("deeply grouped types parse without native recursion", () => {
  const depth = 20_000;
  const result = parse(`let x: ${"(".repeat(depth)}integer${")".repeat(depth)}[] = []`);
  assert.deepEqual(result.diagnostics, []);
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
  const source = 'let broken = (1 + )\nsay "recovered"\nexit';
  const result = parse(source);

  assert.deepEqual(
    [result.diagnostics[0]?.code, result.diagnostics[0]?.span.start.offset],
    ["TSP012", source.indexOf(")")],
  );
  for (const diagnostic of result.diagnostics) {
    assert.ok(diagnostic.span.end.offset <= source.indexOf("\n"), diagnostic.code);
  }
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

/** A written form of a parsed type in which parentheses show every union. */
function writtenType(type: TypeAnnotation): string {
  switch (type.kind) {
    case "namedType":
      return type.name;
    case "listType":
      return `${writtenType(type.element)}[]`;
    case "setType":
      return `${writtenType(type.element)} set`;
    case "dictType":
      return `${writtenType(type.element)} dict`;
    case "optionalType":
      return `${writtenType(type.value)}?`;
    case "unionType":
      return `(${type.members.map(writtenType).join(" | ")})`;
  }
}

type ExpressionShape = string | number | boolean | readonly ExpressionShape[];

// Compact projection: identifiers by name, literals by value, operators and postfix forms with their operands.
function expressionShape(expression: Expression): ExpressionShape {
  switch (expression.kind) {
    case "identifier":
      return expression.name;
    case "numberLiteral":
    case "booleanLiteral":
      return expression.value;
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
        ...expression.arguments.map((argument) => expressionShape(argument.value)),
      ];
    default:
      return expression.kind;
  }
}

function propertyPositionNames(statement: Statement | undefined): readonly string[] | string {
  switch (statement?.kind) {
    case "speakerDeclaration":
      return statement.properties.map((property) => property.name.name);
    case "letStatement":
      if (statement.initializer.kind === "objectLiteral") {
        return statement.initializer.properties.map((property) => property.name.name);
      }
      if (statement.initializer.kind === "propertyAccessExpression") {
        return [statement.initializer.property.name];
      }
      return statement.initializer.kind;
    case "expressionStatement":
      if (statement.expression.kind !== "callExpression") return statement.expression.kind;
      return statement.expression.arguments.map((argument) =>
        argument.kind === "namedArgument" ? argument.name.name : argument.kind,
      );
    default:
      return String(statement?.kind);
  }
}
