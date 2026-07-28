export {
  type RuntimeActionSettlementSnapshot,
  type RuntimeDelayActionSettlementSnapshot,
  type RuntimeInteractionActionSettlementSnapshot,
} from "../state.js";

export type ActionReplayClassification = "completed" | "alreadySettled" | "staleAction" | "unknownAction";
