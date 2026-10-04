import { formatDuration } from "../duration.js";
import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
import type {
  SerializableMediaHandle,
  SerializableRuntimeValue,
  SerializableTimerHandle,
} from "./serializable-values.js";
import {
  isDuration,
  isList,
  isMediaHandle,
  isObject,
  isRange,
  isSet,
  isSpeakerReference,
  isTimerHandle,
} from "./value-predicates.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/** Scalar visible text: strings, finite numbers, booleans, `null`, and elapsed durations. */
export function visibleText(value: SerializableRuntimeValue, span: SourceSpan): string {
  if (typeof value === "string") return value;
  if (isFiniteNumber(value)) return String(Object.is(value, -0) ? 0 : value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  if (isDuration(value)) return formatDuration(value.milliseconds);
  throw fault("TSR021", "This value cannot be converted implicitly to visible text.", span);
}

/** Whether `visibleText` accepts the value. */
export function isVisibleScalar(value: SerializableRuntimeValue): boolean {
  return (
    typeof value === "string" ||
    isFiniteNumber(value) ||
    typeof value === "boolean" ||
    value === null ||
    isDuration(value)
  );
}

/** Text of a field such as a button label or an input hint. Only `${...}` selects from a list. */
export function fieldText(value: SerializableRuntimeValue, span: SourceSpan): string {
  if (isList(value))
    throw fault(
      "TSR021",
      'A list cannot be used as this text. Select one element with "${list}" or list.random.',
      span,
    );
  return visibleText(value, span);
}

/**
 * Code-like notation of any value, as `say` shows a value that is not a scalar: `["pet", 2.5, { name: "Bo" }]`,
 * `1..=5`, or `<speaker mistress>`. Nested text is quoted with the string-literal escapes, other scalars use
 * `visibleText`, and `handleNotation` describes a timer or media handle from its current state.
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
    } else if (isRange(current))
      output.push(
        `${visibleText(current.start, span)}${current.inclusive ? "..=" : ".."}${visibleText(current.end, span)}`,
      );
    else if (isSpeakerReference(current)) output.push(`<speaker ${current.identifier}>`);
    else if (isTimerHandle(current) || isMediaHandle(current)) output.push(handleNotation(current));
    else output.push(visibleText(current, span));
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
