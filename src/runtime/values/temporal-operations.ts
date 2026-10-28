import type { RuntimeErrorCode } from "../../diagnostic-codes.js";
import {
  calendarDuration,
  exactDuration,
  formatDuration,
  isCalendar,
  negateDuration,
  type AnyDuration,
} from "../../duration.js";
import type { ClockFunctionName } from "../../language-facts.js";
import type { PlanSourceLocation } from "../../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../../source.js";
import {
  CLOCK_CONTRACTS,
  hasTemporalField,
  hasTemporalMethod,
  isCalendarDurationPart,
  temporalArgumentsProblem,
  temporalMemberMessage,
  type TemporalMethodName,
} from "../../temporal-builtins.js";
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
  type DateFields,
  type DateTimeFields,
  type TemporalContext,
  type TemporalResult,
  type TimeFields,
} from "../../temporal.js";
import { RuntimeFault } from "../errors.js";
import type {
  SerializableRuntimeCalendarDuration,
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
import { wallClockAt, type RuntimeTemporalCapture } from "../host-data/temporal-captures.js";
import { describeValue } from "../../value-kinds.js";
import { copySpan } from "../../plan/source-location.js";

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

/**
 * A clock read (V30 §35, see `ClockFunction`) at scene time `atMs`: the wall clock of the capture in force, read through
 * its zone for local values.
 */
export function temporalNow(
  name: ClockFunctionName,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  capture: RuntimeTemporalCapture,
  atMs: number,
  span: SourceSpan,
): SerializableRuntimeTemporal {
  const problem = temporalArgumentsProblem(name, positional.length, Object.keys(named));
  if (problem !== undefined) throw fault("TSR028", problem.message, span);
  const epochMilliseconds = wallClockAt(capture, atMs);
  if (epochMilliseconds === undefined)
    throw fault(
      "TSR064",
      `${name}() needs the current time, but this Player supplied no clock when the session started or continued.`,
      span,
    );
  const now = absoluteDateTime(epochMilliseconds, span);
  const kind = CLOCK_CONTRACTS[name].result;
  if (kind === "absoluteDateTime") return now;
  const fields = local(capture.context, now.epochMilliseconds, span);
  switch (kind) {
    case "date":
      return { kind, year: fields.year, month: fields.month, day: fields.day };
    case "time":
      return {
        kind,
        hour: fields.hour,
        minute: fields.minute,
        second: fields.second,
        millisecond: fields.millisecond,
      };
    case "datetime":
      return { kind, ...fields };
  }
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

/**
 * A part of a calendar duration (see `CalendarDurationPart`), or `undefined` when it has no such part. `days` counts
 * calendar days and is not a length.
 */
export function calendarDurationProperty(
  value: SerializableRuntimeCalendarDuration,
  name: string,
): SerializableRuntimeValue | undefined {
  if (!isCalendarDurationPart(name)) return undefined;
  switch (name) {
    case "months":
      return value.months;
    case "days":
      return value.days;
    case "exactOffset":
      return exactDuration(value.milliseconds);
    default: {
      const unhandled: never = name;
      throw new Error(`Calendar duration part '${String(unhandled)}' has no implementation.`);
    }
  }
}

/** A field of a date, time, or date and time (see `TemporalField`), or `undefined` when the value has no such field. */
export function temporalProperty(
  value: SerializableRuntimeTemporal,
  name: string,
): SerializableRuntimeValue | undefined {
  if (!hasTemporalField(value.kind, name)) return undefined;
  // EVIDENCE: invariant: a value has a field only when it has the date or time parts the field reads (`TemporalField`).
  const parts = value as DateFields & TimeFields;
  switch (name) {
    case "year":
      return parts.year;
    case "month":
      return parts.month;
    case "day":
      return parts.day;
    case "weekday":
      return weekdayName(parts);
    case "weekdayNumber":
      return isoWeekdayNumber(parts);
    case "weekNumber":
      return isoWeek(parts).weekNumber;
    case "weekYear":
      return isoWeek(parts).weekYear;
    case "hour":
      return parts.hour;
    case "minute":
      return parts.minute;
    case "second":
      return parts.second;
    case "millisecond":
      return parts.millisecond;
    default: {
      const unhandled: never = name;
      throw new Error(`Date and time field '${String(unhandled)}' has no implementation.`);
    }
  }
}

/**
 * Why a date or time value has no member `name`, as the compiler says it (see `temporalMemberMessage`); `label` is how
 * the source writes the value, where it can.
 */
export function missingTemporalMember(
  value: SerializableRuntimeTemporal,
  name: string,
  use: "method" | "property",
  label: string | null,
): string {
  return temporalMemberMessage(
    capitalize(describeValue(value)),
    value.kind,
    name,
    use,
    label ?? "value",
  );
}

/** A method call on a date or time value (see `TemporalMethod`); `context` gives the player's zone and presentation. */
export function temporalMethod(
  value: SerializableRuntimeTemporal,
  name: string,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  context: TemporalContext,
  span: SourceSpan,
): SerializableRuntimeValue {
  if (!hasTemporalMethod(value.kind, name))
    throw fault("TSR016", missingTemporalMember(value, name, "method", null), span);
  const problem = temporalArgumentsProblem(name, positional.length, Object.keys(named));
  if (problem !== undefined) throw fault("TSR015", problem.message, span);
  return methodResult(value, name, context, span);
}

function methodResult(
  value: SerializableRuntimeTemporal,
  name: TemporalMethodName,
  context: TemporalContext,
  span: SourceSpan,
): SerializableRuntimeValue {
  switch (name) {
    case "toISO":
      return isoText(value);
    case "formatDate":
      return presentDate(context.presentation, localParts(value, context, span));
    case "formatTime":
      return presentTime(context.presentation, localParts(value, context, span));
    case "formatDateTime":
      return presentDateTime(context.presentation, localParts(value, context, span));
    case "toAbsoluteDateTime":
      return absoluteDateTime(zoned(context, localParts(value, context, span), span), span);
    case "toDateTime":
      return { kind: "datetime", ...localParts(value, context, span) };
    case "toSeconds":
      return Math.floor(moment(value) / 1_000);
    case "toMilliseconds":
      return moment(value);
    default: {
      const unhandled: never = name;
      throw new Error(`Date and time method '${String(unhandled)}' has no implementation.`);
    }
  }
}

function isoText(value: SerializableRuntimeTemporal): string {
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

/**
 * The parts of a local value, or of an absolute date and time in the player's zone. A method reads only the parts that
 * every one of its receivers has (see `TemporalMethod`).
 */
function localParts(
  value: SerializableRuntimeTemporal,
  context: TemporalContext,
  span: SourceSpan,
): DateTimeFields {
  if (value.kind === "absoluteDateTime") return local(context, value.epochMilliseconds, span);
  // EVIDENCE: invariant: `hasTemporalMethod` admits a method only for its receivers, which have the parts it reads.
  return value as DateTimeFields;
}

/** The moment of an absolute date and time, the only receiver of `toSeconds()` and `toMilliseconds()`. */
function moment(value: SerializableRuntimeTemporal): number {
  if (value.kind !== "absoluteDateTime")
    throw new Error("Only an absolute date and time is a moment.");
  return value.epochMilliseconds;
}

/**
 * Arithmetic with a date or time operand (V30 §35, ADR 0026), or `undefined` when neither operand is one; the evaluator
 * orders them. No operator reads a zone: exact durations apply only to an absolute date and time, and calendar units
 * only to local dates and dates and times.
 */
export function temporalBinary(
  operator: string,
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
  span: SourceSpan,
): SerializableRuntimeValue | undefined {
  if (!isTemporal(left) && !isTemporal(right)) return undefined;
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
        "A date and time has no time zone, so one cannot be subtracted from another. For the days between them, convert both with the toDate function first. For the elapsed time, convert both with the toAbsoluteDateTime function.",
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
          "An absolute date and time has no calendar. Convert it first, as in '(value.toDateTime() + 1 calendar day).toAbsoluteDateTime()'.",
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

function zoned(context: TemporalContext, value: DateTimeFields, span: SourceSpan): number {
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

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function fault(code: RuntimeErrorCode, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
