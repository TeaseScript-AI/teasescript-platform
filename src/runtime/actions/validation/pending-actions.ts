// The restore check of a snapshot's pending actions: background and foreground actions, their identity and event
// capacity, and the foreground action's base, kind and ownership.

import { type InstructionPlan } from "../../../plan/model.js";
import { actionRecordCompletionEvents } from "../model.js";
import { validMediaAction } from "../../background/media-validation.js";
import { validPermanentButtonAction } from "../../background/permanent-button-validation.js";
import { validTimerAction, catchUpPaused } from "../../background/timer-validation.js";
import {
  contextHoldsInstruction,
  serializedTopContext,
} from "../../scopes/activation-validation.js";
import { isPlainRecord } from "../../values/plain-data.js";
import {
  validSessionTime,
  positiveSafeInteger,
  hasEventSequenceCapacity,
  nonNegativeSafeInteger,
  hasExactKeys,
  isCanonicalJsonArray,
} from "./shared-checks.js";
import {
  validLockAction,
  validFileStoreAction,
  validStorageWriteAction,
  validCaptureAction,
  validMediaPlaybackAction,
  validPacingGateAction,
} from "./foreground-kinds.js";
import { validInteractionAction } from "./interaction-actions.js";
import { validRetainedSettlement } from "./settlements.js";

export function validatePendingActionState(
  value: Record<string, unknown>,
  plan: InstructionPlan | undefined,
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
  if (!validBackgroundActions(value, plan)) {
    errors.push("Runtime backgroundActions are malformed.");
  }
  if (!positiveSafeInteger(value.nextActionId))
    errors.push("Runtime nextActionId must be a positive safe integer.");
  const action = value.foregroundAction;
  if (action !== null && !validForegroundActionState(action, value, plan, catchUpPaused(value))) {
    errors.push("Runtime foreground action is malformed.");
  }
  const settlement = value.lastSettlement;
  if (!validRetainedSettlement(settlement, value, plan)) {
    errors.push("Runtime lastSettlement is malformed.");
  }
  if (!validActiveActionIdentityCoherence(value)) {
    errors.push(
      "Runtime active action identities are inconsistent with each other or the retained settlement.",
    );
  }
  if (!validActiveActionCompletionCapacity(value)) {
    errors.push("Runtime active actions cannot reserve their required completion events.");
  }
}

/**
 * Active actions reserve their unavoidable future events. This is aggregate:
 * a foreground delay and a background timer may complete in one time
 * observation and must both remain representable.
 */
function validActiveActionCompletionCapacity(snapshot: Record<string, unknown>): boolean {
  const backgroundActions = Array.isArray(snapshot.backgroundActions)
    ? snapshot.backgroundActions
    : [];
  const actions = [snapshot.foregroundAction, ...backgroundActions, ...suspendedActions(snapshot)];
  // An action of no known kind is malformed, which its own check reports; it reserves nothing here.
  const requiredCompletionEvents = actions.reduce(
    (count, action) =>
      count + (isPlainRecord(action) ? (actionRecordCompletionEvents(action) ?? 0) : 0),
    0,
  );
  return hasEventSequenceCapacity(snapshot.nextEventSequence, requiredCompletionEvents);
}

/** Background work is timers, media, and permanent buttons; a reading time is always the foreground action. */
function validBackgroundActions(
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  const actions = snapshot.backgroundActions;
  if (!isCanonicalJsonArray(actions)) return false;

  let previousActionId = 0;
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (!isPlainRecord(action)) return false;
    if (action.kind === "timer") {
      if (!validTimerAction(action, snapshot, plan)) return false;
    } else if (action.kind === "media") {
      if (!validMediaAction(action, snapshot, plan)) return false;
    } else if (action.kind === "permanentButton") {
      if (!validPermanentButtonAction(action, snapshot, plan)) return false;
    } else return false;
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
  const completionEvents = actionRecordCompletionEvents(action);
  if (
    completionEvents === null ||
    !hasEventSequenceCapacity(snapshot.nextEventSequence, completionEvents)
  )
    return false;
  if (action.kind === "delay") return delayTimesAreValid && action.expectedCompletion === "time";
  if (action.kind === "interaction")
    return validInteractionAction(action, snapshot, plan, allowDue);
  if (action.kind === "chatPacingGate")
    return validPacingGateAction(action, snapshot, plan, allowDue);
  if (action.kind === "mediaPlayback") return validMediaPlaybackAction(action, snapshot);
  if (action.kind === "storageWrite") return validStorageWriteAction(action, snapshot);
  if (action.kind === "capture") return validCaptureAction(action, snapshot, plan);
  if (action.kind === "fileStore") return validFileStoreAction(action, snapshot, plan);
  if (action.kind === "lock") return validLockAction(action, snapshot, plan);
  return false;
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
  if (settlement.actionKind === "capture" && positiveSafeInteger(settlement.warningEventSequence)) {
    retainedEventSequences.add(settlement.warningEventSequence);
  }
  if (
    settlement.actionKind === "interaction" &&
    positiveSafeInteger(settlement.transcriptEventSequence)
  ) {
    retainedEventSequences.add(settlement.transcriptEventSequence);
  }
  return !retainedEventSequences.has(requestEventSequence);
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

  return (
    (action.ownerCallFrameId === null ||
      (positiveSafeInteger(action.ownerCallFrameId) &&
        activeCallFrameIds.has(action.ownerCallFrameId))) &&
    action.scopeDepth === (Array.isArray(snapshot.frames) ? snapshot.frames.length : -1) &&
    action.loopDepth === (Array.isArray(snapshot.loopFrames) ? snapshot.loopFrames.length : -1)
  );
}

function validForegroundActionOwnership(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan,
): boolean {
  const owningInstruction = action.owningInstruction;
  const continuationInstruction = action.continuationInstruction;
  if (
    !nonNegativeSafeInteger(owningInstruction) ||
    !nonNegativeSafeInteger(continuationInstruction) ||
    snapshot.nextInstruction !== owningInstruction ||
    owningInstruction >= plan.instructions.length ||
    // A file store's or lock's instruction runs again with the answer.
    continuationInstruction !==
      owningInstruction + (action.kind === "fileStore" || action.kind === "lock" ? 0 : 1) ||
    ![
      "wait",
      "interaction",
      "say",
      "playMedia",
      "storageWrite",
      "capture",
      "fileStore",
      "lock",
    ].includes(plan.instructions[owningInstruction]?.kind ?? "")
  )
    return false;
  const owner = plan.instructions[owningInstruction];
  if (
    (action.kind === "fileStore") !== (owner?.kind === "fileStore") ||
    (owner?.kind === "fileStore" && action.destinationTemporary !== owner.destinationTemporary)
  )
    return false;
  if (
    (action.kind === "lock") !== (owner?.kind === "lock") ||
    (owner?.kind === "lock" && action.destinationTemporary !== owner.destinationTemporary)
  )
    return false;
  if (
    (action.kind === "capture") !== (owner?.kind === "capture") ||
    (owner?.kind === "capture" &&
      (action.capture !== owner.capture ||
        action.destinationTemporary !== owner.destinationTemporary))
  ) {
    return false;
  }
  if (
    (action.kind === "chatPacingGate") !== (owner?.kind === "say") ||
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

  // The waiting code is the running context, and continues within it.
  const context = serializedTopContext(snapshot);
  return (
    context !== undefined &&
    context.ownerId === action.ownerCallFrameId &&
    contextHoldsInstruction(plan, context, owningInstruction) &&
    contextHoldsInstruction(plan, context, continuationInstruction)
  );
}
