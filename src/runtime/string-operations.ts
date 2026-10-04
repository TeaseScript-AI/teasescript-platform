import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import {
  argumentCountMessage,
  argumentTypeMessage,
  beyondLengthMessage,
  emptyTextMessage,
  endBeforeStartMessage,
  negativeMessage,
  TEXT_MEMBERS,
  unknownTextMemberMessage,
  type ArgumentKind,
  type TextMember,
} from "../text-operations.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
import { describeRuntimeValue, isDuration } from "./value-predicates.js";
import {
  createCapturedSerializableList,
  type SerializableRuntimeValue,
} from "./serializable-values.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/**
 * Built-in text operations. Strings are immutable, so every operation returns a new value. Lengths and positions count
 * Unicode code points, and case mapping is the locale-independent Unicode mapping.
 */
export const STRING_METHODS: ReadonlySet<string> = new Set(
  [...TEXT_MEMBERS.values()]
    .filter((member) => member.parameters !== null)
    .map((member) => member.name),
);

/**
 * The failure message for a member of a value that has no members, naming the fix when a text operation was meant: a
 * conversion for a scalar, or a null check.
 */
export function missingMemberMessage(
  value: SerializableRuntimeValue,
  name: string,
  use: "method" | "property",
): string {
  const kind = describeRuntimeValue(value);
  const description =
    value === null ? "The value null" : kind.charAt(0).toUpperCase() + kind.slice(1);
  const textOperation = TEXT_MEMBERS.has(name);
  const fix = !textOperation
    ? ""
    : value === null
      ? " Check that it is not null first."
      : typeof value === "number" || typeof value === "boolean" || isDuration(value)
        ? " Text operations need text; convert the value first with toString(...)."
        : "";
  return `${description} has no ${use} '${name}'.${fix}`;
}

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
  return !(isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset)));
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * The UTF-16 offsets, in order, of the literal matches of a non-empty `search` that start and end on code points. With
 * `overlapping`, every match; otherwise each match starts at or after the end of the previous one, as `split` and
 * `replace` consume them. One Knuth-Morris-Pratt pass over the text keeps the work linear even when many candidate
 * matches fall inside a surrogate pair and must be skipped.
 */
function* literalMatches(text: string, search: string, overlapping: boolean): Generator<number> {
  const fallback = new Int32Array(search.length);
  for (let index = 1, matched = 0; index < search.length; index += 1) {
    while (matched > 0 && search.charCodeAt(index) !== search.charCodeAt(matched))
      matched = fallback[matched - 1]!;
    if (search.charCodeAt(index) === search.charCodeAt(matched)) matched += 1;
    fallback[index] = matched;
  }
  for (let index = 0, matched = 0; index < text.length; index += 1) {
    while (matched > 0 && text.charCodeAt(index) !== search.charCodeAt(matched))
      matched = fallback[matched - 1]!;
    if (text.charCodeAt(index) === search.charCodeAt(matched)) matched += 1;
    if (matched < search.length) continue;
    const start = index + 1 - search.length;
    if (isCodePointBoundary(text, start) && isCodePointBoundary(text, index + 1)) {
      yield start;
      matched = overlapping ? fallback[matched - 1]! : 0;
    } else {
      matched = fallback[matched - 1]!;
    }
  }
}

/** The UTF-16 offset of the first literal match, or -1; an empty `search` matches at the start. */
function firstMatch(text: string, search: string): number {
  if (search === "") return 0;
  for (const offset of literalMatches(text, search, false)) return offset;
  return -1;
}

