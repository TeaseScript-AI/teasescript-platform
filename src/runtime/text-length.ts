import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/**
 * The longest a text can be, in UTF-16 code units: what V8 holds on 64-bit hosts. The runtime enforces it in every host,
 * so a script fails the same way in every browser.
 */
export const MAX_TEXT_LENGTH = 536_870_888;

/**
 * `TSR084`: `operation` would make a text longer than `MAX_TEXT_LENGTH`; `length` is how long, in UTF-16 code units,
 * or `null` when it is not known. A length too large for a number is not shown either.
 */
export function textTooLong(
  operation: string,
  span: SourceSpan,
  length: number | null,
): RuntimeFault {
  const size =
    length === null || !Number.isFinite(length)
      ? ""
      : ` of about ${groupedDigits(length)} characters`;
  return new RuntimeFault(
    "TSR084",
    `Text too long: ${operation} would make a text${size}; a text can hold at most about ${Math.floor(MAX_TEXT_LENGTH / 1_000_000)} million.`,
    copySpan(span),
  );
}

/** Fails with `TSR084` before `operation` makes a text of `length` UTF-16 code units that is longer than any text can be. */
export function checkTextLength(length: number, operation: string, span: SourceSpan): void {
  if (length > MAX_TEXT_LENGTH) throw textTooLong(operation, span, length);
}

/**
 * The text that `build`, one native text operation whose length is not known before, makes; `TSR084` when it would be
 * longer than any text can be, whether the host refuses to build it or builds it after all.
 */
export function boundedText(build: () => string, operation: string, span: SourceSpan): string {
  let text: string;
  try {
    text = build();
  } catch (error) {
    // A single native text operation throws a RangeError only when its result is too long to build.
    if (error instanceof RangeError) throw textTooLong(operation, span, null);
    throw error;
  }
  if (text.length > MAX_TEXT_LENGTH) throw textTooLong(operation, span, null);
  return text;
}

/** A whole number with thousands separators, such as 9,007,199,254,740,991. */
function groupedDigits(value: number): string {
  return BigInt(Math.round(value))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}
