import assert from "node:assert/strict";
import test from "node:test";

import { createSourcePosition, createSourceSpan } from "../src/source.js";
import { createToken, TokenKind } from "../src/token.js";

const span = createSourceSpan(
  createSourcePosition(0, 0, 0),
  createSourcePosition(7, 0, 7),
);

test("creates immutable valued tokens", () => {
  const identifier = createToken({
    kind: TokenKind.Identifier,
    lexeme: "cashier",
    value: "cashier",
    span,
  });

  assert.deepEqual(identifier, {
    kind: "identifier",
    lexeme: "cashier",
    value: "cashier",
    span,
  });
  assert.equal(Object.isFrozen(identifier), true);
  assert.equal(Object.isFrozen(identifier.span), true);
});

test("creates immutable structural tokens without a value", () => {
  const newline = createToken({
    kind: TokenKind.Newline,
    lexeme: "\n",
    span,
  });

  assert.deepEqual(newline, {
    kind: "newline",
    lexeme: "\n",
    span,
  });
  assert.equal("value" in newline, false);
  assert.equal(Object.isFrozen(newline), true);
});

test("defines only the keywords and punctuation required by the initial slice", () => {
  assert.deepEqual(
    [
      TokenKind.KeywordSpeaker,
      TokenKind.KeywordSay,
      TokenKind.KeywordAs,
      TokenKind.KeywordExit,
    ],
    ["keywordSpeaker", "keywordSay", "keywordAs", "keywordExit"],
  );
  assert.deepEqual(
    [
      TokenKind.LeftBrace,
      TokenKind.RightBrace,
      TokenKind.Colon,
      TokenKind.Dot,
    ],
    ["leftBrace", "rightBrace", "colon", "dot"],
  );
});

test("represents strings, templates, interpolation boundaries, newlines, and EOF", () => {
  const kinds = [
    TokenKind.StringLiteral,
    TokenKind.TemplateStart,
    TokenKind.TemplateText,
    TokenKind.InterpolationStart,
    TokenKind.InterpolationEnd,
    TokenKind.TemplateEnd,
    TokenKind.Newline,
    TokenKind.EndOfFile,
  ];

  assert.deepEqual(kinds, [
    "stringLiteral",
    "templateStart",
    "templateText",
    "interpolationStart",
    "interpolationEnd",
    "templateEnd",
    "newline",
    "endOfFile",
  ]);
});
