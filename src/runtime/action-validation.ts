import type { TemporalContext } from "../temporal.js";
import {
  temporalCaptureShownAt,
  temporalCapturesProblem,
  type RuntimeTemporalCapture,
} from "./temporal-captures.js";
import { isNormalizedOpaqueColor, normalizeOpaqueColor } from "../color.js";
import { isIntegerAnswerText, isValidInteractionPrefill } from "../interaction-answers.js";
import { isInteractionChoiceValue } from "../choice-values.js";
import { expandChoiceOptions } from "./choice-options.js";
import { RuntimeFault } from "./errors.js";
import {
  serializableEquals,
  validateCapturedSerializableValue,
  type SerializableRuntimeValue,
} from "./serializable-values.js";
import { isOneOf } from "../plan/validation-support.js";
import { isMessagePresentation } from "../message-presentation.js";
import {
  type Instruction,
  type InstructionPlan,
  type InteractionChoiceOption,
  type InteractionKind,
  type InteractionTemporalKind,
  type InteractionUiPayload,
  type PlanSourceLocation,
  mainRootEnd,
} from "../plan/model.js";
import {
  boundedInteractionUtf8ByteLength,
  interactionStringFits,
  interactionStringHasNonWhitespace,
  MAX_INTERACTION_AGGREGATE_UTF8_BYTES,
  MAX_INTERACTION_OPTION_ENTRIES,
} from "../interaction-limits.js";
import { isMessageMarkup } from "../message-markup.js";
import type { RuntimeChatPacingGateSettlementSnapshot } from "./actions/model.js";
import { requiredActionCompletionEvents } from "./actions/model.js";
import { buttonTimeoutMilliseconds } from "./actions/interaction.js";
import { recordValidationTestWork } from "../validation-testing.js";
import { validMediaAction } from "./media-validation.js";
import { validTimerAction } from "./timer-validation.js";
import { validateScriptStorageEntries } from "./script-storage.js";

interface ActionValidationAnalysis {
  readonly functionIdsByInstruction: readonly (number | null)[];
}

const MAX_RUNTIME_SESSION_TIME_MS = Number.MAX_SAFE_INTEGER;

function validSessionTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_RUNTIME_SESSION_TIME_MS
  );
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 1;
}

function hasEventSequenceCapacity(value: unknown, count: number): boolean {
  return positiveSafeInteger(value) && value <= Number.MAX_SAFE_INTEGER - count;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  // EVIDENCE: validation: Number.isSafeInteger establishes the numeric value before comparison.
  return Number.isSafeInteger(value) && (value as number) >= 0;
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

/**
 * A persisted runtime array must preserve its complete own-key shape through
 * JSON serialization. Array indexes and `length` are canonical; custom own
 * properties would be silently omitted by JSON.stringify.
 */
function isCanonicalJsonArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }

  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !isCanonicalArrayIndexKey(key, value.length)) {
      return false;
    }
  }
  return true;
}

function isCanonicalArrayIndexKey(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

export function validatePendingActionState(
  value: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  analysis: ActionValidationAnalysis | undefined,
  errors: string[],
): void {
  if (!validSessionTime(value.currentSessionTimeMs))
    errors.push("Runtime currentSessionTimeMs is outside the supported range.");
  if (
    !validSessionTime(value.observedSessionTimeMs) ||
    !validSessionTime(value.currentSessionTimeMs) ||
    value.observedSessionTimeMs < value.currentSessionTimeMs ||
    (value.observedSessionTimeMs > value.currentSessionTimeMs &&
      value.status !== "failed" &&
      !catchUpPaused(value))
  ) {
    errors.push(
      "Runtime observedSessionTimeMs must not precede scene time, and exceeds it only while execution can continue.",
    );
  }
  if (!validBackgroundPacingActions(value, plan)) {
    errors.push("Runtime backgroundActions are malformed.");
  }
  if (!positiveSafeInteger(value.nextActionId))
    errors.push("Runtime nextActionId must be a positive safe integer.");
  const action = value.foregroundAction;
  if (action !== null && !validForegroundActionState(action, value, plan, catchUpPaused(value))) {
    errors.push("Runtime foreground action is malformed.");
  }
  const settlement = value.lastSettlement;
  if (!validRetainedSettlement(settlement, value, plan, analysis)) {
    errors.push("Runtime lastSettlement is malformed.");
  }
  if (!validActiveActionIdentityCoherence(value)) {
    errors.push(
      "Runtime active action identities are inconsistent with each other or the retained settlement.",
    );
  }
  if (!validActiveActionLocationCoherence(value)) {
    errors.push("Runtime foreground and background action locations are incoherent.");
  }
  if (!validActiveActionCompletionCapacity(value)) {
    errors.push("Runtime active actions cannot reserve their required completion events.");
  }
}

/**
 * Active actions reserve their unavoidable future events. This is aggregate:
 * a foreground delay and a background pacing gate may complete in one time
 * observation and must both remain representable.
 */
function validActiveActionCompletionCapacity(snapshot: Record<string, unknown>): boolean {
  const backgroundActions = Array.isArray(snapshot.backgroundActions)
    ? snapshot.backgroundActions
    : [];
  const actions = [snapshot.foregroundAction, ...backgroundActions, ...suspendedActions(snapshot)];
  const requiredCompletionEvents = actions.reduce(
    (count, action) => count + (isPlainRecord(action) ? requiredActionCompletionEvents(action) : 0),
    0,
  );
  return hasEventSequenceCapacity(snapshot.nextEventSequence, requiredCompletionEvents);
}

function validBackgroundPacingActions(
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  const actions = snapshot.backgroundActions;
  if (!isCanonicalJsonArray(actions)) return false;

  let pacingGates = 0;
  let previousActionId = 0;
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (!isPlainRecord(action)) return false;
    if (action.kind === "timer") {
      if (!validTimerAction(action, snapshot, plan)) return false;
    } else if (action.kind === "media") {
      if (!validMediaAction(action, snapshot, plan)) return false;
    } else {
      pacingGates += 1;
      if (pacingGates > 1 || !validPacingGateAction(action, snapshot, plan, false)) return false;
    }
    // Background work is kept in creation order.
    if (!positiveSafeInteger(action.actionId) || action.actionId <= previousActionId) return false;
    previousActionId = action.actionId;
  }
  return true;
}

function validForegroundActionKind(
  action: unknown,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  delayTimesAreValid: boolean,
  allowDue: boolean,
): boolean {
  if (!isPlainRecord(action)) return false;
  if (action.kind === "delay") {
    return (
      delayTimesAreValid &&
      action.expectedCompletion === "time" &&
      hasEventSequenceCapacity(snapshot.nextEventSequence, 1)
    );
  }
  if (action.kind === "interaction") {
    return (
      validInteractionAction(action, snapshot, plan, allowDue) &&
      hasEventSequenceCapacity(snapshot.nextEventSequence, 2)
    );
  }
  if (action.kind === "chatPacingGate") {
    return (
      validPacingGateAction(action, snapshot, plan, true) &&
      hasEventSequenceCapacity(snapshot.nextEventSequence, 1)
    );
  }
  if (action.kind === "mediaPlayback") {
    return (
      validMediaPlaybackAction(action, snapshot) &&
      hasEventSequenceCapacity(snapshot.nextEventSequence, 1)
    );
  }
  if (action.kind === "storageWrite") {
    return (
      validStorageWriteAction(action, snapshot) &&
      hasEventSequenceCapacity(snapshot.nextEventSequence, 2)
    );
  }
  return false;
}

/** A pending `save`/`delete` exists only for persistent storage and carries a storable value or `null`. */
function validStorageWriteAction(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): boolean {
  return (
    hasExactKeys(action, [
      "kind",
      "actionId",
      "owningInstruction",
      "continuationInstruction",
      "ownerCallFrameId",
      "scopeDepth",
      "loopDepth",
      "createdAtMs",
      "key",
      "value",
      "requestEventSequence",
    ]) &&
    snapshot.scriptStoragePersistent === true &&
    typeof action.key === "string" &&
    (action.value === null ||
      validateScriptStorageEntries([{ key: action.key, value: action.value }], "value") === null) &&
    validSessionTime(action.createdAtMs) &&
    validSessionTime(snapshot.currentSessionTimeMs) &&
    action.createdAtMs <= snapshot.currentSessionTimeMs
  );
}

function validRetainedSettlement(
  settlement: unknown,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  analysis: ActionValidationAnalysis | undefined,
): boolean {
  if (!isPlainRecord(settlement)) return settlement === null;
  if (!validSettlementShapeAndKind(settlement, snapshot, plan, analysis)) return false;
  return validSettlementIdentityAndEventSequences(settlement, snapshot);
}

function validSettlementShapeAndKind(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  analysis: ActionValidationAnalysis | undefined,
): boolean {
  return (
    isOneOf(settlement.actionKind, [
      "delay",
      "interaction",
      "chatPacingGate",
      "mediaPlayback",
      "storageWrite",
    ]) &&
    (settlement.actionKind === "chatPacingGate" ||
      settlement.settlementKind === "completed" ||
      (settlement.actionKind === "interaction" &&
        settlement.interactionKind === "button" &&
        settlement.settlementKind === "timedOut")) &&
    positiveSafeInteger(settlement.actionId) &&
    validSettlementProvenance(settlement, plan) &&
    validSettlementKindData(settlement, snapshot, plan, analysis)
  );
}

