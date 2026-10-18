import type {
  DelayDisplay,
  FileStoreCall,
  InteractionChoiceValue,
  InteractionKind,
  InteractionResultDomain,
  InteractionUiPayload,
  LockCall,
  PlanTag,
} from "../../plan/model.js";
import type { RuntimeTimerSnapshot } from "../timers.js";
import type { RuntimeMediaSnapshot } from "../media.js";
import type { RuntimePermanentButtonSnapshot } from "../permanent-buttons.js";
import type {
  SerializableRuntimeDict,
  SerializableRuntimeList,
  SerializableRuntimeObject,
  SerializableRuntimeValue,
} from "../serializable-values.js";
import type { TemporalAnswer } from "../../interaction-answers.js";

/** Shared serializable pending-action and settlement contracts. */
export interface RuntimeDelayActionSnapshot {
  readonly kind: "delay";
  readonly actionId: number;
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly scopeDepth: number;
  readonly loopDepth: number;
  readonly createdAtMs: number;
  readonly deadlineMs: number;
  readonly expectedCompletion: "time";
  /** Copied from the owning instruction; Players present only `visible` delays. */
  readonly display: DelayDisplay;
  /** Evaluated once from a blocking timer's label; always `null` for `wait`. */
  readonly label: string | null;
  readonly requestEventSequence: number;
}

export interface RuntimeInteractionActionSnapshot {
  readonly kind: "interaction";
  readonly interactionKind: InteractionKind;
  readonly actionId: number;
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly scopeDepth: number;
  readonly loopDepth: number;
  readonly destinationTemporary: number | null;
  readonly expectedResult: InteractionResultDomain;
  readonly target: "standardChat";
  readonly speakerId: number | null;
  readonly ui: InteractionUiPayload;
  /**
   * Scene time when the interaction appeared; a button's or popup's elapsed time counts from here, and its buttons show
   * the date and time presentation in force then.
   */
  readonly createdAtMs: number;
  /**
   * The scene time the interaction stood still while blocks interrupted it, present once positive. Its timeout and a
   * button's or popup's elapsed time leave it out (owner decision on #829, 2026-10-11).
   */
  readonly pausedMs?: number;
  /**
   * How often an expiry block interrupted this password field and it asked again afterwards, present once positive and
   * only for `askPassword`: the Player shows the field anew, without what was typed, also after a block that returned at
   * once.
   */
  readonly resumes?: number;
  /**
   * A button's timeout or a form's time limit; it times out at `createdAtMs + pausedMs + timeoutMs`. Always `null` for
   * other interactions.
   */
  readonly timeoutMs: number | null;
  readonly requestEventSequence: number;
  /** The answers of a form so far; present exactly for a form. */
  readonly form?: RuntimeFormStateSnapshot;
}

/**
 * The answers of an open form, which change with each edit until it is submitted. `values` holds one value per field,
 * in field order: a toggle's boolean, the index of a cycle's selected option, or a typed field's value, `null` while it
 * has none. `editor` is the field the composer edits with its unsubmitted text, or `null`.
 */
export interface RuntimeFormStateSnapshot {
  readonly values: readonly RuntimeFormValue[];
  readonly editor: { readonly fieldId: string; readonly text: string } | null;
}

export type RuntimeFormValue = boolean | number | string | TemporalAnswer | null;

/** What an interaction returns: a choice value, or a form's object, dict, or list of answers. */
export type InteractionResultValue =
  | InteractionChoiceValue
  | SerializableRuntimeObject
  | SerializableRuntimeDict
  | SerializableRuntimeList;

/** The scene time at which a button with a timeout times out, or `null`. */
export function interactionDeadlineMs(action: RuntimeInteractionActionSnapshot): number | null {
  return action.timeoutMs === null ? null : interactionStartMs(action) + action.timeoutMs;
}

/** The scene time an interaction's timeout and elapsed time count from: when it appeared, plus the time it stood still. */
export function interactionStartMs(action: RuntimeInteractionActionSnapshot): number {
  return action.createdAtMs + (action.pausedMs ?? 0);
}

