import type {
  RuntimeActionSettlementSnapshot,
  RuntimePendingActionSnapshot,
  RuntimePreparedSayOutputSnapshot,
} from "./actions/model.js";
import type {
  ExpressionPlan,
  Instruction,
  InstructionPlan,
  InteractionUiPayload,
} from "../plan/model.js";
import { cloneMessageMarkup } from "../message-markup.js";
import { captureOrReuseInstructionPlan } from "../plan/capture.js";
import { captureExternalData, type ExternalDataFailureKind } from "../external-data-capture.js";
import { createSourceSpan, type SourceSpan } from "../source.js";
import {
  hasActivePacingGate,
  hasPacingExecutionHistory,
  isExplicitExitHaltState,
  validPreparedSayOutput,
  validTopLevelPreparedSayOutputRelationship,
  validateInteractionResultHandoffState,
  validatePendingActionState,
  validateTerminalContinuationHandoffState,
} from "./action-validation.js";
import {
  createXorShift32State,
  DEFAULT_PLAYGROUND_SEED,
  XORSHIFT32_ALGORITHM,
  type XorShift32State,
} from "./random.js";
import {
  cloneCapturedSerializableValue,
  validateCapturedSerializableValue,
  type SerializableRuntimeProperty,
  type SerializableRuntimeList,
  type SerializableRuntimeRange,
  type SerializableRuntimeSet,
  type SerializableRuntimeValue,
} from "./serializable-values.js";
import { recordValidationTestWork } from "../validation-testing.js";

export const RUNTIME_SNAPSHOT_FORMAT = "teasescript-runtime-snapshot";
export const RUNTIME_SNAPSHOT_VERSION = 20;
export const DEFAULT_MAX_CALL_DEPTH = 256;
export const MAX_SUPPORTED_CALL_DEPTH = 4096;
export const MAX_RUNTIME_SESSION_TIME_MS = Number.MAX_SAFE_INTEGER;
const DEFAULT_CHAT_PACING_SETTINGS = Object.freeze({
  baseDelayMs: 1500,
  delayPerWordMs: 300,
  delayPerCharacterMs: 30,
});
const RUNTIME_SNAPSHOT_KEYS = [
  "format",
  "version",
  "nextInstruction",
  "frames",
  "speakers",
  "defaultSpeaker",
  "contextualSpeaker",
  "rng",
  "warnedSpeakerIds",
  "loopFrames",
  "temporaries",
  "callFrames",
  "nextEventSequence",
  "nextScopeId",
  "nextSpeakerId",
  "nextCallFrameId",
  "currentSessionTimeMs",
  "chatPacingSettings",
  "foregroundAction",
  "backgroundActions",
  "nextActionId",
  "lastSettlement",
  "interactionResultHandoff",
  "terminalContinuationHandoff",
  "preparedSayOutput",
  "maxCallDepth",
  "status",
  "failure",
] as const;

export type RuntimeStatus = "ready" | "running" | "waiting" | "halted" | "failed";

export interface RuntimeBindingSnapshot {
  readonly name: string;
  value: SerializableRuntimeValue;
}

export interface RuntimeScopeFrameSnapshot {
  readonly id: number;
  readonly bindings: RuntimeBindingSnapshot[];
}

export interface RuntimeSpeakerSnapshot {
  readonly id: number;
  readonly identifier: string;
  readonly properties: SerializableRuntimeProperty[];
}

export interface RuntimeFailureSnapshot {
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan;
}

interface RuntimeLoopFrameBase {
  readonly loopId: number;
  readonly scopeDepth: number;
  readonly callFrameId: number | null;
}

export interface RuntimeRepeatLoopFrameSnapshot extends RuntimeLoopFrameBase {
  readonly kind: "repeat";
  remaining: number;
}

export interface RuntimeForLoopFrameSnapshot extends RuntimeLoopFrameBase {
  readonly kind: "for";
  readonly variable: string;
  readonly source: SerializableRuntimeList | SerializableRuntimeSet | SerializableRuntimeRange;
  position: number;
}

export interface RuntimeWhileLoopFrameSnapshot extends RuntimeLoopFrameBase {
  readonly kind: "while";
}

export type RuntimeLoopFrameSnapshot =
  RuntimeRepeatLoopFrameSnapshot | RuntimeForLoopFrameSnapshot | RuntimeWhileLoopFrameSnapshot;

export interface RuntimeTemporarySnapshot {
  readonly id: number;
  value: SerializableRuntimeValue;
}

export type RuntimeCallArgumentSnapshot =
  | { readonly parameterName: string; readonly supplied: false }
  | {
      readonly parameterName: string;
      readonly supplied: true;
      readonly value: SerializableRuntimeValue;
    };

export interface RuntimeParameterStateSnapshot {
  phase: "supplied" | "defaults" | "body";
  parameterIndex: number;
}

export interface RuntimeCallFrameSnapshot {
  readonly id: number;
  readonly functionId: number;
  readonly functionName: string;
  readonly callSiteSpan: SourceSpan;
  readonly returnInstruction: number;
  readonly destinationTemporary: number;
  readonly callerTemporaries: RuntimeTemporarySnapshot[];
  readonly scopeBaseDepth: number;
  readonly loopBaseDepth: number;
  readonly arguments: RuntimeCallArgumentSnapshot[];
  parameterState: RuntimeParameterStateSnapshot;
}

export interface RuntimeInteractionResultHandoffSnapshot {
  readonly actionId: number;
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly destinationTemporary: number;
  readonly result: string | number;
}

/**
 * Single-use authority for a settled terminal foreground action. Unlike
 * `lastSettlement`, this remains meaningful when later background work
 * settles before the next normal runtime entry completes the root.
 */
export interface RuntimeTerminalContinuationHandoffSnapshot {
  readonly actionId: number;
  readonly actionKind: "delay" | "interaction";
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
}

export interface ChatPacingSettings {
  readonly baseDelayMs: number;
  readonly delayPerWordMs: number;
  readonly delayPerCharacterMs: number;
}

export interface RuntimeSnapshot {
  readonly format: typeof RUNTIME_SNAPSHOT_FORMAT;
  readonly version: typeof RUNTIME_SNAPSHOT_VERSION;
  nextInstruction: number;
  readonly frames: RuntimeScopeFrameSnapshot[];
  readonly speakers: RuntimeSpeakerSnapshot[];
  defaultSpeaker: number | null;
  contextualSpeaker: number | null;
  readonly rng: XorShift32State;
  readonly warnedSpeakerIds: number[];
  readonly loopFrames: RuntimeLoopFrameSnapshot[];
  readonly temporaries: RuntimeTemporarySnapshot[];
  readonly callFrames: RuntimeCallFrameSnapshot[];
  nextEventSequence: number;
  nextScopeId: number;
  nextSpeakerId: number;
  nextCallFrameId: number;
  currentSessionTimeMs: number;
  readonly chatPacingSettings: ChatPacingSettings;
  foregroundAction: RuntimePendingActionSnapshot | null;
  readonly backgroundActions: RuntimePendingActionSnapshot[];
  nextActionId: number;
  lastSettlement: RuntimeActionSettlementSnapshot | null;
  interactionResultHandoff: RuntimeInteractionResultHandoffSnapshot | null;
  terminalContinuationHandoff: RuntimeTerminalContinuationHandoffSnapshot | null;
  preparedSayOutput: RuntimePreparedSayOutputSnapshot | null;
  readonly maxCallDepth: number;
  status: RuntimeStatus;
  failure: RuntimeFailureSnapshot | null;
}

export interface FreshRuntimeOptions {
  readonly seed?: number;
  readonly globals?: Readonly<Record<string, SerializableRuntimeValue>>;
  readonly maxCallDepth?: number;
  readonly initialSessionTimeMs?: number;
  readonly baseDelayMs?: number;
  readonly delayPerWordMs?: number;
  readonly delayPerCharacterMs?: number;
}

export interface SnapshotValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function createFreshRuntimeSnapshot(
  plan: InstructionPlan,
  options: FreshRuntimeOptions = {},
): RuntimeSnapshot {
  const capturedPlan = captureOrReuseInstructionPlan(plan);
  if (!capturedPlan.validation.valid || capturedPlan.plan === null) {
    throw new TypeError(
      capturedPlan.validation.errors[0]?.message ?? "Malformed instruction plan.",
    );
  }
  return createFreshRuntimeSnapshotWithValidatedPlan(capturedPlan.plan, options);
}

/** Creates fresh state for an engine-owned plan that was already fully validated. */
export function createFreshRuntimeSnapshotWithValidatedPlan(
  plan: InstructionPlan,
  options: FreshRuntimeOptions = {},
): RuntimeSnapshot {
  const optionsCapture = captureExternalData(options);
  if (!optionsCapture.ok) {
    throw new TypeError(
      runtimeInputDataFailureMessage(optionsCapture.failure.kind, optionsCapture.failure.path),
    );
  }
  if (!isPlainRecord(optionsCapture.value)) {
    throw new TypeError("Fresh runtime options must be an object.");
  }
  const capturedOptions = optionsCapture.value;
  const globals = capturedOptions.globals ?? {};
  if (!isPlainRecord(globals)) {
    throw new TypeError("Fresh runtime globals must be an object.");
  }
  const bindings: RuntimeBindingSnapshot[] = [];
  const maxCallDepthValue = capturedOptions.maxCallDepth;
  const initialSessionTimeMs = capturedOptions.initialSessionTimeMs ?? 0;
  const chatPacingSettings = captureChatPacingSettings(capturedOptions);
  if (!validSessionTime(initialSessionTimeMs)) {
    throw new RangeError(
      `initialSessionTimeMs must be a finite number from 0 through ${MAX_RUNTIME_SESSION_TIME_MS}.`,
    );
  }
  const maxCallDepth = maxCallDepthValue === undefined ? DEFAULT_MAX_CALL_DEPTH : maxCallDepthValue;
  if (
    typeof maxCallDepth !== "number" ||
    !Number.isInteger(maxCallDepth) ||
    maxCallDepth < 1 ||
    maxCallDepth > MAX_SUPPORTED_CALL_DEPTH
  ) {
    throw new RangeError(
      `maxCallDepth must be an integer from 1 through ${MAX_SUPPORTED_CALL_DEPTH}.`,
    );
  }
  for (const [name, value] of Object.entries(globals)) {
    if (name.length === 0) throw new TypeError("Global binding names must not be empty.");
    const failure = validateCapturedSerializableValue(value, `globals.${name}`);
    if (failure !== null) throw new TypeError(failure);
    bindings.push({
      name,
      // EVIDENCE: validation: validateCapturedSerializableValue accepted this captured global value above.
      value: value as SerializableRuntimeValue,
    });
  }
  return {
    format: RUNTIME_SNAPSHOT_FORMAT,
    version: RUNTIME_SNAPSHOT_VERSION,
    nextInstruction: 0,
    frames: [{ id: 0, bindings }],
    speakers: [],
    defaultSpeaker: null,
    contextualSpeaker: null,
    rng: createXorShift32State(
      typeof capturedOptions.seed === "number"
        ? capturedOptions.seed
        : capturedOptions.seed === undefined
          ? DEFAULT_PLAYGROUND_SEED
          : Number.NaN,
    ),
    warnedSpeakerIds: [],
    loopFrames: [],
    temporaries: [],
    callFrames: [],
    nextEventSequence: 1,
    nextScopeId: 1,
    nextSpeakerId: 1,
    nextCallFrameId: 1,
    currentSessionTimeMs: initialSessionTimeMs,
    chatPacingSettings,
    foregroundAction: null,
    backgroundActions: [],
    nextActionId: 1,
    lastSettlement: null,
    interactionResultHandoff: null,
    terminalContinuationHandoff: null,
    preparedSayOutput: null,
    maxCallDepth,
    status: plan.rootEndInstruction === 0 ? "halted" : "ready",
    failure: null,
  };
}

