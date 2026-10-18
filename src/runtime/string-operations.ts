import type { RuntimeErrorCode } from "../diagnostic-codes.js";
import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import {
  argumentFix,
  argumentTypeMessage,
  isRegexMethod,
  isTextMember,
  isTextMethod,
  methodArgumentCountMessage,
  readsPosition,
  regexMemberMessage,
  stringLength,
  takesRegex,
  takesText,
  TEXT_METHODS,
  unknownTextMemberMessage,
  type ArgumentKind,
  type DomainValue,
  type RegexMethodName,
  type TextDomain,
  type TextParameter,
  type TextSignature,
} from "../text-operations.js";
import { checkCollectionLength, MAX_COLLECTION_LENGTH } from "./collection-size.js";
import { RuntimeFault } from "./errors.js";
import { caseMappedLength, checkTextLength, textLengthLimit, textTooLong } from "./text-length.js";
import { compileRegex, replacementParts, type ReplacementPart } from "../regex.js";
import { REGEX_WORK_EXCEEDED, RegexWork, type RegexProgram } from "../regex-engine.js";
import { isAngle, isAnyDuration, isDuration, isRegex } from "./value-predicates.js";
import type { SerializableRegex, SerializableRuntimeValue } from "./serializable-values.js";
import { describeValue } from "../value-kinds.js";
import { copySpan } from "../plan/source-location.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/**
 * The failure message for a member of a value that has no members, naming the fix when a text operation was meant: a
 * conversion for a scalar, or a null check.
 */
