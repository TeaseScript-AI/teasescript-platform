import type { InstructionPlan } from "../../plan/model.js";
import { captureExternalData } from "../../external-data-limits.js";
import {
  type RuntimeInteractionResultHandoffSnapshot,
  type RuntimeSnapshot,
} from "../state.js";
import type { RuntimeActionSettlementSnapshot, RuntimeChatPacingGateActionSnapshot, RuntimeInteractionActionSnapshot } from "../actions/model.js";
import type { ActionCompletedEvent, InterpreterEvent, PlayerTranscriptEvent } from "../events.js";
import { isValidSessionTime } from "../actions/delay.js";
import { resolveInteractionCompletion } from "../actions/interaction.js";
import type { ActionCompletionOutcome, PendingActionOperationResult } from "./model.js";
import { observeTime } from "./observe-time.js";
import { settleBackgroundPacingGate } from "./pacing-gate.js";
import { terminalContinuationHandoffFor } from "./terminal-continuation.js";
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

export function completeAction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  request: unknown,
): PendingActionOperationResult<ActionCompletionOutcome> {
  const captured = captureExecutableData(plan, snapshot);
  const current = captured.snapshot;
  const external = captureExternalData(request);
  if (!external.ok || !isPlainRecord(external.value)) {
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "Action completion request must be bounded JSON-safe object data.",
    });
  }
  const value = external.value;
  if (!positiveSafeInteger(value.actionId)) {
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "Action completion actionId must be a positive safe integer.",
    });
  }
  const actionId = value.actionId;
  const active = current.foregroundAction?.actionId === actionId
    ? current.foregroundAction
    : current.backgroundActions.find(
      (action): action is RuntimeChatPacingGateActionSnapshot =>
        action.kind === "chatPacingGate" && action.actionId === actionId,
    ) ?? null;
  if (active === null) {
    if (current.lastSettlement?.actionId === actionId) {
      return pendingResult(current, [], {
        kind: "alreadySettled",
        settlement: cloneSettlement(current.lastSettlement),
      });
    }
    const outcome = actionId < current.nextActionId
      ? { kind: "staleAction" as const, actionId }
      : { kind: "unknownAction" as const, actionId };
    return pendingResult(current, [], outcome);
  }
  if (value.actionKind !== active.kind) {
    const receivedActionKind = validRequestedActionKind(value.actionKind)
      ? value.actionKind
      : "<invalid>";
    return pendingResult(current, [], {
      kind: "wrongActionKind",
      actionId,
      expectedActionKind: active.kind,
      receivedActionKind,
    });
  }
  if (active.kind === "interaction") {
    return completeInteraction(captured.plan, current, active, value);
  }
  if (active.kind === "chatPacingGate") {
    return completePacingGate(captured.plan, current, active, value);
  }
  if (
    !isPlainRecord(value.payload) ||
    value.payload.kind !== "time" ||
    !isValidSessionTime(value.payload.currentSessionTimeMs)
  ) {
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "Delay completion payload must contain a valid time observation.",
    });
  }
  const effectiveNow = Math.max(current.currentSessionTimeMs, value.payload.currentSessionTimeMs);
  if (effectiveNow < active.deadlineMs) {
    return pendingResult(current, [], {
      kind: "notDue",
      actionId,
      currentSessionTimeMs: current.currentSessionTimeMs,
      deadlineMs: active.deadlineMs,
    });
  }
  const observed = observeTime(captured.plan, current, effectiveNow);
  if (
    observed.outcome.kind !== "observed" ||
    observed.outcome.completion === null
  ) {
    throw new RuntimeDataError("TSR101", "Due delay completion did not settle.");
  }
  const requestedCompletion = observed.events.find(
    (event): event is ActionCompletedEvent =>
      event.kind === "actionCompleted" && event.settlement.actionId === actionId,
  );
  if (requestedCompletion === undefined) {
    throw new RuntimeDataError("TSR101", "Due delay completion did not settle the requested action.");
  }
  return Object.freeze({
    ...observed,
    outcome: {
      kind: "completed" as const,
      settlement: requestedCompletion.settlement,
    },
  });
}

