import { run, type RuntimeOperationResult } from "../../src/runtime/engine.js";
import { compileValidPlan } from "./compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./immediate-pacing-runtime.js";

/** Compiles `source`, with no diagnostics but the warnings the test names (see `compileValidPlan`), and runs it. */
export function runValidSource(
  source: string,
  seed?: number,
  warnings: readonly string[] = [],
): RuntimeOperationResult {
  const plan = compileValidPlan(source, {}, warnings);
  const snapshot =
    seed === undefined
      ? createImmediatePacingRuntimeSnapshot(plan)
      : createImmediatePacingRuntimeSnapshot(plan, { seed });
  return run(plan, snapshot);
}