function validSettlementIdentityAndEventSequences(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): boolean {
  if (
    !positiveSafeInteger(settlement.actionId) ||
    !positiveSafeInteger(settlement.requestEventSequence) ||
    !positiveSafeInteger(settlement.completionEventSequence) ||
    !positiveSafeInteger(snapshot.nextActionId) ||
    !positiveSafeInteger(snapshot.nextEventSequence) ||
    settlement.actionId >= snapshot.nextActionId ||
    settlement.requestEventSequence >= settlement.completionEventSequence ||
    settlement.completionEventSequence >= snapshot.nextEventSequence
  )
    return false;

  if (settlement.actionKind !== "interaction") return true;
  // A button that timed out publishes no player transcript.
  if (settlement.settlementKind === "timedOut") return settlement.transcriptEventSequence === null;
  return (
    positiveSafeInteger(settlement.transcriptEventSequence) &&
    settlement.requestEventSequence < settlement.transcriptEventSequence &&
    settlement.transcriptEventSequence < settlement.completionEventSequence
  );
}

function validActiveActionIdentityCoherence(snapshot: Record<string, unknown>): boolean {
  const actions = [
    snapshot.foregroundAction,
    ...(Array.isArray(snapshot.backgroundActions) ? snapshot.backgroundActions : []),
    ...suspendedActions(snapshot),
  ].filter(isPlainRecord);
  // Timers outlive later settlements, and an expiry block can settle newer actions before an interrupted older one
  // resumes. Active actions therefore need unique identities that differ from the retained settlement, not a younger
  // history.
  const actionIds = new Set<number>();
  const requestSequences = new Set<number>();
  const settlement = isPlainRecord(snapshot.lastSettlement) ? snapshot.lastSettlement : null;

  for (const action of actions) {
    if (!positiveSafeInteger(action.actionId) || !positiveSafeInteger(action.requestEventSequence))
      return false;
    if (actionIds.has(action.actionId) || requestSequences.has(action.requestEventSequence))
      return false;
    if (settlement !== null && !validActiveActionEventIdentity(action, settlement)) return false;
    actionIds.add(action.actionId);
    requestSequences.add(action.requestEventSequence);
  }
  return true;
}

/**
 * Validates one foreground action against the execution context in `snapshot`. `allowDue` admits a delay due exactly
 * now that settles after the execution pending at this scene time, or one suspended by an expiry block.
 */
export function validForegroundActionState(
  action: unknown,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  allowDue: boolean,
): boolean {
  const callIds = Array.isArray(snapshot.callFrames)
    ? new Set(snapshot.callFrames.filter(isPlainRecord).map((frame) => frame.id))
    : new Set<unknown>();
  const currentSessionTimeMs = snapshot.currentSessionTimeMs;
  const delayTimesAreValid =
    isPlainRecord(action) &&
    action.kind === "delay" &&
    hasExactKeys(action, [
      "kind",
      "actionId",
      "owningInstruction",
      "continuationInstruction",
      "ownerCallFrameId",
      "scopeDepth",
      "loopDepth",
      "createdAtMs",
      "deadlineMs",
      "expectedCompletion",
      "display",
      "label",
      "requestEventSequence",
    ]) &&
    (action.display === "hidden" || action.display === "visible" || action.display === "mystery") &&
    (action.label === null || typeof action.label === "string") &&
    validSessionTime(action.createdAtMs) &&
    validSessionTime(action.deadlineMs) &&
    validSessionTime(currentSessionTimeMs) &&
    action.createdAtMs <= currentSessionTimeMs &&
    (action.deadlineMs > currentSessionTimeMs ||
      (allowDue && action.deadlineMs === currentSessionTimeMs));
  return (
    validForegroundActionBase(action, snapshot, callIds) &&
    validForegroundActionKind(action, snapshot, plan, delayTimesAreValid, allowDue) &&
    (plan === undefined ||
      (isPlainRecord(action) && validForegroundActionOwnership(action, snapshot, plan)))
  );
}

/**
 * Mirrors the engine's pause of catch-up toward the observed time: the script or a queued expiry block can execute,
 * or a queued block waits for a pending storage write. Only then may scene time stand behind the observed time, and
 * timed work due exactly now wait for that execution.
 */
export function catchUpPaused(snapshot: Record<string, unknown>): boolean {
  if (snapshot.status === "ready" || snapshot.status === "running") return true;
  if (
    snapshot.status === "waiting" &&
    isPlainRecord(snapshot.foregroundAction) &&
    snapshot.foregroundAction.kind === "storageWrite" &&
    Array.isArray(snapshot.pendingTimerHandlers) &&
    snapshot.pendingTimerHandlers.length > 0
  )
    return true;
  if (
    snapshot.status !== "waiting" ||
    !Array.isArray(snapshot.callFrames) ||
    !Array.isArray(snapshot.pendingTimerHandlers) ||
    snapshot.pendingTimerHandlers.length === 0 ||
    snapshot.callFrames.some(
      (frame) => isPlainRecord(frame) && isPlainRecord(frame.timerInterruption),
    ) ||
    snapshot.preparedSayOutput !== null ||
    snapshot.interactionResultHandoff !== null ||
    snapshot.terminalContinuationHandoff !== null
  )
    return false;
  const foreground = snapshot.foregroundAction;
  return (
    foreground === null ||
    (isPlainRecord(foreground) &&
      (foreground.kind === "delay" ||
        foreground.kind === "interaction" ||
        foreground.kind === "mediaPlayback"))
  );
}

/** Foreground actions held by an interrupting timer expiry block. */
function suspendedActions(snapshot: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(snapshot.callFrames)) return [];
  return snapshot.callFrames.flatMap((frame) =>
    isPlainRecord(frame) &&
    isPlainRecord(frame.timerInterruption) &&
    isPlainRecord(frame.timerInterruption.suspendedAction)
      ? [frame.timerInterruption.suspendedAction]
      : [],
  );
}

function validActiveActionLocationCoherence(snapshot: Record<string, unknown>): boolean {
  const backgroundActions = snapshot.backgroundActions;
  if (!Array.isArray(backgroundActions)) return false;

  const backgroundPacingActions: Record<string, unknown>[] = [];
  for (let index = 0; index < backgroundActions.length; index += 1) {
    if (!Object.hasOwn(backgroundActions, index)) continue;
    const action = backgroundActions[index];
    if (isPlainRecord(action) && action.kind === "chatPacingGate") {
      backgroundPacingActions.push(action);
    }
  }
  const foregroundAction = isPlainRecord(snapshot.foregroundAction)
    ? snapshot.foregroundAction
    : null;
  const foregroundPacingGateCount = foregroundAction?.kind === "chatPacingGate" ? 1 : 0;
  const activePacingGateCount = backgroundPacingActions.length + foregroundPacingGateCount;

  if (activePacingGateCount > 1) {
    return false;
  }
  if (foregroundAction?.kind === "interaction") {
    return backgroundPacingActions.length === 0;
  }
  if (foregroundAction?.kind !== "delay") return true;
  if (backgroundPacingActions.length === 0) return true;

  // After an expiry block returns to a delay, its own paced output may have left a newer background gate, so the gate
  // and the delay have no required age order.
  return true;
}

function validActiveActionEventIdentity(
  action: Record<string, unknown>,
  settlement: Record<string, unknown>,
): boolean {
  const actionId = action.actionId;
  const requestEventSequence = action.requestEventSequence;
  const settlementActionId = settlement.actionId;
  const settlementRequestEventSequence = settlement.requestEventSequence;
  const settlementCompletionEventSequence = settlement.completionEventSequence;
  if (
    !positiveSafeInteger(actionId) ||
    !positiveSafeInteger(requestEventSequence) ||
    !positiveSafeInteger(settlementActionId) ||
    !positiveSafeInteger(settlementRequestEventSequence) ||
    !positiveSafeInteger(settlementCompletionEventSequence)
  )
    return false;
  if (actionId === settlementActionId) return false;
  const retainedEventSequences = new Set<number>(
    [settlementRequestEventSequence, settlementCompletionEventSequence].filter(positiveSafeInteger),
  );
  if (
    settlement.actionKind === "interaction" &&
    positiveSafeInteger(settlement.transcriptEventSequence)
  ) {
    retainedEventSequences.add(settlement.transcriptEventSequence);
  }
  return !retainedEventSequences.has(requestEventSequence);
}

function validActionCreatedAfterSettlement(
  action: Record<string, unknown>,
  settlement: Record<string, unknown>,
): boolean {
  const actionId = action.actionId;
  const requestEventSequence = action.requestEventSequence;
  const settlementActionId = settlement.actionId;
  const settlementCompletionEventSequence = settlement.completionEventSequence;
  return (
    positiveSafeInteger(actionId) &&
    positiveSafeInteger(requestEventSequence) &&
    positiveSafeInteger(settlementActionId) &&
    positiveSafeInteger(settlementCompletionEventSequence) &&
    actionId > settlementActionId &&
    requestEventSequence > settlementCompletionEventSequence
  );
}

/** An async play's wait ends with its load result; a blocking play's wait ends with its media. */
function validMediaWaitOutcome(
  settlement: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  if (plan === undefined || !nonNegativeSafeInteger(settlement.owningInstruction)) return true;
  const owner = plan.instructions[settlement.owningInstruction];
  if (owner?.kind !== "playMedia") return false;
  return owner.async
    ? settlement.outcome === "loaded" || settlement.outcome === "failed"
    : settlement.outcome !== "loaded";
}

/**
 * A script waiting on media: an async play waits for its unloaded media's load result, a blocking play for its active
 * media to end. The media record is validated with the media state.
 */
