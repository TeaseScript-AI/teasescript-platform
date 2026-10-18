import type { RuntimeErrorCode } from "../../diagnostic-codes.js";
import type { PlanSourceLocation } from "../../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../../source.js";
import { RuntimeFault } from "../errors.js";
import { copySpan } from "../operations/support.js";
import { rangeLength, rangeText, wholeRangeMessage } from "../../range-checks.js";
import type { SerializableRuntimeRange } from "../serializable-values.js";

// What the evaluator and its evaluation modules share.

export type SourceSpan = RichSourceSpan | PlanSourceLocation;

export function fault(code: RuntimeErrorCode, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}

/**
 * What a call gives when it needs its `default:`, which runs only then (owner decision, 2026-10-16), or a call or `load`
 * of `evaluateWithoutDefault` that needs the default that the instructions after it run.
 */
export const USE_DEFAULT: unique symbol = Symbol("use the default");

/** `TSR045` unless `range` has whole-number bounds and a length that a number counts exactly. */
export function assertIntegerRange(
  range: SerializableRuntimeRange,
  subject: string,
  span: SourceSpan,
): void {
  const length = rangeLength(range);
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    !Number.isSafeInteger(length)
  ) {
    throw fault(
      "TSR045",
      !Number.isInteger(range.start) || !Number.isInteger(range.end)
        ? wholeRangeMessage(subject, `this range is ${rangeText(range)}`)
        : Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
          ? `${subject} needs a range it can count, but ${rangeText(range)} holds too many numbers. Use a smaller range.`
          : `${subject} needs a range of whole numbers, but the bounds of ${rangeText(range)} are too large. Use bounds closer to 0.`,
      span,
    );
  }
}
