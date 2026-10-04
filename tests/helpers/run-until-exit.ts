import type { InstructionPlan } from "../../src/plan/model.js";
import { executeInstruction, type RuntimeOperationResult } from "../../src/runtime/engine.js";
import type { InterpreterEvent } from "../../src/runtime/events.js";
import type { RuntimeSnapshot } from "../../src/runtime/state.js";

/**
 * Runs like `run`, but stops before the next `exit`, so a test can inspect the state the session ends with, such as
 * the pacing of its last message, which `exit` stops.
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
