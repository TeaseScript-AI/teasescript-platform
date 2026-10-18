import { unknownNamedArgumentMessage } from "../../argument-rules.js";
import {
  DICT_METHODS,
  dictArgumentsProblem,
  isDictMethod,
  missingDictMethodMessage,
} from "../../dict-operations.js";
import {
  hasListMethod,
  LIST_METHODS,
  listArgumentMessage,
  listMethod,
  missingListMethodMessage,
  type ListMethod,
  type MethodOf,
} from "../../list-methods.js";
import type { ExpressionPlan, TypeCheckPlan } from "../../plan/model.js";
import { internalFault, RuntimeFault } from "../errors.js";
import {
  freezePreparedReferenceDescendants,
  preparePreparedReferencesForListRemoval,
  preparePreparedReferencesForListReorder,
  refreshPreparedReferenceFallbacks,
} from "../prepared-references.js";
import { joinedText } from "../value-text.js";
import {
  checkCollectionLength,
  collectionTooLong,
  MAX_COLLECTION_LENGTH,
} from "../collection-size.js";
import { findValue, readCollection, readDict, sortOrder } from "../collection-operations.js";
import { missingMemberMessage } from "../string-operations.js";
import { methodArgumentCountMessage } from "../../text-operations.js";
import {
  addOwnedSerializableSetValue,
  clearSerializableDict,
  clearSerializableSet,
  getSerializableDictEntry,
  removeSerializableDictEntry,
  removeSerializableSetValue,
  serializableSetContains,
  SerializableValueError,
  type SerializableRuntimeDict,
  type SerializableRuntimeList,
  type SerializableRuntimeSet,
  type SerializableRuntimeValue,
} from "../serializable-values.js";
import { currentTemporalContext } from "../state.js";
import { isList, isRange, isSet } from "../value-predicates.js";
import { assertValueType } from "../value-types.js";
import { describeValue } from "../../value-kinds.js";
import type { Evaluator } from "../evaluator.js";
import { shuffleOrder } from "./draws.js";
import { type SourceSpan, fault, USE_DEFAULT } from "./support.js";
import { dictKey, missingKey, listPosition } from "./access.js";

// The methods of lists, sets, and dicts.

/** One element of `list.join()`: a scalar as visible text, without selecting from nested lists. */
function joinedElementText(
  evaluator: Evaluator,
  item: SerializableRuntimeValue,
  span: SourceSpan,
): string {
  return joinedText(item, span, currentTemporalContext(evaluator.snapshot));
}

/** `added` is the check of an element that `add` inserts, from the compiler (ADR 0021 rule 1.7). */
export function callCollection(
  evaluator: Evaluator,
  receiver: SerializableRuntimeValue,
  receiverPlan: ExpressionPlan,
  name: string,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  defaulted: boolean,
  span: SourceSpan,
  added: { readonly check: TypeCheckPlan; readonly span: SourceSpan } | null,
): SerializableRuntimeValue | typeof USE_DEFAULT {
  evaluator.referenceEpoch++;
  if (!isList(receiver) && !isSet(receiver))
    throw fault("TSR016", missingMemberMessage(receiver, name, "method"), span);
  const namedArgument = Object.keys(named)[0];
  // Only a list's `get` takes a named argument, its `default:`; a set has no `get`.
  if (namedArgument !== undefined && listMethod(name)?.named === undefined)
    throw fault("TSR015", unknownNamedArgumentMessage(name, namedArgument, []), span);
  // The method's parameters as the compiler checks them for a list or a set; `get` checks its own with its default.
  const expect = (method: ListMethod): void => {
    const required = method.parameters.filter((parameter) => !parameter.optional).length;
    if (
      method.named === undefined &&
      (positional.length < required || positional.length > method.parameters.length)
    )
      throw fault("TSR028", methodArgumentCountMessage(method, positional.length), span);
  };
  try {
    if (isSet(receiver)) {
      if (!hasListMethod("set", name))
        throw fault("TSR016", missingListMethodMessage("set", name), span);
      expect(LIST_METHODS[name]);
      return callSet(evaluator, receiver, name, positional, span, added);
    }
    if (!hasListMethod("list", name))
      throw fault("TSR016", missingListMethodMessage("list", name), span);
    expect(LIST_METHODS[name]);
    return callList(
      evaluator,
      receiver,
      receiverPlan,
      name,
      positional,
      named,
      defaulted,
      span,
      added,
    );
  } catch (error) {
    if (error instanceof RuntimeFault) throw error;
    throw translateValueError(error, span);
  }
}

