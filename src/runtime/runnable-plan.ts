import type { CompiledFunctionDefinition, Instruction, InstructionPlan } from "../plan/model.js";

/**
 * The part of a plan that a session can run: `main.tease` with its functions and handlers, and every global function
 * with its handlers (ADR 0022 §3). Until `goto` and `call` reach other files, a snapshot that refers to anything else is
 * malformed, so every check of a snapshot sees the plan through this view: the other instructions and functions are
 * absent, while the runnable ones keep their indexes and IDs.
 */
export interface RunnablePlan extends Omit<InstructionPlan, "instructions" | "functions"> {
  readonly instructions: readonly (Instruction | undefined)[];
  readonly functions: readonly (CompiledFunctionDefinition | undefined)[];
}

/** Builds the view per validation, like the other analyses of external plan data. */
export function runnablePlan(plan: InstructionPlan): RunnablePlan {
  const main = plan.files[0]!;
  const runnable = (definition: CompiledFunctionDefinition): boolean =>
    definition.global || definition.endInstruction <= main.endInstruction;
  if (plan.files.length === 1) return plan;
  const instructions = new Array<Instruction | undefined>(plan.instructions.length).fill(undefined);
  const copy = (start: number, end: number): void => {
    for (let index = start; index < end; index += 1) instructions[index] = plan.instructions[index];
  };
  copy(main.startInstruction, main.rootEndInstruction);
  const functions = plan.functions.map((definition) => {
    if (!runnable(definition)) return undefined;
    copy(definition.entryInstruction, definition.endInstruction);
    return definition;
  });
  return { ...plan, instructions, functions };
}
