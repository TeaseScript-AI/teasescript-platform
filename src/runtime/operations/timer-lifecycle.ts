import type { DeveloperWarningCode } from "../../diagnostic-codes.js";
import {
  type InstructionPlan,
  type PlanSourceLocation,
  instructionSourcePath,
  mainSourceSpan,
} from "../../plan/model.js";
import { formatDuration } from "../../duration.js";
import { cloneCaptures, sweepRetainedScopes } from "../captures.js";
import { interruptFrame, interruptRunning } from "../activations.js";
import type { SourceSpan } from "../../source.js";
import type {
  RuntimeTimerActionSnapshot,
  RuntimeTimerSettlementSnapshot,
} from "../actions/model.js";
import { isValidSessionTime } from "../actions/delay.js";
import type { ActionCompletedEvent, DeveloperWarningEvent, InterpreterEvent } from "../events.js";
import { drawFromSessionGenerator, sampleRangeInteger } from "../random-draws.js";
import type { TraceStore } from "../debug-trace.js";
import type { RandomControl } from "../random-control.js";
import type { RuntimeSnapshot, RuntimeTimerInterruptionSnapshot } from "../state.js";
import {
  expireTimerRound,
  settledTimerRecord,
  stopTimer,
  type RuntimeTimerRangeSnapshot,
  type RuntimeTimerSnapshot,
  type TimerHandleRecord,
} from "../timers.js";
import { assertEventSequenceCapacity, copySpan, takeSequence } from "./support.js";

/**
 * Whether a queued expiry block may interrupt now. Blocks never nest, and they wait for an interaction result handoff
 * and for a pending storage write, capture, file store, or lock step. They interrupt a `wait`, an interaction, a media
 * wait, and a message's reading time alike (owner decision on #829, 2026-10-11), and a lock's dialog as an interaction.
 */
