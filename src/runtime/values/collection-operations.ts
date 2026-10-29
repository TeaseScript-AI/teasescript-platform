import { compareCodePoints } from "../../code-points.js";
import type { RuntimeErrorCode } from "../../diagnostic-codes.js";
import { withoutNegativeZero } from "../../conversions.js";
import { compareAngles } from "../../angle.js";
import { compareDurations, durationFamily, durationParts } from "../../duration.js";
import type { PlanSourceLocation } from "../../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../../source.js";
import { getArgumentsProblem } from "../../argument-rules.js";
import {
  countProblem,
  LIST_METHODS,
  listArgumentMessage,
  SORT_RULE,
  type ListKind,
  type ListMethod,
} from "../../list-methods.js";
import type { ReadingDictMethod } from "../../dict-operations.js";
import { LIST_JOIN } from "../../text-operations.js";
import { checkCollectionLength, MAX_COLLECTION_LENGTH } from "./collection-size.js";
import { RuntimeFault } from "../errors.js";
import {
  createCapturedSerializableList,
  createCapturedSerializableSet,
  getSerializableDictEntry,
  serializableEquals,
  serializableSetContains,
  valueKey,
  type SerializableRuntimeDict,
  type SerializableRuntimeList,
  type SerializableRuntimeSet,
  type SerializableRuntimeValue,
} from "./serializable-values.js";
import { checkTextArguments } from "./string-operations.js";
import { compareTemporal } from "./temporal-operations.js";
import { checkTextLength, groupedDigits } from "./text-length.js";
import {
  isAngle,
  isAnyDuration,
  isCalendarDuration,
  isList,
  isRange,
  isSet,
  isTemporal,
} from "./value-predicates.js";
import {
  describeValue,
  orderedFamily,
  VALUE_KINDS,
  valueKindOf,
  type OrderedFamily,
} from "../../value-kinds.js";
import { copySpan } from "../../plan/source-location.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/**
 * The ascending, stable order of sortable list items as their old indexes: numbers (integers and numbers together),
 * text by Unicode code point, durations, angles by size, or date and time values. Every item must be of one of these kinds, and all of
 * the same kind; dates, times, datetimes, and absolute dates and times are four kinds (V30 §35).
 */