export function missingMemberMessage(
  value: SerializableRuntimeValue,
  name: string,
  use: "method" | "property",
): string {
  if (isRegex(value)) return regexMemberMessage(name, use);
  const kind = describeValue(value);
  const description =
    value === null ? "The value null" : kind.charAt(0).toUpperCase() + kind.slice(1);
  const textOperation = isTextMember(name);
  const fix = !textOperation
    ? ""
    : value === null
      ? " Check that it is not null first."
      : typeof value === "number" ||
          typeof value === "boolean" ||
          isAnyDuration(value) ||
          isAngle(value)
        ? " Convert it to text first with toString(...)."
        : "";
  return `${description} has no ${use} '${name}'.${fix}`;
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
 * `overlapping`, every match; otherwise each match starts at or after the end of the previous one, as `count`, `split`,
 * and `replace` consume them. One Knuth-Morris-Pratt pass over the text keeps the work linear even when many candidate
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

/** The number of UTF-16 code units `reverse` turns around at a time. */
const REVERSE_BLOCK = 4096;

/**
 * The text with its code points in reverse order. It is turned around in blocks from its end, each starting on a code
 * point so that a surrogate pair stays whole, which keeps a long text from becoming an array of all its characters.
 */
function reversedText(text: string): string {
  const parts: string[] = [];
  for (let end = text.length; end > 0;) {
    let start = Math.max(0, end - REVERSE_BLOCK);
    if (!isCodePointBoundary(text, start)) start -= 1;
    parts.push(Array.from(text.slice(start, end)).reverse().join(""));
    end = start;
  }
  return parts.join("");
}

/** The UTF-16 offset of the first literal match, or -1; an empty `search` matches at the start. */
function firstMatch(text: string, search: string): number {
  if (search === "") return 0;
  for (const offset of literalMatches(text, search, false)) return offset;
  return -1;
}

/** A call of a method of text (`TEXT_METHODS`): its arguments are checked, and then it runs. */
export function callStringMethod(
  text: string,
  name: string,
  positional: readonly SerializableRuntimeValue[],
  span: SourceSpan,
): SerializableRuntimeValue {
  if (!isTextMethod(name)) throw fault("TSR016", unknownTextMemberMessage(name, "method"), span);
  checkTextArguments(TEXT_METHODS[name], positional, span, text);
  const searched = positional[0];
  if (searched !== undefined && isRegex(searched) && isRegexMethod(name))
    return regexOperation(text, name, searched, positional[1], span);
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
    // A part that does not occur has no position: null (#840).
    case "indexOf": {
      const offset = firstMatch(text, texts[0]!);
      return offset < 0 ? null : codePointCount(text, offset);
    }
    case "lastIndexOf": {
      if (texts[0] === "") return stringLength(text);
      let offset = -1;
      for (const match of literalMatches(text, texts[0]!, true)) offset = match;
      return offset < 0 ? null : codePointCount(text, offset);
    }
    // Occurrences counted from the start, each after the end of the previous one, as `split` and `replace` find them.
    case "count": {
      let occurrences = 0;
      for (const _match of literalMatches(text, texts[0]!, false)) occurrences += 1;
      return occurrences;
    }
    // The domains proved that start and end are within the text, and end not before start.
    case "substring": {
      const start = numbers[0]!;
      const end = numbers[1];
      const startOffset = utf16Offset(text, start);
      return text.slice(
        startOffset,
        end === undefined ? text.length : utf16Offset(text, end, startOffset, start),
      );
    }
    // The parts are a new array of text that nothing else holds, so the list takes it without a copy. Only a text long
    // enough for more parts than a list can hold has them counted first.
    case "split": {
      if (texts[0] === "") {
        if (text.length > MAX_COLLECTION_LENGTH)
          checkCollectionLength("list", stringLength(text), 0, "split(...)", span);
        return { kind: "list", items: Array.from(text) };
      }
      if (Math.floor(text.length / texts[0]!.length) + 1 > MAX_COLLECTION_LENGTH) {
        let count = 1;
        for (const _match of literalMatches(text, texts[0]!, false)) count += 1;
        checkCollectionLength("list", count, 0, "split(...)", span);
      }
      const parts: string[] = [];
      let last = 0;
      for (const match of literalMatches(text, texts[0]!, false)) {
        parts.push(text.slice(last, match));
        last = match + texts[0]!.length;
      }
      parts.push(text.slice(last));
      return { kind: "list", items: parts };
    }
    case "replace": {
      // Only a longer replacement can make the text longer; then the matches are counted first, unless even a match at
      // every position keeps it short enough.
      const growth = texts[1]!.length - texts[0]!.length;
      if (
        growth > 0 &&
        text.length + Math.floor(text.length / texts[0]!.length) * growth > textLengthLimit()
      ) {
        let matches = 0;
        for (const _match of literalMatches(text, texts[0]!, false)) matches += 1;
        checkTextLength(text.length + matches * growth, "replace", span);
      }
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
    case "lowercase": {
      const upper = name === "uppercase";
      // Case mapping can make a text longer, "ß" becoming "SS": at most three times in upper case and twice in lower
      // case. Only a text that could get too long is measured first.
      if (text.length * (upper ? 3 : 2) > textLengthLimit())
        checkTextLength(caseMappedLength(text, upper), name, span);
      return upper ? text.toUpperCase() : text.toLowerCase();
    }
    case "uppercaseFirst": {
      const codePoint = text.codePointAt(0);
      if (codePoint === undefined) return text;
      const firstText = String.fromCodePoint(codePoint);
      const first = firstText.toUpperCase();
      checkTextLength(text.length - firstText.length + first.length, "uppercaseFirst", span);
      return first + text.slice(firstText.length);
    }
    case "reverse":
      return reversedText(text);
    case "repeat":
      checkTextLength(text.length * numbers[0]!, `repeat(${numbers[0]!})`, span);
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
      for (let round = 0; length < target; round += 1) {
        const missing = target - length;
        const rest = utf16Offset(fill, missing % fillLength);
        const units = result.length + Math.floor(missing / fillLength) * fill.length + rest;
        if (units > textLengthLimit()) {
          // This round is the last one, and its length the result's, unless a lone surrogate joins another between
          // repeated fills or at the text's edge.
          const end = fill.charCodeAt((rest > 0 ? rest : fill.length) - 1);
          const joins =
            (isHighSurrogate(fill.charCodeAt(fill.length - 1)) &&
              isLowSurrogate(fill.charCodeAt(0))) ||
            (name === "padStart"
              ? isHighSurrogate(end) && isLowSurrogate(first)
              : isHighSurrogate(last) && isLowSurrogate(fill.charCodeAt(0)));
          throw textTooLong(`${name}(${target})`, span, round === 0 && !joins ? units : null);
        }
        const padding = fill.repeat(Math.floor(missing / fillLength)) + fill.slice(0, rest);
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
    // A pattern is a regex, which `regexOperation` searches with.
    case "matches":
    case "find":
    case "capture":
    case "findAll":
      throw new Error(`Text operation '${name}' takes a regex.`);
    default: {
      const unhandled: never = name;
      throw new Error(`Text operation '${String(unhandled)}' has no implementation.`);
    }
  }
}

/**
 * A text operation with a regex (V30 §8), which may use at most the regex work limit: past it, the operation fails with
 * `TSR087` and returns nothing.
 */
function regexOperation(
  text: string,
  name: RegexMethodName,
  regex: SerializableRegex,
  replacement: SerializableRuntimeValue | undefined,
  span: SourceSpan,
): SerializableRuntimeValue {
  const program = regexProgram(regex, span);
  const work = new RegexWork();
  try {
    // A replacement is read once, before any search, so one that refers to a group the regex does not have fails even
    // without a match. This is the domain `replacementGroups` of `replace`, checked inside the regex work.
    let parts: readonly ReplacementPart[] = [];
    if (name === "replace") {
      // EVIDENCE: invariant: checkTextArguments proved that the replacement is text.
      const template = replacement as string;
      work.charge(template.length);
      const parsed = replacementParts(template, regex.source, program.groups);
      if (!parsed.ok) throw fault("TSR057", parsed.problem, span);
      parts = parsed.parts;
    }
    return regexResult(text, name, program, parts, work);
  } catch (error) {
    if (error !== REGEX_WORK_EXCEEDED) throw error;
    throw fault(
      "TSR087",
      "This regex needed too much work for this text. Use a simpler pattern or a shorter text.",
      span,
    );
  }
}

/**
 * The result of a text operation with a regex. `matches` tests the whole text; `contains`, `indexOf`, `find`, and
 * `capture` read the first leftmost match; `findAll`, `count`, `split`, `replace`, and `lastIndexOf` read every match,
 * as `regexMatches` finds them. RE2 reports UTF-16 offsets, and a position counts the code points up to it once. Each
 * match, and each piece of a result before it is added, charges `work`, so a result never outgrows the work limit.
 */
function regexResult(
  text: string,
  name: RegexMethodName,
  program: RegexProgram,
  replacement: readonly ReplacementPart[],
  work: RegexWork,
): SerializableRuntimeValue {
  const piece = (start: number, end: number): string => {
    work.charge(1 + end - start);
    return text.slice(start, end);
  };
  switch (name) {
    case "matches":
      return program.matchesWhole(text, work);
    case "contains":
      return program.matchesPart(text, work);
    case "indexOf": {
      const match = program.search(text, 0, false, work);
      return match === null ? null : codePointCount(text, match[0]!);
    }
    case "find": {
      const match = program.search(text, 0, false, work);
      return match === null ? null : text.slice(match[0], match[1]);
    }
    case "capture": {
      // The whole match, then each group in opening-parenthesis order; a group that did not take part is null.
      const match = program.search(text, 0, true, work);
      if (match === null) return null;
      const groups: (string | null)[] = [];
      for (let index = 0; index < match.length; index += 2)
        groups.push(match[index]! < 0 ? null : text.slice(match[index], match[index + 1]));
      return { kind: "list", items: groups };
    }
    case "findAll": {
      const found: string[] = [];
      for (const [start, end] of regexMatches(text, program, false, work))
        found.push(piece(start!, end!));
      return { kind: "list", items: found };
    }
    // The number of matches findAll finds, without building their text.
    case "count": {
      let matches = 0;
      for (const _match of regexMatches(text, program, false, work)) matches += 1;
      return matches;
    }
    case "lastIndexOf": {
      // The start of the last match as findAll finds them, so the matches do not overlap.
      let last = -1;
      for (const [start] of regexMatches(text, program, false, work)) last = start!;
      return last < 0 ? null : codePointCount(text, last);
    }
    case "split": {
      // Separators that match no text separate nothing at the text's ends or right after another separator, and
      // splitting empty text by a separator that matches gives no parts.
      const parts: string[] = [];
      let previous = 0;
      let matched = false;
      for (const [start, end] of regexMatches(text, program, false, work)) {
        matched = true;
        if (start === end && (start === previous || start === text.length)) continue;
        parts.push(piece(previous, start!));
        previous = end!;
      }
      if (text === "" && matched) return { kind: "list", items: [] };
      parts.push(piece(previous, text.length));
      return { kind: "list", items: parts };
    }
    case "replace": {
      const groups = replacement.some((part) => typeof part === "number" && part > 0);
      let result = "";
      let previous = 0;
      for (const match of regexMatches(text, program, groups, work)) {
        result += piece(previous, match[0]!);
        for (const part of replacement) {
          if (typeof part === "string") {
            work.charge(1 + part.length);
            result += part;
          } else if (match[2 * part]! >= 0) {
            result += piece(match[2 * part]!, match[2 * part + 1]!);
          }
        }
        previous = match[1]!;
      }
      return result + piece(previous, text.length);
    }
    default: {
      const unhandled: never = name;
      throw new Error(`Text operation '${String(unhandled)}' takes no regex.`);
    }
  }
}

/**
 * The matches of a regex in `text` for `findAll`, `count`, `split`, `replace`, and `lastIndexOf` (V30 §8): each one
 * the leftmost match from where the previous one ended, so they do not overlap. An empty match counts, also right after
 * another match; the next search starts one code point after it, and one at the end of the text is the last. Each
 * match charges `work` for handling it.
 */
function* regexMatches(
  text: string,
  program: RegexProgram,
  groups: boolean,
  work: RegexWork,
): Generator<number[]> {
  let from = 0;
  while (true) {
    const match = program.search(text, from, groups, work);
    if (match === null) return;
    work.charge(1);
    yield match;
    const [start, end] = match;
    if (end! > start!) from = end!;
    else if (end === text.length) return;
    else from = end! + utf16Width(text, end!);
  }
}

/**
 * `toRegex(text, default:)` (V30 §8): a regex of the pattern text, with its flags written inside it, such as `(?i)`.
 * Text that RE2 rejects or that is over the regex limits, and a value that is not text, give `undefined`, for the
 * default.
 */
export function regexFromText(text: SerializableRuntimeValue): SerializableRegex | undefined {
  if (typeof text !== "string" || !compileRegex(text, "").ok) return undefined;
  return { kind: "regex", source: text, flags: "" };
}

/** The compiled program of a regex value, which validation has already compiled once. */
function regexProgram(regex: SerializableRegex, span: SourceSpan): RegexProgram {
  const compiled = compileRegex(regex.source, regex.flags);
  if (!compiled.ok) throw fault("TSR057", `This regex cannot be used: ${compiled.problem}`, span);
  return compiled.program;
}

/**
 * Checks the arguments of a method of text, or `join`, against its parameters and domains (see `TextDomain`): their
 * number, then each argument's type and the domains that read only it, and then the other domains, except those the
 * regex work checks. `text` is the text the method is called on, which `join` has none of.
 */
export function checkTextArguments(
  member: TextSignature,
  positional: readonly SerializableRuntimeValue[],
  span: SourceSpan,
  text = "",
): void {
  const parameters = member.parameters;
  const required = parameters.filter((parameter) => parameter.optional !== true).length;
  if (positional.length < required || positional.length > parameters.length)
    throw fault("TSR028", methodArgumentCountMessage(member, positional.length), span);
  let length: number | undefined;
  const read = (input: number | "length"): DomainValue => {
    if (input === "length") return (length ??= stringLength(text));
    // EVIDENCE: invariant: the loop below checked the argument's type, text, a regex, or a whole number, first.
    return positional[input] as DomainValue;
  };
  const check = (domain: TextDomain): void => {
    if (domain.reads.some((read) => read !== "length" && read >= positional.length)) return;
    const problem = domain.problem(domain.reads.map(read), member);
    if (problem !== undefined)
      throw fault(readsPosition(member, domain) ? "TSR025" : "TSR057", problem, span);
  };
  const readsOnly = (domain: TextDomain): number | undefined =>
    domain.reads.length === 1 && domain.reads[0] !== "length" ? domain.reads[0] : undefined;
  for (const [index, value] of positional.entries()) {
    const parameter = parameters[index]!;
    if (!fits(parameter, value))
      throw fault(
        parameter.kind === "position" ? "TSR024" : "TSR057",
        argumentTypeMessage(member, parameter, describeValue(value)) +
          argumentFix(parameter, argumentKind(value)),
        span,
      );
    for (const domain of member.domains) if (readsOnly(domain) === index) check(domain);
  }
  for (const domain of member.domains)
    if (readsOnly(domain) === undefined && domain.inRegexWork !== true) check(domain);
}

/** Whether `value` has a type that `parameter` takes: text, a regex, or a whole number. */
function fits(parameter: TextParameter, value: SerializableRuntimeValue): boolean {
  if (takesRegex(parameter) && isRegex(value)) return true;
  if (takesText(parameter)) return typeof value === "string";
  return !takesRegex(parameter) && typeof value === "number" && Number.isInteger(value);
}

function argumentKind(value: SerializableRuntimeValue): ArgumentKind {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return isDuration(value) ? "duration" : null;
}

function fault(code: RuntimeErrorCode, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