export function cloneRuntimeSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  const captured = captureRuntimeSnapshot(snapshot);
  if (!captured.validation.valid || captured.snapshot === null) {
    throw new TypeError(captured.validation.errors[0] ?? "Malformed runtime snapshot.");
  }
  return captured.snapshot;
}

/**
 * Clone already-captured and validated runtime state.
 */
export function cloneCapturedRuntimeSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return {
    format: RUNTIME_SNAPSHOT_FORMAT,
    version: RUNTIME_SNAPSHOT_VERSION,
    nextInstruction: snapshot.nextInstruction,
    frames: snapshot.frames.map((frame) => ({
      id: frame.id,
      bindings: frame.bindings.map((binding) => ({
        name: binding.name,
        value: cloneCapturedSerializableValue(binding.value),
      })),
    })),
    speakers: snapshot.speakers.map((speaker) => ({
      id: speaker.id,
      identifier: speaker.identifier,
      properties: speaker.properties.map((property) => ({
        name: property.name,
        value: cloneCapturedSerializableValue(property.value),
      })),
    })),
    defaultSpeaker: snapshot.defaultSpeaker,
    contextualSpeaker: snapshot.contextualSpeaker,
    rng: { algorithm: XORSHIFT32_ALGORITHM, state: snapshot.rng.state },
    warnedSpeakerIds: [...snapshot.warnedSpeakerIds],
    loopFrames: snapshot.loopFrames.map((frame) => {
      if (frame.kind === "repeat") return { ...frame };
      if (frame.kind === "while") return { ...frame };
      return {
        ...frame,
        // EVIDENCE: validation: cloning preserves the validated for-loop source collection kind.
        source: cloneCapturedSerializableValue(
          frame.source,
        ) as RuntimeForLoopFrameSnapshot["source"],
      };
    }),
    temporaries: snapshot.temporaries.map(cloneTemporary),
    callFrames: snapshot.callFrames.map((frame) => ({
      id: frame.id,
      functionId: frame.functionId,
      functionName: frame.functionName,
      callSiteSpan: copySpan(frame.callSiteSpan),
      returnInstruction: frame.returnInstruction,
      destinationTemporary: frame.destinationTemporary,
      callerTemporaries: frame.callerTemporaries.map(cloneTemporary),
      scopeBaseDepth: frame.scopeBaseDepth,
      loopBaseDepth: frame.loopBaseDepth,
      arguments: frame.arguments.map((argument) =>
        argument.supplied
          ? {
              parameterName: argument.parameterName,
              supplied: true,
              value: cloneCapturedSerializableValue(argument.value),
            }
          : { parameterName: argument.parameterName, supplied: false },
      ),
      parameterState: { ...frame.parameterState },
    })),
    nextEventSequence: snapshot.nextEventSequence,
    nextScopeId: snapshot.nextScopeId,
    nextSpeakerId: snapshot.nextSpeakerId,
    nextCallFrameId: snapshot.nextCallFrameId,
    currentSessionTimeMs: snapshot.currentSessionTimeMs,
    chatPacingSettings: cloneChatPacingSettings(snapshot.chatPacingSettings),
    foregroundAction:
      snapshot.foregroundAction === null ? null : clonePendingAction(snapshot.foregroundAction),
    backgroundActions: snapshot.backgroundActions.map(clonePendingAction),
    nextActionId: snapshot.nextActionId,
    lastSettlement:
      snapshot.lastSettlement === null ? null : cloneSettlement(snapshot.lastSettlement),
    interactionResultHandoff:
      snapshot.interactionResultHandoff === null
        ? null
        : cloneInteractionResultHandoff(snapshot.interactionResultHandoff),
    terminalContinuationHandoff:
      snapshot.terminalContinuationHandoff === null
        ? null
        : cloneTerminalContinuationHandoff(snapshot.terminalContinuationHandoff),
    preparedSayOutput:
      snapshot.preparedSayOutput === null
        ? null
        : clonePreparedSayOutput(snapshot.preparedSayOutput),
    maxCallDepth: snapshot.maxCallDepth,
    status: snapshot.status,
    failure:
      snapshot.failure === null
        ? null
        : {
            code: snapshot.failure.code,
            message: snapshot.failure.message,
            span: copySpan(snapshot.failure.span),
          },
  };
}

function cloneInteractionResultHandoff(
  handoff: RuntimeInteractionResultHandoffSnapshot,
): RuntimeInteractionResultHandoffSnapshot {
  return {
    actionId: handoff.actionId,
    owningInstruction: handoff.owningInstruction,
    continuationInstruction: handoff.continuationInstruction,
    ownerCallFrameId: handoff.ownerCallFrameId,
    destinationTemporary: handoff.destinationTemporary,
    result: handoff.result,
  };
}

function cloneTerminalContinuationHandoff(
  handoff: RuntimeTerminalContinuationHandoffSnapshot,
): RuntimeTerminalContinuationHandoffSnapshot {
  return {
    actionId: handoff.actionId,
    actionKind: handoff.actionKind,
    owningInstruction: handoff.owningInstruction,
    continuationInstruction: handoff.continuationInstruction,
  };
}

function clonePreparedSayOutput(
  output: RuntimePreparedSayOutputSnapshot,
): RuntimePreparedSayOutputSnapshot {
  return {
    owningInstruction: output.owningInstruction,
    continuationInstruction: output.continuationInstruction,
    speaker: output.speaker === null ? null : { ...output.speaker },
    content: cloneMessageMarkup(output.content),
    text: output.text,
    durationMs: output.durationMs,
    skippable: output.skippable,
  };
}

function clonePendingAction(action: RuntimePendingActionSnapshot): RuntimePendingActionSnapshot {
  if (action.kind === "delay")
    return {
      kind: "delay",
      actionId: action.actionId,
      owningInstruction: action.owningInstruction,
      continuationInstruction: action.continuationInstruction,
      ownerCallFrameId: action.ownerCallFrameId,
      scopeDepth: action.scopeDepth,
      loopDepth: action.loopDepth,
      createdAtMs: action.createdAtMs,
      deadlineMs: action.deadlineMs,
      expectedCompletion: "time",
      requestEventSequence: action.requestEventSequence,
    };
  if (action.kind === "chatPacingGate")
    return {
      kind: "chatPacingGate",
      actionId: action.actionId,
      owningInstruction: action.owningInstruction,
      continuationInstruction: action.continuationInstruction,
      ownerCallFrameId: action.ownerCallFrameId,
      scopeDepth: action.scopeDepth,
      loopDepth: action.loopDepth,
      createdAtMs: action.createdAtMs,
      deadlineMs: action.deadlineMs,
      skippable: action.skippable,
      requestEventSequence: action.requestEventSequence,
      preparedOutput:
        action.preparedOutput === null ? null : clonePreparedSayOutput(action.preparedOutput),
    };
  return {
    kind: "interaction",
    interactionKind: action.interactionKind,
    actionId: action.actionId,
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    ownerCallFrameId: action.ownerCallFrameId,
    scopeDepth: action.scopeDepth,
    loopDepth: action.loopDepth,
    destinationTemporary: action.destinationTemporary,
    expectedResult: action.expectedResult,
    target: action.target,
    speakerId: action.speakerId,
    ui: cloneInteractionUi(action.ui),
    requestEventSequence: action.requestEventSequence,
  };
}

function cloneInteractionUi(ui: InteractionUiPayload): InteractionUiPayload {
  const accessibleName =
    ui.accessibleName.kind === "text"
      ? { kind: "text" as const, text: ui.accessibleName.text }
      : { kind: "localizedDefault" as const, key: ui.accessibleName.key };
  if (ui.kind === "choice")
    return {
      kind: "choice",
      labelType: ui.labelType,
      options: ui.options.map((option) => ({ text: option.text, label: option.label })),
      accessibleName,
    };
  if (ui.kind === "button") return { kind: "button", buttonLabel: ui.buttonLabel, accessibleName };
  return { kind: ui.kind, hint: ui.hint, accessibleName };
}

function cloneSettlement(
  settlement: RuntimeActionSettlementSnapshot,
): RuntimeActionSettlementSnapshot {
  if (settlement.actionKind === "delay")
    return {
      actionId: settlement.actionId,
      actionKind: "delay",
      settlementKind: "completed",
      owningInstruction: settlement.owningInstruction,
      continuationInstruction: settlement.continuationInstruction,
      requestEventSequence: settlement.requestEventSequence,
      completionEventSequence: settlement.completionEventSequence,
      deadlineMs: settlement.deadlineMs,
      completedAtMs: settlement.completedAtMs,
    };
  if (settlement.actionKind === "chatPacingGate") return { ...settlement };
  return {
    actionId: settlement.actionId,
    actionKind: "interaction",
    interactionKind: settlement.interactionKind,
    settlementKind: "completed",
    owningInstruction: settlement.owningInstruction,
    continuationInstruction: settlement.continuationInstruction,
    ownerCallFrameId: settlement.ownerCallFrameId,
    destinationTemporary: settlement.destinationTemporary,
    requestEventSequence: settlement.requestEventSequence,
    transcriptEventSequence: settlement.transcriptEventSequence,
    completionEventSequence: settlement.completionEventSequence,
    result: settlement.result,
    transcriptText: settlement.transcriptText,
  };
}

export interface CapturedRuntimeSnapshotResult {
  readonly validation: SnapshotValidationResult;
  readonly snapshot: RuntimeSnapshot | null;
  readonly failureKind: RuntimeSnapshotValidationFailureKind | null;
}

export type RuntimeSnapshotValidationFailureKind =
  ExternalDataFailureKind | "unsupported" | "malformed";

export interface ClassifiedSnapshotValidationResult {
  readonly validation: SnapshotValidationResult;
  readonly failureKind: RuntimeSnapshotValidationFailureKind | null;
}

function captureRuntimeSnapshot(
  value: unknown,
  plan?: InstructionPlan,
): CapturedRuntimeSnapshotResult {
  if (plan === undefined) return captureRuntimeSnapshotWithValidatedPlan(value);
  const capturedPlan = captureOrReuseInstructionPlan(plan);
  if (!capturedPlan.validation.valid || capturedPlan.plan === null) {
    return Object.freeze({
      validation: Object.freeze({
        valid: false,
        errors: Object.freeze([
          capturedPlan.validation.errors[0]?.message ?? "Malformed instruction plan.",
        ]),
      }),
      snapshot: null,
      failureKind: "malformed",
    });
  }
  return captureRuntimeSnapshotWithValidatedPlan(value, capturedPlan.plan);
}

/** Captures a caller snapshot against an instruction plan already captured and validated by this operation. */
export function captureRuntimeSnapshotWithValidatedPlan(
  value: unknown,
  plan?: InstructionPlan,
): CapturedRuntimeSnapshotResult {
  recordValidationTestWork("runtimeSnapshotCaptureCalls");
  const snapshotCapture = captureExternalData(value);
  if (!snapshotCapture.ok) {
    return Object.freeze({
      validation: Object.freeze({
        valid: false,
        errors: Object.freeze([snapshotExternalDataFailureMessage(snapshotCapture.failure.kind)]),
      }),
      snapshot: null,
      failureKind: snapshotCapture.failure.kind,
    });
  }

  const classified = classifyCapturedRuntimeSnapshot(snapshotCapture.value, plan);
  return Object.freeze({
    validation: classified.validation,
    // EVIDENCE: validation: the preceding snapshot validation accepts this captured graph before it is returned.
    snapshot: classified.validation.valid ? (snapshotCapture.value as RuntimeSnapshot) : null,
    failureKind: classified.failureKind,
  });
}

