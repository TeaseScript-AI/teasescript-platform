import type { BinaryExpressionPlan, UnaryExpressionPlan } from "../../../plan/model.js";
import type { EvaluationContext } from "../../evaluator.js";
import {
  binary,
  notBoolean,
  notNumber,
  numberBinary,
  operandLabel,
} from "../../evaluation/operators.js";
import { angleValue } from "../../../angle.js";
import { negateDuration } from "../../../duration.js";
import { joinedValue } from "../../values/pure-operations.js";
import { isAngle, isAnyDuration } from "../../values/value-predicates.js";
import { fromCanonical, toCanonical } from "../values/codec.js";
import { nativeEquals } from "../values/equality.js";
import { isNativeComposite, type NativeValue } from "../values/native-value.js";

/**
 * A binary operator on native values, `and`, `or` and `otherwise` given their right operand once the left one did not
 * decide them: two numbers by `numberBinary`, `==` and `!=` by `nativeEquals`, and every other operand through
 * today's `binary`, which decides the operator's rules and faults (a list joined with `+` through its canonical form).
 */
export function nativeBinary(
  context: EvaluationContext,
  expression: BinaryExpressionPlan,
  left: NativeValue,
  right: NativeValue,
): NativeValue {
  const operator = expression.operator;
  if (typeof left === "number" && typeof right === "number") {
    const result = numberBinary(operator, left, right);
    if (result !== undefined) return result;
    return canonicalBinary(context, expression, left, right);
  }
  if (operator === "==" || operator === "!=") {
    const equal = nativeEquals(left, right);
    return operator === "==" ? equal : !equal;
  }
  if (operator === "+" && typeof left === "string" && typeof right === "string") {
    const joined = joinedValue(left, right, expression.span);
    if (typeof joined === "string") return joined;
  }
  return canonicalBinary(context, expression, left, right);
}

function canonicalBinary(
  context: EvaluationContext,
  expression: BinaryExpressionPlan,
  left: NativeValue,
  right: NativeValue,
): NativeValue {
  return fromCanonical(
    binary(
      context,
      expression,
      isNativeComposite(left) ? toCanonical(left) : left,
      isNativeComposite(right) ? toCanonical(right) : right,
    ),
  );
}

/** `not` on a boolean; `-` and `+` on a number, a duration or an angle; the faults of today's evaluator otherwise. */
export function nativeUnary(
  context: EvaluationContext,
  expression: UnaryExpressionPlan,
  operand: NativeValue,
): NativeValue {
  const shown = isNativeComposite(operand) ? toCanonical(operand) : operand;
  if (expression.operator === "not") {
    if (typeof operand !== "boolean")
      throw notBoolean(
        "'not' needs true or false (boolean)",
        expression.operand,
        shown,
        expression.operand.span,
        context.plan,
      );
    return !operand;
  }
  if (typeof operand === "number") return expression.operator === "-" ? -operand : operand;
  if (isAnyDuration(shown))
    return expression.operator === "+" ? shown : Object.freeze(negateDuration(shown));
  if (isAngle(shown))
    return expression.operator === "+" ? shown : Object.freeze(angleValue(-shown.degrees));
  const label = operandLabel(expression.operand, context.plan);
  throw notNumber(`'${expression.operator}${label ?? ""}'`, label, "", shown, expression.operand.span);
}
