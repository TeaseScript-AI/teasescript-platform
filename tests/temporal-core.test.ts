import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PRESENTATION_SETTINGS,
  formatIsoDate,
  formatIsoDateTime,
  formatIsoTime,
  formatIsoTimestamp,
  isoWeekdayNumber,
  localFields,
  MAX_EPOCH_MILLISECONDS,
  MIN_EPOCH_MILLISECONDS,
  parseIsoDate,
  parseIsoDateTime,
  parseIsoTime,
  parseIsoTimestamp,
  presentationSettingsProblem,
  presentDate,
  presentDateTime,
  presentTime,
  roundToMillisecond,
  utcFields,
  weekdayName,
  zonedTimestamp,
  zoneRulesProblem,
  UTC_ZONE_RULES,
  type DateTimeFields,
  type HourCycle,
  type PresentationSettings,
  type ZoneRules,
} from "../src/temporal.js";
import { capturePresentationSettings, captureZoneRules } from "../src/temporal-capture.js";

function dateTime(text: string): DateTimeFields {
  const result = parseIsoDateTime(text);
  assert.ok(result.ok, text);
  return result.value;
}

function utc(text: string): number {
  return Date.parse(`${text}Z`);
}

// Europe/Amsterdam around 2026 under the EU rule: summer time from the last Sunday of March to the last Sunday of
// October, both at 01:00 UTC.
const AMSTERDAM: ZoneRules = {
  name: "Europe/Amsterdam",
  initialOffsetSeconds: 3_600,
  transitions: [
    [utc("2026-03-29T01:00:00"), 7_200],
    [utc("2026-10-25T01:00:00"), 3_600],
  ],
};

test("UTC fields and weekdays follow the proleptic Gregorian calendar over the whole year range", () => {
  const step = 9_876_543_210; // about 114 days, so the samples drift through every month, weekday, and leap rule
  for (let moment = MIN_EPOCH_MILLISECONDS; moment <= MAX_EPOCH_MILLISECONDS; moment += step) {
    const oracle = new Date(moment);
    const fields = utcFields(moment);
    assert.deepEqual(
      [
        fields.year,
        fields.month,
        fields.day,
        fields.hour,
        fields.minute,
        fields.second,
        fields.millisecond,
      ],
      [
        oracle.getUTCFullYear(),
        oracle.getUTCMonth() + 1,
        oracle.getUTCDate(),
        oracle.getUTCHours(),
        oracle.getUTCMinutes(),
        oracle.getUTCSeconds(),
        oracle.getUTCMilliseconds(),
      ],
    );
    assert.equal(isoWeekdayNumber(fields), oracle.getUTCDay() === 0 ? 7 : oracle.getUTCDay());
  }
  assert.equal(formatIsoTimestamp(MIN_EPOCH_MILLISECONDS), "0000-01-01T00:00:00Z");
  assert.equal(formatIsoTimestamp(MAX_EPOCH_MILLISECONDS), "9999-12-31T23:59:59.999Z");
  assert.equal(weekdayName({ year: 2026, month: 10, day: 4 }), "Sunday");
  assert.equal(weekdayName({ year: 2000, month: 2, day: 29 }), "Tuesday");
});

