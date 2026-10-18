import type { RuntimeErrorCode } from "../../diagnostic-codes.js";
import { compareTemporal, temporalBinary } from "../values/temporal-operations.js";
import type { BinaryExpressionPlan, ExpressionPlan, InstructionPlan } from "../../plan/model.js";
import {
  ANGLE_ARITHMETIC_ROUTE,
  angleArithmetic,
  compareAngles,
  formatAngle,
  type StoredAngle,
} from "../../angle.js";
import { internalFault, RuntimeFault } from "../errors.js";
import { joinedValue } from "../values/pure-operations.js";
import { logicalOperandRule, notNumberFix, orderRule } from "../../operand-rules.js";
import { loweredOperand } from "./lowered-operands.js";
import {
  addDurations,
  compareDurations,
  divideDuration,
  durationFamily,
  durationParts,
  durationQuotient,
  formatDuration,
  isCalendar,
  scaleDuration,
  ZERO_DIVISOR,
  type AnyDuration,
} from "../../duration.js";
import {
  serializableEquals,
  type SerializableRuntimeValue,
} from "../values/serializable-values.js";
import {
  isAngle,
  isAnyDuration,
  isDict,
  isList,
  isRange,
  isSet,
  isTemporal,
} from "../values/value-predicates.js";
import { describeShownValue } from "../values/value-types.js";
import { numberFromText, withoutNegativeZero } from "../../conversions.js";
import {
  describeValue,
  orderedFamily,
  ordersWith,
  valueKindOf,
  type OrderedFamily,
} from "../../value-kinds.js";
import { type SourceSpan, fault, planLabel } from "./support.js";
import type { Evaluator } from "../evaluator.js";

// Binary operators: arithmetic, comparison, and duration operands.

export function binary(
  evaluator: Evaluator,
  expression: BinaryExpressionPlan,
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
): SerializableRuntimeValue {
  if (expression.operator === "and" || expression.operator === "or") {
    if (typeof right !== "boolean")
      throw notLogicalOperand(expression.operator, expression.right, right, evaluator.plan);
    return right;
  }
  if (expression.operator === "otherwise") return right;
  if (expression.operator === "==" || expression.operator === "!=") {
    const equal = serializableEquals(left, right);
    return expression.operator === "==" ? equal : !equal;
  }
  if (expression.operator === "in") {
    if (!isRange(right))
      throw fault(
        "TSR035",
        internalFault(
          `The plan applies 'in' to ${describeShownValue(right)}, but 'in' needs a range on its right side.`,
        ),
        expression.span,
      );
    return (
      typeof left === "number" &&
      left >= right.start &&
      (right.inclusive ? left <= right.end : left < right.end)
    );
  }
  if (
    expression.operator === "+" &&
    (typeof left === "string" || typeof right === "string" || isList(left) || isList(right))
  )
    return joinedValue(left, right, expression.span);
  if (["<", "<=", ">", ">="].includes(expression.operator))
    return ordered(expression, left, right, evaluator.plan);
  const temporal = temporalBinary(expression.operator, left, right, expression.span);
  if (temporal !== undefined) return temporal;
  if (isAngle(left) || isAngle(right)) return angleBinary(expression, left, right, evaluator.plan);
  if (isAnyDuration(left) || isAnyDuration(right))
    return durationBinary(evaluator, expression, left, right);
  const leftNumber = operandNumber(expression, "left", left, evaluator.plan);
  const rightNumber = operandNumber(expression, "right", right, evaluator.plan);
  let result: number;
  switch (expression.operator) {
    case "+":
      result = leftNumber + rightNumber;
      break;
    case "-":
      result = leftNumber - rightNumber;
      break;
    case "*":
      result = leftNumber * rightNumber;
      break;
    case "/":
      result = leftNumber / rightNumber;
      break;
    case "%":
      result = leftNumber % rightNumber;
      break;
    default:
      throw fault(
        "TSR035",
        internalFault(`The engine has no arithmetic for the operator '${expression.operator}'.`),
        expression.span,
      );
  }
  if (!Number.isFinite(result)) throw noArithmeticResult(expression, left, right, evaluator.plan);
  return result;
}

/**
 * Duration arithmetic (ADR 0026); mixing with plain numbers is explicit only. A calendar duration stays one, its months
 * and days stay whole, and calendar durations divide only within one family, never with an exact duration.
 */
