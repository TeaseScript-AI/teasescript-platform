import type { Expression } from "./ast.js";
import { runCompileTask, compileChild, type CompileTask } from "./compiler/continuation.js";
import { durationLiteralMilliseconds, formatDuration } from "./duration.js";

export function staticNumber(expression: Expression): number | undefined {
  return runCompileTask(staticNumberTask(expression));
}

export function staticVisibleText(expression: Expression): string | undefined {
  const known = staticScalar(expression);
  return known === undefined ? undefined : scalarText(known.value);
}

function unwrapParentheses(expression: Expression): Expression {
  while (expression.kind === "parenthesizedExpression") expression = expression.expression;
  return expression;
}

function* staticNumberTask(expression: Expression): CompileTask<number | undefined> {
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
    const left = yield* compileChild(staticNumberTask(expression.left));
    const right = yield* compileChild(staticNumberTask(expression.right));
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

/** A scalar known at compile time: text, a finite number, a boolean, `null`, or a duration. */
export type StaticScalar =
  string | number | boolean | null | { readonly kind: "duration"; readonly milliseconds: number };

/**
 * The value of a literal, of interpolated text whose parts are known, or of number and duration arithmetic on known
 * operands, with the runtime's operations. Anything else is `undefined`.
 */
function staticScalar(expression: Expression): { readonly value: StaticScalar } | undefined {
  return runCompileTask(staticScalarTask(expression, false));
}

/**
 * A known number or duration as the runtime would compute it. A step that overflows makes the whole value that
 * non-finite result, which the runtime would reject, so a caller can report it. Anything else is `undefined`.
 */
export function staticQuantity(
  expression: Expression,
): number | { readonly kind: "duration"; readonly milliseconds: number } | undefined {
  const known = runCompileTask(staticScalarTask(expression, true))?.value;
  return typeof known === "number" || isStaticDuration(known) ? known : undefined;
}

/** Scalar visible text, as the runtime converts the value. */
function scalarText(value: StaticScalar): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(Object.is(value, -0) ? 0 : value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  return formatDuration(value.milliseconds);
}

function* staticScalarTask(
  expression: Expression,
  keepNonFinite: boolean,
): CompileTask<{ readonly value: StaticScalar } | undefined> {
  const finite = (value: StaticScalar | undefined) =>
    keepNonFinite && value !== undefined ? { value } : finiteScalar(value);
  expression = unwrapParentheses(expression);
  switch (expression.kind) {
    case "stringLiteral": {
      const parts: string[] = [];
      for (const part of expression.parts) {
        if (part.kind === "stringText") {
          parts.push(part.value);
          continue;
        }
        const known = yield* compileChild(staticScalarTask(part.expression, keepNonFinite));
        if (known === undefined) return undefined;
        parts.push(scalarText(known.value));
      }
      return { value: parts.join("") };
    }
    case "numberLiteral":
      return finite(expression.value);
    case "booleanLiteral":
      return { value: expression.value };
    case "nullLiteral":
      return { value: null };
    case "durationLiteral":
      return finite({ kind: "duration", milliseconds: durationLiteralMilliseconds(expression) });
    case "unaryExpression": {
      if (expression.operator !== "+" && expression.operator !== "-") return undefined;
      const known = yield* compileChild(staticScalarTask(expression.operand, keepNonFinite));
      const value = known?.value;
      if (typeof value === "number") return { value: expression.operator === "+" ? value : -value };
      if (!isStaticDuration(value)) return undefined;
      return expression.operator === "+"
        ? { value }
        : { value: { kind: "duration", milliseconds: 0 - value.milliseconds } };
    }
    case "binaryExpression": {
      const left = yield* compileChild(staticScalarTask(expression.left, keepNonFinite));
      if (left === undefined) return undefined;
      const right = yield* compileChild(staticScalarTask(expression.right, keepNonFinite));
      if (right === undefined) return undefined;
      // The runtime rejects a non-finite step, so later arithmetic cannot make the result valid again.
      if (keepNonFinite && finiteScalar(left.value) === undefined) return left;
      if (keepNonFinite && finiteScalar(right.value) === undefined) return right;
      return finite(arithmetic(expression.operator, left.value, right.value));
    }
    default:
      return undefined;
  }
}

/** Number and duration arithmetic as the runtime performs it; `undefined` for other operands or a zero divisor. */
function arithmetic(
  operator: string,
  left: StaticScalar,
  right: StaticScalar,
): StaticScalar | undefined {
  if (typeof left === "number" && typeof right === "number") {
    switch (operator) {
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return left * right;
      case "/":
        return right === 0 ? undefined : left / right;
      case "%":
        return right === 0 ? undefined : left % right;
      default:
        return undefined;
    }
  }
  const duration = (milliseconds: number) => ({ kind: "duration" as const, milliseconds });
  if (isStaticDuration(left) && isStaticDuration(right)) {
    if (operator === "+") return duration(left.milliseconds + right.milliseconds);
    if (operator === "-") return duration(left.milliseconds - right.milliseconds);
    if (operator === "/") return left.milliseconds / right.milliseconds;
    return undefined;
  }
  if (isStaticDuration(left) && typeof right === "number") {
    if (operator === "*") return duration(left.milliseconds * right);
    if (operator === "/") return duration(left.milliseconds / right);
    return undefined;
  }
  if (typeof left === "number" && isStaticDuration(right) && operator === "*")
    return duration(left * right.milliseconds);
  return undefined;
}

function isStaticDuration(
  value: StaticScalar | undefined,
): value is { readonly kind: "duration"; readonly milliseconds: number } {
  return typeof value === "object" && value !== null;
}

function finiteScalar(
  value: StaticScalar | undefined,
): { readonly value: StaticScalar } | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? { value } : undefined;
  if (isStaticDuration(value)) return Number.isFinite(value.milliseconds) ? { value } : undefined;
  return { value };
}

/** A choice option value known at compile time, with `-0` as `0` like a runtime choice value. */
export function staticChoiceValue(
  expression: Expression,
): { readonly value: StaticScalar } | undefined {
  const known = staticScalar(expression);
  return known !== undefined && typeof known.value === "number" && Object.is(known.value, -0)
    ? { value: 0 }
    : known;
}
