import { run, type RuntimeOperationResult } from "../../src/runtime/engine.js";
import { compileValidPlan } from "./compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./immediate-pacing-runtime.js";

export function runValidSource(source: string, seed?: number): RuntimeOperationResult {
  const plan = compileValidPlan(source);
  const snapshot =
    seed === undefined
      ? createImmediatePacingRuntimeSnapshot(plan)
      : createImmediatePacingRuntimeSnapshot(plan, { seed });
  return run(plan, snapshot);
}