test("strict ISO text reads real local values and explains values that do not exist", () => {
  assert.deepEqual(parseIsoDate("2026-10-04"), {
    ok: true,
    value: { year: 2026, month: 10, day: 4 },
  });
  assert.deepEqual(parseIsoDate("2024-02-29"), {
    ok: true,
    value: { year: 2024, month: 2, day: 29 },
  });
  assert.deepEqual(parseIsoTime("14:30"), {
    ok: true,
    value: { hour: 14, minute: 30, second: 0, millisecond: 0 },
  });
  assert.deepEqual(parseIsoTime("23:59:59.5"), {
    ok: true,
    value: { hour: 23, minute: 59, second: 59, millisecond: 500 },
  });
  assert.deepEqual(dateTime("2026-10-04T18:00:07.025"), {
    year: 2026,
    month: 10,
    day: 4,
    hour: 18,
    minute: 0,
    second: 7,
    millisecond: 25,
  });

  for (const text of [
    "4-10-2026",
    "2026-10-4",
    "26-10-04",
    "+2026-10-04",
    " 2026-10-04",
    "2026/10/04",
    "",
  ])
    assert.deepEqual(parseIsoDate(text), { ok: false, reason: null }, text);
  for (const text of ["14", "14:3", "1430", "14:30:00.1234", "14:30:00,5", "2pm", "14:30Z"])
    assert.deepEqual(parseIsoTime(text), { ok: false, reason: null }, text);
  for (const text of [
    "2026-10-04 18:00",
    "2026-10-04t18:00",
    "2026-10-04T18:00Z",
    "2026-10-04T18:00+02:00",
  ])
    assert.deepEqual(parseIsoDateTime(text), { ok: false, reason: null }, text);

  assert.deepEqual(parseIsoDate("2026-02-29"), { ok: false, reason: "February 2026 has 28 days" });
  assert.deepEqual(parseIsoDate("2026-13-01"), { ok: false, reason: "there is no month 13" });
  assert.deepEqual(parseIsoDate("2026-10-00"), { ok: false, reason: "there is no day 0" });
  assert.deepEqual(parseIsoTime("24:00"), {
    ok: false,
    reason: "there is no hour 24; midnight is 00:00",
  });
  assert.deepEqual(parseIsoTime("12:60"), { ok: false, reason: "there is no minute 60" });
  assert.deepEqual(parseIsoTime("12:00:60"), { ok: false, reason: "there is no second 60" });
  assert.deepEqual(parseIsoDateTime("2026-04-31T10:00"), {
    ok: false,
    reason: "April 2026 has 30 days",
  });
});

test("timestamp text needs Z or an offset and names one UTC moment", () => {
  const moment = utc("2026-10-04T12:30:00");
  assert.deepEqual(parseIsoTimestamp("2026-10-04T12:30:00Z"), { ok: true, value: moment });
  assert.deepEqual(parseIsoTimestamp("2026-10-04T14:30+02:00"), { ok: true, value: moment });
  assert.deepEqual(parseIsoTimestamp("2026-10-04T07:00-05:30"), { ok: true, value: moment });
  for (const text of [
    "2026-10-04T12:30:00",
    "2026-10-04T12:30:00z",
    "2026-10-04T12:30+0200",
    "2026-10-04Z",
  ])
    assert.deepEqual(parseIsoTimestamp(text), { ok: false, reason: null }, text);
  assert.deepEqual(parseIsoTimestamp("2026-10-04T12:30+24:00"), {
    ok: false,
    reason: "the offset +24:00 does not exist",
  });
  assert.deepEqual(parseIsoTimestamp("0000-01-01T00:30+01:00"), {
    ok: false,
    reason: "the moment lies outside the years 0000 to 9999 in UTC",
  });
});

test("ISO output omits zero seconds and milliseconds for local values and always writes seconds for timestamps", () => {
  assert.equal(formatIsoDate({ year: 42, month: 3, day: 9 }), "0042-03-09");
  assert.equal(formatIsoTime({ hour: 18, minute: 0, second: 0, millisecond: 0 }), "18:00");
  assert.equal(formatIsoTime({ hour: 9, minute: 5, second: 0, millisecond: 7 }), "09:05:00.007");
  assert.equal(formatIsoDateTime(dateTime("2026-10-04T18:00:30")), "2026-10-04T18:00:30");
  assert.equal(formatIsoTimestamp(utc("2026-10-04T12:30:00")), "2026-10-04T12:30:00Z");
  assert.equal(formatIsoTimestamp(utc("1969-12-31T23:59:59.250")), "1969-12-31T23:59:59.250Z");
});

function moment(rules: ZoneRules, text: string): number {
  const result = zonedTimestamp(rules, dateTime(text));
  assert.ok(result.ok, text);
  return result.value;
}

function local(rules: ZoneRules, epochMilliseconds: number): DateTimeFields {
  const result = localFields(rules, epochMilliseconds);
  assert.ok(result.ok, String(epochMilliseconds));
  return result.value;
}

