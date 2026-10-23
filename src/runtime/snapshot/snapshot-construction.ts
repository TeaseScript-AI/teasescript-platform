import { captureOrReuseInstructionPlan } from "../../plan/capture.js";
import { captureExternalData, type ExternalDataFailureKind } from "../../external-data-capture.js";
import { isPlainRecord } from "../values/plain-data.js";
import {
  startupDeclarations,
  type InstructionPlan,
  type InteractionUiPayload,
} from "../../plan/model.js";
import {
  DEFAULT_TEMPORAL_CONTEXT,
  temporalContextProblem,
  frozenTemporalContext,
  isValidEpochMilliseconds,
  type TemporalContext,
} from "../../temporal.js";
import {
  validSessionTime,
  MAX_RUNTIME_SESSION_TIME_MS,
  DEFAULT_MAX_CALL_DEPTH,
  MAX_SUPPORTED_CALL_DEPTH,
  isStoredFileReference,
  RUNTIME_SNAPSHOT_FORMAT,
  RUNTIME_SNAPSHOT_VERSION,
  type FreshRuntimeOptions,
  type RuntimeSnapshot,
  type RuntimeBindingSnapshot,
  type RuntimeForLoopFrameSnapshot,
  type RuntimeScopeFrameSnapshot,
  type RuntimeCallFrameSnapshot,
  type RuntimeTimerInterruptionSnapshot,
  type RuntimeInteractionResultHandoffSnapshot,
  type RuntimeTemporarySnapshot,
  type RuntimeCapturedImageSnapshot,
} from "./state.js";
import {
  validateScriptStorageEntries,
  sortScriptStorage,
  cloneScriptStorage,
  type RuntimeScriptStorageEntrySnapshot,
} from "../host-data/script-storage.js";
import { playerProfileFromInput, clonePlayerProfile } from "../host-data/player-profile.js";
import { addStoredFiles } from "../host-data/stored-files.js";
import {
  validateCapturedSerializableValue,
  containsRuntimeIdentity,
  cloneCapturedSerializableValue,
  type SerializableRuntimeValue,
} from "../values/serializable-values.js";
import {
  createXorShift32State,
  DEFAULT_PLAYGROUND_SEED,
  XORSHIFT32_ALGORITHM,
} from "../random/random.js";
import { frozenTemporalCaptures } from "../host-data/temporal-captures.js";
import { cloneCaptures } from "../scopes/captures.js";
import { cloneRandomControl } from "../random/random-control.js";
import { cloneInteractionResult, cloneInteractionChoiceValue } from "../../choice-values.js";
import type {
  RuntimeForegroundActionSnapshot,
  RuntimePendingActionSnapshot,
  RuntimeActionSettlementSnapshot,
} from "../actions/model.js";
import { cloneTimer } from "../background/timers.js";
import { cloneMedia } from "../background/media.js";
import { cloneFormState, cloneFormUi } from "../actions/form.js";
import { cloneImageUi } from "../actions/interaction.js";
import { DEFAULT_CHAT_PACING_SETTINGS, type ChatPacingSettings } from "../../chat-pacing.js";
import { createSourceSpan, type SourceSpan } from "../../source.js";
// Building runtime snapshots: a fresh one for a plan, and the deep copy of a captured one.

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
  const hostGlobals: RuntimeBindingSnapshot[] = [];
  const scriptGlobals = new Set(startupDeclarations(plan).map((declaration) => declaration.name));
  const maxCallDepthValue = capturedOptions.maxCallDepth;
  const initialSessionTimeMs = capturedOptions.initialSessionTimeMs ?? 0;
  const chatPacingSettings = captureChatPacingSettings(capturedOptions);
  let temporalContext = DEFAULT_TEMPORAL_CONTEXT;
  if (capturedOptions.temporalContext !== undefined) {
    const problem = temporalContextProblem(capturedOptions.temporalContext);
    if (problem !== null) throw new RangeError(`temporalContext is malformed: ${problem}`);
    // EVIDENCE: validation: temporalContextProblem accepted the captured option.
    temporalContext = frozenTemporalContext(capturedOptions.temporalContext as TemporalContext);
  }
  const wallClockMs = capturedOptions.wallClockMs ?? null;
  if (
    wallClockMs !== null &&
    (typeof wallClockMs !== "number" || !isValidEpochMilliseconds(wallClockMs))
  )
    throw new RangeError("wallClockMs must be whole epoch milliseconds in the years 0000 to 9999.");
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
  const scriptStorage =
    capturedOptions.scriptStorage === undefined ? [] : capturedOptions.scriptStorage;
  const scriptStorageFailure = validateScriptStorageEntries(scriptStorage, "scriptStorage");
  if (scriptStorageFailure !== null) throw new TypeError(scriptStorageFailure);
  const persistentScriptStorage =
    capturedOptions.persistentScriptStorage === undefined
      ? false
      : capturedOptions.persistentScriptStorage;
  if (typeof persistentScriptStorage !== "boolean") {
    throw new TypeError("persistentScriptStorage must be a boolean.");
  }
  const debugMode = capturedOptions.debugMode === undefined ? false : capturedOptions.debugMode;
  if (typeof debugMode !== "boolean") throw new TypeError("debugMode must be a boolean.");
  const playerProfile = playerProfileFromInput(capturedOptions.playerProfile);
  const storedFiles = capturedOptions.storedFiles === undefined ? [] : capturedOptions.storedFiles;
  if (!Array.isArray(storedFiles) || !storedFiles.every(isStoredFileReference))
    throw new TypeError("storedFiles must be a list of stored file references.");
  const knownFiles: string[] = [];
  // EVIDENCE: validation: every entry passed isStoredFileReference above.
  addStoredFiles(knownFiles, storedFiles as string[]);
  for (const [name, value] of Object.entries(globals)) {
    if (name.length === 0) throw new TypeError("Global binding names must not be empty.");
    if (scriptGlobals.has(name))
      throw new TypeError(`globals.${name} has the name of a global or speaker of the script.`);
    const failure = validateCapturedSerializableValue(value, `globals.${name}`);
    if (failure !== null) throw new TypeError(failure);
    // EVIDENCE: validation: validateCapturedSerializableValue accepted this captured global value above.
    const valid = value as SerializableRuntimeValue;
    if (containsRuntimeIdentity(valid)) {
      throw new TypeError(
        `globals.${name} contains a timer, media, or message handle or a speaker reference, which only the runtime creates.`,
      );
    }
    hostGlobals.push({ name, value: valid });
  }
  return {
    format: RUNTIME_SNAPSHOT_FORMAT,
    version: RUNTIME_SNAPSHOT_VERSION,
    nextInstruction: 0,
    frames: [{ id: 0, file: 0, entry: plan.files[0]!.entryInstruction, bindings: [] }],
    globals: hostGlobals,
    retainedScopes: [],
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
    observedSessionTimeMs: initialSessionTimeMs,
    chatPacingSettings,
    temporalCaptures: [
      {
        boundaryMs: initialSessionTimeMs,
        sinceEventSequence: 0,
        epochMs: wallClockMs,
        context: temporalContext,
      },
    ],
    foregroundAction: null,
    backgroundActions: [],
    nextActionId: 1,
    lastSettlement: null,
    interactionResultHandoff: null,
    settledTimers: [],
    nextTimerId: 1,
    pendingTimerHandlers: [],
    stageImage: null,
    capturedImages: [],
    storedFiles: knownFiles,
    // EVIDENCE: validation: validateScriptStorageEntries accepted these captured entries above.
    scriptStorage: sortScriptStorage(scriptStorage as RuntimeScriptStorageEntrySnapshot[]),
    scriptStoragePersistent: persistentScriptStorage,
    settledMedia: [],
    nextMediaId: 1,
    cameraView: null,
    nextPermanentButtonId: 1,
    liveMessages: [],
    debugMode,
    playerProfile,
    randomControl: null,
    maxCallDepth,
    status: "ready",
    failure: null,
  };
}

