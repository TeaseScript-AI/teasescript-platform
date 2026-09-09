import assert from "node:assert/strict";
import test from "node:test";

import { compileSource, parse } from "../src/index.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

test("object wrapper chains preserve property and object spans and innermost siblings", () => {
  const depth = 1_024;
  const source = `let value = ${"{ default:\n".repeat(depth)}{ first: 1, second: [2] }${"\n}".repeat(depth)}\nexit`;
  const parsed = parse(source);
  assert.deepEqual(parsed.diagnostics, []);
  const statement = parsed.program.statements[0];
  assert.equal(statement?.kind, "letStatement");
  if (statement?.kind !== "letStatement") return;
  let expression = statement.initializer;
  for (let index = 0; index < depth; index += 1) {
    assert.equal(expression.kind, "objectLiteral");
    if (expression.kind !== "objectLiteral") return;
    assert.equal(expression.properties.length, 1);
    const property = expression.properties[0]!;
    assert.equal(property.name.name, "default");
    assert.equal(expression.span.start.offset, 12 + index * 11);
    assert.equal(property.span.start.offset, expression.span.start.offset + 2);
    assert.equal(property.span.end.offset, property.value.span.end.offset);
    assert.equal(expression.span.end.offset, source.length - 5 - index * 2);
    expression = property.value;
  }
  assert.equal(expression.kind, "objectLiteral");
  if (expression.kind !== "objectLiteral") return;
  assert.deepEqual(
    expression.properties.map((property) => property.name.name),
    ["first", "second"],
  );
  assert.equal(parsed.program.statements[1]?.kind, "exitStatement");
});

test("nested object evaluation retains user-call order, captured values, copies, and resume equivalence", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "let source = [1]",
      "let order = []",
      "function mark(item) { order.add(item)\nreturn item }",
      "function mutate { source.add(2)\nreturn mark(2) }",
      "let value = { before: { items: source, number: mark(1) }, after: mutate(), last: [mark(3)] }",
      "let copy = value",
      "value.before.items.add(4)",
      "say order[0]",
      "say order[1]",
      "say order[2]",
      "say copy.before.items.length",
      "say value.before.items.length",
      "say source.length",
      "exit",
    ].join("\n"),
    { scenarioName: "nested object call/copy ordering", seed: 42 },
  );
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["1", "2", "3", "1", "2", "2"],
  );
});

test("nested object semantic diagnostics retain depth-first property order", () => {
  const source = "let value = { a: { x: missing, x: absent }, a: unknown }";
  const result = compileSource(source);
  assert.equal(result.plan, null);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) =>
      source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
    ),
    ["missing", "x", "absent", "a", "unknown"],
  );
});

test("object name, colon, trailing-comma and cross-delimiter recovery keep diagnostics and following statements", () => {
  const cases = [
    { expression: "{ x: { nope } }", diagnostics: [["TSP005", 24, 24]] },
    { expression: "{ x: { : 1 } }", diagnostics: [["TSP004", 19, 19]] },
    { expression: "{ x: { y: } }", diagnostics: [["TSP012", 22, 22]] },
    { expression: "{ x: { y: 1, } }", diagnostics: [["TSP004", 25, 25]] },
    {
      expression: "{ x: { y: value[] } }",
      diagnostics: [
        ["TSP012", 28, 28],
        ["TSP017", 28, 28],
        ["TSP017", 28, 28],
        ["TSP002", 28, 28],
      ],
    },
    { expression: "{ x: { y: 1 } + 2 }", diagnostics: [] },
    { expression: "{ x: { y: 1 }, z: 2 }", diagnostics: [] },
  ];
  for (const fixture of cases) {
    const parsed = parse(`let value = ${fixture.expression}\nexit`);
    assert.deepEqual(
      parsed.diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.start.offset,
        diagnostic.span.end.offset,
      ]),
      fixture.diagnostics,
      fixture.expression,
    );
    assert.deepEqual(
      parsed.program.statements.map((statement) => statement.kind),
      ["letStatement", "exitStatement"],
    );
  }
});

test("mixed object and collection chains preserve contained malformed recovery", () => {
  const depth = 96;
  const source = `let value = ${"{ x: { y: [".repeat(depth)}{ nope }${"] } }".repeat(depth)}\nexit`;
  const parsed = parse(source);
  assert.deepEqual(
    parsed.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSP005"],
  );
  assert.equal(parsed.program.statements[1]?.kind, "exitStatement");
});

test("nested object data resumes equivalently through JSON checkpoints", () => {
  const depth = 64;
  assertRuntimeResumeEquivalent(
    `let nested = ${"{ value: ".repeat(depth)}[1]${" }".repeat(depth)}\nlet copy = nested\nexit`,
    { scenarioName: "nested object JSON checkpoint", seed: 42 },
  );
});
