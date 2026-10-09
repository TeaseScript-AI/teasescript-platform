import {
  calendarDuration,
  formatDuration,
  isCalendar,
  negateDuration,
  type AnyDuration,
} from "../duration.js";
import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import {
  addCalendarParts,
  compareDates,
  compareDateTimes,
  compareTimes,
  daysBetween,
  formatIsoDate,
  formatIsoDateTime,
  formatIsoTime,
  formatIsoTimestamp,
  isoWeek,
  isoWeekdayNumber,
  isValidEpochMilliseconds,
  localFields,
  parseIsoDate,
  parseIsoDateTime,
  parseIsoTime,
  parseIsoTimestamp,
  presentDate,
  presentDateTime,
  presentTime,
  roundToMillisecond,
  weekdayName,
  zonedTimestamp,
  type DateTimeFields,
  type TemporalContext,
  type TemporalResult,
} from "../temporal.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
import type {
  SerializableRuntimeDate,
  SerializableRuntimeDateTime,
  SerializableRuntimeDuration,
  SerializableRuntimeTemporal,
  SerializableRuntimeTime,
  SerializableRuntimeAbsoluteDateTime,
  SerializableRuntimeValue,
} from "./serializable-values.js";
import {
  isDate,
  isDateTime,
  isAnyDuration,
  isTemporal,
  isTime,
  isAbsoluteDateTime,
} from "./value-predicates.js";
import { describeValue } from "./value-types.js";
import { wallClockAt, type RuntimeTemporalCapture } from "./temporal-captures.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/** Failed temporal conversion or arithmetic: invalid text, a result outside the years 0000–9999 or the zone rules. */
const TEMPORAL_FAILURE = "TSR063";

/**
 * The milliseconds of a duration that a timer, `wait`, timeout, or media position measures as elapsed time. A calendar
 * duration has no fixed length, so it is a runtime error (ADR 0026).
 */
export function exactDurationMilliseconds(
  value: AnyDuration,
  subject: string,
  span: SourceSpan,
): number {
  if (isCalendar(value))
    throw fault(
      "TSR065",
      `${subject} needs a duration such as '30 s', not a calendar duration. A calendar day or month has no fixed length. Use a fixed length such as '1 day' or '24 h'.`,
      span,
    );
  return value.milliseconds;
}

export const TEMPORAL_GETTERS: ReadonlySet<string> = new Set([
  "getDate",
  "getTime",
  "getDateTime",
  "getAbsoluteDateTime",
]);

/**
 * `getDate()`, `getTime()`, `getDateTime()`, or `getAbsoluteDateTime()` (V30 §35) at scene time `atMs`: the wall clock
 * of the capture in force, read through its zone for local values.
 */
export function temporalNow(
  name: string,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  capture: RuntimeTemporalCapture,
  atMs: number,
  span: SourceSpan,
): SerializableRuntimeTemporal {
  if (positional.length > 0 || Object.keys(named).length > 0)
    throw fault("TSR028", `${name}() takes no arguments.`, span);
  const epochMilliseconds = wallClockAt(capture, atMs);
  if (epochMilliseconds === undefined)
    throw fault(
      "TSR064",
      `${name}() needs the current time, but this Player supplied no clock when the session started or continued.`,
      span,
    );
  const now = absoluteDateTime(epochMilliseconds, span);
  if (name === "getAbsoluteDateTime") return now;
  const fields = local(capture.context, now.epochMilliseconds, span);
  if (name === "getDate")
    return { kind: "date", year: fields.year, month: fields.month, day: fields.day };
  if (name === "getTime")
    return {
      kind: "time",
      hour: fields.hour,
      minute: fields.minute,
      second: fields.second,
      millisecond: fields.millisecond,
    };
  return { kind: "datetime", ...fields };
}

