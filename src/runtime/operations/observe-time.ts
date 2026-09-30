import type { InstructionPlan } from "../../plan/model.js";
import {
  MAX_RUNTIME_SESSION_TIME_MS,
  type RuntimeCallFrameSnapshot,
  type RuntimeSnapshot,
} from "../state.js";
import type {
  RuntimeActionSettlementSnapshot,
  RuntimeChatPacingGateActionSnapshot,
  RuntimeDelayActionSnapshot,
  RuntimeTimerActionSnapshot,
} from "../actions/model.js";
import type { ActionCompletedEvent, InterpreterEvent } from "../events.js";
import { isValidSessionTime } from "../actions/delay.js";
import type { PendingActionOperationResult, TimeObservationOutcome } from "./model.js";
import { settleBackgroundPacingGate } from "./pacing-gate.js";
import { expireTimerAction, timerSpan } from "./timer-lifecycle.js";
import { terminalContinuationHandoffFor } from "./terminal-continuation.js";
import { captureExecutableData, copySpan, pendingResult, takeSequence } from "./support.js";

export function observeTime(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  suppliedNowMs: unknown,
): PendingActionOperationResult<TimeObservationOutcome> {
  const captured = captureExecutableData(plan, snapshot);
  const current = captured.snapshot;
  if (!isValidSessionTime(suppliedNowMs))
    return pendingResult(current, [], {
      kind: "invalidObservation",
      message: `Time observation must be a finite number from 0 through ${MAX_RUNTIME_SESSION_TIME_MS}.`,
    });
  const effectiveNow = Math.max(current.currentSessionTimeMs, suppliedNowMs);
  current.currentSessionTimeMs = effectiveNow;
  const events: InterpreterEvent[] = [];
  let completion: RuntimeActionSettlementSnapshot | null = null;
  // Process the globally earliest due work first, so repeat draws and queued expiry blocks follow scene time.
  for (let due = nextDueWork(current); due !== null; due = nextDueWork(current)) {
    if (due.kind === "timer") {
      expireTimerAction(
        current,
        due.action,
        due.deadlineMs,
        timerSpan(captured.plan, due.action.owningInstruction),
        events,
      );
    } else if (due.kind === "suspended") {
      settleSuspendedDelay(captured.plan, current, due.frame, due.action, events);
    } else if (
      due.action.kind === "chatPacingGate" &&
      current.backgroundActions.includes(due.action)
    ) {
      completion = settleBackgroundPacingGate(
        captured.plan,
        current,
        due.action,
        "completed",
        events,
      );
    } else {
      completion = settleForegroundTimedAction(captured.plan, current, due.action, events);
    }
  }
  return pendingResult(current, events, {
    kind: "observed",
    currentSessionTimeMs: current.currentSessionTimeMs,
    completion,
  });
}

type DueWork =
  | {
      readonly kind: "action";
      readonly action: RuntimeDelayActionSnapshot | RuntimeChatPacingGateActionSnapshot;
      readonly deadlineMs: number;
      readonly actionId: number;
    }
  | {
      readonly kind: "timer";
      readonly action: RuntimeTimerActionSnapshot;
      readonly deadlineMs: number;
      readonly actionId: number;
    }
  | {
      readonly kind: "suspended";
      readonly frame: RuntimeCallFrameSnapshot;
      readonly action: RuntimeDelayActionSnapshot;
      readonly deadlineMs: number;
      readonly actionId: number;
    };

/**
 * The earliest due timed work by `(deadline, action ID)`. A due foreground delay waits while an expiry block that
 * became due earlier is queued: the block interrupts that delay first, and the delay then settles as suspended work.
 */
