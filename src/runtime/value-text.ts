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
import type {
  SerializableMediaHandle,
  SerializableRuntimeTemporal,
  SerializableRuntimeValue,
  SerializableTimerHandle,
} from "./serializable-values.js";
import {
  isDict,
  isDuration,
  isList,
  isMediaHandle,
  isObject,
  isRange,
  isSet,
  isSpeakerReference,
  isTemporal,
  isTimerHandle,
} from "./value-predicates.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/**
 * Scalar visible text: strings, finite numbers, booleans, `null`, durations, and date and time values. Dates and times
 * use the player's numeric presentation from `context`, and a timestamp shows as the local date and time it is.
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
    case "timestamp": {
      const local = localFields(context.zone, value.epochMilliseconds);
      if (!local.ok)
        throw fault(
          "TSR063",
          `This timestamp cannot be shown as local time: ${local.reason}. Show it with toISO() instead.`,
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
    case "timestamp":
      return `<timestamp ${formatIsoTimestamp(value.epochMilliseconds)}>`;
  }
}

function plainScalarText(value: SerializableRuntimeValue, span: SourceSpan): string {
  if (typeof value === "string") return value;
  if (isFiniteNumber(value)) return String(Object.is(value, -0) ? 0 : value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  if (isDuration(value)) return formatDuration(durationParts(value));
  throw fault("TSR021", "This value cannot be converted implicitly to visible text.", span);
}

/** Whether `visibleText` accepts the value. */
export function isVisibleScalar(value: SerializableRuntimeValue): boolean {
  return (
    typeof value === "string" ||
    isFiniteNumber(value) ||
    typeof value === "boolean" ||
    value === null ||
    isDuration(value) ||
    isTemporal(value)
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
 * string-literal escapes, other scalars use `visibleText`, and `handleNotation` describes a timer or media handle from
 * its current state.
 */
export function valueNotation(
  value: SerializableRuntimeValue,
  span: SourceSpan,
  handleNotation: (handle: SerializableTimerHandle | SerializableMediaHandle) => string,
): string {
  const output: string[] = [];
  const work: Array<{ readonly text: string } | { readonly value: SerializableRuntimeValue }> = [
    { value },
  ];
  while (work.length > 0) {
    const next = work.pop()!;
    if ("text" in next) {
      output.push(next.text);
      continue;
    }
    const current = next.value;
    if (typeof current === "string") output.push(quotedText(current));
    else if (isList(current) || isSet(current)) {
      work.push({ text: "]" });
      for (let index = current.items.length - 1; index >= 0; index -= 1) {
        work.push({ value: current.items[index]! });
        if (index > 0) work.push({ text: ", " });
      }
      work.push({ text: "[" });
    } else if (isObject(current)) {
      if (current.properties.length === 0) {
        output.push("{}");
        continue;
      }
      work.push({ text: " }" });
      for (let index = current.properties.length - 1; index >= 0; index -= 1) {
        const property = current.properties[index]!;
        work.push({ value: property.value });
        const name = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(property.name)
          ? property.name
          : quotedText(property.name);
        work.push({ text: `${index > 0 ? ", " : ""}${name}: ` });
      }
      work.push({ text: "{ " });
    } else if (isDict(current)) {
      if (current.entries.length === 0) {
        output.push("dict{}");
        continue;
      }
      work.push({ text: " }" });
      for (let index = current.entries.length - 1; index >= 0; index -= 1) {
        const entry = current.entries[index]!;
        work.push({ value: entry.value });
        work.push({ text: `${index > 0 ? ", " : ""}${quotedText(entry.key)}: ` });
      }
      work.push({ text: "dict{ " });
    } else if (isRange(current))
      output.push(
        `${plainScalarText(current.start, span)}${current.inclusive ? "..=" : ".."}${plainScalarText(current.end, span)}`,
      );
    else if (isSpeakerReference(current)) output.push(`<speaker ${current.identifier}>`);
    else if (isTimerHandle(current) || isMediaHandle(current)) output.push(handleNotation(current));
    else if (isTemporal(current)) output.push(temporalNotation(current));
    else output.push(plainScalarText(current, span));
  }
  return output.join("");
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
