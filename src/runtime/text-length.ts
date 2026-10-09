import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import { RUNTIME_DEBUG_TRACE_LIMITS } from "./debug-trace.js";
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
  const most = `${Math.floor(MAX_TEXT_LENGTH / 1_000_000)} million`;
  return new RuntimeFault(
    "TSR084",
    length === null || !Number.isFinite(length)
      ? `Text too long: ${operation} would make a text longer than a text can hold, which is about ${most} characters.`
      : `Text too long: ${operation} would make about ${groupedDigits(length)} characters, but a text can hold at most about ${most}.`,
    copySpan(span),
  );
}

/** Fails with `TSR084` before `operation` makes a text of `length` UTF-16 code units that is longer than any text can be. */
export function checkTextLength(length: number, operation: string, span: SourceSpan): void {
  if (length > MAX_TEXT_LENGTH) throw textTooLong(operation, span, length);
}

/**
 * Text from the script as an error message quotes it: cut to the length Debug previews a value with, ending with "…"
 * when cut, so that a message never gets too long itself.
 */
export function messageText(text: string): string {
  const limit = RUNTIME_DEBUG_TRACE_LIMITS.maxPreviewCharacters;
  if (text.length <= limit) return text;
  // A surrogate pair stays whole.
  const end = isHighSurrogateAt(text, limit - 1) ? limit - 1 : limit;
  return `${text.slice(0, end)}…`;
}

function isHighSurrogateAt(text: string, index: number): boolean {
  const unit = text.charCodeAt(index);
  return unit >= 0xd800 && unit <= 0xdbff;
}

/** How many UTF-16 code units each BMP code unit becomes in upper and lower case, filled in as met; 0 until then. */
const UPPER_WIDTHS = new Uint8Array(0x10000);
const LOWER_WIDTHS = new Uint8Array(0x10000);

/**
 * The length, in UTF-16 code units, of `text` in upper or lower case, found without mapping it whole. The
 * locale-independent mapping changes a character's length the same wherever it stands, so mapping one code point at a
 * time gives the same length.
 */
export function caseMappedLength(text: string, upper: boolean): number {
  const widths = upper ? UPPER_WIDTHS : LOWER_WIDTHS;
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const next = text.charCodeAt(index + 1);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      const pair = text.slice(index, index + 2);
      length += (upper ? pair.toUpperCase() : pair.toLowerCase()).length;
      index += 1;
      continue;
    }
    if (widths[code] === 0) {
      const character = String.fromCharCode(code);
      widths[code] = (upper ? character.toUpperCase() : character.toLowerCase()).length;
    }
    length += widths[code]!;
  }
  return length;
}

/** A whole number with thousands separators, such as 9,007,199,254,740,991. */
function groupedDigits(value: number): string {
  return BigInt(Math.round(value))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}
