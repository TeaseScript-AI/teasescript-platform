import type { DelayDisplay } from "../plan/model.js";
import type { SerializableRuntimeValue } from "./serializable-values.js";

/**
 * Asynchronous timer state. Timers are engine background timed work: they accept no Player completion, so they own
 * no ADR 0016 action ID. Settled records remain so handles stay readable.
 */
export type RuntimeTimerState = "running" | "paused" | "finished" | "stopped";

export interface RuntimeTimerRangeSnapshot {
  /** Whole seconds; a repeating timer redraws its next round from this range. */
  readonly start: number;
  readonly end: number;
  readonly inclusive: boolean;
}

export interface RuntimeTimerSnapshot {
  readonly timerId: number;
  state: RuntimeTimerState;
  display: DelayDisplay;
  readonly label: string | null;
  readonly repeat: boolean;
  readonly persist: boolean;
  readonly handlerFunctionId: number | null;
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
  /** Session time when the current running period began; `null` unless running. */
  runningSinceMs: number | null;
}

/**
 * Expired rounds whose expiry block still has to run. Consecutive expiries of the same timer share one entry, so a
 * long catch-up of a fast repeating timer stays compact; each counted expiry still runs the block once.
 */
export interface RuntimeTimerHandlerInvocationSnapshot {
  readonly timerId: number;
  readonly handlerFunctionId: number;
  readonly dueAtMs: number;
  count: number;
}

export interface TimerRoundDraw {
  /** Draws a whole number of seconds from a validated non-empty range. */
  (range: RuntimeTimerRangeSnapshot): number;
}

export interface TimerWarning {
  readonly code: "TSW010";
  readonly message: string;
}

export function timerRemainingMs(timer: RuntimeTimerSnapshot, nowMs: number): number {
  if (timer.state === "running") return Math.max(0, timer.deadlineMs! - nowMs);
  if (timer.state === "paused") return timer.remainingMs!;
  return 0;
}

export function timerElapsedMs(timer: RuntimeTimerSnapshot, nowMs: number): number {
  return timer.state === "running"
    ? timer.elapsedMs + Math.max(0, Math.min(nowMs, timer.deadlineMs!) - timer.runningSinceMs!)
    : timer.elapsedMs;
}

export function pauseTimer(timer: RuntimeTimerSnapshot, nowMs: number): TimerWarning | null {
  if (timer.state === "paused") return null;
  if (timer.state !== "running") return settledWarning(timer, "pause()");
  timer.elapsedMs = timerElapsedMs(timer, nowMs);
  timer.remainingMs = timerRemainingMs(timer, nowMs);
  timer.deadlineMs = null;
  timer.runningSinceMs = null;
  timer.state = "paused";
  return null;
}

export function resumeTimer(timer: RuntimeTimerSnapshot, nowMs: number): TimerWarning | null {
  if (timer.state === "running") return null;
  if (timer.state !== "paused") return settledWarning(timer, "resume()");
  timer.deadlineMs = nowMs + timer.remainingMs!;
  timer.runningSinceMs = nowMs;
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
  timer: RuntimeTimerSnapshot,
  display: DelayDisplay,
): TimerWarning | null {
  if (timer.state === "finished" || timer.state === "stopped") {
    return settledWarning(timer, "display");
  }
  timer.display = display;
  return null;
}

export function setTimerRepeatDuration(
  timer: RuntimeTimerSnapshot,
  durationMs: number,
): TimerWarning | null {
  if (timer.state === "finished" || timer.state === "stopped") {
    return settledWarning(timer, "repeatDuration");
  }
  timer.repeatDurationMs = durationMs;
  // An explicit later-round duration replaces a repeating range's redraw.
  timer.range = null;
  return null;
}

/**
 * Sets the current round's remaining time, clamped at zero. The round's total changes by the same amount so
 * presentation progress stays continuous. Returns `expired` when the round must end now.
 */
export function setTimerRemaining(
  timer: RuntimeTimerSnapshot,
  requestedMs: number,
  nowMs: number,
): TimerWarning | "expired" | null {
  if (timer.state === "finished" || timer.state === "stopped") {
    return settledWarning(timer, "remaining");
  }
  const remainingMs = Math.max(0, requestedMs);
  timer.roundDurationMs += remainingMs - timerRemainingMs(timer, nowMs);
  if (timer.state === "running") timer.deadlineMs = nowMs + remainingMs;
  else timer.remainingMs = remainingMs;
  return remainingMs === 0 ? "expired" : null;
}

/**
 * Ends the current round at `endedAtMs`. A repeating timer starts its next round at that moment, so catch-up after a
 * late observation keeps the original schedule; a paused timer stays paused with a full next round.
 */
export function expireTimerRound(
  timer: RuntimeTimerSnapshot,
  endedAtMs: number,
  draw: TimerRoundDraw,
): void {
  if (timer.state === "running") {
    timer.elapsedMs += Math.max(0, endedAtMs - timer.runningSinceMs!);
  }
  if (!timer.repeat) {
    settle(timer, "finished");
    return;
  }
  const nextMs =
    timer.repeatDurationMs ??
    (timer.range === null ? timer.roundDurationMs : draw(timer.range) * 1_000);
  timer.roundDurationMs = nextMs;
  if (timer.state === "running") {
    timer.runningSinceMs = endedAtMs;
    timer.deadlineMs = endedAtMs + nextMs;
  } else {
    timer.remainingMs = nextMs;
  }
}

/**
 * A fixed repeating timer without an expiry block produces nothing observable per round, so a late observation skips
 * whole rounds arithmetically, leaving the last due round for ordinary expiry.
 */
export function skipSilentRounds(timer: RuntimeTimerSnapshot, nowMs: number): void {
  const roundMs = timer.repeatDurationMs;
  if (
    timer.state !== "running" ||
    !timer.repeat ||
    timer.handlerFunctionId !== null ||
    timer.range !== null ||
    roundMs === null ||
    timer.deadlineMs === null
  ) {
    return;
  }
  const skipped = Math.floor((nowMs - timer.deadlineMs) / roundMs);
  if (!(skipped >= 1) || !Number.isSafeInteger(skipped)) return;
  // The current round and `skipped - 1` further rounds complete; the next one is still due at or before `nowMs`.
  const nextStartMs = timer.deadlineMs + (skipped - 1) * roundMs;
  timer.elapsedMs += nextStartMs - timer.runningSinceMs!;
  timer.runningSinceMs = nextStartMs;
  timer.roundDurationMs = roundMs;
  timer.deadlineMs = nextStartMs + roundMs;
}

/** Handle property reads; `undefined` means the property does not exist. */
export function timerProperty(
  timer: RuntimeTimerSnapshot,
  name: string,
  nowMs: number,
): SerializableRuntimeValue | undefined {
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
}

function settledWarning(timer: RuntimeTimerSnapshot, operation: string): TimerWarning {
  return {
    code: "TSW010",
    message: `Timer ${operation} has no effect because the timer is already ${timer.state}.`,
  };
}

export function cloneTimer(timer: RuntimeTimerSnapshot): RuntimeTimerSnapshot {
  return { ...timer, range: timer.range === null ? null : { ...timer.range } };
}
