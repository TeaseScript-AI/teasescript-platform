import type { Expression } from "./ast.js";

export function staticNumber(expression: Expression): number | undefined {
  let negate = false;
  while (true) {
    expression = unwrapParentheses(expression);
    if (
      expression.kind !== "unaryExpression" ||
      (expression.operator !== "+" && expression.operator !== "-")
    )
      break;
    if (expression.operator === "-") negate = !negate;
    expression = expression.operand;
  }

  let value: number | undefined;
  if (expression.kind === "numberLiteral") {
    value = expression.value;
  } else if (expression.kind === "binaryExpression") {
    const left = staticNumber(expression.left);
    const right = staticNumber(expression.right);
    if (left === undefined || right === undefined) return undefined;
    switch (expression.operator) {
      case "+":
        value = left + right;
        break;
      case "-":
        value = left - right;
        break;
      case "*":
        value = left * right;
        break;
      case "/":
        value = right === 0 ? undefined : left / right;
        break;
      case "%":
        value = right === 0 ? undefined : left % right;
        break;
      default:
        value = undefined;
        break;
    }
  }
  return value === undefined || !negate ? value : -value;
}

export function staticVisibleText(expression: Expression): string | undefined {
  expression = unwrapParentheses(expression);
  switch (expression.kind) {
    case "stringLiteral":
      return expression.value;
    case "numberLiteral":
      return Number.isFinite(expression.value)
        ? String(Object.is(expression.value, -0) ? 0 : expression.value)
        : undefined;
    case "booleanLiteral":
      return expression.value ? "true" : "false";
    case "nullLiteral":
      return "null";
    case "unaryExpression":
    case "binaryExpression": {
      const value = staticNumber(expression);
      return value !== undefined && Number.isFinite(value)
        ? String(Object.is(value, -0) ? 0 : value)
        : undefined;
    }
    case "templateLiteral": {
      const parts: string[] = [];
      for (const part of expression.parts) {
        if (part.kind === "templateText") {
          parts.push(part.value);
          continue;
        }
        const value = staticVisibleText(part.expression);
        if (value === undefined) return undefined;
        parts.push(value);
      }
      return parts.join("");
    }
    default:
      return undefined;
  }
}

function unwrapParentheses(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
}
