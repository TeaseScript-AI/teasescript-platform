import type { AngleUnit } from "./ast.js";
import { radiansToDegrees } from "./deterministic-math.js";
import { ANGLE_UNIT_NAMES } from "./language-facts.js";

/** Resolves a short or long angle unit name: degrees or radians. */
export function angleUnit(name: string): AngleUnit | undefined {
  return ANGLE_UNIT_NAMES.get(name);
}

/**
 * An angle as a runtime value or plan stores it: its size in degrees, in which the engine's own trigonometry is exact,
 * so `sin(30 deg)` is `0.5` and `pi rad` is `180` degrees.
 */
export interface StoredAngle {
  readonly kind: "angle";
  readonly degrees: number;
}

/** Whether a record is an angle with a finite `degrees` and no other keys. */
export function isStoredAngleRecord(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).length === 2 &&
    value.kind === "angle" &&
    typeof value.degrees === "number" &&
    Number.isFinite(value.degrees)
  );
}

export function angleValue(degrees: number): StoredAngle {
  return { kind: "angle", degrees: degrees === 0 ? 0 : degrees };
}

/**
 * The size in degrees of `amount` in `unit`, rounded once, or `undefined` when it is beyond the largest number. `pi rad`
 * is exactly `180` degrees.
 */
export function angleDegrees(amount: number, unit: AngleUnit): number | undefined {
  return unit === "deg" ? amount : radiansToDegrees(amount);
}

/** Visible text for an angle: its degrees as a number shows, with a degree sign, such as `90°` or `57.29577951308232°`. */
export function formatAngle(angle: StoredAngle): string {
  return `${String(angle.degrees === 0 ? 0 : angle.degrees)}°`;
}

/**
 * Angle arithmetic (V30 §13): two angles add, subtract, or divide into a number, and an angle multiplies or divides by a
 * number. The result may not be finite, so the caller checks it; `undefined` for any other operator or operands.
 */
export function angleArithmetic(
  operator: string,
  left: number | StoredAngle,
  right: number | StoredAngle,
): number | StoredAngle | undefined {
  if (typeof left !== "number" && typeof right !== "number") {
    if (operator === "+") return angleValue(left.degrees + right.degrees);
    if (operator === "-") return angleValue(left.degrees - right.degrees);
    if (operator === "/") return left.degrees / right.degrees;
    return undefined;
  }
  if (typeof left !== "number" && typeof right === "number") {
    if (operator === "*") return angleValue(left.degrees * right);
    if (operator === "/") return angleValue(left.degrees / right);
    return undefined;
  }
  if (typeof left === "number" && typeof right !== "number" && operator === "*")
    return angleValue(left * right.degrees);
  return undefined;
}

/**
 * Why an angle has no property `name`: a unit name such as `degrees` gets the function that gives the angle's size in
 * that unit, as in `toDeg(heading)`.
 */
export function anglePropertyMessage(name: string, label = "value"): string {
  const unit = angleUnit(name);
  if (unit === undefined) return `An angle has no property '${name}'.`;
  return `An angle has no property '${name}'. Use '${unit === "deg" ? "toDeg" : "toRad"}(${label})' for its size in ${unit === "deg" ? "degrees" : "radians"}.`;
}

/**
 * Why a statistics function other than `sum` does not take angles: they wrap around at 360°, and circular statistics
 * are not chosen yet.
 */
export function angleStatisticMessage(name: string): string {
  return `${name} does not take angles: angles wrap around at 360°, so the average of 350° and 10° would not be 0°. Convert them first, as in 'toDeg(angle)', if a plain ${name} is what you want.`;
}

/** The order of two angles by size: -1, 0, or 1. */
export function compareAngles(left: StoredAngle, right: StoredAngle): number {
  return left.degrees < right.degrees ? -1 : left.degrees > right.degrees ? 1 : 0;
}

/** The route that works for an operator that cannot combine an angle with the other operand. */
export const ANGLE_ARITHMETIC_ROUTE =
  "Add or subtract two angles, or multiply or divide an angle by a number.";
