import type { Instruction, InstructionPlan, InteractionUiPayload } from "../plan/model.js";
import {
  boundedInteractionUtf8ByteLength,
  interactionStringFits,
  interactionStringHasNonWhitespace,
  MAX_INTERACTION_AGGREGATE_UTF8_BYTES,
  MAX_INTERACTION_OPTION_ENTRIES,
} from "../interaction-limits.js";
import type { RuntimeChatPacingGateSettlementSnapshot } from "./actions/model.js";
import { requiredActionCompletionEvents } from "./actions/model.js";
import { recordValidationTestWork } from "../validation-testing.js";

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
  if (!validBackgroundPacingActions(value, plan)) {
    errors.push("Runtime backgroundActions are malformed.");
  }
  if (!positiveSafeInteger(value.nextActionId))
    errors.push("Runtime nextActionId must be a positive safe integer.");
  const action = value.foregroundAction;
  if (action !== null) {
    const callIds = Array.isArray(value.callFrames)
      ? new Set(value.callFrames.filter(isPlainRecord).map((frame) => frame.id))
      : new Set<unknown>();
    const currentSessionTimeMs = value.currentSessionTimeMs;
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
        "requestEventSequence",
      ]) &&
      validSessionTime(action.createdAtMs) &&
      validSessionTime(action.deadlineMs) &&
      validSessionTime(currentSessionTimeMs) &&
      action.createdAtMs <= currentSessionTimeMs &&
      action.deadlineMs > currentSessionTimeMs;
    const baseValid = validForegroundActionBase(action, value, callIds);
    const kindValid = validForegroundActionKind(action, value, plan, delayTimesAreValid);
    if (
      !baseValid ||
      !kindValid ||
      (plan !== undefined &&
        isPlainRecord(action) &&
        !validForegroundActionOwnership(action, value, plan))
    ) {
      errors.push("Runtime foreground action is malformed.");
    }
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
  const actions = [snapshot.foregroundAction, ...backgroundActions];
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
  if (!isCanonicalJsonArray(actions) || actions.length > 1) return false;

  for (let index = 0; index < actions.length; index += 1) {
    if (!validPacingGateAction(actions[index], snapshot, plan, false)) return false;
  }
  return true;
}

function validForegroundActionKind(
  action: unknown,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  delayTimesAreValid: boolean,
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
      validInteractionAction(action, snapshot, plan) &&
      hasEventSequenceCapacity(snapshot.nextEventSequence, 2)
    );
  }
  if (action.kind === "chatPacingGate") {
    return (
      validPacingGateAction(action, snapshot, plan, true) &&
      hasEventSequenceCapacity(snapshot.nextEventSequence, 1)
    );
  }
  return false;
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
    ["delay", "interaction", "chatPacingGate"].includes(String(settlement.actionKind)) &&
    (settlement.actionKind === "chatPacingGate" || settlement.settlementKind === "completed") &&
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
  ].filter(isPlainRecord);
  const actionIds = new Set<number>();
  const requestSequences = new Set<number>();
  const settlement = isPlainRecord(snapshot.lastSettlement) ? snapshot.lastSettlement : null;

  for (const action of actions) {
    if (!positiveSafeInteger(action.actionId) || !positiveSafeInteger(action.requestEventSequence))
      return false;
    if (actionIds.has(action.actionId) || requestSequences.has(action.requestEventSequence))
      return false;
    if (settlement !== null && !validActiveActionAgainstSettlement(action, settlement))
      return false;
    actionIds.add(action.actionId);
    requestSequences.add(action.requestEventSequence);
  }
  return true;
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

  const backgroundPacingAction = backgroundPacingActions[0];
  if (backgroundPacingAction === undefined) return false;

  return validPacingGateCreatedBeforeForegroundDelay(backgroundPacingAction, foregroundAction);
}

