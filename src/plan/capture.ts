import type { InstructionPlan } from "./model.js";
import {
  isValidatedImmutableInstructionPlan,
  markValidatedImmutableInstructionPlan,
} from "./validated-immutable.js";
import {
  captureFailureValidation,
  capturePlanData,
  isPlanCaptureFailure,
} from "./capture-support.js";
import { validateCapturedInstructionPlan, type PlanValidationResult } from "./validation.js";

export interface CapturedInstructionPlanResult {
  readonly validation: PlanValidationResult;
  readonly plan: InstructionPlan | null;
}

const validPlanValidation: PlanValidationResult = Object.freeze({
  valid: true,
  errors: Object.freeze([]),
});

export function captureInstructionPlan(value: unknown): CapturedInstructionPlanResult {
  const capture = capturePlanData(value, { freezeCapturedContainers: true });
  if (isPlanCaptureFailure(capture)) {
    return Object.freeze({
      validation: captureFailureValidation(capture.message, capture.path),
      plan: null,
    });
  }
  const validation = validateCapturedInstructionPlan(capture.value);
  // EVIDENCE: validation accepts the captured graph as an InstructionPlan before it is retained.
  const plan = validation.valid
    ? markValidatedImmutableInstructionPlan(capture.value as InstructionPlan)
    : null;
  return Object.freeze({
    validation,
    // EVIDENCE: validation: validateCapturedInstructionPlan checked this immutable captured graph above.
    plan,
  });
}

/** Reuses only an immutable plan graph previously accepted by complete validation. */
export function captureOrReuseInstructionPlan(value: unknown): CapturedInstructionPlanResult {
  if (typeof value === "object" && value !== null) {
    // EVIDENCE: identity membership, not this narrowing cast, determines whether the value is a validated plan.
    const candidate = value as InstructionPlan;
    if (!isValidatedImmutableInstructionPlan(candidate)) return captureInstructionPlan(value);
    // EVIDENCE: only a completely validated InstructionPlan can enter the private identity set.
    return Object.freeze({ validation: validPlanValidation, plan: candidate });
  }
  return captureInstructionPlan(value);
}
