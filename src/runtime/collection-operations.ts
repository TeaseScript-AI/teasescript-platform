import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
import { serializableEquals, type SerializableRuntimeValue } from "./serializable-values.js";
import { describeRuntimeValue, isDuration } from "./value-predicates.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/** The set operations of lists and sets (V30 §16, ADR 0013). */
export const SET_OPERATIONS: ReadonlySet<string> = new Set(["intersection", "union", "difference"]);

/**
 * The ascending, stable order of sortable list items as their old indexes: numbers (integers and numbers together),
 * text by Unicode code point, or durations. Every item must be of one of these kinds, and all of the same kind.
 */
export function sortOrder(items: readonly SerializableRuntimeValue[], span: SourceSpan): number[] {
  let kind: "number" | "text" | "duration" | undefined;
  for (const item of items) {
    const itemKind =
      typeof item === "number"
        ? "number"
        : typeof item === "string"
          ? "text"
          : isDuration(item)
            ? "duration"
            : undefined;
    if (itemKind === undefined)
      throw fault(
        "TSR060",
        `sort() sorts numbers, text, or durations, not ${describeRuntimeValue(item)}.`,
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
  const compare = (left: SerializableRuntimeValue, right: SerializableRuntimeValue): number =>
    typeof left === "string" && typeof right === "string"
      ? compareCodePoints(left, right)
      : sortKey(left) - sortKey(right);
  // Ties keep their order, so the sort is stable without relying on the engine's sort.
  return items
    .map((_, index) => index)
    .sort((left, right) => compare(items[left]!, items[right]!) || left - right);
}

const KIND_DESCRIPTIONS = { number: "numbers", text: "text", duration: "durations" } as const;

function sortKey(value: SerializableRuntimeValue): number {
  return typeof value === "number" ? value : isDuration(value) ? value.milliseconds : 0;
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

/**
 * Values for membership tests by `==`. Text, numbers, booleans, `null`, and durations are looked up directly, so the set
 * operations stay linear for them; objects, lists, and other values compare structurally with each kept one.
 */
class ValueIndex {
  readonly #scalars = new Set<string | number | boolean | null>();
  readonly #durations = new Set<number>();
  readonly #others: SerializableRuntimeValue[] = [];

  constructor(values: readonly SerializableRuntimeValue[]) {
    for (const value of values) this.add(value);
  }

  add(value: SerializableRuntimeValue): void {
    if (value === null || typeof value !== "object") this.#scalars.add(value);
    else if (isDuration(value)) this.#durations.add(value.milliseconds);
    else this.#others.push(value);
  }

  has(value: SerializableRuntimeValue): boolean {
    if (value === null || typeof value !== "object") return this.#scalars.has(value);
    if (isDuration(value)) return this.#durations.has(value.milliseconds);
    return this.#others.some((other) => serializableEquals(other, value));
  }
}

/** A text for a set operation's argument that is neither a list nor a set. */
export function setOperationArgumentMessage(name: string, value: SerializableRuntimeValue): string {
  return `${name}() needs a list or a set, not ${describeRuntimeValue(value)}.`;
}

function fault(code: string, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