test("zone rules map moments to local time and local time back, shifting gaps forward and taking earlier overlaps", () => {
  assert.deepEqual(local(AMSTERDAM, utc("2026-07-01T10:00:00")), dateTime("2026-07-01T12:00"));
  assert.deepEqual(local(AMSTERDAM, utc("2026-12-01T10:00:00")), dateTime("2026-12-01T11:00"));
  assert.equal(moment(AMSTERDAM, "2026-07-01T12:00"), utc("2026-07-01T10:00:00"));
  assert.equal(moment(AMSTERDAM, "2026-12-01T11:00"), utc("2026-12-01T10:00:00"));

  // 02:00–03:00 does not exist on 29 March: 02:30 is read as 03:30 summer time.
  assert.equal(moment(AMSTERDAM, "2026-03-29T02:30"), utc("2026-03-29T01:30:00"));
  assert.equal(moment(AMSTERDAM, "2026-03-29T03:00"), utc("2026-03-29T01:00:00"));
  assert.equal(moment(AMSTERDAM, "2026-03-29T01:59:59.999"), utc("2026-03-29T00:59:59.999"));
  // 02:00–03:00 happens twice on 25 October: the summer-time occurrence comes first.
  assert.equal(moment(AMSTERDAM, "2026-10-25T02:30"), utc("2026-10-25T00:30:00"));
  assert.equal(moment(AMSTERDAM, "2026-10-25T03:00"), utc("2026-10-25T02:00:00"));

  // Elapsed time through the zone: 24 hours after 18:00 on the eve of summer time is 19:00.
  assert.deepEqual(
    local(AMSTERDAM, moment(AMSTERDAM, "2026-03-28T18:00") + 86_400_000),
    dateTime("2026-03-29T19:00"),
  );

  // Close transitions, valid in a table: a local time is found where it really occurs, and a skipped one moves past
  // every range it falls into. Rules start at UTC; at 01:00 the offset becomes +2 h, at 01:30 +1 h (or +3 h).
  const close = (offset: number): ZoneRules => ({
    name: "Test/Close",
    initialOffsetSeconds: 0,
    transitions: [
      [3_600_000, 7_200],
      [5_400_000, offset],
    ],
  });
  assert.equal(moment(close(3_600), "1970-01-01T02:30"), 5_400_000);
  assert.equal(moment(close(10_800), "1970-01-01T02:30"), 5_400_000);
  assert.deepEqual(local(close(10_800), 5_400_000), dateTime("1970-01-01T04:30"));
});

test("zone conversion outside the captured years fails instead of guessing the rules", () => {
  const outside = { ok: false, reason: "the time-zone rules cover 1970 through 2099" };
  assert.deepEqual(localFields(AMSTERDAM, utc("1969-12-31T23:59:59.999")), outside);
  assert.deepEqual(localFields(AMSTERDAM, utc("2100-01-01T00:00:00")), outside);
  assert.deepEqual(zonedTimestamp(AMSTERDAM, dateTime("1970-01-01T00:59")), outside);
  assert.deepEqual(zonedTimestamp(AMSTERDAM, dateTime("2101-07-01T12:00")), outside);
  assert.equal(localFields(AMSTERDAM, 0.5).ok, false);
  assert.equal(moment(AMSTERDAM, "1970-01-01T01:00"), 0);
  assert.equal(moment(UTC_ZONE_RULES, "2099-12-31T23:59:59.999"), utc("2099-12-31T23:59:59.999"));
});

test("zone rules from the host are checked before use", () => {
  assert.equal(zoneRulesProblem(AMSTERDAM), null);
  const malformed: unknown[] = [
    null,
    { ...AMSTERDAM, extra: true },
    { ...AMSTERDAM, name: "Europe/Amsterdam\n" },
    { ...AMSTERDAM, initialOffsetSeconds: 86_400 },
    { ...AMSTERDAM, initialOffsetSeconds: 3_600.5 },
    { ...AMSTERDAM, transitions: [...AMSTERDAM.transitions].reverse() },
    { ...AMSTERDAM, transitions: [AMSTERDAM.transitions[0], AMSTERDAM.transitions[0]] },
    { ...AMSTERDAM, transitions: [[0, 3_600]] },
    { ...AMSTERDAM, transitions: [[utc("2100-01-01T00:00:00"), 3_600]] },
    { ...AMSTERDAM, transitions: [[Number.NaN, 3_600]] },
    { ...AMSTERDAM, transitions: [[utc("2026-03-29T01:00:00")]] },
    { ...AMSTERDAM, transitions: Array.from({ length: 1_001 }, (_, index) => [index + 1, 3_600]) },
  ];
  for (const rules of malformed)
    assert.notEqual(zoneRulesProblem(rules), null, JSON.stringify(rules));
});