function validMediaPlaybackAction(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): boolean {
  if (
    !hasExactKeys(action, [
      "kind",
      "actionId",
      "owningInstruction",
      "continuationInstruction",
      "ownerCallFrameId",
      "scopeDepth",
      "loopDepth",
      "createdAtMs",
      "mediaId",
      "until",
      "requestEventSequence",
    ]) ||
    (action.until !== "loaded" && action.until !== "ended") ||
    !positiveSafeInteger(action.mediaId) ||
    !validSessionTime(action.createdAtMs) ||
    !validSessionTime(snapshot.currentSessionTimeMs) ||
    action.createdAtMs > snapshot.currentSessionTimeMs ||
    !Array.isArray(snapshot.backgroundActions)
  )
    return false;
  const media = snapshot.backgroundActions.find(
    (candidate) =>
      isPlainRecord(candidate) &&
      candidate.kind === "media" &&
      isPlainRecord(candidate.media) &&
      candidate.media.mediaId === action.mediaId,
  );
  // A play creates its media action and then its wait, so the wait belongs to the media action just before it.
  return (
    isPlainRecord(media) &&
    isPlainRecord(media.media) &&
    media.owningInstruction === action.owningInstruction &&
    positiveSafeInteger(media.actionId) &&
    media.actionId + 1 === action.actionId &&
    (action.until === "ended" || media.media.loaded === false)
  );
}

function validForegroundActionBase(
  action: unknown,
  snapshot: Record<string, unknown>,
  activeCallFrameIds: ReadonlySet<unknown>,
): boolean {
  if (
    !isPlainRecord(action) ||
    !positiveSafeInteger(action.actionId) ||
    !positiveSafeInteger(action.requestEventSequence) ||
    !nonNegativeSafeInteger(action.owningInstruction) ||
    !nonNegativeSafeInteger(action.continuationInstruction) ||
    !nonNegativeSafeInteger(action.scopeDepth) ||
    !nonNegativeSafeInteger(action.loopDepth) ||
    (typeof snapshot.nextEventSequence === "number" &&
      action.requestEventSequence >= snapshot.nextEventSequence) ||
    action.actionId >= (typeof snapshot.nextActionId === "number" ? snapshot.nextActionId : 0)
  )
    return false;

  if (action.kind === "chatPacingGate") return true;
  return (
    (action.ownerCallFrameId === null ||
      (positiveSafeInteger(action.ownerCallFrameId) &&
        activeCallFrameIds.has(action.ownerCallFrameId))) &&
    action.scopeDepth === (Array.isArray(snapshot.frames) ? snapshot.frames.length : -1) &&
    action.loopDepth === (Array.isArray(snapshot.loopFrames) ? snapshot.loopFrames.length : -1)
  );
}

function validPacingGateAction(
  action: unknown,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  foreground: boolean,
): boolean {
  if (!isPacingGateShape(action)) return false;
  if (!validPacingGateIdentity(action, snapshot)) return false;
  if (!validPacingGateTiming(action, snapshot)) return false;
  if (!validPacingGateCreationProvenance(action, snapshot, plan)) return false;
  if (!foreground) return action.preparedOutput === null;
  // A pacing barrier promotes the gate without prepared output and waits at the barrier instruction.
  if (action.preparedOutput === null) {
    return (
      plan === undefined ||
      (nonNegativeSafeInteger(snapshot.nextInstruction) &&
        plan.instructions[snapshot.nextInstruction]?.kind === "pacingBarrier")
    );
  }
  return validPreparedSayOutput(action.preparedOutput, snapshot, plan);
}

function isPacingGateShape(action: unknown): action is Record<string, unknown> {
  return (
    isPlainRecord(action) &&
    hasExactKeys(action, [
      "kind",
      "actionId",
      "owningInstruction",
      "continuationInstruction",
      "ownerCallFrameId",
      "scopeDepth",
      "loopDepth",
      "createdAtMs",
      "deadlineMs",
      "skippable",
      "requestEventSequence",
      "preparedOutput",
    ]) &&
    action.kind === "chatPacingGate" &&
    nonNegativeSafeInteger(action.owningInstruction) &&
    nonNegativeSafeInteger(action.continuationInstruction) &&
    action.continuationInstruction === action.owningInstruction + 1 &&
    typeof action.skippable === "boolean"
  );
}

function validPacingGateIdentity(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): boolean {
  return (
    positiveSafeInteger(action.actionId) &&
    positiveSafeInteger(action.requestEventSequence) &&
    positiveSafeInteger(snapshot.nextActionId) &&
    positiveSafeInteger(snapshot.nextEventSequence) &&
    action.actionId < snapshot.nextActionId &&
    action.requestEventSequence < snapshot.nextEventSequence
  );
}

function validPacingGateTiming(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): boolean {
  return (
    validSessionTime(action.createdAtMs) &&
    validSessionTime(action.deadlineMs) &&
    validSessionTime(snapshot.currentSessionTimeMs) &&
    action.createdAtMs <= snapshot.currentSessionTimeMs &&
    (action.deadlineMs > snapshot.currentSessionTimeMs ||
      (action.deadlineMs === snapshot.currentSessionTimeMs &&
        (snapshot.status === "failed" || catchUpPaused(snapshot))))
  );
}

function validPacingGateCreationProvenance(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  if (
    !positiveSafeInteger(action.scopeDepth) ||
    !nonNegativeSafeInteger(action.loopDepth) ||
    action.loopDepth > action.scopeDepth ||
    !positiveSafeInteger(snapshot.nextScopeId) ||
    action.scopeDepth > snapshot.nextScopeId ||
    (action.ownerCallFrameId !== null &&
      (!positiveSafeInteger(action.ownerCallFrameId) ||
        !positiveSafeInteger(snapshot.nextCallFrameId) ||
        action.ownerCallFrameId >= snapshot.nextCallFrameId))
  )
    return false;
  if (plan === undefined) return true;

  const owningInstruction = action.owningInstruction;
  if (
    !nonNegativeSafeInteger(owningInstruction) ||
    plan.instructions[owningInstruction]?.kind !== "say"
  )
    return false;
  const owningFunction = plan.functions.find(
    (definition) =>
      owningInstruction >= definition.entryInstruction &&
      owningInstruction < definition.endInstruction,
  );
  if (owningFunction === undefined) return action.ownerCallFrameId === null;
  if (!positiveSafeInteger(action.ownerCallFrameId)) return false;

  const liveOwner = Array.isArray(snapshot.callFrames)
    ? snapshot.callFrames.find(
        (frame) => isPlainRecord(frame) && frame.id === action.ownerCallFrameId,
      )
    : undefined;
  return liveOwner === undefined || liveOwner.functionId === owningFunction.id;
}

export function validPreparedSayOutput(
  value: unknown,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  if (!isPreparedSayOutputShape(value)) return false;
  if (!validPreparedSayOutputDomain(value)) return false;
  if (!validPreparedSaySpeaker(value.speaker)) return false;
  const owningInstruction = value.owningInstruction;
  if (!nonNegativeSafeInteger(owningInstruction)) return false;
  if (plan !== undefined && plan.instructions[owningInstruction]?.kind !== "say") return false;
  return snapshot.nextInstruction === owningInstruction;
}

function isPreparedSayOutputShape(value: unknown): value is Record<string, unknown> {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "owningInstruction",
      "continuationInstruction",
      "presentation",
      "speaker",
      "content",
      "text",
      "durationMs",
      "skippable",
    ])
  );
}

function validPreparedSayOutputDomain(value: Record<string, unknown>): boolean {
  return (
    nonNegativeSafeInteger(value.owningInstruction) &&
    nonNegativeSafeInteger(value.continuationInstruction) &&
    value.continuationInstruction === value.owningInstruction + 1 &&
    isMessageMarkup(value.content) &&
    isMessagePresentation(value.presentation) &&
    typeof value.text === "string" &&
    value.content.visibleText === value.text &&
    validPreparedSayDuration(value.durationMs) &&
    typeof value.skippable === "boolean"
  );
}

function validPreparedSayDuration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_RUNTIME_SESSION_TIME_MS
  );
}

function validPreparedSaySpeaker(value: unknown): boolean {
  return (
    value === null ||
    (isPlainRecord(value) &&
      hasExactKeys(value, ["identifier", "displayName", "color", "font", "avatar"]) &&
      typeof value.identifier === "string" &&
      typeof value.displayName === "string" &&
      (value.color === null || typeof value.color === "string") &&
      (value.font === null || typeof value.font === "string") &&
      (value.avatar === null || typeof value.avatar === "string"))
  );
}

export function validTopLevelPreparedSayOutputRelationship(
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  const settlement = snapshot.lastSettlement;
  if (snapshot.preparedSayOutput === null) {
    return validReleasedPacingSettlementAfterPreparedOutputConsumption(snapshot, settlement, plan);
  }
  return (
    isPreparedSayOutputShape(snapshot.preparedSayOutput) &&
    (snapshot.status === "running" || snapshot.status === "failed") &&
    snapshot.foregroundAction === null &&
    Array.isArray(snapshot.backgroundActions) &&
    !snapshot.backgroundActions.some(
      (action) => isPlainRecord(action) && action.kind === "chatPacingGate",
    ) &&
    validPacingSettlementReleaseLineage(settlement, plan) &&
    settlement.releasedPreparedOutputInstruction === snapshot.preparedSayOutput.owningInstruction
  );
}

export function hasActivePacingGate(snapshot: Record<string, unknown>): boolean {
  const foregroundIsPacingGate =
    isPlainRecord(snapshot.foregroundAction) && snapshot.foregroundAction.kind === "chatPacingGate";
  const backgroundHasPacingGate =
    Array.isArray(snapshot.backgroundActions) &&
    snapshot.backgroundActions.some(
      (action) => isPlainRecord(action) && action.kind === "chatPacingGate",
    );
  return foregroundIsPacingGate || backgroundHasPacingGate;
}

export function hasPacingExecutionHistory(settlement: unknown): boolean {
  return isPlainRecord(settlement) && settlement.actionKind === "chatPacingGate";
}

function validReleasedPacingSettlementAfterPreparedOutputConsumption(
  snapshot: Record<string, unknown>,
  settlement: unknown,
  plan: InstructionPlan | undefined,
): boolean {
  if (!isPlainRecord(settlement) || settlement.actionKind !== "chatPacingGate") return true;
  const releasedInstruction = settlement.releasedPreparedOutputInstruction;
  if (releasedInstruction === null) return true;
  if (!nonNegativeSafeInteger(releasedInstruction)) return false;

  if (isExplicitExitHaltState(snapshot, plan)) return false;

  return activePacingActions(snapshot).some(
    (action) =>
      action.owningInstruction === releasedInstruction &&
      validActionCreatedAfterSettlement(action, settlement),
  );
}

