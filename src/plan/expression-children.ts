import { lazyDefaultOperation, type LazyDefaultOperation } from "../lazy-defaults.js";
import type { ExpressionPlan } from "./model.js";

export function expressionPlanChildren(expression: ExpressionPlan): readonly ExpressionPlan[] {
  switch (expression.kind) {
    case "literal":
    case "regex":
    case "duration":
    case "calendarDuration":
    case "identifier":
    case "debugMode":
    case "accountField":
    case "temporary":
    case "preparedReference":
      return [];
    case "list":
    case "set":
      return expression.elements;
    case "object":
      return expression.properties.map((p) => p.value);
    case "dict":
      return expression.entries.flatMap((entry) => [entry.key, entry.value]);
    case "group":
      return [expression.expression];
    case "template":
      return expression.parts.flatMap((p) => (p.kind === "expression" ? [p.expression] : []));
    case "property":
      return [expression.object];
    case "index":
      return [expression.object, expression.index];
    case "call":
      return [expression.callee, ...expression.arguments.map((a) => a.value)];
    case "unary":
    case "unit":
    case "angleUnit":
      return [expression.operand];
    case "typeTest":
      return [expression.value];
    case "binary":
      return [expression.left, expression.right];
    case "range":
      return [expression.start, expression.end];
    case "storageLoad":
      return expression.default === null ? [expression.key] : [expression.key, expression.default];
    case "tagQuery":
      return expression.operands;
  }
}

/**
 * The children that the runtime evaluates only on some ways: the right side of `and`, `or`, and `otherwise`, which
 * runs only when the left side does not decide the result (V30 §18), the default of a `load`, which runs only when
 * the key has no value, and the `default:` of a call, which runs only when the call needs it.
 */
export function conditionalExpressionPlanChildren(
  expression: ExpressionPlan,
): readonly ExpressionPlan[] {
  if (expression.kind === "binary")
    return expression.operator === "and" ||
      expression.operator === "or" ||
      expression.operator === "otherwise"
      ? [expression.right]
      : [];
  if (expression.kind === "storageLoad")
    return expression.default === null ? [] : [expression.default];
  if (expression.kind === "call") {
    const index = lazyDefaultArgumentIndex(expression);
    return index === -1 ? [] : [expression.arguments[index]!.value];
  }
  return [];
}

/** The plan of a call, as far as the rule of a `default:` that runs only when it is used reads it. */
interface CallShape {
  readonly callee: { readonly kind?: unknown; readonly name?: unknown };
  readonly arguments: readonly { readonly kind?: unknown; readonly name?: unknown }[];
}

/** The operation of a call whose `default:` runs only when the call needs it, or `null` (see `LazyDefaultOperation`). */
export function lazyDefaultCallOperation(call: CallShape): LazyDefaultOperation | null {
  const { kind, name } = call.callee;
  if (typeof name !== "string") return null;
  return kind === "identifier"
    ? lazyDefaultOperation(name, false)
    : kind === "property"
      ? lazyDefaultOperation(name, true)
      : null;
}

/**
 * The position of a call's `default:` among its arguments when it runs only when the call needs it, after the other
 * arguments and the call's own work, or -1 when every argument runs before the call. It reads only kinds and names, so
 * plan validation may ask it about a call it has not validated yet.
 */
export function lazyDefaultArgumentIndex(call: CallShape): number {
  if (lazyDefaultCallOperation(call) === null) return -1;
  return call.arguments.findIndex(
    (argument) => argument.kind === "named" && argument.name === "default",
  );
}
