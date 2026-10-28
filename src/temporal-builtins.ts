/**
 * The built-ins of date and time values (V30 §35): the clock reads, such as `getDate()`, the methods and fields of
 * dates, times, dates and times, and absolute dates and times, and the parts of a calendar duration. One contract per
 * built-in, shared by the compiler, the runtime, and the editor; the runtime implements each in
 * `runtime/values/temporal-operations.ts`. A duration has no parts, and a calendar duration no methods. None of them takes
 * arguments, so none has a domain of its arguments: a call with any fails alike when the script is compiled and when it
 * runs (`temporalArgumentsProblem`).
 */

import { argumentShapeProblem, NO_ARGUMENTS, type ArgumentProblem } from "./argument-rules.js";
import type { ClockFunctionName } from "./language-facts.js";
import { WEEKDAY_NAMES } from "./temporal.js";
import { isTextMember } from "./text-operations.js";

/** The kinds of date and time values, which have the methods and fields below. */
export const TEMPORAL_KINDS = Object.freeze([
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
] as const);

export type TemporalKind = (typeof TEMPORAL_KINDS)[number];

export function isTemporalKind(name: string): name is TemporalKind {
  return TEMPORAL_KINDS.some((kind) => kind === name);
}

/**
 * A clock read (V30 §35). It takes no arguments and gives the player's current value of the kind `result`. It reads the
 * session clock: the wall clock and zone that the Player gave when the session started or continued, which the session
 * records, advanced by scene time. So it is not pure, since its value depends on when it runs, but it changes no value
 * and does not wait, and a session restored from a checkpoint reads the same values at the same scene times.
 */
export interface ClockFunction {
  readonly result: TemporalKind;
  /** What the call gives, for the editor's help. */
  readonly summary: string;
}

/** Each clock read by its name. */
export const CLOCK_CONTRACTS = {
  getDate: { result: "date", summary: "Gives the player's current local date." },
  getTime: { result: "time", summary: "Gives the player's current local clock time." },
  getDateTime: {
    result: "datetime",
    summary: "Gives the player's current local date and clock time.",
  },
  getAbsoluteDateTime: {
    result: "absoluteDateTime",
    summary:
      "Gives the current moment. Within one start or continue it never goes backwards, unlike a local value after the autumn daylight-saving change or after travelling west, so it measures how much time passed.",
  },
} as const satisfies { readonly [Name in ClockFunctionName]: ClockFunction };

export function isClockFunction(name: string): name is ClockFunctionName {
  return Object.hasOwn(CLOCK_CONTRACTS, name);
}

/**
 * A method of date and time values (V30 §35). Only the `receivers` have it, and it takes no arguments. It only reads the
 * value and gives a new one; a format, and a conversion between local and absolute time, also read the player's zone and
 * presentation, which the session records (see `ClockFunction`).
 */
export interface TemporalMethod {
  readonly receivers: readonly TemporalKind[];
  readonly result: "string" | "integer" | "datetime" | "absoluteDateTime";
  /** It shows the value in the player's own format, which the text of a call with arguments says. */
  readonly formats?: true;
  /** What the call does, for the editor's help. */
  readonly summary: string;
}

