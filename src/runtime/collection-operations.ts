import { compareDurations, durationFamily, durationParts } from "../duration.js";
import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
import { valueKey, type SerializableRuntimeValue } from "./serializable-values.js";
import { compareTemporal } from "./temporal-operations.js";
import {
  describeRuntimeValue,
  isAnyDuration,
  isCalendarDuration,
  isDuration,
  isTemporal,
} from "./value-predicates.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/** The set operations of lists and sets (V30 §16, ADR 0013). */
export const SET_OPERATIONS: ReadonlySet<string> = new Set(["intersection", "union", "difference"]);

/**
 * The ascending, stable order of sortable list items as their old indexes: numbers (integers and numbers together),
 * text by Unicode code point, durations, or date and time values. Every item must be of one of these kinds, and all of
 * the same kind; dates, times, datetimes, and absolute dates and times are four kinds (V30 §35).
 */
export function sortOrder(items: readonly SerializableRuntimeValue[], span: SourceSpan): number[] {
  let kind: keyof typeof KIND_DESCRIPTIONS | undefined;
  for (const item of items) {
    const itemKind =
      typeof item === "number"
        ? "number"
        : typeof item === "string"
          ? "text"
          : isDuration(item)
            ? "duration"
            : isCalendarDuration(item)
              ? "calendarDuration"
              : isTemporal(item)
                ? item.kind
                : undefined;
    if (itemKind === undefined)
      throw fault(
        "TSR060",
        `sort() sorts numbers, text, durations, or date and time values, not ${describeRuntimeValue(item)}.`,
        span,
      );
    if (kind !== undefined && itemKind !== kind)
      throw fault(
        "TSR060",
        `sort() needs elements of one kind, but this list has ${KIND_DESCRIPTIONS[kind]} and ${KIND_DESCRIPTIONS[itemKind]}.`,
        span,
      );
    kind = itemKind;
  }
  if (kind === "calendarDuration") {
    // Calendar durations order only within one family: months, days, or exact time (ADR 0026).
    const families = new Set(
      items.map((item) =>
        isCalendarDuration(item) ? durationFamily(durationParts(item)) : "zero",
      ),
    );
    families.delete("zero");
    if (families.size > 1 || families.has("mixed"))
      throw fault(
        "TSR060",
        "sort() orders calendar durations of one kind only: months, days, or exact time.",
        span,
      );
  }
  const compare = (left: SerializableRuntimeValue, right: SerializableRuntimeValue): number => {
    if (typeof left === "string" && typeof right === "string")
      return compareCodePoints(left, right);
    if (isAnyDuration(left) && isAnyDuration(right)) {
      const order = compareDurations(left, right);
      return typeof order === "number" ? order : 0;
    }
    if (isTemporal(left) && isTemporal(right)) return compareTemporal(left, right);
    return sortKey(left) - sortKey(right);
  };
  // Ties keep their order, so the sort is stable without relying on the engine's sort.
  return items
    .map((_, index) => index)
    .sort((left, right) => compare(items[left]!, items[right]!) || left - right);
}

const KIND_DESCRIPTIONS = {
  number: "numbers",
  text: "text",
  duration: "durations",
  calendarDuration: "calendar durations",
  date: "dates",
  time: "times",
  datetime: "dates and times",
  absoluteDateTime: "absolute dates and times",
} as const;

function sortKey(value: SerializableRuntimeValue): number {
  return typeof value === "number" ? value : 0;
}

/** Compares texts by Unicode code point, independently of locale; UTF-16 order differs above U+FFFF. */
function compareCodePoints(left: string, right: string): number {
  for (let index = 0; index < left.length && index < right.length;) {
    const leftPoint = left.codePointAt(index)!;
    const rightPoint = right.codePointAt(index)!;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
    index += leftPoint > 0xffff ? 2 : 1;
  }
  return left.length - right.length;
}

/**
 * The elements of `intersection`, `union`, or `difference`, each once, in the receiver's order; `union` then adds the
 * argument's new elements in its order. Elements compare with the language's `==`.
 */
export function setOperationItems(
  name: string,
  receiver: readonly SerializableRuntimeValue[],
  argument: readonly SerializableRuntimeValue[],
): SerializableRuntimeValue[] {
  const other = new ValueIndex(argument);
  const result = new ValueIndex([]);
  const items: SerializableRuntimeValue[] = [];
  const keep = (item: SerializableRuntimeValue): void => {
    if (result.has(item)) return;
    result.add(item);
    items.push(item);
  };
  for (const item of receiver) {
    const wanted =
      name === "union" || (name === "intersection" ? other.has(item) : !other.has(item));
    if (wanted) keep(item);
  }
  if (name === "union") for (const item of argument) keep(item);
  return items;
}

/** Values for membership tests by `==`, which use canonical keys instead of pairwise comparisons. */
class ValueIndex {
  readonly #keys = new Set<string>();

  constructor(values: readonly SerializableRuntimeValue[]) {
    for (const value of values) this.add(value);
  }

  add(value: SerializableRuntimeValue): void {
    this.#keys.add(valueKey(value));
  }

  has(value: SerializableRuntimeValue): boolean {
    return this.#keys.has(valueKey(value));
  }
}

/** A text for a set operation's argument that is neither a list nor a set. */
export function setOperationArgumentMessage(name: string, value: SerializableRuntimeValue): string {
  return `${name}() needs a list or a set, not ${describeRuntimeValue(value)}.`;
}

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