export function callStringMethod(
  text: string,
  name: string,
  positional: readonly SerializableRuntimeValue[],
  span: SourceSpan,
): SerializableRuntimeValue {
  const member = TEXT_MEMBERS.get(name);
  if (member?.parameters == null)
    throw fault("TSR016", unknownTextMemberMessage(name, "method"), span);
  checkTextArguments(member, positional, span);
  // EVIDENCE: invariant: checkTextArguments proved that every text parameter received text.
  const texts = positional as readonly string[];
  // EVIDENCE: invariant: checkTextArguments proved that every position and count is a whole number of 0 or more.
  const numbers = positional as readonly number[];
  switch (name) {
    case "contains":
      return firstMatch(text, texts[0]!) >= 0;
    case "startsWith":
      return text.startsWith(texts[0]!) && isCodePointBoundary(text, texts[0]!.length);
    case "endsWith":
      return text.endsWith(texts[0]!) && isCodePointBoundary(text, text.length - texts[0]!.length);
    case "indexOf": {
      const offset = firstMatch(text, texts[0]!);
      return offset < 0 ? -1 : codePointCount(text, offset);
    }
    case "lastIndexOf": {
      if (texts[0] === "") return stringLength(text);
      let offset = -1;
      for (const match of literalMatches(text, texts[0]!, true)) offset = match;
      return offset < 0 ? -1 : codePointCount(text, offset);
    }
    case "substring": {
      const length = stringLength(text);
      const [start = 0, end = length] = numbers;
      for (const [index, value] of [start, end].entries()) {
        if (value > length)
          throw fault(
            "TSR025",
            beyondLengthMessage(member, member.parameters[index]!, value, length),
            span,
          );
      }
      if (end < start) throw fault("TSR025", endBeforeStartMessage(member, start, end), span);
      const startOffset = utf16Offset(text, start);
      return text.slice(startOffset, utf16Offset(text, end, startOffset, start));
    }
    case "split": {
      if (texts[0] === "") return createCapturedSerializableList(Array.from(text));
      const parts: string[] = [];
      let last = 0;
      for (const match of literalMatches(text, texts[0]!, false)) {
        parts.push(text.slice(last, match));
        last = match + texts[0]!.length;
      }
      parts.push(text.slice(last));
      return createCapturedSerializableList(parts);
    }
    case "replace": {
      let result = "";
      let last = 0;
      for (const match of literalMatches(text, texts[0]!, false)) {
        result += text.slice(last, match) + texts[1]!;
        last = match + texts[0]!.length;
      }
      return result + text.slice(last);
    }
    case "trim":
      return text.trim();
    case "trimStart":
      return text.trimStart();
    case "trimEnd":
      return text.trimEnd();
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    case "uppercaseFirst": {
      const codePoint = text.codePointAt(0);
      if (codePoint === undefined) return text;
      const firstText = String.fromCodePoint(codePoint);
      return firstText.toUpperCase() + text.slice(firstText.length);
    }
    case "repeat":
      return text.repeat(numbers[0]!);
    case "padStart":
    case "padEnd": {
      const target = numbers[0]!;
      const fill = texts[1]!;
      const fillLength = stringLength(fill);
      let result = text;
      let length = stringLength(text);
      let first = text.charCodeAt(0);
      let last = text.charCodeAt(text.length - 1);
      // A lone high surrogate before a lone low one joins into one code point, so a fill or text with lone surrogates
      // at its edges can need another, shorter round; well-formed text is padded in one round. Only the new padding is
      // counted, so the work stays linear in the result.
      while (length < target) {
        const missing = target - length;
        const padding =
          fill.repeat(Math.floor(missing / fillLength)) +
          fill.slice(0, utf16Offset(fill, missing % fillLength));
        const before = name === "padStart" ? padding.charCodeAt(padding.length - 1) : last;
        const after = name === "padStart" ? first : padding.charCodeAt(0);
        length +=
          stringLength(padding) - (isHighSurrogate(before) && isLowSurrogate(after) ? 1 : 0);
        if (name === "padStart") {
          result = padding + result;
          first = padding.charCodeAt(0);
        } else {
          result += padding;
          last = padding.charCodeAt(padding.length - 1);
        }
      }
      return result;
    }
    default:
      throw new Error(`Text operation '${name}' has no implementation.`);
  }
}

/**
 * Checks the arguments of a text operation or `join` against its parameters: their number, text where text is required,
 * non-empty text, and whole numbers of 0 or more for positions and counts. A position's upper bound depends on the text
 * and is checked by `substring`.
 */
export function checkTextArguments(
  member: TextMember,
  positional: readonly SerializableRuntimeValue[],
  span: SourceSpan,
): void {
  const parameters = member.parameters!;
  const required = parameters.filter((parameter) => parameter.optional !== true).length;
  if (positional.length < required || positional.length > parameters.length)
    throw fault("TSR028", argumentCountMessage(member, positional.length), span);
  for (const [index, value] of positional.entries()) {
    const parameter = parameters[index]!;
    const position = parameter.kind === "position";
    if (parameter.kind === "text" || parameter.kind === "nonEmptyText") {
      if (typeof value !== "string")
        throw fault(
          "TSR057",
          argumentTypeMessage(member, parameter, describeRuntimeValue(value), argumentKind(value)),
          span,
        );
      if (parameter.kind === "nonEmptyText" && value === "")
        throw fault("TSR057", emptyTextMessage(member, parameter), span);
    } else if (typeof value !== "number" || !Number.isInteger(value)) {
      throw fault(
        position ? "TSR024" : "TSR057",
        argumentTypeMessage(member, parameter, describeRuntimeValue(value), argumentKind(value)),
        span,
      );
    } else if (value < 0) {
      throw fault(position ? "TSR025" : "TSR057", negativeMessage(member, parameter, value), span);
    }
  }
}

function argumentKind(value: SerializableRuntimeValue): ArgumentKind {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return isDuration(value) ? "duration" : null;
}

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