export function sortOrder(items: readonly SerializableRuntimeValue[], span: SourceSpan): number[] {
  let kind: OrderedFamily | undefined;
  for (const item of items) {
    const itemKind = orderedFamily(valueKindOf(item));
    if (itemKind === undefined)
      throw fault("TSV043", `${SORT_RULE}, not ${describeValue(item)}.`, span);
    if (kind !== undefined && itemKind !== kind)
      throw fault(
        "TSR060",
        `sort() needs elements of one kind, but this list has ${VALUE_KINDS[kind].plural} and ${VALUE_KINDS[itemKind].plural}.`,
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
    if (isAngle(left) && isAngle(right)) return compareAngles(left, right);
    if (isTemporal(left) && isTemporal(right)) return compareTemporal(left, right);
    return sortKey(left) - sortKey(right);
  };
  // Ties keep their order, so the sort is stable without relying on the engine's sort.
  return items
    .map((_, index) => index)
    .sort((left, right) => compare(items[left]!, items[right]!) || left - right);
}

function sortKey(value: SerializableRuntimeValue): number {
  return typeof value === "number" ? value : 0;
}

/**
 * The elements of `intersection`, `union`, or `difference`, each once, in the receiver's order; `union` then adds the
 * argument's new elements in its order. Elements compare with the language's `==`.
 */
function setOperationItems(
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

/**
 * A call of a method of a dict that only reads it (`onlyReadsDict`) with a text key: whether the dict has the key, or
 * the key's value, the dict's own, or `undefined` where `get` gives its default. A stored null is a value, so only a
 * missing key gives the default. The evaluator runs it, and the compiler computes known values with it.
 */
export function readDict(
  receiver: SerializableRuntimeDict,
  name: ReadingDictMethod,
  key: string,
): SerializableRuntimeValue | undefined {
  const entry = getSerializableDictEntry(receiver, key);
  switch (name) {
    case "contains":
      return entry !== undefined;
    case "get":
      return entry?.value;
    default: {
      const unhandled: never = name;
      throw new Error(`Dict method '${String(unhandled)}' has no reading implementation.`);
    }
  }
}

/** Whether a list of `length` elements has the position `index`: a whole number from 0 up to below its length. */
export function listHasPosition(length: number, index: unknown): index is number {
  return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < length;
}

/**
 * A call of a method of a list or set that only reads it (`onlyReadsList`), with as many arguments as it takes: its
 * result, or `undefined` when a list's `get` gives its `default:`, which `defaulted` says the call has and `named`
 * leaves out. `text` shows an element as `join` joins it. The evaluator runs it, and the compiler computes known values
 * with it.
 */
export function readCollection(
  receiver: SerializableRuntimeList | SerializableRuntimeSet,
  name: string,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  defaulted: boolean,
  span: SourceSpan,
  text: (item: SerializableRuntimeValue) => string,
): SerializableRuntimeValue | undefined {
  if (isSet(receiver))
    switch (name) {
      case "contains":
        return serializableSetContains(receiver, positional[0]!);
      case "toList":
        return createCapturedSerializableList(receiver.items);
      case "intersection":
      case "union":
      case "difference":
        return createCapturedSerializableSet(
          setOperation("set", name, receiver.items, positional[0]!, span),
        );
      default:
        throw new Error(`Set method '${name}' has no reading implementation.`);
    }
  switch (name) {
    case "contains":
      return findValue(receiver.items, positional[0]!) >= 0;
    // A value that no element equals has no position: null (#840).
    case "indexOf":
    case "lastIndexOf": {
      const index = findValue(receiver.items, positional[0]!, name === "lastIndexOf");
      return index < 0 ? null : index;
    }
    case "count": {
      let count = 0;
      for (const item of receiver.items) if (serializableEquals(item, positional[0]!)) count += 1;
      return count;
    }
    // A value that is not a position of the list, such as a negative or fractional index, text, or null, gives the
    // default (#844).
    case "get": {
      const problem = getArgumentsProblem("list", positional.length, [
        ...Object.keys(named),
        ...(defaulted ? ["default"] : []),
      ]);
      if (problem !== undefined) throw fault("TSR028", problem.message, span);
      const index = positional[0]!;
      return listHasPosition(receiver.items.length, index) ? receiver.items[index]! : undefined;
    }
    case "toSet":
      return createCapturedSerializableSet(receiver.items);
    case "take":
    case "takeLast": {
      const count = positional[0]!;
      // A number that is not whole is of another type than a count, as the compiler sees it.
      if (typeof count !== "number" || !Number.isInteger(count))
        throw fault(
          "TSV043",
          listArgumentMessage(name, "count", describeValue(count), "other"),
          span,
        );
      const problem = countProblem(name, count);
      if (problem !== undefined) throw fault("TSV043", problem, span);
      // A count beyond the length takes the whole list.
      return createCapturedSerializableList(
        name === "take"
          ? receiver.items.slice(0, count)
          : receiver.items.slice(Math.max(0, receiver.items.length - count)),
      );
    }
    case "intersection":
    case "union":
    case "difference":
      return createCapturedSerializableList(
        setOperation("list", name, receiver.items, positional[0]!, span),
      );
    case "join": {
      checkTextArguments(LIST_JOIN, positional, span);
      // EVIDENCE: invariant: checkTextArguments proved that a given separator is text.
      const separator = (positional[0] as string | undefined) ?? ", ";
      let length = separator.length * Math.max(0, receiver.items.length - 1);
      const texts = receiver.items.map((item) => {
        const shown = text(item);
        length += shown.length;
        return shown;
      });
      checkTextLength(length, "join", span);
      return texts.join(separator);
    }
    default:
      throw new Error(`List method '${name}' has no reading implementation.`);
  }
}

/** The index of the first element equal to `value`, or with `last` of the last one; -1 when there is none. */
export function findValue(
  items: readonly SerializableRuntimeValue[],
  value: SerializableRuntimeValue,
  last = false,
): number {
  // A scalar equals only the same scalar, as strict equality compares it; runtime numbers are never NaN.
  if (value === null || typeof value !== "object")
    return last ? items.lastIndexOf(value) : items.indexOf(value);
  for (let step = 0; step < items.length; step += 1) {
    const index = last ? items.length - 1 - step : step;
    if (serializableEquals(items[index]!, value)) return index;
  }
  return -1;
}

/**
 * The elements of `intersection`, `union`, or `difference` of the `items` of a list or set of `kind` and `argument`,
 * which may be a list or a set whatever the receiver is.
 */
function setOperation(
  kind: ListKind,
  name: "intersection" | "union" | "difference",
  items: readonly SerializableRuntimeValue[],
  argument: SerializableRuntimeValue,
  span: SourceSpan,
): SerializableRuntimeValue[] {
  if (!isList(argument) && !isSet(argument))
    throw fault(
      "TSV043",
      listArgumentMessage(
        name,
        "collection",
        describeValue(argument),
        isRange(argument) ? "range" : "other",
      ),
      span,
    );
  const result = setOperationItems(name, items, argument.items);
  const method: ListMethod = LIST_METHODS[name];
  if (method.grows === true)
    checkCollectionLength(
      kind,
      result.length,
      Math.max(items.length, argument.items.length),
      `${name}(...)`,
      span,
    );
  return result;
}

/**
 * Whether `toList()` on the range of whole numbers from `start` to `end` gives more numbers than a list can hold
 * (`MAX_COLLECTION_LENGTH`, V30 §6), and so fails before it builds the list: the message, or `null`. The compiler and
 * the runtime share it.
 */
export function rangeListLengthProblem(
  start: number,
  end: number,
  inclusive: boolean,
): string | null {
  const length = end - start + (inclusive ? 1 : 0);
  if (length <= MAX_COLLECTION_LENGTH) return null;
  const range = `${withoutNegativeZero(start)}${inclusive ? "..=" : ".."}${withoutNegativeZero(end)}`;
  return `toList() can make a list of at most ${groupedDigits(MAX_COLLECTION_LENGTH)} numbers, but ${range} holds ${groupedDigits(length)}. Use a smaller range.`;
}

function fault(code: RuntimeErrorCode, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
