import { argumentShapeProblem, callShapeProblem, positionalShape } from "../argument-rules.js";
import {
  booleanFromText,
  CONVERSIONS,
  numberFromText,
  withoutNegativeZero,
  type Conversion,
} from "../conversions.js";
import type { RuntimeErrorCode } from "../diagnostic-codes.js";
import type { ConversionName, NumericFunctionName } from "../language-facts.js";
import {
  isNumericFailure,
  numberArgumentMessage,
  NUMERIC_CONTRACTS,
  numericResult,
  type NumberSignature,
  type NumericFunction,
} from "../numeric-functions.js";
import type { StoredAngle } from "../angle.js";
import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import { checkCollectionLength } from "./collection-size.js";
import { internalFault, RuntimeFault } from "./errors.js";
import { base64Text, jsonText, textFromBase64, valueFromJson } from "./json-base64.js";
import { copySpan } from "./operations/support.js";
import {
  createCapturedSerializableList,
  type SerializableRuntimeProperty,
  type SerializableRuntimeValue,
  type SerializableSpeakerReference,
} from "./serializable-values.js";
import { regexFromText } from "./string-operations.js";
import { combinedDateAndTime, temporalConverted } from "./temporal-operations.js";
import { checkTextLength } from "./text-length.js";
import { isAngle, isList, isRange, isSet } from "./value-predicates.js";
import { isVisibleScalar } from "./value-text.js";
import { describeValue } from "../value-kinds.js";

/**
 * Operations that only read their values and give a new one: `+` on text or lists, the numeric and angle functions, and
 * the conversions. The evaluator runs them, and the compiler computes known values with them (`static-evaluation.ts`),
 * so a value the compiler knows is the value the script gets.
 */

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/**
 * `+` on text or a list (V30 §4): two texts join, and two lists give a new list of copies of the left elements, then
 * the right ones. Nothing converts, so any other operand fails with what to write instead.
 */
export function joinedValue(
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
  span: SourceSpan,
): SerializableRuntimeValue {
  if (typeof left === "string" && typeof right === "string") {
    checkTextLength(left.length + right.length, "joining with +", span);
    return left + right;
  }
  if (isList(left) && isList(right)) {
    checkCollectionLength(
      "list",
      left.items.length + right.items.length,
      Math.max(left.items.length, right.items.length),
      "joining with +",
      span,
    );
    return createCapturedSerializableList(left.items.concat(right.items));
  }
  throw fault(
    "TSR009",
    `'+' joins two texts or two lists and adds numbers or durations, but these are ${describeValue(left)} and ${describeValue(right)}.${joinFix(left, right)}`,
    span,
  );
}

/** What to write instead of `+` on text or a list and a value of another kind; the left operand names what was meant. */
function joinFix(left: SerializableRuntimeValue, right: SerializableRuntimeValue): string {
  if (isSet(left) || isSet(right))
    return " Join sets with union(), or copy a set into a list with toList() first.";
  if (isList(left) && isRange(right))
    return " To add the numbers of a range, write list + range.toList().";
  if (isList(left))
    return " To add one element, use add(value), or write list + [value] for a new list.";
  if (isRange(left) && isList(right))
    return " To add the numbers of a range, write range.toList() + list.";
  if (typeof left !== "string" && isList(right)) return " Write [value] + list for a new list.";
  return isVisibleScalar(typeof left === "string" ? right : left)
    ? ' Put the value in the text instead, as in "${first}${second}".'
    : "";
}

/** A call of a numeric or angle function (see `NUMERIC_CONTRACTS`); a call without a result fails. */
export function numericFunction(
  name: NumericFunctionName,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): number | StoredAngle {
  const numeric: NumericFunction = NUMERIC_CONTRACTS[name];
  const { numbers, options } = callNumbers(name, numeric, positional, named, span);
  const result = numericResult(numeric, numbers, options);
  if (isNumericFailure(result)) throw fault(result.code, result.failure, span);
  return result;
}

/**
 * The numbers of a call of a function whose every argument is a number or an angle, such as a numeric function or
 * `chance`, by position and by name, an angle as its degrees; a call of another shape, or with a value of another kind,
 * fails.
 */
