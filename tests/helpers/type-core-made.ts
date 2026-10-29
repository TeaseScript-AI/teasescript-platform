import type { WorkCounter } from "../../src/type-inference/core/budget.js";
import type { Contract } from "../../src/type-inference/core/contract.js";

/*
 * The uncharged-work probe (compute rules, "a growth gate on charged counters is accompanied by an uncharged-work
 * probe"; #1422 B2, where cursors hid a quadratic by walking path arrays and key texts uncharged): what a call walks
 * and makes, measured apart from what it charges. While a call runs, every read of the pass's path arena (its parents,
 * depths, last steps, children and G3 stage 1's metadata, `Contract.pathParents` and beside it) is counted by a proxy,
 * independent of the code that reads it; the code units of the texts and the elements of the arrays the call returns are
 * measured; and the ledger's units are taken by counter, charged and apart. A test compares them per site at two sizes.
 */

/** The arena's arrays, each read counted (`probeMade`). */
const ARENA = [
  "pathParents",
  "pathDepths",
  "pathLastSteps",
  "pathChildren",
  "pathFirstSteps",
  "pathTextLengths",
  "pathMembers",
] as const;

/** What one call walked, made and charged (`probeMade`). */
export interface MadeWork {
  /** Reads of the path arena. */
  readonly visits: number;
  /** The code units of the texts and the elements of the arrays it returned, nested ones too. */
  readonly made: number;
  /** Its units by counter, charged and apart. */
  readonly counters: Readonly<Partial<Record<WorkCounter, number>>>;
  readonly charged: number;
}

/** The code units of the texts and the elements of the arrays in `value`, nested ones too. */
function madeUnits(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value))
    return value.reduce((sum: number, part) => sum + 1 + madeUnits(part), 0);
  if (typeof value === "object" && value !== null)
    return Object.values(value).reduce((sum: number, part) => sum + madeUnits(part), 0);
  return 0;
}

/** `run` with the reads of `contract`'s path arena counted, what it returns measured and its units taken by counter. */
export function probeMade<T>(
  contract: Contract,
  run: () => T,
): { readonly result: T; readonly work: MadeWork } {
  const { work } = contract;
  const originals = ARENA.map((name) => contract[name]);
  let visits = 0;
  const counted: ProxyHandler<object> = {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) visits += 1;
      return Reflect.get(target, property, receiver); // oxlint-disable-line anti-slop/no-reflect-get -- EVIDENCE: fixture: the proxy only counts the arena's reads and passes each through unchanged.
    },
  };
  const install = (values: readonly object[]): void => {
    for (const [index, name] of ARENA.entries())
      Object.defineProperty(contract, name, {
        value: values[index],
        writable: true,
        configurable: true,
      });
  };
  install(originals.map((array) => new Proxy(array, counted)));
  const before = [work.counts(), work.apartCounts()] as const;
  try {
    const result = run();
    const counters: Partial<Record<WorkCounter, number>> = {};
    let charged = 0;
    for (const [now, then] of [
      [work.counts(), before[0]],
      [work.apartCounts(), before[1]],
    ] as const)
      for (const [counter, units] of now) {
        const spent = units - (then.get(counter) ?? 0);
        if (spent === 0) continue;
        counters[counter] = (counters[counter] ?? 0) + spent;
        charged += spent;
      }
    return { result, work: { visits, made: madeUnits(result), counters, charged } };
  } finally {
    install(originals);
  }
}
