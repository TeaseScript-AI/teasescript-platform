import { successors } from "./explorer-analysis.ts";

/**
 * Static guidance for the explorer's search (`ExploreOptions.guidance`): a map of the whole plan, built once, that tells
 * how far each instruction is from a region of code play has not reached yet, so that states that come nearer to it
 * share a lead toward it. The map is the plan's control flow ({@link successors}: conditions, calls and returns, file
 * transfers, the blocks a timer, cue, or button sets up), with constant conditions cut, and a session's end leading
 * back to the start of the next session. The distance counts the decisions on the way, the conditions and the prompts
 * the player answers, and a next session as {@link RESTART} of them: the approach level of search-based testing. It only
 * orders states; what play reaches is decided by the runtime.
 */

type Data = Readonly<Record<string, unknown>>;

function list(value: unknown): Data[] {
  return Array.isArray(value)
    ? value.filter((item): item is Data => typeof item === "object" && item !== null)
    : [];
}

/** What starting the next session counts as on the way, in decisions. */
const RESTART = 3;
/** Instructions after which the way depends on a decision: a condition, a loop's, or the player's answer. */
const DECISIONS = new Set(["jumpIfFalse", "loopStart", "interaction"]);
/** The distance of an instruction from which no unreached code can be reached. */
export const FAR = 0x3fffffff;

export class TreasureMap {
  /**
   * Per instruction, the instructions that may run right before it; after the instructions, one place per function
   * that its returns go through to the return points of all its calls, and one that every `end` goes through, so that
   * the map grows with the plan, not with returns times calls.
   */
  readonly #before: number[][];
  /** Per place, what going on from it counts, in decisions. */
  readonly #cost: Uint8Array;
  readonly #instructions: number;
  /** The instructions that end a session, which lead to the next session's start. */
  readonly #ends: number[];
  /** Per instruction (and shared place), the decisions from it to the nearest unreached instruction, or {@link FAR}. */
  readonly distances: Int32Array;

  constructor(plan: Data, instructions: readonly Data[], constants: ReadonlyMap<number, boolean>) {
    const after = successors(plan, instructions, constants);
    const count = instructions.length;
    this.#instructions = count;
    // The function of each return, by its place among the shared ones; `end` shares the one after them.
    const functions = list(plan.functions);
    const shared = new Map<number, number>();
    functions.forEach((definition, place) => {
      const end = Number(definition.endInstruction);
      for (let index = Number(definition.entryInstruction); index <= end; index += 1)
        if (
          instructions[index]?.kind === "returnValue" ||
          instructions[index]?.kind === "returnVoid"
        )
          shared.set(index, count + place);
    });
    const endPlace = count + functions.length;
    instructions.forEach((instruction, index) => {
      if (instruction.kind === "end") shared.set(index, endPlace);
    });
    this.#before = Array.from({ length: endPlace + 1 }, () => []);
    const linked = new Set<number>();
    after.forEach((targets, index) => {
      const through = shared.get(index);
      if (through !== undefined) {
        this.#before[through]!.push(index);
        // A shared place leads to its destinations once.
        if (linked.has(through)) return;
        linked.add(through);
      }
      for (const target of targets)
        if (target >= 0 && target < count) this.#before[target]!.push(through ?? index);
    });
    this.#cost = new Uint8Array(endPlace + 1);
    instructions.forEach((instruction, index) => {
      if (DECISIONS.has(String(instruction.kind))) this.#cost[index] = 1;
    });
    this.#ends = instructions.flatMap((instruction, index) =>
      instruction.kind === "exit" || instruction.kind === "end" ? [index] : [],
    );
    this.distances = new Int32Array(endPlace + 1).fill(FAR);
  }

  /**
   * The regions of code `unreached` tells: instructions that may run one right after another make one region. Largest
   * first, each in instruction order.
   */
  regions(unreached: (index: number) => boolean): number[][] {
    const count = this.#instructions;
    // Shared places join too: a function's unreached returns with the unreached code its calls go on with.
    const parent = Int32Array.from({ length: this.#before.length }, (_, index) => index);
    const root = (index: number): number => {
      let at = index;
      while (parent[at] !== at) {
        parent[at] = parent[parent[at]!]!;
        at = parent[at]!;
      }
      return at;
    };
    // A shared place joins only when an unreached return or `end` leads to it.
    const shared = this.#before
      .slice(count)
      .map((befores) => befores.some((before) => unreached(before)));
    const live = (place: number) => (place < count ? unreached(place) : shared[place - count]!);
    for (let index = 0; index < this.#before.length; index += 1) {
      if (!live(index)) continue;
      for (const before of this.#before[index]!)
        if (live(before)) parent[root(before)] = root(index);
    }
    const members = new Map<number, number[]>();
    for (let index = 0; index < count; index += 1) {
      if (!unreached(index)) continue;
      const at = root(index);
      const region = members.get(at);
      if (region === undefined) members.set(at, [index]);
      else region.push(index);
    }
    return [...members.values()].sort((left, right) => right.length - left.length);
  }

  /** Measures again from the instructions `unreached` tells, each at distance 0; whether any distance moved. */
  update(unreached: (index: number) => boolean): boolean {
    const { distances } = this;
    const before = distances.slice();
    distances.fill(FAR);
    // Distances are small whole numbers: one bucket of instructions per distance, nearest first.
    const buckets: number[][] = [[]];
    for (let index = 0; index < this.#instructions; index += 1)
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
    return distances.some((distance, index) => distance !== before[index]);
  }
}
