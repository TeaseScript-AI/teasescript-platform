import assert from "node:assert/strict";
import test from "node:test";

import { lex } from "../src/lexer.js";
import { TokenKind, type Token } from "../src/token.js";

test("emits one EOF token for empty and horizontal-whitespace-only input", () => {
  for (const source of ["", " \t  "]) {
    const result = lex(source);

    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.tokens.length, 1);
    assert.deepEqual(result.tokens[0], {
      kind: TokenKind.EndOfFile,
      lexeme: "",
      span: span(source.length, 0, source.length, source.length, 0, source.length),
    });
  }
});

test("recognizes exact slice keywords while longer names remain identifiers", () => {
  const result = lex("speaker speakers say saying as ask exit exiting");

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tokens.map((token) => [token.kind, token.lexeme]),
    [
      [TokenKind.KeywordSpeaker, "speaker"],
      [TokenKind.Identifier, "speakers"],
      [TokenKind.KeywordSay, "say"],
      [TokenKind.Identifier, "saying"],
      [TokenKind.KeywordAs, "as"],
      [TokenKind.Identifier, "ask"],
      [TokenKind.KeywordExit, "exit"],
      [TokenKind.Identifier, "exiting"],
      [TokenKind.EndOfFile, ""],
    ],
  );
});

test("tokenizes slice punctuation and property access with exact spans", () => {
  const result = lex("speaker vera {\nname: player.alias\n}");

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tokens.map(compactToken),
    [
      ["keywordSpeaker", "speaker", [0, 0, 0, 7, 0, 7]],
      ["identifier", "vera", [8, 0, 8, 12, 0, 12]],
      ["leftBrace", "{", [13, 0, 13, 14, 0, 14]],
      ["newline", "\n", [14, 0, 14, 15, 1, 0]],
      ["identifier", "name", [15, 1, 0, 19, 1, 4]],
      ["colon", ":", [19, 1, 4, 20, 1, 5]],
      ["identifier", "player", [21, 1, 6, 27, 1, 12]],
      ["dot", ".", [27, 1, 12, 28, 1, 13]],
      ["identifier", "alias", [28, 1, 13, 33, 1, 18]],
      ["newline", "\n", [33, 1, 18, 34, 2, 0]],
      ["rightBrace", "}", [34, 2, 0, 35, 2, 1]],
      ["endOfFile", "", [35, 2, 1, 35, 2, 1]],
    ],
  );
});

test("decodes every accepted ordinary-string escape", () => {
  const source = '"Quote: \\"hello\\"; slash: \\\\; \\n\\r\\t"';
  const result = lex(source);
  const string = result.tokens[0];

  assert.deepEqual(result.diagnostics, []);
  assert.equal(string?.kind, TokenKind.StringLiteral);
  assert.equal(tokenValue(string), 'Quote: "hello"; slash: \\; \n\r\t');
  assert.deepEqual(string?.span, span(0, 0, 0, source.length, 0, source.length));
});

test("folds physical newlines and surrounding indentation inside strings", () => {
  const result = lex('"one  \r\n\t two\n  three"\nexit');

  assert.deepEqual(result.diagnostics, []);
  assert.equal(tokenValue(result.tokens[0]), "one two three");
  assert.deepEqual(result.tokens[0]?.span, span(0, 0, 0, 22, 2, 8));
  assert.deepEqual(result.tokens[1]?.span, span(22, 2, 8, 23, 3, 0));
  assert.deepEqual(result.tokens[2]?.span, span(23, 3, 0, 27, 3, 4));
});

test("emits template text and interpolation boundaries", () => {
  const result = lex("`Hello ${player.alias}.`");

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tokens.map(compactToken),
    [
      ["templateStart", "`", [0, 0, 0, 1, 0, 1]],
      ["templateText", "Hello ", [1, 0, 1, 7, 0, 7]],
      ["interpolationStart", "${", [7, 0, 7, 9, 0, 9]],
      ["identifier", "player", [9, 0, 9, 15, 0, 15]],
      ["dot", ".", [15, 0, 15, 16, 0, 16]],
      ["identifier", "alias", [16, 0, 16, 21, 0, 21]],
      ["interpolationEnd", "}", [21, 0, 21, 22, 0, 22]],
      ["templateText", ".", [22, 0, 22, 23, 0, 23]],
      ["templateEnd", "`", [23, 0, 23, 24, 0, 24]],
      ["endOfFile", "", [24, 0, 24, 24, 0, 24]],
    ],
  );
  assert.equal(tokenValue(result.tokens[1]), "Hello ");
  assert.equal(tokenValue(result.tokens[7]), ".");
});

test("decodes accepted template escapes without opening interpolation", () => {
  const result = lex("`slash \\\\ tick \\` line \\n\\r\\t literal \\${name}`");

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tokens.map((token) => token.kind),
    [
      TokenKind.TemplateStart,
      TokenKind.TemplateText,
      TokenKind.TemplateEnd,
      TokenKind.EndOfFile,
    ],
  );
  assert.equal(
    tokenValue(result.tokens[1]),
    "slash \\ tick ` line \n\r\t literal ${name}",
  );
});

test("folds physical newlines inside template text", () => {
  const result = lex("`Hello ${player.alias},  \r\n\t welcome.`");

  assert.deepEqual(result.diagnostics, []);
  assert.equal(tokenValue(result.tokens[7]), ", welcome.");
  assert.deepEqual(result.tokens[7]?.span, span(22, 0, 22, 37, 1, 10));
});

