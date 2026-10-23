import type { TemporalContext } from "../../temporal.js";
import {
  temporalCaptureShownAt,
  temporalCapturesProblem,
  type RuntimeTemporalCapture,
} from "../host-data/temporal-captures.js";
import { isNormalizedOpaqueColor, normalizeOpaqueColor } from "../../color.js";
import { isIntegerAnswerText, isValidInteractionPrefill } from "../../interaction-answers.js";
import { isInteractionChoiceValue } from "../../choice-values.js";
import { expandChoiceOptions, preselectedChoice } from "./choice-options.js";
import { RuntimeFault } from "../errors.js";
import {
  serializableEquals,
  validateCapturedSerializableValue,
  type SerializableRuntimeDict,
  type SerializableRuntimeList,
  type SerializableRuntimeObject,
  type SerializableRuntimeValue,
} from "../values/serializable-values.js";
import { isConversion } from "../../conversions.js";
import { isOneOf } from "../../plan/validation-support.js";
import { isCanonicalTagList } from "../../tags.js";
import { canonicalWebUrl } from "../../web-url.js";
import {
  type Instruction,
  type InteractionChoiceOption,
  type InteractionKind,
  type InteractionTemporalKind,
  type InteractionUiPayload,
  type InstructionPlan,
  type LockCall,
  type PlanSourceLocation,
  DEFAULT_EXPORT_FILE_NAME,
  DEFAULT_EXPORT_TITLE,
  DEFAULT_OPEN_URL_BUTTON_TEXT,
  DEFAULT_POPUP_BUTTON_TEXT,
  INTERACTION_KINDS,
} from "../../plan/model.js";
import {
  boundedInteractionUtf8ByteLength,
  interactionStringFits,
  interactionStringHasNonWhitespace,
  MAX_INTERACTION_AGGREGATE_UTF8_BYTES,
  MAX_INTERACTION_OPTION_ENTRIES,
} from "../../interaction-limits.js";
import {
  CAPTURE_UNAVAILABLE_REASONS,
  fileStoreOperation,
  actionRecordCompletionEvents,
  isLockNotice,
  isLockOutcome,
} from "./model.js";
import { buttonTimeoutMilliseconds, imageRequestValue } from "./interaction.js";
import {
  formAnswerMismatch,
  formRequestValue,
  formShapeFits,
  isFormUi,
  validFormResult,
  validFormState,
  validFormUi,
} from "./form.js";
import {
  IMAGE_ANSWER_TRANSCRIPT_TEXT,
  IMAGE_SKIP_TEXT,
  validImageRequestFields,
} from "../../image-input.js";
import { recordValidationTestWork } from "../../validation-testing.js";
import { validMediaAction } from "../background/media-validation.js";
import {
  base64FileType,
  holdsStoredFile,
  isRecognizedFileType,
  isStandardBase64,
} from "../host-data/stored-files.js";
import { validPermanentButtonAction } from "../background/permanent-button-validation.js";
import { isSha256Hex } from "../values/sha256.js";
import { MAX_LOCK_PUBLIC_KEYS, parsePublicKey } from "../../public-keys.js";
import { validTimerAction, catchUpPaused } from "../background/timer-validation.js";
import { validateScriptStorageEntries } from "../host-data/script-storage.js";
import {
  contextHoldsInstruction,
  fileOfInstruction,
  ownerFitsInstruction,
  serializedTopContext,
} from "../scopes/activation-validation.js";
import { functionHoldingInstruction } from "../snapshot/snapshot-validation-analysis.js";
import { isPlainRecord } from "../values/plain-data.js";

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

/**
 * A pending step of a lock, for its instruction's call. An encrypt call's lock dialog asks for the openers the player
 * chooses, suggesting a moment for a chosen time lock, after its password field, of `password: askPassword(...)`, asked
 * for the password; the step after them locks with the openers the call gives and what the player gave, and a step
 * without them has an opener. Only an encrypt call has public keys, each read as one, and only a decrypt call a key. A
 * decrypt call has no time lock and chooses nothing; its dialog, and the step after it, have no written password or
 * key, its password field always asks first, and its notice belongs to the dialog. The text is any text, the Base64
 * lock standard Base64, and a file one this session knows.
 */
function validLockAction(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
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
      "destinationTemporary",
      "createdAtMs",
      "requestEventSequence",
      "call",
      "phase",
      "value",
      "password",
      "timeLockMs",
      "choices",
      "dialogActionId",
      "notice",
      "passwordField",
      "publicKeys",
      "key",
      "resumes",
    ]) ||
    !nonNegativeSafeInteger(action.resumes) ||
    (action.phase !== "ask" && action.resumes !== 0) ||
    !positiveSafeInteger(action.destinationTemporary) ||
    !validSessionTime(action.createdAtMs) ||
    !validSessionTime(snapshot.currentSessionTimeMs) ||
    action.createdAtMs > snapshot.currentSessionTimeMs ||
    !isOneOf(action.call, ["encryptText", "encryptFile", "decryptText", "decryptFile"]) ||
    !isOneOf(action.phase, ["work", "ask"]) ||
    typeof action.value !== "string" ||
    (action.password !== null && typeof action.password !== "string") ||
    (action.timeLockMs !== null && !isEpochMilliseconds(action.timeLockMs)) ||
    !validLockChoices(action.choices) ||
    (action.dialogActionId !== null &&
      !(
        positiveSafeInteger(action.dialogActionId) &&
        action.dialogActionId < Number(action.actionId)
      )) ||
    (action.notice !== null && !isLockNotice(action.notice)) ||
    (action.passwordField !== null &&
      !(
        isPlainRecord(action.passwordField) &&
        hasExactKeys(action.passwordField, ["hint"]) &&
        (action.passwordField.hint === null || typeof action.passwordField.hint === "string")
      )) ||
    !Array.isArray(action.publicKeys) ||
    action.publicKeys.length > MAX_LOCK_PUBLIC_KEYS ||
    !action.publicKeys.every(
      (key: unknown) =>
        typeof key === "string" && key === key.trim() && parsePublicKey(key) !== null,
    ) ||
    (action.key !== null && typeof action.key !== "string") ||
    !Array.isArray(snapshot.storedFiles)
  )
    return false;
  const encrypts = action.call === "encryptText" || action.call === "encryptFile";
  // Only an encrypt call has public keys, and only a decrypt call a key.
  if (encrypts ? action.key !== null : action.publicKeys.length > 0) return false;
  const asks = action.phase === "ask";
  const choices: readonly unknown[] = action.choices;
  const field = action.passwordField !== null;
  const value = action.value;
  if (
    (action.call === "decryptText" && !isStandardBase64(value)) ||
    ((action.call === "encryptFile" || action.call === "decryptFile") &&
      !holdsStoredFile(snapshot.storedFiles, value))
  )
    return false;
  if (asks && action.dialogActionId !== null) return false;
  // The password field asks for the call's password, which the call therefore does not write.
  if (field && (action.password !== null || action.notice !== null)) return false;
  if (encrypts) {
    if (action.notice !== null) return false;
    // The dialog or password field and the step after them; a chosen opener is not written, and a chosen time lock is
    // suggested while the dialog asks and comes from the player's answer after it.
    const dialog = asks || action.dialogActionId !== null;
    if (dialog !== (choices.length > 0 || field)) return false;
    if (choices.includes("password") && (action.password !== null || field)) return false;
    if (choices.includes("publicKey") && action.publicKeys.length > 0) return false;
    if (choices.includes("timeLock") && (action.timeLockMs !== null) !== asks) return false;
    if (
      !dialog &&
      action.password === null &&
      action.timeLockMs === null &&
      action.publicKeys.length === 0
    )
      return false;
  } else {
    if (action.timeLockMs !== null || choices.length > 0) return false;
    if (!asks && action.notice !== null) return false;
    // The unlock dialog, and the step after it, ask for nothing written: the dialog's call wrote no password or key.
    if (
      !field &&
      (asks || action.dialogActionId !== null) &&
      (action.password !== null || action.key !== null)
    )
      return false;
    if (field && asks !== (action.dialogActionId === null)) return false;
  }
  if (plan === undefined || !nonNegativeSafeInteger(action.owningInstruction)) return true;
  const owner = plan.instructions[action.owningInstruction];
  if (owner?.kind !== "lock" || owner.call !== action.call) return false;
  if ((owner.passwordField !== null) !== field) return false;
  if (owner.password === null && action.password !== null) return false;
  if ((owner.key !== null) !== (action.key !== null)) return false;
  if (owner.publicKey === null && action.publicKeys.length > 0) return false;
  if (encrypts) {
    if (owner.timeLock === null && action.timeLockMs !== null && !choices.includes("timeLock"))
      return false;
    // An encrypt call that writes no opener lets the player choose each.
    return owner.password !== null || field || choices.length === LOCK_CHOICES.length;
  }
  // Only a decrypt call without a written password or key asks in the dialog; its password field asks too.
  return (
    field ||
    (owner.password === null && owner.key === null) ||
    (!asks && action.dialogActionId === null)
  );
}

