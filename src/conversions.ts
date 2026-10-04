import { isNumberAnswerText } from "./interaction-answers.js";

/**
 * The V30 §13 conversion and rounding built-ins. The text rules are shared by the compiler, which rejects provably
 * invalid constant text, and the runtime.
 */
export const CONVERSION_RESULTS = new Map([
  ["toString", "string"],
  ["toNumber", "number"],
  ["toInteger", "integer"],
  ["toBoolean", "boolean"],
] as const);

export type ConversionName =
  typeof CONVERSION_RESULTS extends ReadonlyMap<infer K, unknown> ? K : never;

const CONVERSION_NAMES: ReadonlySet<string> = new Set(CONVERSION_RESULTS.keys());

export function isConversionName(name: string): name is ConversionName {
  return CONVERSION_NAMES.has(name);
}

export type ConversionResult = "string" | "number" | "integer" | "boolean";

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
  }
}

/** Whether `value` is already a result of the conversion, as a `default:` fallback must be. */
export function isConversionResult(result: ConversionResult, value: unknown): boolean {
  return result === "integer" ? Number.isInteger(value) : typeof value === result;
}

export const ROUNDING_BUILTINS: ReadonlySet<string> = new Set(["round", "floor", "ceil"]);

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
