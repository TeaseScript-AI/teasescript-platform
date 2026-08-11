import type {
  InteractionResultDomain,
  InteractionUiPayload,
} from "../../plan/model.js";

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
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly speaker: import("../events.js").OutputSpeaker | null;
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

export type RuntimePendingActionSnapshot = RuntimeDelayActionSnapshot | RuntimeInteractionActionSnapshot | RuntimeChatPacingGateActionSnapshot;

/** Completion events that an active action must still be able to publish. */
export function requiredActionCompletionEvents(
  action: RuntimePendingActionSnapshot | null,
): number {
  if (action?.kind === "interaction") return 2;
  if (action?.kind === "delay" || action?.kind === "chatPacingGate") return 1;
  return 0;
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
  readonly settlementKind: "completed" | "skipped" | "consumedByForegroundInteraction" | "supersededByInstantOutput";
  readonly owningInstruction: number;
  readonly continuationInstruction: number;
  readonly requestEventSequence: number;
  readonly completionEventSequence: number;
  readonly deadlineMs: number;
  readonly completedAtMs: number;
  /** The owning say instruction released by this foreground settlement, if any. */
  readonly releasedPreparedOutputInstruction: number | null;
}

export type RuntimeActionSettlementSnapshot = RuntimeDelayActionSettlementSnapshot | RuntimeInteractionActionSettlementSnapshot | RuntimeChatPacingGateSettlementSnapshot;
