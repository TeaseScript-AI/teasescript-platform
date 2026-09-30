import type { InstructionPlan } from "../../plan/model.js";
import type { InterpreterEvent } from "../events.js";
import type { RuntimeCallFrameSnapshot, RuntimeSnapshot } from "../state.js";
import { settleForegroundTimedAction } from "./observe-time.js";
import { settleBackgroundPacingGate } from "./pacing-gate.js";
import { assertCounterCanAdvance, copySpan } from "./support.js";

/**
 * Whether a queued expiry block may interrupt now. Blocks never nest, and they wait for single-instruction commit
 * windows (a released prepared `say`, an interaction result handoff, or a settled terminal action) and for a
 * foreground pacing gate, whose prepared output owns the one Standard chat target.
 */
export function timerHandlerDispatchable(snapshot: RuntimeSnapshot): boolean {
  if (snapshot.pendingTimerHandlers.length === 0) return false;
  if (snapshot.status !== "ready" && snapshot.status !== "running" && snapshot.status !== "waiting")
    return false;
  if (snapshot.callFrames.some((frame) => frame.timerInterruption !== null)) return false;
  // The block needs its own frame; at the call-depth limit it waits until the path returns.
  if (snapshot.callFrames.length >= snapshot.maxCallDepth) return false;
  if (
    snapshot.preparedSayOutput !== null ||
    snapshot.interactionResultHandoff !== null ||
    snapshot.terminalContinuationHandoff !== null
  )
    return false;
  const foreground = snapshot.foregroundAction;
  return foreground === null || foreground.kind === "delay" || foreground.kind === "interaction";
}

/**
 * Starts the next queued expiry block as an interrupt frame. The block sees top-level names and its own locals;
 * the interrupted foreground action becomes inert inside the frame. Emits no event and runs no instruction.
 */
export function startTimerHandler(plan: InstructionPlan, snapshot: RuntimeSnapshot): void {
  const invocation = snapshot.pendingTimerHandlers[0]!;
  const definition = plan.functions[invocation.handlerFunctionId - 1];
  if (definition === undefined || !definition.timerHandler) {
    throw new Error("Queued timer expiry block does not refer to a handler region.");
  }
  assertCounterCanAdvance(snapshot.nextCallFrameId, "nextCallFrameId");
  assertCounterCanAdvance(snapshot.nextScopeId, "nextScopeId");
  if (invocation.count > 1) invocation.count -= 1;
  else snapshot.pendingTimerHandlers.shift();
  const suspendedAction = snapshot.foregroundAction;
  if (
    suspendedAction !== null &&
    suspendedAction.kind !== "delay" &&
    suspendedAction.kind !== "interaction"
  ) {
    throw new Error("Only a foreground delay or interaction can be interrupted.");
  }
  const frame: RuntimeCallFrameSnapshot = {
    id: snapshot.nextCallFrameId,
    functionId: definition.id,
    functionName: definition.name,
    callSiteSpan: copySpan(definition.declarationSpan),
    returnInstruction: snapshot.nextInstruction,
    destinationTemporary: null,
    timerInterruption: {
      timerId: invocation.timerId,
      dueAtMs: invocation.dueAtMs,
      suspendedAction,
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
  snapshot.frames.push({ id: snapshot.nextScopeId, bindings: [] });
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
  snapshot.temporaries.splice(
    0,
    snapshot.temporaries.length,
    ...frame.callerTemporaries.map((temporary) => ({ ...temporary })),
  );
  snapshot.nextInstruction = frame.returnInstruction;
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
  // A delay that was already due when interrupted and saw no observation during the block settles now, unless
  // another earlier-due block is queued: that block interrupts it again first.
  if (
    suspended.kind === "delay" &&
    suspended.deadlineMs <= snapshot.currentSessionTimeMs &&
    snapshot.pendingTimerHandlers.length === 0
  ) {
    settleForegroundTimedAction(plan, snapshot, suspended, events);
  }
}