/** The openers an encrypt call's lock dialog lets the player choose, in the order the dialog shows them. */
const LOCK_CHOICES = ["timeLock", "password", "publicKey"] as const;

/** Each choice once, in the order the dialog shows them. */
function validLockChoices(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  let next = 0;
  for (const choice of value) {
    const index = LOCK_CHOICES.findIndex((known, at) => at >= next && known === choice);
    if (index === -1) return false;
    next = index + 1;
  }
  return true;
}

function isEpochMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * A pending file store: the files its instruction's call stores, each once with the type its bytes give, or the stored
 * files of this session it reads or hashes, each once. `fileFromBase64`, `fileToBase64`, and `hashFile` have exactly
 * one.
 */
function validFileStoreAction(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
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
      "destinationTemporary",
      "createdAtMs",
      "requestEventSequence",
      "operation",
      "files",
      "references",
    ]) ||
    !positiveSafeInteger(action.destinationTemporary) ||
    !validSessionTime(action.createdAtMs) ||
    !validSessionTime(snapshot.currentSessionTimeMs) ||
    action.createdAtMs > snapshot.currentSessionTimeMs ||
    !Array.isArray(action.files) ||
    !Array.isArray(action.references) ||
    !Array.isArray(snapshot.storedFiles)
  )
    return false;
  const known = snapshot.storedFiles;
  const files = action.files;
  const references = action.references;
  const stores =
    action.operation === "store" &&
    references.length === 0 &&
    files.length > 0 &&
    files.every(
      (file: unknown) =>
        isPlainRecord(file) &&
        hasExactKeys(file, ["type", "base64"]) &&
        typeof file.base64 === "string" &&
        isStandardBase64(file.base64) &&
        file.type === base64FileType(file.base64),
    ) &&
    new Set(files.map((file: Record<string, unknown>) => file.base64)).size === files.length;
  const reads =
    (action.operation === "read" || action.operation === "hash") &&
    files.length === 0 &&
    references.length > 0 &&
    references.every(
      (reference: unknown) => typeof reference === "string" && holdsStoredFile(known, reference),
    ) &&
    new Set(references).size === references.length;
  if (!stores && !reads) return false;
  if (plan === undefined || !nonNegativeSafeInteger(action.owningInstruction)) return true;
  const owner = plan.instructions[action.owningInstruction];
  if (owner?.kind !== "fileStore") return false;
  const count = Math.max(files.length, references.length);
  return (
    fileStoreOperation(owner.call) === action.operation &&
    // A conversion's value may hold many files.
    (isConversion(owner.call) || count === 1) &&
    // `fromJson` keeps only files of a recognized type.
    (owner.call !== "fromJson" ||
      files.every((file: Record<string, unknown>) => isRecognizedFileType(String(file.type))))
  );
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

/** A pending capture; it carries validated tags exactly when its capture instruction has `tags:`. */
function validCaptureAction(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  const owner =
    plan === undefined || !nonNegativeSafeInteger(action.owningInstruction)
      ? undefined
      : plan.instructions[action.owningInstruction];
  return (
    (action.tags === null || isCanonicalTagList(action.tags)) &&
    (owner?.kind !== "capture" || (owner.tags === null) === (action.tags === null)) &&
    hasExactKeys(action, [
      "kind",
      "capture",
      "tags",
      "actionId",
      "owningInstruction",
      "continuationInstruction",
      "ownerCallFrameId",
      "scopeDepth",
      "loopDepth",
      "destinationTemporary",
      "createdAtMs",
      "requestEventSequence",
    ]) &&
    action.capture === "photo" &&
    positiveSafeInteger(action.destinationTemporary) &&
    validSessionTime(action.createdAtMs) &&
    validSessionTime(snapshot.currentSessionTimeMs) &&
    action.createdAtMs <= snapshot.currentSessionTimeMs
  );
}

function validRetainedSettlement(
  settlement: unknown,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  if (!isPlainRecord(settlement)) return settlement === null;
  if (!validSettlementShapeAndKind(settlement, snapshot, plan)) return false;
  return validSettlementIdentityAndEventSequences(settlement, snapshot);
}

