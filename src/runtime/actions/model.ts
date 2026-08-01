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

export type RuntimePendingActionSnapshot = RuntimeDelayActionSnapshot | RuntimeInteractionActionSnapshot;

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
  /** Canonical action definition retained after prepared payload temporaries clear. */
  readonly ui: InteractionUiPayload;
}

export type RuntimeActionSettlementSnapshot = RuntimeDelayActionSettlementSnapshot | RuntimeInteractionActionSettlementSnapshot;
