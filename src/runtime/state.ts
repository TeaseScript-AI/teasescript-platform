import { isOneOf } from "../plan/validation-support.js";
import {
  cloneRandomControl,
  validateRandomControl,
  type RuntimeRandomControlSnapshot,
} from "./random-control.js";
import {
  DEFAULT_TEMPORAL_CONTEXT,
  frozenTemporalContext,
  isValidEpochMilliseconds,
  temporalContextProblem,
  type TemporalContext,
} from "../temporal.js";
import {
  frozenTemporalCaptures,
  temporalCaptureAt,
  temporalCapturesProblem,
  type RuntimeTemporalCapture,
} from "./temporal-captures.js";
import type {
  RuntimeActionSettlementSnapshot,
  RuntimeDelayActionSnapshot,
  RuntimeMediaPlaybackActionSnapshot,
  RuntimeForegroundActionSnapshot,
  RuntimeInteractionActionSnapshot,
  RuntimePendingActionSnapshot,
  RuntimePreparedSayOutputSnapshot,
  InteractionResultValue,
} from "./actions/model.js";
import { cloneFormState, cloneFormUi } from "./actions/form.js";
import { DEFAULT_CHAT_PACING_SETTINGS, type ChatPacingSettings } from "../chat-pacing.js";
import {
  type CompiledFunctionDefinition,
  type Instruction,
  type InstructionPlan,
  type InteractionUiPayload,
  type PlanTag,
  startupDeclarations,
  type PlanTransferDestination,
} from "../plan/model.js";
import { interactionStringFits } from "../interaction-limits.js";
import { isCanonicalTagList } from "../tags.js";
import { cloneInteractionChoiceValue, cloneInteractionResult } from "../choice-values.js";
import { cloneMessageMarkup } from "../message-markup.js";
import { cloneImageUi } from "./actions/interaction.js";
import { captureOrReuseInstructionPlan } from "../plan/capture.js";
import { GLOBAL_SCOPE_ID } from "./prepared-references.js";
import { packagePathProblem } from "../project-paths.js";
import { captureExternalData, type ExternalDataFailureKind } from "../external-data-capture.js";
import { createSourceSpan, type SourceSpan } from "../source.js";
import {
  hasActivePacingGate,
  hasPacingExecutionHistory,
  isExplicitExitHaltState,
  validForegroundActionState,
  validPreparedSayOutput,
  validTopLevelPreparedSayOutputRelationship,
  validateInteractionResultHandoffState,
  validatePendingActionState,
} from "./action-validation.js";
import {
  createXorShift32State,
  DEFAULT_PLAYGROUND_SEED,
  XORSHIFT32_ALGORITHM,
  type XorShift32State,
} from "./random.js";
import {
  cloneCapturedSerializableValue,
  containsRuntimeIdentity,
  validateCapturedSerializableValue,
  type SerializableRuntimeProperty,
  type SerializableRuntimeList,
  type SerializableRuntimeDict,
  type SerializableRuntimeRange,
  type SerializableRuntimeSet,
  type SerializableRuntimeValue,
} from "./serializable-values.js";
import { cloneCaptures, type RuntimeCaptureSnapshot } from "./captures.js";
import { validateCaptureState } from "./capture-validation.js";
import {
  contextHoldsInstruction,
  rootFitsFunction,
  runsNothing,
  serializedContext,
  serializedRootFiles,
  serializedScopes,
  serializedTopContext,
} from "./activation-validation.js";
import { validateTimerState } from "./timer-validation.js";
import { recordValidationTestWork } from "../validation-testing.js";
import { validateMediaState } from "./media-validation.js";
import {
  cloneTimer,
  TIMER_PROPERTIES,
  type RuntimeSettledTimerSnapshot,
  type RuntimeTimerHandlerInvocationSnapshot,
} from "./timers.js";
import {
  cloneMedia,
  MEDIA_PROPERTIES,
  type RuntimeMediaCueInvocationSnapshot,
  type RuntimeSettledMediaSnapshot,
} from "./media.js";
import type { RuntimePermanentButtonInvocationSnapshot } from "./permanent-buttons.js";
import { stringLength } from "./string-operations.js";
import { calendarDurationProperty, temporalProperty } from "./temporal-operations.js";
import {
  isCalendarDuration,
  isCameraView,
  isMediaHandle,
  isTemporal,
  isTimerHandle,
} from "./value-predicates.js";
import { validatePermanentButtonState } from "./permanent-button-validation.js";
import {
  instructionKilledTemporaries,
  requiredInstructionTemporaries,
} from "../plan/temporary-uses.js";
import {
  snapshotValidationAnalysis,
  type PreparedSayTemporaryOwnership,
  type SnapshotValidationAnalysis,
} from "./snapshot-validation-analysis.js";
import {
  cloneScriptStorage,
  sortScriptStorage,
  validateScriptStorageEntries,
  type RuntimeScriptStorageEntrySnapshot,
} from "./script-storage.js";

export const RUNTIME_SNAPSHOT_FORMAT = "teasescript-runtime-snapshot";
export const RUNTIME_SNAPSHOT_VERSION = 72;
export const DEFAULT_MAX_CALL_DEPTH = 256;
export const MAX_SUPPORTED_CALL_DEPTH = 4096;
export const MAX_RUNTIME_SESSION_TIME_MS = Number.MAX_SAFE_INTEGER;
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
  "fallback",
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
  "preparedSayOutput",
  "settledTimers",
  "nextTimerId",
  "pendingTimerHandlers",
  "stageImage",
  "capturedImages",
  "scriptStorage",
  "scriptStoragePersistent",
  "settledMedia",
  "nextMediaId",
  "cameraView",
  "nextPermanentButtonId",
  "liveMessages",
  "debugMode",
  "randomControl",
  "maxCallDepth",
  "status",
  "failure",
] as const;

export type RuntimeStatus = "ready" | "running" | "waiting" | "halted" | "failed";

/**
 * A shown message a message handle can still change: the ID of its `say` event, and the markup source of its current
 * text, as that `say` or the latest `.text` write gave it. Its events carry the parsed text.
 */
export interface RuntimeLiveMessageSnapshot {
  readonly messageId: number;
  readonly sourceText: string;
}

/**
 * The default camera's view: where it is shown, and whether it is shown now. It exists from the first `showCamera` on,
 * so camera view handles stay readable after `hideCamera`; whether the Player has a camera to show is not part of it.
 */
export interface RuntimeCameraViewSnapshot {
  placement: "window" | "stage";
  shown: boolean;
}

/** A captured photo in the image catalog: its opaque reference, which only the host store resolves, and its tags. */
export interface RuntimeCapturedImageSnapshot {
  readonly reference: string;
  readonly tags: readonly PlanTag[];
}

export interface RuntimeBindingSnapshot {
  readonly name: string;
  value: SerializableRuntimeValue;
}

export interface RuntimeScopeFrameSnapshot {
  readonly id: number;
  /**
   * The file of an activation's root scope, which holds the top-level variables of one entry into the file; `null`
   * for a block or function scope.
   */
  readonly file: number | null;
  /**
   * Where the activation of a root started: its file's entry or one of its labels, which a `goto` to a label of the
   * file keeps; `null` for a block or function scope.
   */
  readonly entry: number | null;
  readonly bindings: RuntimeBindingSnapshot[];
  /**
   * Present on a block, loop, or function scope once a timer, media, or button block shares one of its variables: only
   * such a scope may be retained when its code leaves it.
   */
  shared?: true;
}

export interface RuntimeSpeakerSnapshot {
  readonly id: number;
  readonly identifier: string;
  readonly properties: SerializableRuntimeProperty[];
}

