import { getArgumentsProblem } from "../../../argument-rules.js";
import { isConversion } from "../../../conversions.js";
import { isListFunction } from "../../../list-function-rules.js";
import { isNumericFunction } from "../../../numeric-functions.js";
import type { CallExpressionPlan } from "../../../plan/model.js";
import { isRandomFunction } from "../../../random-functions.js";
import { isClockFunction } from "../../../temporal-builtins.js";
import { temporalCaptureAt } from "../../host-data/temporal-captures.js";
import type { EvaluationContext } from "../../evaluator.js";
import { randomFunction } from "../../evaluation/draws.js";
import { notWholeIndex } from "../../evaluation/access.js";
import { fault } from "../../evaluation/support.js";
import { checkCollectionLength } from "../../values/collection-size.js";
import { listHasPosition } from "../../values/collection-operations.js";
import { speakerById } from "../../evaluation/speakers.js";
import { currentTemporalContext } from "../../snapshot/state.js";
import { listFunctionValue } from "../../values/list-statistics.js";
import { conversionResult, numericFunction } from "../../values/pure-operations.js";
import { visibleText } from "../../values/value-text.js";
import { temporalNow } from "../../values/temporal-operations.js";
import type { SerializableRuntimeValue } from "../../values/serializable-values.js";
import { callStringMethod } from "../../values/string-operations.js";
import { assertValueType } from "../../values/value-types.js";
import { fromCanonical } from "../values/codec.js";
import { nativeEquals } from "../values/equality.js";
import { nativeSetHas } from "../values/native-set.js";
import { NativeSet, type NativeValue } from "../values/native-value.js";
import { shown } from "./access.js";
import { NOT_NATIVE } from "./not-implemented.js";

/** The result a call gives, or that it needs its lazy `default:` (a list's `get` of an index the list does not have). */
export const NEEDS_DEFAULT: unique symbol = Symbol("needs the default");

/**
 * A call of a builtin or a method on native values whose arguments were evaluated and copied in written order, its lazy
 * `default:` left out: random, numeric and clock builtins, text methods, and a list's `add` and `get`, each through
 * today's helpers and checks, conversions and list functions without a lazy `default:`, a non-empty list's
 * `removeLast`, and a list's or set's `contains`. Every other callee gives `NOT_NATIVE`.
 */
export function nativeCall(
  context: EvaluationContext,
  expression: CallExpressionPlan,
  receiver: NativeValue,
  positional: readonly NativeValue[],
  named: Readonly<Record<string, NativeValue>>,
  hasLazyDefault: boolean,
): NativeValue | typeof NEEDS_DEFAULT | typeof NOT_NATIVE {
  const span = expression.span;
  const callee = expression.callee;
  if (callee.kind === "identifier") {
    const name = callee.name;
    if (isRandomFunction(name))
      return fromCanonical(
        randomFunction(context, name, positional.map(shown), shownRecord(named), span),
      );
    if (isNumericFunction(name))
      return fromCanonical(numericFunction(name, positional.map(shown), shownRecord(named), span));
    if (isConversion(name) && name !== "fromJson" && !hasLazyDefault) {
      const converted = conversionResult(name, positional.map(shown), shownRecord(named), false, {
        span,
        text: (value) => visibleText(value, span, currentTemporalContext(context.snapshot)),
        speakerProperties: (speaker) => speakerById(context, speaker.speakerId, span).properties,
      });
      // No result is a fault, whose message today's evaluator writes.
      return converted === undefined ? NOT_NATIVE : fromCanonical(converted);
    }
    if (isListFunction(name))
      return fromCanonical(
        listFunctionValue(name, positional.map(shown), shownRecord(named), span),
      );
    if (isClockFunction(name)) {
      const now = context.snapshot.currentSessionTimeMs;
      const capture = temporalCaptureAt(context.snapshot.temporalCaptures, now);
      return fromCanonical(
        temporalNow(name, positional.map(shown), shownRecord(named), capture, now, span),
      );
    }
    return NOT_NATIVE;
  }
  if (callee.kind !== "property") return NOT_NATIVE;
  const method = callee.name;
  if (typeof receiver === "string")
    return fromCanonical(callStringMethod(receiver, method, positional.map(shown), span));
  if (Array.isArray(receiver)) {
    switch (method) {
      case "add": {
        if (positional.length !== 1 || Object.keys(named).length > 0) return NOT_NATIVE;
        const added = positional[0]!;
        if (expression.typeCheck !== undefined)
          assertValueType(
            shown(added),
            expression.typeCheck,
            expression.arguments.at(-1)!.value.span,
          );
        checkCollectionLength("list", receiver.length + 1, receiver.length, "add(...)", span);
        // The argument is the call's own copy, so the list takes it.
        receiver.push(added);
        return null;
      }
      case "get": {
        const problem = getArgumentsProblem("list", positional.length, [
          ...Object.keys(named),
          ...(hasLazyDefault ? ["default"] : []),
        ]);
        if (problem !== undefined) throw fault("TSR028", problem.message, span);
        const index = positional[0]!;
        const indexPlan = expression.arguments.find((argument) => argument.kind === "positional");
        if (
          expression.indexCheck === true &&
          indexPlan !== undefined &&
          !(typeof index === "number" && Number.isInteger(index))
        )
          throw notWholeIndex(context, indexPlan.value, shown(index), indexPlan.value.span);
        return typeof index === "number" && listHasPosition(receiver.length, index)
          ? receiver[index]!
          : NEEDS_DEFAULT;
      }
      case "removeLast":
        // An empty list's fault is today's evaluator's to write.
        return positional.length === 0 && Object.keys(named).length === 0 && receiver.length > 0
          ? receiver.pop()!
          : NOT_NATIVE;
      case "contains":
        return positional.length === 1 && Object.keys(named).length === 0
          ? receiver.some((item) => nativeEquals(item, positional[0]!))
          : NOT_NATIVE;
      default:
        return NOT_NATIVE;
    }
  }
  if (receiver instanceof NativeSet && method === "contains")
    return positional.length === 1 && Object.keys(named).length === 0
      ? nativeSetHas(receiver, positional[0]!)
      : NOT_NATIVE;
  return NOT_NATIVE;
}

function shownRecord(
  named: Readonly<Record<string, NativeValue>>,
): Record<string, SerializableRuntimeValue> {
  const record: Record<string, SerializableRuntimeValue> = {};
  for (const name of Object.keys(named)) record[name] = shown(named[name]!);
  return record;
}
