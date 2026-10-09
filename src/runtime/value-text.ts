import { durationParts, formatDuration } from "../duration.js";
import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import {
  formatIsoDate,
  formatIsoTime,
  formatIsoTimestamp,
  localFields,
  presentDate,
  presentDateTime,
  presentTime,
  type TemporalContext,
} from "../temporal.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
import { checkTextLength, MAX_TEXT_LENGTH, textTooLong } from "./text-length.js";
import type {
  SerializableRuntimeDictEntry,
  SerializableRuntimeProperty,
  SerializableMediaHandle,
  SerializablePermanentButtonHandle,
  SerializableCameraViewHandle,
  SerializableRuntimeTemporal,
  SerializableRuntimeValue,
  SerializableScriptReference,
  SerializableTimerHandle,
} from "./serializable-values.js";
import {
  describeRuntimeValue,
  isDict,
  isDuration,
  isList,
  isMediaHandle,
  isMessageHandle,
  isPermanentButton,
  isCameraView,
  isObject,
  isRange,
  isScriptReference,
  isSet,
  isSpeakerReference,
  isTemporal,
  isTimerHandle,
} from "./value-predicates.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/**
 * Scalar visible text: strings, finite numbers, booleans, `null`, durations, date and time values, and script
 * references. Dates and times use the player's numeric presentation from `context`, and an absolute date and time shows
 * as the local date and time it is.
 */
export function visibleText(
  value: SerializableRuntimeValue,
  span: SourceSpan,
  context: TemporalContext,
): string {
  return isTemporal(value) ? temporalText(value, span, context) : plainScalarText(value, span);
}

function temporalText(
  value: SerializableRuntimeTemporal,
  span: SourceSpan,
  context: TemporalContext,
): string {
  switch (value.kind) {
    case "date":
      return presentDate(context.presentation, value);
    case "time":
      return presentTime(context.presentation, value);
    case "datetime":
      return presentDateTime(context.presentation, value);
    case "absoluteDateTime": {
      const local = localFields(context.zone, value.epochMilliseconds);
      if (!local.ok)
        throw fault(
          "TSR063",
          `This absolute date and time cannot be shown as local time: ${local.reason}. Show it with toISO() instead.`,
          span,
        );
      return presentDateTime(context.presentation, local.value);
    }
  }
}

/** The fixed notation of a date or time value inside a collection, such as `<date 2026-10-04>`. */
function temporalNotation(value: SerializableRuntimeTemporal): string {
  switch (value.kind) {
    case "date":
      return `<date ${formatIsoDate(value)}>`;
    case "time":
      return `<time ${formatIsoTime(value)}>`;
    case "datetime":
      return `<datetime ${formatIsoDate(value)} ${formatIsoTime(value)}>`;
    case "absoluteDateTime":
      return `<absoluteDateTime ${formatIsoTimestamp(value.epochMilliseconds)}>`;
  }
}

