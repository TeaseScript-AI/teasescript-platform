import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { parse } from "../src/parser.js";

test("parses functions without parameters and value or bare returns", () => {
  const source = [
    "function kneel {",
    '  say "Kneel."',
    "  return",
    "}",
    "function add(left, right) {",
    "  return left + right",
    "}",
  ].join("\n");
  const result = parse(source);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.program.statements.map((statement) => statement.kind), [
    "functionDeclaration",
    "functionDeclaration",
  ]);
  const kneel = result.program.statements[0];
  const add = result.program.statements[1];
  assert.equal(kneel?.kind, "functionDeclaration");
  assert.equal(add?.kind, "functionDeclaration");
  if (kneel?.kind !== "functionDeclaration" || add?.kind !== "functionDeclaration") return;
  assert.deepEqual(kneel.parameters, []);
  assert.equal(kneel.body.statements[1]?.kind, "returnStatement");
  assert.equal(add.parameters.length, 2);
  assert.equal(add.body.statements[0]?.kind, "returnStatement");
});

test("parses multiline defaults, named calls, and exact declaration spans", () => {
  const source = [
    "function greet(",
    "  name,",
    '  title = "pet"',
    ") {",
    "  say `Hello, ${title} ${name}.`",
    "}",
    "greet(",
    '  name: "Alex",',
    '  title: "puppy"',
    ")",
  ].join("\n");
  const result = parse(source);

  assert.deepEqual(result.diagnostics, []);
  const declaration = result.program.statements[0];
  const call = result.program.statements[1];
  assert.equal(declaration?.kind, "functionDeclaration");
  assert.equal(call?.kind, "expressionStatement");
  if (declaration?.kind !== "functionDeclaration" || call?.kind !== "expressionStatement") return;
  assert.equal(declaration.span.start.offset, 0);
  assert.equal(declaration.span.end.offset, source.indexOf("\ngreet("));
  assert.equal(declaration.parameters[1]?.defaultValue?.kind, "stringLiteral");
  assert.equal(call.expression.argumentStyle, "named");
  assert.deepEqual(
    call.expression.arguments.map((argument) =>
      argument.kind === "namedArgument" ? argument.name.name : null
    ),
    ["name", "title"],
  );
});

test("preserves return and call spans", () => {
  const source = "function add(left, right) {\n  return left + right\n}\nlet result = add(2, 3)";
  const result = parse(source);

  assert.deepEqual(result.diagnostics, []);
  const declaration = result.program.statements[0];
  const binding = result.program.statements[1];
  assert.equal(declaration?.kind, "functionDeclaration");
  assert.equal(binding?.kind, "letStatement");
  if (declaration?.kind !== "functionDeclaration" || binding?.kind !== "letStatement") return;
  const returned = declaration.body.statements[0];
  assert.equal(returned?.kind, "returnStatement");
  assert.deepEqual(
    returned?.span,
    returned?.kind === "returnStatement"
      ? {
          start: { offset: source.indexOf("return"), line: 1, column: 2 },
          end: { offset: source.indexOf("right\n" ) + 5, line: 1, column: 21 },
        }
      : null,
  );
  assert.equal(binding.initializer.kind, "callExpression");
  assert.deepEqual(
    [binding.initializer.span.start.offset, binding.initializer.span.end.offset],
    [source.lastIndexOf("add("), source.length],
  );
});

test("reports malformed parameter lists and missing function blocks precisely", () => {
  const cases = [
    ["function empty() {}", "TSP026"],
    ["function broken(first,) {}", "TSP025"],
    ["function broken(first {\n  return\n}", "TSP017"],
    ["function broken(first)", "TSP018"],
  ] as const;
  for (const [source, code] of cases) {
    const result = parse(source);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code), source);
  }
});

test("preserves typed signatures and reports the explicit unsupported subset", () => {
  const source = "function add(left: number, right: number): number { return left + right }";
  const parsed = parse(source);

  assert.deepEqual(parsed.diagnostics, []);
  const declaration = parsed.program.statements[0];
  assert.equal(declaration?.kind, "functionDeclaration");
  if (declaration?.kind !== "functionDeclaration") return;
  assert.equal(declaration.parameters[0]?.typeAnnotation?.name, "number");
  assert.equal(declaration.returnTypeAnnotation?.name, "number");
  const compiled = compileSource(source);
  assert.equal(compiled.plan, null);
  assert.deepEqual(
    compiled.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV027", "TSV027", "TSV027"],
  );
});