function durationBinary(
  evaluator: Evaluator,
  expression: BinaryExpressionPlan,
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
): SerializableRuntimeValue {
  const span = expression.span;
  const operator = expression.operator;
  const result = (duration: AnyDuration | string): AnyDuration => {
    // An exact duration divided by zero has no result like a number; a calendar one keeps its parts' error code.
    if (duration === ZERO_DIVISOR)
      throw isAnyDuration(left) && isCalendar(left)
        ? noArithmeticResult(expression, left, right, evaluator.plan, "TSR009")
        : noArithmeticResult(expression, left, right, evaluator.plan);
    if (typeof duration === "string")
      throw fault("TSR009", `Operator '${operator}': ${duration}.`, span);
    // Calendar parts must stay whole numbers that a value can store, like the milliseconds' finite range.
    const parts = durationParts(duration);
    if (
      !Number.isSafeInteger(parts.months) ||
      !Number.isSafeInteger(parts.days) ||
      !Number.isFinite(parts.milliseconds)
    )
      throw noArithmeticResult(expression, left, right, evaluator.plan);
    return duration;
  };
  if (isAnyDuration(left) && isAnyDuration(right)) {
    switch (operator) {
      case "+":
        return result(addDurations(left, right));
      case "-":
        return result(addDurations(left, right, -1));
      case "/": {
        const ratio = durationQuotient(left, right);
        // An exact zero divisor has no result like a number's; a calendar one has no family to divide in.
        if (ratio === ZERO_DIVISOR)
          throw isCalendar(left)
            ? noArithmeticResult(expression, left, right, evaluator.plan, "TSR009")
            : noArithmeticResult(expression, left, right, evaluator.plan);
        if (typeof ratio === "string")
          throw fault(
            "TSR009",
            `${formatDuration(left)} cannot be divided by ${formatDuration(right)}: ${ratio}.`,
            span,
          );
        if (!Number.isFinite(ratio))
          throw noArithmeticResult(expression, left, right, evaluator.plan);
        return ratio;
      }
    }
  } else if (isAnyDuration(left) && typeof right === "number") {
    if (operator === "*") return result(scaleDuration(left, right));
    if (operator === "/") return result(divideDuration(left, right));
  } else if (typeof left === "number" && isAnyDuration(right) && operator === "*") {
    return result(scaleDuration(right, left));
  }
  throw fault(
    "TSR009",
    `'${operator}' cannot combine ${kindAndValue(left)} and ${kindAndValue(right)}. Add or subtract two durations, or multiply or divide a duration by a number.`,
    span,
  );
}

/**
 * How the source spells an arithmetic operand: a variable, a property path, or a number, or `null` for anything else. An
 * operand that the lowering kept in a temporary is spelled as written.
 */
export function operandLabel(plan: ExpressionPlan, program: InstructionPlan): string | null {
  let current = loweredOperand(program, plan);
  while (current.kind === "group") current = current.expression;
  if (current.kind === "literal")
    return typeof current.value === "number" ? String(current.value) : null;
  return planLabel(current, program);
}

/** How the source spells `left operator right`, when it spells both operands, or `null`. */
function binaryLabel(expression: BinaryExpressionPlan, program: InstructionPlan): string | null {
  const left = operandLabel(expression.left, program);
  const right = operandLabel(expression.right, program);
  return left === null || right === null ? null : `${left} ${expression.operator} ${right}`;
}

/** An operand of `expression` as a number, or `TSR027`, which names the operand where the source spells it. */
function operandNumber(
  expression: BinaryExpressionPlan,
  side: "left" | "right",
  value: SerializableRuntimeValue,
  program: InstructionPlan,
): number {
  if (typeof value === "number") return value;
  const label = binaryLabel(expression, program);
  throw notNumber(
    label === null ? `'${expression.operator}'` : `'${label}'`,
    operandLabel(expression[side], program),
    ` on its ${side} side`,
    value,
    expression[side].span,
  );
}

/** `TSR027`: `subject` needs a number for the operand the source spells `operand`, or else `place`, but got `value`. */
export function notNumber(
  subject: string,
  operand: string | null,
  place: string,
  value: SerializableRuntimeValue,
  span: SourceSpan,
): RuntimeFault {
  return fault(
    "TSR027",
    `${subject} needs a number${operand === null ? place : ` for '${operand}'`}, but received ${describeShownValue(value)}. ${notNumberFix(operand, notNumberKind(value))}`,
    span,
  );
}

/** What a value that is not a number is, for its fix (`notNumberFix`). */
export function notNumberKind(value: SerializableRuntimeValue): "null" | "numeric text" | "other" {
  return value === null
    ? "null"
    : typeof value === "string" && numberFromText(value) !== undefined
      ? "numeric text"
      : "other";
}

/**
 * `TSR026`: `rule`, such as "A condition must be true or false (boolean)", with the value `plan` gave instead and, where
 * the source spells it, the compiler's fix.
 */
