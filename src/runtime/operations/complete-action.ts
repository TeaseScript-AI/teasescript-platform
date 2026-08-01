import type { InstructionPlan } from "../../plan/model.js";
import { captureExternalData } from "../../external-data-limits.js";
import { cloneCapturedRuntimeSnapshot, type RuntimeSnapshot } from "../state.js";
import type { RuntimeActionSettlementSnapshot, RuntimeInteractionActionSnapshot } from "../actions/model.js";
import type { ActionCompletedEvent, InterpreterEvent, PlayerTranscriptEvent } from "../events.js";
import { isValidSessionTime } from "../actions/delay.js";
import { resolveInteractionCompletion } from "../actions/interaction.js";
import type { ActionCompletionOutcome, PendingActionOperationResult } from "./model.js";
import { observeTime } from "./observe-time.js";
import {
  RuntimeDataError,
  assertEventSequenceCapacity,
  captureExecutableData,
  cloneSettlement,
  copySpan,
  isPlainRecord,
  pendingResult,
  positiveSafeInteger,
  setTemporary,
  takeSequence,
} from "./support.js";

export function completeAction(plan: InstructionPlan, snapshot: RuntimeSnapshot, request: unknown): PendingActionOperationResult<ActionCompletionOutcome> {
  const captured = captureExecutableData(plan, snapshot);
  const current = cloneCapturedRuntimeSnapshot(captured.snapshot);
  const external = captureExternalData(request);
  if (!external.ok || !isPlainRecord(external.value)) return pendingResult(current, [], { kind: "invalidPayload", message: "Action completion request must be bounded JSON-safe object data." });
  const value = external.value;
  if (!positiveSafeInteger(value.actionId)) return pendingResult(current, [], { kind: "invalidPayload", message: "Action completion actionId must be a positive safe integer." });
  const actionId = value.actionId;
  const active = current.foregroundAction?.actionId === actionId ? current.foregroundAction : null;
  if (active === null) {
    if (current.lastSettlement?.actionId === actionId) return pendingResult(current, [], { kind: "alreadySettled", settlement: cloneSettlement(current.lastSettlement) });
    return pendingResult(current, [], actionId < current.nextActionId ? { kind: "staleAction", actionId } : { kind: "unknownAction", actionId });
  }
  if (value.actionKind !== active.kind) return pendingResult(current, [], { kind: "wrongActionKind", actionId, expectedActionKind: active.kind, receivedActionKind: value.actionKind === "delay" || value.actionKind === "interaction" ? value.actionKind : "<invalid>" });
  if (active.kind === "interaction") return completeInteraction(captured.plan, current, active, value);
  if (!isPlainRecord(value.payload) || value.payload.kind !== "time" || !isValidSessionTime(value.payload.currentSessionTimeMs)) return pendingResult(current, [], { kind: "invalidPayload", message: "Delay completion payload must contain a valid time observation." });
  const effectiveNow = Math.max(current.currentSessionTimeMs, value.payload.currentSessionTimeMs);
  if (effectiveNow < active.deadlineMs) return pendingResult(current, [], { kind: "notDue", actionId, currentSessionTimeMs: current.currentSessionTimeMs, deadlineMs: active.deadlineMs });
  const observed = observeTime(captured.plan, current, effectiveNow);
  if (observed.outcome.kind !== "observed" || observed.outcome.completion === null) throw new RuntimeDataError("TSR101", "Due delay completion did not settle.");
  return Object.freeze({ ...observed, outcome: { kind: "completed" as const, settlement: observed.outcome.completion } });
}

function completeInteraction(
  plan: InstructionPlan,
  current: RuntimeSnapshot,
  action: RuntimeInteractionActionSnapshot,
  request: Record<string, unknown>,
): PendingActionOperationResult<ActionCompletionOutcome> {
  if (request.interactionKind !== action.interactionKind) {
    const receivedInteractionKind = request.interactionKind;
    const receivedActionKind = receivedInteractionKind === "button" || receivedInteractionKind === "text" || receivedInteractionKind === "number" || receivedInteractionKind === "choice"
      ? `interaction:${receivedInteractionKind}`
      : "<invalid>";
    return pendingResult(current, [], { kind: "wrongActionKind", actionId: action.actionId, expectedActionKind: "interaction", receivedActionKind });
  }
  const resolved = resolveInteractionCompletion(action, request.payload);
  if (!resolved.ok) return pendingResult(current, [], { kind: "invalidPayload", message: resolved.message });
  assertEventSequenceCapacity(current, 2);
  if (action.destinationTemporary !== null && resolved.result !== null) setTemporary(current.temporaries, action.destinationTemporary, resolved.result);
  const transcriptSequence = takeSequence(current);
  const completionSequence = takeSequence(current);
  const settlement: RuntimeActionSettlementSnapshot = Object.freeze({
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: action.interactionKind,
    settlementKind: "completed",
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    ownerCallFrameId: action.ownerCallFrameId,
    destinationTemporary: action.destinationTemporary,
    requestEventSequence: action.requestEventSequence,
    transcriptEventSequence: transcriptSequence,
    completionEventSequence: completionSequence,
    result: resolved.result,
    transcriptText: resolved.transcriptText,
  });
  current.foregroundAction = null;
  current.lastSettlement = settlement;
  current.status = "running";
  current.nextInstruction = action.continuationInstruction;
  const span = plan.instructions[action.owningInstruction]?.span ?? plan.sourceSpan;
  const events: InterpreterEvent[] = [
    Object.freeze({ kind: "playerTranscript", sequence: transcriptSequence, target: action.target, requestingSpeakerId: action.speakerId, text: resolved.transcriptText, span: copySpan(span) } satisfies PlayerTranscriptEvent),
    Object.freeze({ kind: "actionCompleted", sequence: completionSequence, settlement, span: copySpan(span) } satisfies ActionCompletedEvent),
  ];
  return pendingResult(current, events, { kind: "completed", settlement });
}
