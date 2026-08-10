import type { InstructionPlan } from "../../plan/model.js";
import type {
  RuntimeDelayActionSnapshot,
  RuntimeInteractionActionSnapshot,
} from "../actions/model.js";
import type { RuntimeTerminalContinuationHandoffSnapshot } from "../state.js";

/**
 * A terminal foreground action releases root completion to a later normal
 * runtime entry. This is deliberately independent of bounded settlement
 * replay, because unrelated background work may settle first.
 */
export function terminalContinuationHandoffFor(
  plan: InstructionPlan,
  action: RuntimeDelayActionSnapshot | RuntimeInteractionActionSnapshot,
): RuntimeTerminalContinuationHandoffSnapshot | null {
  if (
    action.ownerCallFrameId !== null ||
    action.continuationInstruction !== plan.rootEndInstruction
  ) return null;

  const instruction = plan.instructions[action.owningInstruction];
  const matchesTerminalInstruction =
    (action.kind === "delay" && instruction?.kind === "wait") ||
    (
      action.kind === "interaction" &&
      instruction?.kind === "interaction" &&
      instruction.interactionKind === "button" &&
      instruction.destinationTemporary === null
    );
  if (!matchesTerminalInstruction) return null;

  return Object.freeze({
    actionId: action.actionId,
    actionKind: action.kind,
    owningInstruction: action.owningInstruction,
    continuationInstruction: action.continuationInstruction,
  });
}
