import { type InstructionPlan, mainSourceSpan } from "../../plan/model.js";
import { interruptFrame } from "../activations.js";
import { captureExternalData } from "../../external-data-capture.js";
import {
  currentTemporalContext,
  type RuntimeInteractionResultHandoffSnapshot,
  type RuntimeSnapshot,
} from "../state.js";
import type {
  RuntimeActionSettlementSnapshot,
  RuntimeCaptureActionSnapshot,
  RuntimeChatPacingGateActionSnapshot,
  RuntimeInteractionActionSettlementSnapshot,
  RuntimeInteractionActionSnapshot,
  RuntimeStorageWriteActionSnapshot,
} from "../actions/model.js";
import type {
  ActionCompletedEvent,
  DeveloperWarningEvent,
  InterpreterEvent,
  PlayerTranscriptEvent,
} from "../events.js";
import { writeScriptStorage } from "../script-storage.js";
import {
  captureUnavailableMessage,
  resolveCaptureCompletion,
  type CapturedMediaAdmission,
} from "../actions/capture.js";
import { resolveInteractionCompletion } from "../actions/interaction.js";
import type { ActionCompletionOutcome, PendingActionOperationResult } from "./model.js";
import { timerHandlerDispatchable } from "./timer-lifecycle.js";
import { settleBackgroundPacingGate } from "./pacing-gate.js";
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
    if (interruptFrame(current)?.timerInterruption?.suspendedAction?.actionId === actionId) {
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
  if (active.kind === "permanentButton") {
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "A permanent button is clicked with pressPermanentButton and removed by the script.",
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
  // A storage write settles at the current scene time: catch-up may hold behind it for a queued block.
  if (active.kind === "storageWrite") {
    return completeStorageWrite(captured.plan, current, active, value);
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
  const span = plan.instructions[action.owningInstruction]?.span ?? mainSourceSpan(plan);
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
): value is "interaction" | "chatPacingGate" | "storageWrite" | "capture" {
  return (
    value === "interaction" ||
    value === "chatPacingGate" ||
    value === "storageWrite" ||
    value === "capture"
  );
}

/**
 * The host reports whether it persisted a `save` or `delete`. Only a stored write changes the session's view; a
 * failed one keeps the previous value and warns.
 */
function completeStorageWrite(
  plan: InstructionPlan,
  current: RuntimeSnapshot,
  action: RuntimeStorageWriteActionSnapshot,
  request: Record<string, unknown>,
): PendingActionOperationResult<ActionCompletionOutcome> {
  const payload = request.payload;
  if (
    !isPlainRecord(payload) ||
    Object.keys(payload).length !== 1 ||
    (payload.kind !== "stored" && payload.kind !== "failed")
  ) {
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "Storage write completion payload must be { kind: 'stored' } or { kind: 'failed' }.",
    });
  }
  const outcome = payload.kind;
  assertEventSequenceCapacity(current, outcome === "failed" ? 2 : 1);
  const span = copySpan(plan.instructions[action.owningInstruction]?.span ?? mainSourceSpan(plan));
  const events: InterpreterEvent[] = [];
  if (outcome === "stored") {
    writeScriptStorage(current, action.key, action.value);
  } else {
    events.push(
      Object.freeze({
        kind: "developerWarning",
        sequence: takeSequence(current, 2),
        severity: "warning",
        code: "TSW014",
        message: `${action.value === null ? "delete" : "save"} could not persist ${JSON.stringify(
          action.key,
        )}; the previous value is kept.`,
        span,
      } satisfies DeveloperWarningEvent),
    );
  }
  const settlement: RuntimeActionSettlementSnapshot = Object.freeze({
    actionId: action.actionId,
    actionKind: "storageWrite",
    settlementKind: "completed",
    outcome,
    key: action.key,
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    requestEventSequence: action.requestEventSequence,
    completionEventSequence: takeSequence(current, 2),
    completedAtMs: current.currentSessionTimeMs,
  });
  current.foregroundAction = null;
  current.lastSettlement = settlement;
  current.status = "running";
  current.nextInstruction = action.continuationInstruction;
  events.push(
    Object.freeze({
      kind: "actionCompleted",
      sequence: settlement.completionEventSequence,
      settlement,
      span,
    } satisfies ActionCompletedEvent),
  );
  return pendingResult(current, events, { kind: "completed", settlement });
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
  const reference = resolved.result;
  if (
    reference !== null &&
    action.tags !== null &&
    current.capturedImages.some((image) => image.reference === reference)
  ) {
    return pendingResult(current, [], {
      kind: "invalidPayload",
      message: "The captured photo is already in the image catalog.",
    });
  }
  assertEventSequenceCapacity(current, resolved.unavailableReason === null ? 1 : 2);
  setTemporary(current.temporaries, action.destinationTemporary, reference);
  // A photo taken with tags joins the image catalog, keyed by its reference, so tag queries find it too.
  if (reference !== null && action.tags !== null) {
    current.capturedImages.push({ reference, tags: action.tags.map((tag) => ({ ...tag })) });
  }
  const span = plan.instructions[action.owningInstruction]?.span ?? mainSourceSpan(plan);
  const events: InterpreterEvent[] = [];
  let warningSequence: number | null = null;
  if (resolved.unavailableReason !== null) {
    warningSequence = takeSequence(current, 2);
    events.push(
      Object.freeze({
        kind: "developerWarning",
        sequence: warningSequence,
        severity: "warning",
        code: "TSW015",
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
    actionKind: "capture",
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
      receivedInteractionKind === "choice" ||
      receivedInteractionKind === "temporal"
        ? `interaction:${receivedInteractionKind}`
        : "<invalid>";
    return pendingResult(current, [], {
      kind: "wrongActionKind",
      actionId: action.actionId,
      expectedActionKind: "interaction",
      receivedActionKind,
    });
  }
  const resolved = resolveInteractionCompletion(
    action,
    request.payload,
    currentTemporalContext(current),
  );
  if (!resolved.ok) {
    return pendingResult(current, [], { kind: "invalidPayload", message: resolved.message });
  }
  assertEventSequenceCapacity(current, 2);
  const transcriptSequence = takeSequence(current, 2);
  const completionSequence = takeSequence(current, 2);
  // A button used as a value yields the scene time it waited; it never exceeds the timeout.
  const result =
    action.expectedResult === "duration"
      ? Object.freeze({
          kind: "duration" as const,
          milliseconds: Math.min(
            current.currentSessionTimeMs - action.createdAtMs,
            action.timeoutMs ?? Infinity,
          ),
        })
      : resolved.result;
  const settlement = commitInteractionSettlement(current, action, {
    settlementKind: "completed",
    transcriptEventSequence: transcriptSequence,
    completionEventSequence: completionSequence,
    result,
    transcriptText: resolved.transcriptText,
  });
  const span = plan.instructions[action.owningInstruction]?.span ?? mainSourceSpan(plan);
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

/**
 * A button reaches its timeout during time observation. It completes normally without a player transcript, and a
 * button used as a value yields exactly its timeout.
 */
export function timeOutButton(
  plan: InstructionPlan,
  current: RuntimeSnapshot,
  action: RuntimeInteractionActionSnapshot,
  events: InterpreterEvent[],
): void {
  if (action.timeoutMs === null) throw new Error("Only a button with a timeout can time out.");
  const completionSequence = takeSequence(current, 2);
  const settlement = commitInteractionSettlement(current, action, {
    settlementKind: "timedOut",
    transcriptEventSequence: null,
    completionEventSequence: completionSequence,
    result:
      action.expectedResult === "duration"
        ? Object.freeze({ kind: "duration" as const, milliseconds: action.timeoutMs })
        : null,
    transcriptText: null,
  });
  events.push(
    Object.freeze({
      kind: "actionCompleted",
      sequence: completionSequence,
      settlement,
      span: copySpan(plan.instructions[action.owningInstruction]?.span ?? mainSourceSpan(plan)),
    } satisfies ActionCompletedEvent),
  );
}

/**
 * Settles the foreground interaction: writes its result to the destination temporary with the single-use handoff,
 * retains the settlement for replay, and makes the continuation eligible for a later runtime entry.
 */
function commitInteractionSettlement(
  current: RuntimeSnapshot,
  action: RuntimeInteractionActionSnapshot,
  outcome: Pick<
    RuntimeInteractionActionSettlementSnapshot,
    | "settlementKind"
    | "transcriptEventSequence"
    | "completionEventSequence"
    | "result"
    | "transcriptText"
  >,
): RuntimeInteractionActionSettlementSnapshot {
  const result = outcome.result;
  if (action.destinationTemporary !== null) {
    setTemporary(current.temporaries, action.destinationTemporary, result);
  }
  const settlement: RuntimeInteractionActionSettlementSnapshot = Object.freeze({
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: action.interactionKind,
    settlementKind: outcome.settlementKind,
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    ownerCallFrameId: action.ownerCallFrameId,
    destinationTemporary: action.destinationTemporary,
    requestEventSequence: action.requestEventSequence,
    transcriptEventSequence: outcome.transcriptEventSequence,
    completionEventSequence: outcome.completionEventSequence,
    result,
    transcriptText: outcome.transcriptText,
    ui: action.ui,
  });
  const handoff: RuntimeInteractionResultHandoffSnapshot | null =
    action.destinationTemporary === null
      ? null
      : Object.freeze({
          actionKind: "interaction",
          actionId: action.actionId,
          owningInstruction: action.owningInstruction,
          continuationInstruction: action.continuationInstruction,
          ownerCallFrameId: action.ownerCallFrameId,
          destinationTemporary: action.destinationTemporary,
          result,
        });
  current.foregroundAction = null;
  current.lastSettlement = settlement;
  current.interactionResultHandoff = handoff;
  current.status = "running";
  current.nextInstruction = action.continuationInstruction;
  return settlement;
}