export function validateRuntimeSnapshot(
  value: unknown,
  plan?: InstructionPlan,
): SnapshotValidationResult {
  return captureRuntimeSnapshot(value, plan).validation;
}

export function classifyCapturedRuntimeSnapshot(
  value: unknown,
  plan?: InstructionPlan,
): ClassifiedSnapshotValidationResult {
  return validateCapturedRuntimeSnapshotDetails(value, plan);
}

function validateCapturedRuntimeSnapshotDetails(
  value: unknown,
  plan?: InstructionPlan,
): ClassifiedSnapshotValidationResult {
  const errors: string[] = [];
  if (!isPlainRecord(value)) {
    return Object.freeze({
      validation: Object.freeze({
        valid: false,
        errors: Object.freeze(["Runtime snapshot must be an object."]),
      }),
      failureKind: "malformed",
    });
  }
  if (!hasExactKeys(value, RUNTIME_SNAPSHOT_KEYS)) {
    errors.push("Runtime snapshot contains unsupported fields or omits required fields.");
  }
  let failureKind: RuntimeSnapshotValidationFailureKind = "malformed";
  if (value.format !== RUNTIME_SNAPSHOT_FORMAT) {
    if (errors.length === 0) failureKind = "unsupported";
    errors.push("Unsupported runtime-snapshot format.");
  }
  if (value.version !== RUNTIME_SNAPSHOT_VERSION) {
    if (errors.length === 0) failureKind = "unsupported";
    errors.push("Unsupported runtime-snapshot version.");
  }
  if (!validChatPacingSettings(value.chatPacingSettings)) {
    errors.push("Runtime chatPacingSettings is malformed.");
  }
  const analysis = plan === undefined ? undefined : createSnapshotValidationAnalysis(plan);
  const instructionLimit = plan?.instructions.length;
  if (
    !nonNegativeSafeInteger(value.nextInstruction) ||
    (instructionLimit !== undefined && value.nextInstruction > instructionLimit)
  ) {
    errors.push("Runtime nextInstruction is outside the plan.");
  }
  validateFrames(value.frames, errors);
  const speakerIds = validateSpeakers(value.speakers, errors);
  const preparedReferenceTemporaryIds = collectPreparedReferenceTemporaryIds(plan);
  const preparedSayTemporaryOwnership = collectPreparedSayTemporaryOwnership(plan);
  validateTemporaries(value.temporaries, plan, "Runtime temporaries", errors);
  validatePreparedReferenceTemporaries(
    value.temporaries,
    value.frames,
    value.speakers,
    preparedReferenceTemporaryIds,
    "Runtime temporaries",
    errors,
  );
  validatePreparedSayTemporaries(
    value.temporaries,
    value.speakers,
    preparedSayTemporaryOwnership,
    "Runtime temporaries",
    errors,
  );
  const callFrameIds = validateCallFrames(
    value.callFrames,
    value.frames,
    value.speakers,
    value.loopFrames,
    value.nextInstruction,
    value.maxCallDepth,
    plan,
    analysis,
    preparedReferenceTemporaryIds,
    preparedSayTemporaryOwnership,
    errors,
  );
  validateSpeakerReferences(
    value.frames,
    value.speakers,
    value.loopFrames,
    value.temporaries,
    value.callFrames,
    speakerIds,
    errors,
  );
  if (value.defaultSpeaker !== null && !nonNegativeSafeInteger(value.defaultSpeaker)) {
    errors.push("Runtime defaultSpeaker must be a speaker ID or null.");
  } else if (typeof value.defaultSpeaker === "number" && !speakerIds.has(value.defaultSpeaker)) {
    errors.push("Runtime defaultSpeaker refers to an unknown speaker.");
  }
  if (value.contextualSpeaker !== null && !nonNegativeSafeInteger(value.contextualSpeaker)) {
    errors.push("Runtime contextualSpeaker must be a speaker ID or null.");
  } else if (
    typeof value.contextualSpeaker === "number" &&
    !speakerIds.has(value.contextualSpeaker)
  ) {
    errors.push("Runtime contextualSpeaker refers to an unknown speaker.");
  }
  if (
    !isPlainRecord(value.rng) ||
    value.rng.algorithm !== XORSHIFT32_ALGORITHM ||
    value.rng.state === 0 ||
    !unsigned32(value.rng.state)
  ) {
    errors.push("Runtime RNG state is malformed or unsupported.");
  }
  if (
    !Array.isArray(value.warnedSpeakerIds) ||
    value.warnedSpeakerIds.some((item) => !nonNegativeSafeInteger(item)) ||
    new Set(value.warnedSpeakerIds).size !== value.warnedSpeakerIds.length ||
    value.warnedSpeakerIds.some((item) => !speakerIds.has(item))
  ) {
    errors.push("Runtime warning-deduplication state is malformed.");
  }
  validateLoopFrames(
    value.loopFrames,
    value.frames,
    value.nextInstruction,
    value.callFrames,
    callFrameIds,
    plan,
    analysis,
    errors,
  );
  validateCurrentTemporaryRequirements(
    value.temporaries,
    value.loopFrames,
    value.nextInstruction,
    value.status,
    plan,
    errors,
  );
  if (!nonNegativeSafeInteger(value.nextEventSequence) || value.nextEventSequence < 1) {
    errors.push("Runtime nextEventSequence must be a positive safe integer.");
  }
  const frameIds = Array.isArray(value.frames)
    ? value.frames
        .filter(isPlainRecord)
        .map((frame) => frame.id)
        .filter(nonNegativeSafeInteger)
    : [];
  if (
    !nonNegativeSafeInteger(value.nextScopeId) ||
    value.nextScopeId < 1 ||
    frameIds.some((id) => {
      // EVIDENCE: validation: nextScopeId passed the integer/range guard before this callback.
      return id >= (value.nextScopeId as number);
    })
  ) {
    errors.push("Runtime nextScopeId must be a positive unused safe integer ID.");
  }
  if (
    !nonNegativeSafeInteger(value.nextSpeakerId) ||
    value.nextSpeakerId < 1 ||
    [...speakerIds].some((id) => {
      // EVIDENCE: validation: nextSpeakerId passed the integer/range guard before this callback.
      return id >= (value.nextSpeakerId as number);
    })
  ) {
    errors.push("Runtime nextSpeakerId must be a positive unused safe integer ID.");
  }
  if (
    !nonNegativeSafeInteger(value.nextCallFrameId) ||
    value.nextCallFrameId < 1 ||
    [...callFrameIds].some((id) => {
      // EVIDENCE: validation: nextCallFrameId passed the integer/range guard before this callback.
      return id >= (value.nextCallFrameId as number);
    })
  ) {
    errors.push("Runtime nextCallFrameId must be a positive unused safe integer ID.");
  }
  if (
    !nonNegativeSafeInteger(value.maxCallDepth) ||
    value.maxCallDepth < 1 ||
    value.maxCallDepth > MAX_SUPPORTED_CALL_DEPTH
  ) {
    errors.push("Runtime maxCallDepth is outside the supported range.");
  }
  validatePendingActionState(value, plan, analysis, errors);
  validateInteractionResultHandoffState(value, plan, analysis, errors);
  validateTerminalContinuationHandoffState(value, plan, errors);
  if (!["ready", "running", "waiting", "halted", "failed"].includes(String(value.status))) {
    errors.push("Runtime status is invalid.");
  }
  validateFailure(value.failure, value.status, errors);
  validateStatusConsistency(value, plan, errors);
  validateRootEndTransition(value, plan, errors);
  const validation = Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
  return Object.freeze({ validation, failureKind: validation.valid ? null : failureKind });
}

function validateLoopFrames(
  value: unknown,
  frames: unknown,
  nextInstruction: unknown,
  callFrames: unknown,
  callFrameIds: ReadonlySet<number>,
  plan: InstructionPlan | undefined,
  analysis: SnapshotValidationAnalysis | undefined,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push("Runtime loopFrames must be an array.");
    return;
  }
  const frameCount = Array.isArray(frames) ? frames.length : 0;
  const loopIds = new Set<number>();
  let previousDepth = 0;
  const plannedLoops = new Map<
    number,
    {
      kind: "repeat" | "for" | "while";
      variable?: string;
      start: number;
      continueStart: number;
      target: number;
      functionId: number | null;
    }
  >();
  const callFramesById = new Map<number, Record<string, unknown>>();
  if (Array.isArray(callFrames)) {
    for (const frame of callFrames) {
      if (isPlainRecord(frame) && nonNegativeSafeInteger(frame.id)) {
        callFramesById.set(frame.id, frame);
      }
    }
  }
  plan?.instructions.forEach((instruction, index) => {
    if (instruction.kind === "loopStart") {
      plannedLoops.set(instruction.loopId, {
        kind: instruction.loopKind,
        ...(instruction.loopKind === "for" ? { variable: instruction.variable } : {}),
        start: index,
        continueStart: instruction.continueTarget,
        target: instruction.target,
        functionId: analysis?.functionIdsByInstruction[index] ?? null,
      });
    }
  });
  for (const frame of value) {
    if (
      !isPlainRecord(frame) ||
      !nonNegativeSafeInteger(frame.loopId) ||
      frame.loopId < 1 ||
      !nonNegativeSafeInteger(frame.scopeDepth) ||
      frame.scopeDepth < 1 ||
      frame.scopeDepth > frameCount
    ) {
      errors.push("Runtime loop frame is malformed.");
      continue;
    }
    if (
      frame.callFrameId !== null &&
      (!nonNegativeSafeInteger(frame.callFrameId) || !callFrameIds.has(frame.callFrameId))
    ) {
      errors.push("Runtime loop frame has an unknown call-frame owner.");
    }
    if (loopIds.has(frame.loopId)) errors.push("Runtime loop IDs must be unique.");
    loopIds.add(frame.loopId);
    if (frame.scopeDepth < previousDepth) {
      errors.push("Runtime loop frame scope depths are out of order.");
    }
    previousDepth = frame.scopeDepth;
    const planned = plannedLoops.get(frame.loopId);
    const owner = nonNegativeSafeInteger(frame.callFrameId)
      ? callFramesById.get(frame.callFrameId)
      : undefined;
    const currentOwner =
      Array.isArray(callFrames) && callFrames.length > 0
        ? isPlainRecord(callFrames.at(-1))
          ? callFrames.at(-1)!.id
          : undefined
        : null;
    if (
      plan !== undefined &&
      (planned === undefined ||
        planned.kind !== frame.kind ||
        (planned.kind === "for" && planned.variable !== frame.variable) ||
        (planned.functionId === null
          ? frame.callFrameId !== null
          : !isPlainRecord(owner) || owner.functionId !== planned.functionId) ||
        (frame.callFrameId === currentOwner &&
          (!nonNegativeSafeInteger(nextInstruction) ||
            nextInstruction < planned.continueStart ||
            nextInstruction >= planned.target)))
    ) {
      errors.push("Runtime loop frame does not match the instruction plan.");
    }
    if (frame.kind === "repeat") {
      if (!nonNegativeSafeInteger(frame.remaining)) {
        errors.push("Runtime repeat-loop state is malformed.");
      }
    } else if (frame.kind === "while") {
      // While loops need no additional hidden state.
    } else if (frame.kind === "for") {
      const failure = validateCapturedSerializableValue(frame.source, "loop.source");
      if (
        typeof frame.variable !== "string" ||
        frame.variable.length === 0 ||
        failure !== null ||
        !isPlainRecord(frame.source) ||
        !["list", "set", "range"].includes(String(frame.source.kind)) ||
        !nonNegativeSafeInteger(frame.position) ||
        frame.position > iterationLength(frame.source)
      ) {
        errors.push("Runtime for-loop iterator state is malformed.");
      }
    } else {
      errors.push("Runtime loop kind is unsupported.");
    }
  }
}

