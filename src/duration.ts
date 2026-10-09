import type { CalendarDurationUnit, DurationLiteral, DurationUnit } from "./ast.js";

/** Exact elapsed milliseconds per V30 §35 elapsed-time unit. */
export const DURATION_UNIT_MILLISECONDS: Readonly<Record<DurationUnit, number>> = Object.freeze({
  ms: 1,
  s: 1_000,
  min: 60_000,
  h: 3_600_000,
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

/** Resolves a short or long elapsed-time unit name. */
export function elapsedDurationUnit(name: string): DurationUnit | undefined {
  return ELAPSED_UNIT_NAMES.get(name);
}

/** Resolves a short or long calendar unit name: days, weeks, months, or years. */
export function calendarDurationUnit(name: string): CalendarDurationUnit | undefined {
  return CALENDAR_UNIT_NAMES.get(name);
}

/**
 * A duration's normalized parts (V30 §35): whole calendar months and days, and exact milliseconds. A week is 7 days and
 * a year 12 months. Calendar parts apply first, months then days, before the exact time.
 */
export interface DurationParts {
  readonly months: number;
  readonly days: number;
  readonly milliseconds: number;
}

/** A duration as a runtime value or plan stores it: calendar parts only when they are not zero. */
export interface StoredDuration {
  readonly kind: "duration";
  readonly milliseconds: number;
  readonly months?: number;
  readonly days?: number;
}

/**
 * Whether a record is a stored duration with exactly these keys besides its parts: a finite `milliseconds`, and
 * `months` and `days` only when they are whole and not zero.
 */
export function isStoredDurationRecord(
  value: Record<string, unknown>,
  otherKeys: readonly string[] = [],
): boolean {
  const optional = ["months", "days"].filter((key) => Object.hasOwn(value, key));
  const keys = ["kind", "milliseconds", ...optional, ...otherKeys];
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    value.kind === "duration" &&
    typeof value.milliseconds === "number" &&
    Number.isFinite(value.milliseconds) &&
    optional.every((key) => {
      const part = value[key];
      return typeof part === "number" && Number.isSafeInteger(part) && part !== 0;
    })
  );
}

export function durationParts(duration: StoredDuration): DurationParts {
  return {
    months: duration.months ?? 0,
    days: duration.days ?? 0,
    milliseconds: duration.milliseconds,
  };
}

export function storedDuration(parts: DurationParts): StoredDuration {
  return {
    kind: "duration",
    milliseconds: parts.milliseconds === 0 ? 0 : parts.milliseconds,
    ...(parts.months === 0 ? {} : { months: parts.months }),
    ...(parts.days === 0 ? {} : { days: parts.days }),
  };
}

/**
 * The parts of a duration literal, or why it has none: a calendar amount must give whole days or months, so `0.5 years`
 * is 6 months while `1.5 days` and `1.5 weeks` are errors.
 */
export function durationLiteralParts(literal: DurationLiteral): DurationParts | string {
  const amount = literal.amount.value;
  switch (literal.unit) {
    case "d":
    case "w": {
      const days = amount * (literal.unit === "w" ? 7 : 1);
      return Number.isInteger(days)
        ? { months: 0, days, milliseconds: 0 }
        : `${amount} ${literal.unit === "w" ? "weeks" : "days"} is not a whole number of days`;
    }
    case "mo":
    case "y": {
      const months = amount * (literal.unit === "y" ? 12 : 1);
      return Number.isInteger(months)
        ? { months, days: 0, milliseconds: 0 }
        : `${amount} ${literal.unit === "y" ? "years" : "months"} is not a whole number of months`;
    }
    default:
      return {
        months: 0,
        days: 0,
        milliseconds: amount * DURATION_UNIT_MILLISECONDS[literal.unit],
      };
  }
}

/** Whether a duration is exact elapsed time, without calendar days or months. */
export function isExactDuration(parts: DurationParts): boolean {
  return parts.months === 0 && parts.days === 0;
}

/**
 * The family of a duration (V30 §35): exact time, days and weeks, or months and years. Zero belongs to every family; a
 * duration with parts of two families belongs to none.
 */
export type DurationFamily = "zero" | "exact" | "days" | "months" | "mixed";

export function durationFamily(parts: DurationParts): DurationFamily {
  const families: DurationFamily[] = [];
  if (parts.milliseconds !== 0) families.push("exact");
  if (parts.days !== 0) families.push("days");
  if (parts.months !== 0) families.push("months");
  return families.length === 0 ? "zero" : families.length === 1 ? families[0]! : "mixed";
}

export function addDurationParts(
  left: DurationParts,
  right: DurationParts,
  sign: 1 | -1 = 1,
): DurationParts {
  return {
    months: left.months + sign * right.months,
    days: left.days + sign * right.days,
    milliseconds: left.milliseconds + sign * right.milliseconds,
  };
}

export function negateDurationParts(parts: DurationParts): DurationParts {
  return { months: -parts.months, days: -parts.days, milliseconds: -parts.milliseconds };
}

/** A duration times a number, or why not: calendar parts must stay whole, so `1 month * 1.5` is an error. */
export function scaleDurationParts(parts: DurationParts, factor: number): DurationParts | string {
  const months = parts.months * factor;
  const days = parts.days * factor;
  if (!Number.isInteger(months) || !Number.isInteger(days))
    return "a calendar duration must stay a whole number of days and months";
  return {
    months: months === 0 ? 0 : months,
    days: days === 0 ? 0 : days,
    milliseconds: parts.milliseconds * factor,
  };
}

/** Why a division of a duration has no result when its divisor is zero. */
export const ZERO_DIVISOR = "the divisor is zero";

/** A duration divided by a number, or why not: calendar parts must stay whole and the divisor must not be zero. */
export function divideDurationParts(parts: DurationParts, divisor: number): DurationParts | string {
  if (divisor === 0) return ZERO_DIVISOR;
  const months = parts.months / divisor;
  const days = parts.days / divisor;
  if (!Number.isInteger(months) || !Number.isInteger(days))
    return "a calendar duration must stay a whole number of days and months";
  return {
    months: months === 0 ? 0 : months,
    days: days === 0 ? 0 : days,
    milliseconds: parts.milliseconds / divisor,
  };
}

/**
 * The ratio of two durations of one family, or why there is none: across families there is no fixed ratio, and a zero
 * divisor is an error. `18 months / 1 year` is `1.5`.
 */
export function durationRatio(dividend: DurationParts, divisor: DurationParts): number | string {
  const family = sharedFamily(dividend, divisor);
  if (typeof family !== "string") return family.problem;
  if (family === "zero" || familyAmount(divisor, family) === 0) return ZERO_DIVISOR;
  return familyAmount(dividend, family) / familyAmount(divisor, family);
}

/** The order of two durations of one family (-1, 0, or 1), or why they cannot be ordered. */
export function compareDurationParts(left: DurationParts, right: DurationParts): number | string {
  const family = sharedFamily(left, right);
  if (typeof family !== "string") return family.problem;
  if (family === "zero") return 0;
  return Math.sign(familyAmount(left, family) - familyAmount(right, family));
}

function sharedFamily(
  left: DurationParts,
  right: DurationParts,
): Exclude<DurationFamily, "mixed"> | { readonly problem: string } {
  const a = durationFamily(left);
  const b = durationFamily(right);
  const problem = {
    problem:
      "only durations of one kind compare or divide: exact time with exact time, days and weeks with days and weeks, months and years with months and years",
  };
  if (a === "mixed" || b === "mixed") return problem;
  if (a === "zero") return b;
  return b === "zero" || a === b ? a : problem;
}

function familyAmount(parts: DurationParts, family: "exact" | "days" | "months"): number {
  return family === "exact" ? parts.milliseconds : family === "days" ? parts.days : parts.months;
}

/**
 * Deterministic visible text for a duration, such as `1 h 2 min 3.5 s`, `250 ms`, or `1 y 2 mo 3 d`. Each part keeps its
 * own sign. Locale-aware duration presentation is later Player work.
 */
export function formatDuration(duration: number | DurationParts): string {
  const parts =
    typeof duration === "number" ? { months: 0, days: 0, milliseconds: duration } : duration;
  const pieces: string[] = [];
  const years = Math.trunc(parts.months / 12);
  const months = parts.months - years * 12;
  if (years !== 0) pieces.push(`${years} y`);
  if (months !== 0) pieces.push(`${months} mo`);
  if (parts.days !== 0) pieces.push(`${parts.days} d`);
  if (parts.milliseconds !== 0 || pieces.length === 0) pieces.push(formatExact(parts.milliseconds));
  return pieces.join(" ");
}

function formatExact(milliseconds: number): string {
  const sign = milliseconds < 0 ? "-" : "";
  let rest = Math.abs(milliseconds);
  if (rest === 0) return "0 s";
  if (rest < 1_000) return `${sign}${formatNumber(rest)} ms`;
  const parts: string[] = [];
  const hours = Math.floor(rest / 3_600_000);
  rest -= hours * 3_600_000;
  const minutes = Math.floor(rest / 60_000);
  rest -= minutes * 60_000;
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (rest > 0) parts.push(`${formatNumber(rest / 1_000)} s`);
  return sign + parts.join(" ");
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}
