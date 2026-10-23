import type { CompiledFunctionDefinition, InstructionPlan } from "./model.js";

/**
 * One way the runtime can continue after an instruction (see {@link PlanControlFlow.successors}). `target` is the
 * instruction it continues at, or `null` where the plan cannot name it: the return from a function, the end of a file,
 * a computed destination, or the end of the session.
 */
export type FlowEdge =
  | { readonly kind: "next" }
  /** `jumpIfFalse`: the condition held, or did not. */
  | { readonly kind: "true" }
  | { readonly kind: "false" }
  | { readonly kind: "jump" }
  /** `loopStart`: the body runs once more, or the loop is left. */
  | { readonly kind: "iterate" }
  | { readonly kind: "exhausted" }
  | { readonly kind: "continue" }
  | { readonly kind: "break" }
  /** `callFunction`: into the function, which returns to the target of the `resume` edge. */
  | { readonly kind: "call"; readonly functionId: number }
  /** After a `callFunction` or a file `call` once it returns. */
  | { readonly kind: "resume" }
  /** `prepareParameterDefault`: the call supplied the argument, or left it out so that its default runs. */
  | { readonly kind: "supplied" }
  | { readonly kind: "omitted" }
  | { readonly kind: "return" }
  /** `goto label` of the same file. */
  | { readonly kind: "goto" }
  /** A `goto` or `call` of a file, into its entry: one edge per file a glob may pick. */
  | { readonly kind: "transfer"; readonly mode: "goto" | "call"; readonly file: number }
  /** A `goto` or `call` of a computed destination, which the plan cannot name. */
  | { readonly kind: "computed"; readonly mode: "goto" | "call" }
  | { readonly kind: "end" }
  | { readonly kind: "exit" };

export interface FlowSuccessor {
  readonly edge: FlowEdge;
  readonly target: number | null;
}

const NEXT: FlowSuccessor["edge"] = { kind: "next" };
const TRUE: FlowSuccessor["edge"] = { kind: "true" };
const FALSE: FlowSuccessor["edge"] = { kind: "false" };
const JUMP: FlowSuccessor["edge"] = { kind: "jump" };
const ITERATE: FlowSuccessor["edge"] = { kind: "iterate" };
const EXHAUSTED: FlowSuccessor["edge"] = { kind: "exhausted" };
const CONTINUE: FlowSuccessor["edge"] = { kind: "continue" };
const BREAK: FlowSuccessor["edge"] = { kind: "break" };
const RESUME: FlowSuccessor["edge"] = { kind: "resume" };
const SUPPLIED: FlowSuccessor["edge"] = { kind: "supplied" };
const OMITTED: FlowSuccessor["edge"] = { kind: "omitted" };
const RETURN: FlowSuccessor["edge"] = { kind: "return" };
const GOTO: FlowSuccessor["edge"] = { kind: "goto" };
const END: FlowSuccessor["edge"] = { kind: "end" };
const EXIT: FlowSuccessor["edge"] = { kind: "exit" };

/**
 * The control flow of a plan as the runtime runs it: where each instruction can continue, and the file, function,
 * loop, and label an instruction belongs to. It knows nothing of what the instructions compute; an analysis adds its
 * own facts on top (see `dataflow.ts`). A new instruction kind needs its continuation in {@link successors} alone.
 */
export class PlanControlFlow {
  readonly #functionById = new Map<number, CompiledFunctionDefinition>();
  /** The functions by entry instruction, for the function an instruction belongs to. */
  readonly #functionsByEntry: readonly CompiledFunctionDefinition[];
  readonly #loopStarts = new Map<number, number>();
  readonly #labels = new Map<number, { readonly file: number; readonly name: string }>();

