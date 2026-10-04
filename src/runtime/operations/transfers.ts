import type { EndInstruction, GotoInstruction } from "../../plan/model.js";
import { RuntimeFault } from "../errors.js";
import type { InterpreterEvent } from "../events.js";
import type { RuntimeSnapshot } from "../state.js";
import { assertEventSequenceCapacity, copySpan } from "./support.js";
import { stopTimerAction } from "./timer-lifecycle.js";

/**
 * `goto label`: leaves every function, expiry or media block, loop, and block of the file, so an action that a block
 * interrupted is abandoned rather than resumed. Non-persistent timers stop, with their queued blocks; persistent
 * timers and all media keep running (V30 §22, §27).
 */
export function executeGoto(
  instruction: GotoInstruction,
  snapshot: RuntimeSnapshot,
  events: InterpreterEvent[],
): void {
  removeNonPersistentTimers(snapshot, instruction, events);
  snapshot.callFrames.length = 0;
  snapshot.loopFrames.length = 0;
  snapshot.frames.splice(1);
  snapshot.temporaries.length = 0;
  snapshot.nextInstruction = instruction.target;
}

/** `end` returns to the file that called this one; no file has called it yet. */
export function executeEnd(instruction: EndInstruction): never {
  throw new RuntimeFault(
    "TSR066",
    "This file ended, but no file called it, so there is nothing to return to. Use exit where the session should finish.",
    copySpan(instruction.span),
  );
}

function removeNonPersistentTimers(
  snapshot: RuntimeSnapshot,
  instruction: GotoInstruction,
  events: InterpreterEvent[],
): void {
  const stopping = snapshot.backgroundActions.filter(
    (action) => action.kind === "timer" && !action.timer.persist,
  );
  assertEventSequenceCapacity(snapshot, stopping.length, instruction.span);
  for (const action of stopping) {
    if (action.kind === "timer") stopTimerAction(snapshot, action, instruction.span, events);
  }
  // A finished timer may still have queued blocks; they belong to the path the goto leaves.
  const persistent = new Set(
    snapshot.settledTimers.filter((timer) => timer.persist).map((timer) => timer.timerId),
  );
  for (const action of snapshot.backgroundActions) {
    if (action.kind === "timer") persistent.add(action.timer.timerId);
  }
  for (let index = snapshot.pendingTimerHandlers.length - 1; index >= 0; index -= 1) {
    const invocation = snapshot.pendingTimerHandlers[index]!;
    if ("timerId" in invocation && !persistent.has(invocation.timerId)) {
      snapshot.pendingTimerHandlers.splice(index, 1);
    }
  }
}
