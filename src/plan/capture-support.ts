import {
  captureExternalData,
  type ExternalDataFailureKind,
} from "../external-data-capture.js";
import type { PlanValidationError, PlanValidationResult } from "./validation.js";

export interface CapturedPlanData {
  readonly value: unknown;
}

export interface PlanCaptureFailure {
  readonly message: string;
  readonly path: string;
}

export function capturePlanData(value: unknown): CapturedPlanData | PlanCaptureFailure {
  const capture = captureExternalData(value);
  if (!capture.ok) {
    return Object.freeze({
      message: planExternalDataFailureMessage(capture.failure.kind),
      path: capture.failure.path,
    });
  }
  return Object.freeze({ value: capture.value });
}

export function isPlanCaptureFailure(
  value: CapturedPlanData | PlanCaptureFailure,
): value is PlanCaptureFailure {
  return "message" in value;
}

export function captureFailureValidation(
  message: string,
  path: string,
): PlanValidationResult {
  const error: PlanValidationError = Object.freeze({
    code: "TSC002",
    message,
    path,
  });
  return Object.freeze({ valid: false, errors: Object.freeze([error]) });
}

function planExternalDataFailureMessage(kind: ExternalDataFailureKind): string {
  switch (kind) {
    case "nonFiniteNumber":
      return "Plan contains a non-finite number.";
    case "nonJsonSafeValue":
      return "Plan contains a non-JSON-safe value.";
    case "cycle":
      return "Plan contains a cycle.";
    case "nonPlainObject":
      return "Plan contains a non-plain object.";
  }
}
