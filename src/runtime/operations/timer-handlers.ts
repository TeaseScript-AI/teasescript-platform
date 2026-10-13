import type { RandomControl } from "../random-control.js";
import type { InstructionPlan } from "../../plan/model.js";
import { cloneCaptures, leaveScopes, sweepRetainedScopes } from "../captures.js";
import type { InterpreterEvent } from "../events.js";
import type {
  RuntimeCallFrameSnapshot,
  RuntimeInterruptibleActionSnapshot,
  RuntimeSnapshot,
} from "../state.js";
import { processDueWork } from "./observe-time.js";
import { reportBlockOverrun, timerHandlerDispatchable } from "./timer-lifecycle.js";

export { timerHandlerDispatchable };
import { assertCounterCanAdvance, copySpan } from "./support.js";
import type { TraceStore } from "../debug-trace.js";

/**
 * Starts the next queued expiry, cue, or button block as an interrupt frame. The block sees top-level names and its own
 * locals; the interrupted foreground action becomes inert inside the frame. Emits no event and runs no instruction; due
 * work that became due meanwhile stays unsettled until the block returns or a later observation arrives while it waits.
 */
export function startTimerHandler(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  trace: TraceStore | null = null,
): void {
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
    (suspendedAction.kind === "storageWrite" ||
      suspendedAction.kind === "capture" ||
      suspendedAction.kind === "fileStore")
  ) {
    throw new Error(
      "Only a foreground delay, interaction, reading time, or media wait can be interrupted.",
    );
  }
  const startedAtMs = snapshot.currentSessionTimeMs;
  const frame: RuntimeCallFrameSnapshot = {
    kind: "function",
    id: snapshot.nextCallFrameId,
    rootScopeId: invocation.rootScopeId,
    captures: cloneCaptures(invocation.captures),
    functionId: definition.id,
    functionName: definition.name,
    callSiteSpan: copySpan(definition.declarationSpan),
    returnInstruction: snapshot.nextInstruction,
    destinationTemporary: null,
    timerInterruption:
      "mediaId" in invocation
        ? { mediaId: invocation.mediaId, dueAtMs: invocation.dueAtMs, startedAtMs, suspendedAction }
        : "buttonId" in invocation
          ? {
              buttonId: invocation.buttonId,
              dueAtMs: invocation.dueAtMs,
              startedAtMs,
              suspendedAction,
            }
          : {
              timerId: invocation.timerId,
              dueAtMs: invocation.dueAtMs,
              startedAtMs,
              suspendedAction,
              // The expiry that queued this block began its timer's current round, unless another block held it back.
              currentRoundInBlock: invocation.dueAtMs === startedAtMs,
              endedRoundMs: null,
            },
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
    file: null,
    entry: null,
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
  if (trace !== null && definition.selfHandle !== null && "mediaId" in invocation) {
    trace.at(definition.entryInstruction, snapshot.currentSessionTimeMs);
    trace.writeBinding("declaration", snapshot.nextScopeId, definition.selfHandle, {
      kind: "mediaHandle",
      mediaId: invocation.mediaId,
    });
  }
  snapshot.nextScopeId += 1;
  snapshot.foregroundAction = null;
  snapshot.status = "running";
  snapshot.nextInstruction = definition.entryInstruction;
}

/**
 * A normal return from an expiry block resumes the interrupted path. A still-pending action becomes the foreground
 * action again with its original identity and the time it had left: it stood still while the block ran. A media wait
 * that ended meanwhile continues at its continuation, which the frame already records.
 */
export function returnFromTimerHandler(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  frame: RuntimeCallFrameSnapshot,
  events: InterpreterEvent[],
  trace: TraceStore | null,
  control: RandomControl | null,
): void {
  leaveScopes(snapshot, frame.scopeBaseDepth);
  snapshot.loopFrames.splice(frame.loopBaseDepth);
  snapshot.callFrames.pop();
  sweepRetainedScopes(snapshot, false);
  // Copied one by one: a wide caller state must not depend on the host's argument-spread limit.
  snapshot.temporaries.length = 0;
  for (const temporary of frame.callerTemporaries) snapshot.temporaries.push({ ...temporary });
  snapshot.nextInstruction = frame.returnInstruction;
  restoreSuspendedAction(snapshot, frame);
  reportBlockOverrun(plan, snapshot, frame.timerInterruption!, events);
  // Due work that waited behind this block continues in scene-time order, including a restored overdue delay.
  processDueWork(plan, snapshot, events, trace, control);
}

function restoreSuspendedAction(snapshot: RuntimeSnapshot, frame: RuntimeCallFrameSnapshot): void {
  const { suspendedAction: suspended, startedAtMs } = frame.timerInterruption!;
  if (suspended === null) return;
  snapshot.foregroundAction = resumedAction(suspended, snapshot.currentSessionTimeMs - startedAtMs);
  snapshot.status = "waiting";
}

/**
 * An interrupted action after a block that ran for `stoodStillMs`: its remaining time is what it had when the block
 * started (owner decision on #829, 2026-10-11). A media wait is not timed; it ends with its media.
 */
function resumedAction(
  action: RuntimeInterruptibleActionSnapshot,
  stoodStillMs: number,
): RuntimeInterruptibleActionSnapshot {
  if (stoodStillMs === 0 || action.kind === "mediaPlayback") return action;
  if (action.kind === "interaction")
    return Object.freeze({ ...action, pausedMs: (action.pausedMs ?? 0) + stoodStillMs });
  return Object.freeze({
    ...action,
    createdAtMs: action.createdAtMs + stoodStillMs,
    deadlineMs: action.deadlineMs + stoodStillMs,
  });
}
