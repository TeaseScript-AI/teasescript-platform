import assert from "node:assert/strict";

import type { InstructionPlan } from "../../src/plan/model.js";
import { executeInstruction, type RuntimeOperationResult } from "../../src/runtime/engine.js";
import type { InterpreterEvent } from "../../src/runtime/events.js";
import type { RuntimeSnapshot } from "../../src/runtime/state.js";
import { compileValidPlan } from "./compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./immediate-pacing-runtime.js";

/**
 * Runs like `run`, but stops before the next `exit`, so a test can inspect the state the session ends with, such as
 * the pacing of its last message or the frames a script leaves behind, which `exit` clears.
 */
export function runUntilExit(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): RuntimeOperationResult {
  const events: InterpreterEvent[] = [];
  let current = snapshot;
  let instructionsExecuted = 0;
  while (
    (current.status === "ready" || current.status === "running") &&
    plan.instructions[current.nextInstruction]?.kind !== "exit"
  ) {
    const step = executeInstruction(plan, current);
    events.push(...step.events);
    current = step.snapshot;
    instructionsExecuted += step.instructionsExecuted;
  }
  return { snapshot: current, events, instructionsExecuted };
}

/** Like `runValidSource`, but stops before the script's exit, which it must reach without waiting or failing. */
export function runValidSourceUntilExit(source: string): RuntimeOperationResult {
  const plan = compileValidPlan(source);
  const result = runUntilExit(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(result.snapshot.status, "running", source);
  assert.equal(plan.instructions[result.snapshot.nextInstruction]?.kind, "exit", source);
  return result;
}
