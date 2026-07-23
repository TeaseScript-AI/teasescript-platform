import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "../src/parser.js";

test("reports a missing speaker identifier and parses the next statement", () => {
  const source = "speaker\nexit";
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [
    [
      "TSP003",
      "Expected a speaker identifier after 'speaker'.",
      [7, 0, 7, 7, 0, 7],
    ],
  ]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("reports a missing say-as identifier without consuming the next line", () => {
  const source = 'say as "wrong"\nexit';
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [
    [
      "TSP003",
      "Expected a speaker identifier after 'as'.",
      [7, 0, 7, 7, 0, 7],
    ],
  ]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("reports a missing say string and recovers at LF", () => {
  const source = "say\nexit";
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [
    [
      "TSP006",
      "Expected a string or template after 'say'.",
      [3, 0, 3, 3, 0, 3],
    ],
  ]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("reports missing property names, colons, and strings at bounded lines", () => {
  const source = [
    "speaker vera {",
    ': "no name"',
    'displayName "no colon"',
    "title:",
    "}",
    "exit",
  ].join("\n");
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [
    [
      "TSP004",
      "Expected a speaker property name.",
      [15, 1, 0, 15, 1, 0],
    ],
    [
      "TSP005",
      "Expected ':' after the speaker property name.",
      [39, 2, 12, 39, 2, 12],
    ],
    [
      "TSP006",
      "Expected a string or template for the speaker property.",
      [56, 3, 6, 56, 3, 6],
    ],
  ]);
  assert.deepEqual(statementKinds(result), [
    "speakerDeclaration",
    "exitStatement",
  ]);
});

test("recovers a missing closing brace before a valid statement", () => {
  const source = [
    "speaker vera {",
    'displayName: "Vera"',
    'say "Still parsed"',
    "exit",
  ].join("\n");
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [
    [
      "TSP007",
      "Expected '}' to close the speaker declaration.",
      [35, 2, 0, 35, 2, 0],
    ],
  ]);
  assert.deepEqual(statementKinds(result), [
    "speakerDeclaration",
    "sayStatement",
    "exitStatement",
  ]);
  assert.deepEqual(result.program.statements[0]?.span, {
    start: { offset: 0, line: 0, column: 0 },
    end: { offset: 34, line: 1, column: 19 },
  });
});

test("reports a missing closing brace at EOF once", () => {
  const source = 'speaker vera {\r\n  displayName: "Vera"';
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [
    [
      "TSP007",
      "Expected '}' to close the speaker declaration.",
      [37, 1, 21, 37, 1, 21],
    ],
  ]);
  assert.deepEqual(statementKinds(result), ["speakerDeclaration"]);
});

test("reports an empty template interpolation and parses a later statement", () => {
  const source = "say `Hello ${}`\r\nexit";
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [
    [
      "TSP008",
      "Expected an expression inside the template interpolation.",
      [13, 0, 13, 13, 0, 13],
    ],
  ]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("rejects unsupported interpolation expressions deterministically", () => {
  const source = "say `${player: other}`\nexit";
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [
    [
      "TSP009",
      "Only identifiers and chained property access are supported in template interpolation.",
      [13, 0, 13, 14, 0, 14],
    ],
  ]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("reports a missing property after dot without cascading", () => {
  const source = "say `${player.}`\nexit";
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [
    [
      "TSP010",
      "Expected a property name after '.'.",
      [14, 0, 14, 14, 0, 14],
    ],
  ]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("does not duplicate lexer diagnostics for an unterminated interpolation", () => {
  const source = "say `Hello ${player`\nexit";
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [
    [
      "TSL005",
      "Unterminated template interpolation.",
      [11, 0, 11, 19, 0, 19],
    ],
  ]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("does not add a parser cascade for an empty unterminated interpolation", () => {
  const source = "say `Hello ${`\nexit";
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [
    [
      "TSL005",
      "Unterminated template interpolation.",
      [11, 0, 11, 13, 0, 13],
    ],
  ]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("rejects a non-slice statement and recovers at the next CRLF line", () => {
  const source = "unknown thing\r\nexit";
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [
    [
      "TSP001",
      "Expected a supported TeaseScript statement.",
      [0, 0, 0, 7, 0, 7],
    ],
  ]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

function compactDiagnostics(
  result: ReturnType<typeof parse>,
): Array<
  [string, string, [number, number, number, number, number, number]]
> {
  return result.diagnostics.map((diagnostic) => [
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
  ]);
}

function statementKinds(result: ReturnType<typeof parse>): string[] {
  return result.program.statements.map((statement) => statement.kind);
}
