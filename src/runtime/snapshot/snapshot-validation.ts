import { captureOrReuseInstructionPlan } from "../../plan/capture.js";
import { captureExternalData, type ExternalDataFailureKind } from "../../external-data-capture.js";
import {
  withFrozenTemporalCaptures,
  hasExactKeys,
  RUNTIME_SNAPSHOT_FORMAT,
  RUNTIME_SNAPSHOT_VERSION,
  nonNegativeSafeInteger,
  unsigned32,
  MAX_SUPPORTED_CALL_DEPTH,
  isCanonicalJsonArray,
  validSpan,
  positiveSafeInteger,
  isStoredFileReference,
  type RuntimeSnapshot,
  type CapturedRuntimeSnapshotResult,
  type SnapshotValidationResult,
  type ClassifiedSnapshotValidationResult,
  type RuntimeSnapshotValidationFailureKind,
} from "./state.js";
import { isPlainRecord } from "../values/plain-data.js";
import { temporalCapturesProblem } from "../host-data/temporal-captures.js";
import {
  snapshotValidationAnalysis,
  type SnapshotValidationAnalysis,
} from "./snapshot-validation-analysis.js";
import {
  referenceScopes,
  referenceScopesById,
  validatePreparedReferenceTemporaries,
  validatePreparedSayTemporaries,
} from "./prepared-temporary-validation.js";
import {
  validateTemporaries,
  validateCallFrames,
  validateLoopFrames,
  validateCurrentTemporaryRequirements,
  activeLoopIdOf,
  callContextOwner,
  keepContinuationRequirements,
  type ContinuationRequests,
} from "./frame-validation.js";
import { XORSHIFT32_ALGORITHM } from "../random/random.js";
import {
  serializedScopes,
  serializedTopContext,
  contextHoldsInstruction,
} from "../scopes/activation-validation.js";
import {
  validatePendingActionState,
  validateInteractionResultHandoffState,
} from "../actions/action-validation.js";
import { validateTimerState } from "../background/timer-validation.js";
import { validateMediaState } from "../background/media-validation.js";
import { validatePermanentButtonState } from "../background/permanent-button-validation.js";
import { validateCaptureState } from "../scopes/capture-validation.js";
import { validateScriptStorageEntries } from "../host-data/script-storage.js";
import { playerProfileProblem } from "../host-data/player-profile.js";
import { validateRandomControl } from "../random/random-control.js";
import { isOneOf } from "../../plan/validation-support.js";
import { isCameraPlacement } from "../../handle-rules.js";
import type { ChatPacingSettings } from "../../chat-pacing.js";
import { validateCapturedSerializableValue } from "../values/serializable-values.js";
import { startupDeclarations, type InstructionPlan } from "../../plan/model.js";
import { packagePathProblem } from "../../project-paths.js";
import { identityRootValues } from "./record-collection.js";
import { interactionStringFits } from "../../interaction-limits.js";
import { isCanonicalTagList } from "../../tags.js";

// Capturing a runtime snapshot from outside the engine and validating it: the order of every check, and the checks of
// the session-wide state: status, startup, globals, scopes, speakers, failure, messages, files, and images.

const RUNTIME_SNAPSHOT_KEYS = [
  "format",
  "version",
  "nextInstruction",
  "frames",
  "globals",
  "speakers",
  "defaultSpeaker",
  "contextualSpeaker",
  "rng",
  "warnedSpeakerIds",
  "loopFrames",
  "temporaries",
  "callFrames",
  "retainedScopes",
  "nextEventSequence",
  "nextScopeId",
  "nextSpeakerId",
  "nextCallFrameId",
  "currentSessionTimeMs",
  "observedSessionTimeMs",
  "chatPacingSettings",
  "temporalCaptures",
  "foregroundAction",
  "backgroundActions",
  "nextActionId",
  "lastSettlement",
  "interactionResultHandoff",
  "settledTimers",
  "nextTimerId",
  "pendingTimerHandlers",
  "stageImage",
  "capturedImages",
  "storedFiles",
  "scriptStorage",
  "scriptStoragePersistent",
  "settledMedia",
  "nextMediaId",
  "cameraView",
  "nextPermanentButtonId",
  "liveMessages",
  "debugMode",
  "playerProfile",
  "randomControl",
  "maxCallDepth",
  "status",
  "failure",
] as const;