export function callNumbers(
  name: string,
  signature: NumberSignature & { readonly result: unknown },
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  span: SourceSpan,
): { readonly numbers: readonly number[]; readonly options: Readonly<Record<string, number>> } {
  const { parameters, named: names = [] } = signature;
  const problem = argumentShapeProblem(
    name,
    { ...positionalShape(parameters), names },
    positional.length,
    Object.keys(named),
    parameters.length > 0,
  );
  if (problem !== undefined) throw fault("TSR028", problem.message, span);
  const number = (value: SerializableRuntimeValue, place: string): number => {
    if (signature.takes === "angles") {
      if (isAngle(value)) return value.degrees;
    } else if (typeof value === "number") return value;
    throw fault(
      "TSR059",
      numberArgumentMessage(
        name,
        signature,
        describeValue(value),
        typeof value === "number"
          ? "number"
          : typeof value === "string"
            ? "string"
            : isAngle(value)
              ? "angle"
              : "other",
        place,
      ),
      span,
    );
  };
  return {
    numbers: positional.map((value) => number(value, "")),
    options: Object.fromEntries(
      Object.entries(named).map(([key, value]) => [key, number(value, ` as its ${key}:`)]),
    ),
  };
}

/** What a conversion reads while it runs, besides its arguments. */
export interface ConversionRun {
  readonly span: SourceSpan;
  /** A scalar as `${...}` shows it, dates and times in the player's presentation, which `toString` gives. */
  readonly text: (value: SerializableRuntimeValue) => string;
  /** A speaker's properties, which `toJson` writes. */
  readonly speakerProperties: (
    speaker: SerializableSpeakerReference,
  ) => readonly SerializableRuntimeProperty[];
}

/**
 * How each conversion runs (see `CONVERSIONS`): its result, or `undefined` for a value that it does not convert or text
 * that it does not read, for which the call gives its default or fails.
 */
const CONVERSION_RUNS: {
  readonly [Name in ConversionName]: (
    positional: readonly SerializableRuntimeValue[],
    run: ConversionRun,
  ) => SerializableRuntimeValue | undefined;
} = {
  toString: ([value], run) => (isVisibleScalar(value!) ? run.text(value!) : undefined),
  toNumber: ([value]) => numberOf(value!),
  toInteger: ([value]) => {
    const number = numberOf(value!);
    return number === undefined ? undefined : withoutNegativeZero(Math.trunc(number));
  },
  toBoolean: ([value]) =>
    typeof value === "boolean"
      ? value
      : typeof value === "string"
        ? booleanFromText(value)
        : undefined,
  toDate: ([value]) => temporalConverted("date", value!),
  toTime: ([value]) => temporalConverted("time", value!),
  // A date and a time combine into one date and time (V30 §35).
  toDateTime: ([value, time]) =>
    time === undefined ? temporalConverted("datetime", value!) : combinedDateAndTime(value!, time),
  toAbsoluteDateTime: ([value]) => temporalConverted("absoluteDateTime", value!),
  toRegex: ([text]) => regexFromText(text!),
  toJson: ([value], run) => jsonText(value!, run.speakerProperties, run.span),
  // JSON's null is a value; only text that does not read gives the default.
  fromJson: ([text], run) => (typeof text === "string" ? valueFromJson(text, run.span) : undefined),
  toBase64: ([text], run) => {
    if (typeof text !== "string")
      throw fault(
        "TSR059",
        `toBase64(...) ${CONVERSIONS.toBase64.does}, not ${describeValue(text!)}.`,
        run.span,
      );
    return base64Text(text, run.span);
  },
  fromBase64: ([text]) => (typeof text === "string" ? textFromBase64(text) : undefined),
};

/** A number, or the number that number text holds (V30 §13), or `undefined` for any other value. */
function numberOf(value: SerializableRuntimeValue): number | undefined {
  return typeof value === "number"
    ? withoutNegativeZero(value)
    : typeof value === "string"
      ? numberFromText(value)
      : undefined;
}

/**
 * The result of a call of the conversion `name` as an ordinary call, which only a file store is not: its value, or
 * `undefined` for a value it does not convert or text it does not read, for which the call gives its default or fails.
 * `defaulted`: the call has a `default:`, which `named` leaves out. A call of another shape fails.
 */
export function conversionResult(
  name: ConversionName,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  defaulted: boolean,
  run: ConversionRun,
): SerializableRuntimeValue | undefined {
  const conversion: Conversion = CONVERSIONS[name];
  // Only a call with a written `files: false` is an ordinary call; with files it is a file store.
  if (conversion.files && named.files !== undefined && named.files !== false)
    throw fault(
      "TSR028",
      internalFault(`${name}(...) with files reached an ordinary call instead of a file store.`),
      run.span,
    );
  const problem = callShapeProblem(
    name,
    conversion,
    positional.length,
    Object.keys(named),
    defaulted,
  );
  if (problem !== undefined) throw fault("TSR028", problem.message, run.span);
  return CONVERSION_RUNS[name](positional, run);
}

function fault(code: RuntimeErrorCode, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
