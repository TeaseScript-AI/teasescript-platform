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
