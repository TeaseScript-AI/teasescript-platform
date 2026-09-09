import assert from "node:assert/strict";
import test from "node:test";

import { lex } from "../src/lexer.js";
import { TokenKind, type Token } from "../src/token.js";

test("emits one EOF token for empty and horizontal-whitespace-only input", () => {
  for (const source of ["", " \t  "]) {
    const result = lex(source);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.tokens, [
      {
        kind: TokenKind.EndOfFile,
        lexeme: "",
        span: {
          start: { offset: source.length, line: 0, column: source.length },
          end: { offset: source.length, line: 0, column: source.length },
        },
      },
    ]);
  }
});

test("recognizes exact keywords while longer names remain identifiers", () => {
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

test("recognizes keywords and punctuation with exact source spans", () => {
  const source = "speaker vera {\nname: player.alias\n}";
  const result = lex(source);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.tokens.map(compactToken), [
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
  ]);
});

test("uses one segmented token family for quoted strings and interpolation", () => {
  const source = '"Hello ${player.alias}."';
  const result = lex(source);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.tokens.map(compactToken), [
    ["stringStart", '"', [0, 0, 0, 1, 0, 1]],
    ["stringText", "Hello ", [1, 0, 1, 7, 0, 7]],
    ["interpolationStart", "${", [7, 0, 7, 9, 0, 9]],
    ["identifier", "player", [9, 0, 9, 15, 0, 15]],
    ["dot", ".", [15, 0, 15, 16, 0, 16]],
    ["identifier", "alias", [16, 0, 16, 21, 0, 21]],
    ["interpolationEnd", "}", [21, 0, 21, 22, 0, 22]],
    ["stringText", ".", [22, 0, 22, 23, 0, 23]],
    ["stringEnd", '"', [23, 0, 23, 24, 0, 24]],
    ["endOfFile", "", [24, 0, 24, 24, 0, 24]],
  ]);
});

test("decodes the shared escape set and literal interpolation opener", () => {
  const source = '"Quote: \\"hello\\"; slash: \\\\; \\n\\r\\t; literal \\${name}; `"';
  const result = lex(source);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(
    tokenValue(result.tokens[1]),
    'Quote: "hello"; slash: \\; \n\r\t; literal ${name}; `',
  );
});

test("normalizes and dedents LF and CRLF block strings", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = [
      '"""',
      "    First.",
      "    ",
      "        Intentionally indented.",
      "    Third.",
      '"""',
    ].join(newline);
    const result = lex(source);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(stringText(result.tokens), "First.\n\n    Intentionally indented.\nThird.");
  }
});

test("defines block edge trimming, empty blocks, and trailing newlines", () => {
  const cases = [
    ['""""""', ""],
    ['"""\n"""', ""],
    ['"""text"""', "text"],
    ['"""\n  text\n\n"""', "text\n"],
    ['"""  \n  text"""', "\ntext"],
  ] as const;
  for (const [source, expected] of cases) {
    const result = lex(source);
    assert.deepEqual(result.diagnostics, [], source);
    assert.equal(stringText(result.tokens), expected, source);
  }
});

test("dedents across interpolation while preserving deeper indentation and escape newlines", () => {
  const source = '"""\n    before ${name}\n        after\\n  escaped\n    end\n"""';
  const result = lex(source);
  assert.deepEqual(result.diagnostics, []);
  const values = result.tokens.flatMap((token) =>
    token.kind === TokenKind.StringText ? [token.value] : [],
  );
  assert.deepEqual(values, ["before ", "\n    after\n  escaped\nend"]);
});

test("allows quote runs and Markdown backticks inside blocks", () => {
  const source = '"""one " two "" three \\""" and ```code```"""';
  const result = lex(source);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(stringText(result.tokens), 'one " two "" three """ and ```code```');
});

