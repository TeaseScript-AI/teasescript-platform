// The restore checks of the foreground action kinds other than an interaction: locks, file store and storage writes,
// captures, media playback and pacing gates.

import { isConversion } from "../../../conversions.js";
import { isOneOf } from "../../../plan/validation-support.js";
import { isCanonicalTagList } from "../../../tags.js";
import { type InstructionPlan } from "../../../plan/model.js";
import { fileStoreOperation, isLockNotice } from "../model.js";
import {
  base64FileType,
  holdsStoredFile,
  isRecognizedFileType,
  isStandardBase64,
} from "../../host-data/stored-files.js";
import { MAX_LOCK_PUBLIC_KEYS, parsePublicKey } from "../../../public-keys.js";
import { validateScriptStorageEntries } from "../../host-data/script-storage.js";
import { ownerFitsInstruction } from "../../scopes/activation-validation.js";
import { isPlainRecord } from "../../values/plain-data.js";
import {
  validSessionTime,
  positiveSafeInteger,
  nonNegativeSafeInteger,
  hasExactKeys,
} from "./shared-checks.js";

/**
 * A pending step of a lock, for its instruction's call. An encrypt call's lock dialog asks for the openers the player
 * chooses, suggesting a moment for a chosen time lock, after its password field, of `password: askPassword(...)`, asked
 * for the password; the step after them locks with the openers the call gives and what the player gave, and a step
 * without them has an opener. Only an encrypt call has public keys, each read as one, and only a decrypt call a key. A
 * decrypt call has no time lock and chooses nothing; its dialog, and the step after it, have no written password or
 * key, its password field always asks first, and its notice belongs to the dialog. The text is any text, the Base64
 * lock standard Base64, and a file one this session knows.
 */
export function validLockAction(
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
export function validFileStoreAction(
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
export function validStorageWriteAction(
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
export function validCaptureAction(
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

/** An async play's wait ends with its load result; a blocking play's wait ends with its media. */
export function validMediaWaitOutcome(
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
export function validMediaPlaybackAction(
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

export function validPacingGateAction(
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