export function isExplicitExitHaltState(
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  if (
    plan === undefined ||
    snapshot.status !== "halted" ||
    !nonNegativeSafeInteger(snapshot.nextInstruction) ||
    snapshot.nextInstruction === 0
  )
    return false;
  return plan.instructions[snapshot.nextInstruction - 1]?.kind === "exit";
}

function activePacingActions(snapshot: Record<string, unknown>): Record<string, unknown>[] {
  const actions = [
    snapshot.foregroundAction,
    ...(Array.isArray(snapshot.backgroundActions) ? snapshot.backgroundActions : []),
  ];
  return actions.filter(
    (action): action is Record<string, unknown> =>
      isPlainRecord(action) && action.kind === "chatPacingGate",
  );
}

export function validateInteractionResultHandoffState(
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  analysis: ActionValidationAnalysis | undefined,
  errors: string[],
): void {
  const handoff = snapshot.interactionResultHandoff;
  const nextInstruction = snapshot.nextInstruction;
  const precedingInstruction =
    plan !== undefined && positiveSafeInteger(nextInstruction)
      ? plan.instructions[nextInstruction - 1]
      : undefined;
  const requiresHandoff =
    precedingInstruction?.kind === "interaction" &&
    precedingInstruction.destinationTemporary !== null;

  if (handoff === null) {
    if (requiresHandoff) {
      errors.push(
        "Runtime interaction result handoff is missing at its canonical commit boundary.",
      );
    }
    return;
  }
  if (
    !isPlainRecord(handoff) ||
    !hasExactKeys(handoff, [
      "actionId",
      "owningInstruction",
      "continuationInstruction",
      "ownerCallFrameId",
      "destinationTemporary",
      "result",
    ]) ||
    !positiveSafeInteger(handoff.actionId) ||
    !nonNegativeSafeInteger(handoff.owningInstruction) ||
    !nonNegativeSafeInteger(handoff.continuationInstruction) ||
    !positiveSafeInteger(handoff.destinationTemporary) ||
    (handoff.ownerCallFrameId !== null && !positiveSafeInteger(handoff.ownerCallFrameId)) ||
    !isInteractionChoiceValue(handoff.result) ||
    (typeof handoff.result === "string" && !interactionStringFits(handoff.result)) ||
    !positiveSafeInteger(snapshot.nextActionId) ||
    handoff.actionId >= snapshot.nextActionId ||
    snapshot.foregroundAction !== null ||
    !isOneOf(snapshot.status, ["running", "failed"]) ||
    snapshot.nextInstruction !== handoff.continuationInstruction
  ) {
    errors.push("Runtime interaction result handoff is malformed.");
    return;
  }

  if (
    !validInteractionResultHandoffOwner(handoff, snapshot, analysis) ||
    !Array.isArray(snapshot.temporaries)
  ) {
    errors.push("Runtime interaction result handoff has invalid ownership or state.");
    return;
  }
  const destination = snapshot.temporaries.find(
    (temporary) => isPlainRecord(temporary) && temporary.id === handoff.destinationTemporary,
  );
  if (
    !isPlainRecord(destination) ||
    !sameCanonicalSettlementResult(destination.value, handoff.result)
  ) {
    errors.push(
      "Runtime interaction result handoff destination does not match its canonical result.",
    );
  }

  const settlement = snapshot.lastSettlement;
  if (
    !isPlainRecord(settlement) ||
    !positiveSafeInteger(settlement.actionId) ||
    settlement.actionId < handoff.actionId
  ) {
    errors.push(
      "Runtime interaction result handoff requires its settlement or a newer retained settlement.",
    );
  } else if (
    settlement.actionId === handoff.actionId &&
    (settlement.actionKind !== "interaction" ||
      settlement.owningInstruction !== handoff.owningInstruction ||
      settlement.continuationInstruction !== handoff.continuationInstruction ||
      settlement.ownerCallFrameId !== handoff.ownerCallFrameId ||
      settlement.destinationTemporary !== handoff.destinationTemporary ||
      !sameCanonicalSettlementResult(settlement.result, handoff.result))
  ) {
    errors.push("Runtime interaction result handoff disagrees with its retained settlement.");
  }

  if (plan === undefined) return;
  const instruction = plan.instructions[handoff.owningInstruction];
  if (
    instruction?.kind !== "interaction" ||
    instruction.destinationTemporary === null ||
    handoff.owningInstruction + 1 !== handoff.continuationInstruction ||
    instruction.destinationTemporary !== handoff.destinationTemporary ||
    precedingInstruction !== instruction ||
    !validInteractionResultForInstruction(
      instruction,
      handoff.result,
      snapshot,
      isPlainRecord(settlement) &&
        settlement.actionId === handoff.actionId &&
        settlement.settlementKind === "timedOut",
    )
  ) {
    errors.push(
      "Runtime interaction result handoff does not match its canonical plan instruction.",
    );
  }
}

function validInteractionResultHandoffOwner(
  handoff: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  analysis: ActionValidationAnalysis | undefined,
): boolean {
  const callFrames = Array.isArray(snapshot.callFrames) ? snapshot.callFrames : [];
  const activeOwner = callFrames.at(-1);
  const ownerCallFrameId = handoff.ownerCallFrameId;
  if (ownerCallFrameId === null) {
    if (callFrames.length !== 0) return false;
    return (
      analysis === undefined ||
      (nonNegativeSafeInteger(handoff.owningInstruction) &&
        analysis.functionIdsByInstruction[handoff.owningInstruction] === null)
    );
  }
  if (
    !positiveSafeInteger(ownerCallFrameId) ||
    !isPlainRecord(activeOwner) ||
    activeOwner.id !== ownerCallFrameId
  )
    return false;
  if (analysis === undefined || !nonNegativeSafeInteger(handoff.owningInstruction)) {
    return true;
  }
  const ownerFunctionId = analysis.functionIdsByInstruction[handoff.owningInstruction];
  return ownerFunctionId !== null && activeOwner.functionId === ownerFunctionId;
}

export function validateTerminalContinuationHandoffState(
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  const handoff = snapshot.terminalContinuationHandoff;
  if (handoff === null) return;
  if (
    !isPlainRecord(handoff) ||
    !hasExactKeys(handoff, [
      "actionId",
      "actionKind",
      "owningInstruction",
      "continuationInstruction",
    ]) ||
    !positiveSafeInteger(handoff.actionId) ||
    (handoff.actionKind !== "delay" &&
      handoff.actionKind !== "interaction" &&
      handoff.actionKind !== "mediaPlayback" &&
      handoff.actionKind !== "storageWrite") ||
    !nonNegativeSafeInteger(handoff.owningInstruction) ||
    !nonNegativeSafeInteger(handoff.continuationInstruction) ||
    !positiveSafeInteger(snapshot.nextActionId) ||
    // An expiry block may have allocated newer actions before the terminal action settled.
    handoff.actionId >= snapshot.nextActionId ||
    snapshot.status !== "running" ||
    snapshot.foregroundAction !== null ||
    snapshot.interactionResultHandoff !== null ||
    !validTerminalContinuationHandoffSettlement(handoff, snapshot.lastSettlement)
  ) {
    errors.push("Runtime terminal continuation handoff is malformed.");
    return;
  }
  if (plan === undefined) return;
  const instruction = plan.instructions[handoff.owningInstruction];
  const terminalHandoffMatchesPlan =
    handoff.continuationInstruction === mainRootEnd(plan) &&
    snapshot.nextInstruction === mainRootEnd(plan) &&
    handoff.owningInstruction + 1 === handoff.continuationInstruction &&
    ((handoff.actionKind === "delay" && instruction?.kind === "wait") ||
      (handoff.actionKind === "storageWrite" && instruction?.kind === "storageWrite") ||
      (handoff.actionKind === "mediaPlayback" &&
        instruction?.kind === "playMedia" &&
        instruction.destinationTemporary === null) ||
      (handoff.actionKind === "interaction" &&
        instruction?.kind === "interaction" &&
        instruction.interactionKind === "button" &&
        instruction.destinationTemporary === null));
  if (!terminalHandoffMatchesPlan) {
    errors.push(
      "Runtime terminal continuation handoff does not match its canonical terminal instruction.",
    );
  }
}

function validTerminalContinuationHandoffSettlement(
  handoff: Record<string, unknown>,
  settlement: unknown,
): boolean {
  if (!positiveSafeInteger(handoff.actionId) || !isPlainRecord(settlement)) return false;
  if (settlement.actionId === handoff.actionId) {
    return (
      settlement.actionKind === handoff.actionKind &&
      settlement.owningInstruction === handoff.owningInstruction &&
      settlement.continuationInstruction === handoff.continuationInstruction
    );
  }

  // Only a background pacing gate can settle after a terminal delay or storage write and replace bounded replay
  // before root completion is entered; a gate created by an expiry block may be newer than the delay.
  return (
    (handoff.actionKind === "delay" || handoff.actionKind === "storageWrite") &&
    settlement.actionKind === "chatPacingGate" &&
    positiveSafeInteger(settlement.actionId)
  );
}

