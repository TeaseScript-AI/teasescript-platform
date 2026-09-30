import type { InstructionPlan, PlanSourceLocation } from "../../plan/model.js";
import type { SourceSpan } from "../../source.js";
import type {
  RuntimeTimerActionSnapshot,
  RuntimeTimerSettlementSnapshot,
} from "../actions/model.js";
import { isValidSessionTime } from "../actions/delay.js";
import type { ActionCompletedEvent, InterpreterEvent } from "../events.js";
import { nextXorShift32 } from "../random.js";
import type { RuntimeSnapshot } from "../state.js";
import {
  expireTimerRound,
  stopTimer,
  type RuntimeTimerRangeSnapshot,
  type RuntimeTimerSnapshot,
} from "../timers.js";
import { assertEventSequenceCapacity, copySpan, takeSequence } from "./support.js";

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
 * Catch-up toward the observed time pauses while an expiry block can execute: the running block can continue, or a
 * queued block can interrupt now or right after the current single-instruction commit window (released prepared
 * `say` output, an interaction result, or a settled terminal action). Scene time then stays at the moment that
 * block's work became due. A foreground pacing gate holds a queued block until the gate's own deadline.
 */
export function timerBlockHoldsCatchUp(snapshot: RuntimeSnapshot): boolean {
  const executable =
    snapshot.status === "ready" || snapshot.status === "running" || snapshot.status === "waiting";
  if (snapshot.callFrames.some((frame) => frame.timerInterruption !== null)) {
    return executable && snapshot.status !== "waiting";
  }
  return (
    executable &&
    snapshot.pendingTimerHandlers.length > 0 &&
    snapshot.foregroundAction?.kind !== "chatPacingGate"
  );
}

/**
 * Time recorded for a delay or pacing settlement. Work settled for a running expiry block records the scene time at
 * which the block continues; other settlements record the observation, as for plans without expiry blocks.
 */
export function settlementTimeMs(snapshot: RuntimeSnapshot): number {
  return snapshot.callFrames.some((frame) => frame.timerInterruption !== null)
    ? snapshot.currentSessionTimeMs
    : snapshot.observedSessionTimeMs;
}

/** Finds the active background action of a handle's timer, if it is still running or paused. */
export function activeTimerAction(
  snapshot: RuntimeSnapshot,
  timerId: number,
): RuntimeTimerActionSnapshot | undefined {
  return snapshot.backgroundActions.find(
    (action): action is RuntimeTimerActionSnapshot =>
      action.kind === "timer" && action.timer.timerId === timerId,
  );
}

export function timerRecord(
  snapshot: RuntimeSnapshot,
  timerId: number,
): RuntimeTimerSnapshot | undefined {
  return (
    activeTimerAction(snapshot, timerId)?.timer ??
    snapshot.settledTimers.find((timer) => timer.timerId === timerId)
  );
}

/**
 * Removes a finished or stopped timer from background work, retains its handle data, and publishes its
 * `actionCompleted`. Timer settlements are not retained as `lastSettlement` because no Player completion targets them.
 */
function settleTimerAction(
  snapshot: RuntimeSnapshot,
  action: RuntimeTimerActionSnapshot,
  span: SourceSpan | PlanSourceLocation,
  events: InterpreterEvent[],
): void {
  const settlementKind = action.timer.state;
  if (settlementKind !== "finished" && settlementKind !== "stopped") {
    throw new Error("Only a finished or stopped timer can settle.");
  }
  assertEventSequenceCapacity(snapshot, 1);
  const completionEventSequence = takeSequence(snapshot, 1);
  snapshot.backgroundActions.splice(snapshot.backgroundActions.indexOf(action), 1);
  snapshot.settledTimers.push(action.timer);
  const settlement: RuntimeTimerSettlementSnapshot = Object.freeze({
    actionId: action.actionId,
    actionKind: "timer",
    settlementKind,
    timerId: action.timer.timerId,
    owningInstruction: action.owningInstruction,
    requestEventSequence: action.requestEventSequence,
    completionEventSequence,
    completedAtMs: settlementTimeMs(snapshot),
  });
  events.push(
    Object.freeze({
      kind: "actionCompleted",
      sequence: completionEventSequence,
      settlement,
      span: copySpan(span),
    } satisfies ActionCompletedEvent),
  );
}

