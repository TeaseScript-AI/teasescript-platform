import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import {
  compareDates,
  compareDateTimes,
  compareTimes,
  formatIsoDate,
  formatIsoDateTime,
  formatIsoTime,
  formatIsoTimestamp,
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
  SerializableRuntimeTimestamp,
  SerializableRuntimeValue,
} from "./serializable-values.js";
import {
  isDate,
  isDateTime,
  isDuration,
  isTemporal,
  isTime,
  isTimestamp,
} from "./value-predicates.js";
import { describeValue } from "./value-types.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/** Failed temporal conversion or arithmetic: invalid text, a result outside the years 0000–9999 or the zone rules. */
const TEMPORAL_FAILURE = "TSR060";

export const TEMPORAL_CONVERSIONS: ReadonlySet<string> = new Set([
  "toDate",
  "toTime",
  "toDateTime",
  "toTimestamp",
]);

/** `toDate`, `toTime`, `toDateTime`, or `toTimestamp` (V30 §35), with the optional `default:` fallback. */
export function temporalConversion(
  name: string,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): SerializableRuntimeValue {
  const extra = Object.keys(named).find((key) => key !== "default");
  const combines = name === "toDateTime" && positional.length === 2;
  if (extra !== undefined || (positional.length !== 1 && !combines))
    throw fault(
      "TSR015",
      `${name}(...) takes one value and an optional default:, such as ${name}(text, default: ...).`,
      span,
    );
  const fallback = Object.hasOwn(named, "default") ? named.default : undefined;
  const result = KIND_OF_CONVERSION[name]!;
  if (fallback !== undefined && !isKind(fallback, result))
    throw fault(
      TEMPORAL_FAILURE,
      `${name}(...) needs ${describeKind(result)} as its default:, not ${describeValue(fallback)}.`,
      span,
    );
  const converted = combines
    ? combineDateAndTime(positional[0]!, positional[1]!)
    : convert(result, positional[0]!);
  if (typeof converted !== "string") return converted;
  if (fallback !== undefined) return { ...fallback };
  throw fault(TEMPORAL_FAILURE, `${name}(...) ${converted}`, span);
}

const KIND_OF_CONVERSION: Readonly<Record<string, SerializableRuntimeTemporal["kind"]>> = {
  toDate: "date",
  toTime: "time",
  toDateTime: "datetime",
  toTimestamp: "timestamp",
};

const ISO_EXAMPLES: Readonly<Record<SerializableRuntimeTemporal["kind"], string>> = {
  date: '"2026-10-04"',
  time: '"14:30"',
  datetime: '"2026-10-04T18:00", without an offset',
  timestamp: '"2026-10-04T12:30:00Z", with Z or an offset',
};

/** The converted value, or the end of a sentence explaining why the value does not convert. */
function convert(
  kind: SerializableRuntimeTemporal["kind"],
  value: SerializableRuntimeValue,
): SerializableRuntimeTemporal | string {
  if (typeof value === "string") {
    const parsed = parseText(kind, value);
    if (parsed.ok) return parsed.value;
    return parsed.reason === null
      ? `needs ISO ${kind === "datetime" ? "date and time" : kind} text such as ${ISO_EXAMPLES[kind]}, not ${JSON.stringify(value)}. Give a fallback with default: if the text may not convert.`
      : `cannot convert ${JSON.stringify(value)}: ${parsed.reason}.`;
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
  return `cannot convert ${describeValue(value)} to ${describeKind(kind)}.`;
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
    case "timestamp": {
      const parsed = parseIsoTimestamp(text);
      return parsed.ok ? { ok: true, value: { kind, epochMilliseconds: parsed.value } } : parsed;
    }
  }
}

function combineDateAndTime(
  date: SerializableRuntimeValue,
  time: SerializableRuntimeValue,
): SerializableRuntimeDateTime | string {
  if (!isDate(date) || !isTime(time))
    return `combines a date and a time, not ${describeValue(date)} and ${describeValue(time)}.`;
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
  if (value.kind === "timestamp") return undefined;
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
  datetime: new Set(["toISO", "formatDate", "formatTime", "formatDateTime", "toTimestamp"]),
  timestamp: new Set([
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
      case "timestamp":
        return formatIsoTimestamp(value.epochMilliseconds);
    }
  }
  if (value.kind === "timestamp") {
    if (name === "toSeconds") return Math.floor(value.epochMilliseconds / 1_000);
    if (name === "toMilliseconds") return value.epochMilliseconds;
  }
  if (value.kind === "datetime" && name === "toTimestamp")
    return timestamp(zoned(context, value, span), span);
  const fields = value.kind === "timestamp" ? local(context, value.epochMilliseconds, span) : value;
  if (name === "toDateTime") return { kind: "datetime", ...fields };
  // The remaining methods are formatDate, formatTime, and formatDateTime, on values that have those parts.
  // EVIDENCE: invariant: METHODS admits these names only for kinds whose fields include the formatted parts.
  const parts = fields as DateTimeFields;
  if (name === "formatDate") return presentDate(context.presentation, parts);
  if (name === "formatTime") return presentTime(context.presentation, parts);
  return presentDateTime(context.presentation, parts);
}

