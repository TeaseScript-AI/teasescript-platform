import {
  calendarDuration,
  exactDuration,
  formatDuration,
  isCalendar,
  negateDuration,
  type AnyDuration,
  type StoredCalendarDuration,
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
  localTimeTransition,
  monthOverflow,
  namedZoneRules,
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
  type Disambiguation as ZoneDisambiguation,
  type TemporalContext,
  type TemporalResult,
  type ZoneRules,
} from "../temporal.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
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
import { describeShownValue, describeValue, shownChoice } from "./value-types.js";
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

/**
 * A component of a calendar duration (ADR 0026), or `undefined` when it has no such component. `days` counts calendar
 * days and is not a length.
 */
export function calendarDurationProperty(
  value: SerializableRuntimeCalendarDuration,
  name: string,
): SerializableRuntimeValue | undefined {
  if (name === "months") return value.months;
  if (name === "days") return value.days;
  if (name === "exactOffset") return exactDuration(value.milliseconds);
  return undefined;
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
  date: new Set(["toISO", "formatDate", "add"]),
  time: new Set(["toISO", "formatTime"]),
  datetime: new Set([
    "toISO",
    "formatDate",
    "formatTime",
    "formatDateTime",
    "toAbsoluteDateTime",
    "add",
  ]),
  absoluteDateTime: new Set([
    "toISO",
    "formatDate",
    "formatTime",
    "formatDateTime",
    "toDateTime",
    "toSeconds",
    "toMilliseconds",
    "add",
  ]),
};

export function hasTemporalMethod(value: SerializableRuntimeTemporal, name: string): boolean {
  return METHODS[value.kind].has(name);
}

/**
 * The options of each method that takes them (V30 §35): the zone to count in, how to resolve a local time that the zone
 * skips or repeats, and what a day that the target month lacks becomes. The other methods take no arguments.
 */
const METHOD_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  toAbsoluteDateTime: ["zone", "disambiguation"],
  toDateTime: ["zone"],
  toDuration: ["from", "zone", "disambiguation", "overflow"],
};

const DISAMBIGUATIONS: readonly Disambiguation[] = ["compatible", "earlier", "later", "reject"];
const OVERFLOWS: readonly Overflow[] = ["constrain", "reject"];

/** How a local time that a zone skips or repeats becomes a moment; `reject` refuses it. */
type Disambiguation = ZoneDisambiguation | "reject";
/** What a day that the target month lacks becomes: that month's last day, or a failure. */
type Overflow = "constrain" | "reject";

interface MethodOptions {
  /** The zone's rules: a zone the script names, else the player's. */
  readonly rules: ZoneRules;
  readonly disambiguation: Disambiguation;
  readonly overflow: Overflow;
}

/**
 * A method call on a date or time value; `context` gives the player's zone and presentation and the zones the script
 * names.
 */
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
  if (name === "add") return added(value, positional, named, context, span);
  const options = METHOD_OPTIONS[name];
  if (options !== undefined) {
    if (positional.length > 0)
      throw fault(
        "TSR028",
        `${name}() takes only the options ${optionList(options)}, each with its name.`,
        span,
      );
    const { rules, disambiguation } = methodOptions(name, named, options, context, span);
    if (value.kind === "datetime" && name === "toAbsoluteDateTime")
      return absoluteDateTime(resolvedMoment(rules, value, disambiguation, span), span);
    // EVIDENCE: invariant: METHODS admits toDateTime only on an absolute date and time.
    const moment = (value as SerializableRuntimeAbsoluteDateTime).epochMilliseconds;
    return { kind: "datetime", ...unwrap(localFields(rules, moment), span) };
  }
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
  const fields =
    value.kind === "absoluteDateTime" ? local(context, value.epochMilliseconds, span) : value;
  // The remaining methods are formatDate, formatTime, and formatDateTime, on values that have those parts.
  // EVIDENCE: invariant: METHODS admits these names only for kinds whose fields include the formatted parts.
  const parts = fields as DateTimeFields;
  if (name === "formatDate") return presentDate(context.presentation, parts);
  if (name === "formatTime") return presentTime(context.presentation, parts);
  return presentDateTime(context.presentation, parts);
}

/**
 * `span.toDuration(from: start, ...)` on a calendar duration (V30 §35): the exact time from `start`, a date and time or
 * an absolute date and time, to that start moved by the calendar duration in the zone.
 */
