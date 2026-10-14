import type { Instruction } from "../plan/model.js";

/**
 * What one `run`, `stepToEvent`, or `executeInstruction` call executed, returned when it is called with
 * `instructionTrace: true`. See `docs/RUNTIME.md#instruction-trace`.
 */
export interface RuntimeInstructionTrace {
  /** The plan indices of the instructions the call executed, in ascending order, each once. */
  readonly instructions: readonly number[];
  /**
   * The successors that instructions choosing theirs at run time took, as `[instruction, next]`, in ascending order,
   * each once.
   */
  readonly branches: readonly (readonly [number, number])[];
}

/**
 * A session host's observer of each instruction an operation executes, in order (`docs/RUNTIME.md#runtime-sessions`).
 * `call` is the ID of the call frame that runs the instruction or block, 0 outside every call.
 */
export interface RuntimeInstructionObserver {
  /** Called right before a planned instruction runs; returning `true` ends the operation there, before it runs. */
  readonly before?: (instruction: number, call: number) => boolean | void;
  /** Called once an instruction completed, with `next`, the instruction where execution continues. */
  readonly after?: (instruction: number, next: number, call: number) => void;
  /**
   * Called right before a queued timer, media, or button block starts, which counts as one executed instruction, with
   * `block`, its function ID; returning `true` ends the operation there, before it starts.
   */
  readonly dispatch?: (block: number, call: number) => boolean | void;
}

/** Collects one call's instruction trace; the engine records into it at each instruction boundary. */
export class InstructionTraceCollector {
  readonly #instructions = new Set<number>();
  /** Branches keyed `instruction * stride + next`, exact while the plan has fewer than 2^26 instructions. */
  readonly #branches = new Set<number>();
  readonly #stride: number;

  public constructor(instructionCount: number) {
    this.#stride = instructionCount;
  }

  public visit(index: number): void {
    this.#instructions.add(index);
  }

  /** Records the successor of an executed instruction when it is one that chooses its successor. */
  public settle(index: number, instruction: Instruction, next: number): void {
    if (
      instruction.kind === "jumpIfFalse" ||
      instruction.kind === "loopStart" ||
      instruction.kind === "transfer" ||
      instruction.kind === "end"
    )
      this.#branches.add(index * this.#stride + next);
  }

  public result(): RuntimeInstructionTrace {
    const stride = this.#stride;
    return Object.freeze({
      instructions: Object.freeze([...this.#instructions].sort(ascending)),
      branches: Object.freeze(
        [...this.#branches]
          .sort(ascending)
          .map((key) => Object.freeze([Math.floor(key / stride), key % stride] as const)),
      ),
    });
  }
}

function ascending(left: number, right: number): number {
  return left - right;
}
