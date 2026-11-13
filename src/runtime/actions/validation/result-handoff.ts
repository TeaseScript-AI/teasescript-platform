// The restore check of an interaction result's handoff: its owner, a file store or lock handoff, and whether a result
// fits its instruction.

import { isInteractionChoiceValue } from "../../../choice-values.js";
import { serializableEquals } from "../../values/serializable-values.js";
import { isOneOf } from "../../../plan/validation-support.js";
import { type Instruction, type InstructionPlan } from "../../../plan/model.js";
import {
  interactionStringFits,
  interactionStringHasNonWhitespace,
} from "../../../interaction-limits.js";
import { isLockNotice, isLockOutcome } from "../model.js";
import { buttonTimeoutMilliseconds } from "../interaction.js";
import { formShapeFits } from "../form/materialize.js";
import { isStandardBase64 } from "../../host-data/stored-files.js";
import { isSha256Hex } from "../../values/sha256.js";
import {
  contextHoldsInstruction,
  serializedTopContext,
} from "../../scopes/activation-validation.js";
import { isPlainRecord } from "../../values/plain-data.js";
import {
  validSessionTime,
  positiveSafeInteger,
  nonNegativeSafeInteger,
  hasExactKeys,
  lockOutcomeFits,
  sameItems,
  runtimeTemporaryValue,
  isFormResult,
  isImageReference,
  isTemporalAnswer,
} from "./shared-checks.js";
import {
  preparedChoiceOptions,
  snapshotTemporalContextAt,
  imageRequestAllowsSkip,
} from "./interaction-actions.js";
import { validElapsedResult, sameCanonicalSettlementResult } from "./settlements.js";

export function validateInteractionResultHandoffState(
  snapshot: Record<string, unknown>,
  plan: InstructionPlan,
  errors: string[],
): void {
  const handoff = snapshot.interactionResultHandoff;
  const nextInstruction = snapshot.nextInstruction;
  const precedingInstruction = positiveSafeInteger(nextInstruction)
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
  plan: InstructionPlan,
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
  plan: InstructionPlan,
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

/** The code that asked receives the result: the running context, at the asking instruction. */
function validInteractionResultHandoffOwner(
  handoff: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan,
): boolean {
  const context = serializedTopContext(snapshot);
  if (context === undefined || handoff.ownerCallFrameId !== context.ownerId) return false;
  return (
    nonNegativeSafeInteger(handoff.owningInstruction) &&
    contextHoldsInstruction(plan, context, handoff.owningInstruction)
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
