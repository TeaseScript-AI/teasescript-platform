/**
 * The lowering implementation remains cohesive during this mechanical move.
 * Its implementation is owned by the shared plan module until the next
 * compiler-focused change can extract the stateful class without duplication.
 */
export {
  compileProgram,
  InstructionCompilationError,
} from "../../plan/model.js";
export type {
  InstructionPlan,
} from "../../plan/model.js";