/**
 * Clone already-captured and validated runtime state.
 */
export function cloneCapturedRuntimeSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return {
    format: RUNTIME_SNAPSHOT_FORMAT,
    version: RUNTIME_SNAPSHOT_VERSION,
    nextInstruction: snapshot.nextInstruction,
    frames: snapshot.frames.map(cloneScopeFrame),
    globals: snapshot.globals.map(cloneBinding),
    retainedScopes: snapshot.retainedScopes.map(cloneScopeFrame),
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
    callFrames: snapshot.callFrames.map((frame) =>
      frame.kind === "file"
        ? {
            kind: "file",
            id: frame.id,
            callSiteSpan: copySpan(frame.callSiteSpan),
            returnInstruction: frame.returnInstruction,
            callerTemporaries: frame.callerTemporaries.map(cloneTemporary),
            scopeBaseDepth: frame.scopeBaseDepth,
            loopBaseDepth: frame.loopBaseDepth,
          }
        : cloneFunctionFrame(frame),
    ),
    nextEventSequence: snapshot.nextEventSequence,
    nextScopeId: snapshot.nextScopeId,
    nextSpeakerId: snapshot.nextSpeakerId,
    nextCallFrameId: snapshot.nextCallFrameId,
    currentSessionTimeMs: snapshot.currentSessionTimeMs,
    observedSessionTimeMs: snapshot.observedSessionTimeMs,
    chatPacingSettings: cloneChatPacingSettings(snapshot.chatPacingSettings),
    temporalCaptures: frozenTemporalCaptures(snapshot.temporalCaptures),
    foregroundAction:
      snapshot.foregroundAction === null ? null : cloneForegroundAction(snapshot.foregroundAction),
    backgroundActions: snapshot.backgroundActions.map(clonePendingAction),
    nextActionId: snapshot.nextActionId,
    lastSettlement:
      snapshot.lastSettlement === null ? null : cloneSettlement(snapshot.lastSettlement),
    interactionResultHandoff:
      snapshot.interactionResultHandoff === null
        ? null
        : cloneInteractionResultHandoff(snapshot.interactionResultHandoff),
    settledTimers: snapshot.settledTimers.map((timer) => ({ ...timer })),
    nextTimerId: snapshot.nextTimerId,
    pendingTimerHandlers: snapshot.pendingTimerHandlers.map((invocation) => ({
      ...invocation,
      captures: cloneCaptures(invocation.captures),
    })),
    stageImage: snapshot.stageImage,
    capturedImages: snapshot.capturedImages.map(cloneCapturedImage),
    storedFiles: [...snapshot.storedFiles],
    scriptStorage: cloneScriptStorage(snapshot.scriptStorage),
    scriptStoragePersistent: snapshot.scriptStoragePersistent,
    settledMedia: snapshot.settledMedia.map((media) => ({ ...media })),
    nextMediaId: snapshot.nextMediaId,
    cameraView: snapshot.cameraView === null ? null : { ...snapshot.cameraView },
    nextPermanentButtonId: snapshot.nextPermanentButtonId,
    liveMessages: snapshot.liveMessages.map((message) => ({ ...message })),
    debugMode: snapshot.debugMode,
    playerProfile: clonePlayerProfile(snapshot.playerProfile),
    randomControl: cloneRandomControl(snapshot.randomControl),
    maxCallDepth: snapshot.maxCallDepth,
    status: snapshot.status,
    failure:
      snapshot.failure === null
        ? null
        : {
            code: snapshot.failure.code,
            message: snapshot.failure.message,
            path: snapshot.failure.path,
            span: copySpan(snapshot.failure.span),
          },
  };
}

