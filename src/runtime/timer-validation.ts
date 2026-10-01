import type { InstructionPlan } from "../plan/model.js";
import { isValidSessionTime } from "./actions/delay.js";
import { anchoredDeadlineMs } from "./timers.js";
import { catchUpPaused } from "./action-validation.js";

/** Restore validation for asynchronous timers, their handles, and queued expiry blocks. */

const TIMER_KEYS = [
  "timerId",
  "state",
  "display",
  "label",
  "repeat",
  "persist",
  "handlerFunctionId",
  "range",
  "repeatDurationMs",
  "roundDurationMs",
  "deadlineMs",
  "remainingMs",
  "elapsedMs",
  "runningSinceMs",
  "anchoredRounds",
] as const;

const TIMER_ACTION_KEYS = [
  "kind",
  "actionId",
  "owningInstruction",
  "createdAtMs",
  "requestEventSequence",
  "timer",
] as const;

/**
 * A deadline equal to scene time stays unsettled while execution can continue at that time, and in a failed session,
 * which settles nothing further.
 */
function dueDeadlineMayRemain(snapshot: Record<string, unknown>): boolean {
  return snapshot.status === "failed" || catchUpPaused(snapshot);
}

export function validTimerAction(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  const now = snapshot.currentSessionTimeMs;
  if (
    !hasExactKeys(action, TIMER_ACTION_KEYS) ||
    action.kind !== "timer" ||
    !positiveSafeInteger(action.actionId) ||
    !positiveSafeInteger(snapshot.nextActionId) ||
    action.actionId >= snapshot.nextActionId ||
    !positiveSafeInteger(action.requestEventSequence) ||
    !positiveSafeInteger(snapshot.nextEventSequence) ||
    action.requestEventSequence >= snapshot.nextEventSequence ||
    !isValidSessionTime(action.createdAtMs) ||
    !isValidSessionTime(now) ||
    action.createdAtMs > now ||
    !nonNegativeSafeInteger(action.owningInstruction) ||
    !isPlainRecord(action.timer) ||
    !validTimerRecord(action.timer, true, now, plan, dueDeadlineMayRemain(snapshot)) ||
    !validActiveChronology(action.timer, action.createdAtMs, now)
  ) {
    return false;
  }
  if (plan === undefined) return true;
  const owner = plan.instructions[action.owningInstruction];
  const timer = action.timer;
  return (
    owner?.kind === "startTimer" &&
    owner.repeat === timer.repeat &&
    owner.persist === timer.persist &&
    owner.handlerFunctionId === timer.handlerFunctionId &&
    (owner.label === null) === (timer.label === null)
  );
}

/**
 * A timer runs only after it was created, its deadline follows its current running period, and accumulated elapsed
 * time fits the scene time available before that period (or before now while paused).
 */
function validActiveChronology(
  timer: Record<string, unknown>,
  createdAtMs: number,
  now: number,
): boolean {
  const { runningSinceMs, deadlineMs, elapsedMs } = timer;
  if (typeof elapsedMs !== "number") return false;
  if (typeof runningSinceMs === "number") {
    return (
      runningSinceMs >= createdAtMs &&
      typeof deadlineMs === "number" &&
      deadlineMs >= runningSinceMs &&
      withinSceneTime(elapsedMs, runningSinceMs - createdAtMs)
    );
  }
  return withinSceneTime(elapsedMs, now - createdAtMs);
}

/** Elapsed time accumulates by subtraction, so allow floating-point rounding relative to the bound. */
function withinSceneTime(elapsedMs: number, availableMs: number): boolean {
  return elapsedMs <= availableMs + Number.EPSILON * 16 * Math.max(1, availableMs);
}

/** `value <= bound`, allowing rounding relative to the largest magnitude that produced either side. */
function atMost(value: number, bound: number, magnitude: number): boolean {
  return value <= bound + Number.EPSILON * 16 * Math.max(1, Math.abs(magnitude));
}

/**
 * The current round's total covers the time still left in it, and its consumed part fits the timer's running time.
 * These values come from subtracting session coordinates, so rounding scales with the scene time `now`. An anchored
 * round sequence instead fixes the deadline exactly by its anchor formula, and its completed rounds have ended.
 */
