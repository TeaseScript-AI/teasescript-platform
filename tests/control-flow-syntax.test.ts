import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { lex } from "../src/lexer.js";
import { parse } from "../src/parser.js";
import { TokenKind } from "../src/token.js";

test("comments are whitespace across tokens, statements, blocks, LF, and CRLF", () => {
  const source = [
    "// heading\r\n",
    "let first /* between */ = 1 // after statement\n",
    "if true { /* inside\r\nblock */ say first }\n",
  ].join("");
  const result = parse(source);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.program.statements.map((statement) => statement.kind), [
    "letStatement",
    "ifStatement",
  ]);
});

test("comment markers remain ordinary string and template text", () => {
  const result = parse('say "// not a comment /* either */"\nsay `/* ${"//"} */`');

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.program.statements.length, 2);
});

test("unterminated block comments have a precise UTF-16 span", () => {
  const result = lex("😀 /* open\r\nstill");
  const diagnostic = result.diagnostics.find((item) => item.code === "TSL007");

  assert.ok(diagnostic !== undefined);
  assert.deepEqual(diagnostic.span, {
    start: { offset: 3, line: 0, column: 3 },
    end: { offset: 17, line: 1, column: 5 },
  });
});

test("multiline comments preserve exact following token spans", () => {
  const result = lex("/* first\r\nsecond */\n😀name");
  const identifier = result.tokens.find((token) => token.kind === TokenKind.Identifier);

  assert.ok(identifier !== undefined);
  assert.deepEqual(identifier.span, {
    start: { offset: 22, line: 2, column: 2 },
    end: { offset: 26, line: 2, column: 6 },
  });
});

test("ranges bind below addition and above comparisons with exact bounds", () => {
  const result = parse("let values = 1 + 2..=8 - 3 == other");

  assert.deepEqual(result.diagnostics, []);
  const statement = result.program.statements[0];
  assert.equal(statement?.kind, "letStatement");
  if (statement?.kind !== "letStatement") return;
  assert.equal(statement.initializer.kind, "binaryExpression");
  if (statement.initializer.kind !== "binaryExpression") return;
  assert.equal(statement.initializer.operator, "==");
  assert.equal(statement.initializer.left.kind, "rangeExpression");
  if (statement.initializer.left.kind !== "rangeExpression") return;
  assert.equal(statement.initializer.left.inclusive, true);
  assert.deepEqual(statement.initializer.left.span, {
    start: { offset: 13, line: 0, column: 13 },
    end: { offset: 26, line: 0, column: 26 },
  });
});

test("lexes both range operators without consuming decimal dots", () => {
  const result = lex("1..5 1..=5 1.5..2.5");

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tokens.map((token) => token.kind),
    [
      TokenKind.NumberLiteral,
      TokenKind.RangeExclusive,
      TokenKind.NumberLiteral,
      TokenKind.NumberLiteral,
      TokenKind.RangeInclusive,
      TokenKind.NumberLiteral,
      TokenKind.NumberLiteral,
      TokenKind.RangeExclusive,
      TokenKind.NumberLiteral,
      TokenKind.EndOfFile,
    ],
  );
});

test("rejects chained ranges distinctly from comparisons", () => {
  const result = parse("let bad = 1..2..3");

  assert.deepEqual(result.diagnostics.map((item) => item.code), ["TSP022"]);
  assert.equal(compileSource("let bad = 1..2..3").plan, null);
});

test("parses two-word else-if chains and every loop statement", () => {
  const result = parse([
    "if false { say \"first\" } else if true { say \"second\" } else { say \"last\" }",
    "repeat 2 { continue }",
    "for item in [1] { break }",
    "while false { break }",
  ].join("\n"));

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.program.statements.map((statement) => statement.kind), [
    "ifStatement",
    "repeatStatement",
    "forStatement",
    "whileStatement",
  ]);
  const conditional = result.program.statements[0];
  assert.equal(
    conditional?.kind === "ifStatement" ? conditional.elseBlock?.kind : null,
    "ifStatement",
  );
});

test("recovers malformed loop headers at the following statement", () => {
  const result = parse("for item [1] { say item }\nsay \"after\"");

  assert.equal(result.diagnostics[0]?.code, "TSP023");
  assert.equal(result.program.statements.at(-1)?.kind, "sayStatement");
});
