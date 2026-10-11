import { type InstructionPlan, mainSourceSpan } from "../../plan/model.js";
import type {
  RuntimeActionSettlementSnapshot,
  RuntimeChatPacingGateActionSnapshot,
  RuntimeChatPacingGateSettlementSnapshot,
} from "../actions/model.js";
import type { ActionCompletedEvent, InterpreterEvent } from "../events.js";
import type { RuntimeSnapshot } from "../state.js";
import { assertEventSequenceCapacity, copySpan, takeSequence } from "./support.js";

export function settleBackgroundPacingGate(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  action: RuntimeChatPacingGateActionSnapshot,
  settlementKind: RuntimeChatPacingGateSettlementSnapshot["settlementKind"],
  events: InterpreterEvent[],
): RuntimeActionSettlementSnapshot {
  assertEventSequenceCapacity(snapshot, 1);
  const index = snapshot.backgroundActions.indexOf(action);
  if (index < 0) throw new Error("Background pacing gate is not active.");
  snapshot.backgroundActions.splice(index, 1);
  const completionEventSequence = takeSequence(snapshot);
  const settlement: RuntimeActionSettlementSnapshot = Object.freeze({
    actionId: action.actionId,
    actionKind: "chatPacingGate",
    settlementKind,
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
    requestEventSequence: action.requestEventSequence,
    completionEventSequence,
    deadlineMs: action.deadlineMs,
    completedAtMs: snapshot.currentSessionTimeMs,
    releasedPreparedOutputInstruction: null,
  });
  snapshot.lastSettlement = settlement;
  const span = plan.instructions[action.owningInstruction]?.span ?? mainSourceSpan(plan);
  events.push(
    Object.freeze({
      kind: "actionCompleted",
      sequence: completionEventSequence,
      settlement,
      span: copySpan(span),
    } satisfies ActionCompletedEvent),
  );
  return settlement;
}

/**
 * What the player sees or hears waits for the reading time of the message before it, like a later `say` (owner
 * decision, 2026-10-11): an active background pacing gate becomes the foreground action without prepared output, and
 * the waiting instruction runs again once it settles. Returns whether it waits.
 */
export function holdForPacing(snapshot: RuntimeSnapshot): boolean {
  const gate = snapshot.backgroundActions.find(
    (action): action is RuntimeChatPacingGateActionSnapshot => action.kind === "chatPacingGate",
  );
  if (gate === undefined) return false;
  snapshot.backgroundActions.splice(snapshot.backgroundActions.indexOf(gate), 1);
  snapshot.foregroundAction = Object.freeze({ ...gate, preparedOutput: null });
  snapshot.status = "waiting";
  return true;
}
