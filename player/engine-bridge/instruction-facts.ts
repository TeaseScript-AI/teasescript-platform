import { instructionSourcePath, type InstructionPlan } from "../../src/plan/model.js";
import type { PlayerRuntimeSession } from "../runtime-adapter.js";

/** Where an instruction is in the script: its file and its 1-based line. */
export interface InstructionFact {
  readonly path: string;
  readonly line: number;
}

/** The facts of the instructions a publication's view names, by instruction index. */
export type InstructionFacts = Readonly<Record<number, InstructionFact>>;

/** Each plan's instruction facts, made once per instruction: a plan never changes. */
const cache = new WeakMap<InstructionPlan, Map<number, InstructionFact>>();

function factOf(plan: InstructionPlan, index: number): InstructionFact {
  let facts = cache.get(plan);
  if (facts === undefined) cache.set(plan, (facts = new Map()));
  let fact = facts.get(index);
  if (fact === undefined) {
    fact = Object.freeze({
      path: instructionSourcePath(plan, index),
      line: plan.instructions[index]!.span.sl + 1,
    });
    facts.set(index, fact);
  }
  return fact;
}

/**
 * The facts of the instructions `session`'s view names: the owning instruction of each of its media, so the Player can
 * say where a medium it cannot use comes from. Only the session's live actions are visited.
 */
export function instructionFacts(session: PlayerRuntimeSession): InstructionFacts {
  const facts: Record<number, InstructionFact> = {};
  for (const action of session.state.backgroundActions)
    if (action.kind === "media" && !(action.owningInstruction in facts))
      facts[action.owningInstruction] = factOf(session.plan, action.owningInstruction);
  return Object.freeze(facts);
}
