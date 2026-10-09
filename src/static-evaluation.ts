import type { Expression, Program } from "./ast.js";
import { runCompileTask, compileChild, type CompileTask } from "./compiler/continuation.js";
import {
  addDurations,
  divideDuration,
  durationFamily,
  durationLiteralValue,
  durationParts,
  durationQuotient,
  formatDuration,
  negateDuration,
  scaleDuration,
  unitValue,
  type AnyDuration,
} from "./duration.js";
import type { SourceSpan } from "./source.js";
import { recordValidationTestWork } from "./validation-testing.js";

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
  // A step without a finite result is a visible overflow, reported once by `findVisibleOverflows`.
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return negate ? -value : value;
}

/** A scalar known at compile time: text, a finite number, a boolean, `null`, or an exact or calendar duration. */
export type StaticScalar = string | number | boolean | null | AnyDuration;

/**
 * The value of a literal, of interpolated text whose parts are known, or of number and duration arithmetic on known
 * operands, with the runtime's operations. Anything else is `undefined`.
 */
function staticScalar(expression: Expression): { readonly value: StaticScalar } | undefined {
  return runCompileTask(staticScalarTask(expression));
}

/**
 * A known finite number or duration, with the runtime's operations; anything else is `undefined`. A step that overflows
 * is reported by `findVisibleOverflows`, so callers check only the finite result.
 */
export function staticQuantity(expression: Expression): number | AnyDuration | undefined {
  const known = staticScalar(expression)?.value;
  return typeof known === "number" || isStaticDuration(known) ? known : undefined;
}

/** Scalar visible text, as the runtime converts the value. */
function scalarText(value: StaticScalar): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(Object.is(value, -0) ? 0 : value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  return formatDuration(value);
}

function* staticScalarTask(
  expression: Expression,
): CompileTask<{ readonly value: StaticScalar } | undefined> {
  recordValidationTestWork("staticFolds");
  expression = unwrapParentheses(expression);
  switch (expression.kind) {
    case "stringLiteral": {
      const parts: string[] = [];
      for (const part of expression.parts) {
        if (part.kind === "stringText") {
          parts.push(part.value);
          continue;
        }
        const known = yield* compileChild(staticScalarTask(part.expression));
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
    case "durationLiteral": {
      const value = durationLiteralValue(expression);
      return typeof value === "string" ? undefined : finite(value);
    }
    case "unitExpression": {
      const known = yield* compileChild(staticScalarTask(expression.operand));
      if (typeof known?.value !== "number") return undefined;
      const value = unitValue(known.value, expression);
      return typeof value === "string" ? undefined : finite(value);
    }
    case "unaryExpression": {
      if (expression.operator !== "+" && expression.operator !== "-") return undefined;
      const known = yield* compileChild(staticScalarTask(expression.operand));
      const value = known?.value;
      if (typeof value === "number") return { value: expression.operator === "+" ? value : -value };
      if (!isStaticDuration(value)) return undefined;
      return expression.operator === "+" ? { value } : { value: negateDuration(value) };
    }
    case "binaryExpression": {
      const left = yield* compileChild(staticScalarTask(expression.left));
      if (left === undefined) return undefined;
      const right = yield* compileChild(staticScalarTask(expression.right));
      if (right === undefined) return undefined;
      return finite(arithmetic(expression.operator, left.value, right.value));
    }
    default:
      return undefined;
  }
}

/**
 * Number and duration arithmetic as the runtime performs it, before its finite-result check, so an overflow or a zero
 * divisor gives a non-finite result; `undefined` for other operands.
 */
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
        return left / right;
      case "%":
        return left % right;
      default:
        return undefined;
    }
  }
  const known = (duration: AnyDuration | string) =>
    typeof duration === "string" ? undefined : duration;
  if (isStaticDuration(left) && isStaticDuration(right)) {
    if (operator === "+") return addDurations(left, right);
    if (operator === "-") return addDurations(left, right, -1);
    if (operator === "/") {
      const ratio = durationQuotient(left, right);
      return typeof ratio === "string" ? undefined : ratio;
    }
    return undefined;
  }
  if (isStaticDuration(left) && typeof right === "number") {
    if (operator === "*") return known(scaleDuration(left, right));
    if (operator === "/") return known(divideDuration(left, right));
    return undefined;
  }
  if (typeof left === "number" && isStaticDuration(right) && operator === "*")
    return known(scaleDuration(right, left));
  return undefined;
}

function isStaticDuration(value: StaticScalar | undefined): value is AnyDuration {
  return typeof value === "object" && value !== null;
}

function finite(value: StaticScalar | undefined): { readonly value: StaticScalar } | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? { value } : undefined;
  // Calendar parts stay whole numbers of days and months that a value can store.
  if (isStaticDuration(value)) {
    const parts = durationParts(value);
    return Number.isFinite(parts.milliseconds) &&
      Number.isSafeInteger(parts.months) &&
      Number.isSafeInteger(parts.days)
      ? { value }
      : undefined;
  }
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

/**
 * An arithmetic step the runtime always rejects: known operands with a non-finite result (`TSR036`), or a known zero
 * divisor, which fails for every dividend.
 */