export function calendarDurationMethod(
  value: SerializableRuntimeCalendarDuration,
  name: string,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  context: TemporalContext,
  span: SourceSpan,
): SerializableRuntimeDuration {
  if (name !== "toDuration")
    throw fault(
      "TSR016",
      `A calendar duration has no method '${name}'. Use toDuration(from: start) for its exact length from a start.`,
      span,
    );
  const allowed = METHOD_OPTIONS.toDuration!;
  if (positional.length > 0)
    throw fault(
      "TSR028",
      `toDuration() takes only the options ${optionList(allowed)}, each with its name.`,
      span,
    );
  const from = named.from;
  if (from === undefined)
    throw fault(
      "TSR028",
      "toDuration() needs its start as 'from:', as in 'span.toDuration(from: getAbsoluteDateTime())'. A calendar day or month has a length only from a start.",
      span,
    );
  const options = methodOptions(name, named, allowed, context, span);
  let start: number;
  if (isAbsoluteDateTime(from)) start = from.epochMilliseconds;
  else if (isDateTime(from))
    start = resolvedMoment(options.rules, from, options.disambiguation, span);
  else
    throw fault(
      "TSR059",
      `toDuration(from:) starts at a date and time or an absolute date and time, not ${describeValue(from)}.${isDate(from) ? " Give the date a clock time, as in 'toDateTime(day, toTime(\"00:00\"))'." : ""}`,
      span,
    );
  return exactDuration(
    absoluteDateTime(anchoredEnd(start, value, options, span), span).epochMilliseconds - start,
  );
}

/**
 * `value.add(amount, ...)` (V30 §35). A date or a date and time moves by calendar units like `+`, with `overflow:`; an
 * absolute date and time moves by a duration like `+`, or by a calendar duration in a zone.
 */
function added(
  value: SerializableRuntimeTemporal,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  context: TemporalContext,
  span: SourceSpan,
): SerializableRuntimeTemporal {
  const amount = positional[0];
  if (positional.length !== 1 || amount === undefined)
    throw fault(
      "TSR028",
      "add() takes one duration or calendar duration, as in 'add(1 calendar day)'.",
      span,
    );
  if (!isAnyDuration(amount))
    throw fault(
      "TSR059",
      `add() takes a duration or a calendar duration, such as '1 calendar day', not ${describeValue(amount)}.`,
      span,
    );
  if (value.kind === "date" || value.kind === "datetime") {
    const { overflow } = methodOptions("add", named, ["overflow"], context, span);
    return movedLocally(value, amount, overflow, span);
  }
  // EVIDENCE: invariant: METHODS admits add only on a date, a date and time, or an absolute date and time.
  const start = (value as SerializableRuntimeAbsoluteDateTime).epochMilliseconds;
  if (!isCalendar(amount)) {
    if (Object.keys(named).length > 0)
      throw fault(
        "TSR028",
        `add() with a duration takes no options. 'zone:', 'disambiguation:', and 'overflow:' apply to a calendar duration, not to ${formatDuration(amount)}.`,
        span,
      );
    return absoluteDateTime(start + roundToMillisecond(amount.milliseconds), span);
  }
  const options = methodOptions(
    "add",
    named,
    ["zone", "disambiguation", "overflow"],
    context,
    span,
  );
  return absoluteDateTime(anchoredEnd(start, amount, options, span), span);
}

/**
 * The options of a method call, checked: each a name the method takes, a zone the session recorded, and one of the
 * documented texts. Omitted options are the player's zone, `compatible`, and `constrain`.
 */
function methodOptions(
  method: string,
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  allowed: readonly string[],
  context: TemporalContext,
  span: SourceSpan,
): MethodOptions {
  for (const name of Object.keys(named))
    if (!allowed.includes(name))
      throw fault(
        "TSR028",
        `${method}() has no option '${name}:'. Its options are ${optionList(allowed)}.`,
        span,
      );
  const { zone, disambiguation = "compatible", overflow = "constrain" } = named;
  let rules = context.zone;
  if (zone !== undefined) {
    if (typeof zone !== "string")
      throw fault(
        "TSR059",
        `'zone:' takes the name of a time zone, such as "Europe/Amsterdam", not ${describeShownValue(zone)}.`,
        span,
      );
    const found = namedZoneRules(context, zone);
    if (found === undefined)
      throw fault(
        TEMPORAL_FAILURE,
        `This Player recorded no rules for the time zone '${zone}', so the date and time cannot be converted. Run the script in a Player that knows this zone.`,
        span,
      );
    rules = found;
  }
  return {
    rules,
    disambiguation: optionText("disambiguation", disambiguation, DISAMBIGUATIONS, span),
    overflow: optionText("overflow", overflow, OVERFLOWS, span),
  };
}

function optionText<T extends string>(
  name: string,
  value: SerializableRuntimeValue,
  allowed: readonly T[],
  span: SourceSpan,
): T {
  const chosen = allowed.find((text) => text === value);
  if (chosen !== undefined) return chosen;
  throw fault(
    "TSR059",
    `'${name}:' takes ${listed(
      allowed.map((text) => `"${text}"`),
      "or",
    )}, not ${shownChoice(value)}.`,
    span,
  );
}

