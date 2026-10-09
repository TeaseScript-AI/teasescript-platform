import { DURATION_UNIT_MILLISECONDS } from "../duration.js";
import type { DelayDisplay, DurationUnitPlan } from "../plan/model.js";
import type { SerializableRuntimeValue } from "./serializable-values.js";
import { cloneCaptures, type RuntimeCaptureSnapshot } from "./captures.js";

/**
 * Asynchronous timer state. The enclosing background action owns an ADR 0016 action ID for ordering and events; the
 * timer ID is the separate identity behind opaque handles. No Player completion targets a timer, and its settlements
 * do not replace `lastSettlement`. A settled record stays while a handle or one of its blocks still reaches it, and
 * keeps only what a handle reads.
 */
export type RuntimeTimerState = "running" | "paused" | "finished" | "stopped";

export interface RuntimeTimerRangeSnapshot {
  /** Whole units of `unit`; a repeating timer redraws its next round from this range. */
  readonly start: number;
  readonly end: number;
  readonly inclusive: boolean;
  /** The unit after the range in the source. */
  readonly unit: DurationUnitPlan;
}

export interface RuntimeTimerSnapshot {
  readonly timerId: number;
  state: RuntimeTimerState;
  display: DelayDisplay;
  readonly label: string | null;
  readonly repeat: boolean;
  readonly persist: boolean;
  readonly handlerFunctionId: number | null;
  /**
   * The root of the activation that started the timer. A non-persistent timer goes when that activation is left; the
   * expiry block runs in it.
   */
  readonly rootScopeId: number;
  /** The variables its expiry block shares with the code that started it. */
  readonly captures: readonly RuntimeCaptureSnapshot[];
  /** Present only for a repeating range without a `repeatDuration` override. */
  range: RuntimeTimerRangeSnapshot | null;
  /** Duration of later rounds for a repeating fixed duration or after `repeatDuration` assignment. */
  repeatDurationMs: number | null;
  /** Total length of the current round, used for presentation progress. */
  roundDurationMs: number;
  /** Absolute session deadline while running; otherwise `null`. */
  deadlineMs: number | null;
  /** Remaining current-round time while paused; otherwise `null`. */
  remainingMs: number | null;
  /** Active running time before `runningSinceMs`, across all rounds. */
  elapsedMs: number;
  /**
   * Session time when the current running period began; `null` unless running. For anchored rounds it is the anchor
   * of the round sequence rather than the start of the current round.
   */
  runningSinceMs: number | null;
  /**
   * Fixed-length rounds completed since `runningSinceMs`, or `null` when the current round is not part of an anchored
   * sequence. While anchored, `deadlineMs` is exactly `runningSinceMs + (anchoredRounds + 1) * repeatDurationMs`, so
   * each deadline is computed from the anchor rather than accumulated. Observing every deadline and one late
   * observation therefore yield identical values, and silent rounds can be skipped in one step.
   */
  anchoredRounds: number | null;
}

/**
 * What a handle still reads once a timer finished or stopped: its state, presentation, label, later-round duration, and
 * the time it ran. `persist` stays because leaving the activation that started a non-persistent timer drops its queued
 * expiry blocks; the rounds, range, and block go when it settles.
 */
export interface RuntimeSettledTimerSnapshot {
  readonly timerId: number;
  readonly state: "finished" | "stopped";
  readonly display: DelayDisplay;
  readonly label: string | null;
  readonly persist: boolean;
  readonly repeatDurationMs: number | null;
  readonly elapsedMs: number;
}

/** The record a timer handle refers to: the active one, or what remains once the timer settled. */
export type TimerHandleRecord = RuntimeTimerSnapshot | RuntimeSettledTimerSnapshot;

