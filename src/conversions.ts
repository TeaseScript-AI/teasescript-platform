import type { ScalarTypeName } from "./ast.js";
import { isNumberAnswerText } from "./interaction-answers.js";
import { CONVERSION_FUNCTIONS, type ConversionName } from "./language-facts.js";
import {
  parseIsoDate,
  parseIsoDateTime,
  parseIsoTime,
  parseIsoTimestamp,
  type TemporalResult,
} from "./temporal.js";

/**
 * How a built-in of one positional argument is called: the conversions, and the file and hash functions of text (V30
 * §13, §33). The compiler's checks, the runtime's, and the editor's help read it.
 */
export interface CallShape {
  /** The positional argument, as diagnostics and help name it, such as `value` or `text`. */
  readonly parameter: string;
  /** A second form, of two positional arguments of these types: `toDateTime(date, time)`. */
  readonly pair?: readonly [ScalarTypeName, ScalarTypeName];
  /** The `default:` that the call gives for a value it cannot use, or `null` for a call that takes none. */
  readonly fallback: CallDefault | null;
  /**
   * Whether the call takes `files:`, true or false, true by default: with files, `toJson` writes stored files as data
   * URLs and `fromJson` turns data URLs back into stored files (V30 §13).
   */
  readonly files: boolean;
}

/**
 * A call's `default:`, which it gives for a value it cannot use. It is evaluated last, and only when it is used (owner
 * decision, 2026-10-16; `lazy-defaults.ts`).
 */
export interface CallDefault {
  /** Why a call needs one, after "for", such as "text that is not valid JSON"; `null` when it may leave it out. */
  readonly required: string | null;
  /** What it may be: a value of the call's result type, also `null` with `optional`, or any value. */
  readonly type: "result" | "optional" | "any";
}

/** The type of what a conversion gives, apart from its default. */
export type ConversionResult =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "date"
  | "time"
  | "datetime"
  | "absoluteDateTime"
  | "regex";

/**
 * A conversion built-in (V30 §8, §13, §35): how it is called, what its argument may be, what it gives, and its help.
 * Every conversion only reads copies of its arguments, and to show a date or time the player's presentation, and gives
 * a new value. One that takes `files:` may instead wait for the Player's file store, unless a written `files: false`
 * keeps files out (`conversionWaitsForFiles`); it then runs as a file store instruction. The evaluator runs each one
 * as its `CONVERSION_RUNS` entry says.
 */
export type Conversion = CallShape & {
  /** What the call does, for the editor's help. */
  readonly summary: string;
} & (
    | {
        /**
         * A value that it converts to its result: one of `kinds`, where `shown` stands for every value that `${...}`
         * shows as text (V30 §8), or text that reads as the result.
         */
        readonly takes: "value";
        readonly result: ConversionResult;
        readonly kinds: readonly ScalarTypeName[] | "shown";
        /** What it converts, as a diagnostic names it, such as "text and numbers". */
        readonly converts: string;
        /**
         * Why `text` does not convert, as the end of a sentence (`: February 2026 has 28 days`) or a sentence of its own
         * (`. The text must be ...`), or `undefined` when it does. The compiler applies it to text it can see, and the
         * runtime to every text.
         */
        readonly textProblem: (text: string) => string | undefined;
      }
    | {
        /** Text, which the call uses as `does` says, such as "reads pattern text (string)". */
        readonly takes: "text";
        readonly does: string;
        /** `fromJson` gives what the JSON holds. */
        readonly result: ConversionResult | "unknown";
      }
    | { readonly takes: "json"; readonly result: "string" }
  );

/** A conversion of a value to its result, such as `toNumber`. */
export type ValueConversion = Extract<Conversion, { readonly takes: "value" }>;

const CONVERTED =
  " A value that cannot convert is an error, or gives the default when one is written.";

/** A conversion of a value of `kinds`, or of text that reads as one, to `result`, with an optional default. */
function converting(
  result: ConversionResult,
  kinds: readonly ScalarTypeName[] | "shown",
  converts: string,
  textProblem: (text: string) => string | undefined,
  summary: string,
): ValueConversion & { readonly fallback: CallDefault; readonly files: false } {
  return {
    parameter: "value",
    fallback: { required: null, type: "result" },
    files: false,
    takes: "value",
    result,
    kinds,
    converts,
    textProblem,
    summary: `${summary}${CONVERTED}`,
  };
}

/** Why text does not read with `parse`, as a conversion's `textProblem`; `expected` describes the text it reads. */
function isoTextProblem(
  parse: (text: string) => TemporalResult<unknown>,
  expected: string,
): (text: string) => string | undefined {
  return (text) => {
    const parsed = parse(text);
    if (parsed.ok) return undefined;
    return parsed.reason === null ? `. The text must be ${expected}` : `: ${parsed.reason}`;
  };
}

