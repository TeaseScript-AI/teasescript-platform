import type { ScalarTypeName } from "../ast.js";
import {
  ANGLE_TYPE,
  CALENDAR_DURATION_TYPE,
  DURATION_TYPE,
  INTEGER_TYPE,
  NUMBER_TYPE,
  resolved,
  scalar,
  STRING_TYPE,
  withOrigins,
  type StaticType,
} from "../static-types.js";
import { joinTypes } from "./join.js";
import { mergedOrigins } from "./origins.js";
import { copyType } from "./places.js";

/**
 * The result type of arithmetic on known operand types, or `undefined` when the operator does not support them. Integer
 * arithmetic stays integer except `/`, which always gives a number (ADR 0021 rule 2.2). A duration is added to a date
 * or time value after it, not before it. `+` also joins two texts, and two lists into a new list whose element types
 * join as in a list literal of both; lists that would mix types give `undefined` (V30 §4).
 */
export function arithmeticType(
  operator: string,
  leftType: StaticType,
  rightType: StaticType,
): StaticType | undefined {
  const left = resolved(leftType);
  const right = resolved(rightType);
  if (operator === "+" && left.kind === "list" && right.kind === "list") {
    const element = joinTypes([copyType(left.element), copyType(right.element)]);
    return element === undefined ? undefined : { kind: "list", element };
  }
  if (left.kind !== "scalar" || right.kind !== "scalar") return undefined;
  if (left.name === "string" && right.name === "string")
    return operator === "+" ? STRING_TYPE : undefined;
  const numeric = (name: ScalarTypeName): boolean => name === "integer" || name === "number";
  if (numeric(left.name) && numeric(right.name)) {
    // The result derives from what both operands derive from.
    return withOrigins(
      left.name === "integer" && right.name === "integer" && operator !== "/"
        ? INTEGER_TYPE
        : NUMBER_TYPE,
      mergedOrigins(left.origins, right.origins),
    );
  }
  // A calendar duration stays one in every sum with a duration (ADR 0026); only two of one kind have a ratio.
  const duration = (name: ScalarTypeName): boolean =>
    name === "duration" || name === "calendarDuration";
  if (duration(left.name) && duration(right.name)) {
    if (operator === "+" || operator === "-")
      return left.name === "duration" && right.name === "duration"
        ? DURATION_TYPE
        : CALENDAR_DURATION_TYPE;
    if (operator === "/" && left.name === right.name) return NUMBER_TYPE;
    return undefined;
  }
  if (duration(left.name) && numeric(right.name) && (operator === "*" || operator === "/"))
    return scalar(left.name);
  if (numeric(left.name) && duration(right.name) && operator === "*") return scalar(right.name);
  // Two angles add, subtract, and divide into a number; an angle multiplies or divides by a number (V30 §13).
  if (left.name === "angle" && right.name === "angle") {
    if (operator === "+" || operator === "-") return ANGLE_TYPE;
    return operator === "/" ? NUMBER_TYPE : undefined;
  }
  if (left.name === "angle" && numeric(right.name) && (operator === "*" || operator === "/"))
    return ANGLE_TYPE;
  if (numeric(left.name) && right.name === "angle" && operator === "*") return ANGLE_TYPE;
  // No operator reads a zone (ADR 0026): an absolute date and time moves by a duration, and a date or a date and time
  // by a calendar duration. Two dates differ by a calendar duration, two absolute dates and times by a duration.
  if (operator === "+" || operator === "-") {
    if (left.name === "absoluteDateTime" && right.name === "duration") return scalar(left.name);
    if ((left.name === "date" || left.name === "datetime") && right.name === "calendarDuration")
      return scalar(left.name);
  }
  if (operator === "-" && left.name === "date" && right.name === "date")
    return CALENDAR_DURATION_TYPE;
  if (operator === "-" && left.name === "absoluteDateTime" && right.name === "absoluteDateTime")
    return DURATION_TYPE;
  return undefined;
}