export interface RuntimeFailureSnapshot {
  readonly code: string;
  readonly message: string;
  /** The project file whose source {@link span} is in. */
  readonly path: string;
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
  /**
   * `for key, value in dict`: the value variable. The source is then the dict as the loop started, whose entries give
   * each key and a copy of its value; otherwise a dict source holds its keys as a list.
   */
  readonly valueVariable?: string;
  readonly source:
    | SerializableRuntimeList
    | SerializableRuntimeSet
    | SerializableRuntimeRange
    | SerializableRuntimeDict;
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

/**
 * An expiry block running as an interrupt. The interrupted foreground delay or interaction is inert here and is
 * restored, or settled when its deadline has passed, when the block returns normally.
 */
export type RuntimeTimerInterruptionSnapshot =
  | {
      readonly timerId: number;
      readonly dueAtMs: number;
      readonly suspendedAction: RuntimeInterruptibleActionSnapshot | null;
    }
  /** A media cue block owned by a media record instead of a timer. */
  | {
      readonly mediaId: number;
      readonly dueAtMs: number;
      readonly suspendedAction: RuntimeInterruptibleActionSnapshot | null;
    }
  /** The block of a clicked permanent button, which may have been removed since. */
  | {
      readonly buttonId: number;
      readonly dueAtMs: number;
      readonly suspendedAction: RuntimeInterruptibleActionSnapshot | null;
    };

/** Foreground actions that an interrupt block can suspend. */
export type RuntimeInterruptibleActionSnapshot =
  | RuntimeDelayActionSnapshot
  | RuntimeInteractionActionSnapshot
  | RuntimeMediaPlaybackActionSnapshot;

export interface RuntimeCallFrameSnapshot {
  readonly kind: "function";
  readonly id: number;
  /** The activation root whose top-level names the function or block sees. */
  readonly rootScopeId: number;
  /** For a timer, media, or button block, the variables it shares with the code that created it; otherwise empty. */
  readonly captures: readonly RuntimeCaptureSnapshot[];
  readonly functionId: number;
  readonly functionName: string;
  /** A user call site, or the timer statement for an expiry block. */
  readonly callSiteSpan: SourceSpan;
  /** For an expiry block, the interrupted position, or the continuation once its suspended delay settled. */
  returnInstruction: number;
  /** `null` only for an expiry block, which returns no value. */
  readonly destinationTemporary: number | null;
  timerInterruption: RuntimeTimerInterruptionSnapshot | null;
  readonly callerTemporaries: RuntimeTemporarySnapshot[];
  readonly scopeBaseDepth: number;
  readonly loopBaseDepth: number;
  readonly arguments: RuntimeCallArgumentSnapshot[];
  parameterState: RuntimeParameterStateSnapshot;
}

/**
 * A `call` of a file: the called file runs in its own activation, whose root is `frames[scopeBaseDepth]`, and its
 * `end` continues at `returnInstruction` with the caller's temporaries.
 */
export interface RuntimeFileCallFrameSnapshot {
  readonly kind: "file";
  readonly id: number;
  readonly callSiteSpan: SourceSpan;
  readonly returnInstruction: number;
  readonly callerTemporaries: RuntimeTemporarySnapshot[];
  readonly scopeBaseDepth: number;
  readonly loopBaseDepth: number;
}

/** Function and file calls in the order they happened. */
export type RuntimeFrameSnapshot = RuntimeCallFrameSnapshot | RuntimeFileCallFrameSnapshot;

export interface RuntimeInteractionResultHandoffSnapshot {
  /** Which foreground action produced the result: an interaction or a capture. */
  readonly actionKind: "interaction" | "capture";
  readonly actionId: number;
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly destinationTemporary: number;
  /** A capture's result is its captured-media reference, or `null` when its camera was unavailable. */
  readonly result: InteractionResultValue;
}

export type { ChatPacingSettings };

export interface RuntimeSnapshot {
  readonly format: typeof RUNTIME_SNAPSHOT_FORMAT;
  readonly version: typeof RUNTIME_SNAPSHOT_VERSION;
  nextInstruction: number;
  readonly frames: RuntimeScopeFrameSnapshot[];
  /**
   * The session's globals, which every file sees (ADR 0022 §6): those the host gives, then the globals and speakers of
   * the script as the start of `main.tease` sets them up.
   */
  readonly globals: RuntimeBindingSnapshot[];
  readonly speakers: RuntimeSpeakerSnapshot[];
  defaultSpeaker: number | null;
  contextualSpeaker: number | null;
  readonly rng: XorShift32State;
  readonly warnedSpeakerIds: number[];
  readonly loopFrames: RuntimeLoopFrameSnapshot[];
  readonly temporaries: RuntimeTemporarySnapshot[];
  readonly callFrames: RuntimeFrameSnapshot[];
  /** Roots of activations that were left but whose timer or media blocks can still run. */
  readonly retainedScopes: RuntimeScopeFrameSnapshot[];
  /** Where an `end` without a calling file continues, set by `fallback`. */
  fallback: PlanTransferDestination | null;
  nextEventSequence: number;
  nextScopeId: number;
  nextSpeakerId: number;
  nextCallFrameId: number;
  /** Scene time at which execution currently stands; engine operations read it as "now". */
  currentSessionTimeMs: number;
  /**
   * Latest observed scene time. Execution catches up to it event by event: at each due deadline scene time stands at
   * that deadline while the script or expiry block runs, so late and on-time observation produce the same result.
   */
  observedSessionTimeMs: number;
  readonly chatPacingSettings: ChatPacingSettings;
  /**
   * The player's zone, date and time presentation, and wall clock: captured when the session started and again at each
   * Continue, each in force from its boundary scene time.
   */
  readonly temporalCaptures: RuntimeTemporalCapture[];
  foregroundAction: RuntimeForegroundActionSnapshot | null;
  readonly backgroundActions: RuntimePendingActionSnapshot[];
  nextActionId: number;
  lastSettlement: RuntimeActionSettlementSnapshot | null;
  interactionResultHandoff: RuntimeInteractionResultHandoffSnapshot | null;
  preparedSayOutput: RuntimePreparedSayOutputSnapshot | null;
  /**
   * Finished or stopped timers that a handle or a queued or running expiry block still reaches; a public operation drops
   * the others before it returns. Active timers are background actions.
   */
  readonly settledTimers: RuntimeSettledTimerSnapshot[];
  nextTimerId: number;
  /**
   * Queued interrupt blocks: timer expiry blocks, media cue blocks, and clicked permanent buttons. They run one at a
   * time in due order; entries with equal due times keep their queue order.
   */
  readonly pendingTimerHandlers: (
    | RuntimeTimerHandlerInvocationSnapshot
    | RuntimeMediaCueInvocationSnapshot
    | RuntimePermanentButtonInvocationSnapshot
  )[];
  /** The persistent Stage image reference, or `null` for an empty Stage. */
  stageImage: string | null;
  /**
   * Photos taken with `takePhoto(tags: …)`, in capture order, each by its captured reference with its tags in name
   * order. Tag queries search them after the plan's images (ADR 0023).
   */
  readonly capturedImages: RuntimeCapturedImageSnapshot[];
  /** This session's view of script storage: loaded from the host at start, changed by `save` and `delete`. */
  readonly scriptStorage: RuntimeScriptStorageEntrySnapshot[];
  /** Whether a host provider persists script storage, so `save` and `delete` wait for its acknowledgement. */
  readonly scriptStoragePersistent: boolean;
  /**
   * Finished or stopped media that a handle or a queued or running cue block still reaches; a public operation drops the
   * others before it returns. Active media are background actions.
   */
  readonly settledMedia: RuntimeSettledMediaSnapshot[];
  nextMediaId: number;
  /** The default camera's view, or `null` before the first `showCamera`. */
  cameraView: RuntimeCameraViewSnapshot | null;
  /** Shown permanent buttons are background actions; this issues their identifiers. */
  nextPermanentButtonId: number;
  /**
   * The current text of each shown message that a message handle in this state reaches, by message ID in ascending
   * order. A public operation drops the messages no handle reaches anymore before it returns.
   */
  readonly liveMessages: RuntimeLiveMessageSnapshot[];
  /** What the protected `debugMode` reads: whether the host runs the session in Debug. Only the host changes it. */
  debugMode: boolean;
  /**
   * Controlled randomness (docs/RUNTIME.md#controlled-randomness): how many chosen outcomes this state's history
   * accepted, and a draw the engine paused at; `null` until a host chooses an outcome or pauses.
   */
  randomControl: RuntimeRandomControlSnapshot | null;
  readonly maxCallDepth: number;
  status: RuntimeStatus;
  failure: RuntimeFailureSnapshot | null;
}

export interface FreshRuntimeOptions {
  readonly seed?: number;
  readonly globals?: Readonly<Record<string, SerializableRuntimeValue>>;
  /** The host's stored values for this script. */
  readonly scriptStorage?: readonly RuntimeScriptStorageEntrySnapshot[];
  /**
   * Whether the host persists script storage. Then `save` and `delete` wait for the host's acknowledgement before the
   * session sees the change; otherwise storage is session-local.
   */
  readonly persistentScriptStorage?: boolean;
  /** What the protected `debugMode` reads at first; `false` without one. `setDebugMode` changes it later. */
  readonly debugMode?: boolean;
  readonly maxCallDepth?: number;
  readonly initialSessionTimeMs?: number;
  readonly baseDelayMs?: number;
  readonly delayPerWordMs?: number;
  readonly delayPerCharacterMs?: number;
  /**
   * The player's zone rules and numeric presentation, as `captureTemporalContext` returns them. Without one the
   * session uses UTC and locale-neutral text such as `2026-10-04 18:30`.
   */
  readonly temporalContext?: TemporalContext;
  /**
   * The UTC wall clock in whole epoch milliseconds when the session starts, at `initialSessionTimeMs`. Without one the
   * current-time getters fail.
   */
  readonly wallClockMs?: number;
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
    fallback: null,
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
    preparedSayOutput: null,
    settledTimers: [],
    nextTimerId: 1,
    pendingTimerHandlers: [],
    stageImage: null,
    capturedImages: [],
    // EVIDENCE: validation: validateScriptStorageEntries accepted these captured entries above.
    scriptStorage: sortScriptStorage(scriptStorage as RuntimeScriptStorageEntrySnapshot[]),
    scriptStoragePersistent: persistentScriptStorage,
    settledMedia: [],
    nextMediaId: 1,
    cameraView: null,
    nextPermanentButtonId: 1,
    liveMessages: [],
    debugMode,
    randomControl: null,
    maxCallDepth,
    status: "ready",
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
    frames: snapshot.frames.map(cloneScopeFrame),
    globals: snapshot.globals.map(cloneBinding),
    retainedScopes: snapshot.retainedScopes.map(cloneScopeFrame),
    fallback: snapshot.fallback === null ? null : cloneTransferDestination(snapshot.fallback),
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
    preparedSayOutput:
      snapshot.preparedSayOutput === null
        ? null
        : clonePreparedSayOutput(snapshot.preparedSayOutput),
    settledTimers: snapshot.settledTimers.map((timer) => ({ ...timer })),
    nextTimerId: snapshot.nextTimerId,
    pendingTimerHandlers: snapshot.pendingTimerHandlers.map((invocation) => ({
      ...invocation,
      captures: cloneCaptures(invocation.captures),
    })),
    stageImage: snapshot.stageImage,
    capturedImages: snapshot.capturedImages.map(cloneCapturedImage),
    scriptStorage: cloneScriptStorage(snapshot.scriptStorage),
    scriptStoragePersistent: snapshot.scriptStoragePersistent,
    settledMedia: snapshot.settledMedia.map((media) => ({ ...media })),
    nextMediaId: snapshot.nextMediaId,
    cameraView: snapshot.cameraView === null ? null : { ...snapshot.cameraView },
    nextPermanentButtonId: snapshot.nextPermanentButtonId,
    liveMessages: snapshot.liveMessages.map((message) => ({ ...message })),
    debugMode: snapshot.debugMode,
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

export function cloneTransferDestination(
  destination: PlanTransferDestination,
): PlanTransferDestination {
  return "pick" in destination
    ? { pick: destination.pick.map((option) => ({ file: option.file, target: option.target })) }
    : { file: destination.file, target: destination.target };
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
      argument.supplied
        ? {
            parameterName: argument.parameterName,
            supplied: true,
            value: cloneCapturedSerializableValue(argument.value),
          }
        : { parameterName: argument.parameterName, supplied: false },
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
  return "mediaId" in interruption
    ? { mediaId: interruption.mediaId, dueAtMs: interruption.dueAtMs, suspendedAction }
    : "buttonId" in interruption
      ? { buttonId: interruption.buttonId, dueAtMs: interruption.dueAtMs, suspendedAction }
      : { timerId: interruption.timerId, dueAtMs: interruption.dueAtMs, suspendedAction };
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

function clonePreparedSayOutput(
  output: RuntimePreparedSayOutputSnapshot,
): RuntimePreparedSayOutputSnapshot {
  return {
    owningInstruction: output.owningInstruction,
    continuationInstruction: output.continuationInstruction,
    speaker: output.speaker === null ? null : { ...output.speaker },
    content: cloneMessageMarkup(output.content),
    presentation: { ...output.presentation },
    text: output.text,
    ...(output.sourceText === undefined ? {} : { sourceText: output.sourceText }),
    durationMs: output.durationMs,
    skippable: output.skippable,
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
    createdAtMs: action.createdAtMs,
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

/**
 * A validated snapshot whose temporal contexts are deeply frozen. A captured or parsed context is a fresh copy; a
 * frozen one is shared by every later snapshot clone instead of copying its zone transitions.
 */
export function withFrozenTemporalCaptures(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return { ...snapshot, temporalCaptures: frozenTemporalCaptures(snapshot.temporalCaptures) };
}

/** The zone and presentation in force at the scene time where execution stands. */
export function currentTemporalContext(snapshot: RuntimeSnapshot): TemporalContext {
  return temporalCaptureAt(snapshot.temporalCaptures, snapshot.currentSessionTimeMs).context;
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
  validateFallback(value.fallback, analysis, errors);
  const speakerIds = validateSpeakers(value.speakers, errors);
  validateGlobals(value, plan, errors);
  validateStartupPhase(value, plan, errors);
  const scopes = referenceScopes(value);
  const preparedReferenceTemporaries = analysis?.preparedReferenceTemporaries;
  const preparedSayTemporaryOwnership = analysis?.preparedSayTemporaryOwnership;
  validateTemporaries(value.temporaries, plan, "Runtime temporaries", errors);
  validatePreparedReferenceTemporaries(
    value.temporaries,
    scopes,
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

function validateLoopFrames(
  value: unknown,
  frames: unknown,
  nextInstruction: unknown,
  callFrames: unknown,
  callFrameIds: ReadonlySet<number>,
  analysis: SnapshotValidationAnalysis | undefined,
  snapshotValue: Record<string, unknown>,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push("Runtime loopFrames must be an array.");
    return;
  }
  const frameCount = Array.isArray(frames) ? frames.length : 0;
  let previousDepth = 0;
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
    if (frame.scopeDepth < previousDepth) {
      errors.push("Runtime loop frame scope depths are out of order.");
    }
    previousDepth = frame.scopeDepth;
    if (frame.kind === "repeat") {
      if (!nonNegativeSafeInteger(frame.remaining)) {
        errors.push("Runtime repeat-loop state is malformed.");
      }
    } else if (frame.kind === "while") {
      // While loops need no additional hidden state.
    } else if (frame.kind === "for") {
      const failure = validateCapturedSerializableValue(frame.source, "loop.source");
      const pair = "valueVariable" in frame;
      if (
        typeof frame.variable !== "string" ||
        frame.variable.length === 0 ||
        (pair &&
          (typeof frame.valueVariable !== "string" ||
            frame.valueVariable.length === 0 ||
            frame.valueVariable === frame.variable)) ||
        failure !== null ||
        !isPlainRecord(frame.source) ||
        // A pair loop goes through a dict; any other through a list, set, or range.
        !(pair
          ? frame.source.kind === "dict"
          : isOneOf(frame.source.kind, ["list", "set", "range"])) ||
        !nonNegativeSafeInteger(frame.position) ||
        frame.position > iterationLength(frame.source)
      ) {
        errors.push("Runtime for-loop iterator state is malformed.");
      }
    } else {
      errors.push("Runtime loop kind is unsupported.");
    }
  }
  if (Array.isArray(callFrames)) {
    validateLoopContexts(
      value,
      frames,
      nextInstruction,
      callFrames,
      analysis,
      snapshotValue,
      errors,
    );
  }
}

/**
 * Each context owns the loops between its call frame's loop base and the next call frame's, and runs them in its own
 * scopes. At the position where a context stands (the next instruction, or the call or interrupted position it resumes
 * from), exactly the loops whose body holds that position are active, in nesting order; a loop whose header holds it
 * may be active. Loops are identified per context, so a recursive call runs its own instance of the same loop.
 */
function validateLoopContexts(
  loops: readonly unknown[],
  frames: unknown,
  nextInstruction: unknown,
  callFrames: readonly unknown[],
  analysis: SnapshotValidationAnalysis | undefined,
  snapshotValue: Record<string, unknown>,
  errors: string[],
): void {
  const frameList = Array.isArray(frames) ? frames : [];
  const plan = analysis?.plan;
  const plannedLoops = analysis?.loops ?? new Map<number, never>();
  const depth = (frame: unknown, key: "loopBaseDepth" | "scopeBaseDepth", fallback: number) =>
    isPlainRecord(frame) && nonNegativeSafeInteger(frame[key]) ? frame[key] : fallback;
  // The call frames' own checks report impossible bases; only real, ordered partitions are walked.
  let previousBase = 0;
  for (const frame of callFrames) {
    const base = depth(frame, "loopBaseDepth", -1);
    if (base < previousBase || base > loops.length) return;
    previousBase = base;
  }
  for (let level = 0; level <= callFrames.length; level += 1) {
    const below = level === 0 ? undefined : callFrames[level - 1];
    const above = callFrames[level];
    const owner = level === 0 ? null : isPlainRecord(below) ? below.id : undefined;
    const loopStart = depth(below, "loopBaseDepth", 0);
    const loopEnd = level === callFrames.length ? loops.length : depth(above, "loopBaseDepth", 0);
    const scopeStart = depth(below, "scopeBaseDepth", 0);
    const scopeEnd =
      level === callFrames.length ? frameList.length : depth(above, "scopeBaseDepth", 0);
    // A call stands at its call instruction; an interrupted context resumes where it was interrupted. After `exit`
    // the position follows the exit wherever it stood, with no loops left.
    const position =
      level === callFrames.length
        ? snapshotValue.status === "halted"
          ? undefined
          : nextInstruction
        : isPlainRecord(above) && nonNegativeSafeInteger(above.returnInstruction)
          ? isPlainRecord(above.timerInterruption)
            ? above.returnInstruction
            : above.returnInstruction - 1
          : undefined;
    const context = serializedContext(snapshotValue, level);
    const active = new Set<number>();
    let previousStart = -1;
    // A loop runs in the scopes above those of the loop around it, whose body opened a scope of its own.
    let outerDepth = scopeStart;
    for (let index = loopStart; index < loopEnd; index += 1) {
      const frame = loops[index];
      if (!isPlainRecord(frame) || !nonNegativeSafeInteger(frame.loopId)) continue;
      const planned = plannedLoops.get(frame.loopId);
      const scopeDepth = nonNegativeSafeInteger(frame.scopeDepth) ? frame.scopeDepth : -1;
      const inBody =
        planned !== undefined &&
        nonNegativeSafeInteger(position) &&
        position > planned.start &&
        position < planned.target;
      // Without a plan, the position cannot tell whether the loop's body, with its own scope, holds it.
      if (
        frame.callFrameId !== owner ||
        active.has(frame.loopId) ||
        scopeDepth <= outerDepth ||
        (plan === undefined
          ? scopeDepth > scopeEnd
          : inBody
            ? scopeDepth >= scopeEnd
            : scopeDepth !== scopeEnd) ||
        (scopeDepth < frameList.length &&
          (!isPlainRecord(frameList[scopeDepth]) || frameList[scopeDepth].file !== null))
      ) {
        errors.push("Runtime loop frame does not belong to its call context.");
      }
      active.add(frame.loopId);
      if (scopeDepth > outerDepth) outerDepth = scopeDepth;
      if (plan === undefined) continue;
      if (
        planned === undefined ||
        planned.kind !== frame.kind ||
        (planned.kind === "for" &&
          (planned.variable !== frame.variable || planned.valueVariable !== frame.valueVariable)) ||
        context === undefined ||
        !contextHoldsInstruction(plan, context, planned.start) ||
        planned.start <= previousStart ||
        !nonNegativeSafeInteger(position) ||
        position < planned.continueStart ||
        position >= planned.target
      ) {
        errors.push("Runtime loop frame does not match the instruction plan.");
      }
      previousStart = planned?.start ?? previousStart;
    }
    if (plan === undefined || context === undefined || !nonNegativeSafeInteger(position)) continue;
    for (const [loopId, planned] of plannedLoops) {
      if (
        position > planned.start &&
        position < planned.target &&
        !active.has(loopId) &&
        contextHoldsInstruction(plan, context, planned.start)
      ) {
        errors.push("Runtime state is missing a loop that its position runs in.");
        break;
      }
    }
  }
}

function iterationLength(source: Record<string, unknown>): number {
  if ((source.kind === "list" || source.kind === "set") && Array.isArray(source.items)) {
    return source.items.length;
  }
  if (source.kind === "dict" && Array.isArray(source.entries)) return source.entries.length;
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
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "key"; readonly key: string };

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
  preparedTemporaries: ReadonlyMap<number, boolean> | undefined,
  label: string,
  errors: string[],
): void {
  if (preparedTemporaries === undefined || preparedTemporaries.size === 0 || !Array.isArray(value))
    return;

  for (const temporary of value) {
    if (!isPlainRecord(temporary) || !nonNegativeSafeInteger(temporary.id)) continue;
    const keepsRoot = preparedTemporaries.get(temporary.id);
    if (keepsRoot === undefined) continue;
    const failure = validatePreparedReferenceDescriptor(
      temporary.value,
      frames,
      speakers,
      keepsRoot,
    );
    if (failure !== null) {
      errors.push(`${label} contain malformed prepared-reference state: ${failure}`);
    }
  }
}

function validatePreparedSayTemporaries(
  value: unknown,
  speakers: unknown,
  ownership: PreparedSayTemporaryOwnership | undefined,
  label: string,
  errors: string[],
): void {
  if (ownership === undefined || !Array.isArray(value)) return;
  // The first record of each temporary ID; the temporaries' own checks report duplicates.
  const records = new Map<number, Record<string, unknown>>();
  for (const temporary of value) {
    if (isPlainRecord(temporary) && typeof temporary.id === "number" && !records.has(temporary.id))
      records.set(temporary.id, temporary);
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
  // Each contextual speaker the state holds matches the output speaker it was prepared from, if that is held too.
  for (const [temporaryId, contextual] of records) {
    const outputTemporaryId = ownership.contextualSpeakerSources.get(temporaryId);
    const output = outputTemporaryId === undefined ? undefined : records.get(outputTemporaryId);
    if (output !== undefined && !preparedSaySpeakerValuesMatch(output.value, contextual.value)) {
      errors.push(`${label} contain inconsistent prepared-say speaker state.`);
    }
  }
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

/** `keepsRoot`: whether the plan keeps a copy of the root of an attached reference in this temporary. */
function validatePreparedReferenceDescriptor(
  value: unknown,
  frames: unknown,
  speakers: unknown,
  keepsRoot: boolean,
): string | null {
  const properties = serializedObjectPropertyMap(value);
  if (
    properties === null ||
    properties.size !==
      preparedReferencePropertyNames.length - (properties.has("capturedRoot") ? 0 : 1) ||
    preparedReferencePropertyNames.some((name) => name !== "capturedRoot" && !properties.has(name))
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
    rootFrameId !== GLOBAL_SCOPE_ID &&
    !nonNegativeSafeInteger(rootFrameId)
  ) {
    return "the root frame ID must be a non-negative integer, the globals' scope ID, or null.";
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
  // A detached reference is its captured root; an attached one keeps a copy exactly where the plan does.
  if ((capturedRoot !== undefined) !== (detached || keepsRoot)) {
    return detached || keepsRoot
      ? "the captured root is missing."
      : "an attached descriptor keeps a captured root where the plan keeps none.";
  }

  const path = parsePreparedReferencePath(pathValue);
  if (path === null) return "the descriptor path is malformed.";
  if (capturedRoot !== undefined && !preparedReferencePathResolves(capturedRoot, path, speakers)) {
    return "the captured root does not satisfy the prepared path.";
  }

  if (rootFrameId !== null && rootName !== null) {
    const binding = serializedFrameBinding(frames, rootFrameId, rootName);
    if (!binding.found) {
      return "the binding root does not exist in the serialized scope frames.";
    }
    // A reference that keeps a copy of its root is detached at its next use once its path leads nowhere from its
    // variable. A dict's `keys` and `values` are made anew at each read, so no change of the dict detaches a reference
    // through them before that use.
    if (
      !detached &&
      capturedRoot === undefined &&
      !preparedReferencePathResolves(binding.value, path, speakers)
    ) {
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

function serializedDictEntryMap(value: unknown): ReadonlyMap<string, unknown> | null {
  if (!isPlainRecord(value) || value.kind !== "dict" || !Array.isArray(value.entries)) return null;
  const output = new Map<string, unknown>();
  for (const entry of value.entries) {
    if (!isPlainRecord(entry) || typeof entry.key !== "string" || output.has(entry.key))
      return null;
    output.set(entry.key, entry.value);
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
    if (kind === "key" && properties.size === 2 && properties.has("key")) {
      const key = properties.get("key");
      if (typeof key !== "string") return null;
      output.push({ kind, key });
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
      // Only a list is addressed by position; a set member is read as a copy.
      if (
        !isPlainRecord(current) ||
        current.kind !== "list" ||
        !Array.isArray(current.items) ||
        step.index >= current.items.length
      ) {
        return false;
      }
      current = current.items[step.index];
      continue;
    }
    if (step.kind === "key") {
      const entries = serializedDictEntryMap(current);
      if (entries === null || !entries.has(step.key)) return false;
      current = entries.get(step.key);
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
      isOneOf(current.kind, ["list", "set"]) &&
      Array.isArray(current.items)
    ) {
      if (step.name !== "length") return false;
      current = current.items.length;
      continue;
    }
    if (isPlainRecord(current) && current.kind === "dict" && Array.isArray(current.entries)) {
      const entries = serializedDictEntryMap(current);
      if (entries === null) return false;
      // `keys` and `values` read new lists derived from the entries.
      if (step.name === "length") current = entries.size;
      else if (step.name === "keys") current = { kind: "list", items: [...entries.keys()] };
      else if (step.name === "values") current = { kind: "list", items: [...entries.values()] };
      else return false;
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
    current = derivedProperty(current, step.name);
    if (current === undefined) return false;
  }
  return true;
}

/**
 * A property that the runtime reads from a value that does not hold it (`Evaluator.#getProperty`): one derived from a
 * text, a calendar duration, or a date or time, or state of a timer, media, or camera handle; `undefined` when the
 * value has no such property. A handle's property depends on that state, so it stands as an empty text here: only a
 * text has a property of its own, `length`, which the runtime checks again when it resolves the reference.
 */
function derivedProperty(value: unknown, name: string): SerializableRuntimeValue | undefined {
  if (typeof value === "string") return name === "length" ? stringLength(value) : undefined;
  if (validateCapturedSerializableValue(value) !== null) return undefined;
  // EVIDENCE: validation: validateCapturedSerializableValue accepted this captured value above.
  const runtimeValue = value as SerializableRuntimeValue;
  if (isCalendarDuration(runtimeValue)) return calendarDurationProperty(runtimeValue, name);
  if (isTemporal(runtimeValue)) return temporalProperty(runtimeValue, name);
  return (isTimerHandle(runtimeValue) && TIMER_PROPERTIES.has(name)) ||
    (isMediaHandle(runtimeValue) && MEDIA_PROPERTIES.has(name)) ||
    (isCameraView(runtimeValue) && name === "placement")
    ? ""
    : undefined;
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
  continuationRequests: ContinuationRequests,
  preparedReferenceTemporaries: ReadonlyMap<number, boolean> | undefined,
  preparedSayTemporaryOwnership: PreparedSayTemporaryOwnership | undefined,
  snapshotValue: Record<string, unknown>,
  errors: string[],
): Set<number> {
  const ids = new Set<number>();
  let handlerFrameSeen = false;
  if (!Array.isArray(value)) {
    errors.push("Runtime callFrames must be an array.");
    return ids;
  }
  // An expiry block's interrupt frame is not an author call, so it may exceed the call-depth limit by one.
  const interruptFrames = value.filter(
    (frame) => isPlainRecord(frame) && isPlainRecord(frame.timerInterruption),
  ).length;
  if (
    nonNegativeSafeInteger(maxCallDepth) &&
    value.length > maxCallDepth + Math.min(1, interruptFrames)
  ) {
    errors.push("Runtime call stack exceeds maxCallDepth.");
  }
  const frameCount = Array.isArray(frames) ? frames.length : 0;
  const loopCount = Array.isArray(loopFrames) ? loopFrames.length : 0;
  const roots = serializedRootFiles(snapshotValue);
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
    if (frame.kind !== "function" && frame.kind !== "file") {
      errors.push("Runtime call frame is malformed.");
      return;
    }
    // A file call has no function: it continues after its `call` when the called file ends.
    const isFunction = frame.kind === "function";
    if (!isFunction) validateFileCallFrame(frame, frames, plan, errors);
    const definition =
      isFunction && nonNegativeSafeInteger(frame.functionId)
        ? analysis?.functionsById.get(frame.functionId)
        : undefined;
    const interruption = isFunction ? frame.timerInterruption : null;
    // A function sees the top-level names of the activation it was called in; a block, those of its creator's.
    if (
      isFunction &&
      (!rootFitsFunction(plan, roots, frame.rootScopeId, frame.functionId) ||
        (!isPlainRecord(interruption) &&
          frame.rootScopeId !== serializedContext(snapshotValue, frameIndex)?.rootId))
    ) {
      errors.push("Runtime call frame refers to an impossible activation.");
    }
    if (!isFunction) {
      // Validated above.
    } else if (
      !Object.hasOwn(frame, "timerInterruption") ||
      (interruption !== null && !isPlainRecord(interruption)) ||
      (definition !== undefined && (definition.handler !== null) !== (interruption !== null))
    ) {
      errors.push("Runtime call frame does not match its function kind.");
    }
    if (isPlainRecord(interruption)) {
      if (handlerFrameSeen) errors.push("Runtime timer expiry blocks must not nest.");
      handlerFrameSeen = true;
      validateTimerHandlerFrame(
        frame,
        interruption,
        frameIndex,
        value,
        frames,
        loopFrames,
        snapshotValue,
        plan,
        errors,
      );
    }
    let callInstruction: Instruction | undefined;
    if (
      isFunction &&
      (!nonNegativeSafeInteger(frame.functionId) ||
        frame.functionId < 1 ||
        (plan !== undefined && definition === undefined) ||
        typeof frame.functionName !== "string" ||
        frame.functionName.length === 0 ||
        (definition !== undefined && frame.functionName !== definition.name) ||
        !validSpan(frame.callSiteSpan))
    ) {
      errors.push("Runtime call frame refers to a malformed or unknown function.");
    }
    if (isPlainRecord(interruption)) {
      // Validated with the interrupted position above.
    } else if (
      !nonNegativeSafeInteger(frame.returnInstruction) ||
      frame.returnInstruction < 1 ||
      (plan !== undefined && frame.returnInstruction > plan.instructions.length)
    ) {
      errors.push("Runtime call frame has an invalid return instruction.");
    } else if (plan !== undefined && !isFunction) {
      // The called activation may have gone to another file since, so its root need not be the call's file.
      const call = plan.instructions[frame.returnInstruction - 1];
      if (call?.kind !== "transfer" || call.mode !== "call") {
        errors.push("Runtime call frame return target does not match its call instruction.");
      }
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
    if (!isFunction) {
      // A file call has no result.
    } else if (
      isPlainRecord(interruption)
        ? frame.destinationTemporary !== null
        : !nonNegativeSafeInteger(frame.destinationTemporary) ||
          frame.destinationTemporary < 1 ||
          (plan !== undefined && frame.destinationTemporary > plan.temporaryCount)
    ) {
      errors.push("Runtime call frame has an invalid result destination.");
    }
    validateTemporaries(frame.callerTemporaries, plan, "Runtime caller temporaries", errors);
    validatePreparedReferenceTemporaries(
      frame.callerTemporaries,
      referenceScopes(snapshotValue),
      speakers,
      preparedReferenceTemporaries,
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
    if (isFunction) {
      validateCallArguments(frame.arguments, definition, errors);
      validateCallArgumentSupply(frame.arguments, callInstruction, errors);
      validateParameterState(frame.parameterState, definition, errors);
      validateParameterBindings(frame, frames, definition, analysis, errors);
    }

    if (
      plan !== undefined &&
      nonNegativeSafeInteger(frame.returnInstruction) &&
      (!isFunction ||
        nonNegativeSafeInteger(frame.destinationTemporary) ||
        isPlainRecord(interruption)) &&
      Array.isArray(frame.callerTemporaries)
    ) {
      validateSuspendedContinuationTemporaries(
        frame.callerTemporaries,
        nonNegativeSafeInteger(frame.destinationTemporary) ? frame.destinationTemporary : null,
        frame.returnInstruction,
        // The caller stands at its call, or where it was interrupted.
        isPlainRecord(interruption) ? frame.returnInstruction : frame.returnInstruction - 1,
        contextLoopIds(
          Array.isArray(loopFrames) && nonNegativeSafeInteger(frame.loopBaseDepth)
            ? loopFrames.slice(0, frame.loopBaseDepth)
            : [],
          callContextOwner(value, frameIndex),
        ),
        analysis!,
        continuationRequests,
        errors,
      );
    }

    if (
      plan !== undefined &&
      nonNegativeSafeInteger(frame.returnInstruction) &&
      !isPlainRecord(interruption)
    ) {
      const caller = serializedContext(snapshotValue, frameIndex);
      if (
        caller === undefined ||
        !contextHoldsInstruction(plan, caller, frame.returnInstruction - 1)
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
      } else if (
        isPlainRecord(child) &&
        nonNegativeSafeInteger(child.returnInstruction) &&
        isPlainRecord(child.timerInterruption)
      ) {
        // An expiry block interrupted this function exactly at its recorded position.
        if (
          child.returnInstruction < definition.entryInstruction ||
          child.returnInstruction >= definition.endInstruction
        ) {
          errors.push("Runtime timer expiry block interrupted outside its caller.");
        } else {
          validateExactParameterPosition(
            frame.parameterState,
            definition,
            child.returnInstruction,
            analysis!,
            errors,
          );
        }
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

const FILE_CALL_FRAME_KEYS = [
  "kind",
  "id",
  "callSiteSpan",
  "returnInstruction",
  "callerTemporaries",
  "scopeBaseDepth",
  "loopBaseDepth",
] as const;

/** A file call's own fields; its return and caller state are validated with every call frame. */
function validateFileCallFrame(
  frame: Record<string, unknown>,
  frames: unknown,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  const root =
    Array.isArray(frames) && nonNegativeSafeInteger(frame.scopeBaseDepth)
      ? frames[frame.scopeBaseDepth]
      : undefined;
  if (
    !hasExactKeys(frame, FILE_CALL_FRAME_KEYS) ||
    !validSpan(frame.callSiteSpan) ||
    !isPlainRecord(root) ||
    !nonNegativeSafeInteger(root.file) ||
    (plan !== undefined && root.file >= plan.files.length)
  ) {
    errors.push("Runtime file call frame is malformed.");
  }
}

/**
 * An expiry-block frame records the interrupted position and, while it is still pending, the interrupted foreground
 * delay or interaction. That action is validated against the interrupted context: the caller's scopes, loops, call
 * frames, and temporaries at the recorded position.
 */
function validateTimerHandlerFrame(
  frame: Record<string, unknown>,
  interruption: Record<string, unknown>,
  frameIndex: number,
  callFrames: unknown[],
  frames: unknown,
  loopFrames: unknown,
  snapshotValue: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  const now = snapshotValue.currentSessionTimeMs;
  const owner = Object.hasOwn(interruption, "mediaId")
    ? "mediaId"
    : Object.hasOwn(interruption, "buttonId")
      ? "buttonId"
      : "timerId";
  if (
    !hasExactKeys(interruption, [owner, "dueAtMs", "suspendedAction"]) ||
    !positiveSafeInteger(interruption[owner]) ||
    !validSessionTime(interruption.dueAtMs) ||
    !validSessionTime(now) ||
    interruption.dueAtMs > now ||
    !Array.isArray(frame.arguments) ||
    frame.arguments.length !== 0
  ) {
    errors.push("Runtime timer expiry-block frame is malformed.");
    return;
  }
  const resume = frame.returnInstruction;
  const caller = serializedContext(snapshotValue, frameIndex);
  if (
    !nonNegativeSafeInteger(resume) ||
    (plan !== undefined && (caller === undefined || !contextHoldsInstruction(plan, caller, resume)))
  ) {
    errors.push("Runtime timer expiry block interrupted outside its caller.");
    return;
  }
  const scopeBase = frame.scopeBaseDepth;
  const loopBase = frame.loopBaseDepth;
  if (!nonNegativeSafeInteger(scopeBase) || !nonNegativeSafeInteger(loopBase)) return;
  const interruptedLoops = Array.isArray(loopFrames) ? loopFrames.slice(0, loopBase) : [];
  validateCurrentTemporaryRequirements(
    frame.callerTemporaries,
    activeLoopIdOf(interruptedLoops, callContextOwner(callFrames, frameIndex)),
    resume,
    "running",
    plan,
    errors,
  );
  validateSelfHandleBinding(frame, interruption, frames, plan, errors);
  const action = interruption.suspendedAction;
  if (action === null) return;
  const view = {
    ...snapshotValue,
    nextInstruction: resume,
    frames: Array.isArray(frames) ? frames.slice(0, scopeBase) : frames,
    loopFrames: interruptedLoops,
    callFrames: callFrames.slice(0, frameIndex),
    temporaries: frame.callerTemporaries,
    foregroundAction: action,
    status: "waiting",
  };
  if (
    !isPlainRecord(action) ||
    (action.kind !== "delay" && action.kind !== "interaction" && action.kind !== "mediaPlayback") ||
    !validForegroundActionState(action, view, plan, true)
  ) {
    errors.push("Runtime suspended foreground action is malformed.");
  }
}

/**
 * Until a media block's body starts, its self-handle local holds exactly its own media's handle; afterwards the
 * block may reassign it like any local.
 */
function validateSelfHandleBinding(
  frame: Record<string, unknown>,
  interruption: Record<string, unknown>,
  frames: unknown,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  if (plan === undefined || !nonNegativeSafeInteger(frame.functionId)) return;
  const definition = plan.functions[frame.functionId - 1];
  if (
    definition?.selfHandle == null ||
    !isPlainRecord(frame.parameterState) ||
    frame.parameterState.phase === "body"
  )
    return;
  const scope =
    Array.isArray(frames) && nonNegativeSafeInteger(frame.scopeBaseDepth)
      ? frames[frame.scopeBaseDepth]
      : undefined;
  const binding =
    isPlainRecord(scope) && Array.isArray(scope.bindings)
      ? scope.bindings.find(
          (candidate) => isPlainRecord(candidate) && candidate.name === definition.selfHandle,
        )
      : undefined;
  const value = isPlainRecord(binding) ? binding.value : undefined;
  if (
    !isPlainRecord(value) ||
    value.kind !== "mediaHandle" ||
    value.mediaId !== interruption.mediaId
  ) {
    errors.push("Runtime media block self-handle binding is malformed.");
  }
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
    !isOneOf(view.placement, ["window", "stage"]) ||
    typeof view.shown !== "boolean"
  ) {
    errors.push("Runtime cameraView is malformed.");
    return;
  }
  if (view.shown && snapshot.status === "halted")
    errors.push("A halted runtime session cannot show a camera view.");
}

function validateCallArgumentSupply(
  argumentsValue: unknown,
  callInstruction: Instruction | undefined,
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
  definition: CompiledFunctionDefinition | undefined,
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
  definition: CompiledFunctionDefinition | undefined,
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
  definition: CompiledFunctionDefinition | undefined,
  errors: string[],
): void {
  if (
    !isPlainRecord(value) ||
    !isOneOf(value.phase, ["supplied", "defaults", "body"]) ||
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
  definition: CompiledFunctionDefinition,
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
  definition: CompiledFunctionDefinition,
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

function validateSuspendedContinuationTemporaries(
  callerTemporaries: unknown[],
  destinationTemporary: number | null,
  returnInstruction: number,
  callerPosition: number,
  contextLoops: readonly number[],
  analysis: SnapshotValidationAnalysis,
  continuationRequests: ContinuationRequests,
  errors: string[],
): void {
  const present = new Set(createTemporaryMap(callerTemporaries).keys());
  if (destinationTemporary !== null) present.add(destinationTemporary);
  const required = requiredContinuationTemporaries(
    analysis,
    returnInstruction,
    callerPosition,
    contextLoops,
    continuationRequests,
  );
  if ([...required].some((temporaryId) => !present.has(temporaryId))) {
    errors.push("Runtime caller temporaries cannot resume the suspended continuation.");
  }
}

/**
 * One snapshot validation's continuation liveness. Its continuations with the same loops share one graph, which each
 * query extends with the nodes it reaches; `required` holds what each continuation it asked about needs.
 */
interface ContinuationRequests {
  readonly graphs: Map<string, ContinuationGraph>;
  readonly required: Map<string, ReadonlySet<number>>;
}

/** Analysed nodes and what each needs; closed under successors, so every result is final. */
interface ContinuationGraph {
  readonly nodes: Map<number, ContinuationNode>;
  readonly liveIn: Map<number, ReadonlySet<number>>;
}

/** A node's successors and the temporaries its instruction sets or reads. */
interface ContinuationNode {
  readonly successors: readonly number[];
  readonly killed: ReadonlySet<number>;
  readonly read: ReadonlySet<number>;
}

/** Shared by every node that needs no temporary. */
const NOTHING_LIVE: ReadonlySet<number> = new Set<number>();

function requiredContinuationTemporaries(
  analysis: SnapshotValidationAnalysis,
  startInstruction: number,
  callerPosition: number,
  contextLoops: readonly number[],
  continuationRequests: ContinuationRequests,
): ReadonlySet<number> {
  // A continuation by where it resumes and the loops of its context, outermost first.
  const kept = analysis.continuationRequirements.get(
    `${startInstruction}:${contextLoops.join(",")}`,
  );
  if (kept !== undefined) return kept;
  const activeLoops = analysableLoops(analysis, contextLoops, callerPosition);
  const loopsKey = activeLoops.join(",");
  const key = `${startInstruction}:${loopsKey}`;
  const known =
    analysis.continuationRequirements.get(key) ?? continuationRequests.required.get(key);
  if (known !== undefined) return known;
  let graph = continuationRequests.graphs.get(loopsKey);
  if (graph === undefined) {
    graph = { nodes: new Map(), liveIn: new Map() };
    continuationRequests.graphs.set(loopsKey, graph);
  }
  const required = continuationRequirement(analysis, startInstruction, activeLoops, graph);
  continuationRequests.required.set(key, required);
  return required;
}

/**
 * The context's loops as a continuation query uses them: a list that a session can have where its caller stands, as
 * loop validation requires. That is planned loops in nesting order whose header or body holds the position, including
 * every loop whose body holds it, so the plan's nesting bounds both the list and the contexts of one position. Any
 * other list fails loop validation; its query uses only its innermost planned loop, so that impossible contexts can
 * neither enlarge nor multiply the analysis.
 */
function analysableLoops(
  analysis: SnapshotValidationAnalysis,
  loopIds: readonly number[],
  position: number,
): readonly number[] {
  const listed = new Set<number>();
  let previousStart = -1;
  let possible = true;
  for (const loopId of loopIds) {
    const loop = analysis.loops.get(loopId);
    if (
      loop === undefined ||
      loop.start <= previousStart ||
      position < loop.continueStart ||
      position >= loop.target
    ) {
      possible = false;
      break;
    }
    previousStart = loop.start;
    listed.add(loopId);
  }
  if (possible) {
    for (const [loopId, loop] of analysis.loops) {
      if (position > loop.start && position < loop.target && !listed.has(loopId)) {
        possible = false;
        break;
      }
    }
  }
  if (possible) return loopIds;
  const innermost = loopIds.at(-1);
  return innermost !== undefined && analysis.loops.has(innermost) ? [innermost] : [];
}

/**
 * An accepted snapshot's continuations are ones its session can resume, with validated loops, so the plan keeps what
 * they need.
 */
function keepContinuationRequirements(
  analysis: SnapshotValidationAnalysis,
  continuationRequests: ContinuationRequests,
): void {
  for (const [key, required] of continuationRequests.required) {
    analysis.continuationRequirements.set(key, required);
  }
}

/**
 * The temporaries that a continuation reads before setting them: backward liveness over the control flow that it can
 * reach from `startInstruction`, and nothing else of the plan. A node is an instruction together with how many of the
 * context's loops are still active there. Leaving the innermost of them, at its loop start's exit or by its `break`,
 * ends it; a loop start reads its expression unless its loop is the innermost one still active, which it continues.
 */
function continuationRequirement(
  analysis: SnapshotValidationAnalysis,
  startInstruction: number,
  activeLoops: readonly number[],
  graph: ContinuationGraph,
): ReadonlySet<number> {
  const { plan } = analysis;
  // A position outside the runnable plan has nothing live.
  if (plan.instructions[startInstruction] === undefined) return NOTHING_LIVE;
  const { nodes, liveIn } = graph;
  const depths = activeLoops.length + 1;
  const startNode = startInstruction * depths + activeLoops.length;
  // The nodes that this continuation reaches and earlier ones of the validation did not.
  const added: number[] = [];
  const pending = [startNode];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (nodes.has(node)) continue;
    const index = Math.floor(node / depths);
    const active = node % depths;
    const instruction = plan.instructions[index];
    const innermost = activeLoops[active - 1] ?? null;
    const successors: number[] = [];
    // An instruction outside the runnable plan has nothing live.
    if (instruction === undefined) {
      nodes.set(node, { successors, killed: NOTHING_LIVE, read: NOTHING_LIVE });
      continue;
    }
    for (const successor of instructionSuccessors(analysis, index)) {
      const leaves = innermost !== null && leavesLoop(instruction, innermost, successor);
      if (leaves) successors.push(successor * depths + active - 1);
      // An empty loop body would make a loop's exit and its body the same instruction.
      if (!leaves || (instruction.kind === "loopStart" && successor === index + 1)) {
        successors.push(successor * depths + active);
      }
    }
    nodes.set(node, {
      successors,
      killed: instructionKilledTemporaries(instruction),
      read: requiredInstructionTemporaries(instruction, innermost),
    });
    added.push(node);
    for (const successor of successors) pending.push(successor);
  }
  if (added.length === 0) return liveIn.get(startNode) ?? NOTHING_LIVE;
  recordValidationTestWork("continuationLivenessAnalyses");
  recordValidationTestWork("continuationLivenessNodes", added.length);

  // Earlier nodes are final, so only the added ones take part in the fixed point, latest instructions first.
  added.sort((left, right) => right - left);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of added) {
      const { successors, killed, read } = nodes.get(node)!;
      // Most instructions have nothing live, which needs no set of their own.
      let liveOut: Set<number> | undefined;
      for (const successor of successors) {
        for (const temporaryId of liveIn.get(successor) ?? NOTHING_LIVE) {
          (liveOut ??= new Set()).add(temporaryId);
        }
      }
      for (const temporaryId of killed) liveOut?.delete(temporaryId);
      for (const temporaryId of read) (liveOut ??= new Set()).add(temporaryId);
      if (liveOut !== undefined && !sameNumberSet(liveIn.get(node) ?? NOTHING_LIVE, liveOut)) {
        liveIn.set(node, liveOut);
        changed = true;
      }
    }
  }
  return liveIn.get(startNode) ?? NOTHING_LIVE;
}

/** Whether going from an instruction to this successor leaves the loop: at the loop's exit or by its `break`. */
function leavesLoop(instruction: Instruction, loopId: number, successor: number): boolean {
  if (instruction.kind === "loopStart") {
    return instruction.loopId === loopId && successor === instruction.target;
  }
  return (
    instruction.kind === "loopControl" &&
    instruction.action === "break" &&
    instruction.loopId === loopId
  );
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
    // A goto or end leaves this path with no temporaries, so nothing it holds stays live.
    case "goto":
    case "end":
      return [];
    // A file call returns after it with the caller's temporaries; a file goto leaves like a goto.
    case "transfer":
      return instruction.mode === "call" && next !== null ? [next] : [];
    case "callFunction":
      return instruction.returnInstruction < regionEnd ? [instruction.returnInstruction] : [];
    default:
      return next === null ? [] : [next];
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
      ]);
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
      value.fallback !== null ||
      value.failure !== null ||
      // A session that has not started has taken no photos.
      !(Array.isArray(value.capturedImages) && value.capturedImages.length === 0)
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
    if (
      calls !== 0 ||
      loops !== 0 ||
      temporaries !== 0 ||
      scopes !== 1 ||
      retained !== 0 ||
      value.fallback !== null ||
      value.failure !== null
    ) {
      errors.push("Halted runtime state retains active execution state.");
    }
    if (plan !== undefined && !isLegalHaltPosition(value.nextInstruction, plan)) {
      errors.push("Halted runtime state is not at a legal halt position.");
    }
    if (isExplicitExitHaltState(value, plan) && hasActivePacingGate(value)) {
      errors.push("Explicit exit runtime state must not retain active pacing work.");
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
  return nextInstruction > 0 && plan.instructions[nextInstruction - 1]?.kind === "exit";
}

function validateCurrentTemporaryRequirements(
  temporaries: unknown,
  activeLoopId: number | null,
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
  const required = requiredInstructionTemporaries(instruction, activeLoopId);
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
  if (instruction.kind === "capture" && present.has(instruction.destinationTemporary)) {
    errors.push("Runtime capture result destination is already occupied.");
  }
  if (
    instruction.kind === "say" &&
    instruction.destinationTemporary !== undefined &&
    present.has(instruction.destinationTemporary)
  ) {
    errors.push("Runtime say result destination is already occupied.");
  }
}

/**
 * The scopes a prepared reference may have as its root: the scope frames and retained roots, then the session's globals under
 * {@link GLOBAL_SCOPE_ID}.
 */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: boundary: the scope frames remain unvalidated until the reference checks read them.
function referenceScopes(snapshot: Record<string, unknown>): unknown {
  return Array.isArray(snapshot.frames)
    ? [
        ...serializedScopes(snapshot),
        { id: GLOBAL_SCOPE_ID, bindings: Array.isArray(snapshot.globals) ? snapshot.globals : [] },
      ]
    : snapshot.frames;
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
  "preparedSayOutput",
  "settledTimers",
  "settledMedia",
  "pendingTimerHandlers",
] as const;

/**
 * The start of `main.tease` sets up the globals and speakers once, before anything else runs (ADR 0022 §6). While the
 * next instruction is in it, a session holds nothing but the globals and speakers set up so far: no call, loop,
 * temporary, action, timer, media, queued block, permanent button, settlement, prepared output, top-level variable,
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

/** Whether an activation of a file may start at an instruction: the file's entry or one of its labels. */
function isFileEntry(analysis: SnapshotValidationAnalysis, file: number, entry: number): boolean {
  return analysis.fileEntries[file]?.has(entry) === true;
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

/** Destinations are equal by their files and targets; a glob's files in the same order, which its draws index. */
function sameTransferDestination(planned: PlanTransferDestination, stored: unknown): boolean {
  const samePlain = (left: { file: number; target: number }, right: unknown): boolean =>
    isPlainRecord(right) && right.file === left.file && right.target === left.target;
  if (!("pick" in planned)) return samePlain(planned, stored);
  const options: unknown = isPlainRecord(stored) ? stored.pick : undefined;
  return (
    Array.isArray(options) &&
    options.length === planned.pick.length &&
    planned.pick.every((option, index) => samePlain(option, options[index]))
  );
}

/**
 * `fallback` holds the destination of a `fallback` statement: a file's entry or label, or a glob's files. A computed
 * `fallback` resolves when it runs, so with one in the plan it may also be any label, or the entry of a file that runs
 * something.
 */
function validateFallback(
  value: unknown,
  analysis: SnapshotValidationAnalysis | undefined,
  errors: string[],
): void {
  if (value === null) return;
  const destination = (candidate: unknown): boolean =>
    isPlainRecord(candidate) &&
    hasExactKeys(candidate, ["file", "target"]) &&
    nonNegativeSafeInteger(candidate.file) &&
    nonNegativeSafeInteger(candidate.target);
  const shaped =
    destination(value) ||
    (isPlainRecord(value) &&
      hasExactKeys(value, ["pick"]) &&
      isCanonicalJsonArray(value.pick) &&
      value.pick.length > 0 &&
      value.pick.every(destination));
  if (
    !shaped ||
    (analysis !== undefined &&
      !analysis.fallbackDestinations.some((destination) =>
        sameTransferDestination(destination, value),
      ) &&
      !(isPlainRecord(value) && resolvedFallbackFits(value, analysis)))
  ) {
    errors.push("Runtime fallback is malformed.");
  }
}

/** Whether a fallback is one that a computed `fallback` of the plan may have resolved to. */
function resolvedFallbackFits(
  value: Record<string, unknown>,
  analysis: SnapshotValidationAnalysis,
): boolean {
  return (
    analysis.computedFallback &&
    nonNegativeSafeInteger(value.file) &&
    nonNegativeSafeInteger(value.target) &&
    isFileEntry(analysis, value.file, value.target) &&
    !runsNothing(analysis.plan, value.file)
  );
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
 * Every value a state holds where a script can reach it: the bindings of each scope and of the globals, speaker
 * properties, for-loop sources, temporaries, and each call frame's saved temporaries and supplied arguments. Validation
 * finds the runtime identities a state refers to through them, and record collection the records it still reaches.
 */
function* identityRootValues(
  frames: unknown,
  speakers: unknown,
  loopFrames: unknown,
  temporaries: unknown,
  callFrames: unknown,
): Generator<unknown, void, undefined> {
  if (Array.isArray(frames)) {
    for (const frame of frames) {
      if (!isPlainRecord(frame) || !Array.isArray(frame.bindings)) continue;
      for (const binding of frame.bindings) {
        if (isPlainRecord(binding)) yield binding.value;
      }
    }
  }
  if (Array.isArray(speakers)) {
    for (const speaker of speakers) {
      if (!isPlainRecord(speaker) || !Array.isArray(speaker.properties)) continue;
      for (const property of speaker.properties) {
        if (isPlainRecord(property)) yield property.value;
      }
    }
  }
  if (Array.isArray(loopFrames)) {
    for (const loop of loopFrames) {
      if (isPlainRecord(loop) && loop.kind === "for") yield loop.source;
    }
  }
  if (Array.isArray(temporaries)) {
    for (const temporary of temporaries) {
      if (isPlainRecord(temporary)) yield temporary.value;
    }
  }
  if (Array.isArray(callFrames)) {
    for (const frame of callFrames) {
      if (!isPlainRecord(frame)) continue;
      if (Array.isArray(frame.callerTemporaries)) {
        for (const temporary of frame.callerTemporaries) {
          if (isPlainRecord(temporary)) yield temporary.value;
        }
      }
      if (Array.isArray(frame.arguments)) {
        for (const argument of frame.arguments) {
          if (isPlainRecord(argument) && argument.supplied === true) {
            yield argument.value;
          }
        }
      }
    }
  }
}

/**
 * Drops the live records of messages and the settled media and timer records that nothing in `snapshot` reaches anymore.
 * A public operation does it before it returns, when every value of the state is in one of its roots; no handle to such
 * a message, media, or timer can appear again, so where an operation boundary falls does not change the state. A settled
 * media or timer record also stays while one of its blocks is queued or running.
 */
export function dropUnreachableRecords(snapshot: RuntimeSnapshot): void {
  if (
    snapshot.liveMessages.length === 0 &&
    snapshot.settledMedia.length === 0 &&
    snapshot.settledTimers.length === 0
  )
    return;
  // The records not reached yet. Once every record is reached nothing is dropped, so the search stops there.
  const unreached: UnreachedRecords = {
    messages: new Set(snapshot.liveMessages.map((message) => message.messageId)),
    media: new Set(snapshot.settledMedia.map((record) => record.mediaId)),
    timers: new Set(snapshot.settledTimers.map((record) => record.timerId)),
  };
  reachRecords(collectionRoots(snapshot), unreached);
  if (unreached.messages.size > 0) {
    let kept = 0;
    for (const message of snapshot.liveMessages) {
      if (!unreached.messages.has(message.messageId)) snapshot.liveMessages[kept++] = message;
    }
    snapshot.liveMessages.length = kept;
  }
  if (unreached.media.size > 0) {
    let kept = 0;
    for (const record of snapshot.settledMedia) {
      if (!unreached.media.has(record.mediaId)) snapshot.settledMedia[kept++] = record;
    }
    snapshot.settledMedia.length = kept;
  }
  if (unreached.timers.size > 0) {
    let kept = 0;
    for (const record of snapshot.settledTimers) {
      if (!unreached.timers.has(record.timerId)) snapshot.settledTimers[kept++] = record;
    }
    snapshot.settledTimers.length = kept;
  }
}

/** The IDs of the records that the search for unreachable records has not reached yet, by kind. */
interface UnreachedRecords {
  readonly messages: Set<number>;
  readonly media: Set<number>;
  readonly timers: Set<number>;
}

/**
 * The values `identityRootValues` gives for `snapshot`, scope by scope without copying its scope lists, and then a
 * handle for the media or timer of each queued or running block: a media block binds its own handle when it runs, and
 * restore and transfers read the record of a timer block's timer.
 */
function* collectionRoots(snapshot: RuntimeSnapshot): Generator<unknown, void, undefined> {
  yield* identityRootValues(snapshot.frames, null, null, null, null);
  yield* identityRootValues(snapshot.retainedScopes, null, null, null, null);
  yield* identityRootValues([{ bindings: snapshot.globals }], null, null, null, null);
  yield* identityRootValues(
    null,
    snapshot.speakers,
    snapshot.loopFrames,
    snapshot.temporaries,
    snapshot.callFrames,
  );
  for (const invocation of snapshot.pendingTimerHandlers) {
    if ("mediaId" in invocation) yield { kind: "mediaHandle", mediaId: invocation.mediaId };
    else if ("timerId" in invocation) yield { kind: "timerHandle", timerId: invocation.timerId };
  }
  for (const frame of snapshot.callFrames) {
    if (frame.kind !== "function" || frame.timerInterruption === null) continue;
    const interruption = frame.timerInterruption;
    if ("mediaId" in interruption) yield { kind: "mediaHandle", mediaId: interruption.mediaId };
    else if ("timerId" in interruption)
      yield { kind: "timerHandle", timerId: interruption.timerId };
  }
}

/**
 * Removes from `unreached` the IDs that handles in `roots` name, looking into lists, sets, objects, and dicts, and stops
 * as soon as nothing is left. Each round takes the next root and moves every walk taken so far on by one value, so the
 * work done is bounded by how far the walk must go to reach the last record, not by values after it.
 */
function reachRecords(roots: Iterator<unknown>, unreached: UnreachedRecords): void {
  /** A container's values, from `next` on; `field` reads each value from a property or entry record. */
  interface Cursor {
    readonly values: readonly unknown[];
    readonly field: boolean;
    next: number;
  }
  const { messages, media, timers } = unreached;
  const searching = (): boolean => messages.size > 0 || media.size > 0 || timers.size > 0;
  let walks: Cursor[][] = [];
  let taking = true;
  while (searching()) {
    if (taking) {
      const root = roots.next();
      if (root.done === true) taking = false;
      else {
        recordValidationTestWork("recordReachVisits");
        walks.push([{ values: [root.value], field: false, next: 0 }]);
      }
    }
    if (walks.length === 0 && !taking) return;
    const continuing: Cursor[][] = [];
    for (const walk of walks) {
      if (!searching()) return;
      recordValidationTestWork("recordReachVisits");
      const cursor = walk.at(-1)!;
      const item = cursor.values[cursor.next];
      cursor.next += 1;
      if (cursor.next >= cursor.values.length) walk.pop();
      const value = cursor.field ? (isPlainRecord(item) ? item.value : undefined) : item;
      if (isPlainRecord(value)) {
        if (value.kind === "mediaHandle" && typeof value.mediaId === "number") {
          media.delete(value.mediaId);
        } else if (value.kind === "timerHandle" && typeof value.timerId === "number") {
          timers.delete(value.timerId);
        } else if (value.kind === "messageHandle" && typeof value.messageId === "number") {
          messages.delete(value.messageId);
        } else if (
          (value.kind === "list" || value.kind === "set") &&
          Array.isArray(value.items) &&
          value.items.length > 0
        ) {
          walk.push({ values: value.items, field: false, next: 0 });
        } else if (
          value.kind === "object" &&
          Array.isArray(value.properties) &&
          value.properties.length > 0
        ) {
          walk.push({ values: value.properties, field: true, next: 0 });
        } else if (
          value.kind === "dict" &&
          Array.isArray(value.entries) &&
          value.entries.length > 0
        ) {
          walk.push({ values: value.entries, field: true, next: 0 });
        }
      }
      if (walk.length > 0) continuing.push(walk);
    }
    walks = continuing;
  }
}

/**
 * The live message records: unique positive IDs of `say` events already emitted, in ascending order, each with its
 * markup source. Every message handle the state holds has one; a record no handle reaches is harmless and is dropped by
 * the next public operation.
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
      !hasExactKeys(message, ["messageId", "sourceText"]) ||
      !positiveSafeInteger(message.messageId) ||
      message.messageId <= previous ||
      typeof nextEventSequence !== "number" ||
      message.messageId >= nextEventSequence ||
      typeof message.sourceText !== "string"
    ) {
      errors.push(
        "Runtime liveMessages must list emitted message IDs once each in ascending order, each with its text.",
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

/** The loops of a context, outermost first: the loop frames at the end that the context owns. */
function contextLoopIds(
  loopFrames: readonly unknown[],
  owner: number | null | undefined,
): number[] {
  const loopIds: number[] = [];
  for (let index = loopFrames.length - 1; index >= 0; index -= 1) {
    const frame = loopFrames[index];
    if (
      !isPlainRecord(frame) ||
      !nonNegativeSafeInteger(frame.loopId) ||
      frame.callFrameId !== owner
    )
      break;
    loopIds.push(frame.loopId);
  }
  return loopIds.reverse();
}

/** The innermost loop of a context: the last loop frame, when the context owns it. */
function activeLoopIdOf(loopFrames: unknown, owner: number | null | undefined): number | null {
  const active = Array.isArray(loopFrames) ? loopFrames.at(-1) : undefined;
  return isPlainRecord(active) &&
    nonNegativeSafeInteger(active.loopId) &&
    active.callFrameId === owner
    ? active.loopId
    : null;
}

/** The owner of the context above `level` call frames (all of them for the top): `null` for the base activation. */
function callContextOwner(callFrames: unknown, level: number): number | null | undefined {
  if (!Array.isArray(callFrames)) return null;
  const below: unknown = callFrames[Math.min(level, callFrames.length) - 1];
  if (below === undefined) return null;
  return isPlainRecord(below) && nonNegativeSafeInteger(below.id) ? below.id : undefined;
}

function cloneCapturedImage(image: RuntimeCapturedImageSnapshot): RuntimeCapturedImageSnapshot {
  return { reference: image.reference, tags: image.tags.map((tag) => ({ ...tag })) };
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