function iterationLength(source: Record<string, unknown>): number {
  if ((source.kind === "list" || source.kind === "set") && Array.isArray(source.items)) {
    return source.items.length;
  }
  if (
    source.kind === "range" &&
    Number.isSafeInteger(source.start) &&
    Number.isSafeInteger(source.end) &&
    typeof source.inclusive === "boolean"
  ) {
    // EVIDENCE: validation: both range endpoints passed Number.isSafeInteger above.
    const size = (source.end as number) - (source.start as number) + (source.inclusive ? 1 : 0);
    return Number.isSafeInteger(size) ? Math.max(0, size) : -1;
  }
  return -1;
}

function validateTemporaries(
  value: unknown,
  plan: InstructionPlan | undefined,
  label: string,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return;
  }
  const ids = new Set<number>();
  for (const temporary of value) {
    if (
      !isPlainRecord(temporary) ||
      !nonNegativeSafeInteger(temporary.id) ||
      temporary.id < 1 ||
      (plan !== undefined && temporary.id > plan.temporaryCount)
    ) {
      errors.push(`${label} contain an invalid temporary ID.`);
      continue;
    }
    if (ids.has(temporary.id)) errors.push(`${label} contain duplicate temporary IDs.`);
    ids.add(temporary.id);
    const failure = validateCapturedSerializableValue(temporary.value);
    if (failure !== null) errors.push(failure);
  }
}

type PreparedReferencePathStep =
  | { readonly kind: "property"; readonly name: string }
  | { readonly kind: "index"; readonly index: number };

const preparedReferencePropertyNames = Object.freeze([
  "marker",
  "rootFrameId",
  "rootName",
  "path",
  "capturedRoot",
  "detached",
] as const);

function validatePreparedReferenceTemporaries(
  value: unknown,
  frames: unknown,
  speakers: unknown,
  preparedTemporaryIds: ReadonlySet<number>,
  label: string,
  errors: string[],
): void {
  if (preparedTemporaryIds.size === 0 || !Array.isArray(value)) return;

  for (const temporary of value) {
    if (
      !isPlainRecord(temporary) ||
      !nonNegativeSafeInteger(temporary.id) ||
      !preparedTemporaryIds.has(temporary.id)
    ) {
      continue;
    }
    const failure = validatePreparedReferenceDescriptor(temporary.value, frames, speakers);
    if (failure !== null) {
      errors.push(`${label} contain malformed prepared-reference state: ${failure}`);
    }
  }
}

function collectPreparedReferenceTemporaryIds(
  plan: InstructionPlan | undefined,
): ReadonlySet<number> {
  if (plan === undefined) return new Set<number>();
  return new Set(
    plan.instructions
      .filter(
        (instruction): instruction is Extract<Instruction, { kind: "prepareReference" }> =>
          instruction.kind === "prepareReference",
      )
      .map((instruction) => instruction.destinationTemporary),
  );
}

interface PreparedSayTemporaryOwnership {
  readonly outputSpeakerIds: ReadonlySet<number>;
  readonly nullableOutputSpeakerIds: ReadonlySet<number>;
  readonly explicitOutputSpeakerIdentifiers: ReadonlyMap<number, string>;
  readonly textIds: ReadonlySet<number>;
  readonly contextualSpeakerIds: ReadonlySet<number>;
  readonly nullableContextualSpeakerIds: ReadonlySet<number>;
  readonly contextualSpeakerSources: ReadonlyMap<number, number>;
}

function collectPreparedSayTemporaryOwnership(
  plan: InstructionPlan | undefined,
): PreparedSayTemporaryOwnership {
  const outputSpeakerIds = new Set<number>();
  const textIds = new Set<number>();
  const contextualSpeakerIds = new Set<number>();
  const nullableContextualSpeakerIds = new Set<number>();
  const contextualSpeakerSources = new Map<number, number>();
  const explicitOutputSpeakerIdentifiers = new Map<number, string>();
  const nullableSaySpeakerSources = new Set<number>();
  if (plan !== undefined) {
    for (const instruction of plan.instructions) {
      if (instruction.kind === "prepareSaySpeaker") {
        outputSpeakerIds.add(instruction.destinationTemporary);
        if (instruction.speaker === null)
          nullableSaySpeakerSources.add(instruction.destinationTemporary);
        else
          explicitOutputSpeakerIdentifiers.set(
            instruction.destinationTemporary,
            instruction.speaker,
          );
      } else if (instruction.kind === "prepareSayText") {
        textIds.add(instruction.destinationTemporary);
      } else if (instruction.kind === "prepareSayContextualSpeaker") {
        contextualSpeakerIds.add(instruction.destinationTemporary);
        contextualSpeakerSources.set(
          instruction.destinationTemporary,
          instruction.speakerTemporary,
        );
        if (nullableSaySpeakerSources.has(instruction.speakerTemporary)) {
          nullableContextualSpeakerIds.add(instruction.destinationTemporary);
        }
      }
    }
  }
  return {
    outputSpeakerIds,
    nullableOutputSpeakerIds: nullableSaySpeakerSources,
    explicitOutputSpeakerIdentifiers,
    textIds,
    contextualSpeakerIds,
    nullableContextualSpeakerIds,
    contextualSpeakerSources,
  };
}

function validatePreparedSayTemporaries(
  value: unknown,
  speakers: unknown,
  ownership: PreparedSayTemporaryOwnership,
  label: string,
  errors: string[],
): void {
  if (!Array.isArray(value)) return;
  for (const temporary of value) {
    if (
      !isPlainRecord(temporary) ||
      !nonNegativeSafeInteger(temporary.id) ||
      !("value" in temporary)
    )
      continue;
    let valid = true;
    if (ownership.outputSpeakerIds.has(temporary.id)) {
      valid = validPreparedSayTemporarySpeaker(
        temporary.value,
        speakers,
        ownership.nullableOutputSpeakerIds.has(temporary.id),
        ownership.explicitOutputSpeakerIdentifiers.get(temporary.id),
      );
    } else if (ownership.textIds.has(temporary.id)) {
      valid = typeof temporary.value === "string";
    } else if (ownership.contextualSpeakerIds.has(temporary.id)) {
      valid = validPreparedSayContextualSpeaker(
        temporary.value,
        speakers,
        ownership.nullableContextualSpeakerIds.has(temporary.id),
      );
    }
    if (!valid) errors.push(`${label} contain malformed prepared-say state.`);
  }
  for (const [contextualTemporaryId, outputTemporaryId] of ownership.contextualSpeakerSources) {
    const contextual = runtimeTemporaryValueRecord(value, contextualTemporaryId);
    const output = runtimeTemporaryValueRecord(value, outputTemporaryId);
    if (
      contextual !== undefined &&
      output !== undefined &&
      !preparedSaySpeakerValuesMatch(output.value, contextual.value)
    ) {
      errors.push(`${label} contain inconsistent prepared-say speaker state.`);
    }
  }
}

function runtimeTemporaryValueRecord(
  temporaries: readonly unknown[],
  temporaryId: number,
): Record<string, unknown> | undefined {
  return temporaries.find(
    (temporary): temporary is Record<string, unknown> =>
      isPlainRecord(temporary) && temporary.id === temporaryId,
  );
}

function preparedSaySpeakerValuesMatch(output: unknown, contextual: unknown): boolean {
  if (output === null || contextual === null) return output === contextual;
  const outputProperties = serializedObjectPropertyMap(output);
  if (outputProperties === null || !isPlainRecord(contextual)) return false;
  return (
    outputProperties.get("speakerId") === contextual.speakerId &&
    outputProperties.get("identifier") === contextual.identifier
  );
}

function validPreparedSayTemporarySpeaker(
  value: unknown,
  speakers: unknown,
  allowsNull: boolean,
  expectedIdentifier: string | undefined,
): boolean {
  if (value === null) return allowsNull;
  const properties = serializedObjectPropertyMap(value);
  if (
    properties === null ||
    properties.size !== 6 ||
    !["identifier", "displayName", "color", "font", "avatar", "speakerId"].every((name) =>
      properties.has(name),
    )
  )
    return false;
  const identifier = properties.get("identifier");
  const displayName = properties.get("displayName");
  const color = properties.get("color");
  const font = properties.get("font");
  const avatar = properties.get("avatar");
  const speakerId = properties.get("speakerId");
  if (
    typeof identifier !== "string" ||
    typeof displayName !== "string" ||
    (typeof color !== "string" && color !== null) ||
    (typeof font !== "string" && font !== null) ||
    (typeof avatar !== "string" && avatar !== null) ||
    !positiveSafeInteger(speakerId)
  )
    return false;
  return (
    (expectedIdentifier === undefined || identifier === expectedIdentifier) &&
    Array.isArray(speakers) &&
    speakers.some(
      (speaker) =>
        isPlainRecord(speaker) && speaker.id === speakerId && speaker.identifier === identifier,
    )
  );
}

function validPreparedSayContextualSpeaker(
  value: unknown,
  speakers: unknown,
  allowsNull: boolean,
): boolean {
  if (value === null) return allowsNull;
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["kind", "speakerId", "identifier"]) ||
    value.kind !== "speakerReference" ||
    !positiveSafeInteger(value.speakerId) ||
    typeof value.identifier !== "string"
  )
    return false;
  return (
    Array.isArray(speakers) &&
    speakers.some(
      (speaker) =>
        isPlainRecord(speaker) &&
        speaker.id === value.speakerId &&
        speaker.identifier === value.identifier,
    )
  );
}

function validatePreparedReferenceDescriptor(
  value: unknown,
  frames: unknown,
  speakers: unknown,
): string | null {
  const properties = serializedObjectPropertyMap(value);
  if (
    properties === null ||
    properties.size !== preparedReferencePropertyNames.length ||
    preparedReferencePropertyNames.some((name) => !properties.has(name))
  ) {
    return "the descriptor must contain exactly the supported fields.";
  }

  const marker = properties.get("marker");
  const rootFrameId = properties.get("rootFrameId");
  const rootName = properties.get("rootName");
  const pathValue = properties.get("path");
  const capturedRoot = properties.get("capturedRoot");
  const detached = properties.get("detached");
  if (marker !== "preparedReference") {
    return "the descriptor marker is invalid.";
  }
  if (rootFrameId !== null && !nonNegativeSafeInteger(rootFrameId)) {
    return "the root frame ID must be a non-negative integer or null.";
  }
  if (rootName !== null && (typeof rootName !== "string" || rootName.length === 0)) {
    return "the root name must be a non-empty string or null.";
  }
  if ((rootFrameId === null) !== (rootName === null)) {
    return "the root frame ID and root name must both be present or both be null.";
  }
  if (typeof detached !== "boolean") {
    return "the detached flag must be boolean.";
  }
  if (rootFrameId === null && detached !== true) {
    return "a descriptor without a binding root must be detached.";
  }
  if (capturedRoot === undefined) {
    return "the captured root is missing.";
  }

  const path = parsePreparedReferencePath(pathValue);
  if (path === null) return "the descriptor path is malformed.";
  if (!preparedReferencePathResolves(capturedRoot, path, speakers)) {
    return "the captured root does not satisfy the prepared path.";
  }

  if (rootFrameId !== null && rootName !== null) {
    const binding = serializedFrameBinding(frames, rootFrameId, rootName);
    if (!binding.found) {
      return "the binding root does not exist in the serialized scope frames.";
    }
    if (!detached && !preparedReferencePathResolves(binding.value, path, speakers)) {
      return "the attached binding root does not satisfy the prepared path.";
    }
  }

  return null;
}