function cloneBinding(binding: RuntimeBindingSnapshot): RuntimeBindingSnapshot {
  return { name: binding.name, value: cloneCapturedSerializableValue(binding.value) };
}

function cloneScopeFrame(frame: RuntimeScopeFrameSnapshot): RuntimeScopeFrameSnapshot {
  return {
    id: frame.id,
    file: frame.file,
    entry: frame.entry,
    bindings: frame.bindings.map(cloneBinding),
    ...(frame.shared === true ? { shared: true } : {}),
  };
}

function cloneFunctionFrame(frame: RuntimeCallFrameSnapshot): RuntimeCallFrameSnapshot {
  return {
    kind: "function",
    id: frame.id,
    rootScopeId: frame.rootScopeId,
    captures: cloneCaptures(frame.captures),
    functionId: frame.functionId,
    functionName: frame.functionName,
    callSiteSpan: copySpan(frame.callSiteSpan),
    returnInstruction: frame.returnInstruction,
    destinationTemporary: frame.destinationTemporary,
    timerInterruption:
      frame.timerInterruption === null ? null : cloneInterruption(frame.timerInterruption),
    callerTemporaries: frame.callerTemporaries.map(cloneTemporary),
    scopeBaseDepth: frame.scopeBaseDepth,
    loopBaseDepth: frame.loopBaseDepth,
    arguments: frame.arguments.map((argument) =>
      "value" in argument
        ? {
            parameterName: argument.parameterName,
            supplied: true,
            value: cloneCapturedSerializableValue(argument.value),
          }
        : { ...argument },
    ),
    parameterState: { ...frame.parameterState },
  };
}