/** The settled record of a finished or stopped timer. */
export function settledTimerRecord(timer: RuntimeTimerSnapshot): RuntimeSettledTimerSnapshot {
  if (timer.state !== "finished" && timer.state !== "stopped") {
    throw new Error("Only a finished or stopped timer can settle.");
  }
  return {
    timerId: timer.timerId,
    state: timer.state,
    display: timer.display,
    label: timer.label,
    persist: timer.persist,
    repeatDurationMs: timer.repeatDurationMs,
    elapsedMs: timer.elapsedMs,
  };
}

/**
 * Expired rounds whose expiry block still has to run. Consecutive expiries of the same timer share one entry, so a
 * long catch-up of a fast repeating timer stays compact; each counted expiry still runs the block once.
 */
export interface RuntimeTimerHandlerInvocationSnapshot {
  readonly timerId: number;
  readonly handlerFunctionId: number;
  /** The activation root of its timer's block. */
  readonly rootScopeId: number;
  /** Its timer's shared variables, which the queued block keeps even when the timer goes. */
  readonly captures: readonly RuntimeCaptureSnapshot[];
  readonly dueAtMs: number;
  count: number;
}

export interface TimerRoundDraw {
  /** Draws a whole number of the range's units from a validated non-empty range. */
  (range: RuntimeTimerRangeSnapshot): number;
}

export interface TimerWarning {
  readonly code: "TSW010";
  readonly message: string;
}

function timerRemainingMs(timer: TimerHandleRecord, nowMs: number): number {
  if (timer.state === "running") return Math.max(0, timer.deadlineMs! - nowMs);
  if (timer.state === "paused") return timer.remainingMs!;
  return 0;
}

function timerElapsedMs(timer: TimerHandleRecord, nowMs: number): number {
  return timer.state === "running"
    ? timer.elapsedMs + Math.max(0, Math.min(nowMs, timer.deadlineMs!) - timer.runningSinceMs!)
    : timer.elapsedMs;
}

/** Deadline of anchored round `rounds` (zero-based), computed the same way whenever it is needed. */
export function anchoredDeadlineMs(anchorMs: number, rounds: number, roundMs: number): number {
  return anchorMs + (rounds + 1) * roundMs;
}

/**
 * Starts a new running period at `nowMs` without changing the current deadline. Used before a script changes the
 * current round, which ends any anchored sequence.
 */
function rebaseRunningPeriod(timer: RuntimeTimerSnapshot, nowMs: number): void {
  timer.elapsedMs = timerElapsedMs(timer, nowMs);
  timer.runningSinceMs = nowMs;
  timer.anchoredRounds = null;
}

export function pauseTimer(timer: TimerHandleRecord, nowMs: number): TimerWarning | null {
  if (timer.state === "paused") return null;
  if (timer.state !== "running") return settledWarning(timer, "pause()");
  timer.elapsedMs = timerElapsedMs(timer, nowMs);
  timer.remainingMs = timerRemainingMs(timer, nowMs);
  timer.deadlineMs = null;
  timer.runningSinceMs = null;
  timer.anchoredRounds = null;
  timer.state = "paused";
  return null;
}

export function resumeTimer(timer: TimerHandleRecord, nowMs: number): TimerWarning | null {
  if (timer.state === "running") return null;
  if (timer.state !== "paused") return settledWarning(timer, "resume()");
  timer.deadlineMs = nowMs + timer.remainingMs!;
  timer.runningSinceMs = nowMs;
  timer.anchoredRounds = null;
  timer.remainingMs = null;
  timer.state = "running";
  return null;
}

/** Cancels the timer; its expiry block does not run for this stop. */
export function stopTimer(timer: RuntimeTimerSnapshot, nowMs: number): void {
  if (timer.state !== "running" && timer.state !== "paused") return;
  timer.elapsedMs = timerElapsedMs(timer, nowMs);
  settle(timer, "stopped");
}

export function setTimerDisplay(
  timer: TimerHandleRecord,
  display: DelayDisplay,
): TimerWarning | null {
  if (timer.state !== "running" && timer.state !== "paused") {
    return settledWarning(timer, "display");
  }
  timer.display = display;
  return null;
}

