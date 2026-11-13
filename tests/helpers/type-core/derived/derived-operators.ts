// The operators in a run by the rules (`evaluate`, `type-core-derived-runs.ts`): `not`, `-` and `+` of one operand,
// and every binary operator but `otherwise`, over numbers, text, lists and booleans, each failure with the runtime's
// code at its site. An operand that is a duration, an angle or a date or time value is underivable.

import type { Expression } from "../../../../src/ast.js";
import { compareCodePoints } from "../../../../src/code-points.js";
import {
  isList,
  isAngle,
  isAnyDuration,
  isTemporal,
} from "../../../../src/runtime/values/value-predicates.js";
import {
  serializableEquals,
  type SerializableRuntimeValue,
} from "../../../../src/runtime/values/serializable-values.js";
import { Underivable, unwrap } from "./type-core-derived.js";

/** A value of the run and the host globals it came from. */
export interface OperandValue {
  readonly v: SerializableRuntimeValue;
  readonly from: ReadonlySet<string>;
}

/**
 * A check of the run at `start`..`end` (`evaluate`'s `fail`): it stops the run where the value does not fit, unless the
 * run goes on through every check.
 */
type Fail = (
  code: string,
  start: number,
  end: number,
  from: ReadonlySet<string>,
  fits: boolean,
) => void;

type Unary = Extract<Expression, { kind: "unaryExpression" }>;
type Binary = Extract<Expression, { kind: "binaryExpression" }>;

/** The value a failed operation leaves to a run that goes on (`evaluate`'s `through`): none. */
const failed = (from: ReadonlySet<string>): OperandValue => ({ v: null, from });

const joined = (...values: OperandValue[]): ReadonlySet<string> =>
  new Set(values.flatMap((value) => [...value.from]));

/** A check at an expression's site, as the engine places it: inside its parentheses. */
const at = (
  fail: Fail,
  code: string,
  expression: Expression,
  from: ReadonlySet<string>,
  fits: boolean,
): void =>
  fail(code, unwrap(expression).span.start.offset, unwrap(expression).span.end.offset, from, fits);

/** A duration, an angle or a date or time value: an operand whose arithmetic the oracle does not derive. */
function underived(value: SerializableRuntimeValue, operator: string): void {
  if (isAnyDuration(value) || isAngle(value) || isTemporal(value))
    throw new Underivable(`the operator ${operator} of a duration, an angle or a date or time`);
}

/** `not x`, `-x`, `+x`: TSR026 at an operand of `not` that is no boolean, TSR027 at one of `-` or `+` that is no number. */
export function unaryValue(
  expression: Unary,
  value: (expression: Expression) => OperandValue,
  fail: Fail,
): OperandValue {
  const operand = value(expression.operand);
  if (expression.operator === "not") {
    const fits = typeof operand.v === "boolean";
    at(fail, "TSR026", expression.operand, operand.from, fits);
    return fits ? { v: !operand.v, from: operand.from } : failed(operand.from);
  }
  underived(operand.v, expression.operator);
  const fits = typeof operand.v === "number";
  at(fail, "TSR027", expression.operand, operand.from, fits);
  if (!fits) return failed(operand.from);
  const number = Number(operand.v);
  return { v: expression.operator === "-" ? -number : number, from: operand.from };
}

/**
 * A binary operator but `otherwise`, its operands in source order. `and` and `or`: TSR026 at an operand that is no
 * boolean, the right one read only where the left does not decide. `==` and `!=`: equality of any two values. `+` of
 * text or a list on either side: two texts or two lists joined, else TSR009 at the operation. `<`, `<=`, `>`, `>=`: two
 * numbers or two texts (by code point), else TSR009 at the operation. Arithmetic: TSR027 at the left, then the right
 * operand that is no number, TSR036 at the operation where the result is not finite (a division by zero among them).
 */
export function binaryValue(
  expression: Binary,
  value: (expression: Expression) => OperandValue,
  fail: Fail,
): OperandValue {
  const left = value(expression.left);
  if (expression.operator === "and" || expression.operator === "or") {
    const leftFits = typeof left.v === "boolean";
    at(fail, "TSR026", expression.left, left.from, leftFits);
    if (!leftFits) return failed(left.from);
    if (left.v === (expression.operator === "or")) return left;
    const right = value(expression.right);
    const rightFits = typeof right.v === "boolean";
    at(fail, "TSR026", expression.right, right.from, rightFits);
    return rightFits ? { v: right.v, from: joined(left, right) } : failed(joined(left, right));
  }
  if (expression.operator === "otherwise") throw new Underivable("`otherwise` as an operator");
  const right = value(expression.right);
  const from = joined(left, right);
  const whole = (code: string, fits: boolean): void =>
    fail(code, expression.span.start.offset, expression.span.end.offset, from, fits);
  if (expression.operator === "==" || expression.operator === "!=") {
    const equal = serializableEquals(left.v, right.v);
    return { v: expression.operator === "==" ? equal : !equal, from };
  }
  underived(left.v, expression.operator);
  underived(right.v, expression.operator);
  if (
    expression.operator === "+" &&
    (typeof left.v === "string" || typeof right.v === "string" || isList(left.v) || isList(right.v))
  ) {
    if (typeof left.v === "string" && typeof right.v === "string") {
      whole("TSR009", true);
      return { v: left.v + right.v, from };
    }
    if (isList(left.v) && isList(right.v)) {
      whole("TSR009", true);
      return { v: { kind: "list", items: [...left.v.items, ...right.v.items] }, from };
    }
    whole("TSR009", false);
    return failed(from);
  }
  if (
    expression.operator === "<" ||
    expression.operator === "<=" ||
    expression.operator === ">" ||
    expression.operator === ">="
  ) {
    const order =
      typeof left.v === "number" && typeof right.v === "number"
        ? Math.sign(left.v - right.v)
        : typeof left.v === "string" && typeof right.v === "string"
          ? Math.sign(compareCodePoints(left.v, right.v))
          : null;
    whole("TSR009", order !== null);
    if (order === null) return failed(from);
    const holds =
      expression.operator === "<"
        ? order < 0
        : expression.operator === "<="
          ? order <= 0
          : expression.operator === ">"
            ? order > 0
            : order >= 0;
    return { v: holds, from };
  }
  const leftFits = typeof left.v === "number";
  at(fail, "TSR027", expression.left, left.from, leftFits);
  if (!leftFits) return failed(from);
  const rightFits = typeof right.v === "number";
  at(fail, "TSR027", expression.right, right.from, rightFits);
  if (!rightFits) return failed(from);
  const [a, b] = [Number(left.v), Number(right.v)];
  const result =
    expression.operator === "+"
      ? a + b
      : expression.operator === "-"
        ? a - b
        : expression.operator === "*"
          ? a * b
          : expression.operator === "/"
            ? a / b
            : a % b;
  whole("TSR036", Number.isFinite(result));
  return Number.isFinite(result) ? { v: result, from } : failed(from);
}