/**
 * Ends the current round at `endedAtMs`: the scheduled deadline for natural expiry, or the current scene time for
 * an explicit `remaining` of zero. Queues the expiry block once and settles a timer that does not repeat.
 */
export function expireTimerAction(
  snapshot: RuntimeSnapshot,
  action: RuntimeTimerActionSnapshot,
  endedAtMs: number,
  span: SourceSpan | PlanSourceLocation,
  events: InterpreterEvent[],
): void {
  const timer = action.timer;
  expireTimerRound(timer, endedAtMs, (range) => drawWholeSeconds(snapshot, range));
  // A next deadline that cannot advance or leaves the session range would loop forever; the timer finishes instead.
  if (
    timer.state === "running" &&
    (!isValidSessionTime(timer.deadlineMs) || timer.deadlineMs! <= endedAtMs)
  ) {
    timer.state = "finished";
    timer.deadlineMs = null;
    timer.runningSinceMs = null;
  }
  if (timer.handlerFunctionId !== null) {
    queueTimerHandler(snapshot, timer.timerId, timer.handlerFunctionId, endedAtMs);
  }
  if (timer.state === "finished") settleTimerAction(snapshot, action, span, events);
}

/** `stop()`: cancels the timer and any of its expiry blocks that have not started. */
export function stopTimerAction(
  snapshot: RuntimeSnapshot,
  action: RuntimeTimerActionSnapshot,
  span: SourceSpan | PlanSourceLocation,
  events: InterpreterEvent[],
): void {
  stopTimer(action.timer, snapshot.currentSessionTimeMs);
  for (let index = snapshot.pendingTimerHandlers.length - 1; index >= 0; index -= 1) {
    if (snapshot.pendingTimerHandlers[index]!.timerId === action.timer.timerId) {
      snapshot.pendingTimerHandlers.splice(index, 1);
    }
  }
  settleTimerAction(snapshot, action, span, events);
}

/**
 * Script end and `exit` stop every timer and drop queued expiry blocks. Like the pacing gate at `exit`, this is
 * cleanup of the ended session rather than a sequence of individual settlements, so no events are emitted.
 */
export function stopAllTimersForSessionEnd(snapshot: RuntimeSnapshot): void {
  for (let index = snapshot.backgroundActions.length - 1; index >= 0; index -= 1) {
    const action = snapshot.backgroundActions[index]!;
    if (action.kind !== "timer") continue;
    stopTimer(action.timer, snapshot.currentSessionTimeMs);
    snapshot.backgroundActions.splice(index, 1);
    snapshot.settledTimers.push(action.timer);
  }
  snapshot.pendingTimerHandlers.length = 0;
}

function queueTimerHandler(
  snapshot: RuntimeSnapshot,
  timerId: number,
  handlerFunctionId: number,
  dueAtMs: number,
): void {
  // Keep the queue in due order: an expiry processed late may be due before one queued at an earlier observation.
  const queue = snapshot.pendingTimerHandlers;
  let index = queue.length;
  while (index > 0 && queue[index - 1]!.dueAtMs > dueAtMs) index -= 1;
  const previous = queue[index - 1];
  if (previous?.timerId === timerId) {
    previous.count += 1;
    return;
  }
  queue.splice(index, 0, { timerId, handlerFunctionId, dueAtMs, count: 1 });
}

/** Draws a repeat round from the persisted session RNG. */
function drawWholeSeconds(snapshot: RuntimeSnapshot, range: RuntimeTimerRangeSnapshot): number {
  const length = range.end - range.start + (range.inclusive ? 1 : 0);
  return range.start + Math.floor(nextXorShift32(snapshot.rng) * length);
}

export function timerSpan(plan: InstructionPlan, owningInstruction: number): SourceSpan {
  const location: PlanSourceLocation =
    plan.instructions[owningInstruction]?.span ?? plan.sourceSpan;
  return copySpan(location);
}
