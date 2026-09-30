import type { InstructionPlan } from "../plan/model.js";
import { isValidSessionTime } from "./actions/delay.js";
import { dueWorkAwaitsQueuedBlock } from "./action-validation.js";

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
] as const;

const TIMER_ACTION_KEYS = [
  "kind",
  "actionId",
  "owningInstruction",
  "createdAtMs",
  "requestEventSequence",
  "timer",
] as const;

/** Whether a plan can interrupt a waiting path, which relaxes action-history ordering after a block returns. */
export function planHasTimerHandlers(plan: InstructionPlan | undefined): boolean {
  return plan === undefined || plan.functions.some((definition) => definition.timerHandler);
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
    !validTimerRecord(action.timer, true, now, plan, dueWorkAwaitsQueuedBlock(snapshot))
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

export function validTimerRecord(
  timer: Record<string, unknown>,
  active: boolean,
  now: unknown,
  plan: InstructionPlan | undefined,
  allowDue = false,
): boolean {
  if (
    !hasExactKeys(timer, TIMER_KEYS) ||
    !positiveSafeInteger(timer.timerId) ||
    !["visible", "mystery", "hidden"].includes(String(timer.display)) ||
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
    !isValidSessionTime(now)
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
        (timer.deadlineMs > now || allowDue) &&
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
        !validTimerRecord(timer, false, value.currentSessionTimeMs, plan)
      ) {
        errors.push("Runtime settled timer is malformed.");
        continue;
      }
      addRecord(records, timer, errors);
    }
  }
  if (Array.isArray(value.backgroundActions)) {
    for (const action of value.backgroundActions) {
      if (isPlainRecord(action) && action.kind === "timer" && isPlainRecord(action.timer)) {
        addRecord(records, action.timer, errors);
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
      record.state === "stopped"
    ) {
      errors.push("Runtime pending timer expiry block is malformed.");
      continue;
    }
    previousDue = invocation.dueAtMs;
  }
  if (Array.isArray(value.callFrames)) {
    for (const frame of value.callFrames) {
      if (!isPlainRecord(frame) || !isPlainRecord(frame.timerInterruption)) continue;
      const record = positiveSafeInteger(frame.timerInterruption.timerId)
        ? records.get(frame.timerInterruption.timerId)
        : undefined;
      if (record === undefined || record.handlerFunctionId !== frame.functionId) {
        errors.push("Runtime timer expiry-block frame does not belong to its timer.");
      }
    }
  }
  if ((value.status === "halted" || value.status === "ready") && queue.length > 0) {
    errors.push("Runtime pending timer expiry blocks require an active session.");
  }
}

/** Collects the timer IDs of every handle value reachable in the given runtime values. */
export function collectTimerHandleIds(values: readonly unknown[], output: Set<number>): void {
  const work = [...values];
  while (work.length > 0) {
    const current = work.pop();
    if (!isPlainRecord(current)) continue;
    if (current.kind === "timerHandle" && positiveSafeInteger(current.timerId)) {
      output.add(current.timerId);
    } else if (current.kind === "list" && Array.isArray(current.items)) {
      work.push(...current.items);
    } else if (current.kind === "object" && Array.isArray(current.properties)) {
      for (const property of current.properties) {
        if (isPlainRecord(property)) work.push(property.value);
      }
    }
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
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["start", "end", "inclusive"]) &&
    Number.isSafeInteger(value.start) &&
    Number.isSafeInteger(value.end) &&
    typeof value.inclusive === "boolean" &&
    (value.start as number) >= 1 &&
    (value.inclusive
      ? (value.end as number) >= (value.start as number)
      : (value.end as number) > (value.start as number))
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
