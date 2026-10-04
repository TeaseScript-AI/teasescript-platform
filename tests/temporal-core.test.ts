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
  type DateTimeFields,
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

const DUTCH: PresentationSettings = {
  ...DEFAULT_PRESENTATION_SETTINGS,
  dateOrder: "dmy",
  padDay: false,
  padMonth: false,
};

const AMERICAN: PresentationSettings = {
  ...DEFAULT_PRESENTATION_SETTINGS,
  dateOrder: "mdy",
  dateSeparator: "/",
  padDay: false,
  padMonth: false,
  dateTimeSeparator: ", ",
  hourCycle: "h12",
  padHour: false,
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

test("zone rules map moments to local time and local time back, shifting gaps forward and taking earlier overlaps", () => {
  assert.deepEqual(
    localFields(AMSTERDAM, utc("2026-07-01T10:00:00")),
    dateTime("2026-07-01T12:00"),
  );
  assert.deepEqual(
    localFields(AMSTERDAM, utc("2026-12-01T10:00:00")),
    dateTime("2026-12-01T11:00"),
  );
  assert.equal(zonedTimestamp(AMSTERDAM, dateTime("2026-07-01T12:00")), utc("2026-07-01T10:00:00"));
  assert.equal(zonedTimestamp(AMSTERDAM, dateTime("2026-12-01T11:00")), utc("2026-12-01T10:00:00"));

  // 02:00–03:00 does not exist on 29 March: 02:30 is read as 03:30 summer time.
  assert.equal(zonedTimestamp(AMSTERDAM, dateTime("2026-03-29T02:30")), utc("2026-03-29T01:30:00"));
  assert.equal(zonedTimestamp(AMSTERDAM, dateTime("2026-03-29T03:00")), utc("2026-03-29T01:00:00"));
  assert.equal(
    zonedTimestamp(AMSTERDAM, dateTime("2026-03-29T01:59:59.999")),
    utc("2026-03-29T00:59:59.999"),
  );
  // 02:00–03:00 happens twice on 25 October: the summer-time occurrence comes first.
  assert.equal(zonedTimestamp(AMSTERDAM, dateTime("2026-10-25T02:30")), utc("2026-10-25T00:30:00"));
  assert.equal(zonedTimestamp(AMSTERDAM, dateTime("2026-10-25T03:00")), utc("2026-10-25T02:00:00"));

  // Elapsed time through the zone: 24 hours after 18:00 on the eve of summer time is 19:00.
  const evening = zonedTimestamp(AMSTERDAM, dateTime("2026-03-28T18:00"))!;
  assert.deepEqual(localFields(AMSTERDAM, evening + 86_400_000), dateTime("2026-03-29T19:00"));

  // Outside the captured transitions the nearest offset applies, and results stay within the year range.
  assert.equal(zonedTimestamp(AMSTERDAM, dateTime("1900-01-01T12:00")), utc("1900-01-01T11:00:00"));
  assert.equal(zonedTimestamp(AMSTERDAM, dateTime("0000-01-01T00:30")), undefined);
  assert.equal(localFields(AMSTERDAM, MAX_EPOCH_MILLISECONDS), undefined);
});

test("zone rules from the host are checked before use", () => {
  assert.equal(zoneRulesProblem(AMSTERDAM), null);
  const malformed: unknown[] = [
    null,
    { ...AMSTERDAM, extra: true },
    { ...AMSTERDAM, name: "Europe/Amsterdam\n" },
    { ...AMSTERDAM, initialOffsetSeconds: 86_400 },
    { ...AMSTERDAM, initialOffsetSeconds: 3_600.5 },
    {
      ...AMSTERDAM,
      transitions: [
        [utc("2026-10-25T01:00:00"), 3_600],
        [utc("2026-03-29T01:00:00"), 7_200],
      ],
    },
    {
      ...AMSTERDAM,
      transitions: [
        [utc("2026-03-29T01:00:00"), 7_200],
        [utc("2026-03-29T01:00:00"), 3_600],
      ],
    },
    { ...AMSTERDAM, transitions: [[-1, 3_600]] },
    { ...AMSTERDAM, transitions: [[utc("2100-01-01T00:00:01"), 3_600]] },
    { ...AMSTERDAM, transitions: [[Number.NaN, 3_600]] },
    { ...AMSTERDAM, transitions: [[utc("2026-03-29T01:00:00")]] },
    { ...AMSTERDAM, transitions: Array.from({ length: 1_001 }, (_, index) => [index, 3_600]) },
  ];
  for (const rules of malformed)
    assert.notEqual(zoneRulesProblem(rules), null, JSON.stringify(rules));
});

test("presentation writes numeric local text from the captured settings", () => {
  const evening = dateTime("2026-10-04T18:30");
  assert.equal(presentDateTime(DUTCH, evening), "4-10-2026 18:30");
  assert.equal(presentDateTime(AMERICAN, evening), "10/4/2026, 6:30 PM");
  assert.equal(presentDateTime(DEFAULT_PRESENTATION_SETTINGS, evening), "2026-10-04 18:30");
  assert.equal(presentDate(AMERICAN, evening), "10/4/2026");

  const at = (text: string) => {
    const result = parseIsoTime(text);
    assert.ok(result.ok);
    return result.value;
  };
  assert.equal(presentTime(AMERICAN, at("00:05")), "12:05 AM");
  assert.equal(presentTime(AMERICAN, at("12:00")), "12:00 PM");
  assert.equal(presentTime(AMERICAN, at("09:05:07")), "9:05:07 AM");
  assert.equal(presentTime(DUTCH, at("09:05:00.250")), "09:05:00.250");
  assert.equal(
    presentTime({ ...AMERICAN, dayPeriods: ["am", "pm"], dayPeriodBeforeTime: true }, at("18:30")),
    "pm 6:30",
  );
});

test("presentation settings from the host are checked before use", () => {
  assert.equal(presentationSettingsProblem(DUTCH), null);
  const malformed: unknown[] = [
    { ...DUTCH, dateOrder: "dym" },
    { ...DUTCH, hourCycle: "h24" },
    { ...DUTCH, padDay: "yes" },
    { ...DUTCH, dateSeparator: "\n" },
    { ...DUTCH, timeSeparator: "x".repeat(17) },
    { ...DUTCH, dayPeriods: ["AM"] },
    { ...DUTCH, dayPeriods: ["", "PM"] },
    { ...DUTCH, extra: 1 },
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

test("the host captures zone transitions and locale settings that reproduce its own formatting", () => {
  const amsterdam = captureZoneRules("Europe/Amsterdam");
  assert.equal(amsterdam.name, "Europe/Amsterdam");
  assert.equal(amsterdam.initialOffsetSeconds, 3_600);
  assert.deepEqual(
    amsterdam.transitions.filter(([moment]) => new Date(moment).getUTCFullYear() === 2026),
    AMSTERDAM.transitions,
  );
  assert.deepEqual(captureZoneRules("UTC").transitions, []);
  assert.throws(() => captureZoneRules("Mars/Olympus_Mons"), RangeError);

  // The oracle is the host's own Intl output for the same moments, so the check survives locale-data updates.
  for (const locale of ["nl-NL", "en-US", "en-GB", "de-DE", "fr-FR", "ja-JP", "ko-KR", "sv-SE"]) {
    const settings = capturePresentationSettings(locale);
    for (const text of ["2026-10-04T18:30", "2033-01-05T09:05", "2026-12-24T00:00:07"]) {
      const local = dateTime(text);
      const withSeconds = local.second !== 0;
      const host = new Intl.DateTimeFormat(locale, {
        timeZone: "UTC",
        numberingSystem: "latn",
        calendar: "gregory",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        ...(withSeconds ? { second: "2-digit" } : {}),
      })
        .format(Date.parse(`${text}Z`))
        .replace(/[\u00a0\u202f]/gu, " ");
      assert.equal(presentDateTime(settings, local), host, `${locale} ${text}`);
    }
  }
  assert.throws(() => capturePresentationSettings("not a locale"), RangeError);
});
