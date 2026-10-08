import { successors } from "./explorer-analysis.ts";

/**
 * Static guidance for the explorer's search (`ExploreOptions.guidance`): a map of the whole plan, built once, that tells
 * how far each instruction is from code play has not reached yet, so that states nearer to it go first among states
 * otherwise alike. The map is the plan's control flow ({@link successors}: conditions, calls and returns, file
 * transfers, the blocks a timer, cue, or button sets up), with constant conditions cut, and a session's end leading
 * back to the start of the next session. The distance counts the decisions on the way, the conditions and the prompts
 * the player answers, and a next session as {@link RESTART} of them: the approach level of search-based testing. It only
 * orders states; what play reaches is decided by the runtime.
 */

type Data = Readonly<Record<string, unknown>>;

/** What starting the next session counts as on the way, in decisions. */
const RESTART = 3;
/** Instructions after which the way depends on a decision: a condition, a loop's, or the player's answer. */
const DECISIONS = new Set(["jumpIfFalse", "loopStart", "interaction"]);
/** The distance of an instruction from which no unreached code can be reached. */
export const FAR = 0x3fffffff;

export class TreasureMap {
  /** Per instruction, the instructions that may run right before it. */
  readonly #before: number[][];
  /** Per instruction, what going on from it counts, in decisions. */
  readonly #cost: Uint8Array;
  /** The instructions that end a session, which lead to the next session's start. */
  readonly #ends: number[];
  /** Per instruction, the decisions from it to the nearest unreached instruction, or {@link FAR}. */
  readonly distances: Int32Array;

  constructor(plan: Data, instructions: readonly Data[], constants: ReadonlyMap<number, boolean>) {
    const after = successors(plan, instructions, constants);
    this.#before = instructions.map(() => []);
    after.forEach((targets, index) => {
      for (const target of targets)
        if (target >= 0 && target < instructions.length) this.#before[target]!.push(index);
    });
    this.#cost = Uint8Array.from(instructions, (instruction) =>
      DECISIONS.has(String(instruction.kind)) ? 1 : 0,
    );
    this.#ends = instructions.flatMap((instruction, index) =>
      instruction.kind === "exit" || instruction.kind === "end" ? [index] : [],
    );
    this.distances = new Int32Array(instructions.length).fill(FAR);
  }

  /** Measures again from the instructions `unreached` tells, each at distance 0. */
  update(unreached: (index: number) => boolean): void {
    const { distances } = this;
    distances.fill(FAR);
    // Distances are small whole numbers: one bucket of instructions per distance, nearest first.
    const buckets: number[][] = [[]];
    for (let index = 0; index < distances.length; index += 1)
      if (unreached(index)) {
        distances[index] = 0;
        buckets[0]!.push(index);
      }
    const reach = (index: number, distance: number) => {
      if (distance >= distances[index]!) return;
      distances[index] = distance;
      (buckets[distance] ??= []).push(index);
    };
    for (let distance = 0; distance < buckets.length; distance += 1) {
      for (const index of buckets[distance] ?? []) {
        if (distances[index] !== distance) continue;
        for (const before of this.#before[index]!) reach(before, distance + this.#cost[before]!);
        // The start of a session comes after every end of the one before.
        if (index === 0) for (const end of this.#ends) reach(end, distance + RESTART);
      }
    }
  }
}
