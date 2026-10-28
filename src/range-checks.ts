import type { DurationUnit } from "./ast.js";
import { withoutNegativeZero } from "./conversions.js";
import { DURATION_UNIT_MILLISECONDS, formatDuration } from "./duration.js";

/**
 * The rules of a range that `for` goes through, `randomInteger` draws from, `toList` gives, or a wait or timer counts in
 * units (V30 §6), each with one message: compile error `TSV010` where the compiler knows the problem, and otherwise the
 * runtime error named at each rule.
 */
export interface RangeBounds {
  readonly start: number;
  readonly end: number;
  readonly inclusive: boolean;
}

/** A range as the source writes it, such as `1..=6`. */
export function rangeText(range: RangeBounds): string {
  return `${withoutNegativeZero(range.start)}${range.inclusive ? "..=" : ".."}${withoutNegativeZero(range.end)}`;
}

/**
 * A range bound is a number (runtime error `TSR027`), as a rule that names the range and the bound where the source
 * spells both bounds, such as "'low..=3' needs a number for 'low'", and otherwise the bound's place.
 */
export function rangeBoundRule(
  start: string | null,
  end: string | null,
  inclusive: boolean,
  bound: "start" | "end",
): string {
  const label = bound === "start" ? start : end;
  return `${start === null || end === null ? "A range" : `'${start}${inclusive ? "..=" : ".."}${end}'`} needs a number ${label === null ? `as its ${bound}` : `for '${label}'`}`;
}

/** How many whole numbers a range of whole numbers holds. */
export function rangeLength(range: RangeBounds): number {
  return Math.max(0, range.end - range.start + (range.inclusive ? 1 : 0));
}

/**
 * `subject` counts whole numbers, but `shown` says what it got, such as "this range is 1.5..=3" (runtime error
 * `TSR045`). `why` explains it, from a space.
 */
export function wholeRangeMessage(subject: string, shown: string, why = ""): string {
  return `${subject} needs a range of whole numbers, but ${shown}.${why} Round the bounds with the floor, round or ceil function first.`;
}

/** Why `subject` cannot draw from a range of whole numbers that holds none, or `null` (runtime error `TSR041`). */
export function emptyRangeProblem(subject: string, range: RangeBounds): string | null {
  return rangeLength(range) >= 1
    ? null
    : `${subject} needs a range that holds at least one whole number, but ${rangeText(range)} holds none. Check that the range is not empty first.`;
}

/**
 * Why a wait or timer cannot count `unit`s from `start`, the start of the range that `shown` describes, such as "this
 * range is -1..=3", or `null` (runtime error `TSR050`): no length is below zero, and no round of a repeating timer is
 * zero long.
 */
export function rangeStartProblem(
  command: "wait" | "timer",
  repeat: boolean,
  start: number,
  unit: DurationUnit,
  shown: string,
): string | null {
  if (repeat)
    return start < 1
      ? `A repeating timer needs every round to last longer than zero, but this range can draw ${formatDuration(start * DURATION_UNIT_MILLISECONDS[unit])}. Start the range at 1 or more.`
      : null;
  return start < 0 ? `A ${command} range must not start below 0, but ${shown}.` : null;
}
