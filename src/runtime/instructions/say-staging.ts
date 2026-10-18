import type { ExpressionPlan, SayInstruction } from "../../plan/model.js";
import {
  changesAnything,
  evaluatedChildren,
  expressionEffects,
} from "../evaluation/effect-facts.js";

const selectiveSays = new WeakMap<SayInstruction, boolean>();

/**
 * Whether a say stages on copies of only the snapshot parts it changes in place, instead of on a deep copy of the
 * whole state: no expression it evaluates can change any other state. It evaluates its value unless its text is
 * prepared, its presentation when it has one, and its pacing when that is an expression. Results are cached per
 * instruction.
 */
export function sayStagesSelectively(instruction: SayInstruction): boolean {
  let known = selectiveSays.get(instruction);
  if (known !== undefined) return known;
  known =
    (instruction.textTemporary !== undefined || changesOnlyGenerator(instruction.value)) &&
    (instruction.presentation === null || changesOnlyGenerator(instruction.presentation)) &&
    (typeof instruction.pacing !== "object" || changesOnlyGenerator(instruction.pacing));
  selectiveSays.set(instruction, known);
  return known;
}

/**
 * Whether evaluating an expression changes no state but the session generator, as `expressionEffects` says of each of
 * its nodes: it reads variables, temporaries, and storage, builds new values, draws, and calls only functions and methods
 * that read copies of their arguments. A conversion that may wait for the Player's file store runs as an instruction
 * before the say, which reads its result, so a call of one in the plan only reads.
 */
function changesOnlyGenerator(root: ExpressionPlan): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (changesAnything(expressionEffects(node))) return false;
    // One by one: a wide list must not depend on the host's argument-spread limit.
    for (const child of evaluatedChildren(node)) pending.push(child);
  }
  return true;
}
