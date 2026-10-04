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

test("conversions read ISO text and convert between temporal kinds", () => {
  assert.deepEqual(
    codes(
      [
        'let day: date = toDate("2026-10-04")',
        'let clock: time = toTime("14:30:15.250")',
        'let dinner: datetime = toDateTime("2026-10-04T18:00")',
        'let started: timestamp = toTimestamp("2026-10-04T14:30:00+02:00")',
        "let combined: datetime = toDateTime(day, clock)",
        "let same: date = toDate(day, default: day)",
        "let part: time = toTime(dinner)",
        'let utc: timestamp = toTimestamp("2026-10-04T12:30:00Z", default: started)',
        "function read(text: string): date {",
        "    return toDate(text)",
        "}",
      ].join("\n"),
    ),
    [],
  );
});

test("constant text that is not a valid value is a compile error, also with a default", () => {
  const cases = [
    [
      'toDate("4-10-2026")',
      'toDate(...) needs ISO date text such as "2026-10-04", not "4-10-2026".',
    ],
    [
      'toDate("2026-02-30", default: toDate("2026-01-01"))',
      'toDate(...) cannot convert "2026-02-30": February 2026 has 28 days.',
    ],
    ['toTime("2:30 PM")', 'toTime(...) needs ISO time text such as "14:30", not "2:30 PM".'],
    [
      'toDateTime("2026-10-04T18:00Z")',
      'toDateTime(...) needs local ISO date and time text without an offset, such as "2026-10-04T18:00", not "2026-10-04T18:00Z".',
    ],
    [
      'toTimestamp("2026-10-04T12:30")',
      'toTimestamp(...) needs ISO timestamp text with Z or an offset, such as "2026-10-04T12:30:00Z", not "2026-10-04T12:30".',
    ],
  ] as const;
  for (const [call, message] of cases) {
    const text = /"[^"]*"/u.exec(call)![0];
    assert.deepEqual(diagnostics(`let value = ${call}`), [["TSV043", message, text]], call);
  }
});

test("conversions report wrong arguments, argument counts, and named arguments", () => {
  assert.deepEqual(
    diagnostics(
      [
        "function check(dinner: datetime, started: timestamp) {",
        "    let a = toDate(5)",
        "    let b = toTimestamp(dinner)",
        "    let c = toDateTime(started)",
        '    let d = toDateTime("2026-10-04", toTime("18:00"))',
        '    let e = toDate("2026-10-04", default: "2026-10-04")',
        "}",
      ].join("\n"),
    ),
    [
      [
        "TSV043",
        "toDate(...) takes date text, a date, or a date and time, but this is a whole number (integer).",
        "5",
      ],
      [
        "TSV043",
        "toTimestamp(...) takes timestamp text or a timestamp, but this is a date and time. Convert it with 'dinner.toTimestamp()'.",
        "dinner",
      ],
      [
        "TSV043",
        "toDateTime(...) takes date and time text, a date and time, or a date and a time, but this is a timestamp. Convert it with 'started.toDateTime()'.",
        "started",
      ],
      [
        "TSV043",
        "toDateTime(date, time) takes a date first, but this is text (string). Convert the text first, as in 'toDate(...)'.",
        '"2026-10-04"',
      ],
      [
        "TSV043",
        "toDate(...) takes a date as its 'default:', but this is text (string).",
        '"2026-10-04"',
      ],
    ],
  );
  assert.deepEqual(
    diagnostics(
      [
        "let a = toDate()",
        'let b = toDateTime(toDate("2026-10-04"), toTime("18:00"), toTime("19:00"))',
        'let c = toDate("2026-10-04", fallback: 1)',
      ].join("\n"),
    ).map(([code, message]) => [code, message]),
    [
      ["TSV020", "toDate(...) takes one value, received 0."],
      ["TSV020", "toDateTime(...) takes one value, or a date and a time, received 3."],
      ["TSV022", "toDate(...) has no parameter 'fallback'; its only named argument is 'default:'."],
    ],
  );
});
