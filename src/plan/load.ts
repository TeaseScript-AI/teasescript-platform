import { adoptParsedJson } from "../external-data-capture.js";
import { captureOrReuseInstructionPlan } from "./capture.js";
import type { InstructionPlan } from "./model.js";
import { markValidatedImmutableInstructionPlan } from "./validated-immutable.js";
import { validateCapturedInstructionPlan, type PlanValidationResult } from "./validation.js";

/**
 * A plan loaded from its JSON text: the validated plan, the complete validation of a value that is not one, or why the
 * text could not be read as JSON at all, which is no plan diagnostic.
 */
export type InstructionPlanLoad =
  | { readonly kind: "valid"; readonly plan: InstructionPlan }
  | { readonly kind: "invalid"; readonly validation: PlanValidationResult }
  | { readonly kind: "unreadable"; readonly message: string };

/**
 * Loads a plan from JSON text that the engine parses itself, so that no one else holds the parsed data: it is completely
 * validated as `validateInstructionPlan(JSON.parse(text))` would be, with the same result and diagnostics, but without
 * capture's copy. A valid plan is frozen and reused by runtime entry points as compiler output is.
 */
export function loadInstructionPlan(text: unknown): InstructionPlanLoad {
  if (typeof text !== "string") {
    return Object.freeze({
      kind: "unreadable",
      message: "Instruction plan text must be a string.",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      kind: "unreadable",
      message: `Instruction plan JSON is invalid: ${message}`,
    });
  }
  if (!adoptParsedJson(parsed, true)) {
    // Capture gives a number that is not finite its own diagnostic, before any other.
    const captured = captureOrReuseInstructionPlan(parsed);
    return Object.freeze({ kind: "invalid", validation: captured.validation });
  }
  const validation = validateCapturedInstructionPlan(parsed);
  if (!validation.valid) return Object.freeze({ kind: "invalid", validation });
  // EVIDENCE: validation: validateCapturedInstructionPlan accepted this frozen, engine-parsed plan above.
  const plan = markValidatedImmutableInstructionPlan(parsed as InstructionPlan);
  return Object.freeze({ kind: "valid", plan });
}
