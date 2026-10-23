import type { DeveloperWarningCode } from "../../diagnostic-codes.js";
import { type InstructionPlan, type InteractionKind, mainSourceSpan } from "../../plan/model.js";
import { interruptFrame } from "../scopes/activations.js";
import { messageText } from "../values/text-length.js";
import { captureExternalData } from "../../external-data-capture.js";
import {
  currentTemporalContext,
  type RuntimeInteractionResultHandoffSnapshot,
  type RuntimeSnapshot,
} from "../snapshot/state.js";
import type {
  RuntimeActionSettlementSnapshot,
  RuntimeCaptureActionSnapshot,
  RuntimeChatPacingGateActionSnapshot,
  RuntimeFileStoreActionSnapshot,
  RuntimeInteractionActionSettlementSnapshot,
  RuntimeLockActionSnapshot,
  RuntimeInteractionActionSnapshot,
  RuntimeStorageWriteActionSnapshot,
} from "../actions/model.js";
import { interactionStartMs } from "../actions/model.js";
import { holdsCatchUp } from "../actions/interrupts.js";
import type {
  ActionCompletedEvent,
  DeveloperWarningEvent,
  InterpreterEvent,
  PlayerTranscriptEvent,
} from "../events.js";
import { writeOwnedScriptStorage } from "../host-data/script-storage.js";
import {
  captureUnavailableMessage,
  resolveCaptureCompletion,
  type CapturedMediaAdmission,
} from "../actions/capture.js";
import { resolveFileStoreCompletion } from "../actions/file-store.js";
import { resolveLockCompletion } from "../actions/lock.js";
import { resolveInteractionCompletion } from "../actions/interaction.js";
import { isInteractionKind } from "../actions/action-validation.js";
import { addStoredFile, addStoredFiles } from "../host-data/stored-files.js";
import { createCapturedSerializableList } from "../values/serializable-values.js";
import { formShownOptions, timedOutFormResult } from "../actions/form.js";
import type { ActionCompletionOutcome, PendingActionOperationResult } from "./model.js";
import { timerHandlerDispatchable } from "./timer-lifecycle.js";
import { answerPresentation } from "../message-presentation.js";
import { PLAYER } from "../../speaker-terms.js";
import {
  withDebugTrace,
  stateKey,
  type RuntimeDebugContext,
  type TraceStore,
} from "../debug/debug-trace.js";
import {
  assertEventSequenceCapacity,
  captureExecutableData,
  type CapturedExecutableData,
  cloneSettlement,
  pendingResult,
  positiveSafeInteger,
  setCapturedTemporary,
  takeSettlementSequence,
} from "./support.js";
import { copySpan } from "../../plan/source-location.js";
import { isPlainRecord } from "../values/plain-data.js";
import { randomDrawPending } from "./model.js";

export interface ActionCompletionOptions {
  /**
   * Required to accept a captured photo or an image answer; without it only an unavailable camera completes a capture,
   * and no image request completes.
   */
  readonly capturedMedia?: CapturedMediaAdmission;
  /** An opt-in debug trace that observes the operation (`docs/RUNTIME.md#debug-trace`). */
  readonly debugTrace?: RuntimeDebugContext;
}

export function completeAction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  request: unknown,
  options: ActionCompletionOptions = {},
): PendingActionOperationResult<ActionCompletionOutcome> {
  const captured = captureExecutableData(plan, snapshot);
  return withDebugTrace(options.debugTrace, captured.plan, snapshot, (trace) =>
    completeCapturedAction(captured, request, options, trace),
  );
}

/** Completes an action of engine-owned plan/state that already passed complete validation. */
export function completeValidatedAction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  request: unknown,
  options: ActionCompletionOptions = {},
): PendingActionOperationResult<ActionCompletionOutcome> {
  return withDebugTrace(options.debugTrace, plan, snapshot, (trace) =>
    completeCapturedAction({ plan, snapshot }, request, options, trace),
  );
}