function validCurrentRound(timer: Record<string, unknown>, now: number): boolean {
  const { roundDurationMs, elapsedMs, anchoredRounds } = timer;
  if (typeof roundDurationMs !== "number" || typeof elapsedMs !== "number") return false;
  if (anchoredRounds !== null) {
    return (
      nonNegativeSafeInteger(anchoredRounds) &&
      anchoredRounds < Number.MAX_SAFE_INTEGER - 1 &&
      timer.state === "running" &&
      timer.repeat === true &&
      timer.range === null &&
      typeof timer.repeatDurationMs === "number" &&
      roundDurationMs === timer.repeatDurationMs &&
      typeof timer.runningSinceMs === "number" &&
      timer.deadlineMs ===
        anchoredDeadlineMs(timer.runningSinceMs, anchoredRounds, timer.repeatDurationMs) &&
      (anchoredRounds === 0 ||
        anchoredDeadlineMs(timer.runningSinceMs, anchoredRounds - 1, timer.repeatDurationMs) <= now)
    );
  }
  if (timer.state === "running") {
    if (typeof timer.deadlineMs !== "number" || typeof timer.runningSinceMs !== "number") {
      return false;
    }
    const leftMs = timer.deadlineMs - timer.runningSinceMs;
    const magnitude = Math.max(timer.deadlineMs, now) + elapsedMs;
    return (
      atMost(leftMs, roundDurationMs, magnitude) &&
      atMost(roundDurationMs, elapsedMs + leftMs, magnitude)
    );
  }
  if (timer.state === "paused") {
    if (typeof timer.remainingMs !== "number") return false;
    const magnitude = now + roundDurationMs + elapsedMs;
    return (
      atMost(timer.remainingMs, roundDurationMs, magnitude) &&
      atMost(roundDurationMs - timer.remainingMs, elapsedMs, magnitude)
    );
  }
  return true;
}

function validTimerRecord(
  timer: Record<string, unknown>,
  active: boolean,
  now: unknown,
  plan: InstructionPlan | undefined,
  allowDue = false,
): boolean {
  if (
    !hasExactKeys(timer, TIMER_KEYS) ||
    !positiveSafeInteger(timer.timerId) ||
    (timer.display !== "visible" && timer.display !== "mystery" && timer.display !== "hidden") ||
    (timer.label !== null && typeof timer.label !== "string") ||
    typeof timer.repeat !== "boolean" ||
    typeof timer.persist !== "boolean" ||
    !validDuration(timer.roundDurationMs) ||
    !validDuration(timer.elapsedMs) ||
    (timer.repeatDurationMs !== null &&
      (!validDuration(timer.repeatDurationMs) || timer.repeatDurationMs <= 0)) ||
    !validRange(timer.range) ||
    (timer.range !== null && (!timer.repeat || timer.repeatDurationMs !== null)) ||
    (timer.repeat && timer.range === null && timer.repeatDurationMs === null) ||
    !isValidSessionTime(now) ||
    !validCurrentRound(timer, now)
  ) {
    return false;
  }
  if (timer.handlerFunctionId !== null) {
    if (!positiveSafeInteger(timer.handlerFunctionId)) return false;
    if (plan !== undefined && plan.functions[timer.handlerFunctionId - 1]?.timerHandler !== true)
      return false;
  }
  switch (timer.state) {
    case "running":
      return (
        active &&
        timer.remainingMs === null &&
        isValidSessionTime(timer.deadlineMs) &&
        isValidSessionTime(timer.runningSinceMs) &&
        (timer.deadlineMs > now || (allowDue && timer.deadlineMs === now)) &&
        timer.runningSinceMs <= now
      );
    case "paused":
      return (
        active &&
        timer.deadlineMs === null &&
        timer.runningSinceMs === null &&
        validDuration(timer.remainingMs) &&
        timer.remainingMs > 0
      );
    case "finished":
    case "stopped":
      return (
        !active &&
        timer.deadlineMs === null &&
        timer.remainingMs === null &&
        timer.runningSinceMs === null
      );
    default:
      return false;
  }
}

/**
 * Every issued timer ID has exactly one active or settled record, handles refer only to issued IDs, and queued
 * expiry blocks refer to their timer's own block in scene-time order.
 */
