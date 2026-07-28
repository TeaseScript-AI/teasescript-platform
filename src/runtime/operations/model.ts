import type { RuntimeActionSettlementSnapshot } from "../actions/model.js";
import type { InterpreterEvent } from "../events.js";
import type { RuntimeSnapshot } from "../state.js";

export interface RuntimeOperationResult {
  readonly snapshot: RuntimeSnapshot;
  readonly events: readonly InterpreterEvent[];
  readonly instructionsExecuted: number;
}

export type TimeObservationOutcome =
  | { readonly kind: "observed"; readonly currentSessionTimeMs: number; readonly completion: RuntimeActionSettlementSnapshot | null }
  | { readonly kind: "invalidObservation"; readonly message: string };

export interface PendingActionOperationResult<T> extends RuntimeOperationResult { readonly outcome: T; }

export type ActionCompletionOutcome =
  | { readonly kind: "completed"; readonly settlement: RuntimeActionSettlementSnapshot }
  | { readonly kind: "alreadySettled"; readonly settlement: RuntimeActionSettlementSnapshot }
  | { readonly kind: "staleAction"; readonly actionId: number }
  | { readonly kind: "unknownAction"; readonly actionId: number }
  | { readonly kind: "wrongActionKind"; readonly actionId: number; readonly expectedActionKind: "delay" | "interaction"; readonly receivedActionKind: string }
  | { readonly kind: "invalidPayload"; readonly message: string }
  | { readonly kind: "notDue"; readonly actionId: number; readonly currentSessionTimeMs: number; readonly deadlineMs: number };