function validPacingGateCreatedBeforeForegroundDelay(
  pacingGate: Record<string, unknown>,
  delay: Record<string, unknown>,
): boolean {
  return (
    positiveSafeInteger(pacingGate.actionId) &&
    positiveSafeInteger(pacingGate.requestEventSequence) &&
    positiveSafeInteger(delay.actionId) &&
    positiveSafeInteger(delay.requestEventSequence) &&
    pacingGate.actionId < delay.actionId &&
    pacingGate.requestEventSequence < delay.requestEventSequence
  );
}

function validActiveActionAgainstSettlement(
  action: Record<string, unknown>,
  settlement: Record<string, unknown>,
): boolean {
  if (
    !positiveSafeInteger(action.actionId) ||
    !positiveSafeInteger(action.requestEventSequence) ||
    !positiveSafeInteger(settlement.actionId) ||
    !positiveSafeInteger(settlement.requestEventSequence) ||
    !positiveSafeInteger(settlement.completionEventSequence)
  )
    return false;

  if (!validActiveActionEventIdentity(action, settlement)) return false;
  if (validActionCreatedAfterSettlement(action, settlement)) return true;
  if (validOlderPacingGateWithNewerDelaySettlement(action, settlement)) return true;
  return validForegroundDelayWithOlderPacingSettlement(action, settlement);
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

function validOlderPacingGateWithNewerDelaySettlement(
  action: Record<string, unknown>,
  settlement: Record<string, unknown>,
): boolean {
  // A pacing gate can remain background while a later foreground delay settles,
  // then be promoted by a later say. It must predate that delay in both action
  // identity and request sequence. An interaction would have consumed it, and
  // a second pacing settlement would require a second simultaneous gate.
  const actionId = action.actionId;
  const requestEventSequence = action.requestEventSequence;
  const settlementActionId = settlement.actionId;
  const settlementRequestEventSequence = settlement.requestEventSequence;
  const settlementCompletionEventSequence = settlement.completionEventSequence;
  return (
    action.kind === "chatPacingGate" &&
    settlement.actionKind === "delay" &&
    positiveSafeInteger(actionId) &&
    positiveSafeInteger(requestEventSequence) &&
    positiveSafeInteger(settlementActionId) &&
    positiveSafeInteger(settlementRequestEventSequence) &&
    positiveSafeInteger(settlementCompletionEventSequence) &&
    actionId < settlementActionId &&
    requestEventSequence < settlementRequestEventSequence &&
    settlementRequestEventSequence < settlementCompletionEventSequence
  );
}

function validForegroundDelayWithOlderPacingSettlement(
  action: Record<string, unknown>,
  settlement: Record<string, unknown>,
): boolean {
  // A wait requested after a pacing gate may remain foreground while that
  // older background gate settles. The delay request is therefore between the
  // pacing request and completion, even though its action ID is newer.
  const actionId = action.actionId;
  const requestEventSequence = action.requestEventSequence;
  const settlementActionId = settlement.actionId;
  const settlementRequestEventSequence = settlement.requestEventSequence;
  const settlementCompletionEventSequence = settlement.completionEventSequence;
  return (
    action.kind === "delay" &&
    settlement.actionKind === "chatPacingGate" &&
    positiveSafeInteger(actionId) &&
    positiveSafeInteger(requestEventSequence) &&
    positiveSafeInteger(settlementActionId) &&
    positiveSafeInteger(settlementRequestEventSequence) &&
    positiveSafeInteger(settlementCompletionEventSequence) &&
    actionId > settlementActionId &&
    requestEventSequence > settlementRequestEventSequence &&
    requestEventSequence < settlementCompletionEventSequence
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
    action.deadlineMs > snapshot.currentSessionTimeMs
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
      "speaker",
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
    typeof value.text === "string" &&
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
    !(
      (typeof handoff.result === "string" && interactionStringFits(handoff.result)) ||
      (typeof handoff.result === "number" &&
        Number.isFinite(handoff.result) &&
        !Object.is(handoff.result, -0))
    ) ||
    !positiveSafeInteger(snapshot.nextActionId) ||
    handoff.actionId >= snapshot.nextActionId ||
    snapshot.foregroundAction !== null ||
    !["running", "failed"].includes(String(snapshot.status)) ||
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
    !validInteractionResultForInstruction(instruction, handoff.result, snapshot)
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
    (handoff.actionKind !== "delay" && handoff.actionKind !== "interaction") ||
    !nonNegativeSafeInteger(handoff.owningInstruction) ||
    !nonNegativeSafeInteger(handoff.continuationInstruction) ||
    !positiveSafeInteger(snapshot.nextActionId) ||
    handoff.actionId !== snapshot.nextActionId - 1 ||
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
    handoff.continuationInstruction === plan.rootEndInstruction &&
    snapshot.nextInstruction === plan.rootEndInstruction &&
    handoff.owningInstruction + 1 === handoff.continuationInstruction &&
    ((handoff.actionKind === "delay" && instruction?.kind === "wait") ||
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

  // Only the older background pacing gate can settle after a terminal delay
  // and replace bounded replay before root completion is entered.
  return (
    handoff.actionKind === "delay" &&
    settlement.actionKind === "chatPacingGate" &&
    positiveSafeInteger(settlement.actionId) &&
    settlement.actionId < handoff.actionId
  );
}

function validInteractionResultForInstruction(
  instruction: Extract<Instruction, { kind: "interaction" }>,
  result: unknown,
  snapshot: Record<string, unknown>,
): boolean {
  if (instruction.expectedResult === "number") {
    if (typeof result !== "number" || !Number.isFinite(result) || Object.is(result, -0))
      return false;
    if (instruction.interactionKind !== "choice") return true;
    if ("preparedUi" in instruction) {
      return (
        instruction.preparedUi.kind === "choice" &&
        instruction.preparedUi.labelType === "number" &&
        instruction.preparedUi.labels?.includes(result) === true
      );
    }
    return (
      instruction.ui.kind === "choice" &&
      instruction.ui.options.some((option) => option.label === result)
    );
  }
  if (
    instruction.expectedResult !== "string" ||
    typeof result !== "string" ||
    !interactionStringFits(result)
  )
    return false;
  if (instruction.interactionKind === "text") {
    return !result.includes("\r") && interactionStringHasNonWhitespace(result);
  }
  if (instruction.interactionKind !== "choice") return false;
  if ("preparedUi" in instruction) {
    if (instruction.preparedUi.kind !== "choice") return false;
    if (instruction.preparedUi.labelType === "identifier") {
      return instruction.preparedUi.labels?.includes(result) === true;
    }
    if (instruction.preparedUi.labelType !== "none" || !Array.isArray(snapshot.temporaries))
      return false;
    const raw = runtimeTemporaryValue(
      snapshot.temporaries,
      instruction.preparedUi.optionsTemporary,
    );
    return (
      isPlainRecord(raw) &&
      raw.kind === "list" &&
      Array.isArray(raw.items) &&
      raw.items.some((text) => text === result)
    );
  }
  return (
    instruction.ui.kind === "choice" &&
    instruction.ui.options.some((option) => (option.label ?? option.text) === result)
  );
}

function validInteractionAction(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
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
      "requestEventSequence",
    ])
  )
    return false;
  if (
    !["button", "text", "number", "choice"].includes(String(action.interactionKind)) ||
    action.target !== "standardChat"
  )
    return false;
  const expected =
    action.interactionKind === "button"
      ? "none"
      : action.interactionKind === "number" ||
          (action.interactionKind === "choice" &&
            isPlainRecord(action.ui) &&
            action.ui.labelType === "number")
        ? "number"
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
    action.interactionKind === "button"
      ? action.destinationTemporary !== null
      : !positiveSafeInteger(action.destinationTemporary)
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
  // EVIDENCE: validation: the preceding discriminator check restricts interactionKind to the four UI variants.
  if (
    !validInteractionUiShape(
      action.interactionKind as "button" | "text" | "number" | "choice",
      action.ui,
    )
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
  if (!interactionUiEqual(instruction.ui, action.ui)) return false;
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
  return preparedInteractionUiMatchesAction(
    instruction.preparedUi,
    action.ui,
    snapshot.temporaries,
  );
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
): boolean {
  if (
    !isPlainRecord(actual) ||
    actual.kind !== prepared.kind ||
    !accessibleNameEqual(prepared.accessibleName, actual.accessibleName)
  )
    return false;
  if (prepared.kind === "button") {
    return runtimeTemporaryValue(temporaries, prepared.buttonLabelTemporary) === actual.buttonLabel;
  }
  if (prepared.kind === "text" || prepared.kind === "number") {
    const hint =
      prepared.hintTemporary === null
        ? null
        : runtimeTemporaryValue(temporaries, prepared.hintTemporary);
    return hint === actual.hint;
  }
  const raw = runtimeTemporaryValue(temporaries, prepared.optionsTemporary);
  if (
    !isPlainRecord(raw) ||
    raw.kind !== "list" ||
    !Array.isArray(raw.items) ||
    raw.items.length !== prepared.optionCount
  )
    return false;
  if (
    !Array.isArray(actual.options) ||
    actual.options.length !== prepared.optionCount ||
    actual.labelType !== prepared.labelType
  )
    return false;
  const options = actual.options;
  const labels = prepared.labelType === "none" ? null : prepared.labels;
  return raw.items.every((text, index) => {
    const option = options[index];
    return (
      typeof text === "string" &&
      isPlainRecord(option) &&
      option.text === text &&
      option.label === (labels?.[index] ?? null)
    );
  });
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

function validInteractionUiShape(
  kind: "button" | "text" | "number" | "choice",
  value: unknown,
): boolean {
  if (!isPlainRecord(value) || value.kind !== kind || !isPlainRecord(value.accessibleName))
    return false;
  const expectedUiKeys =
    kind === "button"
      ? ["kind", "buttonLabel", "accessibleName"]
      : kind === "text" || kind === "number"
        ? ["kind", "hint", "accessibleName"]
        : ["kind", "labelType", "options", "accessibleName"];
  if (!hasExactKeys(value, expectedUiKeys)) return false;
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
    return count(value.buttonLabel) && !measurementExhausted;
  }
  if (kind === "text" || kind === "number") {
    return (value.hint === null || count(value.hint)) && !measurementExhausted;
  }
  if (
    !Array.isArray(value.options) ||
    value.options.length === 0 ||
    value.options.length > MAX_INTERACTION_OPTION_ENTRIES ||
    !["none", "identifier", "number"].includes(String(value.labelType))
  )
    return false;
  const labels = new Set<string | number>();
  const texts = new Set<string>();
  for (const option of value.options) {
    if (!isPlainRecord(option) || !hasExactKeys(option, ["text", "label"])) {
      return false;
    }
    const optionText = option.text;
    const textValid = count(optionText);
    if (!textValid && !measurementExhausted) return false;
    const label = option.label;
    const validLabel =
      value.labelType === "none"
        ? label === null
        : value.labelType === "identifier"
          ? typeof label === "string" &&
            count(label) &&
            (measurementExhausted || /^[A-Za-z_][A-Za-z0-9_]*$/u.test(label))
          : typeof label === "number" && Number.isFinite(label) && !Object.is(label, -0);
    if (!validLabel) return false;
    if (
      !measurementExhausted &&
      label !== null &&
      (typeof label === "string" || typeof label === "number")
    ) {
      if (labels.has(label)) return false;
      labels.add(label);
    }
    if (!measurementExhausted && value.labelType === "none") {
      // EVIDENCE: validation: the option text passed the string validation before duplicate checking.
      if (texts.has(optionText as string)) return false;
      // EVIDENCE: validation: the option text passed the string validation before insertion.
      texts.add(optionText as string);
    }
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
  if (expected.kind === "button") return actual.buttonLabel === expected.buttonLabel;
  if (expected.kind === "text" || expected.kind === "number") return actual.hint === expected.hint;
  if (expected.kind !== "choice") return false;
  if (actual.labelType !== expected.labelType) return false;
  if (!Array.isArray(actual.options)) return false;
  if (actual.options.length !== expected.options.length) return false;
  const options = actual.options;
  return expected.options.every((option, index) => {
    const candidate = options[index];
    return (
      isPlainRecord(candidate) && candidate.text === option.text && candidate.label === option.label
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
    ])
  )
    return false;
  if (
    !["button", "text", "number", "choice"].includes(String(settlement.interactionKind)) ||
    typeof settlement.transcriptText !== "string" ||
    !interactionStringFits(settlement.transcriptText) ||
    !positiveSafeInteger(settlement.requestEventSequence) ||
    !positiveSafeInteger(settlement.transcriptEventSequence) ||
    !positiveSafeInteger(settlement.completionEventSequence) ||
    settlement.requestEventSequence >= settlement.transcriptEventSequence ||
    settlement.transcriptEventSequence >= settlement.completionEventSequence
  )
    return false;
  const settlementInstruction =
    plan !== undefined && nonNegativeSafeInteger(settlement.owningInstruction)
      ? plan.instructions[settlement.owningInstruction]
      : undefined;
  const numericChoice =
    settlementInstruction?.kind === "interaction" &&
    settlementInstruction.interactionKind === "choice" &&
    ("preparedUi" in settlementInstruction
      ? settlementInstruction.preparedUi.kind === "choice" &&
        settlementInstruction.preparedUi.labelType === "number"
      : settlementInstruction.ui.kind === "choice" &&
        settlementInstruction.ui.labelType === "number");
  const validNumberResult =
    typeof settlement.result === "number" &&
    Number.isFinite(settlement.result) &&
    !Object.is(settlement.result, -0);
  let resultValid: boolean;
  if (settlement.interactionKind === "button") {
    resultValid = settlement.result === null;
  } else if (settlement.interactionKind === "text") {
    resultValid =
      typeof settlement.result === "string" && settlement.result === settlement.transcriptText;
  } else if (settlement.interactionKind === "number" || numericChoice) {
    resultValid = validNumberResult;
  } else if (settlement.interactionKind === "choice" && plan === undefined) {
    resultValid =
      (typeof settlement.result === "string" && interactionStringFits(settlement.result)) ||
      validNumberResult;
  } else {
    resultValid = typeof settlement.result === "string" && interactionStringFits(settlement.result);
  }
  if (!resultValid) return false;

  const resultBearing = settlement.interactionKind !== "button";
  if (resultBearing) {
    if (!positiveSafeInteger(settlement.destinationTemporary)) return false;
  } else if (settlement.destinationTemporary !== null) return false;
  if (
    settlement.ownerCallFrameId !== null &&
    (!positiveSafeInteger(settlement.ownerCallFrameId) ||
      !positiveSafeInteger(snapshot.nextCallFrameId) ||
      settlement.ownerCallFrameId >= snapshot.nextCallFrameId)
  )
    return false;
  if (
    settlement.interactionKind === "text" &&
    (settlement.result !== settlement.transcriptText ||
      settlement.transcriptText.includes("\r") ||
      !interactionStringHasNonWhitespace(settlement.transcriptText))
  )
    return false;
  if (settlement.interactionKind === "number") {
    if (
      typeof settlement.result !== "number" ||
      /[\r\n\u2028\u2029]/u.test(settlement.transcriptText) ||
      !/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u.test(settlement.transcriptText)
    )
      return false;
    const parsed = Number(settlement.transcriptText);
    if (!Number.isFinite(parsed) || (Object.is(parsed, -0) ? 0 : parsed) !== settlement.result)
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
  if ("preparedUi" in instruction) {
    return preparedInteractionSettlementMatches(
      instruction.preparedUi,
      settlement.result,
      settlement.transcriptText,
      Array.isArray(snapshot.temporaries) ? snapshot.temporaries : [],
    );
  }
  if (instruction.ui.kind === "button")
    return settlement.transcriptText === instruction.ui.buttonLabel;
  if (instruction.ui.kind === "text") return settlement.result === settlement.transcriptText;
  if (instruction.ui.kind === "number") return true;
  if (instruction.ui.kind !== "choice") return false;
  return instruction.ui.options.some(
    (option) =>
      option.text === settlement.transcriptText &&
      (option.label ?? option.text) === settlement.result,
  );
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
  return (
    validSessionTime(settlement.deadlineMs) &&
    validSessionTime(settlement.completedAtMs) &&
    validSessionTime(snapshot.currentSessionTimeMs) &&
    settlement.completedAtMs < settlement.deadlineMs &&
    settlement.completedAtMs <= snapshot.currentSessionTimeMs
  );
}

function preparedInteractionSettlementMatches(
  prepared: import("../plan/model.js").PreparedInteractionUiPayload,
  result: unknown,
  transcriptText: string,
  temporaries: readonly unknown[],
): boolean {
  if (prepared.kind === "button") {
    const label = runtimeTemporaryValue(temporaries, prepared.buttonLabelTemporary);
    return label === undefined || label === transcriptText;
  }
  if (prepared.kind === "text") return result === transcriptText;
  if (prepared.kind === "number") return true;

  const labels = prepared.labelType === "none" ? null : prepared.labels;
  if (prepared.labelType === "identifier") {
    if (typeof result !== "string" || labels?.includes(result) !== true) return false;
  } else if (prepared.labelType === "number") {
    if (typeof result !== "number" || labels?.includes(result) !== true) return false;
  } else if (result !== transcriptText) {
    return false;
  }

  const raw = runtimeTemporaryValue(temporaries, prepared.optionsTemporary);
  if (raw === undefined) return true;
  if (
    !isPlainRecord(raw) ||
    raw.kind !== "list" ||
    !Array.isArray(raw.items) ||
    raw.items.length !== prepared.optionCount
  )
    return false;
  return raw.items.some(
    (text, index) => text === transcriptText && (labels?.[index] ?? text) === result,
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
  const currentSessionTimeMs = snapshot.currentSessionTimeMs;
  return (
    validSessionTime(settlement.deadlineMs) &&
    validSessionTime(settlement.completedAtMs) &&
    validSessionTime(currentSessionTimeMs) &&
    settlement.completedAtMs >= settlement.deadlineMs &&
    settlement.completedAtMs <= currentSessionTimeMs
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
  return destination === result;
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
        : "say";
  if (plan.instructions[owningInstruction]?.kind !== expectedKind) return false;
  const definition = plan.functions.find(
    (candidate) =>
      owningInstruction >= candidate.entryInstruction &&
      owningInstruction < candidate.endInstruction,
  );
  return definition === undefined
    ? continuationInstruction <= plan.rootEndInstruction
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
    !["wait", "interaction", "say"].includes(plan.instructions[owningInstruction]?.kind ?? "")
  )
    return false;

  const definition = plan.functions.find(
    (candidate) =>
      owningInstruction >= candidate.entryInstruction &&
      owningInstruction < candidate.endInstruction,
  );
  const callFrames = Array.isArray(snapshot.callFrames) ? snapshot.callFrames : [];
  const activeFrame = callFrames.at(-1);
  if (definition === undefined) {
    return (
      continuationInstruction <= plan.rootEndInstruction &&
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
