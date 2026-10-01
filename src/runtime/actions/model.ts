import type { MessagePresentation } from "../../message-presentation.js";
import type {
  DelayDisplay,
  InteractionResultDomain,
  InteractionUiPayload,
} from "../../plan/model.js";
import type { MessageMarkup } from "../../message-markup.js";
import type { RuntimeTimerSnapshot } from "../timers.js";

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
  readonly interactionKind: "button" | "text" | "number" | "choice";
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
  readonly requestEventSequence: number;
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

/** Timers are background work only; they never block the foreground path. */
export type RuntimeForegroundActionSnapshot =
  | RuntimeDelayActionSnapshot
  | RuntimeInteractionActionSnapshot
  | RuntimeChatPacingGateActionSnapshot;

export type RuntimePendingActionSnapshot =
  | RuntimeDelayActionSnapshot
  | RuntimeInteractionActionSnapshot
  | RuntimeChatPacingGateActionSnapshot
  | RuntimeTimerActionSnapshot;

/** Completion events that an active action must still be able to publish. */
export function requiredActionCompletionEvents(action: { readonly kind?: unknown } | null): number {
  if (action?.kind === "interaction") return 2;
  if (action?.kind === "delay" || action?.kind === "chatPacingGate" || action?.kind === "timer")
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

export interface RuntimeInteractionActionSettlementSnapshot {
  readonly actionId: number;
  readonly actionKind: "interaction";
  readonly interactionKind: "button" | "text" | "number" | "choice";
  readonly settlementKind: "completed";
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly ownerCallFrameId: number | null;
  readonly destinationTemporary: number | null;
  readonly requestEventSequence: number;
  readonly transcriptEventSequence: number;
  readonly completionEventSequence: number;
  readonly result: string | number | null;
  readonly transcriptText: string;
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

export type RuntimeActionSettlementSnapshot =
  | RuntimeDelayActionSettlementSnapshot
  | RuntimeInteractionActionSettlementSnapshot
  | RuntimeChatPacingGateSettlementSnapshot;
