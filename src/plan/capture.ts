import type { InstructionPlan } from "./model.js";
import { freezeInstructionPlan } from "./freeze.js";
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

export function captureInstructionPlan(value: unknown): CapturedInstructionPlanResult {
  const capture = capturePlanData(value);
  if (isPlanCaptureFailure(capture)) {
    return Object.freeze({
      validation: captureFailureValidation(capture.message, capture.path),
      plan: null,
    });
  }
  const validation = validateCapturedInstructionPlan(capture.value);
  return Object.freeze({
    validation,
    plan: validation.valid
      ? freezeInstructionPlan(capture.value as InstructionPlan)
      : null,
  });
}
