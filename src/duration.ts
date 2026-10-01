import type { DurationLiteral, DurationUnit } from "./ast.js";

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

const CALENDAR_UNIT_NAMES: ReadonlySet<string> = new Set([
  "d",
  "day",
  "days",
  "w",
  "week",
  "weeks",
  "mo",
  "month",
  "months",
]);

/** Resolves a short or long elapsed-time unit name. */
export function elapsedDurationUnit(name: string): DurationUnit | undefined {
  return ELAPSED_UNIT_NAMES.get(name);
}

/** Recognizes V30 calendar duration units, which are not implemented yet. */
export function isCalendarDurationUnit(name: string): boolean {
  return CALENDAR_UNIT_NAMES.has(name);
}

export function durationLiteralMilliseconds(literal: DurationLiteral): number {
  return literal.amount.value * DURATION_UNIT_MILLISECONDS[literal.unit];
}

/**
 * Deterministic visible text for a duration, such as `1 h 2 min 3.5 s` or `250 ms`.
 * Locale-aware presentation is later Player work.
 */
export function formatDuration(milliseconds: number): string {
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