/** A method of a set, with as many arguments as it takes (see `LIST_METHODS`). */
function callSet(
  evaluator: Evaluator,
  receiver: SerializableRuntimeSet,
  name: MethodOf<"set">,
  positional: readonly SerializableRuntimeValue[],
  span: SourceSpan,
  added: { readonly check: TypeCheckPlan; readonly span: SourceSpan } | null,
): SerializableRuntimeValue {
  switch (name) {
    case "add":
      if (added !== null) assertValueType(positional[0]!, added.check, added.span);
      if (
        receiver.items.length >= MAX_COLLECTION_LENGTH &&
        !serializableSetContains(receiver, positional[0]!)
      )
        throw collectionTooLong("set", "add(...)", span, receiver.items.length + 1);
      // Arguments are captured when evaluated, so the set takes its own.
      addOwnedSerializableSetValue(receiver, positional[0]!);
      return null;
    case "remove":
      removeSerializableSetValue(receiver, positional[0]!);
      return null;
    case "clear":
      clearSerializableSet(receiver);
      return null;
    case "contains":
    case "toList":
    case "intersection":
    case "union":
    case "difference":
      return readCollection(receiver, name, positional, {}, false, span, (item) =>
        joinedElementText(evaluator, item, span),
      )!;
    default: {
      const unhandled: never = name;
      throw new Error(`Set method '${String(unhandled)}' has no implementation.`);
    }
  }
}

/** A method of a list, with as many arguments as it takes, but `get` (see `LIST_METHODS`). */
function callList(
  evaluator: Evaluator,
  receiver: SerializableRuntimeList,
  receiverPlan: ExpressionPlan,
  name: MethodOf<"list">,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  defaulted: boolean,
  span: SourceSpan,
  added: { readonly check: TypeCheckPlan; readonly span: SourceSpan } | null,
): SerializableRuntimeValue | typeof USE_DEFAULT {
  switch (name) {
    case "add":
      if (added !== null) assertValueType(positional[0]!, added.check, added.span);
      checkCollectionLength(
        "list",
        receiver.items.length + 1,
        receiver.items.length,
        "add(...)",
        span,
      );
      // Arguments are captured when evaluated, so the list takes its own.
      receiver.items.push(positional[0]!);
      return null;
    case "addAll": {
      const other = positional[0]!;
      if (!isList(other))
        throw fault(
          "TSR060",
          listArgumentMessage(
            name,
            "list",
            describeValue(other),
            isSet(other) ? "set" : isRange(other) ? "range" : "other",
          ),
          span,
        );
      // Every element is checked before any is added. The argument was captured when evaluated, also a list adding
      // itself, so its elements are the list's own to take.
      if (added !== null)
        for (const item of other.items) assertValueType(item, added.check, added.span);
      checkCollectionLength(
        "list",
        receiver.items.length + other.items.length,
        Math.max(receiver.items.length, other.items.length),
        "addAll(...)",
        span,
      );
      for (const item of other.items) receiver.items.push(item);
      return null;
    }
    case "remove": {
      const index = findValue(receiver.items, positional[0]!);
      if (index >= 0) removeListItem(evaluator, receiver, index);
      else {
        evaluator.warn(
          "TSW002",
          "remove(...) found no matching value, so the list is unchanged.",
          span,
        );
      }
      return null;
    }
    case "removeAt": {
      const index = listPosition(
        evaluator,
        receiver,
        receiverPlan,
        null,
        positional[0]!,
        "remove",
        span,
      );
      return removeListItem(evaluator, receiver, index);
    }
    case "removeFirst":
    case "removeLast":
      if (receiver.items.length === 0)
        throw fault(
          "TSR018",
          `Cannot call ${name}() on an empty list. Check that the list's length is above 0 first.`,
          span,
        );
      return removeListItem(
        evaluator,
        receiver,
        name === "removeFirst" ? 0 : receiver.items.length - 1,
      );
    case "clear":
      clearList(evaluator, receiver);
      return null;
    case "contains":
    case "indexOf":
    case "lastIndexOf":
    case "count":
    case "get":
    case "toSet":
    case "take":
    case "takeLast":
    case "intersection":
    case "union":
    case "difference":
    case "join": {
      const value = readCollection(receiver, name, positional, named, defaulted, span, (item) =>
        joinedElementText(evaluator, item, span),
      );
      return value === undefined ? USE_DEFAULT : value;
    }
    case "sort":
    case "shuffle":
      reorderList(
        evaluator,
        receiver,
        name === "sort" ? sortOrder(receiver.items, span) : shuffleOrder(evaluator, receiver, span),
      );
      return null;
    // The last element first: the old indexes from the end.
    case "reverse":
      reorderList(
        evaluator,
        receiver,
        receiver.items.map((_, index) => receiver.items.length - 1 - index),
      );
      return null;
    default: {
      const unhandled: never = name;
      throw new Error(`List method '${String(unhandled)}' has no implementation.`);
    }
  }
}

