import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
import {
  createCapturedSerializableList,
  type SerializableRuntimeValue,
} from "./serializable-values.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/**
 * Built-in text operations. Strings are immutable, so every operation returns a new value. Lengths and positions count
 * Unicode code points, and case mapping is the locale-independent Unicode mapping.
 */
export const STRING_METHODS: ReadonlySet<string> = new Set([
  "contains",
  "startsWith",
  "endsWith",
  "indexOf",
  "substring",
  "split",
  "replace",
  "trim",
  "trimStart",
  "trimEnd",
  "uppercase",
  "lowercase",
  "capitalize",
]);

export function stringLength(text: string): number {
  return codePointCount(text, text.length);
}

/** The number of code points before UTF-16 `offset`, which must be a code-point boundary. */
function codePointCount(text: string, offset: number): number {
  let count = 0;
  for (let index = 0; index < offset; index += utf16Width(text, index)) count += 1;
  return count;
}

/** The UTF-16 offset of code point `index`, counting on from a known `offset` that is code point `from`. */
function utf16Offset(text: string, index: number, offset = 0, from = 0): number {
  for (let count = from; count < index; count += 1) offset += utf16Width(text, offset);
  return offset;
}

/** 2 for a surrogate pair at `offset`, otherwise 1; a lone surrogate is one code point, as in `for...of`. */
function utf16Width(text: string, offset: number): number {
  return text.codePointAt(offset)! > 0xffff ? 2 : 1;
}

/** Whether `offset` does not fall between the two halves of a surrogate pair. */
function isCodePointBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

/** The UTF-16 offset of the first literal match at or after `from` that starts and ends on code points, or -1. */
function findMatch(text: string, search: string, from: number): number {
  for (
    let offset = text.indexOf(search, from);
    offset >= 0;
    offset = text.indexOf(search, offset + 1)
  ) {
    if (isCodePointBoundary(text, offset) && isCodePointBoundary(text, offset + search.length))
      return offset;
  }
  return -1;
}

export function callStringMethod(
  text: string,
  name: string,
  positional: readonly SerializableRuntimeValue[],
  span: SourceSpan,
): SerializableRuntimeValue {
  const expect = (minimum: number, maximum = minimum): void => {
    if (positional.length < minimum || positional.length > maximum)
      throw fault(
        "TSR028",
        minimum === maximum
          ? `Expected ${minimum} positional argument(s), received ${positional.length}.`
          : `Expected ${minimum} to ${maximum} positional arguments, received ${positional.length}.`,
        span,
      );
  };
  const textArgument = (index: number): string => {
    const value = positional[index];
    if (typeof value !== "string")
      throw fault("TSR057", `${name}() expects text as argument ${index + 1}.`, span);
    return value;
  };
  switch (name) {
    case "contains":
      expect(1);
      return findMatch(text, textArgument(0), 0) >= 0;
    case "startsWith": {
      expect(1);
      const part = textArgument(0);
      return text.startsWith(part) && isCodePointBoundary(text, part.length);
    }
    case "endsWith": {
      expect(1);
      const part = textArgument(0);
      return text.endsWith(part) && isCodePointBoundary(text, text.length - part.length);
    }
    case "indexOf": {
      expect(1);
      const offset = findMatch(text, textArgument(0), 0);
      return offset < 0 ? -1 : codePointCount(text, offset);
    }
    case "substring": {
      expect(1, 2);
      const length = stringLength(text);
      const start = position(positional[0]!, length, span);
      const end = positional.length === 2 ? position(positional[1]!, length, span) : length;
      if (end < start)
        throw fault("TSR025", `Text position ${end} is before the start position ${start}.`, span);
      const startOffset = utf16Offset(text, start);
      return text.slice(startOffset, utf16Offset(text, end, startOffset, start));
    }
    case "split": {
      expect(1);
      const separator = textArgument(0);
      if (separator === "") return createCapturedSerializableList(Array.from(text));
      const parts: string[] = [];
      let last = 0;
      for (
        let match = findMatch(text, separator, 0);
        match >= 0;
        match = findMatch(text, separator, last)
      ) {
        parts.push(text.slice(last, match));
        last = match + separator.length;
      }
      parts.push(text.slice(last));
      return createCapturedSerializableList(parts);
    }
    case "replace": {
      expect(2);
      const search = textArgument(0);
      const replacement = textArgument(1);
      if (search === "")
        throw fault("TSR057", "replace() needs non-empty text to search for.", span);
      let result = "";
      let last = 0;
      for (
        let match = findMatch(text, search, 0);
        match >= 0;
        match = findMatch(text, search, last)
      ) {
        result += text.slice(last, match) + replacement;
        last = match + search.length;
      }
      return result + text.slice(last);
    }
    case "trim":
      expect(0);
      return text.trim();
    case "trimStart":
      expect(0);
      return text.trimStart();
    case "trimEnd":
      expect(0);
      return text.trimEnd();
    case "uppercase":
      expect(0);
      return text.toUpperCase();
    case "lowercase":
      expect(0);
      return text.toLowerCase();
    case "capitalize": {
      expect(0);
      const first = text.codePointAt(0);
      if (first === undefined) return text;
      const firstText = String.fromCodePoint(first);
      return firstText.toUpperCase() + text.slice(firstText.length);
    }
    default:
      throw fault("TSR016", `Text has no method '${name}'.`, span);
  }
}

/** A code-point position from 0 through the text length, as for list indexes but including the end. */
function position(value: SerializableRuntimeValue, length: number, span: SourceSpan): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw fault("TSR024", "A text position must be an integer.", span);
  if (value < 0 || value > length)
    throw fault(
      "TSR025",
      `Text position ${value} is outside the text, which has length ${length}.`,
      span,
    );
  return Object.is(value, -0) ? 0 : value;
}

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
