// What the checks of built-in operations share: the problem they report, the known values they read, the type an
// operation acts on, and how a message names an expression.

import type { Expression } from "./ast.js";
import type { SourceSpan } from "./source.js";
import { type KnownValue } from "./static-evaluation.js";
import { nonNullType, resolved, type StaticType } from "./static-types.js";

/** The value that every run gives an expression, when the compiler knows it (see `KnownValues`). */
export type Known = (expression: Expression) => KnownValue | undefined;

/**
 * A compile-time problem with a built-in operation: a wrong number of arguments, an argument name it does not take, or
 * a value it cannot use.
 */
export interface OperationProblem {
  readonly kind: "argumentCount" | "unknownNamedArgument" | "invalidOperand" | "unshowableValue";
  readonly message: string;
  readonly span: SourceSpan;
  /** An argument whose number type a widened variable may explain; the explanation goes before `fix`. */
  readonly widened?: Expression;
  readonly fix?: string;
}

/** The source spelling of a variable or property path, such as `items` or `door.keys`. */
export function expressionLabel(expression: Expression): string | null {
  const names: string[] = [];
  let current = withoutParentheses(expression);
  while (current.kind === "propertyAccessExpression") {
    names.push(current.property.name);
    current = withoutParentheses(current.object);
  }
  if (current.kind !== "identifier") return null;
  names.push(current.name);
  return names.reverse().join(".");
}

export function withoutParentheses(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
}

/**
 * The type an operation acts on: a possibly null value acts on its other members (V30 §34), and a value that is only
 * `null` stays `null`, so its misuse is still visible.
 */
export function forUse(type: StaticType): StaticType {
  const value = resolved(nonNullType(type));
  return value.kind === "never" ? resolved(type) : value;
}
