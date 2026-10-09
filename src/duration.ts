import type { CalendarDurationUnit, DurationLiteral, DurationUnit } from "./ast.js";

/** Exact milliseconds per exact unit (ADR 0026): a day is 24 hours and a week 168 hours. */
export const DURATION_UNIT_MILLISECONDS: Readonly<Record<DurationUnit, number>> = Object.freeze({
  ms: 1,
  s: 1_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
});

const ELAPSED_UNIT_NAMES: ReadonlyMap<string, DurationUnit> = new Map([
  ["ms", "ms"],
  ["millisecond", "ms"],
  ["milliseconds", "ms"],
  ["s", "s"],
  ["second", "s"],
  ["seconds", "s"],
  ["min", "min"],
  ["minute", "min"],
  ["minutes", "min"],
  ["h", "h"],
  ["hour", "h"],
  ["hours", "h"],
  ["d", "d"],
  ["day", "d"],
  ["days", "d"],
  ["w", "w"],
  ["week", "w"],
  ["weeks", "w"],
]);

const CALENDAR_UNIT_NAMES: ReadonlyMap<string, CalendarDurationUnit> = new Map([
  ["d", "d"],
  ["day", "d"],
  ["days", "d"],
  ["w", "w"],
  ["week", "w"],
  ["weeks", "w"],
  ["mo", "mo"],
  ["month", "mo"],
  ["months", "mo"],
  ["y", "y"],
  ["year", "y"],
  ["years", "y"],
]);

/** Resolves a short or long exact unit name, from milliseconds to weeks. */
export function elapsedDurationUnit(name: string): DurationUnit | undefined {
  return ELAPSED_UNIT_NAMES.get(name);
}

/** Resolves a short or long unit name after `calendar`: days, weeks, months, or years. */
export function calendarDurationUnit(name: string): CalendarDurationUnit | undefined {
  return CALENDAR_UNIT_NAMES.get(name);
}

/**
 * Why an exact duration has no property `name` (ADR 0026): a unit name such as `days` gets the division that gives
 * its number, as in `span / 1 day`.
 */
export function durationPropertyMessage(name: string, label = "value"): string {
  if (elapsedDurationUnit(name) === undefined) return `A duration has no property '${name}'.`;
  const unit = name.length > 2 && name.endsWith("s") ? name.slice(0, -1) : name;
  return `A duration has no property '${name}'. Divide it by a unit, as in '${label} / 1 ${unit}'.`;
}

/**
 * The components of a calendar duration (ADR 0026): whole calendar months and days, and an exact offset in
 * milliseconds. A calendar week is 7 days and a calendar year 12 months. Applied, months come first, then days.
 */
export interface DurationParts {
  readonly months: number;
  readonly days: number;
  readonly milliseconds: number;
}

/** An exact duration as a runtime value or plan stores it. */
export interface StoredDuration {
  readonly kind: "duration";
  readonly milliseconds: number;
}

/** A calendar duration as a runtime value or plan stores it; it keeps its kind also when every part is zero. */
export interface StoredCalendarDuration extends DurationParts {
  readonly kind: "calendarDuration";
}

export type AnyDuration = StoredDuration | StoredCalendarDuration;

/** Whether a record is an exact duration with a finite `milliseconds` and exactly these keys besides. */
export function isStoredDurationRecord(
  value: Record<string, unknown>,
  otherKeys: readonly string[] = [],
): boolean {
  return (
    hasExactly(value, ["kind", "milliseconds", ...otherKeys]) &&
    value.kind === "duration" &&
    typeof value.milliseconds === "number" &&
    Number.isFinite(value.milliseconds)
  );
}

/**
 * Whether a record is a calendar duration with whole `months` and `days`, a finite `milliseconds`, and exactly these
 * keys besides.
 */
export function isStoredCalendarDurationRecord(
  value: Record<string, unknown>,
  otherKeys: readonly string[] = [],
): boolean {
  return (
    hasExactly(value, ["kind", "months", "days", "milliseconds", ...otherKeys]) &&
    value.kind === "calendarDuration" &&
    Number.isSafeInteger(value.months) &&
    Number.isSafeInteger(value.days) &&
    typeof value.milliseconds === "number" &&
    Number.isFinite(value.milliseconds)
  );
}

function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

export function isCalendar(duration: AnyDuration): duration is StoredCalendarDuration {
  return duration.kind === "calendarDuration";
}

/** The components of a duration; an exact one has no calendar months or days. */
export function durationParts(duration: AnyDuration): DurationParts {
  return isCalendar(duration)
    ? { months: duration.months, days: duration.days, milliseconds: duration.milliseconds }
    : { months: 0, days: 0, milliseconds: duration.milliseconds };
}