test("rejects physical newlines anywhere inside a single-line string", () => {
  const cases = [
    '"literal\ntext"',
    '"${1 +\n2}"',
    '"${"""\nblock\n"""}"',
    '"${1 /* comment\ncontinued */}"',
  ];
  for (const source of cases) {
    const result = lex(source);
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.code === "TSL008"),
      source,
    );
  }
});

test("tracks standalone LF and CRLF outside strings", () => {
  const result = lex("say\r\nexit\nsay");
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.tokens.map(compactToken), [
    ["keywordSay", "say", [0, 0, 0, 3, 0, 3]],
    ["newline", "\r\n", [3, 0, 3, 5, 1, 0]],
    ["keywordExit", "exit", [5, 1, 0, 9, 1, 4]],
    ["newline", "\n", [9, 1, 4, 10, 2, 0]],
    ["keywordSay", "say", [10, 2, 0, 13, 2, 3]],
    ["endOfFile", "", [13, 2, 3, 13, 2, 3]],
  ]);
});

test("counts UTF-16 code units in string token offsets and columns", () => {
  const result = lex('say "é😀"\nexit');
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.tokens.slice(1, 4).map(compactToken), [
    ["stringStart", '"', [4, 0, 4, 5, 0, 5]],
    ["stringText", "é😀", [5, 0, 5, 8, 0, 8]],
    ["stringEnd", '"', [8, 0, 8, 9, 0, 9]],
  ]);
  assert.deepEqual(result.tokens[4]?.span, {
    start: { offset: 9, line: 0, column: 9 },
    end: { offset: 10, line: 1, column: 0 },
  });
});

test("diagnoses invalid characters and continues lexing", () => {
  const result = lex("😀@ say");
  assert.deepEqual(result.diagnostics.map(compactDiagnostic), [
    ["TSL001", 'Invalid character "😀".', [0, 0, 0, 2, 0, 2]],
    ["TSL001", 'Invalid character "@".', [2, 0, 2, 3, 0, 3]],
  ]);
  assert.deepEqual(
    result.tokens.map((token) => token.kind),
    [TokenKind.KeywordSay, TokenKind.EndOfFile],
  );
});

test("diagnoses unknown escapes and obsolete backticks precisely", () => {
  const unknown = lex('"bad \\q still"');
  assert.deepEqual(unknown.diagnostics.map(compactDiagnostic), [
    ["TSL002", "Unknown escape sequence \\q.", [5, 0, 5, 7, 0, 7]],
  ]);
  assert.equal(tokenValue(unknown.tokens[1]), "bad q still");
  assert.deepEqual(
    lex("`old`").diagnostics.map((diagnostic) => diagnostic.code),
    ["TSL001", "TSL001"],
  );
});

test("recovers an unknown escape before a physical newline", () => {
  const result = lex('"first\\\n  second"\nexit');
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSL002", "TSL008"],
  );
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [
      diagnostic.span.start.offset,
      diagnostic.span.end.offset,
    ]),
    [
      [6, 7],
      [7, 8],
    ],
  );
  assert.equal(stringText(result.tokens), "first\n  second");
  assert.equal(result.tokens.at(-2)?.kind, TokenKind.KeywordExit);
});

test("diagnoses unterminated ordinary, block, and interpolated strings", () => {
  const ordinary = lex('say "unfinished');
  assert.deepEqual(ordinary.diagnostics.map(compactDiagnostic), [
    ["TSL003", "Unterminated string literal.", [4, 0, 4, 15, 0, 15]],
  ]);
  assert.deepEqual(
    lex('"""unfinished').diagnostics.map((diagnostic) => diagnostic.code),
    ["TSL004"],
  );
  const interpolation = lex('"before ${value"');
  assert.deepEqual(
    interpolation.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSL005"],
  );
  assert.equal(
    interpolation.tokens.filter((token) => token.kind === TokenKind.EndOfFile).length,
    1,
  );
});

function stringText(tokens: readonly Token[]): string {
  return tokens
    .flatMap((token) => (token.kind === TokenKind.StringText ? [token.value] : []))
    .join("");
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
