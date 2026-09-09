import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { lex } from "../src/lexer.js";
import { parse } from "../src/parser.js";
import { createFreshRuntimeSnapshot, run, type RuntimeBuiltinFunction } from "../src/index.js";
import { TokenKind } from "../src/token.js";

const nestedSource = 'say "Outer: ${"Hello ${name}"}"';

test("lexes nested quoted strings and interpolations with exact spans", () => {
  const result = lex(nestedSource);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tokens.map((token) => [token.kind, token.span.start.offset, token.span.end.offset]),
    [
      [TokenKind.KeywordSay, 0, 3],
      [TokenKind.StringStart, 4, 5],
      [TokenKind.StringText, 5, 12],
      [TokenKind.InterpolationStart, 12, 14],
      [TokenKind.StringStart, 14, 15],
      [TokenKind.StringText, 15, 21],
      [TokenKind.InterpolationStart, 21, 23],
      [TokenKind.Identifier, 23, 27],
      [TokenKind.InterpolationEnd, 27, 28],
      [TokenKind.StringEnd, 28, 29],
      [TokenKind.InterpolationEnd, 29, 30],
      [TokenKind.StringEnd, 30, 31],
      [TokenKind.EndOfFile, 31, 31],
    ],
  );
});

test("parses one string AST family at both nesting levels", () => {
  const result = parse(nestedSource);
  const statement = result.program.statements[0];
  assert.deepEqual(result.diagnostics, []);
  assert.equal(statement?.kind, "sayStatement");
  if (statement?.kind !== "sayStatement" || statement.value.kind !== "stringLiteral") return;
  assert.equal(statement.value.form, "singleLine");
  const outerInterpolation = statement.value.parts[1];
  assert.equal(outerInterpolation?.kind, "stringInterpolation");
  if (outerInterpolation?.kind !== "stringInterpolation") return;
  assert.deepEqual(
    [outerInterpolation.span.start.offset, outerInterpolation.span.end.offset],
    [12, 30],
  );
  assert.equal(outerInterpolation.expression.kind, "stringLiteral");
  if (outerInterpolation.expression.kind !== "stringLiteral") return;
  assert.equal(outerInterpolation.expression.form, "singleLine");
  assert.deepEqual(
    [
      outerInterpolation.expression.span.start.offset,
      outerInterpolation.expression.span.end.offset,
    ],
    [14, 29],
  );
});

test("supports a nested multiline block inside an outer block", () => {
  const source = ['say """', '  Outer: ${"""', "    Inner ${name}", '  """}', '"""'].join("\n");
  const parsed = parse(source);
  assert.deepEqual(parsed.diagnostics, []);
  const statement = parsed.program.statements[0];
  assert.equal(statement?.kind, "sayStatement");
  if (statement?.kind !== "sayStatement" || statement.value.kind !== "stringLiteral") return;
  assert.equal(statement.value.form, "block");
  const interpolation = statement.value.parts[1];
  assert.equal(interpolation?.kind, "stringInterpolation");
  if (interpolation?.kind !== "stringInterpolation") return;
  assert.equal(interpolation.expression.kind, "stringLiteral");
  if (interpolation.expression.kind !== "stringLiteral") return;
  assert.equal(interpolation.expression.form, "block");
});

test("evaluates nested interpolation in deterministic source order", () => {
  let nextValue = 0;
  const next: RuntimeBuiltinFunction = () => {
    nextValue += 1;
    return nextValue;
  };
  const source = 'say "A${"B ${next()} ${"C ${next()}"}"}"';
  const compiled = compileSource(source, { builtins: ["next"] });
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  const execution = run(compiled.plan!, createFreshRuntimeSnapshot(compiled.plan!), {
    builtins: { next },
  });
  assert.equal(nextValue, 2);
  assert.deepEqual(
    execution.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["AB 1 C 2"],
  );
});

test("keeps structured recovery at an outer quote boundary", () => {
  const source = 'say "Outer: ${value"\nexit';
  const result = lex(source);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSL005"],
  );
  assert.deepEqual(
    result.tokens.map((token) => token.kind),
    [
      TokenKind.KeywordSay,
      TokenKind.StringStart,
      TokenKind.StringText,
      TokenKind.InterpolationStart,
      TokenKind.Identifier,
      TokenKind.StringEnd,
      TokenKind.Newline,
      TokenKind.KeywordExit,
      TokenKind.EndOfFile,
    ],
  );
});

test("keeps exact ordered diagnostics for malformed nested strings", () => {
  const cases = [
    [
      "unterminated inner string",
      'say "Outer: ${"Inner',
      [
        ["TSL003", 14, 20],
        ["TSL005", 12, 20],
        ["TSL003", 4, 20],
      ],
    ],
    [
      "EOF after inner opening",
      'say "Outer: ${"',
      [
        ["TSL003", 14, 15],
        ["TSL005", 12, 15],
        ["TSL003", 4, 15],
      ],
    ],
    [
      "unterminated inner interpolation",
      'say "Outer: ${"Inner ${1',
      [
        ["TSL005", 21, 24],
        ["TSL003", 14, 24],
        ["TSL005", 12, 24],
        ["TSL003", 4, 24],
      ],
    ],
    [
      "unterminated outer interpolation",
      'say "Outer: ${value',
      [
        ["TSL005", 12, 19],
        ["TSL003", 4, 19],
      ],
    ],
  ] as const;

  for (const [name, source, expected] of cases) {
    assert.deepEqual(
      lex(source).diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.start.offset,
        diagnostic.span.end.offset,
      ]),
      expected,
      name,
    );
  }
});