/**
 * Ordering and arithmetic with a date or time operand (V30 §35), or `undefined` when neither operand is one. Exact
 * durations apply to a timestamp as elapsed time, and to a datetime as elapsed time through the player's zone.
 */
export function temporalBinary(
  operator: string,
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
  context: TemporalContext,
  span: SourceSpan,
): SerializableRuntimeValue | undefined {
  if (!isTemporal(left) && !isTemporal(right)) return undefined;
  if (["<", "<=", ">", ">="].includes(operator)) {
    if (!isTemporal(left) || !isTemporal(right) || left.kind !== right.kind)
      throw fault(
        "TSR009",
        `'${operator}' orders two values of the same kind, such as two dates or two timestamps, but these are ${describeValue(left)} and ${describeValue(right)}.`,
        span,
      );
    const order = compareTemporal(left, right);
    if (operator === "<") return order < 0;
    if (operator === "<=") return order <= 0;
    if (operator === ">") return order > 0;
    return order >= 0;
  }
  if (operator === "+" || operator === "-") {
    // A duration is added to or subtracted from the moment written first, as in `started + 1 h`.
    if (isDuration(right) && (isTimestamp(left) || isDateTime(left)))
      return shifted(left, operator === "-" ? -right.milliseconds : right.milliseconds);
    if (operator === "-" && isTimestamp(left) && isTimestamp(right))
      return elapsed(left.epochMilliseconds, right.epochMilliseconds);
    if (operator === "-" && isDateTime(left) && isDateTime(right))
      return elapsed(zoned(context, left, span), zoned(context, right, span));
  }
  throw fault(
    "TSR009",
    `'${operator}' does not apply to ${describeValue(left)} and ${describeValue(right)}. A timestamp or datetime adds or subtracts a duration, and two timestamps or two datetimes subtract to a duration.`,
    span,
  );

  function shifted(
    moment: SerializableRuntimeTimestamp | SerializableRuntimeDateTime,
    milliseconds: number,
  ): SerializableRuntimeTimestamp | SerializableRuntimeDateTime {
    const start =
      moment.kind === "timestamp" ? moment.epochMilliseconds : zoned(context, moment, span);
    const end = timestamp(start + roundToMillisecond(milliseconds), span);
    return moment.kind === "timestamp"
      ? end
      : { kind: "datetime", ...local(context, end.epochMilliseconds, span) };
  }
}

function compareTemporal(
  left: SerializableRuntimeTemporal,
  right: SerializableRuntimeTemporal,
): number {
  if (left.kind === "date" && right.kind === "date") return compareDates(left, right);
  if (left.kind === "time" && right.kind === "time") return compareTimes(left, right);
  if (left.kind === "datetime" && right.kind === "datetime") return compareDateTimes(left, right);
  if (left.kind === "timestamp" && right.kind === "timestamp")
    return Math.sign(left.epochMilliseconds - right.epochMilliseconds);
  throw new Error("Only values of one temporal kind are ordered.");
}

function elapsed(from: number, to: number): SerializableRuntimeDuration {
  return { kind: "duration", milliseconds: from - to };
}

function timestamp(epochMilliseconds: number, span: SourceSpan): SerializableRuntimeTimestamp {
  if (!isValidEpochMilliseconds(epochMilliseconds))
    throw fault(TEMPORAL_FAILURE, "The result lies outside the years 0000 to 9999.", span);
  return { kind: "timestamp", epochMilliseconds };
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
  | SerializableRuntimeTimestamp {
  return isTemporal(value) && value.kind === kind;
}

function describeKind(kind: SerializableRuntimeTemporal["kind"]): string {
  return kind === "date"
    ? "a date"
    : kind === "time"
      ? "a time"
      : kind === "datetime"
        ? "a date and time"
        : "a timestamp";
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