const NUMBER_TEXT = (text: string) =>
  numberFromText(text) === undefined ? ". The text must be a number such as 2.5 or -3" : undefined;

/** Each conversion's contract by its name, which `language-facts.ts` lists. */
export const CONVERSIONS = {
  toString: converting(
    "string",
    "shown",
    "text, numbers, true or false, null, durations, angles, date and time values, script references, and regexes",
    () => undefined,
    'Gives the text that "${value}" shows, for text, numbers, true and false, null, durations, angles, date and time values, script references, and regexes. A list is combined into text with join().',
  ),
  toNumber: converting(
    "number",
    ["integer", "number"],
    "text and numbers",
    NUMBER_TEXT,
    'Converts a number, or number text such as "2.5", "-3", ".5", or "1e3", to a number. Surrounding whitespace is ignored.',
  ),
  toInteger: converting(
    "integer",
    ["integer", "number"],
    "text and numbers",
    NUMBER_TEXT,
    "Converts a number, or number text, to an integer, discarding the fractional part toward zero: toInteger(-2.7) is -2. Round with round, floor, or ceil instead.",
  ),
  toBoolean: converting(
    "boolean",
    ["boolean"],
    "text and true or false (boolean)",
    (text) =>
      booleanFromText(text) === undefined ? '. The text must be "true" or "false"' : undefined,
    'Converts true and false, and the text "true" or "false" with surrounding whitespace ignored. A number does not convert: compare it instead, such as value != 0.',
  ),
  toDate: converting(
    "date",
    ["date", "datetime"],
    "text, a date, or a date and time",
    isoTextProblem(parseIsoDate, 'ISO date text such as "2026-10-04"'),
    'Converts strict ISO date text such as "2026-10-04", a date, or the date of a datetime to a date.',
  ),
  toTime: converting(
    "time",
    ["time", "datetime"],
    "text, a time, or a date and time",
    isoTextProblem(parseIsoTime, 'ISO time text such as "14:30"'),
    'Converts ISO time text such as "14:30" or "14:30:15.250", a time, or the clock time of a datetime to a time.',
  ),
  toDateTime: {
    ...converting(
      "datetime",
      ["datetime"],
      "text, a date and time, or a date and a time",
      isoTextProblem(
        parseIsoDateTime,
        'local ISO date and time text without an offset, such as "2026-10-04T18:00"',
      ),
      'Converts local ISO date and time text without an offset, such as "2026-10-04T18:00", or a datetime to a datetime, or combines a date and a time into one.',
    ),
    pair: ["date", "time"],
  },
  toAbsoluteDateTime: converting(
    "absoluteDateTime",
    ["absoluteDateTime"],
    "text or an absolute date and time",
    isoTextProblem(
      parseIsoTimestamp,
      'ISO text with Z or an offset, such as "2026-10-04T12:30:00Z"',
    ),
    'Converts ISO text with Z or an offset, such as "2026-10-04T12:30:00Z", or an absoluteDateTime to an absoluteDateTime.',
  ),
  toRegex: {
    parameter: "text",
    fallback: { required: "text that is not a valid regex", type: "optional" },
    files: false,
    takes: "text",
    does: "reads pattern text (string)",
    result: "regex",
    summary:
      'Makes a regex of pattern text, with its flags inside it, such as "(?i)yes|no"; in a string a backslash is written twice. Text that is not a valid pattern, or that is over the regex limits, gives the default, a regex or null.',
  },
  toJson: {
    parameter: "value",
    fallback: null,
    files: true,
    takes: "json",
    result: "string",
    summary:
      "Writes a value as compact JSON text. Stored files are written as data URLs, unless files: false keeps their references as text. A calendar duration, range, script reference, regex, or handle cannot be written.",
  },
  fromJson: {
    parameter: "text",
    fallback: { required: "text that is not valid JSON", type: "any" },
    files: true,
    takes: "text",
    does: "reads text (string)",
    result: "unknown",
    summary:
      "Reads JSON text: an object becomes a dict, an array a list, and a whole number an integer. Text that is not JSON gives the default, which may be any value. Data URLs of images, audio, and video become stored files, unless files: false keeps them as text.",
  },
  toBase64: {
    parameter: "text",
    fallback: null,
    files: false,
    takes: "text",
    does: "encodes text (string)",
    result: "string",
    summary: "Encodes text as UTF-8 in standard Base64, with padding and without line breaks.",
  },
  fromBase64: {
    parameter: "text",
    fallback: { required: "text that is not valid Base64", type: "any" },
    files: false,
    takes: "text",
    does: "reads text (string)",
    result: "string",
    summary:
      "Decodes Base64 into UTF-8 text; spaces, line breaks, the URL alphabet, and missing padding are accepted. Text that is not Base64, or whose bytes are not UTF-8, gives the default, which may be any value.",
  },
} as const satisfies { readonly [Name in ConversionName]: Conversion };

