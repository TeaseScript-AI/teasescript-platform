import type { ExpressionPlan, IndexExpressionPlan } from "../../../plan/model.js";
import { stringLength, unknownTextMemberMessage } from "../../../text-operations.js";
import type { EvaluationContext } from "../../evaluator.js";
import { assertIndexable, dictKey, listPosition, missingKey } from "../../evaluation/access.js";
import { fault } from "../../evaluation/support.js";
import { listHasPosition } from "../../values/collection-operations.js";
import type { SerializableRuntimeList } from "../../values/serializable-values.js";
import { toCanonical } from "../values/codec.js";
import {
  isNativeComposite,
  NativeDict,
  NativeSet,
  type NativeValue,
} from "../values/native-value.js";
import { NOT_NATIVE } from "./not-implemented.js";

/**
 * `object[index]`: a list's element at a whole index it has, a dict's value under a text key it has; the faults of
 * today's helpers otherwise. `receiver` is the plan of the indexed value, which a fault's message names.
 */
export function nativeIndexRead(
  context: EvaluationContext,
  expression: IndexExpressionPlan,
  receiver: ExpressionPlan,
  object: NativeValue,
  index: NativeValue,
): NativeValue {
  if (Array.isArray(object))
    return object[nativeListPosition(context, object, receiver, expression.index, index, "read")]!;
  if (object instanceof NativeDict) {
    const key = dictKey(context, shown(index), expression.index);
    const value = object.entries.get(key);
    if (value === undefined)
      throw missingKey(context, key, receiver, expression.index, expression.span);
    return value;
  }
  assertNativeIndexable(context, receiver, object, expression.span);
  throw new Error("assertIndexable accepted a value that is not a list or a dict.");
}

/** The position `index` names in `list`, a whole index the list has; today's fault for the `use` otherwise. */
export function nativeListPosition(
  context: EvaluationContext,
  list: NativeValue[],
  receiver: ExpressionPlan,
  indexPlan: ExpressionPlan,
  index: NativeValue,
  use: "read" | "assign",
): number {
  if (typeof index === "number" && listHasPosition(list.length, index)) return index;
  // EVIDENCE: invariant: `toCanonical` of a native list is a canonical list.
  const canonical = toCanonical(list) as SerializableRuntimeList;
  listPosition(context, canonical, receiver, indexPlan, shown(index), use);
  throw new Error("listPosition accepted an index the list does not have.");
}

/** Today's check that a value can be indexed, a list or a dict, made before its index is evaluated. */
export function assertNativeIndexable(
  context: EvaluationContext,
  receiver: ExpressionPlan,
  object: NativeValue,
  span: ExpressionPlan["span"],
): void {
  if (!Array.isArray(object) && !(object instanceof NativeDict))
    assertIndexable(context, shown(object), receiver, span);
}

/**
 * `.length` of a list, set, dict or text, and a non-empty list's `first` and `last`; a text's other members fail as
 * today's; any other property gives `NOT_NATIVE`.
 */
export function nativeProperty(
  value: NativeValue,
  name: string,
  span: ExpressionPlan["span"],
): NativeValue | typeof NOT_NATIVE {
  if (typeof value === "string") {
    if (name === "length") return stringLength(value);
    throw fault("TSR017", unknownTextMemberMessage(name, "property"), span);
  }
  // A non-empty list's first and last element; an empty list's fault is today's evaluator's to write.
  if (Array.isArray(value) && value.length > 0) {
    if (name === "first") return value[0]!;
    if (name === "last") return value[value.length - 1]!;
  }
  if (name === "length") {
    if (Array.isArray(value)) return value.length;
    if (value instanceof NativeSet) return value.items.length;
    if (value instanceof NativeDict) return value.entries.size;
  }
  return NOT_NATIVE;
}

/** A value as today's helpers take it: composites in their canonical form, for a fault's message. */
export function shown(value: NativeValue): ReturnType<typeof toCanonical> {
  return isNativeComposite(value) ? toCanonical(value) : value;
}
