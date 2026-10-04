import { isNumberAnswerText } from "./interaction-answers.js";
import {
  parseIsoDate,
  parseIsoDateTime,
  parseIsoTime,
  parseIsoTimestamp,
  type TemporalResult,
} from "./temporal.js";

/**
 * The V30 §13 conversion and rounding built-ins, including the §35 date and time conversions. The text rules are shared
 * by the compiler, which rejects provably invalid constant text, and the runtime.
 */
export const CONVERSION_RESULTS = new Map([
  ["toString", "string"],
  ["toNumber", "number"],
  ["toInteger", "integer"],
  ["toBoolean", "boolean"],
  ["toDate", "date"],
  ["toTime", "time"],
  ["toDateTime", "datetime"],
  ["toTimestamp", "timestamp"],
] as const);

export type ConversionName =
  typeof CONVERSION_RESULTS extends ReadonlyMap<infer K, unknown> ? K : never;

const CONVERSION_NAMES: ReadonlySet<string> = new Set(CONVERSION_RESULTS.keys());

export function isConversionName(name: string): name is ConversionName {
  return CONVERSION_NAMES.has(name);
}

export type ConversionResult =
  typeof CONVERSION_RESULTS extends ReadonlyMap<string, infer V> ? V : never;

export type TemporalConversionResult = "date" | "time" | "datetime" | "timestamp";

/** What each date and time conversion converts besides text, and the ISO text it reads (V30 §35). */
export const TEMPORAL_CONVERSIONS: Readonly<
  Record<
    TemporalConversionResult,
    {
      readonly from: readonly TemporalConversionResult[];
      readonly converts: string;
      readonly text: string;
      readonly parse: (text: string) => TemporalResult<unknown>;
    }
  >
> = {
  date: {
    from: ["date", "datetime"],
    converts: "text, a date, or a date and time",
    text: 'ISO date text such as "2026-10-04"',
    parse: parseIsoDate,
  },
  time: {
    from: ["time", "datetime"],
    converts: "text, a time, or a date and time",
    text: 'ISO time text such as "14:30"',
    parse: parseIsoTime,
  },
  datetime: {
    from: ["datetime"],
    converts: "text, a date and time, or a date and a time",
    text: 'local ISO date and time text without an offset, such as "2026-10-04T18:00"',
    parse: parseIsoDateTime,
  },
  timestamp: {
    from: ["timestamp"],
    converts: "text or a timestamp",
    text: 'ISO timestamp text with Z or an offset, such as "2026-10-04T12:30:00Z"',
    parse: parseIsoTimestamp,
  },
};

export function isTemporalConversionResult(
  result: ConversionResult,
): result is TemporalConversionResult {
  return Object.hasOwn(TEMPORAL_CONVERSIONS, result);
}

/**
 * Why `text` does not convert to a date or time value, as the end of a sentence (`: February 2026 has 28 days` or
 * `; the text must be ISO date text such as ...`), or `undefined` when it converts.
 */
export function temporalTextProblem(
  result: TemporalConversionResult,
  text: string,
): string | undefined {
  const conversion = TEMPORAL_CONVERSIONS[result];
  const parsed = conversion.parse(text);
  if (parsed.ok) return undefined;
  return parsed.reason === null ? `; the text must be ${conversion.text}` : `: ${parsed.reason}`;
}

/** A plain-language description of a conversion result, such as "a whole number (integer)". */
export function describeConversionResult(result: ConversionResult): string {
  switch (result) {
    case "string":
      return "text (string)";
    case "number":
      return "a number";
    case "integer":
      return "a whole number (integer)";
    case "boolean":
      return "true or false (boolean)";
    case "date":
      return "a date";
    case "time":
      return "a time";
    case "datetime":
      return "a date and time";
    case "timestamp":
      return "a timestamp";
  }
}

/** Whether `value` is already a result of the conversion, as a `default:` fallback must be. */
export function isConversionResult(result: ConversionResult, value: unknown): boolean {
  if (isTemporalConversionResult(result))
    return typeof value === "object" && value !== null && "kind" in value && value.kind === result;
  return result === "integer" ? Number.isInteger(value) : typeof value === result;
}

export const ROUNDING_BUILTINS: ReadonlySet<string> = new Set(["round", "floor", "ceil"]);

/** `min` and `max` of two or more numbers or durations (V30 §13). */
export const MIN_MAX_BUILTINS: ReadonlySet<string> = new Set(["min", "max"]);

/**
 * The number written in `text`: the decimal or scientific form `askNumber` accepts, with surrounding whitespace
 * ignored, or `undefined` when the text is not such a finite number.
 */
export function numberFromText(text: string): number | undefined {
  const trimmed = text.trim();
  if (!isNumberAnswerText(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? withoutNegativeZero(value) : undefined;
}

/** `true` or `false` written in `text`, with surrounding whitespace ignored, or `undefined`. */
export function booleanFromText(text: string): boolean | undefined {
  const trimmed = text.trim();
  return trimmed === "true" ? true : trimmed === "false" ? false : undefined;
}

/** `round` (ties away from zero), `floor`, or `ceil` of a finite number. */
export function rounded(name: string, value: number): number {
  const whole =
    name === "floor"
      ? Math.floor(value)
      : name === "ceil"
        ? Math.ceil(value)
        : Math.sign(value) * Math.round(Math.abs(value));
  return withoutNegativeZero(whole);
}

export function withoutNegativeZero(value: number): number {
  return value === 0 ? 0 : value;
}