export function exactDuration(milliseconds: number): StoredDuration {
  return { kind: "duration", milliseconds: milliseconds === 0 ? 0 : milliseconds };
}

export function calendarDuration(parts: DurationParts): StoredCalendarDuration {
  return {
    kind: "calendarDuration",
    months: parts.months === 0 ? 0 : parts.months,
    days: parts.days === 0 ? 0 : parts.days,
    milliseconds: parts.milliseconds === 0 ? 0 : parts.milliseconds,
  };
}

/**
 * The value of a duration literal, or why it has none. `2 days` is exact; a calendar amount must give whole days or
 * months, so `0.5 calendar years` is 6 months while `1.5 calendar days` and `1.5 calendar weeks` are errors.
 */
export function durationLiteralValue(literal: DurationLiteral): AnyDuration | string {
  const amount = literal.amount.value;
  if (!literal.calendar) return exactDuration(amount * DURATION_UNIT_MILLISECONDS[literal.unit]);
  switch (literal.unit) {
    case "d":
    case "w": {
      const days = amount * (literal.unit === "w" ? 7 : 1);
      return Number.isInteger(days)
        ? calendarDuration({ months: 0, days, milliseconds: 0 })
        : `${amount} calendar ${literal.unit === "w" ? "weeks" : "days"} is not a whole number of days`;
    }
    default: {
      const months = amount * (literal.unit === "y" ? 12 : 1);
      return Number.isInteger(months)
        ? calendarDuration({ months, days: 0, milliseconds: 0 })
        : `${amount} calendar ${literal.unit === "y" ? "years" : "months"} is not a whole number of months`;
    }
  }
}

/**
 * The family of a calendar duration (ADR 0026): months only, days only, or exact offset only. Zero belongs to every
 * family; a duration with parts of two families belongs to none.
 */
export type DurationFamily = "zero" | "exact" | "days" | "months" | "mixed";

export function durationFamily(parts: DurationParts): DurationFamily {
  const families: DurationFamily[] = [];
  if (parts.milliseconds !== 0) families.push("exact");
  if (parts.days !== 0) families.push("days");
  if (parts.months !== 0) families.push("months");
  return families.length === 0 ? "zero" : families.length === 1 ? families[0]! : "mixed";
}

/** Two durations added or subtracted: a calendar duration when either is one, also when the result is zero. */
export function addDurations(left: AnyDuration, right: AnyDuration, sign: 1 | -1 = 1): AnyDuration {
  if (!isCalendar(left) && !isCalendar(right))
    return exactDuration(left.milliseconds + sign * right.milliseconds);
  const [a, b] = [durationParts(left), durationParts(right)];
  return calendarDuration({
    months: a.months + sign * b.months,
    days: a.days + sign * b.days,
    milliseconds: a.milliseconds + sign * b.milliseconds,
  });
}

export function negateDuration(duration: AnyDuration): AnyDuration {
  return isCalendar(duration)
    ? calendarDuration({
        months: -duration.months,
        days: -duration.days,
        milliseconds: -duration.milliseconds,
      })
    : exactDuration(-duration.milliseconds);
}

/** Why a calendar duration and an exact one have no order or ratio. */
const MIXED_DURATIONS = "a calendar day or month has no fixed length";

/** A duration times a number, or why not: calendar parts must stay whole, so `1 calendar month * 1.5` is an error. */
export function scaleDuration(duration: AnyDuration, factor: number): AnyDuration | string {
  if (!isCalendar(duration)) return exactDuration(duration.milliseconds * factor);
  const months = duration.months * factor;
  const days = duration.days * factor;
  if (!Number.isInteger(months) || !Number.isInteger(days))
    return "a calendar duration must stay a whole number of days and months";
  return calendarDuration({ months, days, milliseconds: duration.milliseconds * factor });
}

/** Why a division of a duration has no result when its divisor is zero. */
export const ZERO_DIVISOR = "the divisor is zero";

/** A duration divided by a number, or why not: calendar parts must stay whole and the divisor must not be zero. */
export function divideDuration(duration: AnyDuration, divisor: number): AnyDuration | string {
  if (divisor === 0) return ZERO_DIVISOR;
  if (!isCalendar(duration)) return exactDuration(duration.milliseconds / divisor);
  const months = duration.months / divisor;
  const days = duration.days / divisor;
  if (!Number.isInteger(months) || !Number.isInteger(days))
    return "a calendar duration must stay a whole number of days and months";
  return calendarDuration({ months, days, milliseconds: duration.milliseconds / divisor });
}

