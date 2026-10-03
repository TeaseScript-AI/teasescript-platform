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
  let count = 0;
  for (const _codePoint of text) count += 1;
  return count;
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
      return text.includes(textArgument(0));
    case "startsWith":
      expect(1);
      return text.startsWith(textArgument(0));
    case "endsWith":
      expect(1);
      return text.endsWith(textArgument(0));
    case "indexOf": {
      expect(1);
      const offset = text.indexOf(textArgument(0));
      return offset < 0 ? -1 : stringLength(text.slice(0, offset));
    }
    case "substring": {
      expect(1, 2);
      const length = stringLength(text);
      const start = position(positional[0]!, length, span);
      const end = positional.length === 2 ? position(positional[1]!, length, span) : length;
      if (end < start)
        throw fault("TSR025", `Text position ${end} is before the start position ${start}.`, span);
      return Array.from(text).slice(start, end).join("");
    }
    case "split": {
      expect(1);
      const separator = textArgument(0);
      return createCapturedSerializableList(
        separator === "" ? Array.from(text) : text.split(separator),
      );
    }
    case "replace": {
      expect(2);
      const search = textArgument(0);
      const replacement = textArgument(1);
      if (search === "")
        throw fault("TSR057", "replace() needs non-empty text to search for.", span);
      return text.split(search).join(replacement);
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