export function timerHandlerDispatchable(snapshot: RuntimeSnapshot): boolean {
  if (!timerHandlerQueuedAndUnblocked(snapshot)) return false;
  const foreground = snapshot.foregroundAction;
  return (
    foreground === null ||
    foreground.kind === "delay" ||
    foreground.kind === "interaction" ||
    foreground.kind === "chatPacingGate" ||
    foreground.kind === "mediaPlayback" ||
    (foreground.kind === "lock" && foreground.phase === "ask")
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
  return snapshot.interactionResultHandoff === null;
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
): TimerHandleRecord | undefined {
  return (
    activeTimerAction(snapshot, timerId)?.timer ??
    snapshot.settledTimers.find((timer) => timer.timerId === timerId)
  );
}

/**
 * Removes a finished or stopped timer from background work, keeps what its handle reads, and publishes its
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
  snapshot.settledTimers.push(settledTimerRecord(action.timer));
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
 * Ends the current round at `endedAtMs`: the scheduled deadline for natural expiry (`ranOut`), or the current scene time
 * for an explicit `remaining` of zero. Queues the expiry block once and settles a timer that does not repeat.
 */
export function expireTimerAction(
  snapshot: RuntimeSnapshot,
  action: RuntimeTimerActionSnapshot,
  endedAtMs: number,
  span: SourceSpan | PlanSourceLocation,
  events: InterpreterEvent[],
  trace: TraceStore | null = null,
  control: RandomControl | null = null,
  ranOut = false,
): void {
  const timer = action.timer;
  const roundMs = timer.roundDurationMs;
  expireTimerRound(timer, endedAtMs, (range) =>
    drawWholeUnits(snapshot, action.owningInstruction, range, trace, control),
  );
  // After the draw: a paused draw throws before this, and undoing its unit does not undo the frame.
  noteRoundEndInBlock(snapshot, timer.timerId, ranOut ? roundMs : null);
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

/**
 * A round of `timerId` ended while that timer's own block runs. A round that began inside the block and ran out at its
 * deadline (`ranOutMs`, its length) lay wholly inside it, so the block takes at least as long: the block keeps that
 * length for `TSW018`. The round running as the block starts counts as inside only when the block's own expiry began
 * it, and a round that a script ends early does not count. Either way the next round begins inside the block. Engine
 * order and stored times decide this, without arithmetic, so floating-point rounding cannot change it.
 */
function noteRoundEndInBlock(
  snapshot: RuntimeSnapshot,
  timerId: number,
  ranOutMs: number | null,
): void {
  const interruption = interruptFrame(snapshot)?.timerInterruption;
  if (!interruption || !("timerId" in interruption) || interruption.timerId !== timerId) return;
  if (ranOutMs !== null && interruption.currentRoundInBlock) interruption.endedRoundMs = ranOutMs;
  interruption.currentRoundInBlock = true;
}

/**
 * Developer warning `TSW018` as a timer's block returns normally, once per timer: a whole round of the timer ran out
 * inside the block. Blocks never interrupt each other, so while this repeats, the next round is due at every return and
 * the path the blocks interrupt cannot continue.
 */
export function reportBlockOverrun(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  interruption: RuntimeTimerInterruptionSnapshot,
  events: InterpreterEvent[],
): void {
  if (!("timerId" in interruption)) return;
  const roundMs = interruption.endedRoundMs;
  if (roundMs === null) return;
  // A stopped timer repeats no more.
  const action = activeTimerAction(snapshot, interruption.timerId);
  if (action === undefined || action.timer.overrunReported) return;
  action.timer.overrunReported = true;
  const span = timerSpan(plan, action.owningInstruction);
  const location = `${instructionSourcePath(plan, action.owningInstruction)}:${span.start.line + 1}`;
  assertEventSequenceCapacity(snapshot, 1);
  events.push(
    Object.freeze({
      kind: "developerWarning",
      sequence: takeSequence(snapshot, 1),
      severity: "warning",
      code: "TSW018" satisfies DeveloperWarningCode,
      message: `The timer at ${location} started its next round before its block had finished, because the block took at least as long as its period of ${formatDuration(roundMs)}. While this repeats, the script after the timer cannot continue. Make the block shorter than the period, or the period longer.`,
      span,
    } satisfies DeveloperWarningEvent),
  );
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
 * Script end and `exit` stop every timer and drop queued expiry blocks. This is cleanup of the ended session rather
 * than a sequence of individual settlements, so no events are emitted.
 */
export function stopAllTimersForSessionEnd(snapshot: RuntimeSnapshot): void {
  for (let index = snapshot.backgroundActions.length - 1; index >= 0; index -= 1) {
    const action = snapshot.backgroundActions[index]!;
    if (action.kind !== "timer") continue;
    stopTimer(action.timer, snapshot.currentSessionTimeMs);
    snapshot.backgroundActions.splice(index, 1);
    snapshot.settledTimers.push(settledTimerRecord(action.timer));
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

/**
 * Draws a repeat round from the persisted session RNG. Its site is the duration of the timer's start, where its first
 * round was drawn.
 */
function drawWholeUnits(
  snapshot: RuntimeSnapshot,
  owningInstruction: number,
  range: RuntimeTimerRangeSnapshot,
  trace: TraceStore | null,
  control: RandomControl | null,
): number {
  const length = range.end - range.start + (range.inclusive ? 1 : 0);
  const drawId = snapshot.rng.state;
  let units = drawFromSessionGenerator(
    snapshot.rng,
    trace,
    "timerRepeat",
    null,
    length,
    { kind: "range", start: range.start, end: range.end, inclusive: range.inclusive },
    (draw) => sampleRangeInteger(draw, range, length),
  );
  if (control !== null) {
    const start = control.plan.instructions[owningInstruction]!;
    const resolved = control.resolve(
      owningInstruction,
      start.kind === "startTimer" ? start.duration.span : start.span,
      "timerRepeat",
      drawId,
      { kind: "number", value: units },
      () => ({ kind: "integer", min: range.start, max: range.start + length - 1 }),
    );
    if (resolved.kind !== "number")
      throw new Error("A timer round resolved to another kind of outcome.");
    units = resolved.value;
  }
  trace?.randomResult(units);
  return units;
}

export function timerSpan(plan: InstructionPlan, owningInstruction: number): SourceSpan {
  const location: PlanSourceLocation =
    plan.instructions[owningInstruction]?.span ?? mainSourceSpan(plan);
  return copySpan(location);
}
