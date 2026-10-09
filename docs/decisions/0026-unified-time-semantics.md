# ADR 0026 — Time values: ISO weeks, absolute moments, exact days, and calendar durations

**Status:** Accepted
**Decision source:** Owner decisions on #512, 2026-10-09

## Context

V30 §35 has five temporal types. Its `duration` holds calendar months, calendar days, and exact milliseconds in one
value, and `1 day` is a calendar day: the same clock time on the next date, which is 23 or 25 hours across a
daylight-saving change. `datetime ± exact duration` and `datetime - datetime` measure through the player's current zone,
so an operator on a local value reads a zone that the source does not show. Authors use a day as 24 hours: converted
scripts add `86400` or `604800` seconds to Unix time, while `timestamp + 1 week` is an error. In SQL, `timestamp` names a
local value. Scripts cannot group by week.

## Decision

### 1. Six temporal types

| Type | Meaning |
| --- | --- |
| `date` | A Gregorian date without clock or zone |
| `time` | A clock time without date or zone |
| `datetime` | A local date and clock time without a zone |
| `absoluteDateTime` | One moment in whole milliseconds, without a zone |
| `duration` | Exact elapsed time: signed finite milliseconds |
| `calendarDuration` | Whole calendar months, whole calendar days, and an exact offset, each signed |

`date`, `time`, and `datetime` keep their construction, fields, comparison, and presentation. All six are immutable
values. Equality, type tests, sets, and typed storage keep them apart.

### 2. ISO weeks

`date` and `datetime` gain `.weekNumber` (1–53) and `.weekYear`, the ISO 8601 week and the year it belongs to. A week
starts on Monday, and week 1 holds the year's first Thursday: 2024-12-30 is week 1 of 2025, and 2021-01-01 is week 53 of
2020. Neither depends on the player's locale. The week year of 0000-01-01 is -1; it is a label, not a year a date can
have. `.day`, `.weekday`, and `.weekdayNumber` are unchanged.

An `absoluteDateTime` has no date or clock fields. Convert it first: `moment.toDateTime().weekNumber`.

### 3. `absoluteDateTime` replaces `timestamp`

| Before | Now |
| --- | --- |
| type `timestamp` | type `absoluteDateTime` |
| `getTimestamp()` | `getAbsoluteDateTime()` |
| `toTimestamp(value)` | `toAbsoluteDateTime(value)` |
| `datetime.toTimestamp()` | `datetime.toAbsoluteDateTime()` |
| `<timestamp 2026-10-04T12:30:00Z>` in a collection | `<absoluteDateTime 2026-10-04T12:30:00Z>` |

`.toSeconds()`, `.toMilliseconds()`, `.toISO()`, `.toDateTime()`, and the format methods stay. Each old name is a
compile error that names its replacement.

### 4. Exact durations and calendar units

A `duration` is exact. `d`/`day`/`days` is 24 hours and `w`/`week`/`weeks` is 168 hours, next to `ms`, `s`, `min`, and
`h` with their long forms. `1 week == 7 days` and `1 day == 24 h` are true.

A calendar step puts `calendar` before its unit: `1 calendar day`, `2 calendar weeks`, `1 calendar month`,
`1 calendar year`. `calendar` takes the short forms `d`, `w`, `mo`, and `y` and every long form. Its value is a
`calendarDuration`. `month` and `year`, also `mo` and `y`, without `calendar` are compile errors that suggest it. `m`
remains invalid. `calendar` is a unit word only where a unit can stand; elsewhere it is an ordinary name, as in
`p.calendar.month`.

A calendar amount counts a week as 7 days and a year as 12 months, and must give whole days and months:
`0.5 calendar years` is 6 months, `2 calendar weeks / 2` is 7 calendar days, and `1.5 calendar days` and
`1.5 calendar weeks` are errors. An exact amount keeps fractions.

A `calendarDuration` stays one in every result, also when it cancels to zero: `1 calendar month - 1 calendar month` is a
zero `calendarDuration`, not a `duration`. Its read-only `.months`, `.days`, and `.exactOffset` give its components as an
integer, an integer, and a `duration`; `.days` counts calendar days and is not a length. A `duration` has no components:
divide by a unit, as in `(2 days + 6 h) / 1 h`, which is `54`.

With D for `duration` and C for `calendarDuration`:

| Operation | Result |
| --- | --- |
| D ± D | D |
| C ± C, C ± D, D ± C | C, also when every component is zero |
| D × number, number × D, D / number | D |
| C × number, number × C, C / number | C whose months and days stay whole |
| D / D | number |
| C / C | number, within one family |
| D compared with D | ordered and equal by length |
| C == C | true when months, days, and exact offset are equal |
| C ordered against C | within one family |
| C == D | false, also for zero values |
| C ordered against or divided by D, D divided by C | error |
| duration × duration | error |

