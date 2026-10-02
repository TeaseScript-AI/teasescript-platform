import type { RuntimeActionSettlementSnapshot } from "../actions/model.js";
import type { InterpreterEvent } from "../events.js";
import type { RuntimeSnapshot } from "../state.js";

export interface RuntimeOperationResult {
  readonly snapshot: RuntimeSnapshot;
  readonly events: readonly InterpreterEvent[];
  readonly instructionsExecuted: number;
}

export type TimeObservationOutcome =
  | { readonly kind: "observed"; readonly currentSessionTimeMs: number }
  | { readonly kind: "invalidObservation"; readonly message: string };

export interface PendingActionOperationResult<T> extends RuntimeOperationResult {
  readonly outcome: T;
}

export type ActionCompletionOutcome =
  | { readonly kind: "completed"; readonly settlement: RuntimeActionSettlementSnapshot }
  | { readonly kind: "alreadySettled"; readonly settlement: RuntimeActionSettlementSnapshot }
  | { readonly kind: "staleAction"; readonly actionId: number }
  | { readonly kind: "unknownAction"; readonly actionId: number }
  /** The action belongs to a path interrupted by a running timer expiry block. */
  | { readonly kind: "suspendedAction"; readonly actionId: number }
  | {
      readonly kind: "wrongActionKind";
      readonly actionId: number;
      readonly expectedActionKind: "interaction" | "chatPacingGate" | "storageWrite";
      readonly receivedActionKind: string;
    }
  | { readonly kind: "invalidPayload"; readonly message: string }
  /**
   * Scene time has not caught up with the observed time, or a due expiry block must run first. The host runs the
   * engine and then retries with the same action ID if that action is still active.
   */
  | { readonly kind: "executionPending"; readonly actionId: number };