export function cloneRuntimeSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  const captured = captureRuntimeSnapshot(snapshot);
  if (!captured.validation.valid || captured.snapshot === null) {
    throw new TypeError(captured.validation.errors[0] ?? "Malformed runtime snapshot.");
  }
  return captured.snapshot;
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
  // EVIDENCE: validation: the preceding snapshot validation accepts this captured graph before it is returned.
  const captured = classified.validation.valid ? (snapshotCapture.value as RuntimeSnapshot) : null;
  return Object.freeze({
    validation: classified.validation,
    snapshot: captured === null ? null : withFrozenTemporalCaptures(captured),
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
    errors.push("Unsupported runtime-snapshot revision.");
  }
  if (!validChatPacingSettings(value.chatPacingSettings)) {
    errors.push("Runtime chatPacingSettings is malformed.");
  }
  const temporalProblem = temporalCapturesProblem(
    value.temporalCaptures,
    typeof value.currentSessionTimeMs === "number" ? value.currentSessionTimeMs : Number.NaN,
    typeof value.observedSessionTimeMs === "number" ? value.observedSessionTimeMs : Number.NaN,
    typeof value.nextEventSequence === "number" ? value.nextEventSequence : Number.NaN,
  );
  if (temporalProblem !== null)
    errors.push(`Runtime temporalCaptures is malformed: ${temporalProblem}`);
  const analysis = plan === undefined ? undefined : snapshotValidationAnalysis(plan);
  const continuationRequests: ContinuationRequests = { graphs: new Map(), required: new Map() };
  // Every region ends in a transfer, so a position is always an instruction of the runnable plan.
  if (
    !nonNegativeSafeInteger(value.nextInstruction) ||
    (plan !== undefined && plan.instructions[value.nextInstruction] === undefined)
  ) {
    errors.push("Runtime nextInstruction is outside the plan.");
  }
  validateScopes(value.frames, value.retainedScopes, analysis, errors);
  validateRootPlacement(value.frames, value.callFrames, errors);
  const speakerIds = validateSpeakers(value.speakers, errors);
  validateGlobals(value, plan, errors);
  validateStartupPhase(value, plan, errors);
  const scopes = referenceScopes(value);
  const scopesById = referenceScopesById(scopes);
  const preparedReferenceTemporaries = analysis?.preparedReferenceTemporaries;
  const preparedSayTemporaryOwnership = analysis?.preparedSayTemporaryOwnership;
  validateTemporaries(value.temporaries, plan, "Runtime temporaries", errors);
  validatePreparedReferenceTemporaries(
    value.temporaries,
    scopesById,
    value.speakers,
    preparedReferenceTemporaries,
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
    continuationRequests,
    scopesById,
    preparedReferenceTemporaries,
    preparedSayTemporaryOwnership,
    value,
    errors,
  );
  const handleIds = validateSpeakerReferences(
    scopes,
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
    analysis,
    value,
    errors,
  );
  validateCurrentTemporaryRequirements(
    value.temporaries,
    activeLoopIdOf(value.loopFrames, callContextOwner(value.callFrames, Infinity)),
    value.nextInstruction,
    value.status,
    value.status === "waiting" &&
      isPlainRecord(value.foregroundAction) &&
      value.foregroundAction.kind === "chatPacingGate",
    plan,
    errors,
  );
  if (!nonNegativeSafeInteger(value.nextEventSequence) || value.nextEventSequence < 1) {
    errors.push("Runtime nextEventSequence must be a positive safe integer.");
  }
  const frameIds = serializedScopes(value)
    .filter(isPlainRecord)
    .map((frame) => frame.id)
    .filter(nonNegativeSafeInteger);
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
  validatePendingActionState(value, plan, errors);
  validateTimerState(value, plan, handleIds.timer, errors);
  validateMediaState(value, plan, handleIds.media, errors);
  validateCameraView(value, handleIds.camera, errors);
  validatePermanentButtonState(value, plan, handleIds.permanentButton, errors);
  validateLiveMessages(value.liveMessages, value.nextEventSequence, handleIds.message, errors);
  validateCaptureState(value, analysis, errors);
  if (value.stageImage !== null && typeof value.stageImage !== "string") {
    errors.push("Runtime stageImage must be a string or null.");
  }
  if (!validCapturedImages(value.capturedImages)) {
    errors.push(
      "Runtime capturedImages must list unique captured references, each with canonical tags in name order.",
    );
  }
  if (!validStoredFiles(value.storedFiles)) {
    errors.push(
      "Runtime storedFiles must list stored file references in ascending order, each once.",
    );
  }
  const scriptStorageFailure = validateScriptStorageEntries(
    value.scriptStorage,
    "Runtime scriptStorage",
    true,
  );
  if (scriptStorageFailure !== null) errors.push(scriptStorageFailure);
  if (typeof value.scriptStoragePersistent !== "boolean") {
    errors.push("Runtime scriptStoragePersistent must be a boolean.");
  }
  if (typeof value.debugMode !== "boolean") errors.push("Runtime debugMode must be a boolean.");
  const playerProfileFailure = playerProfileProblem(value.playerProfile);
  if (playerProfileFailure !== null) errors.push(playerProfileFailure);
  validateRandomControl(value.randomControl, value, plan, errors);
  validateInteractionResultHandoffState(value, plan, errors);
  if (!isOneOf(value.status, ["ready", "running", "waiting", "halted", "failed"])) {
    errors.push("Runtime status is invalid.");
  }
  validateFailure(value.failure, value.status, plan, errors);
  validateStatusConsistency(value, plan, errors);
  const validation = Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
  if (validation.valid && analysis !== undefined) {
    keepContinuationRequirements(analysis, continuationRequests);
  }
  return Object.freeze({ validation, failureKind: validation.valid ? null : failureKind });
}

