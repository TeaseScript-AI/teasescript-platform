import type { Instruction, InstructionPlan } from "../../../plan/model.js";
import { speakerTemporaries } from "../../evaluator.js";
import { snapshotValidationAnalysis } from "../../snapshot/snapshot-validation-analysis.js";
import { compileInstruction, type InstructionScope, type NativeStep } from "./instructions.js";
import { GlobalNames, NativePreparationError, ScopeTracker } from "./scopes.js";

/** A plan prepared for the native engine: a closure for each instruction, and the plan's global names. */
export interface NativeProgram {
  /** By instruction index. */
  readonly steps: readonly NativeStep[];
  readonly globals: GlobalNames;
}

const programs = new WeakMap<InstructionPlan, NativeProgram>();

/**
 * Prepares a validated plan once; every session of the plan shares the result, which holds no session data. A plan the
 * native engine cannot run whole fails here with `NativePreparationError`: one with more than one file, a block, a
 * global function, a default parameter, or an instruction or form outside its slice.
 */
export function prepareNativeProgram(plan: InstructionPlan): NativeProgram {
  let program = programs.get(plan);
  if (program === undefined) {
    program = prepare(plan);
    programs.set(plan, program);
  }
  return program;
}

function prepare(plan: InstructionPlan): NativeProgram {
  if (plan.files.length !== 1) throw new NativePreparationError("a plan of more than one file");
  const globals = new GlobalNames();
  const compiled = new Map<number, NativeStep>();
  const functionRanges = plan.functions.map((definition) => {
    if (definition.handler !== null || definition.global || definition.selfHandle !== null)
      throw new NativePreparationError("a block, a global function or a function with a handle");
    if (definition.parameters.some((parameter) => parameter.hasDefault))
      throw new NativePreparationError("a function with a default parameter");
    return [definition.entryInstruction, definition.endInstruction] as const;
  });
  const inFunction = (pc: number): boolean =>
    functionRanges.some(([start, end]) => pc >= start && pc < end);
  const rootIndexes = plan.instructions.map((_, pc) => pc).filter((pc) => !inFunction(pc));
  const root = new ScopeTracker(null, globals);
  prepareRegion(plan, rootIndexes, root, globals, compiled);
  // A function sees its file's top-level variables, all of them by the time any call runs it.
  const rootNames = root.firstScope;
  for (const definition of plan.functions) {
    const tracker = new ScopeTracker(rootNames, globals);
    for (const parameter of definition.parameters) tracker.declare(parameter.name);
    const indexes: number[] = [];
    for (let pc = definition.entryInstruction; pc < definition.endInstruction; pc += 1) indexes.push(pc);
    prepareRegion(plan, indexes, tracker, globals, compiled);
  }
  // The root and the functions together cover every instruction.
  const steps: NativeStep[] = [];
  for (let pc = 0; pc < plan.instructions.length; pc += 1) steps.push(compiled.get(pc)!);
  return { steps, globals };
}

/**
 * Prepares the instructions of one region (the root or a function) in plan order, which is the order of their scopes:
 * a loop's rounds close at its end, and every jump must land where the scopes it leaves are those it unwinds.
 */
function prepareRegion(
  plan: InstructionPlan,
  indexes: readonly number[],
  tracker: ScopeTracker,
  globals: GlobalNames,
  steps: Map<number, NativeStep>,
): void {
  const analysis = snapshotValidationAnalysis(plan);
  const loops = new Map<number, number>();
  const openLoops: Array<{ readonly target: number; readonly depth: number }> = [];
  const depths = new Map<number, number>();
  const jumps: Array<{ readonly target: number; readonly depth: number }> = [];
  const scope: InstructionScope = {
    plan,
    tracker,
    resolve: (name) => tracker.resolve(name),
    speakerTemporaries: speakerTemporaries(plan),
    globalIndex: (name) => globals.index(name),
    loopDepth: (loopId) => {
      const depth = loops.get(loopId);
      if (depth === undefined) throw new NativePreparationError("a break or continue outside its loop");
      return depth;
    },
    keepsReferenceRoot: (temporaryId) =>
      analysis.preparedReferenceTemporaries.get(temporaryId) === true ||
      analysis.currentValueTemporaries.has(temporaryId),
  };
  for (const pc of indexes) {
    while (openLoops.at(-1)?.target === pc) tracker.unwindTo(openLoops.pop()!.depth);
    const instruction: Instruction = plan.instructions[pc]!;
    const depth = tracker.depth;
    depths.set(pc, depth);
    switch (instruction.kind) {
      case "loopStart":
        loops.set(instruction.loopId, depth);
        openLoops.push({ target: instruction.target, depth });
        break;
      case "jump":
      case "jumpIfFalse":
        jumps.push({ target: instruction.target, depth });
        break;
      case "loopControl":
        jumps.push({ target: instruction.target, depth: scope.loopDepth(instruction.loopId) });
        break;
      case "prepareParameterDefault":
        jumps.push({ target: instruction.target, depth });
        break;
      default:
        break;
    }
    steps.set(pc, compileInstruction(instruction, pc, scope));
  }
  if (openLoops.length > 0) throw new NativePreparationError("a loop that does not end in its region");
  for (const jump of jumps)
    if (depths.get(jump.target) !== jump.depth)
      throw new NativePreparationError("a jump that lands outside the scopes it leaves");
}