/**
 * The reading time of a paced message, which the script waits for at its `say` as at a `wait`, until it is up or the
 * player skips it.
 */
export interface RuntimeChatPacingGateActionSnapshot {
  readonly kind: "chatPacingGate";
  readonly actionId: number;
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly scopeDepth: number;
  readonly loopDepth: number;
  readonly createdAtMs: number;
  readonly deadlineMs: number;
  readonly skippable: boolean;
  readonly requestEventSequence: number;
}

/**
 * One running or paused asynchronous timer as background timed work. Its action identity spans every round; the
 * script-visible handle uses the separate `timerId`. Only time and script operations settle it; the Player cannot.
 */
export interface RuntimeTimerActionSnapshot {
  readonly kind: "timer";
  readonly actionId: number;
  /** The `startTimer` instruction, for provenance and source location. */
  readonly owningInstruction: number;
  readonly createdAtMs: number;
  readonly requestEventSequence: number;
  readonly timer: RuntimeTimerSnapshot;
}

/**
 * One audio or video playback as background work. Its action identity spans every pass; the script-visible handle
 * uses the separate `mediaId`. Player load and progress reports target the media ID; `completeAction` cannot.
 */
export interface RuntimeMediaActionSnapshot {
  readonly kind: "media";
  readonly actionId: number;
  /** The `playMedia` instruction, for provenance and source location. */
  readonly owningInstruction: number;
  readonly createdAtMs: number;
  readonly requestEventSequence: number;
  readonly media: RuntimeMediaSnapshot;
}

/**
 * One shown permanent button as background work, which waits for clicks until it is removed. Its action identity
 * spans every click; the script-visible identifier uses the separate `buttonId`. A Player click targets the button ID
 * through `pressPermanentButton`; `completeAction` cannot.
 */
export interface RuntimePermanentButtonActionSnapshot {
  readonly kind: "permanentButton";
  readonly actionId: number;
  /** The `showPermanentButton` instruction, for provenance and source location. */
  readonly owningInstruction: number;
  readonly createdAtMs: number;
  readonly requestEventSequence: number;
  readonly button: RuntimePermanentButtonSnapshot;
}

/**
 * The script waits on media: an async play until the Player reports the load result, a blocking play until playback
 * finishes, stops, or fails. Like a delay it is interruptible and settles through runtime work, never through
 * `completeAction`.
 */
export interface RuntimeMediaPlaybackActionSnapshot {
  readonly kind: "mediaPlayback";
  readonly actionId: number;
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly scopeDepth: number;
  readonly loopDepth: number;
  readonly createdAtMs: number;
  readonly mediaId: number;
  readonly until: "loaded" | "ended";
  readonly requestEventSequence: number;
}

/**
 * A `save` or `delete` waits for the host to acknowledge persisting it; the session's storage view changes only after
 * a `stored` acknowledgement. Timer and media blocks wait until it settles.
 */
export interface RuntimeStorageWriteActionSnapshot {
  readonly kind: "storageWrite";
  readonly actionId: number;
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly scopeDepth: number;
  readonly loopDepth: number;
  readonly createdAtMs: number;
  readonly key: string;
  /** The value to store, or `null` to remove the key. */
  readonly value: SerializableRuntimeValue;
  readonly requestEventSequence: number;
}

/**
 * `takePhoto()` waits for the Player to capture a still from the session camera. The Player completes it with the
 * captured image reference or reports the camera unavailable, which yields `null`. Expiry blocks wait until it
 * settles, so it is never suspended.
 */
export interface RuntimeCaptureActionSnapshot {
  readonly kind: "capture";
  readonly capture: "photo";
  /**
   * The validated tags of `takePhoto(tags: …)`, in name order, which a captured photo joins the image catalog with;
   * `null` without `tags:`.
   */
  readonly tags: readonly PlanTag[] | null;
  readonly actionId: number;
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly scopeDepth: number;
  readonly loopDepth: number;
  readonly destinationTemporary: number;
  readonly createdAtMs: number;
  readonly requestEventSequence: number;
}

