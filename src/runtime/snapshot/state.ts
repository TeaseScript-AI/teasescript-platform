import type { RuntimeRandomControlSnapshot } from "../random/random-control.js";
import type { TemporalContext } from "../../temporal.js";
import {
  frozenTemporalCaptures,
  temporalCaptureAt,
  type RuntimeTemporalCapture,
} from "../host-data/temporal-captures.js";
import type {
  RuntimeActionSettlementSnapshot,
  RuntimeForegroundActionSnapshot,
  RuntimePendingActionSnapshot,
  InteractionResultValue,
} from "../actions/model.js";
import type { RuntimeInterruptibleActionSnapshot } from "../actions/interrupts.js";
import type { ChatPacingSettings } from "../../chat-pacing.js";
import type {
  RuntimePlayerProfileFieldSnapshot,
  RuntimePlayerProfileInput,
} from "../host-data/player-profile.js";
import type { PlanTag } from "../../plan/model.js";
import { interactionStringFits } from "../../interaction-limits.js";
import type { ExternalDataFailureKind } from "../../external-data-capture.js";
import type { SourceSpan } from "../../source.js";
import type { XorShift32State } from "../random/random.js";
import type {
  SerializableRuntimeProperty,
  SerializableRuntimeList,
  SerializableRuntimeDict,
  SerializableRuntimeRange,
  SerializableRuntimeSet,
  SerializableRuntimeValue,
} from "../values/serializable-values.js";
import type { RuntimeCaptureSnapshot } from "../scopes/captures.js";
import type {
  RuntimeSettledTimerSnapshot,
  RuntimeTimerHandlerInvocationSnapshot,
} from "../background/timers.js";
import type {
  RuntimeMediaCueInvocationSnapshot,
  RuntimeSettledMediaSnapshot,
} from "../background/media.js";
import type { RuntimePermanentButtonInvocationSnapshot } from "../background/permanent-buttons.js";
import type { RuntimeScriptStorageEntrySnapshot } from "../host-data/script-storage.js";
import { isPlainRecord } from "../values/plain-data.js";

export const RUNTIME_SNAPSHOT_FORMAT = "teasescript-runtime-snapshot";
export const RUNTIME_SNAPSHOT_VERSION = 90;
export const DEFAULT_MAX_CALL_DEPTH = 1024;
export const MAX_SUPPORTED_CALL_DEPTH = 32768;
export const MAX_RUNTIME_SESSION_TIME_MS = Number.MAX_SAFE_INTEGER;
export type RuntimeStatus = "ready" | "running" | "waiting" | "halted" | "failed";

/**
 * A shown message a message handle can still reach: the ID of its `say` event, and the markup source of its current
 * text, as that `say` or the latest `.text` write gave it. Its events carry the parsed text. `removed` marks a message
 * that `remove()` took out of the conversation (#836): its text stays readable, and nothing changes it any more.
 */
export interface RuntimeLiveMessageSnapshot {
  readonly messageId: number;
  readonly sourceText: string;
  readonly removed?: true;
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

/**
 * A supplied argument holds the call's private copy of its value until its parameter is bound; the binding then owns
 * that copy, and the argument keeps only that it was supplied.
 */
export type RuntimeCallArgumentSnapshot =
  | { readonly parameterName: string; readonly supplied: false }
  | {
      readonly parameterName: string;
      readonly supplied: true;
      readonly value: SerializableRuntimeValue;
    }
  | { readonly parameterName: string; readonly supplied: true };

export interface RuntimeParameterStateSnapshot {
  phase: "supplied" | "defaults" | "body";
  parameterIndex: number;
}

/**
 * An expiry block running as an interrupt. The interrupted foreground action is inert and stands still from
 * `startedAtMs`, the scene time the block started; when the block returns normally it is restored with the time it had
 * left (owner decision on #829, 2026-10-11). Only a media wait still ends with its media meanwhile.
 */
export type RuntimeTimerInterruptionSnapshot =
  | {
      readonly timerId: number;
      readonly dueAtMs: number;
      readonly startedAtMs: number;
      readonly suspendedAction: RuntimeInterruptibleActionSnapshot | null;
      /** Whether its timer's current round began when the block started or later, for `TSW018`. */
      currentRoundInBlock: boolean;
      /**
       * The length of the last round of its timer that began when the block started or later and ran out at its
       * deadline during the block, for `TSW018`; otherwise `null`.
       */
      endedRoundMs: number | null;
    }
  /** A media cue block owned by a media record instead of a timer. */
  | {
      readonly mediaId: number;
      readonly dueAtMs: number;
      readonly startedAtMs: number;
      readonly suspendedAction: RuntimeInterruptibleActionSnapshot | null;
    }
  /** The block of a clicked permanent button, which may have been removed since. */
  | {
      readonly buttonId: number;
      readonly dueAtMs: number;
      readonly startedAtMs: number;
      readonly suspendedAction: RuntimeInterruptibleActionSnapshot | null;
    };

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
  /** For an expiry block, the interrupted position, or the continuation once its suspended media wait settled. */
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
  /** Which foreground action produced the result: an interaction, a capture, or a file store. */
  readonly actionKind: "interaction" | "capture" | "fileStore" | "lock";
  readonly actionId: number;
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly destinationTemporary: number;
  /**
   * A capture's result is its captured-media reference, or `null` when its camera was unavailable. A file store's is the
   * Player's answer, a list of the stored files' references or of the read files' Base64, or `null` when it failed; its
   * instruction runs again with it, and its destination stays empty until then.
   */
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
  /**
   * The references of the files in the Player's file store that this session knows, in ascending order: those the host
   * named at Start, photos, image answers, and files the script stored. `toJson` writes these, and only these, as data
   * URLs, and `fileToBase64` reads only these.
   */
  readonly storedFiles: string[];
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
  /** The player profile the host gave at the start: the person fields `playerProfile` reads (V30 §37). */
  readonly playerProfile: RuntimePlayerProfileFieldSnapshot[];
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
  /** The person fields of the player's profile, which `playerProfile` reads (V30 §37); without them it has none. */
  readonly playerProfile?: RuntimePlayerProfileInput;
  /**
   * The references of stored files that the stored values hold, which the host's file store vouches for, so that
   * `toJson` and `fileToBase64` know them as files (V30 §33).
   */
  readonly storedFiles?: readonly string[];
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

export function validSessionTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_RUNTIME_SESSION_TIME_MS
  );
}

export function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 1;
}

/** Whether `value` is a source span: a start and an end position, the end not before the start. */
export function validSpan(value: unknown): value is SourceSpan {
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

export function nonNegativeSafeInteger(value: unknown): value is number {
  // EVIDENCE: validation: Number.isSafeInteger establishes the numeric value before comparison.
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function unsigned32(value: unknown): value is number {
  return nonNegativeSafeInteger(value) && value <= 0xffff_ffff;
}

export function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

/**
 * A persisted runtime array must preserve its complete own-key shape through
 * JSON serialization. Array indexes and `length` are canonical; custom own
 * properties would be silently omitted by JSON.stringify.
 */
export function isCanonicalJsonArray(value: unknown): value is unknown[] {
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

/** Captured references are unique, non-empty, and fit an interaction string; each carries canonical tags. */
/** A reference to a stored file, as a capture or file store gives it: non-empty text that fits an answer. */
export function isStoredFileReference(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && interactionStringFits(value);
}
