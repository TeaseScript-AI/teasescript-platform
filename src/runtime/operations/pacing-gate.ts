import type { InstructionPlan } from "../../plan/model.js";
import type {
  RuntimeActionSettlementSnapshot,
  RuntimeChatPacingGateActionSnapshot,
} from "../actions/model.js";
import type { ActionCompletedEvent, InterpreterEvent } from "../events.js";
import type { RuntimeSnapshot } from "../state.js";
import { assertEventSequenceCapacity, copySpan, takeSequence } from "./support.js";

export function settleBackgroundPacingGate(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  action: RuntimeChatPacingGateActionSnapshot,
  settlementKind: "completed" | "skipped" | "consumedByForegroundInteraction" | "supersededByInstantOutput",
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
  });
  snapshot.lastSettlement = settlement;
  const span = plan.instructions[action.owningInstruction]?.span ?? plan.sourceSpan;
  events.push(Object.freeze({
    kind: "actionCompleted",
    sequence: completionEventSequence,
    settlement,
    span: copySpan(span),
  } satisfies ActionCompletedEvent));
  return settlement;
}