function completeCapturedAction(
  captured: CapturedExecutableData,
  request: unknown,
  options: ActionCompletionOptions,
  trace: TraceStore | null,
): PendingActionOperationResult<ActionCompletionOutcome> {
  const current = captured.snapshot;
  const paused = randomDrawPending(current);
  if (paused !== null) return pendingResult(current, [], paused);
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
  // Host input happens at the observed time: scene time must have caught up, and a due expiry block runs first. An action
  // that holds catch-up for a queued block settles at the current scene time instead, before the block runs.
  if (
    !holdsCatchUp(active) &&
    (current.currentSessionTimeMs < current.observedSessionTimeMs ||
      timerHandlerDispatchable(current))
  ) {
    return pendingResult(current, [], { kind: "executionPending", actionId });
  }
  if (active.kind === "storageWrite") {
    return completeStorageWrite(captured.plan, current, active, value, trace);
  }
  trace?.at(active.owningInstruction, current.currentSessionTimeMs);
  if (active.kind === "interaction") {
    return completeInteraction(captured.plan, current, active, value, options.capturedMedia, trace);
  }
  if (active.kind === "capture") {
    return completeCapture(captured.plan, current, active, value, options.capturedMedia, trace);
  }
  if (active.kind === "fileStore") {
    return completeFileStore(captured.plan, current, active, value, options.capturedMedia);
  }
  if (active.kind === "lock") {
    return completeLock(captured.plan, current, active, value, options.capturedMedia);
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
  assertEventSequenceCapacity(current, 1);
  const completionEventSequence = takeSettlementSequence(current, action);
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
  });
  current.foregroundAction = null;
  current.lastSettlement = settlement;
  current.status = "running";
  current.nextInstruction = action.continuationInstruction;
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
): value is "interaction" | "chatPacingGate" | "storageWrite" | "capture" | "fileStore" | "lock" {
  return (
    value === "interaction" ||
    value === "chatPacingGate" ||
    value === "storageWrite" ||
    value === "capture" ||
    value === "fileStore" ||
    value === "lock"
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
  trace: TraceStore | null,
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
  trace?.at(action.owningInstruction, current.currentSessionTimeMs);
  trace?.storageSettled(action.actionId, outcome === "stored");
  if (outcome === "stored") {
    // The action holds the value copied when the save ran, and is dropped below, so storage takes that copy.
    writeOwnedScriptStorage(current, action.key, action.value);
  } else {
    events.push(
      Object.freeze({
        kind: "developerWarning",
        sequence: takeSettlementSequence(current, action),
        severity: "warning",
        code: "TSW014" satisfies DeveloperWarningCode,
        message: `${action.value === null ? "delete" : "save"} could not persist ${JSON.stringify(
          messageText(action.key),
        )}, so the previous value is kept.`,
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
    completionEventSequence: takeSettlementSequence(current, action),
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
  trace: TraceStore | null,
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
  // The admitted reference is text the request gave, captured with it.
  setCapturedTemporary(current.temporaries, action.destinationTemporary, reference);
  const input = trace?.writeTemporary(
    action.ownerCallFrameId ?? 0,
    action.destinationTemporary,
    reference,
    "input",
    Object.freeze({
      kind: "input",
      actionId: action.actionId,
      actionKind: "capture",
      interactionKind: null,
      outcome: "completed",
    }),
  );
  // A photo is a stored file, which `toJson` writes as a data URL.
  if (reference !== null) addStoredFile(current.storedFiles, reference);
  // A photo taken with tags joins the image catalog, keyed by its reference, so tag queries find it too.
  if (reference !== null && action.tags !== null) {
    current.capturedImages.push({ reference, tags: action.tags.map((tag) => ({ ...tag })) });
    trace?.replace(input ?? null);
    // The catalog accumulates: a tag query may pick any photo taken so far.
    trace?.writeState(
      "mutation",
      stateKey("photos"),
      "whole",
      "tagged photos",
      reference,
      null,
      true,
    );
  }
  const span = plan.instructions[action.owningInstruction]?.span ?? mainSourceSpan(plan);
  const events: InterpreterEvent[] = [];
  let warningSequence: number | null = null;
  if (resolved.unavailableReason !== null) {
    warningSequence = takeSettlementSequence(current, action);
    events.push(
      Object.freeze({
        kind: "developerWarning",
        sequence: warningSequence,
        severity: "warning",
        code: "TSW015" satisfies DeveloperWarningCode,
        message: captureUnavailableMessage(resolved.unavailableReason),
        span: copySpan(span),
      } satisfies DeveloperWarningEvent),
    );
  }
  const completionSequence = takeSettlementSequence(current, action);
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

/**
 * Settles a file store with the Player's answer, which is handed off to its instruction; that runs again and gives the
 * result. Stored files become files this session knows.
 */
function completeFileStore(
  plan: InstructionPlan,
  current: RuntimeSnapshot,
  action: RuntimeFileStoreActionSnapshot,
  request: Record<string, unknown>,
  admission: CapturedMediaAdmission | undefined,
): PendingActionOperationResult<ActionCompletionOutcome> {
  const resolved = resolveFileStoreCompletion(request.payload, action, admission);
  if (!resolved.ok) {
    return pendingResult(current, [], { kind: "invalidPayload", message: resolved.message });
  }
  assertEventSequenceCapacity(current, 1);
  const stored = resolved.outcome === "stored" ? (resolved.answer ?? []) : [];
  addStoredFiles(current.storedFiles, stored);
  const completionSequence = takeSettlementSequence(current, action);
  const settlement: RuntimeActionSettlementSnapshot = Object.freeze({
    actionId: action.actionId,
    actionKind: "fileStore",
    settlementKind: "completed",
    outcome: resolved.outcome,
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    ownerCallFrameId: action.ownerCallFrameId,
    destinationTemporary: action.destinationTemporary,
    requestEventSequence: action.requestEventSequence,
    completionEventSequence: completionSequence,
    completedAtMs: current.currentSessionTimeMs,
    references: [...stored],
  });
  current.foregroundAction = null;
  current.lastSettlement = settlement;
  // The instruction runs again with the answer before anything else, as a result is consumed.
  current.interactionResultHandoff = Object.freeze({
    actionKind: "fileStore",
    actionId: action.actionId,
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    ownerCallFrameId: action.ownerCallFrameId,
    destinationTemporary: action.destinationTemporary,
    result: resolved.answer === null ? null : createCapturedSerializableList([...resolved.answer]),
  });
  current.status = "running";
  current.nextInstruction = action.continuationInstruction;
  const span = plan.instructions[action.owningInstruction]?.span ?? mainSourceSpan(plan);
  const events: InterpreterEvent[] = [
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
 * Settles a step of a lock with the Player's answer, which is handed off to its instruction; that runs again and gives
 * the result or waits in the next step. A stored file the Player kept becomes a file this session knows.
 */
function completeLock(
  plan: InstructionPlan,
  current: RuntimeSnapshot,
  action: RuntimeLockActionSnapshot,
  request: Record<string, unknown>,
  admission: CapturedMediaAdmission | undefined,
): PendingActionOperationResult<ActionCompletionOutcome> {
  const resolved = resolveLockCompletion(request.payload, action, admission);
  if (!resolved.ok) {
    return pendingResult(current, [], { kind: "invalidPayload", message: resolved.message });
  }
  assertEventSequenceCapacity(current, 1);
  if (resolved.stored !== null) addStoredFile(current.storedFiles, resolved.stored);
  const completionSequence = takeSettlementSequence(current, action);
  const settlement: RuntimeActionSettlementSnapshot = Object.freeze({
    actionId: action.actionId,
    actionKind: "lock",
    settlementKind: "completed",
    outcome: resolved.outcome,
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    ownerCallFrameId: action.ownerCallFrameId,
    destinationTemporary: action.destinationTemporary,
    requestEventSequence: action.requestEventSequence,
    completionEventSequence: completionSequence,
    completedAtMs: current.currentSessionTimeMs,
    file: resolved.stored,
  });
  current.foregroundAction = null;
  current.lastSettlement = settlement;
  // The instruction runs again with the answer before anything else, as a result is consumed.
  current.interactionResultHandoff = Object.freeze({
    actionKind: "lock",
    actionId: action.actionId,
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    ownerCallFrameId: action.ownerCallFrameId,
    destinationTemporary: action.destinationTemporary,
    result: createCapturedSerializableList(
      resolved.detail === null ? [resolved.outcome] : [resolved.outcome, resolved.detail],
    ),
  });
  current.status = "running";
  current.nextInstruction = action.continuationInstruction;
  const span = plan.instructions[action.owningInstruction]?.span ?? mainSourceSpan(plan);
  const events: InterpreterEvent[] = [
    Object.freeze({
      kind: "actionCompleted",
      sequence: completionSequence,
      settlement,
      span: copySpan(span),
    } satisfies ActionCompletedEvent),
  ];
  return pendingResult(current, events, { kind: "completed", settlement });
}

function completeInteraction(
  plan: InstructionPlan,
  current: RuntimeSnapshot,
  action: RuntimeInteractionActionSnapshot,
  request: Record<string, unknown>,
  capturedMedia: CapturedMediaAdmission | undefined,
  trace: TraceStore | null,
): PendingActionOperationResult<ActionCompletionOutcome> {
  if (request.interactionKind !== action.interactionKind) {
    const receivedInteractionKind = request.interactionKind;
    const receivedActionKind = isInteractionKind(receivedInteractionKind)
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
    capturedMedia,
  );
  if (!resolved.ok) {
    return pendingResult(current, [], { kind: "invalidPayload", message: resolved.message });
  }
  // A popup, an `openUrl`, an `exportText`, or an `askPassword` adds nothing to the transcript, so only its completion
  // takes a sequence.
  const transcriptText = resolved.transcriptText;
  assertEventSequenceCapacity(current, transcriptText === null ? 1 : 2);
  const transcriptSequence =
    transcriptText === null ? null : takeSettlementSequence(current, action);
  const completionSequence = takeSettlementSequence(current, action);
  // A button or popup used as a value yields the scene time it waited; it never exceeds a button's timeout.
  const result =
    action.expectedResult === "duration"
      ? Object.freeze({
          kind: "duration" as const,
          milliseconds: Math.min(
            current.currentSessionTimeMs - interactionStartMs(action),
            action.timeoutMs ?? Infinity,
          ),
        })
      : resolved.result;
  const settlement = commitInteractionSettlement(
    current,
    action,
    {
      settlementKind: "completed",
      transcriptEventSequence: transcriptSequence,
      completionEventSequence: completionSequence,
      result,
      transcriptText,
      ...(resolved.shownOptions === undefined ? {} : { shownOptions: resolved.shownOptions }),
    },
    trace,
  );
  const span = plan.instructions[action.owningInstruction]?.span ?? mainSourceSpan(plan);
  const events: InterpreterEvent[] = [
    ...(transcriptText === null || transcriptSequence === null
      ? []
      : [
          Object.freeze({
            kind: "playerTranscript",
            sequence: transcriptSequence,
            target: action.target,
            requestingSpeakerId: action.speakerId,
            text: transcriptText,
            presentation: answerPresentation(
              current.speakers.find((speaker) => speaker.identifier === PLAYER) ?? null,
              copySpan(span),
            ),
            span: copySpan(span),
          } satisfies PlayerTranscriptEvent),
        ]),
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
 * A button or form reaches its timeout during time observation. It completes normally without a player transcript; a
 * button used as a value yields exactly its timeout, and a form its answers as they stand or `null`, as its
 * `onTimeout` says.
 */
export function timeOutButton(
  plan: InstructionPlan,
  current: RuntimeSnapshot,
  action: RuntimeInteractionActionSnapshot,
  events: InterpreterEvent[],
  trace: TraceStore | null = null,
): void {
  if (action.timeoutMs === null) throw new Error("Only a button with a timeout can time out.");
  const completionSequence = takeSettlementSequence(current, action);
  // A form returns its answers as they stand, with the options its cycles show, or `null`.
  const form =
    action.ui.kind === "form" && action.form !== undefined
      ? { ui: action.ui, state: action.form }
      : null;
  const formResult = form === null ? undefined : timedOutFormResult(form.ui, form.state);
  const settlement = commitInteractionSettlement(
    current,
    action,
    {
      settlementKind: "timedOut",
      transcriptEventSequence: null,
      completionEventSequence: completionSequence,
      result:
        formResult !== undefined
          ? formResult
          : action.expectedResult === "duration"
            ? Object.freeze({ kind: "duration" as const, milliseconds: action.timeoutMs })
            : null,
      transcriptText: null,
      ...(form === null
        ? {}
        : {
            shownOptions: formResult === null ? null : formShownOptions(form.ui, form.state.values),
          }),
    },
    trace,
  );
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
    | "shownOptions"
  >,
  trace: TraceStore | null,
): RuntimeInteractionActionSettlementSnapshot {
  const result = outcome.result;
  if (action.destinationTemporary !== null) {
    // The settlement and the handoff hold the result too, so the temporary takes its own copy.
    resultBuiltByRuntime(action.interactionKind);
    setCapturedTemporary(current.temporaries, action.destinationTemporary, result);
    // Only an accepted answer or a timeout reaches here; refused and repeated reports record nothing.
    trace?.writeTemporary(
      action.ownerCallFrameId ?? 0,
      action.destinationTemporary,
      result,
      "input",
      Object.freeze({
        kind: "input",
        actionId: action.actionId,
        actionKind: "interaction",
        interactionKind: action.interactionKind,
        outcome: outcome.settlementKind,
      }),
    );
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
    // A form records the options its cycles showed, which its result cannot always tell.
    ...(action.ui.kind === "form" ? { shownOptions: outcome.shownOptions ?? null } : {}),
  });
  // An image answer is a stored file, which `toJson` writes as a data URL.
  if (action.ui.kind === "image" && typeof result === "string")
    addStoredFile(current.storedFiles, result);
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

/**
 * Every interaction kind's result is built by the runtime from the captured request or the action's own validated
 * data, so a temporary copies it without capturing it again. A new kind fails here until its result is classified.
 */
function resultBuiltByRuntime(kind: InteractionKind): void {
  switch (kind) {
    case "button":
    case "text":
    case "number":
    case "choice":
    case "temporal":
    case "password":
    case "image":
    case "form":
    case "popup":
    case "url":
    case "export":
      return;
    default: {
      const unclassified: never = kind;
      throw new Error(
        `The result of an interaction of kind '${String(unclassified)}' is not classified.`,
      );
    }
  }
}
