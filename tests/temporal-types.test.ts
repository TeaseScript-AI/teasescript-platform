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
        "function latest(moments: timestamp[], backup: timestamp?): timestamp? {",
        "    return backup",
        "}",
        "function kind(value: date | time | datetime | timestamp): string {",
        '    if value is timestamp { return "moment" }',
        '    return "local"',
        "}",
        "exit",
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(
    diagnostics('function f(at: timestamp) {\n    at = "2026-10-04T12:30:00Z"\n}\nexit'),
    [
      [
        "TSV041",
        "'at' holds a timestamp, so it cannot be set to text (string). Convert the text with toTimestamp(...).",
        '"2026-10-04T12:30:00Z"',
      ],
    ],
  );
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
        "exit",
      ].join("\n"),
    ),
    [],
  );
});

test("constant text that is not a valid value is a compile error, also with a default", () => {
  const cases = [
    [
      'toDate("4-10-2026")',
      'toDate(...) cannot convert "4-10-2026"; the text must be ISO date text such as "2026-10-04".',
    ],
    [
      'toDate("2026-02-30", default: toDate("2026-01-01"))',
      'toDate(...) cannot convert "2026-02-30": February 2026 has 28 days.',
    ],
    [
      'toTime("2:30 PM")',
      'toTime(...) cannot convert "2:30 PM"; the text must be ISO time text such as "14:30".',
    ],
    [
      'toDateTime("2026-10-04T18:00Z")',
      'toDateTime(...) cannot convert "2026-10-04T18:00Z"; the text must be local ISO date and time text without an offset, such as "2026-10-04T18:00".',
    ],
    [
      'toTimestamp("2026-10-04T12:30")',
      'toTimestamp(...) cannot convert "2026-10-04T12:30"; the text must be ISO timestamp text with Z or an offset, such as "2026-10-04T12:30:00Z".',
    ],
  ] as const;
  for (const [call, message] of cases) {
    const text = /"[^"]*"/u.exec(call)![0];
    assert.deepEqual(diagnostics(`let value = ${call}\nexit`), [["TSV043", message, text]], call);
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
        "exit",
      ].join("\n"),
    ),
    [
      [
        "TSV043",
        "toDate(...) converts text, a date, or a date and time, not a whole number (integer).",
        "5",
      ],
      [
        "TSV043",
        "toTimestamp(...) converts text or a timestamp, not a date and time. Convert it with 'dinner.toTimestamp()'.",
        "dinner",
      ],
      [
        "TSV043",
        "toDateTime(...) converts text, a date and time, or a date and a time, not a timestamp. Convert it with 'started.toDateTime()'.",
        "started",
      ],
      [
        "TSV043",
        "toDateTime(date, time) needs a date first, not text (string). Convert the text first with toDate(...).",
        '"2026-10-04"',
      ],
      ["TSV043", "toDate(...) needs a date as its default:, not text (string).", '"2026-10-04"'],
    ],
  );
  assert.deepEqual(
    diagnostics(
      [
        "let a = toDate()",
        'let b = toDateTime(toDate("2026-10-04"), toTime("18:00"), toTime("19:00"))',
        'let c = toDate("2026-10-04", fallback: 1)',
        "exit",
      ].join("\n"),
    ).map(([code, message]) => [code, message]),
    [
      ["TSV020", "toDate(...) takes 1 argument (value), received 0."],
      ["TSV020", "toDateTime(...) takes 1 argument (value) or 2 (date, time), received 3."],
      ["TSV022", "toDate(...) has no parameter 'fallback'; its only named argument is default:."],
    ],
  );
  assert.deepEqual(diagnostics('let day: date = "2026-10-04"\nexit'), [
    [
      "TSV041",
      "'day' is declared as date, so it cannot start as text (string). Convert the text with toDate(...).",
      '"2026-10-04"',
    ],
  ]);
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
        "exit",
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
        "exit",
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
        "exit",
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

test("date and time values order within one kind, and timestamps and dates and times move by durations", () => {
  assert.deepEqual(
    codes(
      [
        "function moments(day: date, clock: time, dinner: datetime, started: timestamp, later: timestamp) {",
        "    let ordered: boolean = day <= day and clock > clock and dinner < dinner and started >= later",
        "    let same: boolean = day == dinner",
        "    let deadline: timestamp = started + 1 h - 30 min",
        "    let earlier: datetime = dinner - 90 min",
        "    let waited: duration = later - started",
        "    let between: duration = dinner - earlier",
        "    let moving = started",
        "    moving += 5 min",
        "}",
        "exit",
      ].join("\n"),
    ),
    // A date is never equal to a date and time, so comparing them is only the always-false warning (ADR 0021 rule 4.5).
    [["TSV046", "day == dinner"]],
  );
});

test("ordering and arithmetic across kinds or on other values name the kinds and the fix", () => {
  assert.deepEqual(
    diagnostics(
      [
        "function moments(day: date, clock: time, dinner: datetime, started: timestamp) {",
        "    let a = day < dinner",
        "    let b = dinner >= started",
        "    let c = started < 5",
        "    let d = clock + 1 h",
        "    let e = started + started",
        "    let f = started - dinner",
        "    let g = 1 h + started",
        "    let h = dinner + 5",
        "}",
        "exit",
      ].join("\n"),
    ),
    [
      [
        "TSV043",
        "'<' compares a date only with another date, not with a date and time. Compare its date, as in 'toDate(dinner)'.",
        "day < dinner",
      ],
      [
        "TSV043",
        "'>=' compares a date and time only with another date and time, not with a timestamp. Convert one first, as in 'dinner.toTimestamp()'.",
        "dinner >= started",
      ],
      [
        "TSV043",
        "'<' compares a timestamp only with another timestamp, not with a whole number (integer).",
        "started < 5",
      ],
      [
        "TSV043",
        "'+' cannot combine a time and a duration: arithmetic on a time is not available. Combine it with a date first, as in 'toDateTime(date, time)'.",
        "clock + 1 h",
      ],
      ["TSV043", "'+' adds only a duration to a timestamp, not a timestamp.", "started + started"],
      [
        "TSV043",
        "'-' subtracts only a duration or another timestamp from a timestamp, not a date and time. Convert one first, as in 'dinner.toTimestamp()'.",
        "started - dinner",
      ],
      [
        "TSV043",
        "'+' cannot add a timestamp to a duration. Write it first, as in 'started + 1 h'.",
        "1 h + started",
      ],
      [
        "TSV043",
        "'+' adds only a duration to a date and time, not a whole number (integer). Give the number a unit, such as '5 s'.",
        "dinner + 5",
      ],
    ],
  );
});

test("date and time values show as text, give buttons, and are set elements", () => {
  assert.deepEqual(
    codes(
      [
        "function show(day: date, clock: time, dinner: datetime, started: timestamp) {",
        '    say "${day} ${clock} ${dinner} ${started} ${[day, day]}"',
        "    showButton started",
        "    let answer = askText dinner",
        '    let pick: date = choose day, toDate("2026-10-05")',
        '    let moment = choose [{ text: "Now", value: started }, { text: "Later", value: started + 1 h }]',
        '    let days: date set = set[day, toDate("2026-10-05")]',
        "    let spans: duration set = set[1 h, 2 h]",
        "    let mixed: (time | timestamp) set = set[]",
        "}",
        "exit",
      ].join("\n"),
    ),
    [],
  );
});