function optionList(options: readonly string[]): string {
  return listed(
    options.map((option) => `'${option}:'`),
    "and",
  );
}

/** Items joined as in "a and b" or "a, b, and c". */
function listed(items: readonly string[], conjunction: "and" | "or"): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")}${items.length > 2 ? "," : ""} ${conjunction} ${items.at(-1)!}`;
}

/**
 * The moment `start` moved by a calendar duration in a zone (research T4): months, then days, in the zone's local
 * fields, the result resolved once, then the exact offset. Without months and days only the exact offset is added, so
 * the local time is not resolved again.
 */
function anchoredEnd(
  start: number,
  amount: StoredCalendarDuration,
  { rules, disambiguation, overflow }: MethodOptions,
  span: SourceSpan,
): number {
  if (amount.months === 0 && amount.days === 0)
    return start + roundToMillisecond(amount.milliseconds);
  const fields = unwrap(localFields(rules, start), span);
  const date = shiftedDate(fields, amount.months, amount.days, overflow, span);
  return (
    resolvedMoment(rules, { ...fields, ...date }, disambiguation, span) +
    roundToMillisecond(amount.milliseconds)
  );
}

/** The moment of a local date and time in a zone; `reject` refuses a time the zone skips or repeats. */
function resolvedMoment(
  rules: ZoneRules,
  value: DateTimeFields,
  disambiguation: Disambiguation,
  span: SourceSpan,
): number {
  if (disambiguation === "reject") {
    const transition = localTimeTransition(rules, value);
    if (transition !== null)
      throw fault(
        TEMPORAL_FAILURE,
        `${formatIsoDateTime(value)} ${transition === "skipped" ? "does not exist" : "happens twice"} in ${rules.name}, because the clocks ${transition === "skipped" ? "skip" : "repeat"} it there, and 'disambiguation: "reject"' refuses such a time. Use another time, or 'disambiguation: "earlier"' or 'disambiguation: "later"' to take the moment before or after.`,
        span,
      );
  }
  return unwrap(
    zonedTimestamp(rules, value, disambiguation === "reject" ? "compatible" : disambiguation),
    span,
  );
}

/** A date moved by months, then days; `reject` refuses a day that the target month lacks. */
function shiftedDate(
  date: DateFields,
  months: number,
  days: number,
  overflow: Overflow,
  span: SourceSpan,
): DateFields {
  const lacking = overflow === "reject" ? monthOverflow(date, months) : null;
  if (lacking !== null)
    throw fault(
      TEMPORAL_FAILURE,
      `${formatIsoDate(date)} moved by ${formatDuration(calendarDuration({ months, days: 0, milliseconds: 0 }))} lands on day ${date.day}, but ${lacking}, and 'overflow: "reject"' refuses that. Leave out the option to take the last day of the month.`,
      span,
    );
  const moved = addCalendarParts(date, months, days);
  if (moved === undefined)
    throw fault(TEMPORAL_FAILURE, "The result lies outside the years 0000 to 9999.", span);
  return moved;
}

/**
 * A date or a date and time moved by a calendar duration (ADR 0026), keeping the clock time: its months, then its
 * days. A duration, or a calendar duration with exact time, does not move a local value, which has no time zone.
 */
function movedLocally<T extends SerializableRuntimeDate | SerializableRuntimeDateTime>(
  value: T,
  duration: AnyDuration,
  overflow: Overflow,
  span: SourceSpan,
): T {
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
  return { ...value, ...shiftedDate(value, duration.months, duration.days, overflow, span) };
}

/**
 * Ordering and arithmetic with a date or time operand (V30 §35, ADR 0026), or `undefined` when neither operand is one.
 * No operator reads a zone: exact durations apply only to an absolute date and time, and calendar units only to local
 * dates and dates and times.
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
   * date and time moves by exact time, and a date or a date and time by calendar units, keeping its clock time.
   */
  function moved(
    value:
      SerializableRuntimeDate | SerializableRuntimeDateTime | SerializableRuntimeAbsoluteDateTime,
    duration: AnyDuration,
  ): SerializableRuntimeDate | SerializableRuntimeDateTime | SerializableRuntimeAbsoluteDateTime {
    if (value.kind !== "absoluteDateTime") return movedLocally(value, duration, "constrain", span);
    if (isCalendar(duration))
      throw fault(
        "TSR009",
        `An absolute date and time has no calendar, so '${operator}' cannot move it by calendar units. Use add(...), which counts them in the player's time zone, as in 'value.add(${operator === "-" ? "-" : ""}1 calendar day)'.`,
        span,
      );
    return absoluteDateTime(
      value.epochMilliseconds + roundToMillisecond(duration.milliseconds),
      span,
    );
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