test("tracks LF and CRLF as one newline with original lexemes", () => {
  const result = lex("say\r\nexit\nsay");

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tokens.map(compactToken),
    [
      ["keywordSay", "say", [0, 0, 0, 3, 0, 3]],
      ["newline", "\r\n", [3, 0, 3, 5, 1, 0]],
      ["keywordExit", "exit", [5, 1, 0, 9, 1, 4]],
      ["newline", "\n", [9, 1, 4, 10, 2, 0]],
      ["keywordSay", "say", [10, 2, 0, 13, 2, 3]],
      ["endOfFile", "", [13, 2, 3, 13, 2, 3]],
    ],
  );
});

test("counts UTF-16 code units in offsets and columns", () => {
  const result = lex('say "é😀"\nexit');

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.tokens[1]?.span, span(4, 0, 4, 9, 0, 9));
  assert.equal(tokenValue(result.tokens[1]), "é😀");
  assert.deepEqual(result.tokens[2]?.span, span(9, 0, 9, 10, 1, 0));
});

test("diagnoses invalid characters and continues lexing", () => {
  const result = lex("😀@ say");

  assert.deepEqual(
    result.diagnostics.map(compactDiagnostic),
    [
      ["TSL001", 'Invalid character "😀".', [0, 0, 0, 2, 0, 2]],
      ["TSL001", 'Invalid character "@".', [2, 0, 2, 3, 0, 3]],
    ],
  );
  assert.deepEqual(
    result.tokens.map((token) => token.kind),
    [TokenKind.KeywordSay, TokenKind.EndOfFile],
  );
});

test("diagnoses unknown escapes precisely and recovers within strings", () => {
  const result = lex('"bad \\q still" exit');

  assert.deepEqual(result.diagnostics.map(compactDiagnostic), [
    ["TSL002", "Unknown escape sequence \\q.", [5, 0, 5, 7, 0, 7]],
  ]);
  assert.equal(tokenValue(result.tokens[0]), "bad q still");
  assert.equal(result.tokens[1]?.kind, TokenKind.KeywordExit);
});

test("recovers an unknown escape before a physical newline", () => {
  const result = lex('"first\\\n  second"\nexit');

  assert.deepEqual(result.diagnostics.map(compactDiagnostic), [
    [
      "TSL002",
      "Unknown escape sequence before a physical newline.",
      [6, 0, 6, 7, 0, 7],
    ],
  ]);
  assert.equal(tokenValue(result.tokens[0]), "first second");
  assert.deepEqual(result.tokens[1]?.span, span(17, 1, 9, 18, 2, 0));
});

test("diagnoses unterminated ordinary strings with exact spans", () => {
  const result = lex('say "unfinished');

  assert.deepEqual(result.diagnostics.map(compactDiagnostic), [
    ["TSL003", "Unterminated string literal.", [4, 0, 4, 15, 0, 15]],
  ]);
  assert.equal(result.tokens[1]?.kind, TokenKind.StringLiteral);
  assert.equal(result.tokens.at(-1)?.kind, TokenKind.EndOfFile);
});

test("diagnoses unterminated templates without duplicate EOF tokens", () => {
  const result = lex("`unfinished");

  assert.deepEqual(result.diagnostics.map(compactDiagnostic), [
    ["TSL004", "Unterminated template string.", [0, 0, 0, 11, 0, 11]],
  ]);
  assert.deepEqual(
    result.tokens.map((token) => token.kind),
    [TokenKind.TemplateStart, TokenKind.TemplateText, TokenKind.EndOfFile],
  );
});

test("recovers an unterminated interpolation at the template boundary", () => {
  const result = lex("`before ${player.alias`\nexit");

  assert.deepEqual(result.diagnostics.map(compactDiagnostic), [
    [
      "TSL005",
      "Unterminated template interpolation.",
      [8, 0, 8, 22, 0, 22],
    ],
  ]);
  assert.deepEqual(
    result.tokens.map((token) => token.kind),
    [
      TokenKind.TemplateStart,
      TokenKind.TemplateText,
      TokenKind.InterpolationStart,
      TokenKind.Identifier,
      TokenKind.Dot,
      TokenKind.Identifier,
      TokenKind.TemplateEnd,
      TokenKind.Newline,
      TokenKind.KeywordExit,
      TokenKind.EndOfFile,
    ],
  );
});

test("reports only the interpolation error when interpolation reaches EOF", () => {
  const result = lex("`before ${player.alias");

  assert.deepEqual(result.diagnostics.map(compactDiagnostic), [
    [
      "TSL005",
      "Unterminated template interpolation.",
      [8, 0, 8, 22, 0, 22],
    ],
  ]);
  assert.equal(
    result.tokens.filter((token) => token.kind === TokenKind.EndOfFile).length,
    1,
  );
});

function span(
  startOffset: number,
  startLine: number,
  startColumn: number,
  endOffset: number,
  endLine: number,
  endColumn: number,
): object {
  return {
    start: { offset: startOffset, line: startLine, column: startColumn },
    end: { offset: endOffset, line: endLine, column: endColumn },
  };
}

function compactToken(
  token: Token,
): [string, string, [number, number, number, number, number, number]] {
  return [
    token.kind,
    token.lexeme,
    [
      token.span.start.offset,
      token.span.start.line,
      token.span.start.column,
      token.span.end.offset,
      token.span.end.line,
      token.span.end.column,
    ],
  ];
}

function compactDiagnostic(
  diagnostic: ReturnType<typeof lex>["diagnostics"][number],
): [string, string, [number, number, number, number, number, number]] {
  return [
    diagnostic.code,
    diagnostic.message,
    [
      diagnostic.span.start.offset,
      diagnostic.span.start.line,
      diagnostic.span.start.column,
      diagnostic.span.end.offset,
      diagnostic.span.end.line,
      diagnostic.span.end.column,
    ],
  ];
}

function tokenValue(token: Token | undefined): string | undefined {
  return token !== undefined && "value" in token ? token.value : undefined;
}