const DAY_FIRST: PresentationSettings = {
  ...DEFAULT_PRESENTATION_SETTINGS,
  date: "{day}-{month}-{year}",
  dateTime: "{day}-{month}-{year}, {hour}:{minute}",
  dateTimeWithSeconds: "{day}-{month}-{year}, {hour}:{minute}:{second}",
  padDay: false,
  padMonth: false,
};

const TWELVE_HOUR: PresentationSettings = {
  date: "{month}/{day}/{year}",
  time: "{hour}:{minute} {dayPeriod}",
  timeWithSeconds: "{hour}:{minute}:{second} {dayPeriod}",
  dateTime: "{month}/{day}/{year}, {hour}:{minute} {dayPeriod}",
  dateTimeWithSeconds: "{month}/{day}/{year}, {hour}:{minute}:{second} {dayPeriod}",
  padDay: false,
  padMonth: false,
  padHour: false,
  hourCycle: "h12",
  dayPeriods: ["AM", "PM"],
};

test("presentation fills the captured templates, with seconds only when they are not zero", () => {
  assert.equal(presentDateTime(DAY_FIRST, dateTime("2026-10-04T18:30")), "4-10-2026, 18:30");
  assert.equal(presentDateTime(TWELVE_HOUR, dateTime("2026-10-04T18:30")), "10/4/2026, 6:30 PM");
  assert.equal(
    presentDateTime(DEFAULT_PRESENTATION_SETTINGS, dateTime("2026-10-04T18:30:00.250")),
    "2026-10-04 18:30",
  );
  assert.equal(presentDateTime(DAY_FIRST, dateTime("2026-10-04T18:30:05")), "4-10-2026, 18:30:05");
  assert.equal(presentDate(TWELVE_HOUR, dateTime("0042-01-05T00:00")), "1/5/0042");

  const hours = (cycle: HourCycle) =>
    ["00:05", "12:05", "23:05"].map((text) => {
      const result = parseIsoTime(text);
      assert.ok(result.ok);
      return presentTime({ ...TWELVE_HOUR, hourCycle: cycle }, result.value);
    });
  assert.deepEqual(hours("h11"), ["0:05 AM", "0:05 PM", "11:05 PM"]);
  assert.deepEqual(hours("h12"), ["12:05 AM", "12:05 PM", "11:05 PM"]);
  assert.deepEqual(hours("h23"), ["0:05 AM", "12:05 PM", "23:05 PM"]);
  assert.deepEqual(hours("h24"), ["24:05 AM", "12:05 PM", "23:05 PM"]);
});

test("presentation settings from the host are checked before use", () => {
  assert.equal(presentationSettingsProblem(TWELVE_HOUR), null);
  const malformed: unknown[] = [
    { ...TWELVE_HOUR, date: "{month}/{day}" },
    { ...TWELVE_HOUR, date: "{month}/{day}/{year}/{day}" },
    { ...TWELVE_HOUR, date: "{month}/{day}/{year} {hour}" },
    { ...TWELVE_HOUR, time: "{hour}:{minute}:{second}" },
    { ...TWELVE_HOUR, time: "{hour}:{minute} {weekday}" },
    { ...TWELVE_HOUR, time: "{hour}:{minute} {" },
    { ...TWELVE_HOUR, dateTime: "{month}/{day}/{year}\n{hour}:{minute}" },
    { ...TWELVE_HOUR, timeWithSeconds: "{hour}:{minute}" },
    { ...TWELVE_HOUR, hourCycle: "h13" },
    { ...TWELVE_HOUR, hourCycle: ["h12"] },
    { ...TWELVE_HOUR, hourCycle: { toString: null, valueOf: null } },
    { ...TWELVE_HOUR, padDay: "yes" },
    { ...TWELVE_HOUR, dayPeriods: ["AM"] },
    { ...TWELVE_HOUR, dayPeriods: ["", "PM"] },
    // A sparse list has length 2 but no markers.
    { ...TWELVE_HOUR, dayPeriods: Array.from({ length: 2 }).map(() => undefined) },
    { ...TWELVE_HOUR, extra: 1 },
  ];
  for (const settings of malformed)
    assert.notEqual(presentationSettingsProblem(settings), null, JSON.stringify(settings));
});