/**
 * The ratio of two durations, or why there is none: exact durations always have one, calendar durations only within
 * one family, and a calendar duration and an exact one never. A zero divisor is an error. `18 calendar months /
 * 1 calendar year` is `1.5`.
 */
export function durationQuotient(dividend: AnyDuration, divisor: AnyDuration): number | string {
  if (isCalendar(dividend) !== isCalendar(divisor)) return MIXED_DURATIONS;
  if (!isCalendar(dividend))
    return divisor.milliseconds === 0 ? ZERO_DIVISOR : dividend.milliseconds / divisor.milliseconds;
  const [a, b] = [durationParts(dividend), durationParts(divisor)];
  const family = sharedFamily(a, b);
  if (typeof family !== "string") return family.problem;
  if (family === "zero" || familyAmount(b, family) === 0) return ZERO_DIVISOR;
  return familyAmount(a, family) / familyAmount(b, family);
}

/** The order of two durations (-1, 0, or 1) under the same rules as their ratio, or why they cannot be ordered. */
export function compareDurations(left: AnyDuration, right: AnyDuration): number | string {
  if (isCalendar(left) !== isCalendar(right)) return MIXED_DURATIONS;
  if (!isCalendar(left)) return Math.sign(left.milliseconds - right.milliseconds);
  const [a, b] = [durationParts(left), durationParts(right)];
  const family = sharedFamily(a, b);
  if (typeof family !== "string") return family.problem;
  if (family === "zero") return 0;
  return Math.sign(familyAmount(a, family) - familyAmount(b, family));
}

function sharedFamily(
  left: DurationParts,
  right: DurationParts,
): Exclude<DurationFamily, "mixed"> | { readonly problem: string } {
  const a = durationFamily(left);
  const b = durationFamily(right);
  const problem = {
    problem:
      "calendar durations compare and divide only within one kind: months with months, days with days, and exact time with exact time",
  };
  if (a === "mixed" || b === "mixed") return problem;
  if (a === "zero") return b;
  return b === "zero" || a === b ? a : problem;
}

function familyAmount(parts: DurationParts, family: "exact" | "days" | "months"): number {
  return family === "exact" ? parts.milliseconds : family === "days" ? parts.days : parts.months;
}

/**
 * Deterministic visible text for a duration (ADR 0026), with unit words in full, singular only for exactly 1: an exact
 * one in days, hours, minutes, and seconds, such as `2 days 6 hours` or `1 minute 3.5 seconds`, and `250 milliseconds`
 * below a second; a calendar one names each calendar part, with 12 months as a year, before any exact offset, such as
 * `1 calendar month 16 calendar days`. Each part keeps its own sign. Locale-aware duration presentation is later Player
 * work.
 */
export function formatDuration(duration: number | AnyDuration): string {
  if (typeof duration === "number" || !isCalendar(duration))
    return formatExact(typeof duration === "number" ? duration : duration.milliseconds);
  const years = Math.trunc(duration.months / 12);
  const pieces = [
    calendarPart(years, "year"),
    calendarPart(duration.months - years * 12, "month"),
    calendarPart(duration.days, "day"),
  ].filter((piece) => piece !== "");
  if (duration.milliseconds !== 0) pieces.push(formatExact(duration.milliseconds));
  return pieces.length === 0 ? "0 calendar days" : pieces.join(" ");
}

function calendarPart(amount: number, unit: "year" | "month" | "day"): string {
  return amount === 0 ? "" : `${amount} calendar ${unit}${Math.abs(amount) === 1 ? "" : "s"}`;
}

function formatExact(milliseconds: number): string {
  const sign = milliseconds < 0 ? "-" : "";
  let rest = Math.abs(milliseconds);
  if (rest === 0) return "0 seconds";
  if (rest < 1_000) return `${sign}${unitAmount(formatNumber(rest), "millisecond")}`;
  const parts: string[] = [];
  const days = Math.floor(rest / 86_400_000);
  rest -= days * 86_400_000;
  const hours = Math.floor(rest / 3_600_000);
  rest -= hours * 3_600_000;
  const minutes = Math.floor(rest / 60_000);
  rest -= minutes * 60_000;
  if (days > 0) parts.push(unitAmount(String(days), "day"));
  if (hours > 0) parts.push(unitAmount(String(hours), "hour"));
  if (minutes > 0) parts.push(unitAmount(String(minutes), "minute"));
  if (rest > 0) parts.push(unitAmount(formatNumber(rest / 1_000), "second"));
  return sign + parts.join(" ");
}

/** An amount with its unit word in full, singular only for exactly 1. */
function unitAmount(amount: string, unit: string): string {
  return `${amount} ${unit}${amount === "1" ? "" : "s"}`;
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}
