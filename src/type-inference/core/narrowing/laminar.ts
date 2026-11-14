import { type WorkLedger } from "../budget.js";
import { mapped, sorted, each, steps } from "../charged-iteration.js";

/**
 * Intervals that nest or lie apart, sorted by where they start (the longer first, and at one interval in the order
 * given), each linked to the nearest one holding it, with skew-binary jumps up that chain (Myers): the innermost one
 * holding a point is a binary search and a logarithmic climb.
 */
export class Laminar<T> {
  readonly starts: readonly number[];
  readonly ends: readonly number[];
  readonly items: readonly T[];
  readonly parents: readonly number[];
  readonly #jumps: readonly number[];

  public constructor(
    readonly work: WorkLedger,
    entries: { readonly start: number; readonly end: number; readonly item: T }[],
  ) {
    work.charge("indexSteps");
    const order = mapped(work, "indexSteps", entries, (_, index) => index);
    sorted(
      work,
      "indexSteps",
      order,
      (a, b) => entries[a]!.start - entries[b]!.start || entries[b]!.end - entries[a]!.end || a - b,
    );
    const ordered = mapped(work, "indexSteps", order, (index) => entries[index]!);
    const parents: number[] = [];
    const jumps: number[] = [];
    const depths: number[] = [];
    const open: number[] = [];
    for (const [index, entry] of each(work, "indexSteps", ordered.entries())) {
      for (const _ of steps(
        work,
        "indexSteps",
        () => open.length > 0 && ordered[open.at(-1)!]!.end < entry.start,
      ))
        open.pop();
      const parent = open.at(-1) ?? -1;
      parents.push(parent);
      depths.push(parent < 0 ? 0 : depths[parent]! + 1);
      const up = parent < 0 ? -1 : jumps[parent]!;
      const further = up < 0 ? -1 : jumps[up]!;
      jumps.push(
        further >= 0 && depths[parent]! - depths[up]! === depths[up]! - depths[further]!
          ? further
          : parent,
      );
      open.push(index);
    }
    this.starts = mapped(work, "indexSteps", ordered, (entry) => entry.start);
    this.ends = mapped(work, "indexSteps", ordered, (entry) => entry.end);
    this.items = mapped(work, "indexSteps", ordered, (entry) => entry.item);
    this.parents = parents;
    this.#jumps = jumps;
  }

  /** The index of the innermost interval holding `at`, or -1. */
  public innermostIndex(at: number): number {
    this.work.charge("eventSteps");
    let low = 0;
    let high = this.starts.length;
    for (const _ of steps(this.work, "eventSteps", () => low < high)) {
      const middle = (low + high) >> 1;
      if (this.starts[middle]! <= at) low = middle + 1;
      else high = middle;
    }
    // (up the chain the intervals end no earlier: a jump whose interval ends before `at` passes every one below it)
    let index = low - 1;
    for (const _ of steps(this.work, "eventSteps", () => index >= 0 && this.ends[index]! < at)) {
      const jump = this.#jumps[index]!;
      index = jump >= 0 && this.ends[jump]! < at ? this.parents[jump]! : this.parents[index]!;
    }
    return index;
  }

  /** The innermost interval's item holding `at`, or `null`. */
  public innermost(at: number): T | null {
    this.work.charge("eventSteps");
    const index = this.innermostIndex(at);
    return index < 0 ? null : this.items[index]!;
  }
}