export function notBoolean(
  rule: string,
  plan: ExpressionPlan,
  value: SerializableRuntimeValue,
  span: SourceSpan,
  program: InstructionPlan,
): RuntimeFault {
  const source = loweredOperand(program, plan);
  const label = source.kind === "literal" ? null : planLabel(source, program);
  let fix = "";
  if (value === null || typeof value === "number" || typeof value === "string")
    fix = ` Compare it instead${label === null ? "" : `, such as '${label} ${value === null ? "== true" : typeof value === "number" ? "> 0" : '!= ""'}'`}.`;
  else if (isList(value) || isSet(value) || isDict(value))
    fix = ` Check its length instead${label === null ? "" : `, such as '${label}.length > 0'`}.`;
  return fault(
    "TSR026",
    `${rule}, but ${label === null ? "this" : `'${label}'`} is ${describeShownValue(value)}.${fix}`,
    span,
  );
}

/**
 * `TSR026` for an operand of `operator` that is not true or false. The lazy `and` and `or` and the lowered ones, which
 * keep their operands in a temporary, all report it here.
 */
export function notLogicalOperand(
  operator: "and" | "or" | null,
  plan: ExpressionPlan,
  value: SerializableRuntimeValue,
  program: InstructionPlan,
): RuntimeFault {
  return notBoolean(logicalOperandRule(operator), plan, value, plan.span, program);
}

/**
 * Why an arithmetic step has no finite result: a division or remainder by zero, or a number or duration too large. It
 * names the operands as the source spells them, where the plan still does, and shows their values.
 */
function noArithmeticResult(
  expression: BinaryExpressionPlan,
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
  program: InstructionPlan,
  code: RuntimeErrorCode = "TSR036",
): RuntimeFault {
  const { operator } = expression;
  const label = binaryLabel(expression, program);
  const values = `${operandText(left)} ${operator} ${operandText(right)}`;
  const subject = label === null ? values : `'${label}'`;
  if ((operator === "/" || operator === "%") && isZero(right)) {
    const divisor = operandLabel(expression.right, program);
    const zero = operandText(right);
    const cause = divisor === null ? "" : ` because '${divisor}' is ${zero}`;
    return fault(
      code,
      `${operator === "/" ? "Division" : "Remainder"} by zero: ${subject} has no result${cause}. Check that ${divisor === null ? "the divisor" : `'${divisor}'`} is not ${zero} first.`,
      expression.span,
    );
  }
  // A duration or an angle divided by one of its kind is a number, and any other step with one gives one of its kind.
  const what =
    operator === "/" &&
    ((isAnyDuration(left) && isAnyDuration(right)) || (isAngle(left) && isAngle(right)))
      ? "a number too large"
      : isAnyDuration(left) || isAnyDuration(right)
        ? "a duration too long"
        : isAngle(left) || isAngle(right)
          ? "an angle too large"
          : "a number too large";
  return fault(
    code,
    `${label === null ? values : `${subject} is ${values}, which`} gives ${what} to represent. Use smaller values.`,
    expression.span,
  );
}

/**
 * An operand's kind, with the value of a duration or an angle, such as `a duration (1 s)`, or a number as `the number 5`.
 */
function kindAndValue(value: SerializableRuntimeValue): string {
  if (typeof value === "number") return `the number ${operandText(value)}`;
  return isAnyDuration(value) || isAngle(value)
    ? `${describeValue(value)} (${operandText(value)})`
    : describeValue(value);
}

/** A number, duration, or angle operand as a message shows it. */
export function operandText(value: SerializableRuntimeValue): string {
  if (typeof value === "number") return String(withoutNegativeZero(value));
  if (isAngle(value)) return formatAngle(value);
  return isAnyDuration(value) ? formatDuration(value) : describeValue(value);
}

function isZero(value: SerializableRuntimeValue): boolean {
  return (
    value === 0 ||
    (isAnyDuration(value) && durationFamily(durationParts(value)) === "zero") ||
    (isAngle(value) && value.degrees === 0)
  );
}

/**
 * Angle arithmetic (V30 §13): angles add and subtract, divide into a number, and multiply or divide by a number. Any
 * other operand or operator is an error that names what works.
 */
function angleBinary(
  expression: BinaryExpressionPlan,
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
  program: InstructionPlan,
): SerializableRuntimeValue {
  const operator = expression.operator;
  const operand = (value: SerializableRuntimeValue): number | StoredAngle | undefined =>
    typeof value === "number" || isAngle(value) ? value : undefined;
  const a = operand(left);
  const b = operand(right);
  const result = a === undefined || b === undefined ? undefined : angleArithmetic(operator, a, b);
  if (result !== undefined) {
    if (!Number.isFinite(typeof result === "number" ? result : result.degrees))
      throw noArithmeticResult(expression, left, right, program);
    return result;
  }
  throw fault(
    "TSR009",
    `'${operator}' cannot combine ${kindAndValue(left)} and ${kindAndValue(right)}. ${ANGLE_ARITHMETIC_ROUTE}`,
    expression.span,
  );
}

