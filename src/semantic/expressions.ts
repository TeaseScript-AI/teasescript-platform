import type { Expression } from "../ast.js";

// Expressions read without evaluating them: through parentheses, and the text of a literal.

/** The text of a string literal without interpolation, looking through parentheses. */
export function literalText(expression: Expression): string | undefined {
  const literal = unwrapParentheses(expression);
  if (literal.kind !== "stringLiteral") return undefined;
  let text = "";
  for (const part of literal.parts) {
    if (part.kind !== "stringText") return undefined;
    text += part.value;
  }
  return text;
}

/**
 * The texts around the `${...}` of a string literal, looking through parentheses: `["rooms/", ".tease"]` for
 * `"rooms/${room}.tease"`. `undefined` for any other expression.
 */
export function interpolatedTexts(expression: Expression): string[] | undefined {
  const literal = unwrapParentheses(expression);
  if (literal.kind !== "stringLiteral") return undefined;
  const texts = [""];
  for (const part of literal.parts) {
    if (part.kind === "stringText") texts[texts.length - 1] += part.value;
    else texts.push("");
  }
  return texts;
}

export function unwrapParentheses(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
}
