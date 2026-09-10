import type { Expression } from "./ast.js";
export function expressionChildren(expression: Expression): readonly Expression[] {
  switch (expression.kind) {
    case "booleanLiteral":
    case "nullLiteral":
    case "numberLiteral":
      return [];
    case "stringLiteral":
      return expression.parts.flatMap((part) =>
        part.kind === "stringInterpolation" ? [part.expression] : [],
      );
    case "identifier":
    case "interactionExpression":
      return [];
    case "parenthesizedExpression":
      return [expression.expression];
    case "listLiteral":
    case "setLiteral":
      return expression.elements;
    case "objectLiteral":
      return expression.properties.map((property) => property.value);
    case "propertyAccessExpression":
      return [expression.object];
    case "indexExpression":
      return [expression.object, expression.index];
    case "callExpression":
      return [expression.callee, ...expression.arguments.map((argument) => argument.value)];
    case "unaryExpression":
      return [expression.operand];
    case "binaryExpression":
      return [expression.left, expression.right];
    case "rangeExpression":
      return [expression.start, expression.end];
  }
}