function completePacingGate(
  plan: InstructionPlan,
  current: RuntimeSnapshot,
  action: RuntimeChatPacingGateActionSnapshot,
  request: Record<string, unknown>,
): PendingActionOperationResult<ActionCompletionOutcome> {
  if (!isPlainRecord(request.payload) || request.payload.kind !== "skip") {
    return pendingResult(current, [], { kind: "invalidPayload", message: "Pacing completion payload must be a skip request." });
  }
  if (!action.skippable) {
    return pendingResult(current, [], { kind: "invalidPayload", message: "This pacing gate is not skippable." });
  }
  if (current.backgroundActions.includes(action)) {
    const events: InterpreterEvent[] = [];
    const settlement = settleBackgroundPacingGate(plan, current, action, "skipped", events);
    return pendingResult(current, events, { kind: "completed", settlement });
  }
  assertEventSequenceCapacity(current, 1);
  const completionEventSequence = takeSequence(current, 1);
  const settlement: RuntimeActionSettlementSnapshot = Object.freeze({
    actionId: action.actionId,
    actionKind: "chatPacingGate",
    settlementKind: "skipped",
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    requestEventSequence: action.requestEventSequence,
    completionEventSequence,
    deadlineMs: action.deadlineMs,
    completedAtMs: current.currentSessionTimeMs,
    releasedPreparedOutputInstruction: action.preparedOutput?.owningInstruction ?? null,
  });
  current.foregroundAction = null;
  current.lastSettlement = settlement;
  current.status = "running";
  if (action.preparedOutput !== null) {
    current.preparedSayOutput = action.preparedOutput;
    current.nextInstruction = action.preparedOutput.owningInstruction;
  } else {
    current.nextInstruction = action.continuationInstruction;
  }
  const span = plan.instructions[action.owningInstruction]?.span ?? plan.sourceSpan;
  const completionEvent: ActionCompletedEvent = Object.freeze({
    kind: "actionCompleted",
    sequence: completionEventSequence,
    settlement,
    span: copySpan(span),
  });
  const events: InterpreterEvent[] = [completionEvent];
  return pendingResult(current, events, { kind: "completed", settlement });
}

function validRequestedActionKind(
  value: unknown,
): value is "delay" | "interaction" | "chatPacingGate" {
  return value === "delay" || value === "interaction" || value === "chatPacingGate";
}

function completeInteraction(
  plan: InstructionPlan,
  current: RuntimeSnapshot,
  action: RuntimeInteractionActionSnapshot,
  request: Record<string, unknown>,
): PendingActionOperationResult<ActionCompletionOutcome> {
  if (request.interactionKind !== action.interactionKind) {
    const receivedInteractionKind = request.interactionKind;
    const receivedActionKind = receivedInteractionKind === "button" ||
      receivedInteractionKind === "text" ||
      receivedInteractionKind === "number" ||
      receivedInteractionKind === "choice"
      ? `interaction:${receivedInteractionKind}`
      : "<invalid>";
    return pendingResult(current, [], {
      kind: "wrongActionKind",
      actionId: action.actionId,
      expectedActionKind: "interaction",
      receivedActionKind,
    });
  }
  const resolved = resolveInteractionCompletion(action, request.payload);
  if (!resolved.ok) {
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: resolved.message,
    });
  }
  assertEventSequenceCapacity(current, 2);
  if (action.destinationTemporary !== null && resolved.result !== null) {
    setTemporary(current.temporaries, action.destinationTemporary, resolved.result);
  }
  const transcriptSequence = takeSequence(current, 2);
  const completionSequence = takeSequence(current, 2);
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
  const handoff: RuntimeInteractionResultHandoffSnapshot | null =
    action.destinationTemporary === null || resolved.result === null
      ? null
      : Object.freeze({
          actionId: action.actionId,
          owningInstruction: action.owningInstruction,
          continuationInstruction: action.continuationInstruction,
          ownerCallFrameId: action.ownerCallFrameId,
          destinationTemporary: action.destinationTemporary,
          result: resolved.result,
        });
  current.foregroundAction = null;
  current.lastSettlement = settlement;
  current.interactionResultHandoff = handoff;
  current.terminalContinuationHandoff = terminalContinuationHandoffFor(plan, action);
  current.status = "running";
  current.nextInstruction = action.continuationInstruction;
  const span = plan.instructions[action.owningInstruction]?.span ?? plan.sourceSpan;
  const events: InterpreterEvent[] = [
    Object.freeze({
      kind: "playerTranscript",
      sequence: transcriptSequence,
      target: action.target,
      requestingSpeakerId: action.speakerId,
      text: resolved.transcriptText,
      span: copySpan(span),
    } satisfies PlayerTranscriptEvent),
    Object.freeze({
      kind: "actionCompleted",
      sequence: completionSequence,
      settlement,
      span: copySpan(span),
    } satisfies ActionCompletedEvent),
  ];
  return pendingResult(current, events, { kind: "completed", settlement });
}