  public constructor(public readonly plan: InstructionPlan) {
    for (const definition of plan.functions) this.#functionById.set(definition.id, definition);
    this.#functionsByEntry = [...plan.functions].sort(
      (left, right) => left.entryInstruction - right.entryInstruction,
    );
    plan.instructions.forEach((instruction, index) => {
      if (instruction.kind === "loopStart") this.#loopStarts.set(instruction.loopId, index);
    });
    plan.files.forEach((file, index) => {
      for (const label of file.labels)
        this.#labels.set(label.instruction, { file: index, name: label.name });
    });
  }

  /** Where the runtime can continue after the instruction at `index`, in the plan's order of its ways. */
  public successors(index: number): readonly FlowSuccessor[] {
    const instruction = this.plan.instructions[index];
    if (instruction === undefined) return [];
    switch (instruction.kind) {
      case "jumpIfFalse":
        return [
          { edge: TRUE, target: index + 1 },
          { edge: FALSE, target: instruction.target },
        ];
      case "jump":
        return [{ edge: JUMP, target: instruction.target }];
      case "loopStart":
        return [
          { edge: ITERATE, target: index + 1 },
          { edge: EXHAUSTED, target: instruction.target },
        ];
      case "loopControl":
        return [
          { edge: instruction.action === "break" ? BREAK : CONTINUE, target: instruction.target },
        ];
      case "callFunction":
        return [
          {
            edge: { kind: "call", functionId: instruction.functionId },
            target: this.#functionById.get(instruction.functionId)?.entryInstruction ?? null,
          },
          { edge: RESUME, target: instruction.returnInstruction },
        ];
      case "prepareParameterDefault":
        return [
          { edge: OMITTED, target: index + 1 },
          { edge: SUPPLIED, target: instruction.target },
        ];
      case "returnValue":
      case "returnVoid":
        return [{ edge: RETURN, target: null }];
      case "goto":
        return [{ edge: GOTO, target: instruction.target }];
      case "transfer": {
        const { mode, destination } = instruction;
        const into: FlowSuccessor[] =
          "value" in destination
            ? [{ edge: { kind: "computed", mode }, target: null }]
            : ("pick" in destination ? destination.pick : [destination]).map((option) => ({
                edge: { kind: "transfer", mode, file: option.file },
                target: option.target,
              }));
        return mode === "call" ? [...into, { edge: RESUME, target: index + 1 }] : into;
      }
      case "end":
        return [{ edge: END, target: null }];
      case "exit":
        return [{ edge: EXIT, target: null }];
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
      case "prepareSaySpeaker":
      case "prepareSayContextualSpeaker":
      case "prepareSayText":
      case "prepareInteractionSpeaker":
      case "clearTemporary":
      case "clearTemporaries":
      case "bindSuppliedParameter":
      case "beginFunctionDefaults":
      case "bindDefaultParameter":
      case "enterFunctionBody":
      case "say":
      case "wait":
      case "startTimer":
      case "showImage":
      case "showCamera":
      case "hideCamera":
      case "showPermanentButton":
      case "storageWrite":
      case "playMedia":
      case "stopAudio":
      case "interaction":
      case "capture":
      case "fileStore":
      case "lock":
        return [{ edge: NEXT, target: index + 1 }];
    }
    instruction satisfies never;
    return [];
  }

  /**
   * The handler regions that the instruction at `index` creates to run later: a timer's expiry block, a media's cue
   * and finish blocks, or a permanent button's block.
   */
  public handlersOf(index: number): readonly number[] {
    const instruction = this.plan.instructions[index];
    switch (instruction?.kind) {
      case "startTimer":
        return instruction.handlerFunctionId === null ? [] : [instruction.handlerFunctionId];
      case "showPermanentButton":
        return [instruction.handlerFunctionId];
      case "playMedia":
        return [
          ...instruction.cues.map((cue) => cue.functionId),
          ...(instruction.finishFunctionId === null ? [] : [instruction.finishFunctionId]),
        ];
      default:
        return [];
    }
  }

  public functionById(id: number): CompiledFunctionDefinition | undefined {
    return this.#functionById.get(id);
  }

  /** The function or handler whose region holds the instruction at `index`, or `null` in a file's root region. */
  public functionOf(index: number): CompiledFunctionDefinition | null {
    const functions = this.#functionsByEntry;
    let low = 0;
    let high = functions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (functions[middle]!.entryInstruction <= index) low = middle + 1;
      else high = middle;
    }
    const candidate = functions[low - 1];
    return candidate !== undefined && index < candidate.endInstruction ? candidate : null;
  }

  /** The file whose source the instruction at `index` comes from; a start value names its own file. */
  public fileOf(index: number): number {
    const instruction = this.plan.instructions[index];
    if (instruction?.kind === "declareGlobal" || instruction?.kind === "declareSpeaker")
      return instruction.file;
    const files = this.plan.files;
    let low = 0;
    let high = files.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (files[middle]!.startInstruction <= index) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, low - 1);
  }

  /** The `loopStart` of the loop with `loopId`. */
  public loopStart(loopId: number): number | undefined {
    return this.#loopStarts.get(loopId);
  }

  /** The label that stands at the instruction at `index`, if any. */
  public labelAt(index: number): { readonly file: number; readonly name: string } | null {
    return this.#labels.get(index) ?? null;
  }
}
