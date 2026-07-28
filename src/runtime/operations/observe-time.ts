import type { InstructionPlan } from "../../plan/model.js";
import { MAX_RUNTIME_SESSION_TIME_MS, cloneCapturedRuntimeSnapshot, type RuntimeSnapshot } from "../state.js";
import type { RuntimeActionSettlementSnapshot } from "../actions/model.js";
import type { ActionCompletedEvent, InterpreterEvent } from "../events.js";
import { isValidSessionTime } from "../actions/delay.js";
import type { PendingActionOperationResult, TimeObservationOutcome } from "./model.js";
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
  const action = current.foregroundAction;
  if (action !== null && action.kind === "delay" && effectiveNow >= action.deadlineMs) {
    assertEventSequenceCapacity(current, 1);
  }
  current.currentSessionTimeMs = effectiveNow;
  if (action === null || action.kind !== "delay" || effectiveNow < action.deadlineMs) {
    return pendingResult(current, [], { kind: "observed", currentSessionTimeMs: current.currentSessionTimeMs, completion: null });
  }
  const completionSequence = takeSequence(current);
  const settlement: RuntimeActionSettlementSnapshot = Object.freeze({
    actionId: action.actionId, actionKind: "delay", settlementKind: "completed",
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    requestEventSequence: action.requestEventSequence, completionEventSequence: completionSequence,
    deadlineMs: action.deadlineMs, completedAtMs: current.currentSessionTimeMs,
  });
  current.foregroundAction = null;
  current.lastSettlement = settlement;
  current.lastSettlementResultState = "none";
  current.status = "running";
  current.nextInstruction = action.continuationInstruction;
  const span = captured.plan.instructions[action.owningInstruction]?.span ?? captured.plan.sourceSpan;
  const events: InterpreterEvent[] = [Object.freeze({ kind: "actionCompleted", sequence: completionSequence, settlement, span: copySpan(span) } satisfies ActionCompletedEvent)];
  return pendingResult(current, events, { kind: "observed", currentSessionTimeMs: current.currentSessionTimeMs, completion: settlement });
}
