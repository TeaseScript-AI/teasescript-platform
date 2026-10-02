import type { InstructionPlan } from "../../plan/model.js";
import type { InterpreterEvent } from "../events.js";
import type { RuntimeCallFrameSnapshot, RuntimeSnapshot } from "../state.js";
import { processDueWork } from "./observe-time.js";
import { timerHandlerDispatchable } from "./timer-lifecycle.js";

export { timerHandlerDispatchable };
import { settleBackgroundPacingGate } from "./pacing-gate.js";
import { assertCounterCanAdvance, copySpan } from "./support.js";

/**
 * Starts the next queued expiry block as an interrupt frame. The block sees top-level names and its own locals;
 * the interrupted foreground action becomes inert inside the frame. Emits no event and runs no instruction; due work that became due meanwhile stays unsettled until the block
 * returns or a later observation arrives while it waits.
 */
export function startTimerHandler(plan: InstructionPlan, snapshot: RuntimeSnapshot): void {
  const invocation = snapshot.pendingTimerHandlers[0]!;
  const definition = plan.functions[invocation.handlerFunctionId - 1];
  if (definition === undefined || definition.handler === null) {
    throw new Error("Queued timer expiry block does not refer to a handler region.");
  }
  assertCounterCanAdvance(snapshot.nextCallFrameId, "nextCallFrameId");
  assertCounterCanAdvance(snapshot.nextScopeId, "nextScopeId");
  if (invocation.count > 1) invocation.count -= 1;
  else snapshot.pendingTimerHandlers.shift();
  const suspendedAction = snapshot.foregroundAction;
  if (
    suspendedAction !== null &&
    (suspendedAction.kind === "chatPacingGate" || suspendedAction.kind === "storageWrite")
  ) {
    throw new Error("Only a foreground delay, interaction, or media wait can be interrupted.");
  }
  const frame: RuntimeCallFrameSnapshot = {
    id: snapshot.nextCallFrameId,
    functionId: definition.id,
    functionName: definition.name,
    callSiteSpan: copySpan(definition.declarationSpan),
    returnInstruction: snapshot.nextInstruction,
    destinationTemporary: null,
    timerInterruption:
      "mediaId" in invocation
        ? { mediaId: invocation.mediaId, dueAtMs: invocation.dueAtMs, suspendedAction }
        : { timerId: invocation.timerId, dueAtMs: invocation.dueAtMs, suspendedAction },
    callerTemporaries: snapshot.temporaries.map((temporary) => ({ ...temporary })),
    scopeBaseDepth: snapshot.frames.length,
    loopBaseDepth: snapshot.loopFrames.length,
    arguments: [],
    parameterState: { phase: "supplied", parameterIndex: 0 },
  };
  snapshot.nextCallFrameId += 1;
  snapshot.callFrames.push(frame);
  snapshot.temporaries.length = 0;
  // A media block of `let NAME = play... async` sees its own handle as a local.
  snapshot.frames.push({
    id: snapshot.nextScopeId,
    bindings:
      definition.selfHandle !== null && "mediaId" in invocation
        ? [
            {
              name: definition.selfHandle,
              value: { kind: "mediaHandle", mediaId: invocation.mediaId },
            },
          ]
        : [],
  });
  snapshot.nextScopeId += 1;
  snapshot.foregroundAction = null;
  snapshot.status = "running";
  snapshot.nextInstruction = definition.entryInstruction;
}

/**
 * A normal return from an expiry block resumes the interrupted path. A still-pending interaction or delay becomes the
 * foreground action again with its original identity; a background pacing gate created by the block is consumed
 * before an interaction, as when an interaction is first requested. A delay settled meanwhile continues at its
 * continuation, which the frame already records.
 */
export function returnFromTimerHandler(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  frame: RuntimeCallFrameSnapshot,
  events: InterpreterEvent[],
): void {
  snapshot.frames.splice(frame.scopeBaseDepth);
  snapshot.loopFrames.splice(frame.loopBaseDepth);
  snapshot.callFrames.pop();
  // Copied one by one: a wide caller state must not depend on the host's argument-spread limit.
  snapshot.temporaries.length = 0;
  for (const temporary of frame.callerTemporaries) snapshot.temporaries.push({ ...temporary });
  snapshot.nextInstruction = frame.returnInstruction;
  restoreSuspendedAction(plan, snapshot, frame, events);
  // Due work that waited behind this block continues in scene-time order, including a restored overdue delay.
  processDueWork(plan, snapshot, events);
}

function restoreSuspendedAction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  frame: RuntimeCallFrameSnapshot,
  events: InterpreterEvent[],
): void {
  const suspended = frame.timerInterruption!.suspendedAction;
  if (suspended === null) return;
  if (suspended.kind === "interaction") {
    const gate = snapshot.backgroundActions.find((action) => action.kind === "chatPacingGate");
    if (gate?.kind === "chatPacingGate") {
      settleBackgroundPacingGate(plan, snapshot, gate, "consumedByForegroundInteraction", events);
    }
  }
  snapshot.foregroundAction = suspended;
  snapshot.status = "waiting";
}
