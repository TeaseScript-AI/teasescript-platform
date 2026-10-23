/**
 * The work budget of the coarse core (checkpoint 9, TABLE §8): every unit of work the analysis does is charged to one
 * counter as it runs, and the charged total is checked against the program's allowance at each charge, so an analysis
 * stops at the unit that crosses it. The allowance is the larger of a fixed floor and a coefficient per syntax node;
 * statement nesting has its own limit. What the analysis does with a place over its share of the allowance (TABLE B1)
 * is not part of this module yet: here the allowance is only the emergency stop.
 */

/** The allowance every program has, however small (TABLE §8). */
export const WORK_FLOOR = 30_000_000;

/** The allowance per syntax node of a larger program (TABLE §8). */
export const WORK_PER_NODE = 256;

/** The statement nesting the analysis accepts; realistic scripts nest about ten deep (TABLE §8). */
export const NESTING_LIMIT = 256;

/** The work allowance of a program with `syntaxNodes` parsed nodes: max(30,000,000, 256 × nodes) (TABLE §8). */
export function allowanceFor(syntaxNodes: number): number {
  return Math.max(WORK_FLOOR, WORK_PER_NODE * syntaxNodes);
}

/**
 * Every counter the analysis charges, by the part of the analysis that charges it (the names of the reference model,
 * so that work records of the port and the model compare counter by counter). A counter that several parts share says
 * what it counts.
 */
export type WorkCounter =
  // the program's size, charged once as setup
  | "syntaxNodes"
  // the graph: nodes, edges, regions, the call graph, liveness and returnability
  | "graphNodes"
  | "graphEdges"
  | "graphScan"
  | "callGraphSteps"
  | "enclosingTags"
  | "fileLookups"
  | "fnLookups"
  | "liveSteps"
  | "regionWalks"
  | "returnabilityRounds"
  | "returnabilityVisits"
  // dominators, loop lists, `edom` and `hdom`
  | "domSteps"
  | "domOrder"
  // the indexes built once (regions, definitions, owner sets, the global site list, handlers, admission's lists)
  | "indexSteps"
  | "defs"
  | "ownerSteps"
  // the reaching definition over a key and its prefixes (X2)
  | "defScan"
  | "defSortElements"
  | "rdQueries"
  | "rdWalk"
  | "parentStackSteps"
  // binary searches in sorted position lists (X6's own events, X7's handler events, the contract's entries)
  | "eventSteps"
  // the contract per demanded path and its source indexes
  | "invSteps"
  // the exact path per read and the value per (D, path)
  | "exactQueries"
  | "exactValues"
  // the demand solver: frames, resumptions and strongly connected components
  | "frames"
  | "yields"
  | "sccMembers"
  | "sccDeps"
  | "sccRounds"
  | "sccReruns"
  // items and the operator table
  | "mergeItems"
  | "sigItems"
  | "operatorSteps"
  // the checks of consumers and admission, evaluated and skipped by the quiet path
  | "checks"
  | "checksSkipped"
  // the writers the result names
  | "evidence";

/** Which limit an analysis reached: the work allowance or the nesting limit. */
export type BudgetLimit = "work" | "nesting";

/** Thrown by `charge` at the unit that exceeds the allowance, and by `checkNesting` past the nesting limit. */
export class BudgetExhausted extends Error {
  public constructor(public readonly limit: BudgetLimit) {
    super(`The analysis exceeded its ${limit === "work" ? "work allowance" : "nesting limit"}.`);
    this.name = "BudgetExhausted";
  }
}

/**
 * The work of one analysis. Counters change only through `charge`, which adds to the total too, so the counters always
 * sum to the total; the budget's test checks that identity over charged work.
 */
export class WorkLedger {
  readonly #counts = new Map<WorkCounter, number>();
  #total = 0;

  public constructor(public readonly allowance: number) {}

  /** Charges `units` of work to `counter`; throws `BudgetExhausted` when the total then exceeds the allowance. */
  public charge(counter: WorkCounter, units = 1): void {
    this.#counts.set(counter, (this.#counts.get(counter) ?? 0) + units);
    this.#total += units;
    if (this.#total > this.allowance) throw new BudgetExhausted("work");
  }

  public get total(): number {
    return this.#total;
  }

  /** The charged counters with their units, in the order they were first charged. */
  public counts(): ReadonlyMap<WorkCounter, number> {
    return new Map(this.#counts);
  }
}

/** Throws `BudgetExhausted` when `depth` nested statements exceed the nesting limit. */
export function checkNesting(depth: number): void {
  if (depth > NESTING_LIMIT) throw new BudgetExhausted("nesting");
}

/** The allowance a test imposes on every analysis started inside `withTestAllowance`, or `null`. */
let testAllowance: number | null = null;

/** The ledger of an analysis of a program with `syntaxNodes` parsed nodes: its allowance, or a test's. */
export function ledgerFor(syntaxNodes: number): WorkLedger {
  return new WorkLedger(testAllowance ?? allowanceFor(syntaxNodes));
}

/**
 * Test-only: runs `callback` with `allowance` as the allowance of every ledger `ledgerFor` makes inside it, so a test
 * can reach the budget's limits with small programs, also through a compile that passes no options down.
 */
export function withTestAllowance<T>(allowance: number, callback: () => T): T {
  if (testAllowance !== null) throw new Error("A test allowance is already active.");
  testAllowance = allowance;
  try {
    return callback();
  } finally {
    testAllowance = null;
  }
}
