import type { ExpressionPlan } from "./model.js";
export function expressionPlanChildren(expression: ExpressionPlan): readonly ExpressionPlan[] {
  switch (expression.kind) {
    case "literal":
    case "identifier":
    case "temporary":
    case "preparedReference":
      return [];
    case "list":
    case "set":
      return expression.elements;
    case "object":
      return expression.properties.map((p) => p.value);
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
      return [expression.operand];
    case "binary":
      return [expression.left, expression.right];
    case "range":
      return [expression.start, expression.end];
  }
}