function serializedObjectPropertyMap(value: unknown): ReadonlyMap<string, unknown> | null {
  if (!isPlainRecord(value) || value.kind !== "object" || !Array.isArray(value.properties)) {
    return null;
  }
  const output = new Map<string, unknown>();
  for (const property of value.properties) {
    if (
      !isPlainRecord(property) ||
      typeof property.name !== "string" ||
      property.name.length === 0 ||
      output.has(property.name)
    ) {
      return null;
    }
    output.set(property.name, property.value);
  }
  return output;
}

function parsePreparedReferencePath(value: unknown): readonly PreparedReferencePathStep[] | null {
  if (!isPlainRecord(value) || value.kind !== "list" || !Array.isArray(value.items)) {
    return null;
  }
  const output: PreparedReferencePathStep[] = [];
  for (const item of value.items) {
    const properties = serializedObjectPropertyMap(item);
    if (properties === null) return null;
    const kind = properties.get("kind");
    if (kind === "property" && properties.size === 2 && properties.has("name")) {
      const name = properties.get("name");
      if (typeof name !== "string" || name.length === 0) return null;
      output.push({ kind, name });
      continue;
    }
    if (kind === "index" && properties.size === 2 && properties.has("index")) {
      const index = properties.get("index");
      if (!nonNegativeSafeInteger(index)) return null;
      output.push({ kind, index });
      continue;
    }
    return null;
  }
  return output;
}

function serializedFrameBinding(
  frames: unknown,
  frameId: number,
  name: string,
): { readonly found: boolean; readonly value: unknown } {
  if (!Array.isArray(frames)) return { found: false, value: null };
  const frame = frames.find((candidate) => isPlainRecord(candidate) && candidate.id === frameId);
  if (!isPlainRecord(frame) || !Array.isArray(frame.bindings)) {
    return { found: false, value: null };
  }
  const binding = frame.bindings.find(
    (candidate) => isPlainRecord(candidate) && candidate.name === name && "value" in candidate,
  );
  return isPlainRecord(binding)
    ? { found: true, value: binding.value }
    : { found: false, value: null };
}

function preparedReferencePathResolves(
  root: unknown,
  path: readonly PreparedReferencePathStep[],
  speakers: unknown,
): boolean {
  let current = root;
  for (const step of path) {
    if (step.kind === "index") {
      if (
        !isPlainRecord(current) ||
        !["list", "set"].includes(String(current.kind)) ||
        !Array.isArray(current.items) ||
        step.index >= current.items.length
      ) {
        return false;
      }
      current = current.items[step.index];
      continue;
    }

    if (isPlainRecord(current) && current.kind === "object") {
      const properties = serializedObjectPropertyMap(current);
      if (properties === null || !properties.has(step.name)) return false;
      current = properties.get(step.name);
      continue;
    }
    if (
      isPlainRecord(current) &&
      ["list", "set"].includes(String(current.kind)) &&
      Array.isArray(current.items)
    ) {
      if (step.name !== "length") return false;
      current = current.items.length;
      continue;
    }
    if (
      isPlainRecord(current) &&
      current.kind === "speakerReference" &&
      nonNegativeSafeInteger(current.speakerId)
    ) {
      const property = serializedSpeakerProperty(speakers, current.speakerId, step.name);
      if (!property.found) return false;
      current = property.value;
      continue;
    }
    return false;
  }
  return true;
}

function serializedSpeakerProperty(
  speakers: unknown,
  speakerId: number,
  name: string,
): { readonly found: boolean; readonly value: unknown } {
  if (!Array.isArray(speakers)) return { found: false, value: null };
  const speaker = speakers.find(
    (candidate) => isPlainRecord(candidate) && candidate.id === speakerId,
  );
  if (!isPlainRecord(speaker) || !Array.isArray(speaker.properties)) {
    return { found: false, value: null };
  }
  const names =
    name === "title"
      ? ["title", "shortTitle"]
      : name === "shortTitle"
        ? ["shortTitle", "title"]
        : [name];
  for (const candidateName of names) {
    const property = speaker.properties.find(
      (candidate) =>
        isPlainRecord(candidate) && candidate.name === candidateName && "value" in candidate,
    );
    if (isPlainRecord(property)) {
      return { found: true, value: property.value };
    }
  }
  return { found: false, value: null };
}

function validateCallFrames(
  value: unknown,
  frames: unknown,
  speakers: unknown,
  loopFrames: unknown,
  nextInstruction: unknown,
  maxCallDepth: unknown,
  plan: InstructionPlan | undefined,
  analysis: SnapshotValidationAnalysis | undefined,
  preparedReferenceTemporaryIds: ReadonlySet<number>,
  preparedSayTemporaryOwnership: PreparedSayTemporaryOwnership,
  errors: string[],
): Set<number> {
  const ids = new Set<number>();
  if (!Array.isArray(value)) {
    errors.push("Runtime callFrames must be an array.");
    return ids;
  }
  if (nonNegativeSafeInteger(maxCallDepth) && value.length > maxCallDepth) {
    errors.push("Runtime call stack exceeds maxCallDepth.");
  }
  const frameCount = Array.isArray(frames) ? frames.length : 0;
  const loopCount = Array.isArray(loopFrames) ? loopFrames.length : 0;
  let previousId = 0;
  let previousScopeBase = 0;
  let previousLoopBase = 0;
  value.forEach((frame, frameIndex) => {
    if (!isPlainRecord(frame)) {
      errors.push("Runtime call frame is malformed.");
      return;
    }
    if (!nonNegativeSafeInteger(frame.id) || frame.id < 1 || ids.has(frame.id)) {
      errors.push("Runtime call-frame IDs must be unique positive integers.");
    } else {
      if (frame.id <= previousId) errors.push("Runtime call-frame IDs are out of order.");
      previousId = frame.id;
      ids.add(frame.id);
    }
    const definition = nonNegativeSafeInteger(frame.functionId)
      ? analysis?.functionsById.get(frame.functionId)
      : undefined;
    let callInstruction: InstructionPlan["instructions"][number] | undefined;
    if (
      !nonNegativeSafeInteger(frame.functionId) ||
      frame.functionId < 1 ||
      (plan !== undefined && definition === undefined) ||
      typeof frame.functionName !== "string" ||
      frame.functionName.length === 0 ||
      (definition !== undefined && frame.functionName !== definition.name) ||
      !validSpan(frame.callSiteSpan)
    ) {
      errors.push("Runtime call frame refers to a malformed or unknown function.");
    }
    if (
      !nonNegativeSafeInteger(frame.returnInstruction) ||
      frame.returnInstruction < 1 ||
      (plan !== undefined && frame.returnInstruction > plan.instructions.length)
    ) {
      errors.push("Runtime call frame has an invalid return instruction.");
    } else if (plan !== undefined) {
      const call = plan.instructions[frame.returnInstruction - 1];
      if (
        call?.kind !== "callFunction" ||
        call.functionId !== frame.functionId ||
        call.destinationTemporary !== frame.destinationTemporary ||
        call.returnInstruction !== frame.returnInstruction
      ) {
        errors.push("Runtime call frame return target does not match its call instruction.");
      } else {
        callInstruction = call;
      }
    }
    if (
      !nonNegativeSafeInteger(frame.destinationTemporary) ||
      frame.destinationTemporary < 1 ||
      (plan !== undefined && frame.destinationTemporary > plan.temporaryCount)
    ) {
      errors.push("Runtime call frame has an invalid result destination.");
    }
    validateTemporaries(frame.callerTemporaries, plan, "Runtime caller temporaries", errors);
    validatePreparedReferenceTemporaries(
      frame.callerTemporaries,
      frames,
      speakers,
      preparedReferenceTemporaryIds,
      "Runtime caller temporaries",
      errors,
    );
    validatePreparedSayTemporaries(
      frame.callerTemporaries,
      speakers,
      preparedSayTemporaryOwnership,
      "Runtime caller temporaries",
      errors,
    );
    if (
      nonNegativeSafeInteger(frame.destinationTemporary) &&
      Array.isArray(frame.callerTemporaries) &&
      createTemporaryMap(frame.callerTemporaries).has(frame.destinationTemporary)
    ) {
      errors.push("Runtime caller temporaries already contain the result destination.");
    }
    if (
      !nonNegativeSafeInteger(frame.scopeBaseDepth) ||
      frame.scopeBaseDepth < 1 ||
      frame.scopeBaseDepth >= frameCount ||
      frame.scopeBaseDepth <= previousScopeBase
    ) {
      errors.push("Runtime call frame has an impossible scope base.");
    }
    if (nonNegativeSafeInteger(frame.scopeBaseDepth)) previousScopeBase = frame.scopeBaseDepth;
    if (
      !nonNegativeSafeInteger(frame.loopBaseDepth) ||
      frame.loopBaseDepth > loopCount ||
      frame.loopBaseDepth < previousLoopBase
    ) {
      errors.push("Runtime call frame has an impossible loop base.");
    }
    if (nonNegativeSafeInteger(frame.loopBaseDepth)) previousLoopBase = frame.loopBaseDepth;
    validateCallArguments(frame.arguments, definition, errors);
    validateCallArgumentSupply(frame.arguments, callInstruction, errors);
    validateParameterState(frame.parameterState, definition, errors);
    validateParameterBindings(frame, frames, definition, analysis, errors);

    if (
      plan !== undefined &&
      nonNegativeSafeInteger(frame.returnInstruction) &&
      nonNegativeSafeInteger(frame.destinationTemporary) &&
      Array.isArray(frame.callerTemporaries)
    ) {
      validateSuspendedContinuationTemporaries(
        frame.callerTemporaries,
        frame.destinationTemporary,
        frame.returnInstruction,
        Array.isArray(loopFrames) && nonNegativeSafeInteger(frame.loopBaseDepth)
          ? loopFrames.slice(0, frame.loopBaseDepth)
          : [],
        analysis!,
        errors,
      );
    }

    if (plan !== undefined && nonNegativeSafeInteger(frame.returnInstruction)) {
      const callIndex = frame.returnInstruction - 1;
      const caller = frameIndex === 0 ? undefined : value[frameIndex - 1];
      const callerDefinition =
        isPlainRecord(caller) && nonNegativeSafeInteger(caller.functionId)
          ? analysis?.functionsById.get(caller.functionId)
          : undefined;
      if (
        (frameIndex === 0 && callIndex >= plan.rootEndInstruction) ||
        (frameIndex > 0 &&
          (callerDefinition === undefined ||
            callIndex < callerDefinition.entryInstruction ||
            callIndex >= callerDefinition.endInstruction))
      ) {
        errors.push("Runtime call frame return instruction is outside its caller.");
      }
    }

    if (definition !== undefined) {
      const child = frameIndex < value.length - 1 ? value[frameIndex + 1] : undefined;
      if (
        frameIndex === value.length - 1 &&
        (!nonNegativeSafeInteger(nextInstruction) ||
          nextInstruction < definition.entryInstruction ||
          nextInstruction >= definition.endInstruction)
      ) {
        errors.push("Runtime next instruction is outside the active function.");
      } else if (frameIndex === value.length - 1 && nonNegativeSafeInteger(nextInstruction)) {
        validateExactParameterPosition(
          frame.parameterState,
          definition,
          nextInstruction,
          analysis!,
          errors,
        );
      } else if (isPlainRecord(child) && nonNegativeSafeInteger(child.returnInstruction)) {
        validateExactParameterPosition(
          frame.parameterState,
          definition,
          child.returnInstruction - 1,
          analysis!,
          errors,
        );
        validateExactParameterPosition(
          frame.parameterState,
          definition,
          child.returnInstruction,
          analysis!,
          errors,
        );
      }
    }
  });
  return ids;
}