type ConversionsWith<Facts> = {
  [Name in ConversionName]: (typeof CONVERSIONS)[Name] extends Facts ? Name : never;
}[ConversionName];
/** The conversions that take a `default:`. */
export type DefaultedConversion = Exclude<
  ConversionName,
  ConversionsWith<{ readonly fallback: null }>
>;
/** The conversions that take `files:`, which may wait for the Player's file store. */
export type FileConversion = ConversionsWith<{ readonly files: true }>;

/** Whether the conversion takes a `default:`. */
export function takesDefault(name: ConversionName): name is DefaultedConversion {
  return CONVERSIONS[name].fallback !== null;
}

/** Whether the conversion takes `files:`. */
export function takesFiles(name: ConversionName): name is FileConversion {
  return CONVERSIONS[name].files;
}

export function isConversion(name: string): name is ConversionName {
  return Object.hasOwn(CONVERSIONS, name);
}

/**
 * Whether a call of the conversion may wait for the Player's file store (V30 §13): one that takes `files:`, unless a
 * written `files: false` keeps files out. Any other call of a conversion only reads (see `Conversion`).
 */
export function conversionWaitsForFiles(name: ConversionName, filesKeptOut: boolean): boolean {
  return takesFiles(name) && !filesKeptOut;
}

/** The file and hash functions of text (V30 §13, §33), each called as its `CallShape` says. */
export const FILE_TEXT_FUNCTIONS: ReadonlyMap<string, CallShape> = new Map([
  [
    "fileFromBase64",
    {
      parameter: "text",
      fallback: { required: "text that is not valid Base64", type: "any" },
      files: false,
    },
  ],
  ["fileToBase64", { parameter: "file", fallback: null, files: false }],
  ["hashText", { parameter: "text", fallback: null, files: false }],
  ["hashFile", { parameter: "file", fallback: null, files: false }],
]);

/** The conversion of text to a value of `result`, which a fix names, such as `toDate` for a date. */
export function conversionTo(result: ScalarTypeName): ConversionName | undefined {
  return CONVERSION_FUNCTIONS.find(
    (name) => CONVERSIONS[name].takes === "value" && CONVERSIONS[name].result === result,
  );
}

/**
 * The call as the editor's help writes it, from its shape, such as `toNumber(value [, default: number])` or
 * `fromJson(text, default: value [, files: boolean])`.
 */
export function conversionSyntax(name: ConversionName): string {
  const conversion: Conversion = CONVERSIONS[name];
  const { fallback } = conversion;
  const value =
    fallback === null || fallback.type === "any" || conversion.result === "unknown"
      ? "value"
      : `${conversion.result}${fallback.type === "optional" ? "?" : ""}`;
  const named = `${
    fallback === null
      ? ""
      : fallback.required === null
        ? ` [, default: ${value}]`
        : `, default: ${value}`
  }${conversion.files ? " [, files: boolean]" : ""}`;
  const forms = [
    [conversion.parameter],
    ...(conversion.pair === undefined ? [] : [conversion.pair]),
  ];
  return forms.map((parameters) => `${name}(${parameters.join(", ")}${named})`).join("  or  ");
}

/** What a conversion's `default:` must be, as a diagnostic names it, or `undefined` when any value fits. */
export function defaultDescription(conversion: Conversion): string | undefined {
  const { fallback, result } = conversion;
  if (fallback === null || fallback.type === "any" || result === "unknown") return undefined;
  return `${describeConversionResult(result)}${fallback.type === "optional" ? " or null" : ""}`;
}

/** Whether `value` may be the conversion's `default:` (see `defaultDescription`). */
export function fitsDefault(conversion: Conversion, value: unknown): boolean {
  const { fallback, result } = conversion;
  if (fallback === null || fallback.type === "any" || result === "unknown") return true;
  return (fallback.type === "optional" && value === null) || isConversionResult(result, value);
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
    case "absoluteDateTime":
      return "an absolute date and time";
    case "regex":
      return "a regex";
  }
}

/** Whether `value` is already a value of `result`, as a `default:` fallback must be. */
function isConversionResult(result: ConversionResult, value: unknown): boolean {
  if (typeof value === "object" && value !== null) return "kind" in value && value.kind === result;
  return result === "integer" ? Number.isInteger(value) : typeof value === result;
}

/** `min` and `max` of two or more numbers or durations (V30 §13). */
export const MIN_MAX_BUILTINS: ReadonlySet<string> = new Set(["min", "max"]);

/**
 * Why `toJson` cannot write a value, after "which": a handle exists only in the current session, and a calendar duration,
 * a range, and a script reference have no JSON form.
 */
export function unwritableJsonReason(session: boolean): string {
  return session ? "exists only in the current session" : "has no JSON form";
}

export const WRITABLE_JSON_FIX =
  "Write plain values, such as text, numbers, lists, or dicts, instead.";

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

export function withoutNegativeZero(value: number): number {
  return value === 0 ? 0 : value;
}