/** A file the Player's file store keeps: its type, from its first bytes, and its bytes as standard Base64. */
export interface RuntimeFileToStore {
  readonly type: string;
  readonly base64: string;
}

/**
 * A `fileStore` instruction waits while the Player stores files, reads stored ones, or hashes one (V30 §13 and §33).
 * The Player completes it with the references of the stored files, the Base64 of the read ones, the SHA-256 of the
 * hashed one, or a failure; the instruction then runs again with that answer, so its continuation is itself. Expiry
 * blocks wait until it settles, so it is never suspended.
 */
export interface RuntimeFileStoreActionSnapshot {
  readonly kind: "fileStore";
  readonly actionId: number;
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly scopeDepth: number;
  readonly loopDepth: number;
  /** Where the instruction puts its result once it runs again. */
  readonly destinationTemporary: number;
  readonly createdAtMs: number;
  readonly requestEventSequence: number;
  /** Whether the Player stores `files`, or reads or hashes `references`; the other list is empty. */
  readonly operation: "store" | "read" | "hash";
  /** The files to store, each kept once. */
  readonly files: readonly RuntimeFileToStore[];
  /** The stored files to read or hash, each named once. */
  readonly references: readonly string[];
}

/** What the Player does for a call of a `fileStore` instruction (V30 §13 and §33). */
export function fileStoreOperation(
  call: FileStoreCall,
): RuntimeFileStoreActionSnapshot["operation"] {
  if (call === "fileFromBase64" || call === "fromJson") return "store";
  return call === "hashFile" ? "hash" : "read";
}

/**
 * Why the unlock dialog asks again: the typed password or key did not open, or the passed time lock could not be
 * fetched.
 */
export type RuntimeLockNotice = "wrongPassword" | "wrongKey" | "unreachable";

/** An opener the player chooses in the lock dialog: written `true`, or each without any written (V30 §13). */
export type RuntimeLockChoice = "timeLock" | "password" | "publicKey";

/**
 * How a step of a lock ended: `locked` or `opened` with the result, `notOpened` (the default), `unreadable` or `failed`
 * (a runtime error), `ask` (the Player must ask the player), or, for a dialog, `submitted` or `cancelled` (the default).
 */
export type RuntimeLockOutcome =
  "locked" | "opened" | "notOpened" | "unreadable" | "failed" | "ask" | "submitted" | "cancelled";

/**
 * A `lock` instruction waits while the Player locks or opens text or a stored file (V30 §13). In its `work` phase the
 * Player locks or opens with what it has, without the player; nothing interrupts it, so a due block runs once it
 * settles. In its `ask` phase the Player's dialog asks the player first, like an interaction: a due block interrupts it,
 * and it is presented again afterwards. Each answer is handed off to the instruction, which runs again, either to give
 * the result or to wait in the next phase, so its continuation is itself.
 */
