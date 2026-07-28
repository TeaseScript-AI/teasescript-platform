/** @deprecated Import plan contracts from ./plan/model.js, ./plan/capture.js, or ./plan/validation.js. */
export * from "./plan/model.js";
export {
  captureInstructionPlan,
  type CapturedInstructionPlanResult,
} from "./plan/capture.js";
export {
  validateInstructionPlan,
  validateCapturedInstructionPlan,
  type PlanValidationError,
  type PlanValidationResult,
} from "./plan/validation.js";
export {
  compileProgram,
  InstructionCompilationError,
} from "./compiler/compile-program.js";
