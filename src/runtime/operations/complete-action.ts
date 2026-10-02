import type { InstructionPlan } from "../../plan/model.js";
import { captureExternalData } from "../../external-data-capture.js";
import { type RuntimeInteractionResultHandoffSnapshot, type RuntimeSnapshot } from "../state.js";
import type {
  RuntimeActionSettlementSnapshot,
  RuntimeCaptureActionSnapshot,
  RuntimeChatPacingGateActionSnapshot,
  RuntimeInteractionActionSnapshot,
} from "../actions/model.js";
import type {
  ActionCompletedEvent,
  DeveloperWarningEvent,
  InterpreterEvent,
  PlayerTranscriptEvent,
} from "../events.js";
import {
  captureUnavailableMessage,
  resolveCaptureCompletion,
  type CapturedMediaAdmission,
} from "../actions/capture.js";
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

export interface ActionCompletionOptions {
  /** Required to accept a captured photo; without it only an unavailable camera completes a capture. */
  readonly capturedMedia?: CapturedMediaAdmission;
}

export function completeAction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  request: unknown,
  options: ActionCompletionOptions = {},
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
  if (active.kind === "capture") {
    return completeCapture(captured.plan, current, active, value, options.capturedMedia);
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

function validRequestedActionKind(
  value: unknown,
): value is "interaction" | "chatPacingGate" | "capture" {
  return value === "interaction" || value === "chatPacingGate" || value === "capture";
}

/** Settles a capture: the admitted reference or `null`, with a developer warning when the camera was unavailable. */
function completeCapture(
  plan: InstructionPlan,
  current: RuntimeSnapshot,
  action: RuntimeCaptureActionSnapshot,
  request: Record<string, unknown>,
  admission: CapturedMediaAdmission | undefined,
): PendingActionOperationResult<ActionCompletionOutcome> {
  const resolved = resolveCaptureCompletion(request.payload, admission);
  if (!resolved.ok) {
    return pendingResult(current, [], { kind: "invalidPayload", message: resolved.message });
  }
  assertEventSequenceCapacity(current, resolved.unavailableReason === null ? 1 : 2);
  setTemporary(current.temporaries, action.destinationTemporary, resolved.result);
  const span = plan.instructions[action.owningInstruction]?.span ?? plan.sourceSpan;
  const events: InterpreterEvent[] = [];
  let warningSequence: number | null = null;
  if (resolved.unavailableReason !== null) {
    warningSequence = takeSequence(current, 2);
    events.push(
      Object.freeze({
        kind: "developerWarning",
        sequence: warningSequence,
        severity: "warning",
        code: "TSW014",
        message: captureUnavailableMessage(resolved.unavailableReason),
        span: copySpan(span),
      } satisfies DeveloperWarningEvent),
    );
  }
  const completionSequence = takeSequence(current, 2);
  const settlement: RuntimeActionSettlementSnapshot = Object.freeze({
    actionId: action.actionId,
    actionKind: "capture",
    capture: action.capture,
    settlementKind: "completed",
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    ownerCallFrameId: action.ownerCallFrameId,
    destinationTemporary: action.destinationTemporary,
    requestEventSequence: action.requestEventSequence,
    warningEventSequence: warningSequence,
    completionEventSequence: completionSequence,
    completedAtMs: current.currentSessionTimeMs,
    result: resolved.result,
    unavailableReason: resolved.unavailableReason,
  });
  current.foregroundAction = null;
  current.lastSettlement = settlement;
  // Like an interaction result, the canonical result is kept until its first consume.
  current.interactionResultHandoff = Object.freeze({
    actionId: action.actionId,
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    ownerCallFrameId: action.ownerCallFrameId,
    destinationTemporary: action.destinationTemporary,
    result: resolved.result,
  });
  current.status = "running";
  current.nextInstruction = action.continuationInstruction;
  events.push(
    Object.freeze({
      kind: "actionCompleted",
      sequence: completionSequence,
      settlement,
      span: copySpan(span),
    } satisfies ActionCompletedEvent),
  );
  return pendingResult(current, events, { kind: "completed", settlement });
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
