import type { ExpressionPlan } from "./model.js";
export function expressionPlanChildren(expression: ExpressionPlan): readonly ExpressionPlan[] {
  switch (expression.kind) {
    case "literal":
    case "duration":
    case "calendarDuration":
    case "identifier":
    case "debugMode":
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
