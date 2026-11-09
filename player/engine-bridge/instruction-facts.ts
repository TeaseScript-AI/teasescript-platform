import { instructionSourcePath, type InstructionPlan } from "../../src/plan/model.js";
import type { PlayerRuntimeSession } from "../runtime/runtime-adapter.js";

/** Where an instruction is in the script, and what it is, as the Player's readers name it. */
export interface InstructionFact {
  /** Its file's package path. */
  readonly path: string;
  /** Its 1-based line, `0` past the plan's end (an ended session's next instruction, whose line is never read). */
  readonly line: number;
  /** Its plan kind, except that a `wait` instruction gives its command: `"wait"` or `"timer"`; `"end"` past the end. */
  readonly kind: string;
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
    const instruction = plan.instructions[index];
    fact = Object.freeze({
      path: instructionSourcePath(plan, index),
      line: instruction === undefined ? 0 : instruction.span.sl + 1,
      kind:
        instruction === undefined
          ? "end"
          : instruction.kind === "wait"
            ? instruction.command
            : instruction.kind,
    });
    facts.set(index, fact);
  }
  return fact;
}

/**
 * The facts of the instructions `session`'s view names. Every view names the owning instruction of each of its media,
 * of its foreground action and of its suspended one: where a medium the Player cannot use comes from, and what Debug's
 * countdown waits for. With the call view (`calls`), it also names the next instruction, each background timer's owner
 * and each call's return instruction, which Debug's Now view and the error dialog's call chain show. Only the session's
 * live actions and calls are visited.
 */
export function instructionFacts(session: PlayerRuntimeSession, calls: boolean): InstructionFacts {
  const { plan, state } = session;
  const facts: Record<number, InstructionFact> = {};
  const name = (index: number) => {
    if (!(index in facts)) facts[index] = factOf(plan, index);
  };
  for (const action of state.backgroundActions)
    if (action.kind === "media" || (calls && action.kind === "timer"))
      name(action.owningInstruction);
  if (state.foregroundAction !== null) name(state.foregroundAction.owningInstruction);
  if (state.suspendedAction !== null) name(state.suspendedAction.owningInstruction);
  if (calls) {
    name(state.nextInstruction);
    for (const call of state.calls) name(call.returnInstruction);
  }
  return Object.freeze(facts);
}