/**
 * The camera view is `null` or `{ placement, shown }`; a camera view handle needs the view, and a halted session shows
 * no camera.
 */
function validateCameraView(
  snapshot: Record<string, unknown>,
  handleReferenced: boolean,
  errors: string[],
): void {
  const view = snapshot.cameraView;
  if (view === null) {
    if (handleReferenced) errors.push("Runtime camera view handle refers to no camera view.");
    return;
  }
  if (
    !isPlainRecord(view) ||
    !hasExactKeys(view, ["placement", "shown"]) ||
    !isCameraPlacement(view.placement) ||
    typeof view.shown !== "boolean"
  ) {
    errors.push("Runtime cameraView is malformed.");
    return;
  }
  if (view.shown && snapshot.status === "halted")
    errors.push("A halted runtime session cannot show a camera view.");
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
  const retained = Array.isArray(value.retainedScopes) ? value.retainedScopes.length : 0;
  if (value.contextualSpeaker !== null) {
    errors.push("Runtime contextual speaker must be cleared between instructions.");
  }
  const action = value.foregroundAction;
  if (value.status === "waiting") {
    const hasForegroundAction = isPlainRecord(action);
    const hasAllowedActionKind =
      hasForegroundAction &&
      isOneOf(action.kind, [
        "delay",
        "interaction",
        "chatPacingGate",
        "mediaPlayback",
        "storageWrite",
        "capture",
        "fileStore",
        "lock",
      ]);
    if (!hasAllowedActionKind) {
      errors.push("Waiting runtime state requires one foreground action.");
    }
  } else if (action !== null) {
    errors.push("Non-waiting runtime state must not contain a foreground action.");
  }
  // Code runs in a context of the top of the call stack: a function's position is validated with its frame, a root
  // region's here. After exit, the position follows the exit wherever it stood.
  const context = serializedTopContext(value);
  if (
    plan !== undefined &&
    value.status !== "halted" &&
    context !== undefined &&
    context.functionId === null &&
    (!nonNegativeSafeInteger(value.nextInstruction) ||
      !contextHoldsInstruction(plan, context, value.nextInstruction))
  ) {
    errors.push("Root execution position is outside the root instruction range.");
  }
  if (value.status === "ready") {
    if (
      value.nextInstruction !== 0 ||
      calls !== 0 ||
      loops !== 0 ||
      temporaries !== 0 ||
      scopes !== 1 ||
      (Array.isArray(value.frames) &&
        isPlainRecord(value.frames[0]) &&
        value.frames[0].file !== 0) ||
      retained !== 0 ||
      value.failure !== null ||
      // A session that has not started has taken no photos.
      !(Array.isArray(value.capturedImages) && value.capturedImages.length === 0)
    ) {
      errors.push("Ready runtime state contains execution progress.");
    }
    if (
      isPlainRecord(value.lastSettlement) &&
      value.lastSettlement.actionKind === "chatPacingGate"
    ) {
      errors.push("Ready runtime state must not contain pacing execution state.");
    }
  } else if (value.status === "halted") {
    if (
      calls !== 0 ||
      loops !== 0 ||
      temporaries !== 0 ||
      scopes !== 1 ||
      retained !== 0 ||
      value.failure !== null
    ) {
      errors.push("Halted runtime state retains active execution state.");
    }
    if (plan !== undefined && !isLegalHaltPosition(value.nextInstruction, plan)) {
      errors.push("Halted runtime state is not at a legal halt position.");
    }
    if (
      Array.isArray(value.backgroundActions) &&
      value.backgroundActions.some((action) => isPlainRecord(action) && action.kind === "timer")
    ) {
      errors.push("Halted runtime state must not retain active timers.");
    }
  } else if (value.status === "running") {
    if (value.failure !== null) errors.push("Running runtime state contains failure information.");
  }
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

function isLegalHaltPosition(nextInstruction: unknown, plan: InstructionPlan): boolean {
  if (!nonNegativeSafeInteger(nextInstruction)) return false;
  return nextInstruction > 0 && plan.instructions[nextInstruction - 1]?.kind === "exit";
}

/**
 * The session's globals: the host's, then those that the start of `main.tease` set up so far, in its order (ADR 0022
 * §6). While it runs, exactly the globals and speakers before the next instruction are set up; after it, all of them. A
 * speaker's global refers to the speaker of its name, and the speaker registry holds exactly these speakers. No scope
 * binding has the name of a global.
 */
function validateGlobals(
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  const globals = snapshot.globals;
  if (!Array.isArray(globals)) {
    errors.push("Runtime globals must be an array.");
    return;
  }
  const names: string[] = [];
  const values: unknown[] = [];
  const globalNames = new Set<string>();
  for (const binding of globals) {
    if (!isPlainRecord(binding) || typeof binding.name !== "string" || binding.name.length === 0) {
      errors.push("Runtime global is malformed.");
      return;
    }
    if (globalNames.has(binding.name)) errors.push("Runtime globals contain a duplicate name.");
    globalNames.add(binding.name);
    names.push(binding.name);
    values.push(binding.value);
    const failure = validateCapturedSerializableValue(binding.value);
    if (failure !== null) errors.push(failure);
  }
  // No scope binds a global's name, also not a root retained for a block.
  if (
    serializedScopes(snapshot).some(
      (frame) =>
        isPlainRecord(frame) &&
        Array.isArray(frame.bindings) &&
        frame.bindings.some(
          (binding) =>
            isPlainRecord(binding) &&
            typeof binding.name === "string" &&
            globalNames.has(binding.name),
        ),
    )
  )
    errors.push("Runtime scope binding has the name of a global.");
  if (plan === undefined) return;
  const declarations = startupDeclarations(plan);
  const setUp =
    nonNegativeSafeInteger(snapshot.nextInstruction) &&
    snapshot.nextInstruction < declarations.length
      ? snapshot.nextInstruction
      : declarations.length;
  const host = globals.length - setUp;
  const scriptNames = new Set(declarations.map((declaration) => declaration.name));
  const speakers = Array.isArray(snapshot.speakers) ? snapshot.speakers : [];
  let speakerIndex = 0;
  const matches = (declaration: (typeof declarations)[number], index: number): boolean => {
    if (names[host + index] !== declaration.name) return false;
    if (declaration.kind !== "declareSpeaker") return true;
    const speaker = speakers[speakerIndex];
    speakerIndex += 1;
    const value = values[host + index];
    return (
      isPlainRecord(speaker) &&
      speaker.identifier === declaration.name &&
      isPlainRecord(value) &&
      value.kind === "speakerReference" &&
      value.speakerId === speaker.id &&
      value.identifier === declaration.name
    );
  };
  if (
    host < 0 ||
    names.slice(0, host).some((name) => scriptNames.has(name)) ||
    !declarations.slice(0, setUp).every(matches) ||
    speakers.length !== speakerIndex
  )
    errors.push("Runtime globals do not match those the plan sets up before the next instruction.");
}

/** The parts of a snapshot that hold work or saved instruction positions, in fields named `...Instruction`. */
const POSITION_HOLDERS = [
  "callFrames",
  "foregroundAction",
  "backgroundActions",
  "lastSettlement",
  "interactionResultHandoff",
  "settledTimers",
  "settledMedia",
  "pendingTimerHandlers",
] as const;

/**
 * The start of `main.tease` sets up the globals and speakers once, before anything else runs (ADR 0022 §6). While the
 * next instruction is in it, a session holds nothing but the globals and speakers set up so far: no call, loop,
 * temporary, action, timer, media, queued block, permanent button, settlement, top-level variable,
 * default speaker, or Stage image, and no identity of those was ever allocated. Afterwards no saved position leads back
 * into it.
 */
function validateStartupPhase(
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  if (plan === undefined) return;
  const prefixEnd = startupDeclarations(plan).length;
  if (prefixEnd === 0) return;
  if (nonNegativeSafeInteger(snapshot.nextInstruction) && snapshot.nextInstruction < prefixEnd) {
    const empty = (value: unknown): boolean =>
      value === null || (Array.isArray(value) && value.length === 0);
    const frames = snapshot.frames;
    if (
      !isOneOf(snapshot.status, ["ready", "running", "failed"]) ||
      !POSITION_HOLDERS.every((field) => empty(snapshot[field])) ||
      !empty(snapshot.loopFrames) ||
      !empty(snapshot.temporaries) ||
      !Array.isArray(frames) ||
      frames.length !== 1 ||
      !isPlainRecord(frames[0]) ||
      !empty(frames[0].bindings) ||
      snapshot.defaultSpeaker !== null ||
      snapshot.stageImage !== null ||
      snapshot.cameraView !== null ||
      !empty(snapshot.capturedImages) ||
      !empty(snapshot.liveMessages) ||
      [
        snapshot.nextScopeId,
        snapshot.nextCallFrameId,
        snapshot.nextActionId,
        snapshot.nextTimerId,
        snapshot.nextMediaId,
        snapshot.nextPermanentButtonId,
      ].some((counter) => counter !== 1)
    )
      errors.push(
        "Runtime state within the startup holds more than the globals and speakers set up.",
      );
    return;
  }
  const work: unknown[] = POSITION_HOLDERS.map((field) => snapshot[field]);
  while (work.length > 0) {
    const node = work.pop();
    if (Array.isArray(node)) {
      for (const item of node) work.push(item);
      continue;
    }
    if (!isPlainRecord(node)) continue;
    for (const [key, nested] of Object.entries(node)) {
      if (key.endsWith("Instruction") && typeof nested === "number" && nested < prefixEnd) {
        errors.push("Runtime state saves a position within the startup, which runs only once.");
        return;
      }
      work.push(nested);
    }
  }
}

/**
 * Scope frames on the stack, then the retained scopes: roots of activations the session has left and scopes whose
 * variables blocks share, which capture validation checks.
 */
function validateScopes(
  frames: unknown,
  retainedScopes: unknown,
  analysis: SnapshotValidationAnalysis | undefined,
  errors: string[],
): void {
  if (!Array.isArray(frames) || frames.length === 0) {
    errors.push("Runtime frames must be a non-empty array.");
    return;
  }
  if (!isCanonicalJsonArray(retainedScopes)) {
    errors.push("Runtime retainedScopes must be an array.");
    return;
  }
  const frameIds = new Set<number>();
  for (const frame of [...frames, ...retainedScopes]) {
    if (
      !isPlainRecord(frame) ||
      !hasExactKeys(
        frame,
        Object.hasOwn(frame, "shared")
          ? ["id", "file", "entry", "bindings", "shared"]
          : ["id", "file", "entry", "bindings"],
      ) ||
      (Object.hasOwn(frame, "shared") && (frame.shared !== true || frame.file !== null)) ||
      !nonNegativeSafeInteger(frame.id) ||
      !Array.isArray(frame.bindings) ||
      (frame.file === null
        ? frame.entry !== null
        : !nonNegativeSafeInteger(frame.file) ||
          !nonNegativeSafeInteger(frame.entry) ||
          (analysis !== undefined && !isFileEntry(analysis, frame.file, frame.entry)))
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
}

/** Whether an activation of a file may start at an instruction: only at the file's entry, its top (V30 §29). */
function isFileEntry(analysis: SnapshotValidationAnalysis, file: number, entry: number): boolean {
  return analysis.plan.files[file]?.entryInstruction === entry;
}

/** An activation's root stands at the bottom of the stack and above each file call; no other scope is a root. */
function validateRootPlacement(frames: unknown, callFrames: unknown, errors: string[]): void {
  if (!Array.isArray(frames) || !Array.isArray(callFrames)) return;
  const rootDepths = new Set([0]);
  for (const frame of callFrames) {
    if (
      isPlainRecord(frame) &&
      frame.kind === "file" &&
      nonNegativeSafeInteger(frame.scopeBaseDepth)
    )
      rootDepths.add(frame.scopeBaseDepth);
  }
  if (
    frames.some(
      (frame, depth) => isPlainRecord(frame) && (frame.file !== null) !== rootDepths.has(depth),
    )
  ) {
    errors.push("Runtime activation roots are out of place.");
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

function validateFailure(
  value: unknown,
  status: unknown,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  if (value === null) {
    if (status === "failed") errors.push("Failed runtime status requires failure information.");
    return;
  }
  if (
    !isPlainRecord(value) ||
    typeof value.code !== "string" ||
    typeof value.message !== "string" ||
    typeof value.path !== "string" ||
    (plan === undefined
      ? packagePathProblem(value.path) !== null
      : !plan.files.some((file) => file.path === value.path)) ||
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
): RuntimeIdentityIds {
  const referencedIds = new Set<number>();
  const handleIds = emptyIdentityIds();
  for (const value of identityRootValues(frames, speakers, loopFrames, temporaries, callFrames))
    collectSpeakerReferenceIds(value, referencedIds, handleIds);
  for (const id of referencedIds) {
    if (!speakerIds.has(id)) {
      errors.push("Runtime value refers to an unknown speaker ID.");
      break;
    }
  }
  return handleIds;
}

/** The engine-owned resources that values of a state refer to, by kind. */
interface RuntimeIdentityIds {
  readonly timer: Set<number>;
  readonly media: Set<number>;
  readonly permanentButton: Set<number>;
  readonly message: Set<number>;
  camera: boolean;
}

function emptyIdentityIds(): RuntimeIdentityIds {
  return {
    timer: new Set(),
    media: new Set(),
    permanentButton: new Set(),
    message: new Set(),
    camera: false,
  };
}

/**
 * The live message records: unique positive IDs of `say` events already emitted, in ascending order, each with its
 * markup source and, once removed, `removed: true`. Every message handle the state holds has one; a record no handle
 * reaches is harmless and is dropped by the next public operation.
 */
function validateLiveMessages(
  value: unknown,
  nextEventSequence: unknown,
  referenced: ReadonlySet<number>,
  errors: string[],
): void {
  if (!isCanonicalJsonArray(value)) {
    errors.push("Runtime liveMessages must be an array.");
    return;
  }
  const ids = new Set<number>();
  let previous = 0;
  for (const message of value) {
    if (
      !isPlainRecord(message) ||
      !(
        hasExactKeys(message, ["messageId", "sourceText"]) ||
        (hasExactKeys(message, ["messageId", "sourceText", "removed"]) && message.removed === true)
      ) ||
      !positiveSafeInteger(message.messageId) ||
      message.messageId <= previous ||
      typeof nextEventSequence !== "number" ||
      message.messageId >= nextEventSequence ||
      typeof message.sourceText !== "string"
    ) {
      errors.push(
        "Runtime liveMessages must list emitted message IDs once each in ascending order, each with its text and, once removed, removed: true.",
      );
      return;
    }
    previous = message.messageId;
    ids.add(message.messageId);
  }
  for (const id of referenced) {
    if (!ids.has(id)) {
      errors.push("Runtime value refers to a message that has no live record.");
      return;
    }
  }
}

/**
 * Collects speaker references and, in the same traversal, timer, media, message, and permanent button IDs and camera
 * view handles.
 */
function collectSpeakerReferenceIds(
  value: unknown,
  output: Set<number>,
  handleIds: RuntimeIdentityIds,
): void {
  const work: unknown[] = [value];
  while (work.length > 0) {
    const current = work.pop();
    if (!isPlainRecord(current)) continue;
    if (current.kind === "speakerReference" && nonNegativeSafeInteger(current.speakerId)) {
      output.add(current.speakerId);
      continue;
    }
    if (current.kind === "timerHandle" && nonNegativeSafeInteger(current.timerId)) {
      handleIds.timer.add(current.timerId);
      continue;
    }
    if (current.kind === "mediaHandle" && nonNegativeSafeInteger(current.mediaId)) {
      handleIds.media.add(current.mediaId);
      continue;
    }
    if (current.kind === "permanentButtonHandle" && nonNegativeSafeInteger(current.buttonId)) {
      handleIds.permanentButton.add(current.buttonId);
      continue;
    }
    if (current.kind === "messageHandle" && nonNegativeSafeInteger(current.messageId)) {
      handleIds.message.add(current.messageId);
      continue;
    }
    if (current.kind === "cameraView") {
      handleIds.camera = true;
      continue;
    }
    if ((current.kind === "list" || current.kind === "set") && Array.isArray(current.items)) {
      for (let index = current.items.length - 1; index >= 0; index -= 1) {
        work.push(current.items[index]);
      }
    } else if (current.kind === "object" && Array.isArray(current.properties)) {
      for (let index = current.properties.length - 1; index >= 0; index -= 1) {
        const property = current.properties[index];
        if (isPlainRecord(property)) work.push(property.value);
      }
    } else if (current.kind === "dict" && Array.isArray(current.entries)) {
      for (let index = current.entries.length - 1; index >= 0; index -= 1) {
        const entry = current.entries[index];
        if (isPlainRecord(entry)) work.push(entry.value);
      }
    }
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

function validStoredFiles(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  let previous: string | null = null;
  for (const reference of value) {
    if (!isStoredFileReference(reference) || (previous !== null && previous >= reference))
      return false;
    previous = reference;
  }
  return true;
}

/** Captured references are unique, non-empty, and fit an interaction string; each carries canonical tags. */
function validCapturedImages(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const references = new Set<string>();
  return value.every((image: unknown) => {
    if (
      !isPlainRecord(image) ||
      !hasExactKeys(image, ["reference", "tags"]) ||
      typeof image.reference !== "string" ||
      image.reference.length === 0 ||
      !interactionStringFits(image.reference) ||
      references.has(image.reference) ||
      !isCanonicalTagList(image.tags)
    )
      return false;
    references.add(image.reference);
    return true;
  });
}