function validInteractionResultForInstruction(
  instruction: Extract<Instruction, { kind: "interaction" }>,
  result: unknown,
  snapshot: Record<string, unknown>,
  timedOut: boolean,
): boolean {
  if (instruction.expectedResult === "duration") {
    // Elapsed time ends no later than now. Until the handoff is consumed, the prepared timeout still bounds it, and a
    // timed-out button returns exactly its timeout.
    if (
      !validElapsedResult(result) ||
      !validSessionTime(snapshot.currentSessionTimeMs) ||
      result.milliseconds > snapshot.currentSessionTimeMs
    )
      return false;
    const prepared = "preparedUi" in instruction ? instruction.preparedUi : null;
    if (prepared?.kind !== "button" || prepared.timeoutTemporary === undefined) return !timedOut;
    const timeoutMs = Array.isArray(snapshot.temporaries)
      ? buttonTimeoutMilliseconds(
          runtimeTemporaryValue(snapshot.temporaries, prepared.timeoutTemporary),
        )
      : null;
    return (
      timeoutMs !== null &&
      (timedOut ? result.milliseconds === timeoutMs : result.milliseconds <= timeoutMs)
    );
  }
  if (instruction.interactionKind === "choice") {
    if (instruction.expectedResult !== "choice" || !isInteractionChoiceValue(result)) return false;
    const options =
      "preparedUi" in instruction
        ? preparedChoiceOptions(
            instruction.preparedUi,
            snapshot.temporaries,
            snapshotTemporalContextAt(snapshot, snapshot.currentSessionTimeMs),
            instruction.span,
          )
        : instruction.ui.kind === "choice"
          ? instruction.ui.options
          : undefined;
    return options?.some((option) => serializableEquals(option.value, result)) === true;
  }
  if (instruction.expectedResult === "number") {
    // An `askInteger` result is a safe whole number.
    const ui = "preparedUi" in instruction ? instruction.preparedUi : instruction.ui;
    return (
      instruction.interactionKind === "number" &&
      typeof result === "number" &&
      Number.isFinite(result) &&
      !Object.is(result, -0) &&
      (ui.kind !== "number" || ui.integer !== true || Number.isSafeInteger(result))
    );
  }
  if (instruction.expectedResult === "temporal") {
    const ui = "preparedUi" in instruction ? instruction.preparedUi : instruction.ui;
    return (
      instruction.interactionKind === "temporal" &&
      ui.kind === "temporal" &&
      isTemporalAnswer(result, ui.temporalKind)
    );
  }
  return (
    instruction.expectedResult === "string" &&
    instruction.interactionKind === "text" &&
    typeof result === "string" &&
    interactionStringFits(result) &&
    !result.includes("\r") &&
    interactionStringHasNonWhitespace(result)
  );
}

/** The buttons a prepared choice shows for its captured option values, or `undefined` when they are invalid. */
function preparedChoiceOptions(
  prepared: import("../plan/model.js").PreparedInteractionUiPayload,
  temporaries: unknown,
  context: TemporalContext | undefined,
  span: PlanSourceLocation,
): readonly InteractionChoiceOption[] | undefined {
  if (prepared.kind !== "choice" || !Array.isArray(temporaries) || context === undefined)
    return undefined;
  const raw = runtimeTemporaryValue(temporaries, prepared.optionsTemporary);
  if (
    validateCapturedSerializableValue(raw) !== null ||
    !isPlainRecord(raw) ||
    raw.kind !== "list" ||
    !Array.isArray(raw.items) ||
    raw.items.length !== prepared.values.length
  )
    return undefined;
  try {
    // EVIDENCE: validation: validateCapturedSerializableValue accepted the captured list and its items above.
    return expandChoiceOptions(
      raw.items as SerializableRuntimeValue[],
      prepared.values,
      context,
      span,
    );
  } catch (error) {
    if (error instanceof RuntimeFault) return undefined;
    throw error;
  }
}

/**
 * An interaction appeared at a scene time no later than now. Only a button has a timeout, and its deadline is a
 * representable later scene time. A pending button is not overdue unless catch-up is paused for execution that runs
 * first, such as a queued expiry block or one that suspends it.
 */
function validInteractionTiming(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  allowDue: boolean,
): boolean {
  if (
    !validSessionTime(action.createdAtMs) ||
    !validSessionTime(snapshot.currentSessionTimeMs) ||
    action.createdAtMs > snapshot.currentSessionTimeMs
  )
    return false;
  if (action.timeoutMs === null) return true;
  if (
    action.interactionKind !== "button" ||
    typeof action.timeoutMs !== "number" ||
    !(action.timeoutMs > 0) ||
    !Number.isFinite(action.timeoutMs)
  )
    return false;
  const deadlineMs = action.createdAtMs + action.timeoutMs;
  return (
    validSessionTime(deadlineMs) &&
    deadlineMs > action.createdAtMs &&
    (allowDue || deadlineMs > snapshot.currentSessionTimeMs)
  );
}

function validInteractionAction(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  allowDue: boolean,
): boolean {
  if (
    !hasExactKeys(action, [
      "kind",
      "interactionKind",
      "actionId",
      "owningInstruction",
      "continuationInstruction",
      "ownerCallFrameId",
      "scopeDepth",
      "loopDepth",
      "destinationTemporary",
      "expectedResult",
      "target",
      "speakerId",
      "ui",
      "createdAtMs",
      "timeoutMs",
      "requestEventSequence",
    ])
  )
    return false;
  if (
    !isInteractionKind(action.interactionKind) ||
    action.target !== "standardChat" ||
    !validInteractionTiming(action, snapshot, allowDue)
  )
    return false;
  const expected =
    action.interactionKind === "button"
      ? action.destinationTemporary === null
        ? "none"
        : "duration"
      : action.interactionKind === "number"
        ? "number"
        : action.interactionKind === "choice"
          ? "choice"
          : action.interactionKind === "temporal"
            ? "temporal"
            : "string";
  if (
    action.expectedResult !== expected ||
    (action.speakerId !== null && !positiveSafeInteger(action.speakerId))
  )
    return false;
  const speakers = Array.isArray(snapshot.speakers) ? snapshot.speakers : [];
  if (
    action.speakerId !== null &&
    !speakers.some((speaker) => isPlainRecord(speaker) && speaker.id === action.speakerId)
  )
    return false;
  if (
    action.destinationTemporary !== null
      ? !positiveSafeInteger(action.destinationTemporary)
      : action.interactionKind !== "button"
  )
    return false;
  if (
    action.destinationTemporary !== null &&
    Array.isArray(snapshot.temporaries) &&
    snapshot.temporaries.some(
      (temporary) => isPlainRecord(temporary) && temporary.id === action.destinationTemporary,
    )
  )
    return false;
  if (!validInteractionUiShape(action.interactionKind, action.ui)) return false;
  if (plan === undefined || !nonNegativeSafeInteger(action.owningInstruction)) return true;
  const instruction = plan.instructions[action.owningInstruction];
  if (
    instruction?.kind !== "interaction" ||
    instruction.interactionKind !== action.interactionKind ||
    instruction.expectedResult !== action.expectedResult ||
    instruction.destinationTemporary !== action.destinationTemporary ||
    instruction.target !== action.target
  )
    return false;

  if ("preparedUi" in instruction) {
    return validPreparedInteractionAction(instruction, action, snapshot, speakers);
  }
  if (!interactionUiEqual(instruction.ui, action.ui) || action.timeoutMs !== null) return false;
  if (instruction.speaker === null) return action.speakerId === snapshot.defaultSpeaker;
  const explicitSpeaker = visibleRuntimeBindingValue(snapshot, instruction.speaker);
  if (
    !isPlainRecord(explicitSpeaker) ||
    explicitSpeaker.kind !== "speakerReference" ||
    !positiveSafeInteger(explicitSpeaker.speakerId) ||
    typeof explicitSpeaker.identifier !== "string" ||
    explicitSpeaker.identifier.length === 0 ||
    !speakers.some((speaker) => isPlainRecord(speaker) && speaker.id === explicitSpeaker.speakerId)
  )
    return false;
  return action.speakerId === explicitSpeaker.speakerId;
}

function validPreparedInteractionAction(
  instruction: import("../plan/model.js").PreparedInteractionInstruction,
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  speakers: readonly unknown[],
): boolean {
  if (!Array.isArray(snapshot.temporaries)) return false;
  const preparedSpeaker = runtimeTemporaryValue(snapshot.temporaries, instruction.speakerTemporary);
  if (preparedSpeaker === undefined) return false;
  if (preparedSpeaker === null) {
    if (action.speakerId !== null) return false;
  } else {
    if (
      !isPlainRecord(preparedSpeaker) ||
      preparedSpeaker.kind !== "speakerReference" ||
      !positiveSafeInteger(preparedSpeaker.speakerId) ||
      typeof preparedSpeaker.identifier !== "string" ||
      !speakers.some(
        (speaker) => isPlainRecord(speaker) && speaker.id === preparedSpeaker.speakerId,
      ) ||
      action.speakerId !== preparedSpeaker.speakerId
    )
      return false;
  }
  // The action keeps the timeout its prepared temporary held when the button appeared.
  const prepared = instruction.preparedUi;
  const timeoutMs =
    prepared.kind === "button" && prepared.timeoutTemporary !== undefined
      ? buttonTimeoutMilliseconds(
          runtimeTemporaryValue(snapshot.temporaries, prepared.timeoutTemporary),
        )
      : null;
  if (
    (prepared.kind === "button" && prepared.timeoutTemporary !== undefined && timeoutMs === null) ||
    action.timeoutMs !== timeoutMs
  )
    return false;
  return preparedInteractionUiMatchesAction(
    prepared,
    action.ui,
    snapshot.temporaries,
    // The buttons were shown with the context in force when the interaction opened, also after a later Continue.
    snapshotTemporalContextAt(snapshot, action.createdAtMs, action.requestEventSequence),
    instruction.span,
  );
}