/** `value` converted to a date or time value of `kind` (V30 §35), or `undefined` when it does not convert. */
export function temporalConverted(
  kind: SerializableRuntimeTemporal["kind"],
  value: SerializableRuntimeValue,
): SerializableRuntimeTemporal | undefined {
  if (typeof value === "string") {
    const parsed = parseText(kind, value);
    return parsed.ok ? parsed.value : undefined;
  }
  if (isKind(value, kind)) return { ...value };
  if (isDateTime(value) && kind === "date")
    return { kind: "date", year: value.year, month: value.month, day: value.day };
  if (isDateTime(value) && kind === "time")
    return {
      kind: "time",
      hour: value.hour,
      minute: value.minute,
      second: value.second,
      millisecond: value.millisecond,
    };
  return undefined;
}

function parseText(
  kind: SerializableRuntimeTemporal["kind"],
  text: string,
): TemporalResult<SerializableRuntimeTemporal> {
  switch (kind) {
    case "date": {
      const parsed = parseIsoDate(text);
      return parsed.ok ? { ok: true, value: { kind, ...parsed.value } } : parsed;
    }
    case "time": {
      const parsed = parseIsoTime(text);
      return parsed.ok ? { ok: true, value: { kind, ...parsed.value } } : parsed;
    }
    case "datetime": {
      const parsed = parseIsoDateTime(text);
      return parsed.ok ? { ok: true, value: { kind, ...parsed.value } } : parsed;
    }
    case "absoluteDateTime": {
      const parsed = parseIsoTimestamp(text);
      return parsed.ok ? { ok: true, value: { kind, epochMilliseconds: parsed.value } } : parsed;
    }
  }
}

/** A date and a time combined into one date and time, or `undefined` when the values are not a date and a time. */
export function combinedDateAndTime(
  date: SerializableRuntimeValue,
  time: SerializableRuntimeValue,
): SerializableRuntimeDateTime | undefined {
  if (!isDate(date) || !isTime(time)) return undefined;
  return {
    kind: "datetime",
    year: date.year,
    month: date.month,
    day: date.day,
    hour: time.hour,
    minute: time.minute,
    second: time.second,
    millisecond: time.millisecond,
  };
}

/** A field of a date, time, or datetime, or `undefined` when the value has no such field. */
export function temporalProperty(
  value: SerializableRuntimeTemporal,
  name: string,
): SerializableRuntimeValue | undefined {
  if (value.kind === "absoluteDateTime") return undefined;
  if (value.kind !== "time") {
    switch (name) {
      case "year":
        return value.year;
      case "month":
        return value.month;
      case "day":
        return value.day;
      case "weekday":
        return weekdayName(value);
      case "weekdayNumber":
        return isoWeekdayNumber(value);
      case "weekNumber":
        return isoWeek(value).weekNumber;
      case "weekYear":
        return isoWeek(value).weekYear;
    }
  }
  if (value.kind !== "date") {
    switch (name) {
      case "hour":
        return value.hour;
      case "minute":
        return value.minute;
      case "second":
        return value.second;
      case "millisecond":
        return value.millisecond;
    }
  }
  return undefined;
}

const METHODS: Readonly<Record<SerializableRuntimeTemporal["kind"], ReadonlySet<string>>> = {
  date: new Set(["toISO", "formatDate"]),
  time: new Set(["toISO", "formatTime"]),
  datetime: new Set(["toISO", "formatDate", "formatTime", "formatDateTime", "toAbsoluteDateTime"]),
  absoluteDateTime: new Set([
    "toISO",
    "formatDate",
    "formatTime",
    "formatDateTime",
    "toDateTime",
    "toSeconds",
    "toMilliseconds",
  ]),
};

export function hasTemporalMethod(value: SerializableRuntimeTemporal, name: string): boolean {
  return METHODS[value.kind].has(name);
}

