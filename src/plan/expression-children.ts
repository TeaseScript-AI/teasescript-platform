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
 * runs only when the left side does not decide the result (V30 §18), and the default of a `load`, which runs only when
 * the key has no value.
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
  return [];
}