function nextDueWork(snapshot: RuntimeSnapshot): DueWork | null {
  const now = snapshot.currentSessionTimeMs;
  const candidates: DueWork[] = [];
  const foreground = snapshot.foregroundAction;
  const handlerRunning = snapshot.callFrames.some((frame) => frame.timerInterruption !== null);
  if (
    foreground?.kind === "chatPacingGate" ||
    (foreground?.kind === "delay" && (handlerRunning || snapshot.pendingTimerHandlers.length === 0))
  ) {
    candidates.push({
      kind: "action",
      action: foreground,
      deadlineMs: foreground.deadlineMs,
      actionId: foreground.actionId,
    });
  }
  for (const action of snapshot.backgroundActions) {
    if (action.kind === "chatPacingGate") {
      candidates.push({
        kind: "action",
        action,
        deadlineMs: action.deadlineMs,
        actionId: action.actionId,
      });
    } else if (action.kind === "timer" && action.timer.deadlineMs !== null) {
      candidates.push({
        kind: "timer",
        action,
        deadlineMs: action.timer.deadlineMs,
        actionId: action.actionId,
      });
    }
  }
  for (const frame of snapshot.callFrames) {
    const suspended = frame.timerInterruption?.suspendedAction;
    if (suspended?.kind === "delay") {
      candidates.push({
        kind: "suspended",
        frame,
        action: suspended,
        deadlineMs: suspended.deadlineMs,
        actionId: suspended.actionId,
      });
    }
  }
  let earliest: DueWork | null = null;
  for (const candidate of candidates) {
    if (candidate.deadlineMs > now) continue;
    if (
      earliest === null ||
      candidate.deadlineMs < earliest.deadlineMs ||
      (candidate.deadlineMs === earliest.deadlineMs && candidate.actionId < earliest.actionId)
    ) {
      earliest = candidate;
    }
  }
  return earliest;
}

/**
 * A delay interrupted by an expiry block still settles in deadline order. Its continuation stays suspended and runs
 * once when the block returns normally.
 */
function settleSuspendedDelay(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  frame: RuntimeCallFrameSnapshot,
  action: RuntimeDelayActionSnapshot,
  events: InterpreterEvent[],
): void {
  const completionEventSequence = takeSequence(snapshot, 1);
  const settlement = createDelaySettlement(
    action,
    completionEventSequence,
    snapshot.currentSessionTimeMs,
  );
  frame.returnInstruction = action.continuationInstruction;
  frame.timerInterruption = { ...frame.timerInterruption!, suspendedAction: null };
  snapshot.lastSettlement = settlement;
  events.push(
    Object.freeze({
      kind: "actionCompleted",
      sequence: completionEventSequence,
      settlement,
      span: copySpan(plan.instructions[action.owningInstruction]?.span ?? plan.sourceSpan),
    } satisfies ActionCompletedEvent),
  );
}

export function settleForegroundTimedAction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  action: RuntimeDelayActionSnapshot | RuntimeChatPacingGateActionSnapshot,
  events: InterpreterEvent[],
): RuntimeActionSettlementSnapshot {
  const completionEventSequence = takeSequence(snapshot, 1);
  const settlement =
    action.kind === "delay"
      ? createDelaySettlement(action, completionEventSequence, snapshot.currentSessionTimeMs)
      : createPacingSettlement(action, completionEventSequence, snapshot.currentSessionTimeMs);
  snapshot.foregroundAction = null;
  snapshot.lastSettlement = settlement;
  snapshot.terminalContinuationHandoff =
    action.kind === "delay" ? terminalContinuationHandoffFor(plan, action) : null;
  snapshot.status = "running";
  if (action.kind === "chatPacingGate" && action.preparedOutput !== null) {
    snapshot.preparedSayOutput = action.preparedOutput;
    snapshot.nextInstruction = action.preparedOutput.owningInstruction;
  } else {
    snapshot.nextInstruction = action.continuationInstruction;
  }
  const span = plan.instructions[action.owningInstruction]?.span ?? plan.sourceSpan;
  const completionEvent: ActionCompletedEvent = Object.freeze({
    kind: "actionCompleted",
    sequence: completionEventSequence,
    settlement,
    span: copySpan(span),
  });
  events.push(completionEvent);
  return settlement;
}

export function createDelaySettlement(
  action: RuntimeDelayActionSnapshot,
  completionEventSequence: number,
  completedAtMs: number,
): RuntimeActionSettlementSnapshot {
  return Object.freeze({
    actionId: action.actionId,
    actionKind: "delay",
    settlementKind: "completed",
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    requestEventSequence: action.requestEventSequence,
    completionEventSequence,
    deadlineMs: action.deadlineMs,
    completedAtMs,
  });
}

function createPacingSettlement(
  action: RuntimeChatPacingGateActionSnapshot,
  completionEventSequence: number,
  completedAtMs: number,
): RuntimeActionSettlementSnapshot {
  return Object.freeze({
    actionId: action.actionId,
    actionKind: "chatPacingGate",
    settlementKind: "completed",
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    requestEventSequence: action.requestEventSequence,
    completionEventSequence,
    deadlineMs: action.deadlineMs,
    completedAtMs,
    releasedPreparedOutputInstruction: action.preparedOutput?.owningInstruction ?? null,
  });
}
