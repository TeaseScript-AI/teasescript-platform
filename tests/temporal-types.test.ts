import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

function codes(source: string): [string, string][] {
  return diagnostics(source).map(([code, , text]) => [code, text]);
}

test("timestamp is a type name for annotations and type tests, and a protected name", () => {
  assert.deepEqual(
    codes(
      [
        "function latest(moments: timestamp[], fallback: timestamp?): timestamp? {",
        "    return fallback",
        "}",
        "function kind(value: date | time | datetime | timestamp): string {",
        '    if value is timestamp { return "moment" }',
        '    return "local"',
        "}",
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(diagnostics('function f(at: timestamp) {\n    at = "2026-10-04T12:30:00Z"\n}'), [
    [
      "TSV041",
      "'at' holds a timestamp, so it cannot be set to text (string). To allow both, declare it as 'let at: timestamp | string = ...'.",
      '"2026-10-04T12:30:00Z"',
    ],
  ]);
  assert.deepEqual(codes("let timestamp = 1"), [["TSV001", "timestamp"]]);
});