function validSettlementShapeAndKind(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  return (
    isOneOf(settlement.actionKind, [
      "delay",
      "interaction",
      "chatPacingGate",
      "mediaPlayback",
      "storageWrite",
      "capture",
      "fileStore",
      "lock",
    ]) &&
    (settlement.actionKind === "chatPacingGate" ||
      settlement.settlementKind === "completed" ||
      (settlement.actionKind === "interaction" &&
        (settlement.interactionKind === "button" || settlement.interactionKind === "form") &&
        settlement.settlementKind === "timedOut")) &&
    positiveSafeInteger(settlement.actionId) &&
    validSettlementProvenance(settlement, plan) &&
    validSettlementKindData(settlement, snapshot, plan)
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

  if (settlement.actionKind === "capture") {
    return (
      settlement.warningEventSequence === null ||
      (positiveSafeInteger(settlement.warningEventSequence) &&
        settlement.requestEventSequence < settlement.warningEventSequence &&
        settlement.warningEventSequence < settlement.completionEventSequence)
    );
  }
  if (settlement.actionKind !== "interaction") return true;
  // A button that timed out, a closed popup or exportText, an opened `openUrl`, and a password publish no player
  // transcript.
  if (settlement.settlementKind === "timedOut" || transcriptless(settlement.interactionKind))
    return settlement.transcriptEventSequence === null;
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
  allowDue: boolean,
): boolean {
  return (
    isPacingGateShape(action) &&
    validPacingGateIdentity(action, snapshot) &&
    validPacingGateTiming(action, snapshot, allowDue) &&
    validPacingGateCreationProvenance(action, snapshot, plan)
  );
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

/** `allowDue` admits a reading time due exactly now, as for a delay. */
function validPacingGateTiming(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  allowDue: boolean,
): boolean {
  return (
    validSessionTime(action.createdAtMs) &&
    validSessionTime(action.deadlineMs) &&
    validSessionTime(snapshot.currentSessionTimeMs) &&
    action.createdAtMs <= snapshot.currentSessionTimeMs &&
    (action.deadlineMs > snapshot.currentSessionTimeMs ||
      (action.deadlineMs === snapshot.currentSessionTimeMs &&
        (snapshot.status === "failed" || allowDue)))
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
  return ownerFitsInstruction(plan, snapshot, action.ownerCallFrameId, owningInstruction);
}

export function validateInteractionResultHandoffState(
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  const handoff = snapshot.interactionResultHandoff;
  const nextInstruction = snapshot.nextInstruction;
  const precedingInstruction =
    plan !== undefined && positiveSafeInteger(nextInstruction)
      ? plan.instructions[nextInstruction - 1]
      : undefined;
  const requiresHandoff =
    (precedingInstruction?.kind === "interaction" &&
      precedingInstruction.destinationTemporary !== null) ||
    precedingInstruction?.kind === "capture";

  if (handoff === null) {
    if (requiresHandoff) {
      errors.push(
        "Runtime interaction result handoff is missing at its canonical commit boundary.",
      );
    }
    return;
  }
  if (isPlainRecord(handoff) && handoff.actionKind === "fileStore") {
    validateFileStoreHandoff(handoff, snapshot, plan, errors);
    return;
  }
  if (isPlainRecord(handoff) && handoff.actionKind === "lock") {
    validateLockHandoff(handoff, snapshot, plan, errors);
    return;
  }
  if (
    !isPlainRecord(handoff) ||
    !hasExactKeys(handoff, [
      "actionKind",
      "actionId",
      "owningInstruction",
      "continuationInstruction",
      "ownerCallFrameId",
      "destinationTemporary",
      "result",
    ]) ||
    !isOneOf(handoff.actionKind, ["interaction", "capture"]) ||
    !positiveSafeInteger(handoff.actionId) ||
    !nonNegativeSafeInteger(handoff.owningInstruction) ||
    !nonNegativeSafeInteger(handoff.continuationInstruction) ||
    !positiveSafeInteger(handoff.destinationTemporary) ||
    (handoff.ownerCallFrameId !== null && !positiveSafeInteger(handoff.ownerCallFrameId)) ||
    !(handoff.actionKind === "capture"
      ? handoff.result === null ||
        (typeof handoff.result === "string" &&
          handoff.result.length > 0 &&
          interactionStringFits(handoff.result))
      : isFormResult(handoff.result) ||
        (isInteractionChoiceValue(handoff.result) &&
          (typeof handoff.result !== "string" || interactionStringFits(handoff.result)))) ||
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
    !validInteractionResultHandoffOwner(handoff, snapshot, plan) ||
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
  // An interaction's settlement, or a newer one, stays retained until its result is consumed.
  if (
    handoff.actionKind === "interaction" &&
    (!isPlainRecord(settlement) ||
      !positiveSafeInteger(settlement.actionId) ||
      settlement.actionId < handoff.actionId)
  ) {
    errors.push(
      "Runtime interaction result handoff requires its settlement or a newer retained settlement.",
    );
  } else if (
    isPlainRecord(settlement) &&
    settlement.actionId === handoff.actionId &&
    (settlement.actionKind !== handoff.actionKind ||
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
  if (handoff.actionKind === "capture") {
    if (
      instruction?.kind !== "capture" ||
      handoff.owningInstruction + 1 !== handoff.continuationInstruction ||
      instruction.destinationTemporary !== handoff.destinationTemporary ||
      precedingInstruction !== instruction
    ) {
      errors.push(
        "Runtime interaction result handoff does not match its canonical plan instruction.",
      );
    }
    return;
  }
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

/**
 * The Player's answer to a file store, handed off to its instruction, which runs next and has not given its result: a
 * list of texts, or `null` after a failure, as its retained settlement records.
 */
function validateFileStoreHandoff(
  handoff: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  const result = handoff.result;
  const settlement = snapshot.lastSettlement;
  if (
    !hasExactKeys(handoff, [
      "actionKind",
      "actionId",
      "owningInstruction",
      "continuationInstruction",
      "ownerCallFrameId",
      "destinationTemporary",
      "result",
    ]) ||
    !positiveSafeInteger(handoff.actionId) ||
    !nonNegativeSafeInteger(handoff.owningInstruction) ||
    handoff.continuationInstruction !== handoff.owningInstruction ||
    snapshot.nextInstruction !== handoff.owningInstruction ||
    !positiveSafeInteger(handoff.destinationTemporary) ||
    (handoff.ownerCallFrameId !== null && !positiveSafeInteger(handoff.ownerCallFrameId)) ||
    !(
      result === null ||
      (isPlainRecord(result) &&
        hasExactKeys(result, ["kind", "items"]) &&
        result.kind === "list" &&
        Array.isArray(result.items) &&
        result.items.length > 0 &&
        // An empty file's Base64 is empty.
        result.items.every((item: unknown) => typeof item === "string"))
    ) ||
    snapshot.foregroundAction !== null ||
    !isOneOf(snapshot.status, ["running", "failed"]) ||
    !isPlainRecord(settlement) ||
    settlement.actionKind !== "fileStore" ||
    settlement.actionId !== handoff.actionId ||
    settlement.owningInstruction !== handoff.owningInstruction ||
    settlement.ownerCallFrameId !== handoff.ownerCallFrameId ||
    settlement.destinationTemporary !== handoff.destinationTemporary ||
    (settlement.outcome === "failed") !== (result === null) ||
    // The stored files' references are the answer.
    (settlement.outcome === "stored" && !sameItems(result, settlement.references)) ||
    // A hash is 64 lowercase hexadecimal digits.
    (settlement.outcome === "hashed" &&
      !(isPlainRecord(result) && Array.isArray(result.items) && result.items.every(isSha256Hex))) ||
    !validInteractionResultHandoffOwner(handoff, snapshot, plan) ||
    !Array.isArray(snapshot.temporaries) ||
    snapshot.temporaries.some(
      (temporary) => isPlainRecord(temporary) && temporary.id === handoff.destinationTemporary,
    )
  ) {
    errors.push("Runtime file store answer handoff is malformed.");
    return;
  }
  if (plan === undefined) return;
  const instruction = plan.instructions[handoff.owningInstruction];
  if (
    instruction?.kind !== "fileStore" ||
    instruction.destinationTemporary !== handoff.destinationTemporary
  )
    errors.push("Runtime file store answer handoff does not match its plan instruction.");
}

/**
 * The answer of a lock step, which its instruction runs again with: its outcome, then the result text or file of a lock
 * or an opening, or the notice of a dialog that asks again.
 */
function validateLockHandoff(
  handoff: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  const result = handoff.result;
  const settlement = snapshot.lastSettlement;
  let items: string[] | null = null;
  if (
    isPlainRecord(result) &&
    hasExactKeys(result, ["kind", "items"]) &&
    result.kind === "list" &&
    Array.isArray(result.items)
  ) {
    const texts: string[] = [];
    for (const item of result.items) if (typeof item === "string") texts.push(item);
    if (texts.length === result.items.length) items = texts;
  }
  const outcome = items?.[0];
  const detail = items !== null && items.length === 2 ? items[1]! : null;
  if (
    !hasExactKeys(handoff, [
      "actionKind",
      "actionId",
      "owningInstruction",
      "continuationInstruction",
      "ownerCallFrameId",
      "destinationTemporary",
      "result",
    ]) ||
    !positiveSafeInteger(handoff.actionId) ||
    !nonNegativeSafeInteger(handoff.owningInstruction) ||
    handoff.continuationInstruction !== handoff.owningInstruction ||
    snapshot.nextInstruction !== handoff.owningInstruction ||
    !positiveSafeInteger(handoff.destinationTemporary) ||
    (handoff.ownerCallFrameId !== null && !positiveSafeInteger(handoff.ownerCallFrameId)) ||
    items === null ||
    items.length < 1 ||
    items.length > 2 ||
    !isLockOutcome(outcome) ||
    // A lock or an opening carries its result, a dialog that asks again may carry its notice, nothing else carries more.
    ((outcome === "locked" || outcome === "opened") !== (detail !== null) &&
      !(outcome === "ask" && isLockNotice(detail))) ||
    snapshot.foregroundAction !== null ||
    !isOneOf(snapshot.status, ["running", "failed"]) ||
    !isPlainRecord(settlement) ||
    settlement.actionKind !== "lock" ||
    settlement.actionId !== handoff.actionId ||
    settlement.owningInstruction !== handoff.owningInstruction ||
    settlement.ownerCallFrameId !== handoff.ownerCallFrameId ||
    settlement.destinationTemporary !== handoff.destinationTemporary ||
    settlement.outcome !== outcome ||
    // A kept file is the result.
    (settlement.file !== null && settlement.file !== detail) ||
    !validInteractionResultHandoffOwner(handoff, snapshot, plan) ||
    !Array.isArray(snapshot.temporaries) ||
    snapshot.temporaries.some(
      (temporary) => isPlainRecord(temporary) && temporary.id === handoff.destinationTemporary,
    )
  ) {
    errors.push("Runtime lock answer handoff is malformed.");
    return;
  }
  if (plan === undefined) return;
  const instruction = plan.instructions[handoff.owningInstruction];
  if (
    instruction?.kind !== "lock" ||
    instruction.destinationTemporary !== handoff.destinationTemporary ||
    !lockOutcomeFits(instruction.call, outcome, settlement.file) ||
    // A locked text is standard Base64.
    (outcome === "locked" && instruction.call === "encryptText" && !isStandardBase64(detail!))
  )
    errors.push("Runtime lock answer handoff does not match its plan instruction.");
}

/**
 * Whether a lock step's outcome fits its call: an encrypt call locks, a decrypt call opens, and a file call keeps
 * exactly the stored file it gives; only a decrypt call is not opened, cancelled, or reads its file, and the file calls
 * alone find a file unreadable.
 */
function lockOutcomeFits(call: LockCall, outcome: string, file: unknown): boolean {
  const encrypts = call === "encryptText" || call === "encryptFile";
  const files = call === "encryptFile" || call === "decryptFile";
  const result = outcome === "locked" || outcome === "opened";
  if ((outcome === "locked" && !encrypts) || (outcome === "opened" && encrypts)) return false;
  if ((outcome === "notOpened" || outcome === "cancelled") && encrypts) return false;
  if (outcome === "unreadable" && !files) return false;
  return (file !== null) === (result && files);
}

/** Whether `list` is a list value whose items are exactly `items`, in order. */
function sameItems(list: unknown, items: unknown): boolean {
  if (!isPlainRecord(list) || !Array.isArray(list.items) || !Array.isArray(items)) return false;
  const listed: readonly unknown[] = list.items;
  return listed.length === items.length && listed.every((item, index) => item === items[index]);
}

/** The code that asked receives the result: the running context, at the asking instruction. */
function validInteractionResultHandoffOwner(
  handoff: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  const context = serializedTopContext(snapshot);
  if (context === undefined || handoff.ownerCallFrameId !== context.ownerId) return false;
  return (
    plan === undefined ||
    (nonNegativeSafeInteger(handoff.owningInstruction) &&
      contextHoldsInstruction(plan, context, handoff.owningInstruction))
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
  // A skipped image request returns `null`; only a request that allowed skipping is skipped.
  if (instruction.interactionKind === "image")
    return (
      instruction.expectedResult === "string" &&
      (isImageReference(result) ||
        (result === null && imageRequestAllowsSkip(instruction, snapshot.temporaries)))
    );
  // A password's answer is the SHA-256 of what was typed.
  if (instruction.interactionKind === "password")
    return instruction.expectedResult === "string" && isSha256Hex(result);
  // The form's fields were cleared with its request; its settlement checks the answers against them.
  if (instruction.interactionKind === "form")
    return (
      instruction.expectedResult === "form" &&
      "preparedUi" in instruction &&
      instruction.preparedUi.kind === "form" &&
      // A cancelled form returns `null`; its settlement shows it had a cancel button.
      (result === null ||
        (isFormResult(result) &&
          formShapeFits(
            instruction.preparedUi.shape,
            result.kind === "list" ? "booleanList" : result.kind,
          )))
    );
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
  prepared: import("../../plan/model.js").PreparedInteractionUiPayload,
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
  // An interaction that stood still while blocks ran counts its time from later, but never from after now.
  const pausedMs = action.pausedMs ?? 0;
  if (
    !validSessionTime(action.createdAtMs) ||
    !validSessionTime(snapshot.currentSessionTimeMs) ||
    (action.pausedMs !== undefined && (!validSessionTime(pausedMs) || !(pausedMs > 0))) ||
    typeof pausedMs !== "number" ||
    action.createdAtMs + pausedMs > snapshot.currentSessionTimeMs
  )
    return false;
  if (action.timeoutMs === null) return true;
  if (
    (action.interactionKind !== "button" && action.interactionKind !== "form") ||
    typeof action.timeoutMs !== "number" ||
    !(action.timeoutMs > 0) ||
    !Number.isFinite(action.timeoutMs)
  )
    return false;
  const deadlineMs = action.createdAtMs + pausedMs + action.timeoutMs;
  return (
    validSessionTime(deadlineMs) &&
    deadlineMs > action.createdAtMs + pausedMs &&
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
      ...(action.interactionKind === "form" ? ["form"] : []),
      ...(Object.hasOwn(action, "pausedMs") ? ["pausedMs"] : []),
      ...(Object.hasOwn(action, "resumes") ? ["resumes"] : []),
    ])
  )
    return false;
  // Only a password field counts its returns after blocks.
  if (
    Object.hasOwn(action, "resumes") &&
    (action.interactionKind !== "password" || !positiveSafeInteger(action.resumes))
  )
    return false;
  if (
    !isInteractionKind(action.interactionKind) ||
    action.target !== "standardChat" ||
    !validInteractionTiming(action, snapshot, allowDue)
  )
    return false;
  const expected =
    action.interactionKind === "button" || silentInteraction(action.interactionKind)
      ? action.destinationTemporary === null
        ? "none"
        : "duration"
      : action.interactionKind === "number"
        ? "number"
        : action.interactionKind === "choice"
          ? "choice"
          : action.interactionKind === "temporal"
            ? "temporal"
            : action.interactionKind === "form"
              ? "form"
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
  // A button or a popup used as a value gives one; an `openUrl` or an `exportText` never does.
  if (
    action.destinationTemporary !== null
      ? !positiveSafeInteger(action.destinationTemporary) ||
        valuelessInteraction(action.interactionKind)
      : action.interactionKind !== "button" && !silentInteraction(action.interactionKind)
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
  // EVIDENCE: validation: validInteractionUiShape accepted the form definition above.
  if (
    action.interactionKind === "form" &&
    !(isFormUi(action.ui) && validFormState(action.ui, action.form))
  )
    return false;
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
  // The action keeps the default speaker of its request; an interrupt block may have changed the default since.
  if (instruction.speaker === null) return true;
  const explicitSpeaker = speakerGlobalValue(snapshot, instruction.speaker);
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
  instruction: import("../../plan/model.js").PreparedInteractionInstruction,
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
  // A form keeps its time limit in its definition, which its request temporary holds.
  const timeoutMs =
    prepared.kind === "button" && prepared.timeoutTemporary !== undefined
      ? buttonTimeoutMilliseconds(
          runtimeTemporaryValue(snapshot.temporaries, prepared.timeoutTemporary),
        )
      : prepared.kind === "form" && isFormUi(action.ui)
        ? (action.ui.timeout?.milliseconds ?? null)
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
  prepared: import("../../plan/model.js").PreparedInteractionUiPayload,
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
  // The temporaries keep the canonical address and the button text the request opened with.
  if (prepared.kind === "url")
    return (
      runtimeTemporaryValue(temporaries, prepared.urlTemporary) === actual.url &&
      (prepared.buttonTextTemporary === undefined
        ? actual.buttonText === DEFAULT_OPEN_URL_BUTTON_TEXT
        : runtimeTemporaryValue(temporaries, prepared.buttonTextTemporary) === actual.buttonText) &&
      (prepared.alwaysButtonTemporary === undefined
        ? actual.alwaysButton === false
        : runtimeTemporaryValue(temporaries, prepared.alwaysButtonTemporary) ===
          actual.alwaysButton)
    );
  if (prepared.kind === "popup") {
    return (
      runtimeTemporaryValue(temporaries, prepared.messageTemporary) === actual.message &&
      (prepared.buttonTextTemporary === undefined
        ? actual.buttonText === DEFAULT_POPUP_BUTTON_TEXT
        : runtimeTemporaryValue(temporaries, prepared.buttonTextTemporary) === actual.buttonText)
    );
  }
  if (prepared.kind === "export")
    return (
      runtimeTemporaryValue(temporaries, prepared.textTemporary) === actual.text &&
      (prepared.titleTemporary === undefined
        ? actual.title === DEFAULT_EXPORT_TITLE
        : runtimeTemporaryValue(temporaries, prepared.titleTemporary) === actual.title) &&
      (prepared.fileNameTemporary === undefined
        ? actual.fileName === DEFAULT_EXPORT_FILE_NAME
        : runtimeTemporaryValue(temporaries, prepared.fileNameTemporary) === actual.fileName)
    );
  if (prepared.kind === "text" || prepared.kind === "number") {
    const hint =
      prepared.hintTemporary === null
        ? null
        : runtimeTemporaryValue(temporaries, prepared.hintTemporary);
    // A field without a prefill left `null` in the temporary of its empty prefill.
    const prefill =
      prepared.prefillTemporary === undefined
        ? undefined
        : (runtimeTemporaryValue(temporaries, prepared.prefillTemporary) ?? undefined);
    return (
      hint === actual.hint &&
      prefill === actual.prefill &&
      actual.integer === (prepared.kind === "number" ? prepared.integer : undefined)
    );
  }
  if (prepared.kind === "password")
    return (
      (prepared.hintTemporary === null
        ? null
        : runtimeTemporaryValue(temporaries, prepared.hintTemporary)) === actual.hint
    );
  if (prepared.kind === "temporal") {
    const hint =
      prepared.hintTemporary === null
        ? null
        : runtimeTemporaryValue(temporaries, prepared.hintTemporary);
    const prefill =
      prepared.prefillTemporary === undefined
        ? undefined
        : (runtimeTemporaryValue(temporaries, prepared.prefillTemporary) ?? undefined);
    return (
      actual.temporalKind === prepared.temporalKind &&
      hint === actual.hint &&
      prefill === actual.prefill
    );
  }
  if (prepared.kind === "form") {
    // The open form keeps its definition in its request temporary.
    const request = runtimeTemporaryValue(temporaries, prepared.requestTemporary);
    if (!isFormUi(actual) || validateCapturedSerializableValue(request) !== null) return false;
    // EVIDENCE: validation: validateCapturedSerializableValue accepted the captured request above.
    const captured = request as SerializableRuntimeValue;
    return (
      formShapeFits(prepared.shape, actual.shape) &&
      serializableEquals(captured, formRequestValue(actual)) &&
      formAnswerMismatch(actual.fields, prepared.shape) === null
    );
  }
  if (prepared.kind === "image") {
    // The open request keeps what it shows in its request temporary.
    const request = runtimeTemporaryValue(temporaries, prepared.requestTemporary);
    const fields = imageRequestFields(actual);
    return (
      fields !== null &&
      validateCapturedSerializableValue(request) === null &&
      serializableEquals(
        // EVIDENCE: validation: validateCapturedSerializableValue accepted the captured request above.
        request as SerializableRuntimeValue,
        imageRequestValue(fields),
      )
    );
  }
  const options = preparedChoiceOptions(prepared, temporaries, context, span);
  if (options === undefined || !choiceOptionsEqual(options, actual.options)) return false;
  // The prefill temporary keeps the value, so the preselected button is found again.
  if (prepared.prefillTemporary === undefined) return actual.preselected === undefined;
  const prefill = runtimeTemporaryValue(temporaries, prepared.prefillTemporary);
  if (prefill === undefined || validateCapturedSerializableValue(prefill) !== null) return false;
  // askBoolean opens only with true, false, null, or blank text, as its prefill must be.
  if (
    prepared.booleanPrefill === true &&
    !(
      typeof prefill === "boolean" ||
      prefill === null ||
      (typeof prefill === "string" && !interactionStringHasNonWhitespace(prefill))
    )
  )
    return false;
  // EVIDENCE: validation: validateCapturedSerializableValue accepted the captured prefill above.
  const preselected = preselectedChoice(options, prefill as SerializableRuntimeValue);
  return actual.preselected === (typeof preselected === "number" ? preselected : undefined);
}

function accessibleNameEqual(
  expected: import("../../plan/model.js").InteractionAccessibleName,
  actual: unknown,
): boolean {
  if (!isPlainRecord(actual) || actual.kind !== expected.kind) return false;
  return expected.kind === "localizedDefault"
    ? actual.key === expected.key
    : actual.text === expected.text;
}

/** A speaker is a global of the session, so an interaction finds its speaker among the globals. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: boundary: binding payloads remain unvalidated during snapshot lineage checks.
function speakerGlobalValue(snapshot: Record<string, unknown>, name: string): unknown {
  if (!Array.isArray(snapshot.globals)) return undefined;
  const binding = snapshot.globals.find(
    (candidate) => isPlainRecord(candidate) && candidate.name === name,
  );
  return isPlainRecord(binding) ? binding.value : undefined;
}

function validInteractionUiShape(kind: InteractionKind, value: unknown): boolean {
  if (!isPlainRecord(value) || value.kind !== kind || !isPlainRecord(value.accessibleName))
    return false;
  const expectedUiKeys =
    kind === "button"
      ? ["kind", "buttonLabel", "accessibleName", ...("background" in value ? ["background"] : [])]
      : kind === "text" || kind === "number" || kind === "temporal" || kind === "password"
        ? [
            "kind",
            "hint",
            "accessibleName",
            // A password is never suggested.
            ...("prefill" in value && kind !== "password" ? ["prefill"] : []),
            ...(kind === "number" && "integer" in value ? ["integer"] : []),
            ...(kind === "temporal" ? ["temporalKind"] : []),
          ]
        : kind === "image"
          ? [
              "kind",
              "question",
              "hint",
              "accessibleName",
              "allowCamera",
              "allowFile",
              "allowSkip",
              "types",
              "mime",
            ]
          : kind === "form"
            ? ["kind", "shape", "fields", "hint", "submit", "cancel", "timeout", "accessibleName"]
            : kind === "popup"
              ? ["kind", "message", "buttonText", "accessibleName"]
              : kind === "url"
                ? ["kind", "url", "buttonText", "alwaysButton", "accessibleName"]
                : kind === "export"
                  ? ["kind", "text", "title", "fileName", "accessibleName"]
                  : [
                      "kind",
                      "options",
                      "accessibleName",
                      ...("preselected" in value ? ["preselected"] : []),
                    ];
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
    kind === "button" || silentInteraction(kind)
      ? "continue"
      : kind === "number"
        ? "number"
        : kind === "choice"
          ? "chooseOption"
          : kind === "password"
            ? "password"
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
  if (kind === "popup")
    return count(value.message) && count(value.buttonText) && !measurementExhausted;
  if (kind === "password")
    return (value.hint === null || count(value.hint)) && !measurementExhausted;
  // The address is canonical.
  if (kind === "url")
    return (
      count(value.url) &&
      count(value.buttonText) &&
      !measurementExhausted &&
      canonicalWebUrl(value.url) === value.url &&
      typeof value.alwaysButton === "boolean"
    );
  // The exported text may be as long as any text, outside the interaction's text limit.
  if (kind === "export")
    return (
      typeof value.text === "string" &&
      count(value.title) &&
      count(value.fileName) &&
      !measurementExhausted
    );
  if (kind === "form") return validFormUi(value, count) && !measurementExhausted;
  if (kind === "image")
    return (
      (value.question === null || count(value.question)) &&
      (value.hint === null || count(value.hint)) &&
      validImageRequestFields(value, count) &&
      !measurementExhausted
    );
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
  // A preselected button is one of the buttons.
  const preselected = "preselected" in value ? value.preselected : 0;
  if (!nonNegativeSafeInteger(preselected) || preselected >= value.options.length) return false;
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
  if (expected.kind === "popup")
    return actual.message === expected.message && actual.buttonText === expected.buttonText;
  if (expected.kind === "url")
    return (
      actual.url === expected.url &&
      actual.buttonText === expected.buttonText &&
      actual.alwaysButton === expected.alwaysButton
    );
  if (expected.kind === "export")
    return (
      actual.text === expected.text &&
      actual.title === expected.title &&
      actual.fileName === expected.fileName
    );
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
  if (expected.kind === "password") return actual.hint === expected.hint;
  if (expected.kind === "image")
    return (
      actual.question === expected.question &&
      actual.hint === expected.hint &&
      actual.allowCamera === expected.allowCamera &&
      actual.allowFile === expected.allowFile &&
      actual.allowSkip === expected.allowSkip &&
      textsEqual(expected.types, actual.types) &&
      textsEqual(expected.mime, actual.mime)
    );
  // A form is always prepared.
  if (expected.kind === "form") return false;
  return (
    choiceOptionsEqual(expected.options, actual.options) &&
    actual.preselected === expected.preselected
  );
}

/** The request fields of an image UI, read without assuming their types; `null` when one is malformed. */
function imageRequestFields(
  ui: Record<string, unknown>,
): Parameters<typeof imageRequestValue>[0] | null {
  const { question, hint, allowCamera, allowFile, allowSkip } = ui;
  const types = textList(ui.types);
  const mime = textList(ui.mime);
  if (
    (question !== null && typeof question !== "string") ||
    (hint !== null && typeof hint !== "string") ||
    typeof allowCamera !== "boolean" ||
    typeof allowFile !== "boolean" ||
    typeof allowSkip !== "boolean" ||
    types === undefined ||
    mime === undefined
  )
    return null;
  return { question, hint, allowCamera, allowFile, allowSkip, types, mime };
}

/**
 * Whether the image request of `instruction` may be skipped: its UI says so, or for a prepared request, the request its
 * temporary keeps while it is open and until its result is taken.
 */
function imageRequestAllowsSkip(
  instruction: Extract<Instruction, { kind: "interaction" }>,
  temporaries: unknown,
): boolean {
  if (!("preparedUi" in instruction))
    return instruction.ui.kind === "image" && instruction.ui.allowSkip;
  if (instruction.preparedUi.kind !== "image" || !Array.isArray(temporaries)) return false;
  const request = runtimeTemporaryValue(temporaries, instruction.preparedUi.requestTemporary);
  return (
    isPlainRecord(request) &&
    request.kind === "object" &&
    Array.isArray(request.properties) &&
    request.properties.some(
      (property: unknown) =>
        isPlainRecord(property) && property.name === "allowSkip" && property.value === true,
    )
  );
}

function textList(value: unknown): readonly string[] | null | undefined {
  if (value === null) return null;
  return Array.isArray(value) && value.every((text): text is string => typeof text === "string")
    ? value
    : undefined;
}

function textsEqual(expected: readonly string[] | null, actual: unknown): boolean {
  if (expected === null) return actual === null;
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((text, index) => actual[index] === text)
  );
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

function validCaptureSettlement(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  if (
    !hasExactKeys(settlement, [
      "actionId",
      "actionKind",
      "capture",
      "settlementKind",
      "owningInstruction",
      "continuationInstruction",
      "ownerCallFrameId",
      "destinationTemporary",
      "requestEventSequence",
      "warningEventSequence",
      "completionEventSequence",
      "completedAtMs",
      "result",
      "unavailableReason",
    ]) ||
    settlement.capture !== "photo" ||
    (settlement.ownerCallFrameId !== null && !positiveSafeInteger(settlement.ownerCallFrameId)) ||
    !positiveSafeInteger(settlement.destinationTemporary) ||
    !validSessionTime(settlement.completedAtMs) ||
    !validSessionTime(snapshot.currentSessionTimeMs) ||
    settlement.completedAtMs > snapshot.currentSessionTimeMs
  )
    return false;
  // A captured reference has no warning; an unavailable camera has a bounded reason, a warning, and a null result.
  const captured =
    typeof settlement.result === "string" &&
    settlement.result.length > 0 &&
    interactionStringFits(settlement.result) &&
    settlement.unavailableReason === null &&
    settlement.warningEventSequence === null;
  const unavailable =
    settlement.result === null &&
    isOneOf(settlement.unavailableReason, CAPTURE_UNAVAILABLE_REASONS) &&
    settlement.warningEventSequence !== null;
  if (!captured && !unavailable) return false;
  if (plan === undefined || !nonNegativeSafeInteger(settlement.owningInstruction)) return true;
  const owner = plan.instructions[settlement.owningInstruction];
  return (
    owner?.kind === "capture" && owner.destinationTemporary === settlement.destinationTemporary
  );
}

/** A settled file store; only one that stored files records their references, which this session knows. */
function validFileStoreSettlement(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  const known = new Set<unknown>(Array.isArray(snapshot.storedFiles) ? snapshot.storedFiles : []);
  if (
    !hasExactKeys(settlement, [
      "actionId",
      "actionKind",
      "settlementKind",
      "outcome",
      "owningInstruction",
      "continuationInstruction",
      "ownerCallFrameId",
      "destinationTemporary",
      "requestEventSequence",
      "completionEventSequence",
      "completedAtMs",
      "references",
    ]) ||
    !isOneOf(settlement.outcome, ["stored", "read", "hashed", "failed"]) ||
    (settlement.ownerCallFrameId !== null && !positiveSafeInteger(settlement.ownerCallFrameId)) ||
    !positiveSafeInteger(settlement.destinationTemporary) ||
    !Array.isArray(settlement.references) ||
    (settlement.outcome === "stored") !== settlement.references.length > 0 ||
    // Stored files stay known for the rest of the session.
    !settlement.references.every((reference: unknown) => known.has(reference)) ||
    new Set(settlement.references).size !== settlement.references.length ||
    !validSessionTime(settlement.completedAtMs) ||
    !validSessionTime(snapshot.currentSessionTimeMs) ||
    settlement.completedAtMs > snapshot.currentSessionTimeMs
  )
    return false;
  if (plan === undefined || !nonNegativeSafeInteger(settlement.owningInstruction)) return true;
  const owner = plan.instructions[settlement.owningInstruction];
  return (
    owner?.kind === "fileStore" &&
    owner.destinationTemporary === settlement.destinationTemporary &&
    (settlement.outcome === "failed" ||
      settlement.outcome ===
        { store: "stored", read: "read", hash: "hashed" }[fileStoreOperation(owner.call)])
  );
}

/** A settled lock step: how it ended, and the stored file it kept, which the session knows from then on. */
function validLockSettlement(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  if (
    !hasExactKeys(settlement, [
      "actionId",
      "actionKind",
      "settlementKind",
      "outcome",
      "owningInstruction",
      "continuationInstruction",
      "ownerCallFrameId",
      "destinationTemporary",
      "requestEventSequence",
      "completionEventSequence",
      "completedAtMs",
      "file",
    ]) ||
    !isLockOutcome(settlement.outcome) ||
    (settlement.ownerCallFrameId !== null && !positiveSafeInteger(settlement.ownerCallFrameId)) ||
    !positiveSafeInteger(settlement.destinationTemporary) ||
    (settlement.file !== null &&
      !(
        typeof settlement.file === "string" &&
        Array.isArray(snapshot.storedFiles) &&
        holdsStoredFile(snapshot.storedFiles, settlement.file)
      )) ||
    !validSessionTime(settlement.completedAtMs) ||
    !validSessionTime(snapshot.currentSessionTimeMs) ||
    settlement.completedAtMs > snapshot.currentSessionTimeMs
  )
    return false;
  if (plan === undefined || !nonNegativeSafeInteger(settlement.owningInstruction)) return true;
  const owner = plan.instructions[settlement.owningInstruction];
  return (
    owner?.kind === "lock" &&
    owner.destinationTemporary === settlement.destinationTemporary &&
    lockOutcomeFits(owner.call, settlement.outcome, settlement.file)
  );
}

function validSettlementKindData(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  if (settlement.actionKind === "chatPacingGate")
    return validPacingGateSettlement(settlement, snapshot);
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
  if (settlement.actionKind === "capture")
    return validCaptureSettlement(settlement, snapshot, plan);
  if (settlement.actionKind === "fileStore")
    return validFileStoreSettlement(settlement, snapshot, plan);
  if (settlement.actionKind === "lock") return validLockSettlement(settlement, snapshot, plan);
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
      // A form also records the options its cycles showed.
      ...(settlement.interactionKind === "form" ? ["shownOptions"] : []),
    ])
  )
    return false;
  const timedOut = settlement.settlementKind === "timedOut";
  if (
    !isInteractionKind(settlement.interactionKind) ||
    !positiveSafeInteger(settlement.requestEventSequence) ||
    !positiveSafeInteger(settlement.completionEventSequence) ||
    // A timed-out button or form, a closed popup or exportText, and an opened `openUrl` add nothing to the transcript.
    (timedOut || transcriptless(settlement.interactionKind)
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
  if (valuelessInteraction(settlement.interactionKind)) {
    resultValid = settlement.result === null && settlement.destinationTemporary === null;
  } else if (elapsedInteraction(settlement.interactionKind)) {
    resultValid =
      settlement.destinationTemporary === null
        ? settlement.result === null
        : validElapsedResult(settlement.result) &&
          !(timedOut && settlement.result.milliseconds === 0);
  } else if (settlement.interactionKind === "password") {
    // The SHA-256 of what was typed, never the text.
    resultValid = isSha256Hex(settlement.result);
  } else if (settlement.interactionKind === "text") {
    resultValid =
      typeof settlement.result === "string" && settlement.result === settlement.transcriptText;
  } else if (settlement.interactionKind === "number") {
    resultValid =
      typeof settlement.result === "number" &&
      Number.isFinite(settlement.result) &&
      !Object.is(settlement.result, -0);
  } else if (settlement.interactionKind === "form") {
    // `settlementMatchesPresentedUi` checked the answers against the recorded form above.
    resultValid = true;
  } else if (settlement.interactionKind === "image") {
    // A skip of a request that allowed it returns `null`, with the skip control's text as the transcript.
    resultValid =
      (isImageReference(settlement.result) &&
        settlement.transcriptText === IMAGE_ANSWER_TRANSCRIPT_TEXT) ||
      (settlement.result === null &&
        isPlainRecord(settlement.ui) &&
        settlement.ui.allowSkip === true &&
        settlement.transcriptText === IMAGE_SKIP_TEXT);
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
    !valuelessInteraction(settlement.interactionKind) &&
    (!elapsedInteraction(settlement.interactionKind) || settlement.destinationTemporary !== null) &&
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
    !ownerFitsInstruction(plan, snapshot, settlement.ownerCallFrameId, settlement.owningInstruction)
  )
    return false;
  // Only a button written with a timeout, or a form with a time limit, can time out.
  if (
    timedOut &&
    !(
      "preparedUi" in instruction &&
      ((instruction.preparedUi.kind === "button" &&
        instruction.preparedUi.timeoutTemporary !== undefined) ||
        (instruction.preparedUi.kind === "form" &&
          isFormUi(settlement.ui) &&
          settlement.ui.timeout !== null))
    )
  )
    return false;
  return "preparedUi" in instruction
    ? preparedUiFitsPresentedUi(instruction.preparedUi, settlement.ui)
    : interactionUiEqual(instruction.ui, settlement.ui);
}

/** An interaction that adds no player line to the transcript: a silent one, or a password, which is never shown. */
function transcriptless(kind: unknown): boolean {
  return silentInteraction(kind) || kind === "password";
}

/** A popup, an `openUrl`, or an `exportText`: the player gives no answer, and nothing enters the transcript. */
function silentInteraction(kind: unknown): boolean {
  return kind === "popup" || kind === "url" || kind === "export";
}

/** An `openUrl` or an `exportText`: an interaction that never gives a value. */
function valuelessInteraction(kind: unknown): boolean {
  return kind === "url" || kind === "export";
}

/** A button or a popup: an interaction that, used as a value, gives its elapsed waiting time (V30 §21, §31). */
function elapsedInteraction(kind: unknown): boolean {
  return kind === "button" || kind === "popup";
}

export function isInteractionKind(value: unknown): value is InteractionKind {
  return isOneOf(value, INTERACTION_KINDS);
}

/** A form's answers: an object, dict, or list of runtime values. Its recorded UI decides which. */
function isFormResult(
  value: unknown,
): value is SerializableRuntimeObject | SerializableRuntimeDict | SerializableRuntimeList {
  return (
    isPlainRecord(value) &&
    isOneOf(value.kind, ["object", "dict", "list"]) &&
    validateCapturedSerializableValue(value) === null
  );
}

/** An image answer: the reference of a stored image, which only the host that stored it resolves. */
function isImageReference(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && interactionStringFits(value);
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
  if (ui.kind === "form")
    return (
      isFormUi(ui) &&
      validFormResult(
        ui,
        settlement.result,
        settlement.transcriptText,
        settlement.shownOptions,
        settlement.settlementKind === "timedOut",
      )
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
  prepared: import("../../plan/model.js").PreparedInteractionUiPayload,
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
  // The temporaries are cleared after completion; the recorded request was checked by its shape. A request without
  // `buttonText:` or `alwaysButton:` shows the defaults.
  if (prepared.kind === "url")
    return (
      (prepared.buttonTextTemporary !== undefined ||
        ui.buttonText === DEFAULT_OPEN_URL_BUTTON_TEXT) &&
      (prepared.alwaysButtonTemporary !== undefined || ui.alwaysButton === false)
    );
  // A popup without `buttonText:` shows the default text.
  if (prepared.kind === "popup")
    return (
      prepared.buttonTextTemporary !== undefined || ui.buttonText === DEFAULT_POPUP_BUTTON_TEXT
    );
  // An `exportText` without `title:` or `fileName:` shows the defaults.
  if (prepared.kind === "export")
    return (
      (prepared.titleTemporary !== undefined || ui.title === DEFAULT_EXPORT_TITLE) &&
      (prepared.fileNameTemporary !== undefined || ui.fileName === DEFAULT_EXPORT_FILE_NAME)
    );
  if (prepared.kind === "text" || prepared.kind === "number")
    return (
      (ui.hint === null) === (prepared.hintTemporary === null) &&
      // Only a `prefill:` prefills, and one that was empty when the field opened did not.
      (!("prefill" in ui) || prepared.prefillTemporary !== undefined) &&
      ui.integer === (prepared.kind === "number" ? prepared.integer : undefined)
    );
  if (prepared.kind === "temporal")
    return (
      ui.temporalKind === prepared.temporalKind &&
      (ui.hint === null) === (prepared.hintTemporary === null) &&
      (!("prefill" in ui) || prepared.prefillTemporary !== undefined)
    );
  if (prepared.kind === "password") return (ui.hint === null) === (prepared.hintTemporary === null);
  // The request temporary is cleared after completion; the recorded request was checked by its shape.
  if (prepared.kind === "image") return true;
  if (prepared.kind === "form") return formShapeFits(prepared.shape, ui.shape);
  return (
    Array.isArray(ui.options) &&
    buttonsFitWrittenValues(prepared.values, ui.options) &&
    // Only a `prefill:` preselects; its temporary is cleared after completion.
    (!("preselected" in ui) || prepared.prefillTemporary !== undefined)
  );
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
    ])
  )
    return false;
  if (settlement.settlementKind === "completed")
    return validSettlementChronology(settlement, snapshot);
  return (
    settlement.settlementKind === "skipped" &&
    validSkipPacingSettlementChronology(settlement, snapshot)
  );
}

function validSkipPacingSettlementChronology(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): boolean {
  // A skip happens at scene time no later than the deadline.
  return (
    validSessionTime(settlement.deadlineMs) &&
    validSessionTime(settlement.completedAtMs) &&
    validSessionTime(snapshot.currentSessionTimeMs) &&
    settlement.completedAtMs <= settlement.deadlineMs &&
    settlement.completedAtMs <= snapshot.currentSessionTimeMs
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

/** A button's or popup's elapsed waiting time: a finite, non-negative duration. */
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
  if (isFormResult(destination) || isFormResult(result)) {
    return (
      isFormResult(destination) && isFormResult(result) && serializableEquals(destination, result)
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
  // A file store's or lock's instruction runs again with the answer.
  if (
    !nonNegativeSafeInteger(owningInstruction) ||
    !nonNegativeSafeInteger(continuationInstruction) ||
    continuationInstruction !==
      owningInstruction +
        (settlement.actionKind === "fileStore" || settlement.actionKind === "lock" ? 0 : 1)
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
            : settlement.actionKind === "capture"
              ? "capture"
              : settlement.actionKind === "fileStore"
                ? "fileStore"
                : settlement.actionKind === "lock"
                  ? "lock"
                  : "say";
  if (plan.instructions[owningInstruction]?.kind !== expectedKind) return false;
  const definition = functionHoldingInstruction(plan, owningInstruction);
  return definition === undefined
    ? continuationInstruction <
        (plan.files[fileOfInstruction(plan, owningInstruction)]?.rootEndInstruction ?? 0)
    : continuationInstruction < definition.endInstruction;
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
