import { instructionSourcePath } from "../../../plan/model.js";
import { failForBudgetAt, failSnapshot, instructionFailure } from "../../engine.js";
import { executionRunnable, processDueWork } from "../../operations/observe-time.js";
import type { NativeStep } from "../prepare/instructions.js";
import type { NativeMachine } from "./machine.js";

/**
 * Runs the machine's plan from `snapshot.nextInstruction` as today's `run` and `stepToEvent` do: while execution can
 * run, within `budget` instructions per scene time, and under `untilEvent` until an instruction emits an event. A fault
 * of the script fails the session at its instruction; once execution waits or ends, due work settles toward the
 * observed time, which may let it run again. Gives the number of instructions executed.
 */
export function runNative(
  machine: NativeMachine,
  steps: readonly NativeStep[],
  budget: number,
  untilEvent: boolean,
): number {
  const plan = machine.plan;
  const snapshot = machine.snapshot;
  let executed = 0;
  let counted = 0;
  let budgetTimeMs = snapshot.currentSessionTimeMs;
  while (executionRunnable(snapshot) && !(untilEvent && machine.events.length > 0)) {
    if (snapshot.currentSessionTimeMs > budgetTimeMs) {
      budgetTimeMs = snapshot.currentSessionTimeMs;
      counted = 0;
    }
    if (counted >= budget) {
      const loop = snapshot.status === "running" ? machine.current.loops.at(-1) : undefined;
      failForBudgetAt(plan, snapshot, machine.events, budget, loop?.loopId ?? null);
      break;
    }
    snapshot.status = "running";
    machine.pc = snapshot.nextInstruction;
    let pc = machine.pc;
    let failed = false;
    try {
      for (;;) {
        pc = machine.pc;
        executed += 1;
        counted += 1;
        steps[pc]!(machine);
        if (machine.stop || counted >= budget || (untilEvent && machine.events.length > 0)) break;
      }
      snapshot.nextInstruction = machine.pc;
    } catch (error) {
      const failure = instructionFailure(error, plan.instructions[pc]!.span);
      if (failure === null) throw error;
      snapshot.nextInstruction = pc;
      failed = true;
      failSnapshot(snapshot, failure.toInfo(), instructionSourcePath(plan, pc), machine.events);
    }
    machine.stop = false;
    if (
      !failed &&
      // Work due exactly at the observed time also settles once execution waits or ends.
      snapshot.currentSessionTimeMs <= snapshot.observedSessionTimeMs &&
      !executionRunnable(snapshot)
    )
      processDueWork(plan, snapshot, machine.events);
  }
  return executed;
}