function plainScalarText(value: SerializableRuntimeValue, span: SourceSpan): string {
  if (typeof value === "string") return value;
  if (isFiniteNumber(value)) return String(Object.is(value, -0) ? 0 : value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  if (isDuration(value)) return formatDuration(durationParts(value));
  if (isScriptReference(value)) return scriptNotation(value, span);
  throw fault(
    "TSR021",
    `${describeRuntimeValue(value).replace(/^a/u, "A")} cannot be shown as text here.${isObject(value) ? " Show one of its properties instead." : isSet(value) ? " Show its elements with toList().join() instead." : ""}`,
    span,
  );
}

/**
 * A script reference as the call that makes it: `script("rooms/hall.tease", label: "start")`. A `limit` cuts its texts
 * before they are quoted. Notation longer than any text can be fails with `TSR084` for `script(…)`.
 */
function scriptNotation(
  value: SerializableScriptReference,
  span: SourceSpan,
  limit = Infinity,
): string {
  const path = prefix(value.path, limit);
  const label = value.label === null ? null : prefix(value.label, limit);
  // `script(`, `)`, and `, label: ` around the quoted texts.
  const around = 8 + (label === null ? 0 : 9);
  // Quoting adds two quotes and at most one escape for each character, so only texts that could get too long are measured.
  if ((path.length + (label?.length ?? 0)) * 2 + 4 + around > MAX_TEXT_LENGTH)
    checkTextLength(
      quotedLength(path) + (label === null ? 0 : quotedLength(label)) + around,
      "script(…)",
      span,
    );
  return `script(${quotedText(path)}${label === null ? "" : `, label: ${quotedText(label)}`})`;
}

/** At most the first `limit` characters of `text`. */
function prefix(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

/** Whether `visibleText` accepts the value. */
export function isVisibleScalar(value: SerializableRuntimeValue): boolean {
  return (
    typeof value === "string" ||
    isFiniteNumber(value) ||
    typeof value === "boolean" ||
    value === null ||
    isDuration(value) ||
    isTemporal(value) ||
    isScriptReference(value)
  );
}

/** Text of a field such as a button label or an input hint. Only `${...}` selects from a list. */
export function fieldText(
  value: SerializableRuntimeValue,
  span: SourceSpan,
  context: TemporalContext,
): string {
  if (isList(value))
    throw fault(
      "TSR021",
      'A list cannot be used as this text. Select one element with "${list}" or list.random.',
      span,
    );
  return visibleText(value, span, context);
}

/**
 * Code-like notation of any value, as `say` shows a value that is not a scalar: `["pet", 2.5, { name: "Bo" }]`,
 * `dict{ "collar": "leather" }`, `1..=5`, or `<speaker mistress>`. Nested text and dict keys are quoted with the
 * string-literal escapes, other scalars use `visibleText`, and `handleNotation` describes a handle from its current
 * state. Notation longer than any text can be fails with `TSR084` for `operation` as soon as it is.
 */
export function valueNotation(
  value: SerializableRuntimeValue,
  span: SourceSpan,
  handleNotation: (
    handle:
      | SerializableTimerHandle
      | SerializableMediaHandle
      | SerializablePermanentButtonHandle
      | SerializableCameraViewHandle,
  ) => string,
  operation: string,
): string {
  return writeNotation(value, span, handleNotation, Infinity, operation).text;
}

/**
 * At most `limit` characters of `valueNotation`, written only as far as the limit, so that a large value is never
 * materialized whole. `truncated` tells whether notation was cut off.
 */
export function valueNotationPrefix(
  value: SerializableRuntimeValue,
  span: SourceSpan,
  handleNotation: Parameters<typeof valueNotation>[2],
  limit: number,
): { readonly text: string; readonly truncated: boolean } {
  return writeNotation(value, span, handleNotation, limit, null);
}

/** Work of `writeNotation`: text, a value, or the next of a collection's members, written one at a time. */
type NotationWork =
  | { readonly text: string }
  | { readonly value: SerializableRuntimeValue }
  | { readonly items: readonly SerializableRuntimeValue[]; index: number }
  | { readonly properties: readonly SerializableRuntimeProperty[]; index: number }
  | { readonly entries: readonly SerializableRuntimeDictEntry[]; index: number };

function writeNotation(
  value: SerializableRuntimeValue,
  span: SourceSpan,
  handleNotation: Parameters<typeof valueNotation>[2],
  limit: number,
  /** Without a limit, the operation that fails when the notation gets longer than any text can be. */
  operation: string | null,
): { readonly text: string; readonly truncated: boolean } {
  const output: string[] = [];
  let length = 0;
  // The whole notation is not known before it is written, so only that it is too long is.
  const tooLong = (added: number) => {
    if (operation !== null && length + added > MAX_TEXT_LENGTH)
      throw textTooLong(operation, span, null);
  };
  // A text cut to the limit and quoted. Quoting adds two quotes and at most one escape for each character, so only a
  // text that could be too long is measured first.
  const quoted = (text: string) => {
    if (operation !== null && text.length * 2 + 2 > MAX_TEXT_LENGTH - length)
      tooLong(quotedLength(text));
    return quotedText(prefix(text, limit));
  };
  // Members are taken one at a time, so a limit stops a large collection after the members it writes.
  const work: NotationWork[] = [{ value }];
  while (work.length > 0) {
    if (length >= limit) {
      const text = output.join("");
      return { text: text.slice(0, limit), truncated: true };
    }
    const next = work.pop()!;
    if ("text" in next) {
      tooLong(next.text.length);
      output.push(next.text);
      length += next.text.length;
      continue;
    }
    if ("items" in next) {
      if (next.index === next.items.length) continue;
      const item = next.items[next.index]!;
      next.index += 1;
      work.push(next, { value: item });
      if (next.index > 1) work.push({ text: ", " });
      continue;
    }
    if ("properties" in next) {
      if (next.index === next.properties.length) continue;
      const property = next.properties[next.index]!;
      next.index += 1;
      // Whether to quote depends on the whole name; it is cut to the limit before it is written.
      const name = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(property.name)
        ? prefix(property.name, limit)
        : quoted(property.name);
      work.push(
        next,
        { value: property.value },
        { text: `${next.index > 1 ? ", " : ""}${name}: ` },
      );
      continue;
    }
    if ("entries" in next) {
      if (next.index === next.entries.length) continue;
      const entry = next.entries[next.index]!;
      next.index += 1;
      work.push(
        next,
        { value: entry.value },
        { text: `${next.index > 1 ? ", " : ""}${quoted(entry.key)}: ` },
      );
      continue;
    }
    const current = next.value;
    const before = output.length;
    if (typeof current === "string")
      // A long text is cut before it is quoted; the closing quote then marks no end.
      output.push(quoted(current));
    else if (isList(current) || isSet(current))
      work.push({ text: "]" }, { items: current.items, index: 0 }, { text: "[" });
    else if (isObject(current)) {
      if (current.properties.length === 0) output.push("{}");
      else work.push({ text: " }" }, { properties: current.properties, index: 0 }, { text: "{ " });
    } else if (isDict(current)) {
      if (current.entries.length === 0) output.push("dict{}");
      else work.push({ text: " }" }, { entries: current.entries, index: 0 }, { text: "dict{ " });
    } else if (isRange(current))
      output.push(
        `${plainScalarText(current.start, span)}${current.inclusive ? "..=" : ".."}${plainScalarText(current.end, span)}`,
      );
    else if (isSpeakerReference(current))
      output.push(`<speaker ${prefix(current.identifier, limit)}>`);
    // A message handle shows its identity, not its text, so a message never shows another one within it.
    else if (isMessageHandle(current)) output.push(`<message ${current.messageId}>`);
    else if (
      isTimerHandle(current) ||
      isMediaHandle(current) ||
      isPermanentButton(current) ||
      isCameraView(current)
    )
      output.push(handleNotation(current));
    else if (isTemporal(current)) output.push(temporalNotation(current));
    else if (isScriptReference(current)) output.push(scriptNotation(current, span, limit));
    else output.push(plainScalarText(current, span));
    for (let index = before; index < output.length; index += 1) {
      tooLong(output[index]!.length);
      length += output[index]!.length;
    }
  }
  const text = output.join("");
  return length > limit
    ? { text: text.slice(0, limit), truncated: true }
    : { text, truncated: false };
}

/**
 * `text` quoted with `before` and `after` around it, or `TSR084` for `operation` when that would be longer than any text
 * can be.
 */
export function quotedTextWithin(
  before: string,
  text: string,
  after: string,
  operation: string,
  span: SourceSpan,
): string {
  // Quoting adds two quotes and at most one escape for each character, so only a text that could get too long is
  // measured.
  const around = before.length + after.length;
  if (text.length * 2 + 2 + around > MAX_TEXT_LENGTH)
    checkTextLength(quotedLength(text) + around, operation, span);
  return `${before}${quotedText(text)}${after}`;
}

/** The length of `quotedText(text)`, found without writing it: each character it escapes adds one. */
function quotedLength(text: string): number {
  let length = text.length + 2;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // Backslash, quote, line feed, carriage return, tab, and a `$` before `{`.
    if (
      code === 0x5c ||
      code === 0x22 ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0x09 ||
      (code === 0x24 && text.charCodeAt(index + 1) === 0x7b)
    )
      length += 1;
  }
  return length;
}

/** A double-quoted string literal with the TeaseScript escapes, including `\${`. */
export function quotedText(text: string): string {
  const escaped = text.replace(/[\\"\n\r\t]|\$(?=\{)/gu, (character) =>
    character === "\n"
      ? "\\n"
      : character === "\r"
        ? "\\r"
        : character === "\t"
          ? "\\t"
          : `\\${character}`,
  );
  return `"${escaped}"`;
}

function isFiniteNumber(value: SerializableRuntimeValue): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