function validateCallArgumentSupply(
  argumentsValue: unknown,
  callInstruction: InstructionPlan["instructions"][number] | undefined,
  errors: string[],
): void {
  if (!Array.isArray(argumentsValue) || callInstruction?.kind !== "callFunction") {
    return;
  }
  const suppliedParameters = new Set(
    callInstruction.arguments.map((argument) => argument.parameterName),
  );
  for (const argument of argumentsValue) {
    if (
      !isPlainRecord(argument) ||
      typeof argument.parameterName !== "string" ||
      typeof argument.supplied !== "boolean"
    )
      continue;
    if (argument.supplied !== suppliedParameters.has(argument.parameterName)) {
      errors.push("Runtime supplied arguments do not match the call instruction.");
    }
  }
}

function createTemporaryMap(
  temporaries: readonly unknown[],
): ReadonlyMap<number, Record<string, unknown>> {
  recordValidationTestWork("temporaryMapBuilds");
  const result = new Map<number, Record<string, unknown>>();
  for (const temporary of temporaries) {
    if (isPlainRecord(temporary) && nonNegativeSafeInteger(temporary.id)) {
      result.set(temporary.id, temporary);
    }
  }
  return result;
}

function validateParameterBindings(
  frame: Record<string, unknown>,
  frames: unknown,
  definition: InstructionPlan["functions"][number] | undefined,
  analysis: SnapshotValidationAnalysis | undefined,
  errors: string[],
): void {
  if (
    definition === undefined ||
    !Array.isArray(frames) ||
    !nonNegativeSafeInteger(frame.scopeBaseDepth) ||
    !Array.isArray(frame.arguments) ||
    !isPlainRecord(frame.parameterState) ||
    !nonNegativeSafeInteger(frame.parameterState.parameterIndex)
  ) {
    return;
  }
  const scope = frames[frame.scopeBaseDepth];
  if (!isPlainRecord(scope) || !Array.isArray(scope.bindings)) return;
  const argumentsList = frame.arguments;
  const parameterState = frame.parameterState;
  const bindingNames = new Set(
    scope.bindings
      .filter(isPlainRecord)
      .map((binding) => binding.name)
      .filter((name): name is string => typeof name === "string"),
  );
  if (
    parameterState.phase !== "body" &&
    [...bindingNames].some((name) => !analysis?.parameterNames.get(definition.id)?.has(name))
  ) {
    errors.push("Runtime function prologue contains a non-parameter binding.");
  }
  definition.parameters.forEach((parameter, index) => {
    const argument = argumentsList[index];
    if (!isPlainRecord(argument) || typeof argument.supplied !== "boolean") return;
    const phase = parameterState.phase;
    // EVIDENCE: validation: parameterIndex passed nonNegativeSafeInteger before iterating parameters.
    const progress = parameterState.parameterIndex as number;
    const shouldBeBound =
      phase === "body" ||
      (phase === "supplied" && argument.supplied && index < progress) ||
      (phase === "defaults" && (argument.supplied || index < progress));
    if (bindingNames.has(parameter.name) !== shouldBeBound) {
      errors.push("Runtime parameter bindings do not match prologue progress.");
    }
  });
}

function validateCallArguments(
  value: unknown,
  definition: InstructionPlan["functions"][number] | undefined,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push("Runtime call-frame arguments must be an array.");
    return;
  }
  if (definition !== undefined && value.length !== definition.parameters.length) {
    errors.push("Runtime call-frame arguments do not match function parameters.");
  }
  value.forEach((argument, index) => {
    const parameter = definition?.parameters[index];
    if (
      !isPlainRecord(argument) ||
      typeof argument.parameterName !== "string" ||
      argument.parameterName.length === 0 ||
      typeof argument.supplied !== "boolean" ||
      (parameter !== undefined && argument.parameterName !== parameter.name)
    ) {
      errors.push("Runtime call-frame argument state is malformed.");
      return;
    }
    if (argument.supplied) {
      if (!("value" in argument)) {
        errors.push("Supplied runtime argument is missing its value.");
      } else {
        const failure = validateCapturedSerializableValue(argument.value);
        if (failure !== null) errors.push(failure);
      }
    } else if ("value" in argument) {
      errors.push("Missing runtime argument must not contain a value.");
    }
  });
}

function validateParameterState(
  value: unknown,
  definition: InstructionPlan["functions"][number] | undefined,
  errors: string[],
): void {
  if (
    !isPlainRecord(value) ||
    !["supplied", "defaults", "body"].includes(String(value.phase)) ||
    !nonNegativeSafeInteger(value.parameterIndex) ||
    (definition !== undefined && value.parameterIndex > definition.parameters.length) ||
    (value.phase === "body" &&
      definition !== undefined &&
      value.parameterIndex !== definition.parameters.length)
  ) {
    errors.push("Runtime parameter-prologue state is malformed.");
  }
}

function validateExactParameterPosition(
  value: unknown,
  definition: InstructionPlan["functions"][number],
  instructionPosition: number,
  analysis: SnapshotValidationAnalysis,
  errors: string[],
): void {
  if (!isPlainRecord(value) || !nonNegativeSafeInteger(value.parameterIndex)) return;
  const expected = expectedParameterProgress(definition, instructionPosition, analysis);
  if (
    expected === null ||
    value.phase !== expected.phase ||
    value.parameterIndex !== expected.parameterIndex
  ) {
    errors.push("Runtime parameter progress does not match its exact instruction position.");
  }
}

function expectedParameterProgress(
  definition: InstructionPlan["functions"][number],
  instructionPosition: number,
  analysis: SnapshotValidationAnalysis,
): RuntimeParameterStateSnapshot | null {
  const parameterCount = definition.parameters.length;
  if (
    instructionPosition >= definition.entryInstruction &&
    instructionPosition < definition.entryInstruction + parameterCount
  ) {
    return { phase: "supplied", parameterIndex: instructionPosition - definition.entryInstruction };
  }
  let cursor = definition.entryInstruction + parameterCount;
  if (instructionPosition === cursor) {
    return { phase: "supplied", parameterIndex: parameterCount };
  }
  cursor += 1;
  for (let parameterIndex = 0; parameterIndex < parameterCount; parameterIndex += 1) {
    const prepare = analysis.plan.instructions[cursor];
    if (prepare?.kind !== "prepareParameterDefault") return null;
    if (instructionPosition === cursor) {
      return { phase: "defaults", parameterIndex };
    }
    const bindIndex =
      analysis.defaultBindingPositions.get(`${definition.id}:${parameterIndex}`) ?? -1;
    if (instructionPosition > cursor && instructionPosition < prepare.target) {
      return {
        phase: "defaults",
        parameterIndex:
          bindIndex >= 0 && instructionPosition > bindIndex ? parameterIndex + 1 : parameterIndex,
      };
    }
    cursor = prepare.target;
  }
  if (instructionPosition === definition.bodyEntryInstruction - 1) {
    return { phase: "defaults", parameterIndex: parameterCount };
  }
  if (
    instructionPosition >= definition.bodyEntryInstruction &&
    instructionPosition < definition.endInstruction
  ) {
    return { phase: "body", parameterIndex: parameterCount };
  }
  return null;
}

interface SnapshotValidationAnalysis {
  readonly plan: InstructionPlan;
  readonly functionsById: ReadonlyMap<number, InstructionPlan["functions"][number]>;
  readonly regionEnds: readonly number[];
  readonly functionIdsByInstruction: readonly (number | null)[];
  readonly continuationLiveness: Map<string, readonly ReadonlySet<number>[]>;
  readonly defaultBindingPositions: ReadonlyMap<string, number>;
  readonly parameterNames: ReadonlyMap<number, ReadonlySet<string>>;
}

function createSnapshotValidationAnalysis(plan: InstructionPlan): SnapshotValidationAnalysis {
  recordValidationTestWork("snapshotAnalysisBuilds");
  const functionsById = new Map<number, InstructionPlan["functions"][number]>();
  const regionEnds = new Array<number>(plan.instructions.length).fill(plan.rootEndInstruction);
  const functionIdsByInstruction = new Array<number | null>(plan.instructions.length).fill(null);
  for (const definition of plan.functions) {
    functionsById.set(definition.id, definition);
    for (let index = definition.entryInstruction; index < definition.endInstruction; index += 1) {
      regionEnds[index] = definition.endInstruction;
      functionIdsByInstruction[index] = definition.id;
    }
  }
  const defaultBindingPositions = new Map<string, number>();
  recordValidationTestWork("defaultBindingIndexBuilds");
  for (let index = 0; index < plan.instructions.length; index += 1) {
    const instruction = plan.instructions[index];
    if (instruction?.kind === "bindDefaultParameter") {
      defaultBindingPositions.set(`${instruction.functionId}:${instruction.parameterIndex}`, index);
    }
  }
  const parameterNames = new Map(
    plan.functions.map((definition) => [
      definition.id,
      new Set(definition.parameters.map((parameter) => parameter.name)),
    ]),
  );
  recordValidationTestWork("parameterNameIndexBuilds");
  return {
    plan,
    functionsById,
    regionEnds,
    functionIdsByInstruction,
    continuationLiveness: new Map(),
    defaultBindingPositions,
    parameterNames,
  };
}

function validateSuspendedContinuationTemporaries(
  callerTemporaries: unknown[],
  destinationTemporary: number,
  returnInstruction: number,
  callerLoopFrames: unknown,
  analysis: SnapshotValidationAnalysis,
  errors: string[],
): void {
  const present = new Set(createTemporaryMap(callerTemporaries).keys());
  present.add(destinationTemporary);
  const required = requiredContinuationTemporaries(analysis, returnInstruction, callerLoopFrames);
  if ([...required].some((temporaryId) => !present.has(temporaryId))) {
    errors.push("Runtime caller temporaries cannot resume the suspended continuation.");
  }
}

function requiredContinuationTemporaries(
  analysis: SnapshotValidationAnalysis,
  startInstruction: number,
  loopFrames: unknown,
): ReadonlySet<number> {
  const activeLoop = Array.isArray(loopFrames) ? loopFrames.at(-1) : undefined;
  const loopSignature =
    isPlainRecord(activeLoop) && nonNegativeSafeInteger(activeLoop.loopId)
      ? `loop:${activeLoop.loopId}`
      : "none";
  let liveIn = analysis.continuationLiveness.get(loopSignature);
  if (liveIn === undefined) {
    recordDetailedValidationWork(analysis.plan.instructions.length);
    recordValidationTestWork("livenessComputations");
    recordValidationTestWork("livenessTableAllocations");
    liveIn = computeContinuationLiveness(analysis, loopFrames);
    analysis.continuationLiveness.set(loopSignature, liveIn);
    recordValidationTestWork("livenessCacheInsertions");
  } else {
    recordValidationTestWork("livenessCacheHits");
  }
  return liveIn[startInstruction] ?? new Set<number>();
}

