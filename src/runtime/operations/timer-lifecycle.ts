import { type InstructionPlan, type PlanSourceLocation, mainSourceSpan } from "../../plan/model.js";
import { cloneCaptures, sweepRetainedScopes } from "../captures.js";
import { interruptRunning } from "../activations.js";
import type { SourceSpan } from "../../source.js";
import type {
  RuntimeTimerActionSnapshot,
  RuntimeTimerSettlementSnapshot,
} from "../actions/model.js";
import { isValidSessionTime } from "../actions/delay.js";
import type { ActionCompletedEvent, InterpreterEvent } from "../events.js";
import { nextXorShift32 } from "../random.js";
import type { TraceStore } from "../debug-trace.js";
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
 * windows (a released prepared `say` or an interaction result handoff), for a
 * foreground pacing gate, whose prepared output owns the one Standard chat target, and for a pending storage write.
 */
export function timerHandlerDispatchable(snapshot: RuntimeSnapshot): boolean {
  if (!timerHandlerQueuedAndUnblocked(snapshot)) return false;
  const foreground = snapshot.foregroundAction;
  return (
    foreground === null ||
    foreground.kind === "delay" ||
    foreground.kind === "interaction" ||
    foreground.kind === "mediaPlayback"
  );
}

/**
 * A queued block waits for a pending storage write, also one made inside a running block. Catch-up holds at the
 * block's due time, so the block still runs at that scene time once the host acknowledges the write.
 */
export function timerHandlerAwaitsStorageWrite(snapshot: RuntimeSnapshot): boolean {
  return (
    snapshot.status === "waiting" &&
    snapshot.foregroundAction?.kind === "storageWrite" &&
    snapshot.pendingTimerHandlers.length > 0
  );
}

function timerHandlerQueuedAndUnblocked(snapshot: RuntimeSnapshot): boolean {
  if (snapshot.pendingTimerHandlers.length === 0) return false;
  if (snapshot.status !== "ready" && snapshot.status !== "running" && snapshot.status !== "waiting")
    return false;
  if (interruptRunning(snapshot)) return false;
  return snapshot.preparedSayOutput === null && snapshot.interactionResultHandoff === null;
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
  sweepRetainedScopes(snapshot, false);
  const settlement: RuntimeTimerSettlementSnapshot = Object.freeze({
    actionId: action.actionId,
    actionKind: "timer",
    settlementKind,
    timerId: action.timer.timerId,
    owningInstruction: action.owningInstruction,
    requestEventSequence: action.requestEventSequence,
    completionEventSequence,
    completedAtMs: snapshot.currentSessionTimeMs,
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
  trace: TraceStore | null = null,
): void {
  const timer = action.timer;
  expireTimerRound(timer, endedAtMs, (range) => drawWholeSeconds(snapshot, range, trace));
  // A next deadline outside the session range, an exhausted anchored round index, or an unanchored round that cannot
  // advance would loop forever; the timer finishes instead. Anchored rounds always advance their index, so rounds
  // shorter than the deadline's resolution may end at the same time without looping.
  if (
    timer.state === "running" &&
    (!isValidSessionTime(timer.deadlineMs) ||
      (timer.anchoredRounds === null
        ? timer.deadlineMs! <= endedAtMs
        : timer.anchoredRounds >= Number.MAX_SAFE_INTEGER - 1))
  ) {
    // Running time up to the end of the last round is kept, including an anchored sequence's rounds.
    timer.elapsedMs += Math.max(0, endedAtMs - timer.runningSinceMs!);
    timer.state = "finished";
    timer.deadlineMs = null;
    timer.runningSinceMs = null;
    timer.anchoredRounds = null;
  }
  if (timer.handlerFunctionId !== null) {
    queueTimerHandler(snapshot, timer, timer.handlerFunctionId, endedAtMs);
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
    const invocation = snapshot.pendingTimerHandlers[index]!;
    if ("timerId" in invocation && invocation.timerId === action.timer.timerId) {
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
  timer: RuntimeTimerSnapshot,
  handlerFunctionId: number,
  dueAtMs: number,
): void {
  const { timerId, rootScopeId } = timer;
  // Keep the queue in due order: an expiry processed late may be due before one queued at an earlier observation.
  const queue = snapshot.pendingTimerHandlers;
  let index = queue.length;
  while (index > 0 && queue[index - 1]!.dueAtMs > dueAtMs) index -= 1;
  const previous = queue[index - 1];
  // A full count starts a new entry, so aggregation never publishes an unsafe integer.
  if (
    previous !== undefined &&
    "timerId" in previous &&
    previous.timerId === timerId &&
    previous.count < Number.MAX_SAFE_INTEGER
  ) {
    previous.count += 1;
    return;
  }
  queue.splice(index, 0, {
    timerId,
    handlerFunctionId,
    rootScopeId,
    captures: cloneCaptures(timer.captures),
    dueAtMs,
    count: 1,
  });
}

/** Draws a repeat round from the persisted session RNG. */
function drawWholeSeconds(
  snapshot: RuntimeSnapshot,
  range: RuntimeTimerRangeSnapshot,
  trace: TraceStore | null,
): number {
  const length = range.end - range.start + (range.inclusive ? 1 : 0);
  const before = snapshot.rng.state;
  const seconds = range.start + Math.floor(nextXorShift32(snapshot.rng) * length);
  if (trace !== null) {
    trace.random(
      "timerRepeat",
      null,
      length,
      { kind: "range", ...range },
      before,
      snapshot.rng.state,
    );
    trace.randomResult(seconds);
  }
  return seconds;
}

export function timerSpan(plan: InstructionPlan, owningInstruction: number): SourceSpan {
  const location: PlanSourceLocation =
    plan.instructions[owningInstruction]?.span ?? mainSourceSpan(plan);
  return copySpan(location);
}