export interface RuntimeLockActionSnapshot {
  readonly kind: "lock";
  readonly actionId: number;
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly scopeDepth: number;
  readonly loopDepth: number;
  /** Where the instruction puts its result once it runs again with the last answer. */
  readonly destinationTemporary: number;
  readonly createdAtMs: number;
  readonly requestEventSequence: number;
  readonly call: LockCall;
  readonly phase: "work" | "ask";
  /** `encryptText`'s text, `decryptText`'s lock as standard Base64, or the stored file of the file calls. */
  readonly value: string;
  /** The password text written in `password:`, or `null`. */
  readonly password: string | null;
  /**
   * An encrypt call's time lock: the moment written in `timeLock:`, when it opens by itself, in epoch milliseconds, or
   * `null`; while the lock dialog asks for a time lock, the moment it suggests, 7 days from now. `null` for a decrypt
   * call and for a time lock that the player chose in the dialog before this step.
   */
  readonly timeLockMs: number | null;
  /**
   * The openers of an encrypt call that the player chooses in its lock dialog, which asks in the `ask` step, and whose
   * answer the `work` step after it locks with; empty for any other step.
   */
  readonly choices: readonly RuntimeLockChoice[];
  /** The `ask` action whose dialog or password field the player answered just before this `work` step, or `null`. */
  readonly dialogActionId: number | null;
  /**
   * The call's `password: askPassword(...)`: the Player's password field, with its `hint:` or none, asks in the `ask`
   * step, and the `work` step uses what was typed in it. `null` for any other call.
   */
  readonly passwordField: { readonly hint: string | null } | null;
  /** An encrypt call's written public keys, each trimmed; empty for any other call. */
  readonly publicKeys: readonly string[];
  /** A decrypt call's written `key:`, the unlock key sent back for a public key opener, or `null`. */
  readonly key: string | null;
  /** Why the unlock dialog asks again, or `null`. */
  readonly notice: RuntimeLockNotice | null;
  /**
   * How often an expiry block interrupted this `ask` step and its dialog asked again afterwards, which the Player shows
   * anew, without what was typed; always 0 for a `work` step.
   */
  readonly resumes: number;
}

/** Why the Player had no usable camera for a capture; every reason yields `null` and the script continues. */
export type CaptureUnavailableReason =
  "unconfigured" | "denied" | "notFound" | "busy" | "unsupported" | "revoked" | "failed";

export const CAPTURE_UNAVAILABLE_REASONS: readonly CaptureUnavailableReason[] = [
  "unconfigured",
  "denied",
  "notFound",
  "busy",
  "unsupported",
  "revoked",
  "failed",
];

/** Timers and media are background work; a media wait blocks the foreground path. */
export type RuntimeForegroundActionSnapshot =
  | RuntimeDelayActionSnapshot
  | RuntimeInteractionActionSnapshot
  | RuntimeChatPacingGateActionSnapshot
  | RuntimeMediaPlaybackActionSnapshot
  | RuntimeStorageWriteActionSnapshot
  | RuntimeCaptureActionSnapshot
  | RuntimeFileStoreActionSnapshot
  | RuntimeLockActionSnapshot;

export type RuntimePendingActionSnapshot =
  | RuntimeDelayActionSnapshot
  | RuntimeInteractionActionSnapshot
  | RuntimeChatPacingGateActionSnapshot
  | RuntimeMediaPlaybackActionSnapshot
  | RuntimeStorageWriteActionSnapshot
  | RuntimeCaptureActionSnapshot
  | RuntimeFileStoreActionSnapshot
  | RuntimeLockActionSnapshot
  | RuntimeTimerActionSnapshot
  | RuntimeMediaActionSnapshot
  | RuntimePermanentButtonActionSnapshot;

/**
 * The completion events that an active action must still be able to publish, by kind: an interaction its transcript
 * entry and its completion, a storage write or a capture the warning of a failed write or an unavailable camera and its
 * completion, any other action its completion. Every kind has its entry, so a new kind must decide.
 */
const ACTION_COMPLETION_EVENTS: { readonly [K in RuntimePendingActionSnapshot["kind"]]: number } = {
  delay: 1,
  interaction: 2,
  chatPacingGate: 1,
  mediaPlayback: 1,
  storageWrite: 2,
  capture: 2,
  fileStore: 1,
  lock: 1,
  timer: 1,
  media: 1,
  permanentButton: 1,
};

/** Completion events that an active action must still be able to publish. */
export function requiredActionCompletionEvents(
  action: RuntimePendingActionSnapshot | null,
): number {
  return action === null ? 0 : ACTION_COMPLETION_EVENTS[action.kind];
}

/**
 * The completion events that an action of checkpoint data that is not validated yet must still be able to publish, or
 * `null` for a kind that no action has.
 */
