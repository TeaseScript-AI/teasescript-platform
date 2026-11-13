// The restore check of a retained settlement: its shape, identity, event sequences, provenance, chronology and each
// kind's data.

import { isIntegerAnswerText } from "../../../interaction-answers.js";
import { isInteractionChoiceValue } from "../../../choice-values.js";
import { serializableEquals } from "../../values/serializable-values.js";
import { isOneOf } from "../../../plan/validation-support.js";
import { type InstructionPlan } from "../../../plan/model.js";
import {
  interactionStringFits,
  interactionStringHasNonWhitespace,
} from "../../../interaction-limits.js";
import { CAPTURE_UNAVAILABLE_REASONS, fileStoreOperation, isLockOutcome } from "../model.js";
import { isFormUi } from "../form/ui-state.js";
import { IMAGE_ANSWER_TRANSCRIPT_TEXT, IMAGE_SKIP_TEXT } from "../../../image-input.js";
import { holdsStoredFile } from "../../host-data/stored-files.js";
import { isSha256Hex } from "../../values/sha256.js";
import { fileOfInstruction, ownerFitsInstruction } from "../../scopes/activation-validation.js";
import { functionHoldingInstruction } from "../../snapshot/snapshot-validation-analysis.js";
import { isPlainRecord } from "../../values/plain-data.js";
import {
  validSessionTime,
  positiveSafeInteger,
  nonNegativeSafeInteger,
  hasExactKeys,
  lockOutcomeFits,
  transcriptless,
  valuelessInteraction,
  elapsedInteraction,
  isInteractionKind,
  isFormResult,
  isImageReference,
  isTemporalAnswerKind,
  isTemporalAnswer,
} from "./shared-checks.js";
import { validMediaWaitOutcome } from "./foreground-kinds.js";
import {
  validInteractionUiShape,
  interactionUiEqual,
  settlementMatchesPresentedUi,
  preparedUiFitsPresentedUi,
} from "./interaction-ui.js";

export function validRetainedSettlement(
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
      // A form also records the options its cycles showed and the presentation of its answers.
      ...(settlement.interactionKind === "form" ? ["shownOptions", "temporalPresentation"] : []),
    ])
  )
    return false;
  const timedOut = settlement.settlementKind === "timedOut";
  if (
    !isInteractionKind(settlement.interactionKind) ||
    !positiveSafeInteger(settlement.requestEventSequence) ||
    !positiveSafeInteger(settlement.completionEventSequence) ||
    // A timed-out button or form, a closed popup or exportText, an opened `openUrl`, and an answered password add
    // nothing to the transcript.
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
export function validElapsedResult(
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

export function sameCanonicalSettlementResult(destination: unknown, result: unknown): boolean {
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