function cloneInterruption(
  interruption: RuntimeTimerInterruptionSnapshot,
): RuntimeTimerInterruptionSnapshot {
  const suspendedAction =
    interruption.suspendedAction === null
      ? null
      : cloneForegroundAction(interruption.suspendedAction);
  const { dueAtMs, startedAtMs } = interruption;
  return "mediaId" in interruption
    ? { mediaId: interruption.mediaId, dueAtMs, startedAtMs, suspendedAction }
    : "buttonId" in interruption
      ? { buttonId: interruption.buttonId, dueAtMs, startedAtMs, suspendedAction }
      : {
          timerId: interruption.timerId,
          dueAtMs,
          startedAtMs,
          suspendedAction,
          currentRoundInBlock: interruption.currentRoundInBlock,
          endedRoundMs: interruption.endedRoundMs,
        };
}

function cloneInteractionResultHandoff(
  handoff: RuntimeInteractionResultHandoffSnapshot,
): RuntimeInteractionResultHandoffSnapshot {
  return {
    actionKind: handoff.actionKind,
    actionId: handoff.actionId,
    owningInstruction: handoff.owningInstruction,
    continuationInstruction: handoff.continuationInstruction,
    ownerCallFrameId: handoff.ownerCallFrameId,
    destinationTemporary: handoff.destinationTemporary,
    result: cloneInteractionResult(handoff.result),
  };
}

function cloneForegroundAction<T extends RuntimeForegroundActionSnapshot>(action: T): T {
  // EVIDENCE: invariant: clonePendingAction returns a copy of the same action kind.
  return clonePendingAction(action) as T;
}

function clonePendingAction(action: RuntimePendingActionSnapshot): RuntimePendingActionSnapshot {
  if (action.kind === "timer") return { ...action, timer: cloneTimer(action.timer) };
  if (action.kind === "media") return { ...action, media: cloneMedia(action.media) };
  if (action.kind === "permanentButton") return { ...action, button: { ...action.button } };
  if (action.kind === "mediaPlayback") return { ...action };
  if (action.kind === "capture")
    return {
      ...action,
      tags: action.tags === null ? null : action.tags.map((tag) => ({ ...tag })),
    };
  if (action.kind === "storageWrite")
    return { ...action, value: cloneCapturedSerializableValue(action.value) };
  if (action.kind === "fileStore")
    return {
      ...action,
      files: action.files.map((file) => ({ ...file })),
      references: [...action.references],
    };
  if (action.kind === "lock")
    return {
      ...action,
      passwordField: action.passwordField === null ? null : { ...action.passwordField },
      publicKeys: [...action.publicKeys],
    };
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
      display: action.display,
      label: action.label,
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
    createdAtMs: action.createdAtMs,
    ...(action.pausedMs === undefined ? {} : { pausedMs: action.pausedMs }),
    ...(action.resumes === undefined ? {} : { resumes: action.resumes }),
    timeoutMs: action.timeoutMs,
    requestEventSequence: action.requestEventSequence,
    ...(action.form === undefined ? {} : { form: cloneFormState(action.form) }),
  };
}