export function actionRecordCompletionEvents(action: Record<string, unknown>): number | null {
  return isPendingActionKind(action.kind) ? ACTION_COMPLETION_EVENTS[action.kind] : null;
}

function isPendingActionKind(kind: unknown): kind is RuntimePendingActionSnapshot["kind"] {
  return typeof kind === "string" && Object.hasOwn(ACTION_COMPLETION_EVENTS, kind);
}

/**
 * Published with `actionCompleted` when a timer finishes or stops. It is not retained as `lastSettlement` because no
 * Player completion can target a timer, so there is nothing to replay.
 */
export interface RuntimeTimerSettlementSnapshot {
  readonly actionId: number;
  readonly actionKind: "timer";
  readonly settlementKind: "finished" | "stopped";
  readonly timerId: number;
  readonly owningInstruction: number;
  readonly requestEventSequence: number;
  readonly completionEventSequence: number;
  readonly completedAtMs: number;
}

/**
 * Published with `actionCompleted` when media finishes or stops. Like a timer settlement it is not retained as
 * `lastSettlement`.
 */
export interface RuntimeMediaSettlementSnapshot {
  readonly actionId: number;
  readonly actionKind: "media";
  readonly settlementKind: "finished" | "stopped";
  readonly mediaId: number;
  readonly owningInstruction: number;
  readonly requestEventSequence: number;
  readonly completionEventSequence: number;
  readonly completedAtMs: number;
}

/**
 * Published with `actionCompleted` when a permanent button is removed. Like a timer settlement it is not retained as
 * `lastSettlement`.
 */
export interface RuntimePermanentButtonSettlementSnapshot {
  readonly actionId: number;
  readonly actionKind: "permanentButton";
  readonly settlementKind: "removed";
  readonly buttonId: number;
  readonly owningInstruction: number;
  readonly requestEventSequence: number;
  readonly completionEventSequence: number;
  readonly completedAtMs: number;
}

/** A settled media wait; `outcome` records why the script continued. */
export interface RuntimeMediaPlaybackSettlementSnapshot {
  readonly actionId: number;
  readonly actionKind: "mediaPlayback";
  readonly settlementKind: "completed";
  readonly outcome: "loaded" | "finished" | "stopped" | "failed";
  readonly mediaId: number;
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly requestEventSequence: number;
  readonly completionEventSequence: number;
  readonly completedAtMs: number;
}

/** A settled storage write; `failed` kept the previous stored value. */
export interface RuntimeStorageWriteSettlementSnapshot {
  readonly actionId: number;
  readonly actionKind: "storageWrite";
  readonly settlementKind: "completed";
  readonly outcome: "stored" | "failed";
  readonly key: string;
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly requestEventSequence: number;
  readonly completionEventSequence: number;
  readonly completedAtMs: number;
}

export interface RuntimeDelayActionSettlementSnapshot {
  readonly actionId: number;
  readonly actionKind: "delay";
  readonly settlementKind: "completed";
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly requestEventSequence: number;
  readonly completionEventSequence: number;
  readonly deadlineMs: number;
  readonly completedAtMs: number;
}

/**
 * A completed interaction, or a button that reached its timeout. A timeout publishes no player transcript, so its
 * transcript sequence and text are `null`.
 */
export interface RuntimeInteractionActionSettlementSnapshot {
  readonly actionId: number;
  readonly actionKind: "interaction";
  readonly interactionKind: InteractionKind;
  readonly settlementKind: "completed" | "timedOut";
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly destinationTemporary: number | null;
  readonly requestEventSequence: number;
  readonly transcriptEventSequence: number | null;
  readonly completionEventSequence: number;
  /**
   * `null` for a button or popup used as a statement; a choice may also return `null` as an option's value, and a
   * button or popup used as a value records its elapsed waiting time.
   */
  readonly result: InteractionResultValue;
  readonly transcriptText: string | null;
  /** The UI the player answered, so the settlement validates against what was presented. */
  readonly ui: InteractionUiPayload;
  /**
   * Only a form's: for each field, the position of the option a cycle showed, else `null`; `null` as a whole for a form
   * that returned `null`. Options of one cycle may share a value, so the result alone cannot tell which one was shown.
   */
  readonly shownOptions?: readonly (number | null)[] | null;
}