/** The snapshot's temporal context at a scene time when its captures are valid: choice texts are derived from it. */
function snapshotTemporalContextAt(
  snapshot: Record<string, unknown>,
  atMs: unknown,
  eventSequence: unknown = Infinity,
): TemporalContext | undefined {
  if (
    typeof atMs !== "number" ||
    typeof eventSequence !== "number" ||
    typeof snapshot.currentSessionTimeMs !== "number" ||
    typeof snapshot.observedSessionTimeMs !== "number" ||
    typeof snapshot.nextEventSequence !== "number" ||
    temporalCapturesProblem(
      snapshot.temporalCaptures,
      snapshot.currentSessionTimeMs,
      snapshot.observedSessionTimeMs,
      snapshot.nextEventSequence,
    ) !== null
  )
    return undefined;
  // EVIDENCE: validation: temporalCapturesProblem accepted the snapshot's captures.
  const captures = snapshot.temporalCaptures as RuntimeTemporalCapture[];
  // Without a capture recorded before the request, the shown texts cannot be derived again, so they do not validate.
  return temporalCaptureShownAt(captures, atMs, eventSequence)?.context;
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: boundary: a temporary payload remains unvalidated while snapshot consistency is checked.
function runtimeTemporaryValue(temporaries: readonly unknown[], id: number): unknown {
  const temporary = temporaries.find(
    (candidate) => isPlainRecord(candidate) && candidate.id === id,
  );
  return isPlainRecord(temporary) ? temporary.value : undefined;
}

function preparedInteractionUiMatchesAction(
  prepared: import("../plan/model.js").PreparedInteractionUiPayload,
  actual: unknown,
  temporaries: readonly unknown[],
  context: TemporalContext | undefined,
  span: PlanSourceLocation,
): boolean {
  if (
    !isPlainRecord(actual) ||
    actual.kind !== prepared.kind ||
    !accessibleNameEqual(prepared.accessibleName, actual.accessibleName)
  )
    return false;
  if (prepared.kind === "button") {
    return (
      runtimeTemporaryValue(temporaries, prepared.buttonLabelTemporary) === actual.buttonLabel &&
      (prepared.backgroundTemporary === undefined
        ? actual.background === undefined
        : normalizeOpaqueColor(runtimeTemporaryValue(temporaries, prepared.backgroundTemporary)) ===
          actual.background)
    );
  }
  if (prepared.kind === "text" || prepared.kind === "number") {
    const hint =
      prepared.hintTemporary === null
        ? null
        : runtimeTemporaryValue(temporaries, prepared.hintTemporary);
    const prefill =
      prepared.prefillTemporary === undefined
        ? undefined
        : runtimeTemporaryValue(temporaries, prepared.prefillTemporary);
    return (
      hint === actual.hint &&
      prefill === actual.prefill &&
      actual.integer === (prepared.kind === "number" ? prepared.integer : undefined)
    );
  }
  if (prepared.kind === "temporal") {
    const hint =
      prepared.hintTemporary === null
        ? null
        : runtimeTemporaryValue(temporaries, prepared.hintTemporary);
    const prefill =
      prepared.prefillTemporary === undefined
        ? undefined
        : runtimeTemporaryValue(temporaries, prepared.prefillTemporary);
    return (
      actual.temporalKind === prepared.temporalKind &&
      hint === actual.hint &&
      prefill === actual.prefill
    );
  }
  const options = preparedChoiceOptions(prepared, temporaries, context, span);
  return options !== undefined && choiceOptionsEqual(options, actual.options);
}

function accessibleNameEqual(
  expected: import("../plan/model.js").InteractionAccessibleName,
  actual: unknown,
): boolean {
  if (!isPlainRecord(actual) || actual.kind !== expected.kind) return false;
  return expected.kind === "localizedDefault"
    ? actual.key === expected.key
    : actual.text === expected.text;
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: boundary: binding payloads remain unvalidated during snapshot lineage checks.
function visibleRuntimeBindingValue(snapshot: Record<string, unknown>, name: string): unknown {
  if (!Array.isArray(snapshot.frames)) return undefined;
  const lastCall = Array.isArray(snapshot.callFrames) ? snapshot.callFrames.at(-1) : undefined;
  const functionBase =
    isPlainRecord(lastCall) && nonNegativeSafeInteger(lastCall.scopeBaseDepth)
      ? lastCall.scopeBaseDepth
      : undefined;
  const minimum = functionBase ?? 0;
  for (let index = snapshot.frames.length - 1; index >= minimum; index -= 1) {
    const frame = snapshot.frames[index];
    if (!isPlainRecord(frame) || !Array.isArray(frame.bindings)) continue;
    const binding = frame.bindings.find(
      (candidate) => isPlainRecord(candidate) && candidate.name === name,
    );
    if (isPlainRecord(binding)) return binding.value;
  }
  if (functionBase !== undefined) {
    const root = snapshot.frames[0];
    if (!isPlainRecord(root) || !Array.isArray(root.bindings)) return undefined;
    const binding = root.bindings.find(
      (candidate) => isPlainRecord(candidate) && candidate.name === name,
    );
    if (isPlainRecord(binding)) return binding.value;
  }
  return undefined;
}

function validInteractionUiShape(kind: InteractionKind, value: unknown): boolean {
  if (!isPlainRecord(value) || value.kind !== kind || !isPlainRecord(value.accessibleName))
    return false;
  const expectedUiKeys =
    kind === "button"
      ? ["kind", "buttonLabel", "accessibleName", ...("background" in value ? ["background"] : [])]
      : kind === "text" || kind === "number" || kind === "temporal"
        ? [
            "kind",
            "hint",
            "accessibleName",
            ...("prefill" in value ? ["prefill"] : []),
            ...(kind === "number" && "integer" in value ? ["integer"] : []),
            ...(kind === "temporal" ? ["temporalKind"] : []),
          ]
        : ["kind", "options", "accessibleName"];
  if (
    !hasExactKeys(value, expectedUiKeys) ||
    ("integer" in value && value.integer !== true) ||
    (kind === "temporal" && !isTemporalAnswerKind(value.temporalKind))
  )
    return false;
  let aggregate = 0;
  let measurementExhausted = false;
  const count = (text: unknown): text is string => {
    if (typeof text !== "string") return false;
    if (measurementExhausted) {
      return text.length <= Math.max(0, MAX_INTERACTION_AGGREGATE_UTF8_BYTES - aggregate);
    }
    recordValidationTestWork("interactionUtf8Measurements");
    const bytes = boundedInteractionUtf8ByteLength(
      text,
      MAX_INTERACTION_AGGREGATE_UTF8_BYTES - aggregate,
    );
    if (bytes === null) {
      measurementExhausted = true;
      return false;
    }
    aggregate += bytes;
    return true;
  };
  const expectedKey =
    kind === "button"
      ? "continue"
      : kind === "number"
        ? "number"
        : kind === "choice"
          ? "chooseOption"
          : "answer";
  if (value.accessibleName.kind === "text") {
    if (
      !hasExactKeys(value.accessibleName, ["kind", "text"]) ||
      !count(value.accessibleName.text) ||
      measurementExhausted ||
      !interactionStringHasNonWhitespace(value.accessibleName.text)
    )
      return false;
  } else if (
    !hasExactKeys(value.accessibleName, ["kind", "key"]) ||
    value.accessibleName.kind !== "localizedDefault" ||
    value.accessibleName.key !== expectedKey
  )
    return false;
  if (kind === "button") {
    return (
      count(value.buttonLabel) &&
      !measurementExhausted &&
      (!("background" in value) || isNormalizedOpaqueColor(value.background))
    );
  }
  if (kind === "text" || kind === "number" || kind === "temporal") {
    const answerKind = isTemporalAnswerKind(value.temporalKind)
      ? value.temporalKind
      : value.integer === true
        ? "integer"
        : kind === "number"
          ? "number"
          : "text";
    return (
      (value.hint === null || count(value.hint)) &&
      (!("prefill" in value) ||
        (count(value.prefill) && isValidInteractionPrefill(answerKind, value.prefill))) &&
      !measurementExhausted
    );
  }
  if (
    !Array.isArray(value.options) ||
    value.options.length === 0 ||
    value.options.length > MAX_INTERACTION_OPTION_ENTRIES
  )
    return false;
  for (const option of value.options) {
    if (
      !isPlainRecord(option) ||
      !hasExactKeys(option, ["text", "value", ...("background" in option ? ["background"] : [])])
    ) {
      return false;
    }
    if ("background" in option && !isNormalizedOpaqueColor(option.background)) return false;
    if (!count(option.text) && !measurementExhausted) return false;
    const value = option.value;
    if (!isInteractionChoiceValue(value)) return false;
    if (
      typeof value === "string" &&
      value !== option.text &&
      !count(value) &&
      !measurementExhausted
    )
      return false;
  }
  return !measurementExhausted;
}

function interactionUiEqual(expected: InteractionUiPayload, actual: unknown): boolean {
  if (!isPlainRecord(actual) || actual.kind !== expected.kind) return false;
  if (!isPlainRecord(actual.accessibleName)) return false;
  if (actual.accessibleName.kind !== expected.accessibleName.kind) return false;
  if (expected.accessibleName.kind === "text") {
    if (actual.accessibleName.text !== expected.accessibleName.text) return false;
  } else if (actual.accessibleName.key !== expected.accessibleName.key) return false;
  if (expected.kind === "button")
    return actual.buttonLabel === expected.buttonLabel && actual.background === expected.background;
  if (expected.kind === "text" || expected.kind === "number")
    return (
      actual.hint === expected.hint &&
      actual.prefill === expected.prefill &&
      actual.integer === (expected.kind === "number" ? expected.integer : undefined)
    );
  if (expected.kind === "temporal")
    return (
      actual.temporalKind === expected.temporalKind &&
      actual.hint === expected.hint &&
      actual.prefill === expected.prefill
    );
  return choiceOptionsEqual(expected.options, actual.options);
}

/** Whether `actual` holds the same buttons, in order: text, value, and background. */
function choiceOptionsEqual(
  expected: readonly InteractionChoiceOption[],
  actual: unknown,
): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every((option, index) => {
    const candidate: unknown = actual[index];
    return (
      isPlainRecord(candidate) &&
      candidate.text === option.text &&
      isInteractionChoiceValue(candidate.value) &&
      serializableEquals(candidate.value, option.value) &&
      candidate.background === option.background
    );
  });
}

function validSettlementKindData(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  analysis: ActionValidationAnalysis | undefined,
): boolean {
  if (settlement.actionKind === "chatPacingGate")
    return validPacingGateSettlement(settlement, snapshot, plan);
  if (settlement.actionKind === "delay") {
    return (
      hasExactKeys(settlement, [
        "actionId",
        "actionKind",
        "settlementKind",
        "owningInstruction",
        "continuationInstruction",
        "requestEventSequence",
        "completionEventSequence",
        "deadlineMs",
        "completedAtMs",
      ]) && validSettlementChronology(settlement, snapshot)
    );
  }
  if (settlement.actionKind === "storageWrite") {
    return (
      hasExactKeys(settlement, [
        "actionId",
        "actionKind",
        "settlementKind",
        "outcome",
        "key",
        "owningInstruction",
        "continuationInstruction",
        "requestEventSequence",
        "completionEventSequence",
        "completedAtMs",
      ]) &&
      isOneOf(settlement.outcome, ["stored", "failed"]) &&
      typeof settlement.key === "string" &&
      snapshot.scriptStoragePersistent === true &&
      // A failed write publishes its TSW014 warning between the request and the completion.
      (settlement.outcome === "stored" ||
        (positiveSafeInteger(settlement.requestEventSequence) &&
          positiveSafeInteger(settlement.completionEventSequence) &&
          settlement.completionEventSequence >= settlement.requestEventSequence + 2)) &&
      validSessionTime(settlement.completedAtMs) &&
      validSessionTime(snapshot.currentSessionTimeMs) &&
      settlement.completedAtMs <= snapshot.currentSessionTimeMs
    );
  }
  if (settlement.actionKind === "mediaPlayback") {
    return (
      hasExactKeys(settlement, [
        "actionId",
        "actionKind",
        "settlementKind",
        "outcome",
        "mediaId",
        "owningInstruction",
        "continuationInstruction",
        "requestEventSequence",
        "completionEventSequence",
        "completedAtMs",
      ]) &&
      isOneOf(settlement.outcome, ["loaded", "finished", "stopped", "failed"]) &&
      positiveSafeInteger(settlement.mediaId) &&
      positiveSafeInteger(snapshot.nextMediaId) &&
      settlement.mediaId < snapshot.nextMediaId &&
      validMediaWaitOutcome(settlement, plan) &&
      validSessionTime(settlement.completedAtMs) &&
      validSessionTime(snapshot.currentSessionTimeMs) &&
      settlement.completedAtMs <= snapshot.currentSessionTimeMs
    );
  }
  if (
    !hasExactKeys(settlement, [
      "actionId",
      "actionKind",
      "interactionKind",
      "settlementKind",
      "owningInstruction",
      "continuationInstruction",
      "ownerCallFrameId",
      "destinationTemporary",
      "requestEventSequence",
      "transcriptEventSequence",
      "completionEventSequence",
      "result",
      "transcriptText",
      "ui",
    ])
  )
    return false;
  const timedOut = settlement.settlementKind === "timedOut";
  if (
    !isInteractionKind(settlement.interactionKind) ||
    !positiveSafeInteger(settlement.requestEventSequence) ||
    !positiveSafeInteger(settlement.completionEventSequence) ||
    (timedOut
      ? settlement.transcriptText !== null ||
        settlement.transcriptEventSequence !== null ||
        settlement.requestEventSequence >= settlement.completionEventSequence
      : typeof settlement.transcriptText !== "string" ||
        !interactionStringFits(settlement.transcriptText) ||
        !positiveSafeInteger(settlement.transcriptEventSequence) ||
        settlement.requestEventSequence >= settlement.transcriptEventSequence ||
        settlement.transcriptEventSequence >= settlement.completionEventSequence)
  )
    return false;
  const interactionKind = settlement.interactionKind;
  if (
    !isInteractionKind(interactionKind) ||
    !validInteractionUiShape(interactionKind, settlement.ui) ||
    !settlementMatchesPresentedUi(settlement)
  )
    return false;
  let resultValid: boolean;
  if (settlement.interactionKind === "button") {
    resultValid =
      settlement.destinationTemporary === null
        ? settlement.result === null
        : validElapsedResult(settlement.result) &&
          !(timedOut && settlement.result.milliseconds === 0);
  } else if (settlement.interactionKind === "text") {
    resultValid =
      typeof settlement.result === "string" && settlement.result === settlement.transcriptText;
  } else if (settlement.interactionKind === "number") {
    resultValid =
      typeof settlement.result === "number" &&
      Number.isFinite(settlement.result) &&
      !Object.is(settlement.result, -0);
  } else if (settlement.interactionKind === "temporal") {
    // The transcript shows the answer in the presentation in force then, which is not derived again here.
    resultValid =
      isPlainRecord(settlement.ui) &&
      isTemporalAnswerKind(settlement.ui.temporalKind) &&
      isTemporalAnswer(settlement.result, settlement.ui.temporalKind) &&
      typeof settlement.transcriptText === "string" &&
      !/[\r\n\u2028\u2029]/u.test(settlement.transcriptText) &&
      interactionStringHasNonWhitespace(settlement.transcriptText);
  } else {
    // The recorded UI offered the result; `settlementMatchesPresentedUi` checked that above.
    resultValid =
      isInteractionChoiceValue(settlement.result) &&
      (typeof settlement.result !== "string" || interactionStringFits(settlement.result));
  }
  if (!resultValid) return false;

  if (
    (settlement.interactionKind !== "button" || settlement.destinationTemporary !== null) &&
    !positiveSafeInteger(settlement.destinationTemporary)
  )
    return false;
  if (
    settlement.ownerCallFrameId !== null &&
    (!positiveSafeInteger(settlement.ownerCallFrameId) ||
      !positiveSafeInteger(snapshot.nextCallFrameId) ||
      settlement.ownerCallFrameId >= snapshot.nextCallFrameId)
  )
    return false;
  if (
    settlement.interactionKind === "text" &&
    (typeof settlement.transcriptText !== "string" ||
      settlement.result !== settlement.transcriptText ||
      settlement.transcriptText.includes("\r") ||
      !interactionStringHasNonWhitespace(settlement.transcriptText))
  )
    return false;
  if (settlement.interactionKind === "number") {
    if (
      typeof settlement.result !== "number" ||
      typeof settlement.transcriptText !== "string" ||
      /[\r\n\u2028\u2029]/u.test(settlement.transcriptText) ||
      !/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u.test(settlement.transcriptText)
    )
      return false;
    const parsed = Number(settlement.transcriptText);
    if (!Number.isFinite(parsed) || (Object.is(parsed, -0) ? 0 : parsed) !== settlement.result)
      return false;
    // An `askInteger` answer is whole-number notation within the safe integer range.
    if (
      isPlainRecord(settlement.ui) &&
      settlement.ui.integer === true &&
      (!isIntegerAnswerText(settlement.transcriptText) || !Number.isSafeInteger(parsed))
    )
      return false;
  }

  if (plan === undefined || !nonNegativeSafeInteger(settlement.owningInstruction)) return true;
  const instruction = plan.instructions[settlement.owningInstruction];
  if (
    instruction?.kind !== "interaction" ||
    instruction.interactionKind !== settlement.interactionKind
  )
    return false;
  if (
    settlement.destinationTemporary !== instruction.destinationTemporary ||
    !validInteractionSettlementOwner(settlement, snapshot, analysis)
  )
    return false;
  // Only a button written with a timeout can time out.
  if (
    timedOut &&
    !(
      "preparedUi" in instruction &&
      instruction.preparedUi.kind === "button" &&
      instruction.preparedUi.timeoutTemporary !== undefined
    )
  )
    return false;
  return "preparedUi" in instruction
    ? preparedUiFitsPresentedUi(instruction.preparedUi, settlement.ui)
    : interactionUiEqual(instruction.ui, settlement.ui);
}

function isInteractionKind(value: unknown): value is InteractionKind {
  return isOneOf(value, ["button", "text", "number", "choice", "temporal"]);
}

function isTemporalAnswerKind(value: unknown): value is InteractionTemporalKind {
  return isOneOf(value, ["date", "time", "datetime"]);
}

/** Whether `value` is a valid date, time, or date and time of `kind`, as a date or time field returns. */
function isTemporalAnswer(value: unknown, kind: InteractionTemporalKind): boolean {
  return (
    isInteractionChoiceValue(value) &&
    typeof value === "object" &&
    value !== null &&
    value.kind === kind
  );
}

/**
 * The settled transcript and result must be what the recorded UI offered. The settlement carries that UI because the
 * instruction's prepared temporaries are cleared after completion and may be prepared anew by a later run.
 */
function settlementMatchesPresentedUi(settlement: Record<string, unknown>): boolean {
  const ui = settlement.ui;
  if (!isPlainRecord(ui)) return false;
  if (ui.kind === "button")
    return (
      settlement.transcriptText ===
      (settlement.settlementKind === "timedOut" ? null : ui.buttonLabel)
    );
  if (ui.kind !== "choice") return true;
  const result = settlement.result;
  if (!isInteractionChoiceValue(result)) return false;
  return (
    Array.isArray(ui.options) &&
    ui.options.some(
      (option) =>
        isPlainRecord(option) &&
        option.text === settlement.transcriptText &&
        isInteractionChoiceValue(option.value) &&
        serializableEquals(option.value, result),
    )
  );
}

/**
 * The recorded UI has the shape the prepared instruction produces. A choice's captured options are cleared after
 * completion, so its buttons are checked only against the values written in the plan.
 */
function preparedUiFitsPresentedUi(
  prepared: import("../plan/model.js").PreparedInteractionUiPayload,
  ui: unknown,
): boolean {
  if (
    !isPlainRecord(ui) ||
    ui.kind !== prepared.kind ||
    !accessibleNameEqual(prepared.accessibleName, ui.accessibleName)
  )
    return false;
  if (prepared.kind === "button")
    return "background" in ui === (prepared.backgroundTemporary !== undefined);
  if (prepared.kind === "text" || prepared.kind === "number")
    return (
      (ui.hint === null) === (prepared.hintTemporary === null) &&
      "prefill" in ui === (prepared.prefillTemporary !== undefined) &&
      ui.integer === (prepared.kind === "number" ? prepared.integer : undefined)
    );
  if (prepared.kind === "temporal")
    return (
      ui.temporalKind === prepared.temporalKind &&
      (ui.hint === null) === (prepared.hintTemporary === null) &&
      "prefill" in ui === (prepared.prefillTemporary !== undefined)
    );
  return Array.isArray(ui.options) && buttonsFitWrittenValues(prepared.values, ui.options);
}

/**
 * Whether `options` can be the buttons of options with these written values. An option with a written value gives
 * buttons that all return it, one or, for a list, any number; an option without one may give any buttons. So when
 * every option has a written value, the buttons are runs of those values in order.
 */
function buttonsFitWrittenValues(
  values: readonly (string | number | null)[],
  options: readonly unknown[],
): boolean {
  if (values.includes(null)) return true;
  let slot = 0;
  for (const option of options) {
    if (!isPlainRecord(option) || !isInteractionChoiceValue(option.value)) return false;
    const value = option.value;
    while (slot < values.length && !serializableEquals(values[slot]!, value)) slot += 1;
    if (slot === values.length) return false;
  }
  return true;
}

function validPacingGateSettlement(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan?: InstructionPlan,
): boolean {
  if (
    !hasExactKeys(settlement, [
      "actionId",
      "actionKind",
      "settlementKind",
      "owningInstruction",
      "continuationInstruction",
      "requestEventSequence",
      "completionEventSequence",
      "deadlineMs",
      "completedAtMs",
      "releasedPreparedOutputInstruction",
    ])
  )
    return false;
  if (!validPacingSettlementKind(settlement.settlementKind)) return false;
  if (!validPacingSettlementReleaseLineage(settlement, plan)) return false;
  if (settlement.settlementKind === "completed") {
    return validSettlementChronology(settlement, snapshot);
  }
  return validNonTimePacingSettlementChronology(settlement, snapshot);
}

function validPacingSettlementKind(
  value: unknown,
): value is RuntimeChatPacingGateSettlementSnapshot["settlementKind"] {
  return (
    value === "completed" ||
    value === "skipped" ||
    value === "consumedByForegroundInteraction" ||
    value === "supersededByInstantOutput"
  );
}

function pacingSettlementCanReleasePreparedOutput(
  settlementKind: RuntimeChatPacingGateSettlementSnapshot["settlementKind"],
): boolean {
  return settlementKind === "completed" || settlementKind === "skipped";
}

function validPacingSettlementReleaseLineage(
  settlement: unknown,
  plan: InstructionPlan | undefined,
): settlement is Record<string, unknown> & {
  readonly releasedPreparedOutputInstruction: number | null;
} {
  if (!isPlainRecord(settlement)) return false;
  const releasedInstruction = settlement.releasedPreparedOutputInstruction;
  if (releasedInstruction === null) return true;
  return (
    pacingSettlementCanReleasePreparedOutput(
      // EVIDENCE: validation: this helper only compares completed/skipped strings; other values return false.
      settlement.settlementKind as RuntimeChatPacingGateSettlementSnapshot["settlementKind"],
    ) &&
    nonNegativeSafeInteger(releasedInstruction) &&
    (plan === undefined || plan.instructions[releasedInstruction]?.kind === "say")
  );
}

function validNonTimePacingSettlementChronology(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): boolean {
  // A skip, consumption or supersession happens at scene time no later than the deadline.
  return (
    validSessionTime(settlement.deadlineMs) &&
    validSessionTime(settlement.completedAtMs) &&
    validSessionTime(snapshot.currentSessionTimeMs) &&
    settlement.completedAtMs <= settlement.deadlineMs &&
    settlement.completedAtMs <= snapshot.currentSessionTimeMs
  );
}

function validInteractionSettlementOwner(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  analysis: ActionValidationAnalysis | undefined,
): boolean {
  if (analysis === undefined || !nonNegativeSafeInteger(settlement.owningInstruction)) return true;
  const ownerFunctionId = analysis.functionIdsByInstruction[settlement.owningInstruction] ?? null;
  if (ownerFunctionId === null) return settlement.ownerCallFrameId === null;
  if (!positiveSafeInteger(settlement.ownerCallFrameId)) return false;
  const callFrames = Array.isArray(snapshot.callFrames) ? snapshot.callFrames : [];
  const activeOwner = callFrames.find(
    (frame) => isPlainRecord(frame) && frame.id === settlement.ownerCallFrameId,
  );
  return (
    activeOwner === undefined ||
    (isPlainRecord(activeOwner) && activeOwner.functionId === ownerFunctionId)
  );
}

function validSettlementChronology(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): boolean {
  // Time-driven settlements happen exactly at their deadline in scene time.
  return (
    validSessionTime(settlement.deadlineMs) &&
    validSessionTime(snapshot.currentSessionTimeMs) &&
    settlement.completedAtMs === settlement.deadlineMs &&
    settlement.completedAtMs <= snapshot.currentSessionTimeMs
  );
}

/** A button's elapsed waiting time: a finite, non-negative duration. */
function validElapsedResult(
  value: unknown,
): value is { readonly kind: "duration"; readonly milliseconds: number } {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["kind", "milliseconds"]) &&
    value.kind === "duration" &&
    typeof value.milliseconds === "number" &&
    value.milliseconds >= 0 &&
    Number.isFinite(value.milliseconds)
  );
}

