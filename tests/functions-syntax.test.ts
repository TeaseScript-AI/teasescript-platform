import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { parse } from "../src/parser.js";
import { run } from "../src/runtime/engine.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

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
  assert.deepEqual(
    result.program.statements.map((statement) => statement.kind),
    ["functionDeclaration", "functionDeclaration"],
  );
  const kneel = result.program.statements[0];
  const add = result.program.statements[1];
  assert.equal(kneel?.kind, "functionDeclaration");
  assert.equal(add?.kind, "functionDeclaration");
  if (kneel?.kind !== "functionDeclaration" || add?.kind !== "functionDeclaration") return;
  assert.deepEqual(kneel.parameters, []);
  const bareReturn = kneel.body.statements[1];
  assert.equal(bareReturn?.kind, "returnStatement");
  if (bareReturn?.kind === "returnStatement") assert.equal(bareReturn.value, null);
  assert.deepEqual(
    add.parameters.map((parameter) => parameter.name.name),
    ["left", "right"],
  );
  const valueReturn = add.body.statements[0];
  assert.equal(valueReturn?.kind, "returnStatement");
  if (valueReturn?.kind !== "returnStatement") return;
  const sum = valueReturn.value;
  assert.equal(sum?.kind, "binaryExpression");
  if (sum?.kind !== "binaryExpression") return;
  assert.deepEqual(
    [
      sum.operator,
      sum.left.kind === "identifier" && sum.left.name,
      sum.right.kind === "identifier" && sum.right.name,
    ],
    ["+", "left", "right"],
  );
});

test("parses multiline defaults, named calls, and exact declaration spans", () => {
  const source = [
    "function greet(",
    "  name,",
    '  title = "pet"',
    ") {",
    '  say "Hello, ${title} ${name}."',
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
      argument.kind === "namedArgument" ? argument.name.name : null,
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
          end: { offset: source.indexOf("right\n") + 5, line: 1, column: 21 },
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
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.code === code),
      source,
    );
  }
});

test("preserves typed signatures and never silently ignores declared types", () => {
  const source = "function add(left: number, right: number): number { return left + right }";
  const parsed = parse(source);

  assert.deepEqual(parsed.diagnostics, []);
  const declaration = parsed.program.statements[0];
  assert.equal(declaration?.kind, "functionDeclaration");
  if (declaration?.kind !== "functionDeclaration") return;
  assert.deepEqual(
    [
      ...declaration.parameters.map((parameter) => parameter.typeAnnotation),
      declaration.returnTypeAnnotation,
    ].map((annotation) => [annotation?.name, annotation?.span.start.offset]),
    [...source.matchAll(/number/gu)].map((match) => ["number", match.index]),
  );

  // Type checking is not implemented yet. Either outcome below is acceptable; running the call as if the declared
  // types were absent is not.
  const violating = "function echo(value: string): string { return value }\nsay echo(5)";
  const compiled = compileSource(violating);
  if (compiled.plan === null) {
    assert.notEqual(compiled.diagnostics.length, 0);
    for (const diagnostic of compiled.diagnostics) {
      assert.match(diagnostic.code, /^TS[LPV]\d{3}$/u);
      assert.ok(diagnostic.span.end.offset <= violating.length, diagnostic.code);
    }
  } else {
    const result = run(compiled.plan, createImmediatePacingRuntimeSnapshot(compiled.plan));
    assert.match(result.snapshot.failure?.code ?? "", /^TSR\d{3}$/u);
    assert.deepEqual(
      result.events.filter((event) => event.kind === "say"),
      [],
    );
  }
});