/** Each method of date and time values by its name. */
export const TEMPORAL_METHODS = {
  toISO: {
    receivers: TEMPORAL_KINDS,
    result: "string",
    summary:
      'Gives the value as ISO text. A local value has no offset, as in "2026-10-04T18:00", and shows seconds when the seconds or milliseconds are not zero, and milliseconds when they are not zero. An absolute date and time is in UTC with seconds, as in "2026-10-04T12:30:00Z".',
  },
  formatDate: {
    receivers: ["date", "datetime", "absoluteDateTime"],
    result: "string",
    formats: true,
    summary:
      "Gives the date of a date, a date and time, or an absolute date and time in the player's numeric local form, as say shows it, such as 4-10-2026 in Dutch.",
  },
  formatTime: {
    receivers: ["time", "datetime", "absoluteDateTime"],
    result: "string",
    formats: true,
    summary:
      "Gives the clock time of a time, a date and time, or an absolute date and time in the player's local form, as say shows it, such as 18:30 or 6:30 PM. Seconds appear only when they are not zero.",
  },
  formatDateTime: {
    receivers: ["datetime", "absoluteDateTime"],
    result: "string",
    formats: true,
    summary:
      "Gives a date and time, or an absolute date and time, in the player's numeric local form, as say shows it, such as 4-10-2026, 18:30 in Dutch.",
  },
  toAbsoluteDateTime: {
    receivers: ["datetime"],
    result: "absoluteDateTime",
    summary:
      "Converts a date and time to the moment it is in the player's current zone. A time that the spring daylight-saving change skips moves forward by the gap, and one that the autumn change repeats takes the earlier moment.",
  },
  toDateTime: {
    receivers: ["absoluteDateTime"],
    result: "datetime",
    summary:
      "Converts an absolute date and time to the local date and time it is in the player's current zone.",
  },
  toSeconds: {
    receivers: ["absoluteDateTime"],
    result: "integer",
    summary: "Gives an absolute date and time as Unix seconds, rounded down.",
  },
  toMilliseconds: {
    receivers: ["absoluteDateTime"],
    result: "integer",
    summary: "Gives an absolute date and time as Unix milliseconds.",
  },
} as const satisfies { readonly [name: string]: TemporalMethod };

export type TemporalMethodName = keyof typeof TEMPORAL_METHODS;

/** Whether a date or time value has a method `name`; a call of it is then a call of that method. */
export function isTemporalMethod(name: string): name is TemporalMethodName {
  return Object.hasOwn(TEMPORAL_METHODS, name);
}

/** Whether a value of `kind` has the method `name`. */
export function hasTemporalMethod(kind: TemporalKind, name: string): name is TemporalMethodName {
  if (!isTemporalMethod(name)) return false;
  const method: TemporalMethod = TEMPORAL_METHODS[name];
  return method.receivers.includes(kind);
}

/** The call as the editor's help writes it, such as `getDate()` or `value.toISO()`. */
export function temporalSyntax(name: ClockFunctionName | TemporalMethodName): string {
  return isClockFunction(name) ? `${name}()` : `value.${name}()`;
}

/**
 * A read-only field of date and time values (V30 §35). A date's fields (`of: "date"`) belong to a date and a date and
 * time, and a time's to a time and a date and time. An absolute date and time has none: it is converted first, as in
 * `started.toDateTime().hour`. A field is computed when it is read.
 */
export interface TemporalField {
  readonly of: "date" | "time";
  readonly result: "integer" | "string";
  /** Every value it can have. */
  readonly values?: readonly (string | number)[];
  readonly summary: string;
}

/** Each field of date and time values by its name. */
export const TEMPORAL_FIELDS = {
  year: { of: "date", result: "integer", summary: "Gives the year." },
  month: { of: "date", result: "integer", summary: "Gives the month, from 1 for January." },
  day: { of: "date", result: "integer", summary: "Gives the day of the month." },
  weekday: {
    of: "date",
    result: "string",
    values: WEEKDAY_NAMES,
    summary: 'Gives the English name of the weekday, such as "Saturday".',
  },
  weekdayNumber: {
    of: "date",
    result: "integer",
    values: WEEKDAY_NAMES.map((_, index) => index + 1),
    summary: "Gives the ISO number of the weekday: Monday is 1 and Sunday is 7.",
  },
  weekNumber: {
    of: "date",
    result: "integer",
    summary:
      "Gives the ISO 8601 week, 1 to 53. A week starts on Monday, and week 1 holds the year's first Thursday.",
  },
  weekYear: {
    of: "date",
    result: "integer",
    summary: "Gives the year that the ISO week belongs to: 2024-12-30 is in week 1 of 2025.",
  },
  hour: { of: "time", result: "integer", summary: "Gives the hour, from 0 to 23." },
  minute: { of: "time", result: "integer", summary: "Gives the minute." },
  second: { of: "time", result: "integer", summary: "Gives the second." },
  millisecond: { of: "time", result: "integer", summary: "Gives the millisecond." },
} as const satisfies { readonly [name: string]: TemporalField };