export function validateTimerState(
  value: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  handleIds: ReadonlySet<number>,
  errors: string[],
): void {
  const nextTimerId = value.nextTimerId;
  if (!positiveSafeInteger(nextTimerId)) {
    errors.push("Runtime nextTimerId must be a positive safe integer.");
    return;
  }
  const records = new Map<number, Record<string, unknown>>();
  const settled = value.settledTimers;
  if (!isCanonicalJsonArray(settled)) {
    errors.push("Runtime settledTimers must be an array.");
  } else {
    for (const timer of settled) {
      if (
        !isPlainRecord(timer) ||
        !validTimerRecord(timer, false, value.currentSessionTimeMs, plan) ||
        typeof value.currentSessionTimeMs !== "number" ||
        typeof timer.elapsedMs !== "number" ||
        !withinSceneTime(timer.elapsedMs, value.currentSessionTimeMs)
      ) {
        errors.push("Runtime settled timer is malformed.");
        continue;
      }
      addRecord(records, timer, errors);
    }
  }
  // Known creation times of active timers bound when their expiries can be due.
  const createdAt = new Map<number, number>();
  if (Array.isArray(value.backgroundActions)) {
    for (const action of value.backgroundActions) {
      if (isPlainRecord(action) && action.kind === "timer" && isPlainRecord(action.timer)) {
        addRecord(records, action.timer, errors);
        if (positiveSafeInteger(action.timer.timerId) && typeof action.createdAtMs === "number") {
          createdAt.set(action.timer.timerId, action.createdAtMs);
        }
      }
    }
  }
  if (records.size !== nextTimerId - 1 || [...records.keys()].some((id) => id >= nextTimerId)) {
    errors.push("Runtime timers do not match the issued timer IDs.");
  }
  for (const id of handleIds) {
    if (!records.has(id)) errors.push("Runtime timer handle refers to an unissued timer.");
  }
  const queue = value.pendingTimerHandlers;
  if (!isCanonicalJsonArray(queue)) {
    errors.push("Runtime pendingTimerHandlers must be an array.");
    return;
  }
  let previousDue = -Infinity;
  const oneShotInvocations = new Map<number, number>();
  for (const invocation of queue) {
    const record =
      isPlainRecord(invocation) && positiveSafeInteger(invocation.timerId)
        ? records.get(invocation.timerId)
        : undefined;
    if (
      !isPlainRecord(invocation) ||
      !hasExactKeys(invocation, ["timerId", "handlerFunctionId", "dueAtMs", "count"]) ||
      record === undefined ||
      !positiveSafeInteger(invocation.handlerFunctionId) ||
      invocation.handlerFunctionId !== record.handlerFunctionId ||
      !positiveSafeInteger(invocation.count) ||
      !isValidSessionTime(invocation.dueAtMs) ||
      !isValidSessionTime(value.currentSessionTimeMs) ||
      invocation.dueAtMs > value.currentSessionTimeMs ||
      invocation.dueAtMs < previousDue ||
      invocation.dueAtMs < (createdAt.get(Number(invocation.timerId)) ?? 0) ||
      record.state === "stopped"
    ) {
      errors.push("Runtime pending timer expiry block is malformed.");
      continue;
    }
    previousDue = invocation.dueAtMs;
    const { timerId, count } = invocation;
    if (record.repeat !== true && positiveSafeInteger(timerId) && positiveSafeInteger(count)) {
      oneShotInvocations.set(timerId, (oneShotInvocations.get(timerId) ?? 0) + count);
      if (record.state !== "finished") {
        errors.push("Runtime one-shot timer expiry block requires a finished timer.");
      }
    }
  }
  if (Array.isArray(value.callFrames)) {
    for (const frame of value.callFrames) {
      if (!isPlainRecord(frame) || !isPlainRecord(frame.timerInterruption)) continue;
      const record = positiveSafeInteger(frame.timerInterruption.timerId)
        ? records.get(frame.timerInterruption.timerId)
        : undefined;
      const dueAtMs = frame.timerInterruption.dueAtMs;
      if (
        record === undefined ||
        record.handlerFunctionId !== frame.functionId ||
        (typeof dueAtMs === "number" &&
          positiveSafeInteger(record.timerId) &&
          dueAtMs < (createdAt.get(record.timerId) ?? 0))
      ) {
        errors.push("Runtime timer expiry-block frame does not belong to its timer.");
      } else if (record.repeat !== true && positiveSafeInteger(record.timerId)) {
        const id = record.timerId;
        oneShotInvocations.set(id, (oneShotInvocations.get(id) ?? 0) + 1);
        if (record.state !== "finished") {
          errors.push("Runtime one-shot timer expiry block requires a finished timer.");
        }
      }
    }
  }
  // A timer that does not repeat expires once, so its block is queued or running at most once.
  if ([...oneShotInvocations.values()].some((count) => count > 1)) {
    errors.push("Runtime one-shot timer has more than one expiry block invocation.");
  }
  if ((value.status === "halted" || value.status === "ready") && queue.length > 0) {
    errors.push("Runtime pending timer expiry blocks require an active session.");
  }
}

function addRecord(
  records: Map<number, Record<string, unknown>>,
  timer: Record<string, unknown>,
  errors: string[],
): void {
  if (!positiveSafeInteger(timer.timerId)) return;
  if (records.has(timer.timerId)) errors.push("Runtime timer IDs must be unique.");
  records.set(timer.timerId, timer);
}

function validRange(value: unknown): boolean {
  if (value === null) return true;
  if (!isPlainRecord(value) || !hasExactKeys(value, ["start", "end", "inclusive"])) return false;
  const { start, end, inclusive } = value;
  return (
    typeof start === "number" &&
    typeof end === "number" &&
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    typeof inclusive === "boolean" &&
    start >= 1 &&
    (inclusive ? end >= start : end > start)
  );
}

function validDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isCanonicalJsonArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.keys(value).length === value.length;
}
