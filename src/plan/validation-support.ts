export interface PlanValidationError {
  readonly code: "TSC001" | "TSC002";
  readonly message: string;
  readonly path: string;
}

const PLAN_LOCATION_KEYS = ["so", "sl", "sc", "eo", "el", "ec"] as const;

export function validateSpan(value: unknown, path: string, errors: PlanValidationError[]): void {
  if (!isRecord(value) || !hasExactKeys(value, PLAN_LOCATION_KEYS)) {
    errors.push(planError("TSC002", "Plan source location is malformed.", path));
    return;
  }
  if (!PLAN_LOCATION_KEYS.every((key) => nonNegativeSafeInteger(value[key]))) {
    errors.push(
      planError("TSC002", "Plan source location values must be non-negative safe integers.", path),
    );
    return;
  }
  // EVIDENCE: validation: every source-location field passed nonNegativeSafeInteger above.
  if ((value.eo as number) < (value.so as number)) {
    errors.push(planError("TSC002", "Plan source location ends before it starts.", path));
  }
}

export function requireString(value: unknown, path: string, errors: PlanValidationError[]): void {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(planError("TSC002", "Expected a non-empty string.", path));
  }
}

export function validInstructionBoundary(
  value: unknown,
  instructionCount: number,
): value is number {
  // EVIDENCE: validation: Number.isSafeInteger establishes the numeric target before the lower-bound comparison.
  // EVIDENCE: validation: Number.isSafeInteger establishes the numeric target before the upper-bound comparison.
  return (
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= instructionCount
  );
}

export function nonNegativeSafeInteger(value: unknown): value is number {
  // EVIDENCE: validation: Number.isSafeInteger establishes the numeric value before comparison.
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function positiveSafeInteger(value: unknown): value is number {
  // EVIDENCE: validation: Number.isSafeInteger establishes the numeric value before comparison.
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export function planError(
  code: PlanValidationError["code"],
  message: string,
  path: string,
): PlanValidationError {
  return Object.freeze({ code, message, path });
}
