import type { SourceFile } from "../../type-core-analysis.js";

/**
 * The work families of the coarse core (checkpoint 9), as the reference model's gate generator
 * writes them (`make-gates14.py`): per family a program of size k whose shape once made a product of two program
 * dimensions in some realization of the core. Each family names the structure whose bound it measures. The
 * harness's boolean host flag is an interaction, as the expectation set writes it: a file that reads `flagHost`
 * starts with `let flagHost = askBoolean "flag"`.
 */
export interface WorkFamily {
  readonly name: string;
  readonly measures: string;
  readonly program: (k: number) => readonly SourceFile[];
  /**
   * Where `main` grows faster than the gate's bound: `main`'s growth per doubling at the gate's sizes, the least of the
   * four orders and sharings, for the total and `invSteps` (at or under `main`'s), a regression oracle of
   * this family's shape, measured once.
   */
  readonly main?: { readonly total: number; readonly invSteps: number };
  /**
   * An output-bound family's output at `k`: the descriptor nodes its stores' checks hold, counted
   * from the program's holders. Its work and counters grow per output unit, not per syntax node, where the stores'
   * contracts are captured inside the analysis (#1526 phase B) that `main` built uncounted after it.
   */
  readonly output?: (k: number) => number;
}

export const rows = (k: number, row: (index: number) => string): string =>
  Array.from({ length: k }, (_, index) => row(index)).join("\n");
export const lines = (...parts: readonly string[]): string => parts.join("\n");
export const fields = (k: number, value: (index: number) => string, name = "f"): string =>
  Array.from({ length: k }, (_, index) => `${name}${index}: ${value(index)}`).join(", ");
export const cells = (k: number, cell: string): string =>
  Array.from({ length: k }, () => cell).join(", ");

/** A file that reads the boolean host flag declares it from an interaction first. */
export function file(path: string, source: string): SourceFile {
  return {
    path,
    source: source.includes("flagHost") ? `let flagHost = askBoolean "flag"\n${source}` : source,
  };
}

export const main = (source: string): readonly SourceFile[] => [file("main.tease", source)];

/** A family whose work is a known product, accepted as measured: its doubling at k = 64 → 128, the steeper order's. */
export interface KnownProduct extends WorkFamily {
  readonly measured: number;
}

/** The sum of `(a_i otherwise 0)` for i in [lo, hi), as a balanced tree of `+`. */
export const balancedSum = (lo: number, hi: number): string =>
  hi - lo === 1
    ? `(a${lo} otherwise 0)`
    : `(${balancedSum(lo, (lo + hi) >> 1)} + ${balancedSum((lo + hi) >> 1, hi)})`;

/** A k-field record's literal, every field `value`. */
export const record = (k: number, value: string): string => `{${fields(k, () => value)}}`;

/** k whole copies of `root`: each of the one before it (a chain), or each of `root` (a fan-out). */
export const copiesOf = (k: number, form: "chain" | "fan-out"): string =>
  rows(k, (i) => `let a${i} = ${form === "chain" && i > 0 ? `a${i - 1}` : "root"}`);

export const parsed = (input: string, fallback: string | null = "seed"): string =>
  `fromJson(${input}${fallback === null ? "" : `, default: ${fallback}`}, files: false)`;

/**
 * Codex r5's crossed dimension (`cases.mjs` `make`, the same text): a seed storing k fields, k copies of it each storing
 * `h = {p<i>: …}`, each copied again with its own `unique<i>` (and, `mixed`, an `h.local<i>`); joined (in reverse with
 * `reverse`) and copied twice, read at every `unique<i>` and `h.p<i>`; or (`pairs`) k places each joining the first two
 * copies, read at one property of each. Every copy of the seed stores `h`, so each read of an `h.p<i>` has k layers
 * holding a source on its path: the summaries' demands are the answers' own pairs, k² of them.
 */
export function sharedReads(
  k: number,
  variant: "shared" | "mixed" | "pairs",
  reverse = false,
): string {
  const out = ["let seed = {z:1}"];
  for (let i = 0; i < k; i++) out.push(`seed.common${i} = ${i % 2 ? "hostOther" : "hostValue"}`);
  for (let i = 0; i < k; i++) {
    out.push(`let root${i} = seed`, `root${i}.h = {p${i}: ${i % 2 ? '"text"' : "[hostOther]"}}`);
    out.push(`let arm${i} = root${i}`, `arm${i}.unique${i} = hostValue`);
    if (variant === "mixed") out.push(`arm${i}.h.local${i} = hostOther`);
  }
  const names = Array.from({ length: k }, (_, i) => `arm${i}`);
  if (reverse) names.reverse();
  if (variant === "pairs") {
    for (let i = 0; i < k; i++) out.push(`let pair${i} = ${names[0]}`, `pair${i} = ${names[1]}`);
    for (let i = 0; i < k; i++) out.push(`repeat pair${i}.unique0 {}`, `repeat pair${i}.h.p1 {}`);
  } else {
    out.push(
      `let joined = ${names[0]}`,
      ...names.slice(1).map((name) => `joined = ${name}`),
      "let copy0 = joined",
      "let copy1 = copy0",
    );
    for (let i = 0; i < k; i++) out.push(`repeat copy1.unique${i} {}`, `repeat copy1.h.p${i} {}`);
  }
  return [...out, "exit"].join("\n");
}