export function cloneInteractionUi(ui: InteractionUiPayload): InteractionUiPayload {
  const accessibleName =
    ui.accessibleName.kind === "text"
      ? { kind: "text" as const, text: ui.accessibleName.text }
      : { kind: "localizedDefault" as const, key: ui.accessibleName.key };
  if (ui.kind === "choice")
    return {
      kind: "choice",
      options: ui.options.map((option) => ({
        text: option.text,
        value: cloneInteractionChoiceValue(option.value),
        ...(option.background === undefined ? {} : { background: option.background }),
      })),
      ...(ui.preselected === undefined ? {} : { preselected: ui.preselected }),
      accessibleName,
    };
  if (ui.kind === "popup")
    return { kind: "popup", message: ui.message, buttonText: ui.buttonText, accessibleName };
  if (ui.kind === "url")
    return {
      kind: "url",
      url: ui.url,
      buttonText: ui.buttonText,
      alwaysButton: ui.alwaysButton,
      accessibleName,
    };
  if (ui.kind === "export")
    return {
      kind: "export",
      text: ui.text,
      title: ui.title,
      fileName: ui.fileName,
      accessibleName,
    };
  if (ui.kind === "button")
    return {
      kind: "button",
      buttonLabel: ui.buttonLabel,
      ...(ui.background === undefined ? {} : { background: ui.background }),
      accessibleName,
    };
  if (ui.kind === "temporal")
    return {
      kind: "temporal",
      temporalKind: ui.temporalKind,
      hint: ui.hint,
      ...(ui.prefill === undefined ? {} : { prefill: ui.prefill }),
      accessibleName,
    };
  if (ui.kind === "image") return cloneImageUi(ui, accessibleName);
  if (ui.kind === "form") return cloneFormUi(ui, accessibleName);
  if (ui.kind === "password") return { kind: "password", hint: ui.hint, accessibleName };
  return {
    kind: ui.kind,
    hint: ui.hint,
    ...(ui.prefill === undefined ? {} : { prefill: ui.prefill }),
    ...(ui.kind === "number" && ui.integer === true ? { integer: true as const } : {}),
    accessibleName,
  };
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
  if (
    settlement.actionKind === "chatPacingGate" ||
    settlement.actionKind === "mediaPlayback" ||
    settlement.actionKind === "storageWrite" ||
    settlement.actionKind === "capture"
  )
    return { ...settlement };
  if (settlement.actionKind === "fileStore")
    return { ...settlement, references: [...settlement.references] };
  if (settlement.actionKind === "lock") return { ...settlement };
  return {
    actionId: settlement.actionId,
    actionKind: "interaction",
    interactionKind: settlement.interactionKind,
    settlementKind: settlement.settlementKind,
    owningInstruction: settlement.owningInstruction,
    continuationInstruction: settlement.continuationInstruction,
    ownerCallFrameId: settlement.ownerCallFrameId,
    destinationTemporary: settlement.destinationTemporary,
    requestEventSequence: settlement.requestEventSequence,
    transcriptEventSequence: settlement.transcriptEventSequence,
    completionEventSequence: settlement.completionEventSequence,
    result: cloneInteractionResult(settlement.result),
    transcriptText: settlement.transcriptText,
    ui: cloneInteractionUi(settlement.ui),
    ...(settlement.shownOptions === undefined
      ? {}
      : { shownOptions: settlement.shownOptions && [...settlement.shownOptions] }),
  };
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

function copySpan(span: SourceSpan): SourceSpan {
  return createSourceSpan(span.start, span.end);
}

function cloneTemporary(temporary: RuntimeTemporarySnapshot): RuntimeTemporarySnapshot {
  return { id: temporary.id, value: cloneCapturedSerializableValue(temporary.value) };
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

function cloneCapturedImage(image: RuntimeCapturedImageSnapshot): RuntimeCapturedImageSnapshot {
  return { reference: image.reference, tags: image.tags.map((tag) => ({ ...tag })) };
}