function sameCanonicalSettlementResult(destination: unknown, result: unknown): boolean {
  if (typeof destination === "number" || typeof result === "number") {
    return (
      typeof destination === "number" &&
      typeof result === "number" &&
      Object.is(destination, result)
    );
  }
  return (
    isInteractionChoiceValue(destination) &&
    isInteractionChoiceValue(result) &&
    serializableEquals(destination, result)
  );
}

function validSettlementProvenance(
  settlement: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  const owningInstruction = settlement.owningInstruction;
  const continuationInstruction = settlement.continuationInstruction;
  if (
    !nonNegativeSafeInteger(owningInstruction) ||
    !nonNegativeSafeInteger(continuationInstruction) ||
    continuationInstruction !== owningInstruction + 1
  )
    return false;
  if (plan === undefined) return true;
  if (owningInstruction >= plan.instructions.length) return false;
  const expectedKind =
    settlement.actionKind === "delay"
      ? "wait"
      : settlement.actionKind === "interaction"
        ? "interaction"
        : settlement.actionKind === "mediaPlayback"
          ? "playMedia"
          : settlement.actionKind === "storageWrite"
            ? "storageWrite"
            : "say";
  if (plan.instructions[owningInstruction]?.kind !== expectedKind) return false;
  const definition = plan.functions.find(
    (candidate) =>
      owningInstruction >= candidate.entryInstruction &&
      owningInstruction < candidate.endInstruction,
  );
  return definition === undefined
    ? continuationInstruction <= mainRootEnd(plan)
    : continuationInstruction < definition.endInstruction;
}