export function setTimerRepeatDuration(
  timer: TimerHandleRecord,
  durationMs: number,
  nowMs: number,
): TimerWarning | null {
  if (timer.state !== "running" && timer.state !== "paused") {
    return settledWarning(timer, "repeatDuration");
  }
  // The current round keeps its deadline; later rounds use the new length from a new anchor.
  if (timer.state === "running") rebaseRunningPeriod(timer, nowMs);
  timer.repeatDurationMs = durationMs;
  // An explicit later-round duration replaces a repeating range's redraw.
  timer.range = null;
  return null;
}

/**
 * Sets the current round's remaining time, clamped at zero. The round's total becomes its consumed part plus the new
 * remaining time, so presentation progress stays continuous; the consumed part is clamped at zero so rounding in the
 * old remaining time cannot make the total negative. Returns `expired` when the round must end now.
 */
export function setTimerRemaining(
  timer: TimerHandleRecord,
  requestedMs: number,
  nowMs: number,
): TimerWarning | "expired" | null {
  if (timer.state !== "running" && timer.state !== "paused") {
    return settledWarning(timer, "remaining");
  }
  const remainingMs = Math.max(0, requestedMs);
  const consumedMs = Math.max(0, timer.roundDurationMs - timerRemainingMs(timer, nowMs));
  timer.roundDurationMs = consumedMs + remainingMs;
  if (timer.state === "running") {
    rebaseRunningPeriod(timer, nowMs);
    timer.deadlineMs = nowMs + remainingMs;
  } else {
    timer.remainingMs = remainingMs;
  }
  return remainingMs === 0 ? "expired" : null;
}

/** The length of a repeating timer's next round without a `repeatDuration`: drawn anew from its range, if any. */
function nextRoundMs(timer: RuntimeTimerSnapshot, draw: TimerRoundDraw): number {
  return timer.range === null
    ? timer.roundDurationMs
    : draw(timer.range) * DURATION_UNIT_MILLISECONDS[timer.range.unit];
}

/**
 * Ends the current round at `endedAtMs`. A repeating timer starts its next round at that moment, so catch-up after a
 * late observation keeps the original schedule; a paused timer stays paused with a full next round. An anchored
 * round that ends at its deadline continues the anchored sequence; any other fixed-length round starts a new one.
 */
export function expireTimerRound(
  timer: RuntimeTimerSnapshot,
  endedAtMs: number,
  draw: TimerRoundDraw,
): void {
  if (!timer.repeat) {
    if (timer.state === "running") timer.elapsedMs = timerElapsedMs(timer, endedAtMs);
    settle(timer, "finished");
    return;
  }
  if (timer.state !== "running") {
    timer.roundDurationMs = timer.repeatDurationMs ?? nextRoundMs(timer, draw);
    timer.remainingMs = timer.roundDurationMs;
    return;
  }
  if (
    timer.anchoredRounds !== null &&
    timer.repeatDurationMs !== null &&
    endedAtMs === timer.deadlineMs
  ) {
    timer.anchoredRounds += 1;
    timer.deadlineMs = anchoredDeadlineMs(
      timer.runningSinceMs!,
      timer.anchoredRounds,
      timer.repeatDurationMs,
    );
    return;
  }
  // The next round is drawn before the timer changes, so a paused draw leaves the timer as it was.
  const roundDurationMs = timer.repeatDurationMs ?? nextRoundMs(timer, draw);
  timer.elapsedMs = timerElapsedMs(timer, endedAtMs);
  timer.runningSinceMs = endedAtMs;
  timer.roundDurationMs = roundDurationMs;
  if (timer.repeatDurationMs !== null) {
    timer.anchoredRounds = 0;
    timer.deadlineMs = anchoredDeadlineMs(endedAtMs, 0, timer.repeatDurationMs);
  } else {
    timer.anchoredRounds = null;
    timer.deadlineMs = endedAtMs + roundDurationMs;
  }
}