/**
 * `<`, `<=`, `>`, or `>=` (V30 §5): two values of one family that orders (`ordersWith`), numbers and texts as JavaScript
 * orders them, and durations, angles, and date and time values by their own order. Any other pair fails with `TSR009`.
 */
function ordered(
  expression: BinaryExpressionPlan,
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
  program: InstructionPlan,
): boolean {
  const kind = valueKindOf(left);
  const family = orderedFamily(kind);
  if (family === undefined || !ordersWith(kind, valueKindOf(right)))
    throw unordered(expression, left, right, program);
  const order = orderWithin(family, left, right, expression.span);
  switch (expression.operator) {
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    default:
      return order >= 0;
  }
}

/**
 * The order of two values of the ordered `family`: -1, 0, or 1. Two calendar durations of different families, such as
 * months and days, have none (`TSR009`).
 */
function orderWithin(
  family: OrderedFamily,
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
  span: SourceSpan,
): number {
  switch (family) {
    case "number":
      if (typeof left === "number" && typeof right === "number")
        return left < right ? -1 : left > right ? 1 : 0;
      break;
    case "string":
      if (typeof left === "string" && typeof right === "string")
        return left < right ? -1 : left > right ? 1 : 0;
      break;
    case "duration":
    case "calendarDuration":
      if (isAnyDuration(left) && isAnyDuration(right)) {
        const order = compareDurations(left, right);
        if (typeof order === "number") return order;
        throw fault(
          "TSR009",
          `${formatDuration(left)} and ${formatDuration(right)} cannot be compared: ${order}.`,
          span,
        );
      }
      break;
    case "angle":
      if (isAngle(left) && isAngle(right)) return compareAngles(left, right);
      break;
    case "date":
    case "time":
    case "datetime":
    case "absoluteDateTime":
      if (isTemporal(left) && isTemporal(right)) return compareTemporal(left, right);
      break;
    default: {
      const unhandled: never = family;
      throw new Error(`The values of '${String(unhandled)}' have no order.`);
    }
  }
  throw new Error(`Only two values of the family '${family}' are ordered.`);
}

/**
 * `TSR009` for `<`, `<=`, `>`, or `>=` with values of different families or of a family without order: the rule of the
 * operands' family, a date or time value's first, then an angle's, then a duration's.
 */
function unordered(
  expression: BinaryExpressionPlan,
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
  program: InstructionPlan,
): RuntimeFault {
  const operator = expression.operator;
  if (isTemporal(left) || isTemporal(right))
    return fault(
      "TSR009",
      `'${operator}' orders two values of the same kind, such as two dates or two absolute dates and times, but these are ${describeValue(left)} and ${describeValue(right)}.`,
      expression.span,
    );
  if (isAngle(left) || isAngle(right))
    return fault(
      "TSR009",
      `'${operator}' cannot compare ${kindAndValue(left)} with ${kindAndValue(right)}. Use an angle on both sides.`,
      expression.span,
    );
  // An exact and a calendar duration never have an order, so their comparison gives the reason.
  if (isAnyDuration(left) && isAnyDuration(right)) {
    const order = compareDurations(left, right);
    if (typeof order === "string")
      return fault(
        "TSR009",
        `${formatDuration(left)} and ${formatDuration(right)} cannot be compared: ${order}.`,
        expression.span,
      );
  }
  if (isAnyDuration(left) || isAnyDuration(right))
    return fault(
      "TSR009",
      `'${operator}' cannot compare ${kindAndValue(left)} with ${kindAndValue(right)}. Use a duration on both sides.`,
      expression.span,
    );
  return notComparable(expression, left, right, program);
}

/**
 * `TSR009`: `<`, `<=`, `>`, or `>=` with operands of no family that orders (`orderRule`), with the values and, for null
 * or numeric text, the fix.
 */
function notComparable(
  expression: BinaryExpressionPlan,
  left: SerializableRuntimeValue,
  right: SerializableRuntimeValue,
  program: InstructionPlan,
): RuntimeFault {
  let fix = "";
  if (left === null || right === null) {
    const label = planLabel(left === null ? expression.left : expression.right, program);
    fix = ` Check that ${label === null ? "the value" : `'${label}'`} is not null first.`;
  } else if (
    (typeof left === "number" &&
      typeof right === "string" &&
      numberFromText(right) !== undefined) ||
    (typeof right === "number" && typeof left === "string" && numberFromText(left) !== undefined)
  )
    fix = " Convert the text with toNumber(...) first.";
  return fault(
    "TSR009",
    `${orderRule(expression.operator)}, but these are ${describeShownValue(left)} and ${describeShownValue(right)}.${fix}`,
    expression.span,
  );
}
