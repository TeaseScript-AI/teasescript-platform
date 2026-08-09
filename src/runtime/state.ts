import type {
  RuntimeActionSettlementSnapshot,
  RuntimeChatPacingGateSettlementSnapshot,
  RuntimePendingActionSnapshot,
  RuntimePreparedSayOutputSnapshot,
} from "./actions/model.js";
import type {
  ExpressionPlan,
  Instruction,
  InstructionPlan,
  InteractionUiPayload,
} from "../plan/model.js";
import { captureInstructionPlan } from "../plan/capture.js";
import {
  EXTERNAL_DATA_DEPTH_MESSAGE,
  EXTERNAL_DATA_WORK_MESSAGE,
  captureExternalData,
  type ExternalDataFailureKind,
} from "../external-data-limits.js";
import { createSourceSpan, type SourceSpan } from "../source.js";
import {
  boundedInteractionUtf8ByteLength,
  interactionStringHasNonWhitespace,
  interactionStringFits,
  MAX_INTERACTION_AGGREGATE_UTF8_BYTES,
  MAX_INTERACTION_OPTION_ENTRIES,
} from "../interaction-limits.js";
import {
  createXorShift32State,
  DEFAULT_PLAYGROUND_SEED,
  XORSHIFT32_ALGORITHM,
  type XorShift32State,
} from "./random.js";
import {
  cloneSerializableValue,
  validateSerializableValue,
  type SerializableRuntimeProperty,
  type SerializableRuntimeList,
  type SerializableRuntimeRange,
  type SerializableRuntimeSet,
  type SerializableRuntimeValue,
} from "./serializable-values.js";
import {
  detailedValidationWorkLimitForTesting,
  recordValidationTestWork,
} from "../validation-testing.js";

export const RUNTIME_SNAPSHOT_FORMAT = "teasescript-runtime-snapshot";
export const RUNTIME_SNAPSHOT_VERSION = 12;
export const DEFAULT_MAX_CALL_DEPTH = 256;
export const MAX_SUPPORTED_CALL_DEPTH = 4096;
export const MAX_RUNTIME_SESSION_TIME_MS = Number.MAX_SAFE_INTEGER;
const DEFAULT_CHAT_PACING_SETTINGS = Object.freeze({
  baseDelayMs: 1500,
  delayPerWordMs: 300,
  delayPerCharacterMs: 30,
});
const MAX_DETAILED_VALIDATION_WORK = 1_000_000;
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
  readonly source:
    | SerializableRuntimeList
    | SerializableRuntimeSet
    | SerializableRuntimeRange;
  position: number;
}

export interface RuntimeWhileLoopFrameSnapshot extends RuntimeLoopFrameBase {
  readonly kind: "while";
}

export type RuntimeLoopFrameSnapshot =
  | RuntimeRepeatLoopFrameSnapshot
  | RuntimeForLoopFrameSnapshot
  | RuntimeWhileLoopFrameSnapshot;

export interface RuntimeTemporarySnapshot {
  readonly id: number;
  value: SerializableRuntimeValue;
}

export type RuntimeCallArgumentSnapshot =
  | {
      readonly parameterName: string;
      readonly supplied: false;
    }
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
  const capturedPlan = captureInstructionPlan(plan);
  if (!capturedPlan.validation.valid || capturedPlan.plan === null) {
    throw new TypeError(
      capturedPlan.validation.errors[0]?.message ?? "Malformed instruction plan.",
    );
  }
  const optionsCapture = captureExternalData(options);
  if (!optionsCapture.ok) {
    throw new TypeError(runtimeInputDataFailureMessage(
      optionsCapture.failure.kind,
      optionsCapture.failure.path,
    ));
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
    throw new RangeError(`initialSessionTimeMs must be a finite number from 0 through ${MAX_RUNTIME_SESSION_TIME_MS}.`);
  }
  const maxCallDepth = maxCallDepthValue === undefined
    ? DEFAULT_MAX_CALL_DEPTH
    : maxCallDepthValue;
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
    const failure = validateSerializableValue(value, `globals.${name}`);
    if (failure !== null) throw new TypeError(failure);
    bindings.push({
      name,
      value: cloneSerializableValue(value as SerializableRuntimeValue),
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
    preparedSayOutput: null,
    maxCallDepth,
    status: capturedPlan.plan.rootEndInstruction === 0 ? "halted" : "ready",
    failure: null,
  };
}