/** The last anchored round index; expiring it reaches the index limit and finishes the timer. */
const LAST_ANCHORED_ROUND = Number.MAX_SAFE_INTEGER - 2;

/**
 * An anchored repeating timer without an expiry block produces nothing observable per round, so catch-up moves
 * directly to the last anchored round due before the boundary, leaving that round for ordinary expiry. A round
 * ending exactly at `limitMs` counts only when `includeLimit` says this timer precedes the work there. The result
 * equals expiring every round in turn because each deadline comes from the same anchor formula and the same index
 * limit ends both paths.
 */
export function skipSilentRounds(
  timer: RuntimeTimerSnapshot,
  limitMs: number,
  includeLimit: boolean,
): void {
  const roundMs = timer.repeatDurationMs;
  const anchorMs = timer.runningSinceMs;
  const rounds = timer.anchoredRounds;
  if (
    timer.state !== "running" ||
    timer.handlerFunctionId !== null ||
    roundMs === null ||
    anchorMs === null ||
    rounds === null
  ) {
    return;
  }
  const due = (index: number): boolean => {
    const deadlineMs = anchoredDeadlineMs(anchorMs, index, roundMs);
    return deadlineMs < limitMs || (includeLimit && deadlineMs === limitMs);
  };
  // The largest due round index. Deadlines never decrease with the index, so a binary search over the exact formula
  // finds it in bounded steps, even where many consecutive deadlines round to the same time.
  let last = rounds;
  let high = LAST_ANCHORED_ROUND;
  while (last < high) {
    const middle = last + Math.ceil((high - last) / 2);
    if (due(middle)) last = middle;
    else high = middle - 1;
  }
  if (last <= rounds) return;
  timer.anchoredRounds = last;
  timer.deadlineMs = anchoredDeadlineMs(anchorMs, last, roundMs);
}

/** The properties a timer handle has, which {@link timerProperty} reads and restore validation accepts. */
export const TIMER_PROPERTIES: ReadonlySet<string> = new Set([
  "remaining",
  "elapsed",
  "display",
  "label",
  "state",
  "repeatDuration",
]);

/** Handle property reads; `undefined` means the property does not exist. */
export function timerProperty(
  timer: TimerHandleRecord,
  name: string,
  nowMs: number,
): SerializableRuntimeValue | undefined {
  if (!TIMER_PROPERTIES.has(name)) return undefined;
  switch (name) {
    case "remaining":
      return { kind: "duration", milliseconds: timerRemainingMs(timer, nowMs) };
    case "elapsed":
      return { kind: "duration", milliseconds: timerElapsedMs(timer, nowMs) };
    case "display":
      return timer.display;
    case "label":
      return timer.label;
    case "state":
      return timer.state;
    case "repeatDuration":
      return timer.repeatDurationMs === null
        ? null
        : { kind: "duration", milliseconds: timer.repeatDurationMs };
    default:
      return undefined;
  }
}

function settle(timer: RuntimeTimerSnapshot, state: "finished" | "stopped"): void {
  timer.state = state;
  timer.deadlineMs = null;
  timer.remainingMs = null;
  timer.runningSinceMs = null;
  timer.anchoredRounds = null;
}

function settledWarning(timer: TimerHandleRecord, operation: string): TimerWarning {
  return {
    code: "TSW010",
    message: `Timer ${operation} has no effect because the timer is already ${timer.state}.`,
  };
}

export function cloneTimer(timer: RuntimeTimerSnapshot): RuntimeTimerSnapshot {
  // Every field is a primitive except `range` and `captures`.
  return {
    ...timer,
    captures: cloneCaptures(timer.captures),
    range: timer.range === null ? null : { ...timer.range },
  };
}
