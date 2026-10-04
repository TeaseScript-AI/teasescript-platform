import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";

function said(source: string): string[] {
  const result = runValidSource(source);
  assert.equal(result.snapshot.failure, null, source);
  return sayTexts(result);
}

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

/** Hides a value's type from the compiler, as host data or untyped storage would. */
const DYNAMIC = "function dynamic(value) {\n    return value\n}\n";

test("min and max pick from two or more numbers or durations", () => {
  assert.deepEqual(
    said(
      [
        "let punishments = 30",
        "let level = 12",
        'say "${min(20, 5 + punishments)} ${max(1, min(level, 10))} ${max(2, 2.5)} ${min(3, -1, 7, 0)}"',
        'say "${max(1 min, 90 s)} ${min(1 min, 90 s, 45 s)} ${min(-0, 0)}"',
      ].join("\n"),
    ),
    ["20 10 2.5 -1", "1 min 30 s 45 s 0"],
  );
});

test("min and max of integers are integers, otherwise numbers, and of durations durations", () => {
  assert.deepEqual(
    diagnostics(
      [
        "let whole: integer = max(1, min(4, 10))",
        "let fraction: number = min(1, 2.5)",
        "let pause: duration = max(1 s, 2 s)",
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(diagnostics("let whole: integer = max(1, 2.5)"), [
    [
      "TSV041",
      "'whole' is declared as integer, so it cannot start as a number. Round it with floor(...), round(...), or ceil(...), or declare it as 'let whole: number = ...'.",
      "max(1, 2.5)",
    ],
  ]);
});

test("misuse the compiler can see is a compile error", () => {
  const cases: [string, string, string, string][] = [
    ["say min(1)", "TSV020", "min(...) takes 2 or more arguments, received 1.", "min(1)"],
    [
      "say max(1, 2 s)",
      "TSV043",
      "max(...) needs all numbers or all durations, but this is a duration and an earlier one is a number.",
      "2 s",
    ],
    ['say min(1, "2")', "TSV043", "min(...) needs numbers or durations, not text (string).", '"2"'],
    ["say max(null, 1)", "TSV043", "max(...) needs numbers or durations, not null.", "null"],
    ["say min(1, 2, to: 3)", "TSV022", "min(...) takes no named arguments; remove 'to:'.", "to"],
    [
      "let max = 10",
      "TSV001",
      "Declaration 'max' conflicts with a protected TeaseScript name. Choose another name, such as 'maxValue'.",
      "max",
    ],
  ];
  for (const [source, code, message, text] of cases)
    assert.deepEqual(diagnostics(source), [[code, message, text]], source);
});

test("values the compiler cannot know are checked at runtime", () => {
  const cases: [string, string][] = [
    [
      `${DYNAMIC}say max(dynamic(1), dynamic(2 s))`,
      "max(...) needs all numbers or all durations, not a mix of both.",
    ],
    [
      `${DYNAMIC}say min(dynamic("1"), 2)`,
      "min(...) needs numbers or durations, not text (string).",
    ],
  ];
  for (const [source, message] of cases) {
    const result = runValidSource(source);
    assert.deepEqual(
      [result.snapshot.failure?.code, result.snapshot.failure?.message],
      ["TSR059", message],
      source,
    );
  }
});
