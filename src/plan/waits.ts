import { PlanControlFlow } from "./control-flow.js";
import { expressionPlanChildren } from "./expression-children.js";
import { instructionExpressions } from "./instruction-expressions.js";
import type { ExpressionPlan, Instruction, InstructionPlan } from "./model.js";

/**
 * Which parts of a plan may be live while the session waits for the host: the instructions that can leave it waiting,
 * the author functions and blocks whose activation may stand below such a wait, and the file activations that may.
 *
 * Sound: a function the plan can reach a wait from is marked. A marked function has a path in the plan to an
 * instruction that can wait, or to one that can start a block that can wait (see `blocksItMayStart`); a pacing that
 * evaluates to `instant`, a lock that never blocks, a branch that never runs, or a store that only names a handle's
 * field still marks. A block's own waits are its own: the runtime starts a block at a wait, above frames that wait
 * already, or right after an instruction of the script that made it due, which can bring a wait into an activation
 * that does not wait otherwise: the one holding the instruction, and the one the instruction enters.
 *
 * `file` is an index into this plan's `files`. These flags classify potential host waits, not checkpoint eligibility,
 * restored waits, or Debug stops.
 */
export interface PlanWaits {
  /** The instruction at `index` can leave the session waiting by itself. */
  waitsAt(index: number): boolean;
  /**
   * The instruction at `index` may stand below a wait: it waits by itself, it calls a function or a file whose
   * activation may wait, or it may start a block that may wait.
   */
  mayWaitAt(index: number): boolean;
  /** An author function's or a block's activation may be live while the session waits. */
  functionMayWait(id: number): boolean;
  /** An activation of the file, from where a `goto` or `call` enters it, with the files it goes on to, may wait. */
  fileMayWait(file: number): boolean;
}

