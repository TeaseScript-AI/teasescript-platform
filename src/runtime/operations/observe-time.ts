import type { InstructionPlan } from "../../plan/model.js";
import { MAX_RUNTIME_SESSION_TIME_MS, cloneCapturedRuntimeSnapshot, type RuntimeSnapshot } from "../state.js";
import type {
  RuntimeActionSettlementSnapshot,
  RuntimeChatPacingGateActionSnapshot,
  RuntimeDelayActionSnapshot,
} from "../actions/model.js";
import type { ActionCompletedEvent, InterpreterEvent } from "../events.js";
import { isValidSessionTime } from "../actions/delay.js";
import type { PendingActionOperationResult, TimeObservationOutcome } from "./model.js";
import { settleBackgroundPacingGate } from "./pacing-gate.js";
import {
  assertEventSequenceCapacity,
  captureExecutableData,
  copySpan,
  pendingResult,
  takeSequence,
} from "./support.js";

export function observeTime(plan: InstructionPlan, snapshot: RuntimeSnapshot, suppliedNowMs: unknown): PendingActionOperationResult<TimeObservationOutcome> {
  const captured = captureExecutableData(plan, snapshot);
  const current = cloneCapturedRuntimeSnapshot(captured.snapshot);
  if (!isValidSessionTime(suppliedNowMs)) return pendingResult(current, [], { kind: "invalidObservation", message: `Time observation must be a finite number from 0 through ${MAX_RUNTIME_SESSION_TIME_MS}.` });
  const effectiveNow = Math.max(current.currentSessionTimeMs, suppliedNowMs);
  const due = timedActionsDue(current, effectiveNow);
  assertEventSequenceCapacity(current, due.length);
  current.currentSessionTimeMs = effectiveNow;
  const events: InterpreterEvent[] = [];
  let completion: RuntimeActionSettlementSnapshot | null = null;
  for (const action of due) {
    if (action.kind === "chatPacingGate" && current.backgroundActions.includes(action)) {
      completion = settleBackgroundPacingGate(captured.plan, current, action, "completed", events);
      continue;
    }
    if (current.foregroundAction === action) {
      completion = settleForegroundTimedAction(captured.plan, current, action, events);
    }
  }
  return pendingResult(current, events, { kind: "observed", currentSessionTimeMs: current.currentSessionTimeMs, completion });
}

function timedActionsDue(snapshot: RuntimeSnapshot, now: number): Array<RuntimeDelayActionSnapshot | RuntimeChatPacingGateActionSnapshot> {
  const actions: Array<RuntimeDelayActionSnapshot | RuntimeChatPacingGateActionSnapshot> = [];
  if (snapshot.foregroundAction?.kind === "delay" || snapshot.foregroundAction?.kind === "chatPacingGate") actions.push(snapshot.foregroundAction);
  for (const action of snapshot.backgroundActions) {
    if (action.kind === "chatPacingGate") actions.push(action);
  }
  return actions
    .filter((action) => now >= action.deadlineMs)
    .sort((left, right) => left.deadlineMs - right.deadlineMs || left.actionId - right.actionId);
}

function settleForegroundTimedAction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  action: RuntimeDelayActionSnapshot | RuntimeChatPacingGateActionSnapshot,
  events: InterpreterEvent[],
): RuntimeActionSettlementSnapshot {
  const completionEventSequence = takeSequence(snapshot);
  const settlement: RuntimeActionSettlementSnapshot = Object.freeze(
    action.kind === "delay"
      ? {
          actionId: action.actionId, actionKind: "delay", settlementKind: "completed",
          owningInstruction: action.owningInstruction, continuationInstruction: action.continuationInstruction,
          requestEventSequence: action.requestEventSequence, completionEventSequence,
          deadlineMs: action.deadlineMs, completedAtMs: snapshot.currentSessionTimeMs,
        }
      : {
          actionId: action.actionId, actionKind: "chatPacingGate", settlementKind: "completed",
          owningInstruction: action.owningInstruction, continuationInstruction: action.continuationInstruction,
          requestEventSequence: action.requestEventSequence, completionEventSequence,
          deadlineMs: action.deadlineMs, completedAtMs: snapshot.currentSessionTimeMs,
          releasedPreparedOutput: action.preparedOutput !== null,
        },
  );
  snapshot.foregroundAction = null;
  snapshot.lastSettlement = settlement;
  snapshot.status = "running";
  if (action.kind === "chatPacingGate" && action.preparedOutput !== null) {
    snapshot.preparedSayOutput = action.preparedOutput;
    snapshot.nextInstruction = action.preparedOutput.owningInstruction;
  } else {
    snapshot.nextInstruction = action.continuationInstruction;
  }
  const span = plan.instructions[action.owningInstruction]?.span ?? plan.sourceSpan;
  events.push(Object.freeze({ kind: "actionCompleted", sequence: completionEventSequence, settlement, span: copySpan(span) } satisfies ActionCompletedEvent));
  return settlement;
}
