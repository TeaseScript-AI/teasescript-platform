/**
 * Calendar, clock, ISO text, zone-rule, and presentation arithmetic for the V30 §35 temporal values (#532). Everything
 * here is pure: it reads no clock and calls no `Intl` API. Zone rules and presentation settings are plain data that the
 * host captures (see `temporal-capture.ts`), so a restored or replayed session computes the same local times and text on
 * every host.
 */

import { hasExactKeys, isRecord } from "./plan/validation-support.js";

/** A calendar date in the proleptic Gregorian calendar, years 0000 through 9999. */
export interface DateFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** A clock time with whole milliseconds and no midnight wrap: 00:00 through 23:59:59.999. */
export interface TimeFields {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

export interface DateTimeFields extends DateFields, TimeFields {}

const MIN_YEAR = 0;
const MAX_YEAR = 9999;

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const WEEKDAY_NAMES = Object.freeze([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);

const MONTH_NAMES = Object.freeze([
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]);

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function isValidDate(fields: DateFields): boolean {
  return (
    isWholeInRange(fields.year, MIN_YEAR, MAX_YEAR) &&
    isWholeInRange(fields.month, 1, 12) &&
    isWholeInRange(fields.day, 1, daysInMonth(fields.year, fields.month))
  );
}

export function isValidTime(fields: TimeFields): boolean {
  return (
    isWholeInRange(fields.hour, 0, 23) &&
    isWholeInRange(fields.minute, 0, 59) &&
    isWholeInRange(fields.second, 0, 59) &&
    isWholeInRange(fields.millisecond, 0, 999)
  );
}

/** ISO weekday number: Monday is 1 and Sunday is 7. */
export function isoWeekdayNumber(date: DateFields): number {
  return ((((daysFromEpoch(date) + 3) % 7) + 7) % 7) + 1;
}

/** The English weekday name, such as `"Saturday"`. */
export function weekdayName(date: DateFields): string {
  return WEEKDAY_NAMES[isoWeekdayNumber(date) - 1]!;
}

/**
 * A date moved by whole months and then whole days (V30 §35): a day the target month lacks becomes its last day, so
 * January 31 plus one month is February 28 or 29. `undefined` outside the years 0000 to 9999.
 */
export function addCalendarParts(
  date: DateFields,
  months: number,
  days: number,
): DateFields | undefined {
  const monthIndex = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  if (year < MIN_YEAR || year > MAX_YEAR) return undefined;
  const clamped = { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
  const moved = dateFromEpochDays(daysFromEpoch(clamped) + days);
  return moved.year < MIN_YEAR || moved.year > MAX_YEAR ? undefined : moved;
}

/** The whole calendar days from `right` to `left`. */
export function daysBetween(left: DateFields, right: DateFields): number {
  return daysFromEpoch(left) - daysFromEpoch(right);
}

/** A date and time read as if it were UTC, in milliseconds since the epoch, to measure the time between two. */
export function dateTimeMilliseconds(fields: DateTimeFields): number {
  return fieldsAsUtc(fields);
}

export function compareDates(left: DateFields, right: DateFields): number {
  return Math.sign(daysFromEpoch(left) - daysFromEpoch(right));
}

export function compareTimes(left: TimeFields, right: TimeFields): number {
  return Math.sign(millisecondOfDay(left) - millisecondOfDay(right));
}

export function compareDateTimes(left: DateTimeFields, right: DateTimeFields): number {
  return Math.sign(fieldsAsUtc(left) - fieldsAsUtc(right));
}

/** The earliest and latest representable timestamps: 0000-01-01T00:00:00Z and 9999-12-31T23:59:59.999Z. */
export const MIN_EPOCH_MILLISECONDS =
  daysFromEpoch({ year: MIN_YEAR, month: 1, day: 1 }) * MS_PER_DAY;
export const MAX_EPOCH_MILLISECONDS =
  daysFromEpoch({ year: MAX_YEAR, month: 12, day: 31 }) * MS_PER_DAY + MS_PER_DAY - 1;

export function isValidEpochMilliseconds(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_EPOCH_MILLISECONDS &&
    value <= MAX_EPOCH_MILLISECONDS
  );
}

/** The UTC date and time of a valid timestamp. */
export function utcFields(epochMilliseconds: number): DateTimeFields {
  const days = Math.floor(epochMilliseconds / MS_PER_DAY);
  let rest = epochMilliseconds - days * MS_PER_DAY;
  const hour = Math.floor(rest / MS_PER_HOUR);
  rest -= hour * MS_PER_HOUR;
  const minute = Math.floor(rest / MS_PER_MINUTE);
  rest -= minute * MS_PER_MINUTE;
  const second = Math.floor(rest / MS_PER_SECOND);
  return {
    ...dateFromEpochDays(days),
    hour,
    minute,
    second,
    millisecond: rest - second * MS_PER_SECOND,
  };
}

/** Rounds to a whole millisecond with ties away from zero, as an exact duration part is applied to a temporal value. */
export function roundToMillisecond(milliseconds: number): number {
  const rounded = Math.sign(milliseconds) * Math.round(Math.abs(milliseconds));
  return rounded === 0 ? 0 : rounded;
}

// ---------------------------------------------------------------------------------------------------------------------
// Strict ISO text

/**
 * The result of reading temporal text or converting through a zone. `reason` explains a failure, such as
 * `"February 2026 has 28 days"`; it is `null` when text does not have the ISO form at all.
 */
export type TemporalResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string | null };

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/u;
const TIME_TEXT = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u;
const OFFSET_TEXT = /^(?:Z|([+-])(\d{2}):(\d{2}))$/u;

/** Reads `YYYY-MM-DD`. */
export function parseIsoDate(text: string): TemporalResult<DateFields> {
  const match = DATE_TEXT.exec(text);
  if (match === null) return { ok: false, reason: null };
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const reason = dateProblem(date);
  return reason === null ? { ok: true, value: date } : { ok: false, reason };
}

/** Reads `HH:MM`, `HH:MM:SS`, or `HH:MM:SS.f` with one to three fraction digits. */
export function parseIsoTime(text: string): TemporalResult<TimeFields> {
  const match = TIME_TEXT.exec(text);
  if (match === null) return { ok: false, reason: null };
  const time = {
    hour: Number(match[1]),
    minute: Number(match[2]),
    second: match[3] === undefined ? 0 : Number(match[3]),
    millisecond: match[4] === undefined ? 0 : Number(match[4].padEnd(3, "0")),
  };
  const reason = timeProblem(time);
  return reason === null ? { ok: true, value: time } : { ok: false, reason };
}

/** Reads a local date and time joined by `T`, without an offset. */
export function parseIsoDateTime(text: string): TemporalResult<DateTimeFields> {
  const separator = text.indexOf("T");
  if (separator < 0) return { ok: false, reason: null };
  const date = parseIsoDate(text.slice(0, separator));
  const time = parseIsoTime(text.slice(separator + 1));
  if (!date.ok) return date;
  if (!time.ok) return time;
  return { ok: true, value: { ...date.value, ...time.value } };
}

/** Reads a date and time with `Z` or a `±HH:MM` offset as a timestamp in epoch milliseconds. */
export function parseIsoTimestamp(text: string): TemporalResult<number> {
  const offsetStart = Math.max(text.lastIndexOf("Z"), text.lastIndexOf("+"), text.lastIndexOf("-"));
  const timeStart = text.indexOf("T");
  if (timeStart < 0 || offsetStart <= timeStart) return { ok: false, reason: null };
  const offset = OFFSET_TEXT.exec(text.slice(offsetStart));
  if (offset === null) return { ok: false, reason: null };
  const local = parseIsoDateTime(text.slice(0, offsetStart));
  if (!local.ok) return local;
  let offsetMinutes = 0;
  if (offset[1] !== undefined) {
    const hours = Number(offset[2]);
    const minutes = Number(offset[3]);
    if (hours > 23 || minutes > 59)
      return { ok: false, reason: `the offset ${text.slice(offsetStart)} does not exist` };
    offsetMinutes = (offset[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
  }
  const epochMilliseconds = fieldsAsUtc(local.value) - offsetMinutes * MS_PER_MINUTE;
  return isValidEpochMilliseconds(epochMilliseconds)
    ? { ok: true, value: epochMilliseconds }
    : { ok: false, reason: "the moment lies outside the years 0000 to 9999 in UTC" };
}

/** `YYYY-MM-DD`. */
export function formatIsoDate(date: DateFields): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

/** `HH:MM`, with `:SS` when the seconds or milliseconds are not zero and `.fff` when the milliseconds are not zero. */
export function formatIsoTime(time: TimeFields): string {
  let text = `${pad(time.hour, 2)}:${pad(time.minute, 2)}`;
  if (time.second !== 0 || time.millisecond !== 0) text += `:${pad(time.second, 2)}`;
  if (time.millisecond !== 0) text += `.${pad(time.millisecond, 3)}`;
  return text;
}

/** `YYYY-MM-DDTHH:MM` with the optional parts of `formatIsoTime`. */
export function formatIsoDateTime(dateTime: DateTimeFields): string {
  return `${formatIsoDate(dateTime)}T${formatIsoTime(dateTime)}`;
}

/** UTC text with seconds and `Z`, such as `2026-10-04T12:30:00Z`, with `.fff` when the milliseconds are not zero. */
export function formatIsoTimestamp(epochMilliseconds: number): string {
  const fields = utcFields(epochMilliseconds);
  const fraction = fields.millisecond === 0 ? "" : `.${pad(fields.millisecond, 3)}`;
  return `${formatIsoDate(fields)}T${pad(fields.hour, 2)}:${pad(fields.minute, 2)}:${pad(fields.second, 2)}${fraction}Z`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Zone rules

/**
 * The UTC offsets of one time zone from 1970 up to 2100, captured by the host. Converting a moment outside that window
 * fails: the rules there are unknown, and guessing them could silently shift a local time.
 */
export interface ZoneRules {
  /** The IANA name, such as `Europe/Amsterdam`. */
  readonly name: string;
  /** The offset at the start of 1970. */
  readonly initialOffsetSeconds: number;
  /** Pairs `[epochMilliseconds, offsetSeconds]`: from that moment on, local time is UTC plus the offset. */
  readonly transitions: readonly (readonly number[])[];
}

/** The captured window: 1970-01-01T00:00Z up to, not including, 2100-01-01T00:00Z. */
export const ZONE_RULES_START_MILLISECONDS = 0;
export const ZONE_RULES_END_MILLISECONDS =
  daysFromEpoch({ year: 2100, month: 1, day: 1 }) * MS_PER_DAY;
const MAX_ZONE_TRANSITIONS = 1_000;
const MAX_OFFSET_SECONDS = 86_399;
const OUTSIDE_ZONE_RULES = "the time-zone rules cover 1970 through 2099";

export const UTC_ZONE_RULES: ZoneRules = Object.freeze({
  name: "UTC",
  initialOffsetSeconds: 0,
  transitions: Object.freeze([]),
});

/** The local date and time of a moment in the zone. */
export function localFields(
  rules: ZoneRules,
  epochMilliseconds: number,
): TemporalResult<DateTimeFields> {
  if (!Number.isSafeInteger(epochMilliseconds))
    return { ok: false, reason: "a moment is a whole number of milliseconds" };
  if (!withinZoneRules(epochMilliseconds)) return { ok: false, reason: OUTSIDE_ZONE_RULES };
  return {
    ok: true,
    value: utcFields(epochMilliseconds + offsetSecondsAt(rules, epochMilliseconds) * MS_PER_SECOND),
  };
}

/**
 * The moment of a local date and time in the zone. A local time that a forward transition skips is moved forward by
 * the skipped length; a local time that a backward transition repeats takes the earlier moment.
 */
export function zonedTimestamp(rules: ZoneRules, local: DateTimeFields): TemporalResult<number> {
  let wall = fieldsAsUtc(local);
  // Each pass finds the earliest moment showing the wall time, or moves the wall time past one skipped range, so the
  // passes end within the number of transitions.
  for (let pass = 0; pass <= rules.transitions.length; pass += 1) {
    const segments = segmentsAround(rules, wall);
    for (let index = 0; index < segments.length; index += 1) {
      const moment = wall - segments[index]!.offset;
      if (moment >= segments[index]!.start && moment < (segments[index + 1]?.start ?? Infinity))
        return withinZoneRules(moment)
          ? { ok: true, value: moment }
          : { ok: false, reason: OUTSIDE_ZONE_RULES };
    }
    // Segment `gap` ends at local time `next.start + offset`, and the next one starts later, at `next.start + next.offset`.
    const gap = segments.findIndex((segment, index) => {
      const next = segments[index + 1];
      return (
        next !== undefined && wall >= next.start + segment.offset && wall < next.start + next.offset
      );
    });
    if (gap < 0) break;
    wall += segments[gap + 1]!.offset - segments[gap]!.offset;
  }
  return { ok: false, reason: OUTSIDE_ZONE_RULES };
}

/** Why `value` is not valid zone rules, or `null`. */
export function zoneRulesProblem(value: unknown): string | null {
  if (!isRecord(value) || !hasExactKeys(value, ["name", "initialOffsetSeconds", "transitions"]))
    return "Zone rules must be { name, initialOffsetSeconds, transitions }.";
  if (typeof value.name !== "string" || !/^[A-Za-z0-9_+\-/]{1,64}$/u.test(value.name))
    return "A zone name must be an IANA name such as Europe/Amsterdam.";
  if (!isOffsetSeconds(value.initialOffsetSeconds))
    return "A zone offset must be whole seconds below one day.";
  const transitions = value.transitions;
  if (!Array.isArray(transitions) || transitions.length > MAX_ZONE_TRANSITIONS)
    return `Zone transitions must be a list of at most ${MAX_ZONE_TRANSITIONS} entries.`;
  let previous = ZONE_RULES_START_MILLISECONDS;
  for (const transition of transitions) {
    if (!Array.isArray(transition) || transition.length !== 2)
      return "A zone transition must be [epochMilliseconds, offsetSeconds].";
    const [moment, offset]: unknown[] = transition;
    if (
      typeof moment !== "number" ||
      !Number.isSafeInteger(moment) ||
      moment <= previous ||
      moment >= ZONE_RULES_END_MILLISECONDS
    )
      return "Zone transitions must be whole milliseconds in increasing order, after 1970 and before 2100.";
    if (!isOffsetSeconds(offset)) return "A zone offset must be whole seconds below one day.";
    previous = moment;
  }
  return null;
}

function withinZoneRules(epochMilliseconds: number): boolean {
  return (
    epochMilliseconds >= ZONE_RULES_START_MILLISECONDS &&
    epochMilliseconds < ZONE_RULES_END_MILLISECONDS
  );
}

function offsetSecondsAt(rules: ZoneRules, epochMilliseconds: number): number {
  let low = 0;
  let high = rules.transitions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rules.transitions[middle]![0]! <= epochMilliseconds) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? rules.initialOffsetSeconds : rules.transitions[low - 1]![1]!;
}

/** The offsets in force around `wall`, as consecutive segments of moments, with offsets in milliseconds. */
function segmentsAround(
  rules: ZoneRules,
  wall: number,
): { readonly start: number; readonly offset: number }[] {
  // Every offset is below one day, so only moments within a day of the wall time can show it.
  const from = wall - MS_PER_DAY;
  const until = wall + MS_PER_DAY;
  const segments = [{ start: -Infinity, offset: offsetSecondsAt(rules, from) * MS_PER_SECOND }];
  for (const transition of rules.transitions) {
    const moment = transition[0]!;
    if (moment > from && moment <= until)
      segments.push({ start: moment, offset: transition[1]! * MS_PER_SECOND });
  }
  return segments;
}

// ---------------------------------------------------------------------------------------------------------------------
// Presentation

export type HourCycle = "h11" | "h12" | "h23" | "h24";

/**
 * How the player's locale writes numeric dates and times, captured by the host so that text does not depend on host
 * locale data. Each template is literal text with the placeholders `{year}`, `{month}`, `{day}`, `{hour}`,
 * `{minute}`, `{second}`, and `{dayPeriod}`, such as `"{month}/{day}/{year}, {hour}:{minute} {dayPeriod}"`. Digits are
 * always 0–9; minutes and seconds always have two digits.
 */
export interface PresentationSettings {
  readonly date: string;
  readonly time: string;
  readonly timeWithSeconds: string;
  readonly dateTime: string;
  readonly dateTimeWithSeconds: string;
  readonly padDay: boolean;
  readonly padMonth: boolean;
  readonly padHour: boolean;
  /** `h11` counts 0–11, `h12` 1–12, `h23` 0–23, and `h24` 1–24. */
  readonly hourCycle: HourCycle;
  /** The morning and afternoon markers for `{dayPeriod}`, such as `["AM", "PM"]`. */
  readonly dayPeriods: readonly [string, string];
}

/** Locale-neutral settings for hosts that capture none: `2026-10-04 18:30`. */
export const DEFAULT_PRESENTATION_SETTINGS: PresentationSettings = Object.freeze({
  date: "{year}-{month}-{day}",
  time: "{hour}:{minute}",
  timeWithSeconds: "{hour}:{minute}:{second}",
  dateTime: "{year}-{month}-{day} {hour}:{minute}",
  dateTimeWithSeconds: "{year}-{month}-{day} {hour}:{minute}:{second}",
  padDay: true,
  padMonth: true,
  padHour: true,
  hourCycle: "h23",
  dayPeriods: Object.freeze(["AM", "PM"] as const),
});

export function presentDate(settings: PresentationSettings, date: DateFields): string {
  return fillTemplate(settings.date, settings, date);
}

/** Hours and minutes, with seconds when they are not zero. Milliseconds are not shown. */
export function presentTime(settings: PresentationSettings, time: TimeFields): string {
  return fillTemplate(time.second === 0 ? settings.time : settings.timeWithSeconds, settings, time);
}

export function presentDateTime(settings: PresentationSettings, dateTime: DateTimeFields): string {
  const template = dateTime.second === 0 ? settings.dateTime : settings.dateTimeWithSeconds;
  return fillTemplate(template, settings, dateTime);
}

/** Why `value` is not valid presentation settings, or `null`. */
export function presentationSettingsProblem(value: unknown): string | null {
  if (!isRecord(value) || !hasExactKeys(value, PRESENTATION_KEYS))
    return `Presentation settings must have exactly ${PRESENTATION_KEYS.join(", ")}.`;
  for (const [key, required] of TEMPLATE_FIELDS) {
    const problem = templateProblem(value[key], required);
    if (problem !== null) return `The ${key} template ${problem}.`;
  }
  for (const key of ["padDay", "padMonth", "padHour"] as const) {
    if (typeof value[key] !== "boolean")
      return `The presentation setting ${key} must be true or false.`;
  }
  if (
    typeof value.hourCycle !== "string" ||
    !["h11", "h12", "h23", "h24"].includes(value.hourCycle)
  )
    return 'The hour cycle must be "h11", "h12", "h23", or "h24".';
  const periods = value.dayPeriods;
  if (
    !Array.isArray(periods) ||
    periods.length !== 2 ||
    !isPresentationText(periods[0], 1, MAX_DAY_PERIOD_LENGTH) ||
    !isPresentationText(periods[1], 1, MAX_DAY_PERIOD_LENGTH)
  )
    return "The day periods must be two short plain texts, such as AM and PM.";
  return null;
}

const DATE_PLACEHOLDERS = ["year", "month", "day"] as const;
const TIME_PLACEHOLDERS = ["hour", "minute"] as const;
const TEMPLATE_FIELDS: readonly (readonly [keyof PresentationSettings, readonly string[]])[] = [
  ["date", DATE_PLACEHOLDERS],
  ["time", TIME_PLACEHOLDERS],
  ["timeWithSeconds", [...TIME_PLACEHOLDERS, "second"]],
  ["dateTime", [...DATE_PLACEHOLDERS, ...TIME_PLACEHOLDERS]],
  ["dateTimeWithSeconds", [...DATE_PLACEHOLDERS, ...TIME_PLACEHOLDERS, "second"]],
];
const PRESENTATION_KEYS = Object.freeze([
  ...TEMPLATE_FIELDS.map(([key]) => key),
  "padDay",
  "padMonth",
  "padHour",
  "hourCycle",
  "dayPeriods",
]);
const PLACEHOLDER = /\{([a-zA-Z]+)\}/gu;
const MAX_TEMPLATE_LENGTH = 80;
const MAX_DAY_PERIOD_LENGTH = 16;

/**
 * Why a template is unusable: it must contain each required placeholder once, may contain `{dayPeriod}` once when it
 * shows the hour, and has no other placeholder, brace, or control character.
 */
function templateProblem(template: unknown, required: readonly string[]): string | null {
  if (!isPresentationText(template, 1, MAX_TEMPLATE_LENGTH))
    return `must be plain text of at most ${MAX_TEMPLATE_LENGTH} characters`;
  const names = Array.from(template.matchAll(PLACEHOLDER), (match) => match[1]!);
  const allowed = required.includes("hour") ? [...required, "dayPeriod"] : required;
  if (
    template.replace(PLACEHOLDER, "").includes("{") ||
    template.replace(PLACEHOLDER, "").includes("}")
  )
    return "has a brace outside a placeholder";
  if (names.some((name) => !allowed.includes(name)) || new Set(names).size !== names.length)
    return `may only use ${allowed.map((name) => `{${name}}`).join(", ")}, each once`;
  if (required.some((name) => !names.includes(name)))
    return `must contain ${required.map((name) => `{${name}}`).join(", ")}`;
  return null;
}

function fillTemplate(
  template: string,
  settings: PresentationSettings,
  fields: Partial<DateTimeFields>,
): string {
  return template.replace(PLACEHOLDER, (_placeholder, name: string) => {
    switch (name) {
      case "year":
        return pad(fields.year!, 4);
      case "month":
        return settings.padMonth ? pad(fields.month!, 2) : String(fields.month);
      case "day":
        return settings.padDay ? pad(fields.day!, 2) : String(fields.day);
      case "hour": {
        const hour = displayedHour(settings.hourCycle, fields.hour!);
        return settings.padHour ? pad(hour, 2) : String(hour);
      }
      case "minute":
        return pad(fields.minute!, 2);
      case "second":
        return pad(fields.second!, 2);
      default:
        return settings.dayPeriods[fields.hour! < 12 ? 0 : 1];
    }
  });
}

function displayedHour(cycle: HourCycle, hour: number): number {
  switch (cycle) {
    case "h11":
      return hour % 12;
    case "h12":
      return ((hour + 11) % 12) + 1;
    case "h23":
      return hour;
    case "h24":
      return hour === 0 ? 24 : hour;
  }
}

function isPresentationText(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimumLength &&
    value.length <= maximumLength &&
    !/[\p{Cc}\u2028\u2029]/u.test(value)
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Session context

/** What the host captured about the player for a session: the zone rules and the numeric presentation. */
export interface TemporalContext {
  readonly zone: ZoneRules;
  readonly presentation: PresentationSettings;
}

/** Why `value` is not a valid temporal context, or `null`. */
export function temporalContextProblem(value: unknown): string | null {
  if (!isRecord(value) || !hasExactKeys(value, ["zone", "presentation"]))
    return "A temporal context must be { zone, presentation }.";
  return zoneRulesProblem(value.zone) ?? presentationSettingsProblem(value.presentation);
}

/** Contexts that `frozenTemporalContext` made: deeply frozen, so snapshots can share them. */
const frozenContexts = new WeakSet<TemporalContext>();

/**
 * A deeply frozen copy of a valid temporal context, or the context itself when this function froze it. Frozen contexts
 * are shared between snapshots instead of copying their zone transitions.
 */
export function frozenTemporalContext(context: TemporalContext): TemporalContext {
  if (frozenContexts.has(context)) return context;
  const frozen: TemporalContext = Object.freeze({
    zone: Object.freeze({
      name: context.zone.name,
      initialOffsetSeconds: context.zone.initialOffsetSeconds,
      transitions: Object.freeze(
        context.zone.transitions.map((transition) => Object.freeze([...transition])),
      ),
    }),
    presentation: Object.freeze({
      ...context.presentation,
      dayPeriods: Object.freeze([...context.presentation.dayPeriods] as const),
    }),
  });
  frozenContexts.add(frozen);
  return frozen;
}

/** UTC with locale-neutral presentation, for hosts that capture nothing, such as tests and command-line tools. */
export const DEFAULT_TEMPORAL_CONTEXT: TemporalContext = frozenTemporalContext({
  zone: UTC_ZONE_RULES,
  presentation: DEFAULT_PRESENTATION_SETTINGS,
});

// ---------------------------------------------------------------------------------------------------------------------
// Shared helpers

/** Days since 1970-01-01 (H. Hinnant's `days_from_civil`), valid for every proleptic Gregorian date. */
function daysFromEpoch(date: DateFields): number {
  const year = date.month <= 2 ? date.year - 1 : date.year;
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const dayOfYear = Math.floor((153 * ((date.month + 9) % 12) + 2) / 5) + date.day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** The inverse of `daysFromEpoch`. */
function dateFromEpochDays(days: number): DateFields {
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1_460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  return {
    year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0),
    month,
    day: dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1,
  };
}

/** The date and time read as if they were UTC, in milliseconds since the epoch. */
function fieldsAsUtc(fields: DateTimeFields): number {
  return daysFromEpoch(fields) * MS_PER_DAY + millisecondOfDay(fields);
}

function millisecondOfDay(time: TimeFields): number {
  return (
    time.hour * MS_PER_HOUR +
    time.minute * MS_PER_MINUTE +
    time.second * MS_PER_SECOND +
    time.millisecond
  );
}

function dateProblem(date: DateFields): string | null {
  if (date.month < 1 || date.month > 12) return `there is no month ${date.month}`;
  const length = daysInMonth(date.year, date.month);
  if (date.day < 1 || date.day > length)
    return date.day < 1
      ? "there is no day 0"
      : `${MONTH_NAMES[date.month - 1]} ${pad(date.year, 4)} has ${length} days`;
  return null;
}

function timeProblem(time: TimeFields): string | null {
  if (time.hour === 24) return "there is no hour 24; midnight is 00:00";
  if (time.hour > 23) return `there is no hour ${time.hour}`;
  if (time.minute > 59) return `there is no minute ${time.minute}`;
  if (time.second > 59) return `there is no second ${time.second}`;
  return null;
}

function isOffsetSeconds(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= MAX_OFFSET_SECONDS
  );
}

function isWholeInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
