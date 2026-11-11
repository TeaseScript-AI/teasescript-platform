// pins for tests/type-core/type-core-work-b.test.ts: main's work per family, as bounds | line /^\s*main: \{\s*$/u
import { sharedReads } from "./builders.js";

/** A family whose summaries' demands are its answers' own pairs, with `main`'s work measured once. */
export interface OutputBoundFamily {
  readonly name: string;
  readonly measures: string;
  readonly source: (k: number) => string;
  /** The answers' distinct holder-layer/path pairs, counted from the program's own holders (`main`'s enumeration). */
  readonly pairs: (k: number) => number;
  /**
   * Of those, the pairs one source answers alone, asked by reference with no summary's demand: a holder
   * layer with one own source under the path's first step and no listing layer below it, counted from the program's
   * holders (each arm's `unique<i>`, `mixed` its `h.local<i>` too; `pairs` the first arm's `unique0`).
   */
  readonly references: (k: number) => number;
  /**
   * Whether the pairs grow with the program's answers
   * (docs/specifications/type-inference-accepted-record/solver-and-work.md#r4-245: the exception for its totals), or
   * the family is a control.
   */
  readonly outputBound: boolean;
  /**
   * `main`'s total, `checks` and `invSteps` at k = 16 and 32 in the four modes (source order, sharing on and off, then
   * reversed), measured on `main` 7d6c4d3d4, the totals less the narrowing index these programs without a test no longer
   * make since #1251: a regression oracle of this family's comparison, not a bound elsewhere.
   */
  readonly main: Readonly<Record<16 | 32, readonly (readonly [number, number, number])[]>>;
}

export const OUTPUT_BOUND_FAMILIES: readonly OutputBoundFamily[] = [
  {
    name: "shared-reads",
    measures:
      "Codex r5's F1: k joined copies over a seed of k fields, every copy holding `h`, read at each `h.p<i>`",
    source: (k) => sharedReads(k, "shared"),
    pairs: (k) => k * k + 2 * k,
    references: (k) => k,
    outputBound: true,
    main: {
      16: [
        [51209, 4782, 6799],
        [45317, 4782, 7113],
        [51240, 4782, 6815],
        [45333, 4782, 7129],
      ],
      32: [
        [121911, 10598, 19143],
        [103920, 10598, 20281],
        [121943, 10598, 19175],
        [103952, 10598, 20313],
      ],
    },
  },
  {
    name: "shared-reads-reversed",
    measures: "Codex r5's F1 with the copies joined in reverse",
    source: (k) => sharedReads(k, "shared", true),
    pairs: (k) => k * k + 2 * k,
    references: (k) => k,
    outputBound: true,
    main: {
      16: [
        [51228, 4782, 6796],
        [45337, 4782, 7110],
        [51259, 4782, 6812],
        [45353, 4782, 7126],
      ],
      32: [
        [121962, 10598, 19140],
        [103972, 10598, 20278],
        [121994, 10598, 19172],
        [104004, 10598, 20310],
      ],
    },
  },
  {
    name: "shared-reads-mixed",
    measures: "Codex r5's F1 with each copy storing below `h` too",
    source: (k) => sharedReads(k, "mixed"),
    pairs: (k) => k * k + 3 * k,
    references: (k) => 2 * k,
    outputBound: true,
    main: {
      16: [
        [61786, 5821, 9406],
        [55048, 5821, 9776],
        [61883, 5821, 9486],
        [55128, 5821, 9856],
      ],
      32: [
        [145717, 12677, 26926],
        [126035, 12677, 28176],
        [145877, 12677, 27086],
        [126195, 12677, 28336],
      ],
    },
  },
  {
    name: "shared-reads-pairs",
    measures: "Codex r5's control: k places each joining two copies, read at one property of each",
    source: (k) => sharedReads(k, "pairs"),
    pairs: () => 5,
    references: () => 1,
    outputBound: false,
    main: {
      16: [
        [43857, 4576, 4148],
        [40384, 4576, 4238],
        [43859, 4576, 4150],
        [40386, 4576, 4240],
      ],
      32: [
        [88063, 10088, 8164],
        [81169, 10088, 8342],
        [88065, 10088, 8166],
        [81171, 10088, 8344],
      ],
    },
  },
];