function computeContinuationLiveness(
  analysis: SnapshotValidationAnalysis,
  loopFrames: unknown,
): readonly ReadonlySet<number>[] {
  const plan = analysis.plan;
  const count = plan.instructions.length;
  const liveIn = Array.from({ length: count }, () => new Set<number>());
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = count - 1; index >= 0; index -= 1) {
      recordDetailedValidationWork();
      const instruction = plan.instructions[index]!;
      const liveOut = new Set<number>();
      for (const successor of instructionSuccessors(analysis, index)) {
        for (const temporaryId of liveIn[successor] ?? []) {
          recordDetailedValidationWork();
          liveOut.add(temporaryId);
        }
      }
      for (const temporaryId of instructionKilledTemporaries(instruction)) {
        liveOut.delete(temporaryId);
      }
      for (const temporaryId of requiredInstructionTemporaries(instruction, loopFrames)) {
        liveOut.add(temporaryId);
      }
      if (!sameNumberSet(liveIn[index]!, liveOut)) {
        liveIn[index] = liveOut;
        changed = true;
      }
    }
  }
  return liveIn;
}

function recordDetailedValidationWork(amount = 1): void {
  recordValidationTestWork("detailedWorkConsumed", amount);
}

function instructionSuccessors(
  analysis: SnapshotValidationAnalysis,
  index: number,
): readonly number[] {
  const { plan } = analysis;
  const instruction = plan.instructions[index];
  if (instruction === undefined) return [];
  const regionEnd = analysis.regionEnds[index] ?? plan.instructions.length;
  const next = index + 1 < regionEnd ? index + 1 : null;
  switch (instruction.kind) {
    case "jump":
    case "loopControl":
      return instruction.target < regionEnd ? [instruction.target] : [];
    case "jumpIfFalse":
    case "loopStart": {
      const successors = [instruction.target];
      if (next !== null) successors.push(next);
      return successors.filter((candidate) => candidate >= 0 && candidate < regionEnd);
    }
    case "returnValue":
    case "returnVoid":
    case "exit":
      return [];
    case "callFunction":
      return instruction.returnInstruction < regionEnd ? [instruction.returnInstruction] : [];
    default:
      return next === null ? [] : [next];
  }
}

function instructionKilledTemporaries(instruction: Instruction): ReadonlySet<number> {
  switch (instruction.kind) {
    case "storeTemporary":
      return new Set([instruction.temporaryId]);
    case "prepareSayText":
    case "prepareSaySpeaker":
    case "prepareSayContextualSpeaker":
      return new Set([instruction.destinationTemporary]);
    case "prepareInteractionSpeaker":
      return new Set([instruction.destinationTemporary]);
    case "prepareReference":
      return new Set([instruction.destinationTemporary]);
    case "clearTemporary":
      return new Set([instruction.temporaryId]);
    case "clearTemporaries":
      return new Set(instruction.temporaryIds);
    case "callFunction":
      return new Set([instruction.destinationTemporary]);
    case "interaction":
      return instruction.destinationTemporary === null
        ? new Set<number>()
        : new Set([instruction.destinationTemporary]);
    default:
      return new Set<number>();
  }
}

function sameNumberSet(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function validateStatusConsistency(
  value: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  const calls = Array.isArray(value.callFrames) ? value.callFrames.length : 0;
  const loops = Array.isArray(value.loopFrames) ? value.loopFrames.length : 0;
  const temporaries = Array.isArray(value.temporaries) ? value.temporaries.length : 0;
  const scopes = Array.isArray(value.frames) ? value.frames.length : 0;
  if (value.contextualSpeaker !== null) {
    errors.push("Runtime contextual speaker must be cleared between instructions.");
  }
  const action = value.foregroundAction;
  if (value.status === "waiting") {
    const hasForegroundAction = isPlainRecord(action);
    const hasAllowedActionKind =
      hasForegroundAction &&
      ["delay", "interaction", "chatPacingGate"].includes(String(action.kind));
    if (!hasAllowedActionKind) {
      errors.push("Waiting runtime state requires one foreground action.");
    }
  } else if (action !== null) {
    errors.push("Non-waiting runtime state must not contain a foreground action.");
  }
  if (
    value.preparedSayOutput !== null &&
    !validPreparedSayOutput(value.preparedSayOutput, value, plan)
  ) {
    errors.push("Runtime prepared say output is malformed.");
  }
  if (!validTopLevelPreparedSayOutputRelationship(value, plan)) {
    errors.push("Runtime prepared say output has impossible pacing-settlement provenance.");
  }
  if (value.status === "ready") {
    if (
      value.nextInstruction !== 0 ||
      calls !== 0 ||
      loops !== 0 ||
      temporaries !== 0 ||
      scopes !== 1 ||
      value.failure !== null
    ) {
      errors.push("Ready runtime state contains execution progress.");
    }
    if (
      value.preparedSayOutput !== null ||
      hasActivePacingGate(value) ||
      hasPacingExecutionHistory(value.lastSettlement)
    ) {
      errors.push("Ready runtime state must not contain pacing execution state.");
    }
  } else if (value.status === "halted") {
    if (calls !== 0 || loops !== 0 || temporaries !== 0 || scopes !== 1 || value.failure !== null) {
      errors.push("Halted runtime state retains active execution state.");
    }
    if (plan !== undefined && !isLegalHaltPosition(value.nextInstruction, plan)) {
      errors.push("Halted runtime state is not at a legal halt position.");
    }
    if (isExplicitExitHaltState(value, plan) && hasActivePacingGate(value)) {
      errors.push("Explicit exit runtime state must not retain active pacing work.");
    }
  } else if (value.status === "running") {
    if (value.failure !== null) errors.push("Running runtime state contains failure information.");
    if (
      plan !== undefined &&
      calls === 0 &&
      (!nonNegativeSafeInteger(value.nextInstruction) ||
        value.nextInstruction > plan.rootEndInstruction)
    ) {
      errors.push("Root execution position is outside the root instruction range.");
    }
  }
}

/**
 * A terminal delay or result-free button may settle at the root-end
 * coordinate while awaiting its ordinary completion entry. The separate
 * handoff remains authoritative even when a background pacing settlement
 * replaces bounded replay data before that entry occurs.
 */
function validateRootEndTransition(
  value: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  if (
    plan === undefined ||
    value.status !== "running" ||
    value.nextInstruction !== plan.rootEndInstruction ||
    !Array.isArray(value.callFrames) ||
    value.callFrames.length !== 0
  )
    return;

  const common =
    Array.isArray(value.frames) &&
    value.frames.length === 1 &&
    isPlainRecord(value.frames[0]) &&
    value.frames[0].id === 0 &&
    Array.isArray(value.callFrames) &&
    value.callFrames.length === 0 &&
    Array.isArray(value.loopFrames) &&
    value.loopFrames.length === 0 &&
    Array.isArray(value.temporaries) &&
    value.temporaries.length === 0 &&
    value.foregroundAction === null &&
    value.failure === null &&
    value.contextualSpeaker === null;
  if (!common || value.terminalContinuationHandoff === null) {
    errors.push(
      "Running root-end state is not a canonical settled terminal foreground transition.",
    );
  }
}

function validSessionTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_RUNTIME_SESSION_TIME_MS
  );
}

function captureChatPacingSettings(options: Record<string, unknown>): ChatPacingSettings {
  return Object.freeze({
    baseDelayMs: capturePacingSetting(
      options.baseDelayMs,
      "baseDelayMs",
      DEFAULT_CHAT_PACING_SETTINGS.baseDelayMs,
    ),
    delayPerWordMs: capturePacingSetting(
      options.delayPerWordMs,
      "delayPerWordMs",
      DEFAULT_CHAT_PACING_SETTINGS.delayPerWordMs,
    ),
    delayPerCharacterMs: capturePacingSetting(
      options.delayPerCharacterMs,
      "delayPerCharacterMs",
      DEFAULT_CHAT_PACING_SETTINGS.delayPerCharacterMs,
    ),
  });
}