export interface RuntimeChatPacingGateSettlementSnapshot {
  readonly actionId: number;
  readonly actionKind: "chatPacingGate";
  /** A reading time ends when its time is up or when the player skips it. */
  readonly settlementKind: "completed" | "skipped";
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly requestEventSequence: number;
  readonly completionEventSequence: number;
  readonly deadlineMs: number;
  readonly completedAtMs: number;
}

/** A settled capture, retained so a repeated Player completion replays instead of capturing twice. */
export interface RuntimeCaptureActionSettlementSnapshot {
  readonly actionId: number;
  readonly actionKind: "capture";
  readonly capture: "photo";
  readonly settlementKind: "completed";
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly destinationTemporary: number;
  readonly requestEventSequence: number;
  /** The developer warning of an unavailable camera; `null` for a captured photo. */
  readonly warningEventSequence: number | null;
  readonly completionEventSequence: number;
  readonly completedAtMs: number;
  /** The captured image reference, or `null` when the camera was unavailable. */
  readonly result: string | null;
  readonly unavailableReason: CaptureUnavailableReason | null;
}

/**
 * A settled file store, retained so a repeated Player completion replays instead of storing or reading twice. The
 * answer itself is handed off to the instruction, which runs again; only the references of stored files are kept here.
 */
export interface RuntimeFileStoreActionSettlementSnapshot {
  readonly actionId: number;
  readonly actionKind: "fileStore";
  readonly settlementKind: "completed";
  /** `stored`, `read`, or `hashed` as asked, or `failed` when the Player could not. */
  readonly outcome: "stored" | "read" | "hashed" | "failed";
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly destinationTemporary: number;
  readonly requestEventSequence: number;
  readonly completionEventSequence: number;
  readonly completedAtMs: number;
  /** The references of the stored files, in the order of the request; empty unless `stored`. */
  readonly references: readonly string[];
}

/**
 * A settled step of a lock, retained so a repeated Player completion replays instead of locking or opening twice. Its
 * answer is handed off to the instruction, which runs again; only the stored file it kept is recorded here.
 */
export interface RuntimeLockActionSettlementSnapshot {
  readonly actionId: number;
  readonly actionKind: "lock";
  readonly settlementKind: "completed";
  readonly outcome: RuntimeLockOutcome;
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly destinationTemporary: number;
  readonly requestEventSequence: number;
  readonly completionEventSequence: number;
  readonly completedAtMs: number;
  /** The stored file a lock or an opening kept: the locked file, or the opened one; `null` otherwise. */
  readonly file: string | null;
}

export type RuntimeActionSettlementSnapshot =
  | RuntimeDelayActionSettlementSnapshot
  | RuntimeInteractionActionSettlementSnapshot
  | RuntimeChatPacingGateSettlementSnapshot
  | RuntimeMediaPlaybackSettlementSnapshot
  | RuntimeStorageWriteSettlementSnapshot
  | RuntimeCaptureActionSettlementSnapshot
  | RuntimeFileStoreActionSettlementSnapshot
  | RuntimeLockActionSettlementSnapshot;

const LOCK_NOTICES: readonly RuntimeLockNotice[] = ["wrongPassword", "wrongKey", "unreachable"];

export function isLockNotice(value: unknown): value is RuntimeLockNotice {
  return LOCK_NOTICES.some((notice) => notice === value);
}

const LOCK_OUTCOMES: readonly RuntimeLockOutcome[] = [
  "locked",
  "opened",
  "notOpened",
  "unreadable",
  "failed",
  "ask",
  "submitted",
  "cancelled",
];

export function isLockOutcome(value: unknown): value is RuntimeLockOutcome {
  return LOCK_OUTCOMES.some((outcome) => outcome === value);
}