The families of a `calendarDuration` are months only, days only, and exact offset only. A zero value belongs to every
family. A value with components of two families is never ordered, also not against zero. Dividing by zero, or by a zero
duration of either type, is an error, and so is a result that is not finite. `min`, `max`, and `sort()` follow the same
rules. `1 calendar month + 1 day` and `1 day + 1 calendar month` are the same value.

### 5. Arithmetic on dates and times

Operators never read a time zone.

| Operation | Result |
| --- | --- |
| `date ± C` with a zero exact offset | `date`: months, then days |
| `datetime ± C` with a zero exact offset | `datetime`: months, then days, with the same clock time |
| `absoluteDateTime ± D` | `absoluteDateTime` |
| `absoluteDateTime - absoluteDateTime` | D |
| `date - date` | C, a whole number of calendar days |

Adding months to a day that the target month lacks gives that month's last day, as before. Every other combination is
an error with a diagnostic that names a route that works:

- `date ± D`, also a whole number of days, and `date ± C` with a nonzero exact offset: use calendar units, as in
  `getDate() + 1 calendar day`;
- `datetime ± D`, `datetime ± C` with a nonzero exact offset, and `datetime - datetime`: convert to `absoluteDateTime` for
  elapsed time, or use calendar units or `toDate(...)` for local dates;
- `absoluteDateTime ± C`: convert to a `datetime` first;
- any arithmetic on `time`.

```tease
let local = getDateTime()
let later = (local.toAbsoluteDateTime() + 2 h).toDateTime()   // 2 elapsed hours later, as local time
let sameClock = local + 1 calendar day                         // the same clock time on the next date
let dinner = toDateTime(getDate() + 1 calendar day, toTime("18:00"))
let week = getAbsoluteDateTime() + 1 week                      // 168 hours from now
```

Comparison is unchanged: local values order by their fields, absolute values by moment, `==` across kinds is false, and
ordering across kinds is an error. Known invalid combinations are compile errors and others are runtime errors.
`toAbsoluteDateTime()` and `toDateTime()` keep converting through the player's current zone. `wait`, timers, and the
other consumers of an exact duration take a `duration` and reject a `calendarDuration`.

### 6. Display

A `duration` displays in days, hours, minutes, and seconds, without weeks: `2 days + 6 h` shows `2 d 6 h` and `2 weeks`
shows `14 d`. A `calendarDuration` is normalized, weeks into days and 12 months into a year, and every calendar part is
marked: `1 calendar month + 16 calendar days` shows `1 calendar month 16 calendar days`.

### 7. Stored values

Stored values are not converted. A `save` value written before this change, such as a `timestamp` or a duration with
calendar months or days, fails validation when it is read, and `load` returns its default. Plans, snapshots, and
checkpoints follow the existing format-revision rule: an older revision is refused, and a session kept in an older
format shows Start.

## Not decided

These parts of the #512 time proposal remain open:

- anchored conversion and explicit time zones, with options for month ends and daylight-saving gaps and overlaps (`zone:`,
  `disambiguation:`, `overflow:`, applying a `calendarDuration` to an `absoluteDateTime`, and measuring one from an
  anchor);
- units after arbitrary expressions, such as `count days` or `(n / 2) days`;
- `askDuration` and `askCalendarDuration`;
- scheduling and `schedule(...)` ([V30 §36](../specifications/accepted-syntaxes-v30.md#36-scheduling));
- `waitUntil`;
- a warning for a `wait` or timer of days or weeks, which count scene time.

## Consequences

- [V30 §35](../specifications/accepted-syntaxes-v30.md#35-date-time-and-durations) describes the implemented
  language and gains each part of this decision in the change that implements it.
- Source with the `timestamp` names or with `month` or `year` without `calendar` stops compiling, and so does `date`
  and `datetime` arithmetic with a `duration`. The SexScript importer emits the new forms.
- A `1 day` that meant a calendar day on a `date` or `datetime` is now a compile error, not a silent one-hour shift.
- Each part bumps the plan, snapshot, and checkpoint revisions whose contracts it changes.

## Alternatives considered

- Calendar days by default, as before: matches a wall calendar, but a `duration` then has no fixed length, and the
  common "a week from now" on a moment is an error.
- Local arithmetic on `datetime` without a zone (`datetime + 2 h` moves the displayed fields): useful for calendar grids,
  but a `duration` then no longer means time that passed.
- `date ± D` with a whole number of days, as in `getDate() + 1 day`: shorter for the most common date step, but a
  `day` would then mean a calendar day on a date and 24 hours elsewhere.
- Converting old `save` values when they are read: keeps progress across the change, but adds a conversion path to
  every reader of saved data before any release has saved data to keep.