function capturePacingSetting(value: unknown, name: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer number of milliseconds.`);
  }
  return value;
}

function cloneChatPacingSettings(settings: ChatPacingSettings): ChatPacingSettings {
  return Object.freeze({
    baseDelayMs: settings.baseDelayMs,
    delayPerWordMs: settings.delayPerWordMs,
    delayPerCharacterMs: settings.delayPerCharacterMs,
  });
}

function validChatPacingSettings(value: unknown): value is ChatPacingSettings {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["baseDelayMs", "delayPerWordMs", "delayPerCharacterMs"]) &&
    validPacingSetting(value.baseDelayMs) &&
    validPacingSetting(value.delayPerWordMs) &&
    validPacingSetting(value.delayPerCharacterMs)
  );
}

function validPacingSetting(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 1;
}

function isLegalHaltPosition(nextInstruction: unknown, plan: InstructionPlan): boolean {
  if (!nonNegativeSafeInteger(nextInstruction)) return false;
  if (nextInstruction === plan.rootEndInstruction) return true;
  return nextInstruction > 0 && plan.instructions[nextInstruction - 1]?.kind === "exit";
}

function validateCurrentTemporaryRequirements(
  temporaries: unknown,
  loopFrames: unknown,
  nextInstruction: unknown,
  status: unknown,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  if (
    plan === undefined ||
    status === "halted" ||
    !Array.isArray(temporaries) ||
    !nonNegativeSafeInteger(nextInstruction)
  ) {
    return;
  }
  const instruction = plan.instructions[nextInstruction];
  if (instruction === undefined) return;
  const required = requiredInstructionTemporaries(instruction, loopFrames);
  const present = new Set(
    temporaries
      .filter(isPlainRecord)
      .map((temporary) => temporary.id)
      .filter((id): id is number => nonNegativeSafeInteger(id)),
  );
  if ([...required].some((id) => !present.has(id))) {
    errors.push("Runtime state is missing a temporary required by the next instruction.");
  }
  if (
    instruction.kind === "interaction" &&
    instruction.destinationTemporary !== null &&
    present.has(instruction.destinationTemporary)
  ) {
    errors.push("Runtime interaction result destination is already occupied.");
  }
  if (instruction.kind === "callFunction" && present.has(instruction.destinationTemporary)) {
    errors.push("Runtime function result destination is already occupied.");
  }
}

function requiredInstructionTemporaries(
  instruction: Instruction,
  loopFrames: unknown,
): ReadonlySet<number> {
  const output = new Set<number>();
  const collect = (expression: ExpressionPlan): void => {
    collectExpressionTemporaries(expression, output);
  };
  switch (instruction.kind) {
    case "declareSpeaker":
      instruction.properties.forEach((property) => collect(property.value));
      break;
    case "setDeclaredSpeakerProperty":
    case "declareBinding":
      collect(instruction.value);
      break;
    case "prepareReference":
      collect(instruction.expression);
      break;
    case "validateAssignmentTarget":
      collect(instruction.target);
      break;
    case "assign":
      collect(instruction.value);
      collect(instruction.target);
      break;
    case "validateCallReceiver":
      collect(instruction.receiver);
      break;
    case "evaluate":
      collect(instruction.expression);
      break;
    case "jumpIfFalse":
      collect(instruction.condition);
      break;
    case "loopStart": {
      const active = Array.isArray(loopFrames) ? loopFrames.at(-1) : undefined;
      if (
        instruction.loopKind === "while" ||
        !isPlainRecord(active) ||
        active.loopId !== instruction.loopId
      ) {
        collect(instruction.expression);
      }
      break;
    }
    case "storeTemporary":
    case "bindDefaultParameter":
    case "prepareSayText":
    case "returnValue":
      collect(instruction.value);
      break;
    case "prepareSayContextualSpeaker":
      output.add(instruction.speakerTemporary);
      break;
    case "callFunction":
      instruction.arguments.forEach((argument) =>
        collectExpressionTemporaries(argument.value, output),
      );
      break;
    case "setDefaultSpeaker":
    case "prepareInteractionSpeaker":
    case "enterScope":
    case "leaveScope":
    case "jump":
    case "loopControl":
    case "clearTemporary":
    case "clearTemporaries":
    case "bindSuppliedParameter":
    case "beginFunctionDefaults":
    case "prepareParameterDefault":
    case "enterFunctionBody":
    case "returnVoid":
    case "exit":
      break;
    case "say":
      if (typeof instruction.textTemporary === "number") output.add(instruction.textTemporary);
      else collect(instruction.value);
      if (typeof instruction.speakerTemporary === "number")
        output.add(instruction.speakerTemporary);
      if (typeof instruction.pacing === "object") collect(instruction.pacing);
      break;
    case "wait":
      collect(instruction.duration);
      break;
    case "interaction":
      if ("preparedUi" in instruction) {
        output.add(instruction.speakerTemporary);
        if (instruction.preparedUi.kind === "button")
          output.add(instruction.preparedUi.buttonLabelTemporary);
        else if (
          instruction.preparedUi.kind === "text" ||
          instruction.preparedUi.kind === "number"
        ) {
          if (instruction.preparedUi.hintTemporary !== null)
            output.add(instruction.preparedUi.hintTemporary);
        } else output.add(instruction.preparedUi.optionsTemporary);
      }
      break;
  }
  return output;
}

function collectExpressionTemporaries(expression: ExpressionPlan, output: Set<number>): void {
  switch (expression.kind) {
    case "temporary":
    case "preparedReference":
      output.add(expression.temporaryId);
      return;
    case "literal":
    case "identifier":
      return;
    case "list":
    case "set":
      expression.elements.forEach((item) => collectExpressionTemporaries(item, output));
      return;
    case "object":
      expression.properties.forEach((property) =>
        collectExpressionTemporaries(property.value, output),
      );
      return;
    case "group":
      collectExpressionTemporaries(expression.expression, output);
      return;
    case "template":
      expression.parts.forEach((part) => {
        if (part.kind === "expression") {
          collectExpressionTemporaries(part.expression, output);
        }
      });
      return;
    case "property":
      collectExpressionTemporaries(expression.object, output);
      return;
    case "index":
      collectExpressionTemporaries(expression.object, output);
      collectExpressionTemporaries(expression.index, output);
      return;
    case "call":
      collectExpressionTemporaries(expression.callee, output);
      expression.arguments.forEach((argument) =>
        collectExpressionTemporaries(argument.value, output),
      );
      return;
    case "unary":
      collectExpressionTemporaries(expression.operand, output);
      return;
    case "binary":
      collectExpressionTemporaries(expression.left, output);
      collectExpressionTemporaries(expression.right, output);
      return;
    case "range":
      collectExpressionTemporaries(expression.start, output);
      collectExpressionTemporaries(expression.end, output);
      return;
  }
}

function validateFrames(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("Runtime frames must be a non-empty array.");
    return;
  }
  const frameIds = new Set<number>();
  for (const frame of value) {
    if (
      !isPlainRecord(frame) ||
      !nonNegativeSafeInteger(frame.id) ||
      !Array.isArray(frame.bindings)
    ) {
      errors.push("Runtime scope frame is malformed.");
      continue;
    }
    if (frameIds.has(frame.id)) errors.push("Runtime scope frame IDs must be unique.");
    frameIds.add(frame.id);
    const names = new Set<string>();
    for (const binding of frame.bindings) {
      if (
        !isPlainRecord(binding) ||
        typeof binding.name !== "string" ||
        binding.name.length === 0
      ) {
        errors.push("Runtime binding is malformed.");
        continue;
      }
      if (names.has(binding.name)) errors.push("Runtime frame contains a duplicate binding.");
      names.add(binding.name);
      const failure = validateCapturedSerializableValue(binding.value);
      if (failure !== null) errors.push(failure);
    }
  }
  if (isPlainRecord(value[0]) && value[0].id !== 0) {
    errors.push("Runtime root scope frame must have ID 0.");
  }
}

function validateSpeakers(value: unknown, errors: string[]): Set<number> {
  const ids = new Set<number>();
  if (!isCanonicalJsonArray(value)) {
    errors.push("Runtime speakers must be an array.");
    return ids;
  }
  for (const speaker of value) {
    if (
      !isPlainRecord(speaker) ||
      !nonNegativeSafeInteger(speaker.id) ||
      typeof speaker.identifier !== "string" ||
      speaker.identifier.length === 0 ||
      !isCanonicalJsonArray(speaker.properties)
    ) {
      errors.push("Runtime speaker is malformed.");
      continue;
    }
    if (ids.has(speaker.id)) errors.push("Runtime speaker IDs must be unique.");
    ids.add(speaker.id);
    const names = new Set<string>();
    for (const property of speaker.properties) {
      if (
        !isPlainRecord(property) ||
        typeof property.name !== "string" ||
        property.name.length === 0
      ) {
        errors.push("Runtime speaker property is malformed.");
        continue;
      }
      if (names.has(property.name)) errors.push("Runtime speaker property names must be unique.");
      names.add(property.name);
      const failure = validateCapturedSerializableValue(property.value);
      if (failure !== null) errors.push(failure);
      if (property.name === "defaultSaySkippable" && typeof property.value !== "boolean") {
        errors.push("Runtime speaker property defaultSaySkippable must be a boolean.");
      }
    }
  }
  return ids;
}

function validateFailure(value: unknown, status: unknown, errors: string[]): void {
  if (value === null) {
    if (status === "failed") errors.push("Failed runtime status requires failure information.");
    return;
  }
  if (
    !isPlainRecord(value) ||
    typeof value.code !== "string" ||
    typeof value.message !== "string" ||
    !validSpan(value.span)
  ) {
    errors.push("Runtime failure information is malformed.");
  }
  if (status !== "failed") errors.push("Runtime failure information requires failed status.");
}

function validateSpeakerReferences(
  frames: unknown,
  speakers: unknown,
  loopFrames: unknown,
  temporaries: unknown,
  callFrames: unknown,
  speakerIds: ReadonlySet<number>,
  errors: string[],
): void {
  const values: unknown[] = [];
  if (Array.isArray(frames)) {
    for (const frame of frames) {
      if (!isPlainRecord(frame) || !Array.isArray(frame.bindings)) continue;
      for (const binding of frame.bindings) {
        if (isPlainRecord(binding)) values.push(binding.value);
      }
    }
  }
  if (Array.isArray(speakers)) {
    for (const speaker of speakers) {
      if (!isPlainRecord(speaker) || !Array.isArray(speaker.properties)) continue;
      for (const property of speaker.properties) {
        if (isPlainRecord(property)) values.push(property.value);
      }
    }
  }
  if (Array.isArray(loopFrames)) {
    for (const loop of loopFrames) {
      if (isPlainRecord(loop) && loop.kind === "for") values.push(loop.source);
    }
  }
  if (Array.isArray(temporaries)) {
    for (const temporary of temporaries) {
      if (isPlainRecord(temporary)) values.push(temporary.value);
    }
  }
  if (Array.isArray(callFrames)) {
    for (const frame of callFrames) {
      if (!isPlainRecord(frame)) continue;
      if (Array.isArray(frame.callerTemporaries)) {
        for (const temporary of frame.callerTemporaries) {
          if (isPlainRecord(temporary)) values.push(temporary.value);
        }
      }
      if (Array.isArray(frame.arguments)) {
        for (const argument of frame.arguments) {
          if (isPlainRecord(argument) && argument.supplied === true) {
            values.push(argument.value);
          }
        }
      }
    }
  }
  const referencedIds = new Set<number>();
  for (const value of values) collectSpeakerReferenceIds(value, referencedIds);
  for (const id of referencedIds) {
    if (!speakerIds.has(id)) {
      errors.push("Runtime value refers to an unknown speaker ID.");
      return;
    }
  }
}

function collectSpeakerReferenceIds(value: unknown, output: Set<number>): void {
  const work: unknown[] = [value];
  while (work.length > 0) {
    const current = work.pop();
    if (!isPlainRecord(current)) continue;
    if (current.kind === "speakerReference" && nonNegativeSafeInteger(current.speakerId)) {
      output.add(current.speakerId);
      continue;
    }
    if (current.kind === "list" && Array.isArray(current.items)) {
      for (let index = current.items.length - 1; index >= 0; index -= 1) {
        work.push(current.items[index]);
      }
    } else if (current.kind === "object" && Array.isArray(current.properties)) {
      for (let index = current.properties.length - 1; index >= 0; index -= 1) {
        const property = current.properties[index];
        if (isPlainRecord(property)) work.push(property.value);
      }
    }
  }
}

function validSpan(value: unknown): value is SourceSpan {
  return (
    isPlainRecord(value) &&
    validPosition(value.start) &&
    validPosition(value.end) &&
    value.end.offset >= value.start.offset
  );
}

function validPosition(value: unknown): value is { offset: number; line: number; column: number } {
  return (
    isPlainRecord(value) &&
    nonNegativeSafeInteger(value.offset) &&
    nonNegativeSafeInteger(value.line) &&
    nonNegativeSafeInteger(value.column)
  );
}

function copySpan(span: SourceSpan): SourceSpan {
  return createSourceSpan(span.start, span.end);
}

function cloneTemporary(temporary: RuntimeTemporarySnapshot): RuntimeTemporarySnapshot {
  return { id: temporary.id, value: cloneCapturedSerializableValue(temporary.value) };
}

function nonNegativeSafeInteger(value: unknown): value is number {
  // EVIDENCE: validation: Number.isSafeInteger establishes the numeric value before comparison.
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function unsigned32(value: unknown): value is number {
  return nonNegativeSafeInteger(value) && value <= 0xffff_ffff;
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

function runtimeInputDataFailureMessage(kind: ExternalDataFailureKind, path: string): string {
  switch (kind) {
    case "nonFiniteNumber":
      return `${path} must be a finite number.`;
    case "nonJsonSafeValue":
    case "nonPlainObject":
      return `${path} is not a JSON-safe runtime value.`;
    case "cycle":
      return `${path} contains a cyclic runtime value.`;
  }
}

function snapshotExternalDataFailureMessage(kind: ExternalDataFailureKind): string {
  switch (kind) {
    case "nonFiniteNumber":
      return "Runtime snapshot contains a non-finite number.";
    case "nonJsonSafeValue":
      return "Runtime snapshot contains a non-JSON-safe value.";
    case "cycle":
      return "Runtime snapshot contains a cycle.";
    case "nonPlainObject":
      return "Runtime snapshot contains a non-plain object.";
  }
}