function validForegroundActionOwnership(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan,
): boolean {
  const owningInstruction = action.owningInstruction;
  const continuationInstruction = action.continuationInstruction;
  if (action.kind === "chatPacingGate") {
    return (
      nonNegativeSafeInteger(owningInstruction) &&
      nonNegativeSafeInteger(continuationInstruction) &&
      owningInstruction < plan.instructions.length &&
      plan.instructions[owningInstruction]?.kind === "say"
    );
  }
  if (
    !nonNegativeSafeInteger(owningInstruction) ||
    !nonNegativeSafeInteger(continuationInstruction) ||
    snapshot.nextInstruction !== owningInstruction ||
    owningInstruction >= plan.instructions.length ||
    continuationInstruction !== owningInstruction + 1 ||
    !["wait", "interaction", "say", "playMedia", "storageWrite"].includes(
      plan.instructions[owningInstruction]?.kind ?? "",
    )
  )
    return false;
  const owner = plan.instructions[owningInstruction];
  if (
    (action.kind === "mediaPlayback") !== (owner?.kind === "playMedia") ||
    (action.kind === "storageWrite") !== (owner?.kind === "storageWrite") ||
    (owner?.kind === "playMedia" && (action.until === "loaded") !== owner.async)
  ) {
    return false;
  }
  if (
    action.kind === "delay" &&
    (owner?.kind !== "wait" ||
      // An evaluated display expression may give any valid display.
      (typeof owner.display === "string" && owner.display !== action.display) ||
      (owner.label === null) !== (action.label === null))
  ) {
    return false;
  }

  const definition = plan.functions.find(
    (candidate) =>
      owningInstruction >= candidate.entryInstruction &&
      owningInstruction < candidate.endInstruction,
  );
  const callFrames = Array.isArray(snapshot.callFrames) ? snapshot.callFrames : [];
  const activeFrame = callFrames.at(-1);
  if (definition === undefined) {
    return (
      continuationInstruction <= mainRootEnd(plan) &&
      action.ownerCallFrameId === null &&
      callFrames.length === 0
    );
  }
  if (continuationInstruction >= definition.endInstruction) return false;
  return (
    isPlainRecord(activeFrame) &&
    activeFrame.id === action.ownerCallFrameId &&
    activeFrame.functionId === definition.id
  );
}
