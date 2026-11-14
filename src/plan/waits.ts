import { PlanControlFlow } from "./control-flow.js";
import type { Instruction, InstructionPlan } from "./model.js";

/**
 * Which parts of a plan may be live while the session waits for the host: the instructions that can leave it waiting,
 * the author functions and blocks whose activation may stand below such a wait, and the file activations that may.
 *
 * Sound and exact up to values and dead code: a function the plan can reach a wait from is marked, and a marked
 * function has a path in the plan to an instruction that can wait; a pacing that evaluates to `instant`, a lock that
 * never blocks or a branch that never runs still marks. A block starts only where the runtime dispatches it; this
 * analysis counts a block's waits as its own and assumes no block starts and waits between two instructions of a
 * function that cannot wait itself.
 */
export interface PlanWaits {
  /** The instruction at `index` can leave the session waiting by itself. */
  waitsAt(index: number): boolean;
  /**
   * The instruction at `index` may stand below a wait: it waits by itself, or it calls a function or a file whose
   * activation may wait.
   */
  mayWaitAt(index: number): boolean;
  /** An author function's or a block's activation may be live while the session waits. */
  functionMayWait(id: number): boolean;
  /** An activation of the file, from where a `goto` or `call` enters it, with the files it goes on to, may wait. */
  fileMayWait(file: number): boolean;
}

/** Whether the instruction can leave the session waiting by itself; every kind is named, so a new kind is decided here. */
export function instructionWaits(instruction: Instruction): boolean {
  switch (instruction.kind) {
    case "say":
      // An instant say shows its message and goes on; any other pacing may hold for reading time.
      return instruction.pacing !== "instant";
    case "wait":
    case "interaction":
    case "capture":
    case "fileStore":
    case "lock":
    case "storageWrite":
    case "playMedia":
      return true;
    case "declareGlobal":
    case "declareSpeaker":
    case "setDefaultSpeaker":
    case "copyPlayerProfile":
    case "enterScope":
    case "leaveScope":
    case "declareBinding":
    case "prepareReference":
    case "validateAssignmentTarget":
    case "assign":
    case "validateCallReceiver":
    case "evaluate":
    case "storeTemporary":
    case "jumpIfFalse":
    case "jump":
    case "loopStart":
    case "loopControl":
    case "prepareSaySpeaker":
    case "prepareSayContextualSpeaker":
    case "prepareSayText":
    case "prepareInteractionSpeaker":
    case "clearTemporary":
    case "clearTemporaries":
    case "callFunction":
    case "bindSuppliedParameter":
    case "prepareParameterDefault":
    case "beginFunctionDefaults":
    case "bindDefaultParameter":
    case "enterFunctionBody":
    case "returnValue":
    case "returnVoid":
    case "startTimer":
    case "showImage":
    case "showCamera":
    case "hideCamera":
    case "showPermanentButton":
    case "stopAudio":
    case "goto":
    case "transfer":
    case "exit":
    case "end":
      return false;
  }
  instruction satisfies never;
  return true;
}

/**
 * The least fixpoint over these facts, each a node that turns true once and never back:
 * - `region` r (an author function, a block, or a file's root region) may wait: one of its instructions waits by itself,
 *   or it calls a function that may wait, or it calls a file whose activation may wait;
 * - `gotoWaits` r: a `goto` of a file that r, or a function it calls, holds goes to a file whose activation may wait;
 * - `activation` f may wait: f's root region may wait, or its `gotoWaits` holds, as a `goto` replaces the running
 *   activation, whichever function it stands in.
 * A `goto` does not mark the region holding it, which it leaves. A block is entered by the runtime only, so its waits
 * are its own; as where a block runs is the runtime's decision, a `goto` in a block that reaches a waiting activation
 * marks every activation. A computed destination reaches every file. Work and memory are linear in instructions and
 * edges.
 */
