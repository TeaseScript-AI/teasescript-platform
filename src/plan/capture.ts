import type { InstructionPlan } from "./model.js";
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

/** Validates stable engine-owned data and freezes it without another capture/copy. */
export function validateAndFreezeInstructionPlan(
  value: unknown,
): CapturedInstructionPlanResult {
  const validation = validateCapturedInstructionPlan(value);
  return Object.freeze({
    validation,
    plan: validation.valid ? freezeInstructionPlan(value as InstructionPlan) : null,
  });
}

function freezeInstructionPlan(plan: InstructionPlan): InstructionPlan {
  const work: Array<readonly [object, boolean]> = [[plan, false]];
  while (work.length > 0) {
    const [current, readyToFreeze] = work.pop()!;
    if (Object.isFrozen(current)) continue;
    if (readyToFreeze) {
      Object.freeze(current);
      continue;
    }
    work.push([current, true]);
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const nested = current[index];
        if (typeof nested === "object" && nested !== null && !Object.isFrozen(nested)) {
          work.push([nested, false]);
        }
      }
      continue;
    }
    for (const nested of Object.values(current as Record<string, unknown>)) {
      if (typeof nested === "object" && nested !== null && !Object.isFrozen(nested)) {
        work.push([nested, false]);
      }
    }
  }
  return plan;
}