export function cloneRuntimeSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  const captured = captureRuntimeSnapshot(snapshot);
  if (!captured.validation.valid || captured.snapshot === null) {
    throw new TypeError(
      captured.validation.errors[0] ?? "Malformed runtime snapshot.",
    );
  }
  return cloneCapturedRuntimeSnapshot(captured.snapshot);
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
        value: cloneSerializableValue(binding.value),
      })),
    })),
    speakers: snapshot.speakers.map((speaker) => ({
      id: speaker.id,
      identifier: speaker.identifier,
      properties: speaker.properties.map((property) => ({
        name: property.name,
        value: cloneSerializableValue(property.value),
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
        source: cloneSerializableValue(frame.source) as RuntimeForLoopFrameSnapshot["source"],
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
              value: cloneSerializableValue(argument.value),
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
    foregroundAction: snapshot.foregroundAction === null ? null : clonePendingAction(snapshot.foregroundAction),
    backgroundActions: snapshot.backgroundActions.map(clonePendingAction),
    nextActionId: snapshot.nextActionId,
    lastSettlement: snapshot.lastSettlement === null ? null : cloneSettlement(snapshot.lastSettlement),
    interactionResultHandoff:
      snapshot.interactionResultHandoff === null
        ? null
        : cloneInteractionResultHandoff(snapshot.interactionResultHandoff),
    preparedSayOutput: snapshot.preparedSayOutput === null ? null : clonePreparedSayOutput(snapshot.preparedSayOutput),
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

function clonePreparedSayOutput(output: RuntimePreparedSayOutputSnapshot): RuntimePreparedSayOutputSnapshot {
  return {
    owningInstruction: output.owningInstruction,
    continuationInstruction: output.continuationInstruction,
    speaker: output.speaker === null ? null : { ...output.speaker },
    text: output.text,
    durationMs: output.durationMs,
    skippable: output.skippable,
  };
}

function clonePendingAction(action: RuntimePendingActionSnapshot): RuntimePendingActionSnapshot {
  if (action.kind === "delay") return {
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
  if (action.kind === "chatPacingGate") return {
    kind: "chatPacingGate", actionId: action.actionId,
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    ownerCallFrameId: action.ownerCallFrameId,
    scopeDepth: action.scopeDepth, loopDepth: action.loopDepth,
    createdAtMs: action.createdAtMs, deadlineMs: action.deadlineMs,
    skippable: action.skippable, requestEventSequence: action.requestEventSequence,
    preparedOutput: action.preparedOutput === null ? null : {
      owningInstruction: action.preparedOutput.owningInstruction,
      continuationInstruction: action.preparedOutput.continuationInstruction,
      speaker: action.preparedOutput.speaker === null ? null : { ...action.preparedOutput.speaker },
      text: action.preparedOutput.text,
      durationMs: action.preparedOutput.durationMs,
      skippable: action.preparedOutput.skippable,
    },
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
  const accessibleName = ui.accessibleName.kind === "text"
    ? { kind: "text" as const, text: ui.accessibleName.text }
    : { kind: "localizedDefault" as const, key: ui.accessibleName.key };
  if (ui.kind === "choice") return {
    kind: "choice",
    labelType: ui.labelType,
    options: ui.options.map((option) => ({ text: option.text, label: option.label })),
    accessibleName,
  };
  if (ui.kind === "button") return { kind: "button", buttonLabel: ui.buttonLabel, accessibleName };
  return { kind: ui.kind, hint: ui.hint, accessibleName };
}

function cloneSettlement(settlement: RuntimeActionSettlementSnapshot): RuntimeActionSettlementSnapshot {
  if (settlement.actionKind === "delay") return {
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
}

export function captureRuntimeSnapshot(
  value: unknown,
  plan?: InstructionPlan,
): CapturedRuntimeSnapshotResult {
  const snapshotCapture = captureExternalData(value);
  if (!snapshotCapture.ok) {
    return Object.freeze({
      validation: Object.freeze({
        valid: false,
        errors: Object.freeze([
          snapshotExternalDataFailureMessage(snapshotCapture.failure.kind),
        ]),
      }),
      snapshot: null,
    });
  }

  let capturedPlan: InstructionPlan | undefined;
  if (plan !== undefined) {
    const planCapture = captureExternalData(plan);
    if (!planCapture.ok) {
      return Object.freeze({
        validation: Object.freeze({
          valid: false,
          errors: Object.freeze([
            snapshotExternalDataFailureMessage(planCapture.failure.kind),
          ]),
        }),
        snapshot: null,
      });
    }
    capturedPlan = planCapture.value as InstructionPlan;
  }

  const validation = validateCapturedRuntimeSnapshot(
    snapshotCapture.value,
    capturedPlan,
  );
  return Object.freeze({
    validation,
    snapshot: validation.valid
      ? snapshotCapture.value as RuntimeSnapshot
      : null,
  });
}

export function validateRuntimeSnapshot(
  value: unknown,
  plan?: InstructionPlan,
): SnapshotValidationResult {
  return captureRuntimeSnapshot(value, plan).validation;
}

export function validateCapturedRuntimeSnapshot(
  value: unknown,
  plan?: InstructionPlan,
): SnapshotValidationResult {
  const errors: string[] = [];
  if (!isPlainRecord(value)) {
    return Object.freeze({ valid: false, errors: Object.freeze(["Runtime snapshot must be an object."]) });
  }
  if (!hasExactKeys(value, RUNTIME_SNAPSHOT_KEYS)) {
    errors.push("Runtime snapshot contains unsupported fields or omits required fields.");
  }
  if (value.format !== RUNTIME_SNAPSHOT_FORMAT) errors.push("Unsupported runtime-snapshot format.");
  if (value.version !== RUNTIME_SNAPSHOT_VERSION) errors.push("Unsupported runtime-snapshot version.");
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
  validateTemporaries(value.temporaries, plan, "Runtime temporaries", errors);
  validatePreparedReferenceTemporaries(
    value.temporaries,
    value.frames,
    value.speakers,
    preparedReferenceTemporaryIds,
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
  } else if (
    typeof value.defaultSpeaker === "number" &&
    !speakerIds.has(value.defaultSpeaker)
  ) {
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
    frameIds.some((id) => id >= (value.nextScopeId as number))
  ) {
    errors.push("Runtime nextScopeId must be a positive unused safe integer ID.");
  }
  if (
    !nonNegativeSafeInteger(value.nextSpeakerId) ||
    value.nextSpeakerId < 1 ||
    [...speakerIds].some((id) => id >= (value.nextSpeakerId as number))
  ) {
    errors.push("Runtime nextSpeakerId must be a positive unused safe integer ID.");
  }
  if (
    !nonNegativeSafeInteger(value.nextCallFrameId) ||
    value.nextCallFrameId < 1 ||
    [...callFrameIds].some((id) => id >= (value.nextCallFrameId as number))
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
  if (
    analysis?.detailedWorkExceeded === true &&
    !errors.includes("Runtime snapshot exceeds the detailed validation work limit.")
  ) {
    errors.push("Runtime snapshot exceeds the detailed validation work limit.");
  }
  if (!["ready", "running", "waiting", "halted", "failed"].includes(String(value.status))) {
    errors.push("Runtime status is invalid.");
  }
  validateFailure(value.failure, value.status, errors);
  validateStatusConsistency(value, plan, errors);
  validateRootEndTransition(value, plan, errors);
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
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
  const plannedLoops = new Map<number, {
    kind: "repeat" | "for" | "while";
    variable?: string;
    start: number;
    continueStart: number;
    target: number;
    functionId: number | null;
  }>();
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
    const currentOwner = Array.isArray(callFrames) && callFrames.length > 0
      ? (isPlainRecord(callFrames.at(-1)) ? callFrames.at(-1)!.id : undefined)
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
      const failure = validateSerializableValue(frame.source, "loop.source");
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
    const size = (source.end as number) - (source.start as number) +
      (source.inclusive ? 1 : 0);
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
    const failure = validateSerializableValue(temporary.value);
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
    const failure = validatePreparedReferenceDescriptor(
      temporary.value,
      frames,
      speakers,
    );
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
  if (
    rootFrameId !== null &&
    (!nonNegativeSafeInteger(rootFrameId))
  ) {
    return "the root frame ID must be a non-negative integer or null.";
  }
  if (
    rootName !== null &&
    (typeof rootName !== "string" || rootName.length === 0)
  ) {
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

function serializedObjectPropertyMap(
  value: unknown,
): ReadonlyMap<string, unknown> | null {
  if (
    !isPlainRecord(value) ||
    value.kind !== "object" ||
    !Array.isArray(value.properties)
  ) {
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

function parsePreparedReferencePath(
  value: unknown,
): readonly PreparedReferencePathStep[] | null {
  if (!isPlainRecord(value) || value.kind !== "list" || !Array.isArray(value.items)) {
    return null;
  }
  const output: PreparedReferencePathStep[] = [];
  for (const item of value.items) {
    const properties = serializedObjectPropertyMap(item);
    if (properties === null) return null;
    const kind = properties.get("kind");
    if (
      kind === "property" &&
      properties.size === 2 &&
      properties.has("name")
    ) {
      const name = properties.get("name");
      if (typeof name !== "string" || name.length === 0) return null;
      output.push({ kind, name });
      continue;
    }
    if (
      kind === "index" &&
      properties.size === 2 &&
      properties.has("index")
    ) {
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
  const frame = frames.find(
    (candidate) => isPlainRecord(candidate) && candidate.id === frameId,
  );
  if (!isPlainRecord(frame) || !Array.isArray(frame.bindings)) {
    return { found: false, value: null };
  }
  const binding = frame.bindings.find(
    (candidate) =>
      isPlainRecord(candidate) &&
      candidate.name === name &&
      "value" in candidate,
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
      const property = serializedSpeakerProperty(
        speakers,
        current.speakerId,
        step.name,
      );
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
  const names = name === "title"
    ? ["title", "shortTitle"]
    : name === "shortTitle"
      ? ["shortTitle", "title"]
      : [name];
  for (const candidateName of names) {
    const property = speaker.properties.find(
      (candidate) =>
        isPlainRecord(candidate) &&
        candidate.name === candidateName &&
        "value" in candidate,
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
    validateTemporaries(
      frame.callerTemporaries,
      plan,
      "Runtime caller temporaries",
      errors,
    );
    validatePreparedReferenceTemporaries(
      frame.callerTemporaries,
      frames,
      speakers,
      preparedReferenceTemporaryIds,
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
    validateCallArgumentConsistency(
      frame.arguments,
      frame.callerTemporaries,
      callInstruction,
      errors,
    );
    validateParameterState(frame.parameterState, definition, errors);
    validateParameterBindings(
      frame,
      frames,
      definition,
      analysis,
      errors,
    );

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
      const callerDefinition = isPlainRecord(caller) && nonNegativeSafeInteger(caller.functionId)
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
      const child = frameIndex < value.length - 1
        ? value[frameIndex + 1]
        : undefined;
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

function validateCallArgumentConsistency(
  argumentsValue: unknown,
  callerTemporaries: unknown,
  callInstruction: InstructionPlan["instructions"][number] | undefined,
  errors: string[],
): void {
  if (
    !Array.isArray(argumentsValue) ||
    !Array.isArray(callerTemporaries) ||
    callInstruction?.kind !== "callFunction"
  ) {
    return;
  }
  const preparedByParameter = new Map(
    callInstruction.arguments.map((argument) => [argument.parameterName, argument]),
  );
  recordValidationTestWork("preparedArgumentMapBuilds");
  const callerTemporariesById = createTemporaryMap(callerTemporaries);
  for (const argument of argumentsValue) {
    if (!isPlainRecord(argument) || typeof argument.parameterName !== "string") continue;
    const prepared = preparedByParameter.get(argument.parameterName);
    if (argument.supplied === true) {
      const temporary = prepared === undefined
        ? undefined
        : callerTemporariesById.get(prepared.temporaryId);
      if (
        !isPlainRecord(temporary) ||
        !("value" in temporary) ||
        !sameValidatedSerializableValue(temporary.value, argument.value)
      ) {
        errors.push("Runtime supplied argument does not match caller temporary state.");
      }
    } else if (prepared !== undefined) {
      errors.push("Runtime missing argument is marked as supplied by the call instruction.");
    }
  }
}

function createTemporaryMap(temporaries: readonly unknown[]): ReadonlyMap<number, Record<string, unknown>> {
  recordValidationTestWork("temporaryMapBuilds");
  const result = new Map<number, Record<string, unknown>>();
  for (const temporary of temporaries) {
    if (isPlainRecord(temporary) && nonNegativeSafeInteger(temporary.id)) {
      result.set(temporary.id, temporary);
    }
  }
  return result;
}

/** Structural equality for values that have already passed serializable-value validation. */
function sameValidatedSerializableValue(left: unknown, right: unknown): boolean {
  recordValidationTestWork("structuralValueComparisons");
  if (left === right) return true;
  if (!isPlainRecord(left) || !isPlainRecord(right) || left.kind !== right.kind) return false;
  switch (left.kind) {
    case "speakerReference":
      return left.speakerId === right.speakerId && left.identifier === right.identifier;
    case "range":
      return left.start === right.start && left.end === right.end && left.inclusive === right.inclusive;
    case "list":
    case "set":
      { const rightItems = Array.isArray(right.items) ? right.items : null;
        return Array.isArray(left.items) && rightItems !== null &&
          left.items.length === rightItems.length &&
          left.items.every((item, index) => sameValidatedSerializableValue(item, rightItems[index])); }
    case "object":
      { const rightProperties = Array.isArray(right.properties) ? right.properties : null;
        return Array.isArray(left.properties) && rightProperties !== null &&
        left.properties.length === rightProperties.length &&
        left.properties.every((property, index) =>
          isPlainRecord(property) && isPlainRecord(rightProperties[index]) &&
          property.name === rightProperties[index].name &&
          sameValidatedSerializableValue(property.value, rightProperties[index].value)
        ); }
    default:
      return false;
  }
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
  const argumentsList = frame.arguments as unknown[];
  const parameterState = frame.parameterState as Record<string, unknown>;
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
        const failure = validateSerializableValue(argument.value);
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
    return {
      phase: "supplied",
      parameterIndex: instructionPosition - definition.entryInstruction,
    };
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
    const bindIndex = analysis.defaultBindingPositions.get(
      `${definition.id}:${parameterIndex}`,
    ) ?? -1;
    if (instructionPosition > cursor && instructionPosition < prepare.target) {
      return {
        phase: "defaults",
        parameterIndex:
          bindIndex >= 0 && instructionPosition > bindIndex
            ? parameterIndex + 1
            : parameterIndex,
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
  remainingDetailedWork: number;
  detailedWorkExceeded: boolean;
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
    remainingDetailedWork:
      detailedValidationWorkLimitForTesting() ?? MAX_DETAILED_VALIDATION_WORK,
    detailedWorkExceeded: false,
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
  const required = requiredContinuationTemporaries(
    analysis,
    returnInstruction,
    callerLoopFrames,
  );
  if (analysis.detailedWorkExceeded) {
    errors.push("Runtime snapshot exceeds the detailed validation work limit.");
    return;
  }
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
  const loopSignature = isPlainRecord(activeLoop) && nonNegativeSafeInteger(activeLoop.loopId)
    ? `loop:${activeLoop.loopId}`
    : "none";
  let liveIn = analysis.continuationLiveness.get(loopSignature);
  if (liveIn === undefined) {
    // Charge the full table allocation before allocating or caching it.
    if (!consumeDetailedValidationWork(analysis, analysis.plan.instructions.length)) {
      recordValidationTestWork("budgetExhaustions");
      return new Set<number>();
    }
    recordValidationTestWork("livenessComputations");
    recordValidationTestWork("livenessTableAllocations");
    liveIn = computeContinuationLiveness(analysis, loopFrames);
    if (!analysis.detailedWorkExceeded) {
      analysis.continuationLiveness.set(loopSignature, liveIn);
      recordValidationTestWork("livenessCacheInsertions");
    }
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
      if (!consumeDetailedValidationWork(analysis)) return liveIn;
      const instruction = plan.instructions[index]!;
      const liveOut = new Set<number>();
      for (const successor of instructionSuccessors(analysis, index)) {
        for (const temporaryId of liveIn[successor] ?? []) {
          if (!consumeDetailedValidationWork(analysis)) return liveIn;
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

function consumeDetailedValidationWork(analysis: SnapshotValidationAnalysis, amount = 1): boolean {
  recordValidationTestWork("detailedWorkConsumed", amount);
  if (analysis.remainingDetailedWork < amount) {
    analysis.detailedWorkExceeded = true;
    return false;
  }
  analysis.remainingDetailedWork -= amount;
  return true;
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
      return instruction.returnInstruction < regionEnd
        ? [instruction.returnInstruction]
        : [];
    default:
      return next === null ? [] : [next];
  }
}

function instructionKilledTemporaries(
  instruction: Instruction,
): ReadonlySet<number> {
  switch (instruction.kind) {
    case "storeTemporary":
      return new Set([instruction.temporaryId]);
    case "prepareInteractionSpeaker":
      return new Set([instruction.destinationTemporary]);
    case "prepareReference":
      return new Set([instruction.destinationTemporary]);
    case "clearTemporary":
      return new Set([instruction.temporaryId]);
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
    if (!isPlainRecord(action) || !["delay", "interaction", "chatPacingGate"].includes(String(action.kind))) errors.push("Waiting runtime state requires one foreground action.");
  } else if (action !== null) {
    errors.push("Non-waiting runtime state must not contain a foreground action.");
  }
  if (value.preparedSayOutput !== null && !validPreparedSayOutput(value.preparedSayOutput, value, plan)) {
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
  } else if (value.status === "halted") {
    if (calls !== 0 || loops !== 0 || temporaries !== 0 || scopes !== 1 || value.failure !== null) {
      errors.push("Halted runtime state retains active execution state.");
    }
    if (plan !== undefined && !isLegalHaltPosition(value.nextInstruction, plan)) {
      errors.push("Halted runtime state is not at a legal halt position.");
    }
  } else if (value.status === "running") {
    if (value.failure !== null) errors.push("Running runtime state contains failure information.");
    if (
      plan !== undefined &&
      calls === 0 &&
      (!nonNegativeSafeInteger(value.nextInstruction) || value.nextInstruction > plan.rootEndInstruction)
    ) {
      errors.push("Root execution position is outside the root instruction range.");
    }
  }
}

/**
 * A terminal delay or result-free button may settle at the root-end
 * coordinate while awaiting its ordinary completion entry. Do not treat the
 * coordinate as a general running-state escape hatch: result-bearing
 * interactions require an in-region continuation that consumes or clears
 * their destination temporary.
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
  ) return;

  const settlement = value.lastSettlement;
  const terminalInstruction = plan.instructions[plan.rootEndInstruction - 1];
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
    Array.isArray(value.backgroundActions) &&
    value.backgroundActions.length === 0 &&
    value.failure === null &&
    value.contextualSpeaker === null &&
    isPlainRecord(settlement) &&
    settlement.settlementKind === "completed" &&
    positiveSafeInteger(settlement.actionId) &&
    positiveSafeInteger(value.nextActionId) &&
    settlement.actionId === value.nextActionId - 1 &&
    settlement.owningInstruction === plan.rootEndInstruction - 1 &&
    settlement.continuationInstruction === plan.rootEndInstruction;
  const canonical = common && (
    (settlement.actionKind === "delay" && terminalInstruction?.kind === "wait") ||
    (settlement.actionKind === "interaction" && settlement.interactionKind === "button" && terminalInstruction?.kind === "interaction" && terminalInstruction.interactionKind === "button")
  );
  if (!canonical) {
    errors.push("Running root-end state is not a canonical settled terminal foreground transition.");
  }
}

function validSessionTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_RUNTIME_SESSION_TIME_MS;
}

function captureChatPacingSettings(options: Record<string, unknown>): ChatPacingSettings {
  return Object.freeze({
    baseDelayMs: capturePacingSetting(options.baseDelayMs, "baseDelayMs", DEFAULT_CHAT_PACING_SETTINGS.baseDelayMs),
    delayPerWordMs: capturePacingSetting(options.delayPerWordMs, "delayPerWordMs", DEFAULT_CHAT_PACING_SETTINGS.delayPerWordMs),
    delayPerCharacterMs: capturePacingSetting(options.delayPerCharacterMs, "delayPerCharacterMs", DEFAULT_CHAT_PACING_SETTINGS.delayPerCharacterMs),
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
  return isPlainRecord(value) &&
    hasExactKeys(value, ["baseDelayMs", "delayPerWordMs", "delayPerCharacterMs"]) &&
    validPacingSetting(value.baseDelayMs) &&
    validPacingSetting(value.delayPerWordMs) &&
    validPacingSetting(value.delayPerCharacterMs);
}

function validPacingSetting(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 1;
}

function hasEventSequenceCapacity(value: unknown, count: number): boolean {
  return positiveSafeInteger(value) && value <= Number.MAX_SAFE_INTEGER - count;
}

function validatePendingActionState(
  value: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  analysis: SnapshotValidationAnalysis | undefined,
  errors: string[],
): void {
  if (!validSessionTime(value.currentSessionTimeMs)) errors.push("Runtime currentSessionTimeMs is outside the supported range.");
  if (!validBackgroundPacingActions(value, plan)) {
    errors.push("Runtime backgroundActions are malformed.");
  }
  if (!positiveSafeInteger(value.nextActionId)) errors.push("Runtime nextActionId must be a positive safe integer.");
  const action = value.foregroundAction;
  if (action !== null) {
    const callIds = Array.isArray(value.callFrames) ? new Set(value.callFrames.filter(isPlainRecord).map((frame) => frame.id)) : new Set<unknown>();
    const currentSessionTimeMs = value.currentSessionTimeMs;
    const delayTimesAreValid =
      isPlainRecord(action) &&
      action.kind === "delay" &&
      hasExactKeys(action, [
        "kind", "actionId", "owningInstruction", "continuationInstruction",
        "ownerCallFrameId", "scopeDepth", "loopDepth", "createdAtMs",
        "deadlineMs", "expectedCompletion", "requestEventSequence",
      ]) &&
      validSessionTime(action.createdAtMs) &&
      validSessionTime(action.deadlineMs) &&
      validSessionTime(currentSessionTimeMs) &&
      action.createdAtMs <= currentSessionTimeMs &&
      action.deadlineMs > currentSessionTimeMs;
    const baseValid = validForegroundActionBase(action, value, callIds);
    const kindValid = validForegroundActionKind(
      action,
      value,
      plan,
      delayTimesAreValid,
    );
    if (!baseValid || !kindValid || (plan !== undefined && isPlainRecord(action) && !validForegroundActionOwnership(action, value, plan))) {
      errors.push("Runtime foreground action is malformed.");
    }
  }
  const settlement = value.lastSettlement;
  if (!validRetainedSettlement(settlement, value, plan, analysis)) {
    errors.push("Runtime lastSettlement is malformed.");
  }
  if (!validActiveActionIdentityCoherence(value)) {
    errors.push("Runtime active action identities are inconsistent with each other or the retained settlement.");
  }
  if (!validActiveActionLocationCoherence(value)) {
    errors.push("Runtime foreground and background action locations are incoherent.");
  }
}

function validBackgroundPacingActions(
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  const actions = snapshot.backgroundActions;
  if (!Array.isArray(actions) || actions.length > 1) return false;

  for (let index = 0; index < actions.length; index += 1) {
    if (!Object.hasOwn(actions, index)) return false;
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
    return delayTimesAreValid &&
      action.expectedCompletion === "time" &&
      hasEventSequenceCapacity(snapshot.nextEventSequence, 1);
  }
  if (action.kind === "interaction") {
    return validInteractionAction(action, snapshot, plan) &&
      hasEventSequenceCapacity(snapshot.nextEventSequence, 2);
  }
  if (action.kind === "chatPacingGate") {
    return validPacingGateAction(action, snapshot, plan, true) &&
      hasEventSequenceCapacity(snapshot.nextEventSequence, 1);
  }
  return false;
}

function validRetainedSettlement(
  settlement: unknown,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  analysis: SnapshotValidationAnalysis | undefined,
): boolean {
  if (!isPlainRecord(settlement)) return settlement === null;
  if (!validSettlementShapeAndKind(settlement, snapshot, plan, analysis)) return false;
  return validSettlementIdentityAndEventSequences(settlement, snapshot);
}

function validSettlementShapeAndKind(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  analysis: SnapshotValidationAnalysis | undefined,
): boolean {
  return ["delay", "interaction", "chatPacingGate"].includes(String(settlement.actionKind)) &&
    (settlement.actionKind === "chatPacingGate" || settlement.settlementKind === "completed") &&
    positiveSafeInteger(settlement.actionId) &&
    validSettlementProvenance(settlement, plan) &&
    validSettlementKindData(settlement, snapshot, plan, analysis);
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
  ) return false;

  if (settlement.actionKind !== "interaction") return true;
  return positiveSafeInteger(settlement.transcriptEventSequence) &&
    settlement.requestEventSequence < settlement.transcriptEventSequence &&
    settlement.transcriptEventSequence < settlement.completionEventSequence;
}

function validActiveActionIdentityCoherence(snapshot: Record<string, unknown>): boolean {
  const actions = [snapshot.foregroundAction, ...(Array.isArray(snapshot.backgroundActions) ? snapshot.backgroundActions : [])]
    .filter(isPlainRecord);
  const actionIds = new Set<number>();
  const requestSequences = new Set<number>();
  const settlement = isPlainRecord(snapshot.lastSettlement) ? snapshot.lastSettlement : null;

  for (const action of actions) {
    if (!positiveSafeInteger(action.actionId) || !positiveSafeInteger(action.requestEventSequence)) return false;
    if (actionIds.has(action.actionId) || requestSequences.has(action.requestEventSequence)) return false;
    if (settlement !== null && !validActiveActionAgainstSettlement(action, settlement)) return false;
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
  const foregroundPacingGateCount = foregroundAction?.kind === "chatPacingGate"
    ? 1
    : 0;
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

  return validPacingGateCreatedBeforeForegroundDelay(
    backgroundPacingAction,
    foregroundAction,
  );
}

function validPacingGateCreatedBeforeForegroundDelay(
  pacingGate: Record<string, unknown>,
  delay: Record<string, unknown>,
): boolean {
  return positiveSafeInteger(pacingGate.actionId) &&
    positiveSafeInteger(pacingGate.requestEventSequence) &&
    positiveSafeInteger(delay.actionId) &&
    positiveSafeInteger(delay.requestEventSequence) &&
    pacingGate.actionId < delay.actionId &&
    pacingGate.requestEventSequence < delay.requestEventSequence;
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
  ) return false;

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
  ) return false;
  if (actionId === settlementActionId) return false;
  const retainedEventSequences = new Set<number>([
    settlementRequestEventSequence,
    settlementCompletionEventSequence,
  ].filter(positiveSafeInteger));
  if (settlement.actionKind === "interaction" && positiveSafeInteger(settlement.transcriptEventSequence)) {
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
  return positiveSafeInteger(actionId) &&
    positiveSafeInteger(requestEventSequence) &&
    positiveSafeInteger(settlementActionId) &&
    positiveSafeInteger(settlementCompletionEventSequence) &&
    actionId > settlementActionId &&
    requestEventSequence > settlementCompletionEventSequence;
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
  return action.kind === "chatPacingGate" &&
    settlement.actionKind === "delay" &&
    positiveSafeInteger(actionId) &&
    positiveSafeInteger(requestEventSequence) &&
    positiveSafeInteger(settlementActionId) &&
    positiveSafeInteger(settlementRequestEventSequence) &&
    positiveSafeInteger(settlementCompletionEventSequence) &&
    actionId < settlementActionId &&
    requestEventSequence < settlementRequestEventSequence &&
    settlementRequestEventSequence < settlementCompletionEventSequence;
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
  return action.kind === "delay" &&
    settlement.actionKind === "chatPacingGate" &&
    positiveSafeInteger(actionId) &&
    positiveSafeInteger(requestEventSequence) &&
    positiveSafeInteger(settlementActionId) &&
    positiveSafeInteger(settlementRequestEventSequence) &&
    positiveSafeInteger(settlementCompletionEventSequence) &&
    actionId > settlementActionId &&
    requestEventSequence > settlementRequestEventSequence &&
    requestEventSequence < settlementCompletionEventSequence;
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
  ) return false;

  if (action.kind === "chatPacingGate") return true;
  return (
    (action.ownerCallFrameId === null ||
      (positiveSafeInteger(action.ownerCallFrameId) && activeCallFrameIds.has(action.ownerCallFrameId))) &&
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
  return isPlainRecord(action) &&
    hasExactKeys(action, [
      "kind", "actionId", "owningInstruction", "continuationInstruction", "ownerCallFrameId",
      "scopeDepth", "loopDepth", "createdAtMs", "deadlineMs", "skippable", "requestEventSequence", "preparedOutput",
    ]) &&
    action.kind === "chatPacingGate" &&
    nonNegativeSafeInteger(action.owningInstruction) &&
    nonNegativeSafeInteger(action.continuationInstruction) &&
    action.continuationInstruction === action.owningInstruction + 1 &&
    typeof action.skippable === "boolean";
}

function validPacingGateIdentity(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): boolean {
  return positiveSafeInteger(action.actionId) &&
    positiveSafeInteger(action.requestEventSequence) &&
    positiveSafeInteger(snapshot.nextActionId) &&
    positiveSafeInteger(snapshot.nextEventSequence) &&
    action.actionId < snapshot.nextActionId &&
    action.requestEventSequence < snapshot.nextEventSequence;
}

function validPacingGateTiming(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): boolean {
  return validSessionTime(action.createdAtMs) &&
    validSessionTime(action.deadlineMs) &&
    validSessionTime(snapshot.currentSessionTimeMs) &&
    action.createdAtMs <= snapshot.currentSessionTimeMs &&
    action.deadlineMs > snapshot.currentSessionTimeMs;
}

function validPacingGateCreationProvenance(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  if (
    !nonNegativeSafeInteger(action.scopeDepth) ||
    !nonNegativeSafeInteger(action.loopDepth) ||
    action.loopDepth > action.scopeDepth ||
    !positiveSafeInteger(snapshot.nextScopeId) ||
    action.scopeDepth > snapshot.nextScopeId ||
    (action.ownerCallFrameId !== null &&
      (!positiveSafeInteger(action.ownerCallFrameId) ||
        !positiveSafeInteger(snapshot.nextCallFrameId) ||
        action.ownerCallFrameId >= snapshot.nextCallFrameId))
  ) return false;
  if (plan === undefined) return true;

  const owningInstruction = action.owningInstruction;
  if (!nonNegativeSafeInteger(owningInstruction) || plan.instructions[owningInstruction]?.kind !== "say") return false;
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

function validPreparedSayOutput(value: unknown, snapshot: Record<string, unknown>, plan: InstructionPlan | undefined): boolean {
  if (!isPreparedSayOutputShape(value)) return false;
  if (!validPreparedSayOutputDomain(value)) return false;
  if (!validPreparedSaySpeaker(value.speaker)) return false;
  const owningInstruction = value.owningInstruction;
  if (!nonNegativeSafeInteger(owningInstruction)) return false;
  if (plan !== undefined && plan.instructions[owningInstruction]?.kind !== "say") return false;
  return snapshot.nextInstruction === owningInstruction;
}

function isPreparedSayOutputShape(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && hasExactKeys(value, [
    "owningInstruction",
    "continuationInstruction",
    "speaker",
    "text",
    "durationMs",
    "skippable",
  ]);
}

function validPreparedSayOutputDomain(value: Record<string, unknown>): boolean {
  return nonNegativeSafeInteger(value.owningInstruction) &&
    nonNegativeSafeInteger(value.continuationInstruction) &&
    value.continuationInstruction === value.owningInstruction + 1 &&
    typeof value.text === "string" &&
    validPreparedSayDuration(value.durationMs) &&
    typeof value.skippable === "boolean";
}

function validPreparedSayDuration(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_RUNTIME_SESSION_TIME_MS;
}

function validPreparedSaySpeaker(value: unknown): boolean {
  return value === null || (
    isPlainRecord(value) &&
    hasExactKeys(value, ["identifier", "displayName", "color", "font", "avatar"]) &&
    typeof value.identifier === "string" &&
    typeof value.displayName === "string" &&
    (value.color === null || typeof value.color === "string") &&
    (value.font === null || typeof value.font === "string") &&
    (value.avatar === null || typeof value.avatar === "string")
  );
}

function validTopLevelPreparedSayOutputRelationship(
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  const settlement = snapshot.lastSettlement;
  if (snapshot.preparedSayOutput === null) {
    return validReleasedPacingSettlementAfterPreparedOutputConsumption(snapshot, settlement);
  }
  return isPreparedSayOutputShape(snapshot.preparedSayOutput) &&
    snapshot.status === "running" &&
    snapshot.foregroundAction === null &&
    Array.isArray(snapshot.backgroundActions) &&
    !snapshot.backgroundActions.some((action) => isPlainRecord(action) && action.kind === "chatPacingGate") &&
    validPacingSettlementReleaseLineage(settlement, plan) &&
    settlement.releasedPreparedOutputInstruction === snapshot.preparedSayOutput.owningInstruction;
}

function validReleasedPacingSettlementAfterPreparedOutputConsumption(
  snapshot: Record<string, unknown>,
  settlement: unknown,
): boolean {
  if (!isPlainRecord(settlement) || settlement.actionKind !== "chatPacingGate") return true;
  const releasedInstruction = settlement.releasedPreparedOutputInstruction;
  if (releasedInstruction === null) return true;
  if (!nonNegativeSafeInteger(releasedInstruction)) return false;

  return activePacingActions(snapshot).some(
    (action) =>
      action.owningInstruction === releasedInstruction &&
      validActionCreatedAfterSettlement(action, settlement),
  );
}

function activePacingActions(snapshot: Record<string, unknown>): Record<string, unknown>[] {
  const actions = [snapshot.foregroundAction, ...(Array.isArray(snapshot.backgroundActions) ? snapshot.backgroundActions : [])];
  return actions.filter(
    (action): action is Record<string, unknown> => isPlainRecord(action) && action.kind === "chatPacingGate",
  );
}

function validateInteractionResultHandoffState(
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  analysis: SnapshotValidationAnalysis | undefined,
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
      errors.push("Runtime interaction result handoff is missing at its canonical commit boundary.");
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
    (handoff.ownerCallFrameId !== null &&
      !positiveSafeInteger(handoff.ownerCallFrameId)) ||
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
  const destination = snapshot.temporaries.find((temporary) =>
    isPlainRecord(temporary) && temporary.id === handoff.destinationTemporary
  );
  if (
    !isPlainRecord(destination) ||
    !sameCanonicalSettlementResult(destination.value, handoff.result)
  ) {
    errors.push("Runtime interaction result handoff destination does not match its canonical result.");
  }

  const settlement = snapshot.lastSettlement;
  if (
    !isPlainRecord(settlement) ||
    !positiveSafeInteger(settlement.actionId) ||
    settlement.actionId < handoff.actionId
  ) {
    errors.push("Runtime interaction result handoff requires its settlement or a newer retained settlement.");
  } else if (
    settlement.actionId === handoff.actionId &&
    (
      settlement.actionKind !== "interaction" ||
      settlement.owningInstruction !== handoff.owningInstruction ||
      settlement.continuationInstruction !== handoff.continuationInstruction ||
      settlement.ownerCallFrameId !== handoff.ownerCallFrameId ||
      settlement.destinationTemporary !== handoff.destinationTemporary ||
      !sameCanonicalSettlementResult(settlement.result, handoff.result)
    )
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
    errors.push("Runtime interaction result handoff does not match its canonical plan instruction.");
  }
}

function validInteractionResultHandoffOwner(
  handoff: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  analysis: SnapshotValidationAnalysis | undefined,
): boolean {
  const callFrames = Array.isArray(snapshot.callFrames) ? snapshot.callFrames : [];
  const activeOwner = callFrames.at(-1);
  const ownerCallFrameId = handoff.ownerCallFrameId;
  if (ownerCallFrameId === null) {
    if (callFrames.length !== 0) return false;
    return analysis === undefined ||
      (nonNegativeSafeInteger(handoff.owningInstruction) &&
        analysis.functionIdsByInstruction[handoff.owningInstruction] === null);
  }
  if (
    !positiveSafeInteger(ownerCallFrameId) ||
    !isPlainRecord(activeOwner) ||
    activeOwner.id !== ownerCallFrameId
  ) return false;
  if (analysis === undefined || !nonNegativeSafeInteger(handoff.owningInstruction)) {
    return true;
  }
  const ownerFunctionId = analysis.functionIdsByInstruction[handoff.owningInstruction];
  return ownerFunctionId !== null && activeOwner.functionId === ownerFunctionId;
}

function validInteractionResultForInstruction(
  instruction: Extract<Instruction, { kind: "interaction" }>,
  result: unknown,
  snapshot: Record<string, unknown>,
): boolean {
  if (instruction.expectedResult === "number") {
    if (typeof result !== "number" || !Number.isFinite(result) || Object.is(result, -0)) return false;
    if (instruction.interactionKind !== "choice") return true;
    if ("preparedUi" in instruction) {
      return instruction.preparedUi.kind === "choice" &&
        instruction.preparedUi.labelType === "number" &&
        instruction.preparedUi.labels?.includes(result) === true;
    }
    return instruction.ui.kind === "choice" &&
      instruction.ui.options.some((option) => option.label === result);
  }
  if (
    instruction.expectedResult !== "string" ||
    typeof result !== "string" ||
    !interactionStringFits(result)
  ) return false;
  if (instruction.interactionKind === "text") {
    return !result.includes("\r") && interactionStringHasNonWhitespace(result);
  }
  if (instruction.interactionKind !== "choice") return false;
  if ("preparedUi" in instruction) {
    if (instruction.preparedUi.kind !== "choice") return false;
    if (instruction.preparedUi.labelType === "identifier") {
      return instruction.preparedUi.labels?.includes(result) === true;
    }
    if (instruction.preparedUi.labelType !== "none" || !Array.isArray(snapshot.temporaries)) return false;
    const raw = runtimeTemporaryValue(snapshot.temporaries, instruction.preparedUi.optionsTemporary);
    return isPlainRecord(raw) && raw.kind === "list" && Array.isArray(raw.items) &&
      raw.items.some((text) => text === result);
  }
  return instruction.ui.kind === "choice" && instruction.ui.options.some((option) =>
    (option.label ?? option.text) === result
  );
}

function validInteractionAction(action: Record<string, unknown>, snapshot: Record<string, unknown>, plan: InstructionPlan | undefined): boolean {
  if (!hasExactKeys(action, [
    "kind", "interactionKind", "actionId", "owningInstruction",
    "continuationInstruction", "ownerCallFrameId", "scopeDepth", "loopDepth",
    "destinationTemporary", "expectedResult", "target", "speakerId", "ui",
    "requestEventSequence",
  ])) return false;
  if (!["button", "text", "number", "choice"].includes(String(action.interactionKind)) || action.target !== "standardChat") return false;
  const expected = action.interactionKind === "button"
    ? "none"
    : action.interactionKind === "number" || (action.interactionKind === "choice" && isPlainRecord(action.ui) && action.ui.labelType === "number")
      ? "number"
      : "string";
  if (action.expectedResult !== expected || (action.speakerId !== null && !positiveSafeInteger(action.speakerId))) return false;
  const speakers = Array.isArray(snapshot.speakers) ? snapshot.speakers : [];
  if (action.speakerId !== null && !speakers.some((speaker) => isPlainRecord(speaker) && speaker.id === action.speakerId)) return false;
  if (action.interactionKind === "button" ? action.destinationTemporary !== null : !positiveSafeInteger(action.destinationTemporary)) return false;
  if (
    action.destinationTemporary !== null &&
    Array.isArray(snapshot.temporaries) &&
    snapshot.temporaries.some((temporary) => isPlainRecord(temporary) && temporary.id === action.destinationTemporary)
  ) return false;
  if (!validInteractionUiShape(action.interactionKind as "button" | "text" | "number" | "choice", action.ui)) return false;
  if (plan === undefined || !nonNegativeSafeInteger(action.owningInstruction)) return true;
  const instruction = plan.instructions[action.owningInstruction];
  if (
    instruction?.kind !== "interaction" ||
    instruction.interactionKind !== action.interactionKind ||
    instruction.expectedResult !== action.expectedResult ||
    instruction.destinationTemporary !== action.destinationTemporary ||
    instruction.target !== action.target
  ) return false;

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
  ) return false;
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
      !speakers.some((speaker) => isPlainRecord(speaker) && speaker.id === preparedSpeaker.speakerId) ||
      action.speakerId !== preparedSpeaker.speakerId
    ) return false;
  }
  return preparedInteractionUiMatchesAction(instruction.preparedUi, action.ui, snapshot.temporaries);
}

function runtimeTemporaryValue(temporaries: readonly unknown[], id: number): unknown {
  const temporary = temporaries.find((candidate) => isPlainRecord(candidate) && candidate.id === id);
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
  ) return false;
  if (prepared.kind === "button") {
    return runtimeTemporaryValue(temporaries, prepared.buttonLabelTemporary) === actual.buttonLabel;
  }
  if (prepared.kind === "text" || prepared.kind === "number") {
    const hint = prepared.hintTemporary === null ? null : runtimeTemporaryValue(temporaries, prepared.hintTemporary);
    return hint === actual.hint;
  }
  const raw = runtimeTemporaryValue(temporaries, prepared.optionsTemporary);
  if (!isPlainRecord(raw) || raw.kind !== "list" || !Array.isArray(raw.items) || raw.items.length !== prepared.optionCount) return false;
  if (!Array.isArray(actual.options) || actual.options.length !== prepared.optionCount || actual.labelType !== prepared.labelType) return false;
  const options = actual.options;
  const labels = prepared.labelType === "none" ? null : prepared.labels;
  return raw.items.every((text, index) => {
    const option = options[index];
    return typeof text === "string" && isPlainRecord(option) && option.text === text && option.label === (labels?.[index] ?? null);
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

function visibleRuntimeBindingValue(snapshot: Record<string, unknown>, name: string): unknown {
  if (!Array.isArray(snapshot.frames)) return undefined;
  const lastCall = Array.isArray(snapshot.callFrames) ? snapshot.callFrames.at(-1) : undefined;
  const functionBase = isPlainRecord(lastCall) && nonNegativeSafeInteger(lastCall.scopeBaseDepth)
    ? lastCall.scopeBaseDepth
    : undefined;
  const minimum = functionBase ?? 0;
  for (let index = snapshot.frames.length - 1; index >= minimum; index -= 1) {
    const frame = snapshot.frames[index];
    if (!isPlainRecord(frame) || !Array.isArray(frame.bindings)) continue;
    const binding = frame.bindings.find((candidate) => isPlainRecord(candidate) && candidate.name === name);
    if (isPlainRecord(binding)) return binding.value;
  }
  if (functionBase !== undefined) {
    const root = snapshot.frames[0];
    if (!isPlainRecord(root) || !Array.isArray(root.bindings)) return undefined;
    const binding = root.bindings.find((candidate) => isPlainRecord(candidate) && candidate.name === name);
    if (isPlainRecord(binding)) return binding.value;
  }
  return undefined;
}

function validInteractionUiShape(kind: "button" | "text" | "number" | "choice", value: unknown): boolean {
  if (!isPlainRecord(value) || value.kind !== kind || !isPlainRecord(value.accessibleName)) return false;
  const expectedUiKeys = kind === "button"
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
  const expectedKey = kind === "button" ? "continue" : kind === "number" ? "number" : kind === "choice" ? "chooseOption" : "answer";
  if (value.accessibleName.kind === "text") {
    if (!hasExactKeys(value.accessibleName, ["kind", "text"]) || !count(value.accessibleName.text) || measurementExhausted || !interactionStringHasNonWhitespace(value.accessibleName.text)) return false;
  } else if (!hasExactKeys(value.accessibleName, ["kind", "key"]) || value.accessibleName.kind !== "localizedDefault" || value.accessibleName.key !== expectedKey) return false;
  if (kind === "button") return count(value.buttonLabel) && !measurementExhausted;
  if (kind === "text" || kind === "number") return (value.hint === null || count(value.hint)) && !measurementExhausted;
  if (!Array.isArray(value.options) || value.options.length === 0 || value.options.length > MAX_INTERACTION_OPTION_ENTRIES || !["none", "identifier", "number"].includes(String(value.labelType))) return false;
  const labels = new Set<string | number>();
  const texts = new Set<string>();
  for (const option of value.options) {
    if (!isPlainRecord(option) || !hasExactKeys(option, ["text", "label"])) return false;
    const optionText = option.text;
    const textValid = count(optionText);
    if (!textValid && !measurementExhausted) return false;
    const label = option.label;
    const validLabel = value.labelType === "none"
      ? label === null
      : value.labelType === "identifier"
        ? typeof label === "string" && count(label) && (measurementExhausted || /^[A-Za-z_][A-Za-z0-9_]*$/u.test(label))
        : typeof label === "number" && Number.isFinite(label) && !Object.is(label, -0);
    if (!validLabel) return false;
    if (!measurementExhausted && label !== null && (typeof label === "string" || typeof label === "number")) {
      if (labels.has(label)) return false;
      labels.add(label);
    }
    if (!measurementExhausted && value.labelType === "none") {
      if (texts.has(optionText as string)) return false;
      texts.add(optionText as string);
    }
  }
  return !measurementExhausted;
}

function interactionUiEqual(expected: InteractionUiPayload, actual: unknown): boolean {
  if (!isPlainRecord(actual) || actual.kind !== expected.kind || !isPlainRecord(actual.accessibleName) || actual.accessibleName.kind !== expected.accessibleName.kind) return false;
  if (expected.accessibleName.kind === "text" ? actual.accessibleName.text !== expected.accessibleName.text : actual.accessibleName.key !== expected.accessibleName.key) return false;
  if (expected.kind === "button") return actual.buttonLabel === expected.buttonLabel;
  if (expected.kind === "text" || expected.kind === "number") return actual.hint === expected.hint;
  if (expected.kind !== "choice") return false;
  if (actual.labelType !== expected.labelType || !Array.isArray(actual.options) || actual.options.length !== expected.options.length) return false;
  const options = actual.options;
  return expected.options.every((option, index) => {
    const candidate = options[index];
    return isPlainRecord(candidate) && candidate.text === option.text && candidate.label === option.label;
  });
}

function validSettlementKindData(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  analysis: SnapshotValidationAnalysis | undefined,
): boolean {
  if (settlement.actionKind === "chatPacingGate") return validPacingGateSettlement(settlement, snapshot, plan);
  if (settlement.actionKind === "delay") {
    return hasExactKeys(settlement, [
      "actionId", "actionKind", "settlementKind", "owningInstruction",
      "continuationInstruction", "requestEventSequence", "completionEventSequence",
      "deadlineMs", "completedAtMs",
    ]) && validSettlementChronology(settlement, snapshot);
  }
  if (!hasExactKeys(settlement, [
    "actionId", "actionKind", "interactionKind", "settlementKind",
    "owningInstruction", "continuationInstruction", "ownerCallFrameId",
    "destinationTemporary", "requestEventSequence",
    "transcriptEventSequence", "completionEventSequence", "result",
    "transcriptText",
  ])) return false;
  if (!["button", "text", "number", "choice"].includes(String(settlement.interactionKind)) || typeof settlement.transcriptText !== "string" || !interactionStringFits(settlement.transcriptText) || !positiveSafeInteger(settlement.requestEventSequence) || !positiveSafeInteger(settlement.transcriptEventSequence) || !positiveSafeInteger(settlement.completionEventSequence) || settlement.requestEventSequence >= settlement.transcriptEventSequence || settlement.transcriptEventSequence >= settlement.completionEventSequence) return false;
  const settlementInstruction = plan !== undefined && nonNegativeSafeInteger(settlement.owningInstruction)
    ? plan.instructions[settlement.owningInstruction]
    : undefined;
  const numericChoice = settlementInstruction?.kind === "interaction" &&
    settlementInstruction.interactionKind === "choice" &&
    ("preparedUi" in settlementInstruction
      ? settlementInstruction.preparedUi.kind === "choice" && settlementInstruction.preparedUi.labelType === "number"
      : settlementInstruction.ui.kind === "choice" && settlementInstruction.ui.labelType === "number");
  const validNumberResult = typeof settlement.result === "number" && Number.isFinite(settlement.result) && !Object.is(settlement.result, -0);
  let resultValid: boolean;
  if (settlement.interactionKind === "button") resultValid = settlement.result === null;
  else if (settlement.interactionKind === "text") resultValid = typeof settlement.result === "string" && settlement.result === settlement.transcriptText;
  else if (settlement.interactionKind === "number" || numericChoice) resultValid = validNumberResult;
  else if (settlement.interactionKind === "choice" && plan === undefined) {
    resultValid = (typeof settlement.result === "string" && interactionStringFits(settlement.result)) || validNumberResult;
  } else resultValid = typeof settlement.result === "string" && interactionStringFits(settlement.result);
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
  ) return false;
  if (
    settlement.interactionKind === "text" &&
    (settlement.result !== settlement.transcriptText || settlement.transcriptText.includes("\r") || !interactionStringHasNonWhitespace(settlement.transcriptText))
  ) return false;
  if (settlement.interactionKind === "number") {
    if (
      typeof settlement.result !== "number" ||
      /[\r\n\u2028\u2029]/u.test(settlement.transcriptText) ||
      !/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u.test(settlement.transcriptText)
    ) return false;
    const parsed = Number(settlement.transcriptText);
    if (!Number.isFinite(parsed) || (Object.is(parsed, -0) ? 0 : parsed) !== settlement.result) return false;
  }

  if (plan === undefined || !nonNegativeSafeInteger(settlement.owningInstruction)) return true;
  const instruction = plan.instructions[settlement.owningInstruction];
  if (instruction?.kind !== "interaction" || instruction.interactionKind !== settlement.interactionKind) return false;
  if (
    settlement.destinationTemporary !== instruction.destinationTemporary ||
    !validInteractionSettlementOwner(settlement, snapshot, analysis)
  ) return false;
  if ("preparedUi" in instruction) {
    return preparedInteractionSettlementMatches(
      instruction.preparedUi,
      settlement.result,
      settlement.transcriptText,
      Array.isArray(snapshot.temporaries) ? snapshot.temporaries : [],
    );
  }
  if (instruction.ui.kind === "button") return settlement.transcriptText === instruction.ui.buttonLabel;
  if (instruction.ui.kind === "text") return settlement.result === settlement.transcriptText;
  if (instruction.ui.kind === "number") return true;
  if (instruction.ui.kind !== "choice") return false;
  return instruction.ui.options.some((option) => option.text === settlement.transcriptText && (option.label ?? option.text) === settlement.result);
}

function validPacingGateSettlement(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan?: InstructionPlan,
): boolean {
  if (!hasExactKeys(settlement, [
    "actionId", "actionKind", "settlementKind", "owningInstruction",
    "continuationInstruction", "requestEventSequence", "completionEventSequence",
    "deadlineMs", "completedAtMs", "releasedPreparedOutputInstruction",
  ])) return false;
  if (!validPacingSettlementKind(settlement.settlementKind)) return false;
  if (!validPacingSettlementReleaseLineage(settlement, plan)) return false;
  if (settlement.settlementKind === "completed") {
    return validSettlementChronology(settlement, snapshot);
  }
  return validNonTimePacingSettlementChronology(settlement, snapshot);
}

function validPacingSettlementKind(value: unknown): value is RuntimeChatPacingGateSettlementSnapshot["settlementKind"] {
  return value === "completed" ||
    value === "skipped" ||
    value === "consumedByForegroundInteraction" ||
    value === "supersededByInstantOutput";
}

function pacingSettlementCanReleasePreparedOutput(
  settlementKind: RuntimeChatPacingGateSettlementSnapshot["settlementKind"],
): boolean {
  return settlementKind === "completed" || settlementKind === "skipped";
}

function validPacingSettlementReleaseLineage(
  settlement: unknown,
  plan: InstructionPlan | undefined,
): settlement is Record<string, unknown> & { readonly releasedPreparedOutputInstruction: number | null } {
  if (!isPlainRecord(settlement)) return false;
  const releasedInstruction = settlement.releasedPreparedOutputInstruction;
  if (releasedInstruction === null) return true;
  return pacingSettlementCanReleasePreparedOutput(
    settlement.settlementKind as RuntimeChatPacingGateSettlementSnapshot["settlementKind"],
  ) &&
    nonNegativeSafeInteger(releasedInstruction) &&
    (plan === undefined || plan.instructions[releasedInstruction]?.kind === "say");
}

function validNonTimePacingSettlementChronology(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): boolean {
  return validSessionTime(settlement.deadlineMs) &&
    validSessionTime(settlement.completedAtMs) &&
    validSessionTime(snapshot.currentSessionTimeMs) &&
    settlement.completedAtMs < settlement.deadlineMs &&
    settlement.completedAtMs <= snapshot.currentSessionTimeMs;
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
  if (!isPlainRecord(raw) || raw.kind !== "list" || !Array.isArray(raw.items) || raw.items.length !== prepared.optionCount) return false;
  return raw.items.some((text, index) =>
    text === transcriptText && (labels?.[index] ?? text) === result
  );
}

function validInteractionSettlementOwner(
  settlement: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  analysis: SnapshotValidationAnalysis | undefined,
): boolean {
  if (
    analysis === undefined ||
    !nonNegativeSafeInteger(settlement.owningInstruction)
  ) return true;
  const ownerFunctionId =
    analysis.functionIdsByInstruction[settlement.owningInstruction] ?? null;
  if (ownerFunctionId === null) return settlement.ownerCallFrameId === null;
  if (!positiveSafeInteger(settlement.ownerCallFrameId)) return false;
  const callFrames = Array.isArray(snapshot.callFrames) ? snapshot.callFrames : [];
  const activeOwner = callFrames.find((frame) =>
    isPlainRecord(frame) && frame.id === settlement.ownerCallFrameId
  );
  return activeOwner === undefined ||
    (isPlainRecord(activeOwner) && activeOwner.functionId === ownerFunctionId);
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
    return typeof destination === "number" && typeof result === "number" && Object.is(destination, result);
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
  ) return false;
  if (plan === undefined) return true;
  if (owningInstruction >= plan.instructions.length) return false;
  const expectedKind = settlement.actionKind === "delay" ? "wait" : settlement.actionKind === "interaction" ? "interaction" : "say";
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
    return nonNegativeSafeInteger(owningInstruction) &&
      nonNegativeSafeInteger(continuationInstruction) &&
      owningInstruction < plan.instructions.length &&
      plan.instructions[owningInstruction]?.kind === "say";
  }
  if (
    !nonNegativeSafeInteger(owningInstruction) ||
    !nonNegativeSafeInteger(continuationInstruction) ||
    snapshot.nextInstruction !== owningInstruction ||
    owningInstruction >= plan.instructions.length ||
    continuationInstruction !== owningInstruction + 1 ||
    !["wait", "interaction", "say"].includes(plan.instructions[owningInstruction]?.kind ?? "")
  ) return false;

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

function isLegalHaltPosition(
  nextInstruction: unknown,
  plan: InstructionPlan,
): boolean {
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
      const active = Array.isArray(loopFrames)
        ? loopFrames.at(-1)
        : undefined;
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
    case "returnValue":
      collect(instruction.value);
      break;
    case "callFunction":
      instruction.arguments.forEach((argument) => output.add(argument.temporaryId));
      break;
    case "setDefaultSpeaker":
    case "prepareInteractionSpeaker":
    case "enterScope":
    case "leaveScope":
    case "jump":
    case "loopControl":
    case "clearTemporary":
    case "bindSuppliedParameter":
    case "beginFunctionDefaults":
    case "prepareParameterDefault":
    case "enterFunctionBody":
    case "returnVoid":
    case "exit":
      break;
    case "say":
      collect(instruction.value);
      break;
    case "wait":
      collect(instruction.duration);
      break;
    case "interaction":
      if ("preparedUi" in instruction) {
        output.add(instruction.speakerTemporary);
        if (instruction.preparedUi.kind === "button") output.add(instruction.preparedUi.buttonLabelTemporary);
        else if (instruction.preparedUi.kind === "text" || instruction.preparedUi.kind === "number") {
          if (instruction.preparedUi.hintTemporary !== null) output.add(instruction.preparedUi.hintTemporary);
        } else output.add(instruction.preparedUi.optionsTemporary);
      }
      break;
  }
  return output;
}

function collectExpressionTemporaries(
  expression: ExpressionPlan,
  output: Set<number>,
): void {
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
        collectExpressionTemporaries(property.value, output)
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
        collectExpressionTemporaries(argument.value, output)
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
    if (!isPlainRecord(frame) || !nonNegativeSafeInteger(frame.id) || !Array.isArray(frame.bindings)) {
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
      const failure = validateSerializableValue(binding.value);
      if (failure !== null) errors.push(failure);
    }
  }
  if (isPlainRecord(value[0]) && value[0].id !== 0) {
    errors.push("Runtime root scope frame must have ID 0.");
  }
}

function validateSpeakers(value: unknown, errors: string[]): Set<number> {
  const ids = new Set<number>();
  if (!Array.isArray(value)) {
    errors.push("Runtime speakers must be an array.");
    return ids;
  }
  for (const speaker of value) {
    if (
      !isPlainRecord(speaker) ||
      !nonNegativeSafeInteger(speaker.id) ||
      typeof speaker.identifier !== "string" ||
      speaker.identifier.length === 0 ||
      !Array.isArray(speaker.properties)
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
      const failure = validateSerializableValue(property.value);
      if (failure !== null) errors.push(failure);
      if (
        property.name === "defaultSaySkippable" &&
        typeof property.value !== "boolean"
      ) {
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
  if (!isPlainRecord(value)) return;
  if (value.kind === "speakerReference" && nonNegativeSafeInteger(value.speakerId)) {
    output.add(value.speakerId);
    return;
  }
  if (value.kind === "list" && Array.isArray(value.items)) {
    for (const item of value.items) collectSpeakerReferenceIds(item, output);
  } else if (value.kind === "object" && Array.isArray(value.properties)) {
    for (const property of value.properties) {
      if (isPlainRecord(property)) collectSpeakerReferenceIds(property.value, output);
    }
  }
}

function validSpan(value: unknown): value is SourceSpan {
  return (
    isPlainRecord(value) &&
    validPosition(value.start) &&
    validPosition(value.end) &&
    (value.end as { offset: number }).offset >= (value.start as { offset: number }).offset
  );
}

function validPosition(value: unknown): boolean {
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

function cloneTemporary(
  temporary: RuntimeTemporarySnapshot,
): RuntimeTemporarySnapshot {
  return {
    id: temporary.id,
    value: cloneSerializableValue(temporary.value),
  };
}

function nonNegativeSafeInteger(value: unknown): value is number {
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

function runtimeInputDataFailureMessage(
  kind: ExternalDataFailureKind,
  path: string,
): string {
  switch (kind) {
    case "depth":
      return EXTERNAL_DATA_DEPTH_MESSAGE;
    case "work":
      return EXTERNAL_DATA_WORK_MESSAGE;
    case "nonFiniteNumber":
      return `${path} must be a finite number.`;
    case "nonJsonSafeValue":
    case "nonPlainObject":
      return `${path} is not a JSON-safe runtime value.`;
    case "cycle":
      return `${path} contains a cyclic runtime value.`;
  }
}

function snapshotExternalDataFailureMessage(
  kind: ExternalDataFailureKind,
): string {
  switch (kind) {
    case "depth":
      return EXTERNAL_DATA_DEPTH_MESSAGE;
    case "work":
      return EXTERNAL_DATA_WORK_MESSAGE;
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