export function planWaits(plan: InstructionPlan, flow = new PlanControlFlow(plan)): PlanWaits {
  const instructions = plan.instructions;
  const fileCount = plan.files.length;
  // Regions: the files' root regions first, then the functions and blocks in plan order.
  const regionOfFunction = new Map<number, number>();
  plan.functions.forEach((definition, index) => regionOfFunction.set(definition.id, fileCount + index));
  const regionCount = fileCount + plan.functions.length;
  const ranges: (readonly [number, number])[] = [
    ...plan.files.map((file) => [file.startInstruction, file.rootEndInstruction] as const),
    ...plan.functions.map((definition) => [definition.entryInstruction, definition.endInstruction] as const),
  ];
  const blocks = plan.functions.map((definition) => definition.handler !== null);

  // Nodes: regions, then their `gotoWaits`, then the files' activations, then "some activation may wait" and "every
  // activation may wait".
  const gotoNode = (region: number): number => regionCount + region;
  const activationNode = (file: number): number => 2 * regionCount + file;
  const someActivation = 2 * regionCount + fileCount;
  const everyActivation = someActivation + 1;
  const nodeCount = everyActivation + 1;
  /** For each node, the nodes that turn true when it does. */
  const dependents: number[][] = Array.from({ length: nodeCount }, () => []);
  const depend = (from: number, to: number): void => {
    dependents[from]!.push(to);
  };
  const value = new Uint8Array(nodeCount);
  const work: number[] = [];
  const set = (node: number): void => {
    if (value[node] === 1) return;
    value[node] = 1;
    work.push(node);
  };

  for (let file = 0; file < fileCount; file += 1) {
    depend(file, activationNode(file));
    depend(gotoNode(file), activationNode(file));
    depend(activationNode(file), someActivation);
    depend(everyActivation, activationNode(file));
  }
  for (let region = 0; region < regionCount; region += 1) {
    const [start, end] = ranges[region]!;
    const block = region >= fileCount && blocks[region - fileCount]!;
    // A goto in a block that reaches a waiting activation: every activation, as any may be running the block.
    if (block) depend(gotoNode(region), everyActivation);
    for (let index = start; index < end; index += 1) {
      const instruction = instructions[index]!;
      if (instructionWaits(instruction)) {
        set(region);
        continue;
      }
      if (instruction.kind !== "callFunction" && instruction.kind !== "transfer") continue;
      for (const { edge } of flow.successors(index)) {
        if (edge.kind === "call") {
          const callee = regionOfFunction.get(edge.functionId);
          if (callee === undefined) continue;
          depend(callee, region);
          depend(gotoNode(callee), gotoNode(region));
        } else if (edge.kind === "transfer" || edge.kind === "computed") {
          const target =
            edge.kind === "transfer" ? activationNode(edge.file) : someActivation;
          depend(target, edge.mode === "call" ? region : gotoNode(region));
        }
      }
    }
  }
  while (work.length > 0) {
    const node = work.pop()!;
    for (const dependent of dependents[node]!) set(dependent);
  }

  return Object.freeze({
    waitsAt(index: number): boolean {
      const instruction = instructions[index];
      return instruction !== undefined && instructionWaits(instruction);
    },
    mayWaitAt(index: number): boolean {
      const instruction = instructions[index];
      if (instruction === undefined) return false;
      if (instructionWaits(instruction)) return true;
      if (instruction.kind !== "callFunction" && instruction.kind !== "transfer") return false;
      return flow.successors(index).some(({ edge }) => {
        if (edge.kind === "call") {
          const callee = regionOfFunction.get(edge.functionId);
          return callee !== undefined && value[callee] === 1;
        }
        if (edge.kind === "transfer" && edge.mode === "call") return value[activationNode(edge.file)] === 1;
        if (edge.kind === "computed" && edge.mode === "call") return value[someActivation] === 1;
        return false;
      });
    },
    functionMayWait(id: number): boolean {
      const region = regionOfFunction.get(id);
      return region !== undefined && value[region] === 1;
    },
    fileMayWait(file: number): boolean {
      return file >= 0 && file < fileCount && value[activationNode(file)] === 1;
    },
  });
}