/** A method call on a date or time value; `context` gives the player's zone and presentation. */
export function temporalMethod(
  value: SerializableRuntimeTemporal,
  name: string,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  context: TemporalContext,
  span: SourceSpan,
): SerializableRuntimeValue {
  if (!hasTemporalMethod(value, name))
    throw fault("TSR016", `${capitalize(describeKind(value.kind))} has no method '${name}'.`, span);
  if (positional.length > 0 || Object.keys(named).length > 0)
    throw fault("TSR015", `${name}() takes no arguments.`, span);
  if (name === "toISO") {
    switch (value.kind) {
      case "date":
        return formatIsoDate(value);
      case "time":
        return formatIsoTime(value);
      case "datetime":
        return formatIsoDateTime(value);
      case "absoluteDateTime":
        return formatIsoTimestamp(value.epochMilliseconds);
    }
  }
  if (value.kind === "absoluteDateTime") {
    if (name === "toSeconds") return Math.floor(value.epochMilliseconds / 1_000);
    if (name === "toMilliseconds") return value.epochMilliseconds;
  }
  if (value.kind === "datetime" && name === "toAbsoluteDateTime")
    return absoluteDateTime(zoned(context, value, span), span);
  const fields =
    value.kind === "absoluteDateTime" ? local(context, value.epochMilliseconds, span) : value;
  if (name === "toDateTime") return { kind: "datetime", ...fields };
  // The remaining methods are formatDate, formatTime, and formatDateTime, on values that have those parts.
  // EVIDENCE: invariant: METHODS admits these names only for kinds whose fields include the formatted parts.
  const parts = fields as DateTimeFields;
  if (name === "formatDate") return presentDate(context.presentation, parts);
  if (name === "formatTime") return presentTime(context.presentation, parts);
  return presentDateTime(context.presentation, parts);
}

/**
 * Ordering and arithmetic with a date or time operand (V30 §35, ADR 0026), or `undefined` when neither operand is one.
 * No operator reads a zone: exact durations apply only to an absolute date and time, and whole days and calendar units
 * to local dates.
 */
export function temporalBinary(
  operator: string,
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
  span: SourceSpan,
): SerializableRuntimeValue | undefined {
  if (!isTemporal(left) && !isTemporal(right)) return undefined;
  if (["<", "<=", ">", ">="].includes(operator)) {
    if (!isTemporal(left) || !isTemporal(right) || left.kind !== right.kind)
      throw fault(
        "TSR009",
        `'${operator}' orders two values of the same kind, such as two dates or two absolute dates and times, but these are ${describeValue(left)} and ${describeValue(right)}.`,
        span,
      );
    const order = compareTemporal(left, right);
    if (operator === "<") return order < 0;
    if (operator === "<=") return order <= 0;
    if (operator === ">") return order > 0;
    return order >= 0;
  }
  if (operator === "+" || operator === "-") {
    // A duration is added to or subtracted from the value written first, as in `started + 1 h`.
    if (isAnyDuration(right) && (isDate(left) || isAbsoluteDateTime(left) || isDateTime(left)))
      return moved(left, operator === "-" ? negateDuration(right) : right);
    if (operator === "-" && isDate(left) && isDate(right))
      return calendarDuration({ months: 0, days: daysBetween(left, right), milliseconds: 0 });
    if (operator === "-" && isAbsoluteDateTime(left) && isAbsoluteDateTime(right))
      return elapsed(left.epochMilliseconds, right.epochMilliseconds);
    if (operator === "-" && isDateTime(left) && isDateTime(right))
      throw fault(
        "TSR009",
        "A date and time has no time zone, so one cannot be subtracted from another. Subtract their dates with 'toDate(...)', or convert both with toAbsoluteDateTime() for the elapsed time.",
        span,
      );
  }
  throw fault(
    "TSR009",
    `'${operator}' does not apply to ${describeValue(left)} and ${describeValue(right)}. A date or a date and time moves by calendar units, an absolute date and time by a duration, and two dates or two absolute dates and times subtract to how far apart they are.`,
    span,
  );

  /**
   * A date, datetime, or absolute date and time moved by a duration (ADR 0026). Operators read no zone: an absolute
   * date and time moves by exact time, and a date or a date and time by calendar units, keeping its clock time. A
   * calendar duration applies its months, then its days.
   */
  function moved(
    value:
      SerializableRuntimeDate | SerializableRuntimeDateTime | SerializableRuntimeAbsoluteDateTime,
    duration: AnyDuration,
  ): SerializableRuntimeDate | SerializableRuntimeDateTime | SerializableRuntimeAbsoluteDateTime {
    if (value.kind === "absoluteDateTime") {
      if (isCalendar(duration))
        throw fault(
          "TSR009",
          "An absolute date and time has no calendar. Convert it first, as in '(moment.toDateTime() + 1 calendar month).toAbsoluteDateTime()'.",
          span,
        );
      return absoluteDateTime(
        value.epochMilliseconds + roundToMillisecond(duration.milliseconds),
        span,
      );
    }
    if (!isCalendar(duration))
      throw fault(
        "TSR009",
        value.kind === "date"
          ? `A date moves only by calendar units, such as '1 calendar day', not by ${formatDuration(duration)}.`
          : "A date and time has no time zone, so it cannot move by elapsed time. Convert it first, as in '(value.toAbsoluteDateTime() + 2 h).toDateTime()', or use calendar units to keep the clock time.",
        span,
      );
    if (duration.milliseconds !== 0)
      throw fault(
        "TSR009",
        value.kind === "date"
          ? `A date moves only by calendar units, not by ${formatDuration(duration)}. A date has no clock time, so leave out the ${formatDuration(duration.milliseconds)}.`
          : `A date and time moves only by calendar units, not by ${formatDuration(duration)}. Convert it with toAbsoluteDateTime() for elapsed time.`,
        span,
      );
    const date = addCalendarParts(value, duration.months, duration.days);
    if (date === undefined)
      throw fault(TEMPORAL_FAILURE, "The result lies outside the years 0000 to 9999.", span);
    return value.kind === "date" ? { kind: "date", ...date } : { ...value, ...date };
  }
}

