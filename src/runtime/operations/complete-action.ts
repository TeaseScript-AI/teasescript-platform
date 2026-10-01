import type { InstructionPlan } from "../../plan/model.js";
import { captureExternalData } from "../../external-data-capture.js";
import { type RuntimeInteractionResultHandoffSnapshot, type RuntimeSnapshot } from "../state.js";
import type {
  RuntimeActionSettlementSnapshot,
  RuntimeChatPacingGateActionSnapshot,
  RuntimeInteractionActionSnapshot,
} from "../actions/model.js";
import type { ActionCompletedEvent, InterpreterEvent, PlayerTranscriptEvent } from "../events.js";
import { resolveInteractionCompletion } from "../actions/interaction.js";
import type { ActionCompletionOutcome, PendingActionOperationResult } from "./model.js";
import { timerHandlerDispatchable } from "./timer-lifecycle.js";
import { settleBackgroundPacingGate } from "./pacing-gate.js";
import { terminalContinuationHandoffFor } from "./terminal-continuation.js";
import {
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
  const active =
    current.foregroundAction?.actionId === actionId
      ? current.foregroundAction
      : (current.backgroundActions.find((action) => action.actionId === actionId) ?? null);
  if (active === null) {
    if (
      current.callFrames.some(
        (frame) => frame.timerInterruption?.suspendedAction?.actionId === actionId,
      )
    ) {
      // An interrupted action is inert while a timer expiry block runs; it is not settled.
      return pendingResult(current, [], { kind: "suspendedAction" as const, actionId });
    }
    if (current.lastSettlement?.actionId === actionId) {
      return pendingResult(current, [], {
        kind: "alreadySettled",
        settlement: cloneSettlement(current.lastSettlement),
      });
    }
    const outcome =
      actionId < current.nextActionId
        ? { kind: "staleAction" as const, actionId }
        : { kind: "unknownAction" as const, actionId };
    return pendingResult(current, [], outcome);
  }
  if (active.kind === "timer" || active.kind === "delay") {
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "Waits and timers settle only through time observation and script operations.",
    });
  }
  if (active.kind === "media" || active.kind === "mediaPlayback") {
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "Media settles only through media load and progress reports and script operations.",
    });
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
  if (current.status === "failed") {
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "The session has failed and accepts no further input.",
    });
  }
  // Host input happens at the observed time: scene time must have caught up, and a due expiry block runs first.
  if (
    current.currentSessionTimeMs < current.observedSessionTimeMs ||
    timerHandlerDispatchable(current)
  ) {
    return pendingResult(current, [], { kind: "executionPending", actionId });
  }
  if (active.kind === "interaction") {
    return completeInteraction(captured.plan, current, active, value);
  }
  return completePacingGate(captured.plan, current, active, value);
}

function completePacingGate(
  plan: InstructionPlan,
  current: RuntimeSnapshot,
  action: RuntimeChatPacingGateActionSnapshot,
  request: Record<string, unknown>,
): PendingActionOperationResult<ActionCompletionOutcome> {
  if (!isPlainRecord(request.payload) || request.payload.kind !== "skip") {
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "Pacing completion payload must be a skip request.",
    });
  }
  if (!action.skippable) {
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "This pacing gate is not skippable.",
    });
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
  // A gate promoted by a pacing barrier carries no prepared output; the barrier runs again and then advances.
  if (action.preparedOutput !== null) {
    current.preparedSayOutput = action.preparedOutput;
    current.nextInstruction = action.preparedOutput.owningInstruction;
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

function validRequestedActionKind(value: unknown): value is "interaction" | "chatPacingGate" {
  return value === "interaction" || value === "chatPacingGate";
}

function completeInteraction(
  plan: InstructionPlan,
  current: RuntimeSnapshot,
  action: RuntimeInteractionActionSnapshot,
  request: Record<string, unknown>,
): PendingActionOperationResult<ActionCompletionOutcome> {
  if (request.interactionKind !== action.interactionKind) {
    const receivedInteractionKind = request.interactionKind;
    const receivedActionKind =
      receivedInteractionKind === "button" ||
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
    return pendingResult(current, [], { kind: "invalidPayload", message: resolved.message });
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