export type TemporalFieldName = keyof typeof TEMPORAL_FIELDS;

function isTemporalField(name: string): name is TemporalFieldName {
  return Object.hasOwn(TEMPORAL_FIELDS, name);
}

/** Whether a value of `kind` has the field `name`. */
export function hasTemporalField(kind: TemporalKind, name: string): name is TemporalFieldName {
  return isTemporalField(name) && (TEMPORAL_FIELDS[name].of === kind || kind === "datetime");
}

/** A read-only part of a calendar duration (V30 §35, ADR 0026). */
export interface CalendarDurationPart {
  readonly result: "integer" | "duration";
  readonly summary: string;
}

/** Each part of a calendar duration by its name. */
export const CALENDAR_DURATION_PARTS = {
  months: {
    result: "integer",
    summary: "Gives the whole calendar months, with a calendar year as 12.",
  },
  days: {
    result: "integer",
    summary:
      "Gives the whole calendar days, with a calendar week as 7. It counts calendar days and is not a length.",
  },
  exactOffset: {
    result: "duration",
    summary: "Gives the exact time besides the calendar months and days, as a duration.",
  },
} as const satisfies { readonly [name: string]: CalendarDurationPart };

export type CalendarDurationPartName = keyof typeof CALENDAR_DURATION_PARTS;

export function isCalendarDurationPart(name: string): name is CalendarDurationPartName {
  return Object.hasOwn(CALENDAR_DURATION_PARTS, name);
}

/**
 * The first problem with a call of a clock read or a method of a date or time value, which take no arguments (V30 §35),
 * with `received` arguments without a name and the names `named`: a name first, as for every other built-in. From the
 * compiler (`TSV022`, `TSV020`) and the runtime (`TSR028`, `TSR015`). A format says that it follows the player's
 * settings. `undefined` for a call without arguments.
 */
export function temporalArgumentsProblem(
  name: ClockFunctionName | TemporalMethodName,
  received: number,
  named: readonly string[],
): ArgumentProblem | undefined {
  const problem = argumentShapeProblem(name, NO_ARGUMENTS, received, named, false);
  const method: TemporalMethod | undefined = isTemporalMethod(name)
    ? TEMPORAL_METHODS[name]
    : undefined;
  if (problem === undefined || method?.formats !== true) return problem;
  return {
    ...problem,
    message: `${problem.message} It shows the value in the player's own date and time format.`,
  };
}

/**
 * Why `subject`, a date or time value of `kind`, such as "A date", has no method or property `name`, from the compiler
 * (`TSV043`) and the runtime (`TSR016`, `TSR017`). A field of a local value read from an absolute date and time names
 * the conversion, as in `label.toDateTime().hour`, and a member of text names `toString(...)`.
 */
export function temporalMemberMessage(
  subject: string,
  kind: TemporalKind,
  name: string,
  use: "method" | "property",
  label: string,
): string {
  const fix =
    use === "property" && kind === "absoluteDateTime" && isTemporalField(name)
      ? ` Convert it first, as in '${label}.toDateTime().${name}'.`
      : isTextMember(name)
        ? " Convert the value to text first with the toString function."
        : "";
  return `${subject} has no ${use} '${name}'.${fix}`;
}

/** Why a calendar duration has no property `name`, from the compiler (`TSV043`) and the runtime (`TSR017`). */
export function calendarDurationPropertyMessage(name: string): string {
  const parts = Object.keys(CALENDAR_DURATION_PARTS);
  return `A calendar duration has no property '${name}'. Use ${parts.slice(0, -1).join(", ")}, or ${parts.at(-1)!}.`;
}