/** The order of two date or time values of one kind: negative, zero, or positive. */
export function compareTemporal(
  left: SerializableRuntimeTemporal,
  right: SerializableRuntimeTemporal,
): number {
  if (left.kind === "date" && right.kind === "date") return compareDates(left, right);
  if (left.kind === "time" && right.kind === "time") return compareTimes(left, right);
  if (left.kind === "datetime" && right.kind === "datetime") return compareDateTimes(left, right);
  if (left.kind === "absoluteDateTime" && right.kind === "absoluteDateTime")
    return Math.sign(left.epochMilliseconds - right.epochMilliseconds);
  throw new Error("Only values of one temporal kind are ordered.");
}

function elapsed(from: number, to: number): SerializableRuntimeDuration {
  return { kind: "duration", milliseconds: from - to };
}

function absoluteDateTime(
  epochMilliseconds: number,
  span: SourceSpan,
): SerializableRuntimeAbsoluteDateTime {
  if (!isValidEpochMilliseconds(epochMilliseconds))
    throw fault(TEMPORAL_FAILURE, "The result lies outside the years 0000 to 9999.", span);
  return { kind: "absoluteDateTime", epochMilliseconds };
}

function zoned(
  context: TemporalContext,
  value: SerializableRuntimeDateTime,
  span: SourceSpan,
): number {
  return unwrap(zonedTimestamp(context.zone, value), span);
}

function local(
  context: TemporalContext,
  epochMilliseconds: number,
  span: SourceSpan,
): DateTimeFields {
  return unwrap(localFields(context.zone, epochMilliseconds), span);
}

function unwrap<T>(result: TemporalResult<T>, span: SourceSpan): T {
  if (result.ok) return result.value;
  throw fault(TEMPORAL_FAILURE, `This date and time cannot be converted: ${result.reason}.`, span);
}

function isKind(
  value: SerializableRuntimeValue,
  kind: SerializableRuntimeTemporal["kind"],
): value is
  | SerializableRuntimeDate
  | SerializableRuntimeTime
  | SerializableRuntimeDateTime
  | SerializableRuntimeAbsoluteDateTime {
  return isTemporal(value) && value.kind === kind;
}

function describeKind(kind: SerializableRuntimeTemporal["kind"]): string {
  return kind === "date"
    ? "a date"
    : kind === "time"
      ? "a time"
      : kind === "datetime"
        ? "a date and time"
        : "an absolute date and time";
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
