import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/index.js";
import { parse } from "../src/parser.js";

test("reports a missing speaker identifier and parses the next statement", () => {
  const source = "speaker\nexit";
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP003", "error", [7, 0, 7, 7, 0, 7]]]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("reports a missing say-as identifier without consuming the next line", () => {
  const source = 'say as "wrong"\nexit';
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP003", "error", [7, 0, 7, 7, 0, 7]]]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("reports a missing say string and recovers at LF", () => {
  const source = "say\nexit";
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP006", "error", [3, 0, 3, 3, 0, 3]]]);
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
    ["TSP004", "error", [15, 1, 0, 15, 1, 0]],
    ["TSP005", "error", [39, 2, 12, 39, 2, 12]],
    ["TSP006", "error", [57, 4, 0, 57, 4, 0]],
  ]);
  assert.deepEqual(statementKinds(result), ["speakerDeclaration", "exitStatement"]);
});

test("recovers a missing closing brace before a valid statement", () => {
  const source = ["speaker vera {", 'displayName: "Vera"', 'say "Still parsed"', "exit"].join("\n");
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP007", "error", [35, 2, 0, 35, 2, 0]]]);
  assert.deepEqual(statementKinds(result), ["speakerDeclaration", "sayStatement", "exitStatement"]);
  assert.deepEqual(result.program.statements[0]?.span, {
    start: { offset: 0, line: 0, column: 0 },
    end: { offset: 34, line: 1, column: 19 },
  });
});

test("reports a missing closing brace at EOF once", () => {
  const source = 'speaker vera {\r\n  displayName: "Vera"';
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP007", "error", [37, 1, 21, 37, 1, 21]]]);
  assert.deepEqual(statementKinds(result), ["speakerDeclaration"]);
});

test("reports an empty string interpolation and parses a later statement", () => {
  const source = 'say "Hello ${}"\r\nexit';
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP008", "error", [13, 0, 13, 13, 0, 13]]]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("rejects invalid interpolation punctuation deterministically", () => {
  const source = 'say "${player: other}"\nexit';
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP009", "error", [13, 0, 13, 14, 0, 14]]]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("reports a missing property after dot without cascading", () => {
  const source = 'say "${player.}"\nexit';
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP010", "error", [14, 0, 14, 14, 0, 14]]]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("does not duplicate lexer diagnostics for an unterminated interpolation", () => {
  const source = 'say "Hello ${player"\nexit';
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSL005", "error", [11, 0, 11, 19, 0, 19]]]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

test("an error inside an interpolation where a value is required is reported only once", () => {
  for (const [source, expected] of [
    ['let value = "${1 < 2 < 3}"\nexit', ["TSP020", "error", [21, 0, 21, 22, 0, 22]]],
    // The failed inner expression reported its own error: no generic TSP009 inside the string either.
    ['let value = "${1 +}"\nexit', ["TSP012", "error", [18, 0, 18, 18, 0, 18]]],
    // Nothing reported the failed expression, so the interpolation does.
    ['let value = "${)}"\nexit', ["TSP009", "error", [15, 0, 15, 16, 0, 16]]],
  ] as const) {
    const compilation = compileSource(source);
    assert.deepEqual(compactDiagnostics(compilation), [expected], source);
    assert.equal(compilation.plan, null, source);
    assert.deepEqual(statementKinds(parse(source)), ["exitStatement"], source);
  }
});

test("accepts physical continuation lines inside block-string interpolation", () => {
  const source = ['say """', "  ${", "    1 + 2", "  }", '"""', "exit"].join("\n");
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), []);
  assert.deepEqual(statementKinds(result), ["sayStatement", "exitStatement"]);
});

test("rejects an invalid statement shape and recovers at the next CRLF line", () => {
  const source = "unknown thing\r\nexit";
  const result = parse(source);

  assert.deepEqual(compactDiagnostics(result), [["TSP001", "error", [0, 0, 0, 7, 0, 7]]]);
  assert.deepEqual(statementKinds(result), ["exitStatement"]);
});

function compactDiagnostics(
  result: Pick<ReturnType<typeof parse>, "diagnostics">,
): Array<[string, string, [number, number, number, number, number, number]]> {
  return result.diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.severity,
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
