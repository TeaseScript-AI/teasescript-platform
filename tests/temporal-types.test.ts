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

test("date and time values have read-only fields and methods by kind", () => {
  assert.deepEqual(
    codes(
      [
        "function parts(day: date, clock: time, dinner: datetime, started: timestamp) {",
        "    let fields: integer = day.year + day.month + day.day + day.weekdayNumber",
        "    let clockFields: integer = clock.hour + clock.minute + clock.second + clock.millisecond",
        "    let both: integer = dinner.year + dinner.millisecond",
        "    let name: string = dinner.weekday",
        "    let texts: string[] = [day.toISO(), clock.formatTime(), dinner.formatDateTime(), started.formatDate()]",
        "    let moment: timestamp = dinner.toTimestamp()",
        "    let local: datetime = started.toDateTime()",
        "    let unix: integer = started.toSeconds() + started.toMilliseconds()",
        "}",
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(
    diagnostics(
      [
        "function parts(day: date, clock: time, started: timestamp) {",
        "    let a = clock.year",
        "    let b = started.hour",
        "    let c = day.formatTime()",
        "    let d = clock.toTimestamp()",
        '    let e = day.formatDate("dd-MM")',
        "    day.year = 2027",
        "}",
      ].join("\n"),
    ),
    [
      ["TSV043", "A time has no property 'year'.", "year"],
      [
        "TSV043",
        "A timestamp has no property 'hour'. Convert it first, as in 'started.toDateTime().hour'.",
        "hour",
      ],
      ["TSV043", "A date has no method 'formatTime'.", "formatTime"],
      ["TSV043", "A time has no method 'toTimestamp'.", "toTimestamp"],
      [
        "TSV020",
        "formatDate() takes no arguments: it shows the value in the player's own date and time format.",
        "formatDate",
      ],
      [
        "TSV043",
        "Property 'year' of a date cannot be assigned; date and time values do not change.",
        "year",
      ],
    ],
  );
});

test("a comparison of weekday fields with values they never have gives a warning", () => {
  assert.deepEqual(
    diagnostics(
      [
        "function check(day: date) {",
        '    if day.weekday == "Saturday" or day.weekdayNumber == 7 { say "weekend" }',
        '    if day.weekday == "saturday" { say "never" }',
        '    if day.weekdayNumber != 0 { say "always" }',
        "}",
      ].join("\n"),
    ),
    [
      [
        "TSV046",
        `'day.weekday' is always "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday" or "Sunday" here, so this comparison is always false.`,
        'day.weekday == "saturday"',
      ],
      [
        "TSV046",
        "'day.weekdayNumber' is always 1, 2, 3, 4, 5, 6 or 7 here, so this comparison is always true.",
        "day.weekdayNumber != 0",
      ],
    ],
  );
});
