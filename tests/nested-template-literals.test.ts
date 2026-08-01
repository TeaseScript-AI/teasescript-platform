import assert from "node:assert/strict";
import test from "node:test";

import { lex } from "../src/lexer.js";
import { parse } from "../src/parser.js";
import { compileSource, createFreshRuntimeSnapshot, run } from "../src/index.js";
import { TokenKind } from "../src/token.js";

const nestedSource = "say `Outer: ${`Hello ${name}`}`";

test("lexes nested templates and interpolations with exact spans", () => {
  const result = lex(nestedSource);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tokens.map((token) => [
      token.kind,
      token.span.start.offset,
      token.span.end.offset,
    ]),
    [
      [TokenKind.KeywordSay, 0, 3],
      [TokenKind.TemplateStart, 4, 5],
      [TokenKind.TemplateText, 5, 12],
      [TokenKind.InterpolationStart, 12, 14],
      [TokenKind.TemplateStart, 14, 15],
      [TokenKind.TemplateText, 15, 21],
      [TokenKind.InterpolationStart, 21, 23],
      [TokenKind.Identifier, 23, 27],
      [TokenKind.InterpolationEnd, 27, 28],
      [TokenKind.TemplateEnd, 28, 29],
      [TokenKind.InterpolationEnd, 29, 30],
      [TokenKind.TemplateEnd, 30, 31],
      [TokenKind.EndOfFile, 31, 31],
    ],
  );
});

test("preserves template escapes inside a nested template", () => {
  const result = lex("say `Outer: ${`tick \\` literal \\${name}`}`");
  const textValues = result.tokens.flatMap((token) =>
    token.kind === TokenKind.TemplateText && "value" in token
      ? [token.value]
      : [],
  );

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(textValues, ["Outer: ", "tick ` literal ${name}"]);
});

test("parses nested template AST levels with exact spans", () => {
  const result = parse(nestedSource);
  const statement = result.program.statements[0];

  assert.deepEqual(result.diagnostics, []);
  assert.equal(statement?.kind, "sayStatement");
  if (
    statement?.kind !== "sayStatement" ||
    statement.value.kind !== "templateLiteral"
  ) {
    assert.fail("Expected an outer template say statement.");
  }

  const outerInterpolation = statement.value.parts[1];
  assert.equal(outerInterpolation?.kind, "templateInterpolation");
  if (outerInterpolation?.kind !== "templateInterpolation") {
    assert.fail("Expected the outer interpolation.");
  }
  assert.deepEqual(
    [outerInterpolation.span.start.offset, outerInterpolation.span.end.offset],
    [12, 30],
  );

  const innerTemplate = outerInterpolation.expression;
  assert.equal(innerTemplate.kind, "templateLiteral");
  if (innerTemplate.kind !== "templateLiteral") {
    assert.fail("Expected a nested template expression.");
  }
  assert.deepEqual(
    [innerTemplate.span.start.offset, innerTemplate.span.end.offset],
    [14, 29],
  );

  const innerInterpolation = innerTemplate.parts[1];
  assert.equal(innerInterpolation?.kind, "templateInterpolation");
  if (innerInterpolation?.kind !== "templateInterpolation") {
    assert.fail("Expected the nested interpolation.");
  }
  assert.deepEqual(
    [innerInterpolation.span.start.offset, innerInterpolation.span.end.offset],
    [21, 28],
  );
});

test("evaluates interpolation inside a nested template", () => {
  const source = [
    'let name = "Vera"',
    "say `Outer: ${`Hello ${name}`}`",
  ].join("\n");
  const compiled = compileSource(source);
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  const result = run(compiled.plan!, createFreshRuntimeSnapshot(compiled.plan!));
  assert.deepEqual(
    result.events
      .filter((event) => event.kind === "say")
      .map((event) => event.text),
    ["Outer: Hello Vera"],
  );
});

test("diagnoses an unterminated nested template and outer interpolation", () => {
  const source = "say `Outer: ${`Inner";
  const result = lex(source);

  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.span.start.offset,
      diagnostic.span.end.offset,
    ]),
    [
      ["TSL004", 14, source.length],
      ["TSL005", 12, source.length],
    ],
  );
});