export interface VisibleOverflow {
  readonly span: SourceSpan;
  /** `zero` for a division or remainder by zero, otherwise the kind of value that grew too large. */
  readonly cause: "zero" | "number" | "duration";
}

const ARITHMETIC_OPERATORS: ReadonlySet<string> = new Set(["+", "-", "*", "/", "%"]);

/**
 * Every arithmetic step in the program whose operands are known and finite but whose result is not, and every division
 * or remainder by a known zero, in source order.
 * Known values are computed once per expression from its operands, so the walk is linear in the program size; a
 * reported step is unknown to the steps around it, so one overflow is reported once.
 */
export function findVisibleOverflows(program: Program): readonly VisibleOverflow[] {
  const known = new Map<Expression, StaticScalar>();
  const found: VisibleOverflow[] = [];
  const work: { readonly node: unknown; readonly visited: boolean }[] = [
    { node: program, visited: false },
  ];
  while (work.length > 0) {
    const { node, visited } = work.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) work.push({ node: item, visited: false });
      continue;
    }
    if (!visited) {
      work.push({ node, visited: true });
      // Source spans hold no expressions.
      for (const [key, child] of Object.entries(node))
        if (key !== "span" && !key.endsWith("Span")) work.push({ node: child, visited: false });
      continue;
    }
    // EVIDENCE: invariant: the parser builds every AST object with a string `kind`; other kinds have no known value.
    const expression = node as Expression;
    // A known zero divisor fails for every dividend, so the dividend need not be known.
    if (dividesByKnownZero(expression, known)) {
      found.push({ span: expression.span, cause: "zero" });
      continue;
    }
    const value = knownValue(expression, known);
    if (value === undefined) continue;
    if (finite(value) !== undefined) known.set(expression, value);
    else
      found.push({ span: expression.span, cause: isStaticDuration(value) ? "duration" : "number" });
  }
  return found.sort((left, right) => left.span.start.offset - right.span.start.offset);
}

/**
 * The operands whose known values decide `expression`'s known value in `knownStep`: a grouping's or sign's operand, or
 * both operands of an arithmetic step. Other expressions have none.
 */
export function knownOperands(expression: Expression): readonly Expression[] {
  switch (expression.kind) {
    case "parenthesizedExpression":
      return [expression.expression];
    case "unaryExpression":
    case "unitExpression":
      return [expression.operand];
    case "binaryExpression":
      return ARITHMETIC_OPERATORS.has(expression.operator)
        ? [expression.left, expression.right]
        : [];
    default:
      return [];
  }
}

/**
 * The finite number or duration a literal, grouping, sign, or arithmetic step is known to have, from its operands'
 * known values, or `undefined`. Callers that keep each expression's result fold any expression in linear time.
 */
export function knownStep(
  expression: Expression,
  known: (operand: Expression) => StaticScalar | undefined,
): StaticScalar | undefined {
  recordValidationTestWork("staticFolds");
  const value = knownValue(expression, { get: known });
  return value === undefined ? undefined : finite(value)?.value;
}

/** The value of a literal, grouping, sign, or arithmetic step from its operands' known values, before any check. */
function knownValue(
  expression: Expression,
  known: { get(operand: Expression): StaticScalar | undefined },
): StaticScalar | undefined {
  switch (expression.kind) {
    case "numberLiteral":
      return Number.isFinite(expression.value) ? expression.value : undefined;
    case "durationLiteral": {
      const value = durationLiteralValue(expression);
      return typeof value === "string" || !Number.isFinite(value.milliseconds) ? undefined : value;
    }
    case "parenthesizedExpression":
      return known.get(expression.expression);
    case "unitExpression": {
      const value = known.get(expression.operand);
      if (typeof value !== "number") return undefined;
      // A duration too long to represent stays known, so that its overflow is reported.
      const duration = unitValue(value, expression);
      return typeof duration === "string" ? undefined : duration;
    }
    case "unaryExpression": {
      const value = known.get(expression.operand);
      if (expression.operator === "-" && typeof value === "number") return -value;
      if (expression.operator === "-" && isStaticDuration(value)) return negateDuration(value);
      return expression.operator === "+" ? value : undefined;
    }
    case "binaryExpression": {
      if (!ARITHMETIC_OPERATORS.has(expression.operator)) return undefined;
      const left = known.get(expression.left);
      const right = known.get(expression.right);
      return left === undefined || right === undefined
        ? undefined
        : arithmetic(expression.operator, left, right);
    }
    default:
      return undefined;
  }
}

/**
 * A division or remainder by a zero number or duration the compiler can see. The runtime rejects it for every dividend:
 * as a non-finite result where the operation is supported, and otherwise as an unsupported operation or a wrong kind.
 */
function dividesByKnownZero(
  expression: Expression,
  known: ReadonlyMap<Expression, StaticScalar>,
): boolean {
  if (expression.kind !== "binaryExpression") return false;
  if (expression.operator !== "/" && expression.operator !== "%") return false;
  const divisor = known.get(expression.right);
  return (
    divisor === 0 ||
    (isStaticDuration(divisor) && durationFamily(durationParts(divisor)) === "zero")
  );
}