/** A method of a dict, with as many arguments as it takes (see `DICT_METHODS`), each a text key. */
export function callDict(
  evaluator: Evaluator,
  receiver: SerializableRuntimeDict,
  expression: Extract<ExpressionPlan, { kind: "call" }>,
  positional: readonly SerializableRuntimeValue[],
  named: Readonly<Record<string, SerializableRuntimeValue>>,
  defaulted: boolean,
): SerializableRuntimeValue | typeof USE_DEFAULT {
  // EVIDENCE: invariant: #call dispatches here only for a property callee.
  const callee = expression.callee as Extract<ExpressionPlan, { kind: "property" }>;
  const name = callee.name;
  const span = expression.span;
  if (!isDictMethod(name)) throw fault("TSR016", missingDictMethodMessage(name), span);
  const problem = dictArgumentsProblem(DICT_METHODS[name], positional.length, [
    ...Object.keys(named),
    ...(defaulted ? ["default"] : []),
  ]);
  if (problem !== undefined) throw fault("TSR028", problem.message, span);
  if (name === "clear") {
    clearDict(evaluator, receiver);
    return null;
  }
  // Every other method takes one key.
  const keyPlan = expression.arguments[0]!.value;
  const key = dictKey(evaluator, positional[0]!, keyPlan);
  switch (name) {
    case "contains":
    case "get": {
      const value = readDict(receiver, name, key);
      return value === undefined ? USE_DEFAULT : value;
    }
    case "remove":
      if (getSerializableDictEntry(receiver, key) === undefined)
        throw missingKey(evaluator, key, callee.object, keyPlan, span);
      return removeDictEntry(evaluator, receiver, key);
    default: {
      const unhandled: never = name;
      throw new Error(`Dict method '${String(unhandled)}' has no implementation.`);
    }
  }
}

/** Puts the items in `order` (old indexes), moving prepared references into items along with them. */
function reorderList(
  evaluator: Evaluator,
  list: SerializableRuntimeList,
  order: readonly number[],
): void {
  const newIndexOf: number[] = [];
  for (const [index, old] of order.entries()) newIndexOf[old] = index;
  const rebased = preparePreparedReferencesForListReorder(evaluator.snapshot, list, newIndexOf);
  const items = order.map((old) => list.items[old]!);
  for (const [index, item] of items.entries()) list.items[index] = item;
  refreshPreparedReferenceFallbacks(evaluator.snapshot, rebased);
}

function removeListItem(
  evaluator: Evaluator,
  list: SerializableRuntimeList,
  index: number,
): SerializableRuntimeValue {
  const rebased = preparePreparedReferencesForListRemoval(evaluator.snapshot, list, index);
  const removed = list.items.splice(index, 1)[0]!;
  refreshPreparedReferenceFallbacks(evaluator.snapshot, rebased);
  return removed;
}

/** Empties a list; the prepared references into its items keep the values they refer to now. */
function clearList(evaluator: Evaluator, list: SerializableRuntimeList): void {
  if (list.items.length === 0) return;
  freezePreparedReferenceDescendants(evaluator.snapshot, list);
  list.items.length = 0;
}

/**
 * Removes the entry of `key`; the prepared references through it keep the values they refer to now. The other entries
 * keep their keys, so no reference moves and no fallback needs refreshing, unlike a list's removal.
 */
function removeDictEntry(
  evaluator: Evaluator,
  dict: SerializableRuntimeDict,
  key: string,
): SerializableRuntimeValue {
  freezePreparedReferenceDescendants(evaluator.snapshot, dict, key);
  return removeSerializableDictEntry(dict, key)!.value;
}

/** Empties a dict; the prepared references into its entries keep the values they refer to now. */
function clearDict(evaluator: Evaluator, dict: SerializableRuntimeDict): void {
  if (dict.entries.length === 0) return;
  freezePreparedReferenceDescendants(evaluator.snapshot, dict);
  clearSerializableDict(dict);
}

function translateValueError(error: unknown, span: SourceSpan): RuntimeFault {
  if (error instanceof SerializableValueError) {
    return fault("TSR031", internalFault(error.message), span);
  }
  throw error;
}