test("an exact part rounds to a whole millisecond with ties away from zero", () => {
  assert.deepEqual(
    [0.5, 1.4999, 2.5, -0.5, -2.5, -0.4].map(roundToMillisecond),
    [1, 1, 3, -1, -3, 0],
  );
  assert.ok(Object.is(roundToMillisecond(-0.4), 0));
});

/** The host's own `Intl` text for a local value, with the no-break spaces that capture turns into plain spaces. */
function hostText(locale: string, text: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    numberingSystem: "latn",
    calendar: "gregory",
    ...options,
  })
    .format(Date.parse(`${text}Z`))
    .replace(/[\u00a0\u202f]/gu, " ");
}

test("captured presentation reproduces the host's own formatting", () => {
  // Day-month-year, month-day-year, year-day-month, time before date, outer literals, a leading day period, a pattern
  // that changes with seconds, and explicitly chosen hour cycles. The oracle is live host data, not fixed strings.
  const locales = [
    "nl-NL",
    "en-US",
    "ky-KG",
    "vi-VN",
    "ko-KR",
    "eu-ES",
    "dz-BT",
    "en-US-u-hc-h11",
    "en-US-u-hc-h24",
  ];
  const date = { year: "numeric", month: "numeric", day: "numeric" } as const;
  const time = { hour: "numeric", minute: "2-digit" } as const;
  for (const locale of locales) {
    const settings = capturePresentationSettings(locale);
    for (const text of ["2026-01-05T00:05", "2026-10-04T12:30", "2026-12-24T18:30:07"]) {
      const value = dateTime(text);
      const seconds = value.second === 0 ? {} : ({ second: "2-digit" } as const);
      const label = `${locale} ${text}`;
      assert.equal(presentDate(settings, value), hostText(locale, text, date), label);
      assert.equal(
        presentTime(settings, value),
        hostText(locale, text, { ...time, ...seconds }),
        label,
      );
      assert.equal(
        presentDateTime(settings, value),
        hostText(locale, text, { ...date, ...time, ...seconds }),
        label,
      );
    }
  }
  assert.throws(() => capturePresentationSettings("not a locale"), RangeError);
});

test("captured zone rules reproduce the host's offsets around every transition", () => {
  const hostOffsetSeconds = (timeZone: string, epochMilliseconds: number) => {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(epochMilliseconds)
      .find((part) => part.type === "timeZoneName")!.value;
    const match = /^GMT(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?$/u.exec(name)!;
    const seconds =
      Number(match[2] ?? 0) * 3_600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
    return match[1] === "-" ? -seconds : seconds;
  };
  // Half-hour summer time, a 5:45 offset, an offset in seconds before 1972, and Ramadan pauses of summer time in 2010.
  for (const zone of ["Australia/Lord_Howe", "Asia/Kathmandu", "Africa/Monrovia", "Africa/Cairo"]) {
    const rules = captureZoneRules(zone);
    assert.equal(
      rules.name,
      new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone,
    );
    const instants = rules.transitions.flatMap(([at]) => [at! - 1, at!]);
    for (const at of [0, utc("2026-01-15T00:00:00"), utc("2026-07-15T00:00:00"), ...instants]) {
      const expected = at + hostOffsetSeconds(zone, at) * 1_000;
      assert.equal(fieldsAsMilliseconds(local(rules, at)), expected, `${zone} ${at}`);
    }
  }
  assert.deepEqual(captureZoneRules("UTC").transitions, []);
  assert.throws(() => captureZoneRules("Mars/Olympus_Mons"), RangeError);
});

function fieldsAsMilliseconds(fields: DateTimeFields): number {
  return Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
    fields.millisecond,
  );
}