/** Whether the instruction can leave the session waiting by itself; every kind is named, so a new kind is decided here. */
function instructionWaits(instruction: Instruction): boolean {
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
 * The blocks an instruction may make due while the script runs, which the runtime then starts right after it: an
 * async timer's own block when its round may be 0; any timer or media block after a store into a property named
 * `remaining` or `position` (a seek can pass a media's cues and end, a timer's `remaining` can reach 0); any timer block
 * after a `pause()` or `resume()` call (on a timer with nothing remaining). The plan does not say which value is a
 * handle, so the names alone count: a store into an object's `remaining`, or a `pause()` of anything else, counts too
 * and cannot start a block. Sound before exact; a plan whose blocks cannot wait loses nothing by it.
 */
function blocksItMayStart(instruction: Instruction): {
  readonly ownBlock: number | null;
  readonly timerBlocks: boolean;
  readonly timerOrMediaBlocks: boolean;
} {
  const ownBlock =
    instruction.kind === "startTimer" && !positiveConstantDuration(instruction)
      ? instruction.handlerFunctionId
      : null;
  const timerOrMediaBlocks =
    instruction.kind === "assign" &&
    instruction.target.kind === "property" &&
    (instruction.target.name === "remaining" || instruction.target.name === "position");
  // Every expression the instruction reads, walked with a list: valid source may nest deeper than the call stack.
  let timerBlocks = false;
  const pending: ExpressionPlan[] = [...instructionExpressions(instruction)];
  while (pending.length > 0 && !timerBlocks) {
    const expression = pending.pop()!;
    if (
      expression.kind === "call" &&
      expression.callee.kind === "property" &&
      (expression.callee.name === "pause" || expression.callee.name === "resume")
    )
      timerBlocks = true;
    // One at a time: a list literal may have more elements than a call takes arguments.
    for (const child of expressionPlanChildren(expression)) pending.push(child);
  }
  return { ownBlock, timerBlocks, timerOrMediaBlocks };
}

/** A timer's duration written as a constant above zero, whose round is never 0. */
function positiveConstantDuration(
  instruction: Extract<Instruction, { kind: "startTimer" }>,
): boolean {
  const duration = instruction.duration;
  if (duration.kind === "duration") return duration.milliseconds > 0;
  return (
    instruction.unit !== null &&
    duration.kind === "literal" &&
    typeof duration.value === "number" &&
    duration.value > 0
  );
}

/**
 * The least fixpoint over these facts, each a node that turns true once and never back:
 * - a region (an author function, a block, or a file's root region) may wait: one of its instructions waits by
 *   itself, or it calls a function that may wait, or it calls a file whose activation may wait, or it may start a
 *   block that may wait (`blocksItMayStart`), or an instruction that enters it may start one;
 * - a region's goto reaches a wait (`gotoNode`): a `goto` of a file that the region, or a function it calls, holds goes
 *   to a file whose activation may wait;
 * - a file's activation may wait: its root region may wait, or its root region's goto reaches a wait, as a `goto`
 *   replaces the running activation, whichever function it stands in, or a `call` or `goto` that enters it may start a
 *   block that may wait.
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
  plan.functions.forEach((definition, index) =>
    regionOfFunction.set(definition.id, fileCount + index),
  );
  const regionCount = fileCount + plan.functions.length;
  const ranges: (readonly [number, number])[] = [
    ...plan.files.map((file) => [file.startInstruction, file.rootEndInstruction] as const),
    ...plan.functions.map(
      (definition) => [definition.entryInstruction, definition.endInstruction] as const,
    ),
  ];
  const blocks = plan.functions.map((definition) => definition.handler !== null);

  // Nodes: regions, then whether their goto reaches a wait, then the files' activations, then "some activation may
  // wait", "every activation may wait", "some timer block may wait" and "some timer or media block may wait".
  const gotoNode = (region: number): number => regionCount + region;
  const activationNode = (file: number): number => 2 * regionCount + file;
  const someActivation = 2 * regionCount + fileCount;
  const everyActivation = someActivation + 1;
  const someTimerBlock = everyActivation + 1;
  const someTimerOrMediaBlock = someTimerBlock + 1;
  const nodeCount = someTimerOrMediaBlock + 1;
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

  /**
   * The activations that an instruction at `index` that may start a block enters: a called function, or every file for
   * a computed `goto` or `call`. A path or glob destination evaluates nothing, so it starts no block; only calls and
   * transfers push or replace an activation, never a method or built-in.
   */
  const enteredActivations = (index: number): number[] =>
    flow.successors(index).flatMap(({ edge }) => {
      if (edge.kind === "call") {
        const callee = regionOfFunction.get(edge.functionId);
        return callee === undefined ? [] : [callee];
      }
      return edge.kind === "computed" ? [everyActivation] : [];
    });
  /** The nodes that make an instruction that may start a block stand below a wait, by instruction. */
  const startedBlocks = new Map<number, readonly number[]>();
  const startNodes = (instruction: Instruction): readonly number[] => {
    const { ownBlock, timerBlocks, timerOrMediaBlocks } = blocksItMayStart(instruction);
    const nodes: number[] = [];
    const own = ownBlock === null ? undefined : regionOfFunction.get(ownBlock);
    if (own !== undefined) nodes.push(own);
    if (timerBlocks) nodes.push(someTimerBlock);
    if (timerOrMediaBlocks) nodes.push(someTimerOrMediaBlock);
    return nodes;
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
    const handler = region >= fileCount ? plan.functions[region - fileCount]!.handler : null;
    if (handler === "timer") depend(region, someTimerBlock);
    if (handler === "timer" || handler === "media") depend(region, someTimerOrMediaBlock);
    for (let index = start; index < end; index += 1) {
      const instruction = instructions[index]!;
      if (instructionWaits(instruction)) {
        set(region);
        continue;
      }
      const starts = startNodes(instruction);
      if (starts.length > 0) {
        startedBlocks.set(index, starts);
        // The block starts at the next boundary, which may be the first of the activation the instruction enters (a
        // call evaluates its arguments, then pushes the callee's frame): that activation stands below it too.
        const entered = enteredActivations(index);
        for (const node of starts) {
          depend(node, region);
          for (const activation of entered) depend(node, activation);
        }
      }
      if (instruction.kind !== "callFunction" && instruction.kind !== "transfer") continue;
      for (const { edge } of flow.successors(index)) {
        if (edge.kind === "call") {
          const callee = regionOfFunction.get(edge.functionId);
          if (callee === undefined) continue;
          depend(callee, region);
          depend(gotoNode(callee), gotoNode(region));
        } else if (edge.kind === "transfer" || edge.kind === "computed") {
          const target = edge.kind === "transfer" ? activationNode(edge.file) : someActivation;
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
      if (startedBlocks.get(index)?.some((node) => value[node] === 1) === true) return true;
      if (instruction.kind !== "callFunction" && instruction.kind !== "transfer") return false;
      return flow.successors(index).some(({ edge }) => {
        if (edge.kind === "call") {
          const callee = regionOfFunction.get(edge.functionId);
          return callee !== undefined && value[callee] === 1;
        }
        if (edge.kind === "transfer" && edge.mode === "call")
          return value[activationNode(edge.file)] === 1;
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
