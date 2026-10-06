import type { MessagePresentation } from "../../message-presentation.js";
import type {
  DelayDisplay,
  InteractionChoiceValue,
  InteractionKind,
  InteractionResultDomain,
  InteractionUiPayload,
  PlanTag,
} from "../../plan/model.js";
import type { MessageMarkup } from "../../message-markup.js";
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
   * Scene time when the interaction appeared; a button's elapsed time counts from here, and its buttons show the date
   * and time presentation in force then.
   */
  readonly createdAtMs: number;
  /**
   * A button's timeout or a form's time limit; it times out at `createdAtMs + timeoutMs`. Always `null` for other
   * interactions.
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
  return action.timeoutMs === null ? null : action.createdAtMs + action.timeoutMs;
}

export interface RuntimePreparedSayOutputSnapshot {
  readonly presentation: MessagePresentation;
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly speaker: import("../events.js").OutputSpeaker | null;
  readonly content: MessageMarkup;
  readonly text: string;
  readonly durationMs: number;
  readonly skippable: boolean;
}

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
  readonly preparedOutput: RuntimePreparedSayOutputSnapshot | null;
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
  | RuntimeCaptureActionSnapshot;

export type RuntimePendingActionSnapshot =
  | RuntimeDelayActionSnapshot
  | RuntimeInteractionActionSnapshot
  | RuntimeChatPacingGateActionSnapshot
  | RuntimeMediaPlaybackActionSnapshot
  | RuntimeStorageWriteActionSnapshot
  | RuntimeCaptureActionSnapshot
  | RuntimeTimerActionSnapshot
  | RuntimeMediaActionSnapshot
  | RuntimePermanentButtonActionSnapshot;

/** Completion events that an active action must still be able to publish. */
export function requiredActionCompletionEvents(action: { readonly kind?: unknown } | null): number {
  // An interaction publishes its transcript entry; a failed storage write or an unavailable capture its warning.
  if (
    action?.kind === "interaction" ||
    action?.kind === "storageWrite" ||
    action?.kind === "capture"
  )
    return 2;
  if (
    action?.kind === "delay" ||
    action?.kind === "chatPacingGate" ||
    action?.kind === "timer" ||
    action?.kind === "media" ||
    action?.kind === "mediaPlayback" ||
    action?.kind === "permanentButton"
  )
    return 1;
  return 0;
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
   * `null` for a button used as a statement; a choice may also return `null` as an option's value, and a button used
   * as a value records its elapsed waiting time.
   */
  readonly result: InteractionResultValue;
  readonly transcriptText: string | null;
  /** The UI the player answered, so the settlement validates against what was presented. */
  readonly ui: InteractionUiPayload;
}

export interface RuntimeChatPacingGateSettlementSnapshot {
  readonly actionId: number;
  readonly actionKind: "chatPacingGate";
  readonly settlementKind:
    "completed" | "skipped" | "consumedByForegroundInteraction" | "supersededByInstantOutput";
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly requestEventSequence: number;
  readonly completionEventSequence: number;
  readonly deadlineMs: number;
  readonly completedAtMs: number;
  /** The owning say instruction released by this foreground settlement, if any. */
  readonly releasedPreparedOutputInstruction: number | null;
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

export type RuntimeActionSettlementSnapshot =
  | RuntimeDelayActionSettlementSnapshot
  | RuntimeInteractionActionSettlementSnapshot
  | RuntimeChatPacingGateSettlementSnapshot
  | RuntimeMediaPlaybackSettlementSnapshot
  | RuntimeStorageWriteSettlementSnapshot
  | RuntimeCaptureActionSettlementSnapshot;
