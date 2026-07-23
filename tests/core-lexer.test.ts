import assert from "node:assert/strict";
import test from "node:test";

import { lex } from "../src/lexer.js";
import { TokenKind } from "../src/token.js";

test("lexes every accepted milestone numeric form", () => {
  const source = "5 05 2.5 .5 5. 1e6 1E6 1.5e3 2e-4 .5e2 5.e1";
  const result = lex(source);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tokens
      .filter((token) => token.kind === TokenKind.NumberLiteral)
      .map((token) => [token.lexeme, "value" in token ? token.value : null]),
    [
      ["5", "5"],
      ["05", "05"],
      ["2.5", "2.5"],
      [".5", ".5"],
      ["5.", "5."],
      ["1e6", "1e6"],
      ["1E6", "1E6"],
      ["1.5e3", "1.5e3"],
      ["2e-4", "2e-4"],
      [".5e2", ".5e2"],
      ["5.e1", "5.e1"],
    ],
  );
});

test("distinguishes dots from leading-dot numbers with exact spans", () => {
  const result = lex("item.value .5");

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tokens.map((token) => [
      token.kind,
      token.lexeme,
      token.span.start.offset,
      token.span.end.offset,
    ]),
    [
      [TokenKind.Identifier, "item", 0, 4],
      [TokenKind.Dot, ".", 4, 5],
      [TokenKind.Identifier, "value", 5, 10],
      [TokenKind.NumberLiteral, ".5", 11, 13],
      [TokenKind.EndOfFile, "", 13, 13],
    ],
  );
});

test("lexes core keywords, delimiters, and operators", () => {
  const result = lex(
    "let if else true false null not and or set () [] , ? + - * / % = == != < <= > >=",
  );

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tokens.map((token) => token.kind),
    [
      TokenKind.KeywordLet,
      TokenKind.KeywordIf,
      TokenKind.KeywordElse,
      TokenKind.KeywordTrue,
      TokenKind.KeywordFalse,
      TokenKind.KeywordNull,
      TokenKind.KeywordNot,
      TokenKind.KeywordAnd,
      TokenKind.KeywordOr,
      TokenKind.KeywordSet,
      TokenKind.LeftParenthesis,
      TokenKind.RightParenthesis,
      TokenKind.LeftBracket,
      TokenKind.RightBracket,
      TokenKind.Comma,
      TokenKind.Question,
      TokenKind.Plus,
      TokenKind.Minus,
      TokenKind.Star,
      TokenKind.Slash,
      TokenKind.Percent,
      TokenKind.Equal,
      TokenKind.EqualEqual,
      TokenKind.BangEqual,
      TokenKind.Less,
      TokenKind.LessEqual,
      TokenKind.Greater,
      TokenKind.GreaterEqual,
      TokenKind.EndOfFile,
    ],
  );
});

test("diagnoses a malformed exponent and keeps a bounded numeric token", () => {
  const result = lex("1e+\nexit");

  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.span.start.offset,
      diagnostic.span.end.offset,
    ]),
    [["TSL006", 0, 3]],
  );
  assert.equal(result.tokens[0]?.lexeme, "1e+");
  assert.equal(result.tokens[2]?.kind, TokenKind.KeywordExit);
});

test("skips line and block comments", () => {
  const result = lex("let // comment\n/* block */ score");

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tokens.map((token) => token.kind),
    [
      TokenKind.KeywordLet,
      TokenKind.Newline,
      TokenKind.Identifier,
      TokenKind.EndOfFile,
    ],
  );
});
