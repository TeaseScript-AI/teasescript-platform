/**
 * The work budget of the coarse core (checkpoint 9, TABLE §8): every unit of work the analysis does is charged to one
 * counter as it runs, and the charged total is checked against the program's allowance at each charge, so an analysis
 * stops proving at the unit that crosses it. The allowance is the larger of a fixed floor and a coefficient per syntax
 * node; statement nesting and a read chain's depth have their own limits. A stop is no compile error (the owner's D4,
 * option a′, TABLE r4.54): the ledger then only finishes, every later charge counted apart and none stopping it, and
 * each unit before the stop is counted to the place that spent it, so one warning can name the heaviest. The fallback
 * of a demand over its own allowance (TABLE B1) is not part of this module.
 */

/** The allowance every program has, however small (TABLE §8). */
export const WORK_FLOOR = 30_000_000;

/** The allowance per syntax node of a larger program (TABLE §8). */
export const WORK_PER_NODE = 256;

/**
 * The statement nesting the analysis proves (TABLE §8); realistic scripts nest about ten deep. A statement nested deeper
 * is checked when the script runs (TABLE r4.55): the pipeline itself handles depth 10,000.
 */
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
  // what the literal indexes, their identities and structures keep, charged before they keep it: each entry, scheduled
  // task and element of a sorted copy, and each text (a signature, a structure) by its size; and each path, key or
  // composite key the core makes past `SHORT` (`keptText` and the helpers beside it)
  | "literalUnits"
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
  // the checks of consumers and admission, evaluated and skipped by the quiet path; admission's passes after the first (A6,
  // and #1275's store targets), and those after a pass in which a decision stopped (TABLE r4.180)
  | "checks"
  | "checksSkipped"
  | "rejectPasses"
  | "stopPasses"
  // admission's copies (S6-CARRIERS §4): alias keys, signatures and groups; the eligibility index; the quiet proofs of a
  // class; the member visits a proof that is not quiet makes; the structure levels
  | "aliasSteps"
  | "eligibility"
  | "quietProofs"
  | "c1Visits"
  | "structureSteps"
  // the list join check's composition of an operand's parts (#1310): each entry and open path of the smaller part
  | "partVisits"
  // the writers the result names
  | "evidence"
  // what a decision's stop forgets by (#1403), counted apart (`countApart`): each demand's reader, each key a demand
  // asked whether it stopped
  | "readerRecords"
  | "stopAsks";

/**
 * The units a kept text of `length` UTF-16 code units costs (TABLE r4.58): about its size in 8-byte words, a header of
 * two and one per eight code units, so a short key costs about what an entry does and a long path or signature its
 * length.
 */
export function textUnits(length: number): number {
  return (length + 23) >> 3;
}

/** The length of a path's text, its steps joined by dots, before it is made. */
export function pathTextLength(path: readonly string[]): number {
  let length = Math.max(0, path.length - 1);
  for (const step of path) length += step.length;
  return length;
}

/**
 * The paths and keys the core makes, each through one of these helpers or the key helpers of `definitions.ts`
 * (`tests/type-core-kept.test.ts` fails on one made past them). A text or array a structure keeps (a map's key, a set's
 * member, an entry's path or key) is made by a kept helper (`keptText`, `keptKey`, …), which charges its size to
 * `literalUnits` before it makes it (TABLE r4.58), so a literal's depth, breadth or names reach the allowance before
 * the heap; one a step only looks up or passes on is made by its plain twin (`pathText`, `keyOf`, …), which charges
 * nothing: its making is the step's own work. Up to `SHORT` code units or elements ride on the unit of the step that
 * makes them, so an ordinary path costs nothing more; beyond it a text costs a unit per eight code units and an array a
 * unit per element, about their size in 8-byte words.
 */
const SHORT = 32;

/** Charges `units` of what the core keeps (`literalUnits`): the one charge of the literal work, TABLE r4.58. */
export function keep(work: WorkLedger, units: number): void {
  if (units > 0) work.charge("literalUnits", units);
}

/** Charges a text of `length` code units about to be kept (see `SHORT`). */
export function keepText(work: WorkLedger, length: number): void {
  if (length > SHORT) keep(work, (length - SHORT + 7) >> 3);
}

/** Charges an array of `length` elements about to be kept (see `SHORT`). */
function keepArray(work: WorkLedger, length: number): void {
  if (length > SHORT) keep(work, length - SHORT);
}

/** A path's text, its steps joined by dots. */
export function pathText(path: readonly string[]): string {
  return path.join(".");
}

/** `pathText`, charged before it is made. */
export function keptText(work: WorkLedger, path: readonly string[]): string {
  keepText(work, pathTextLength(path));
  return pathText(path);
}

/** A path's text one `step` longer (a label or a prefix's text). */
export function stepText(text: string, step: string): string {
  return `${text}.${step}`;
}

/** A part of a composite key: a text, a number, a flag, or a path (its text). */
type Part = string | number | boolean | readonly string[];

/** `parts` joined by bars (a composite key), each path among them by dots. */
export function joinParts(...parts: readonly Part[]): string {
  return parts.map((part) => (typeof part === "object" ? pathText(part) : String(part))).join("|");
}

/** `joinParts`, charged before it is made. */
export function keptParts(work: WorkLedger, ...parts: readonly Part[]): string {
  let length = parts.length - 1;
  for (const part of parts)
    length += typeof part === "object" ? pathTextLength(part) : String(part).length;
  keepText(work, length);
  return joinParts(...parts);
}

/** The steps of a path written as text (the empty text none). */
export function splitPath(text: string): string[] {
  return text === "" ? [] : text.split(".");
}

/** `splitPath`, charged before the steps are made. */
export function keptSplit(work: WorkLedger, text: string): string[] {
  keepText(work, text.length);
  return splitPath(text);
}

/** The steps of `parts` in one new array (a path or an evaluation key extended). */
export function joinSteps<T>(...parts: readonly (readonly T[])[]): T[] {
  const steps: T[] = [];
  for (const part of parts) for (const step of part) steps.push(step);
  return steps;
}

/** `joinSteps`, charged before it is made. */
export function keptSteps<T>(work: WorkLedger, ...parts: readonly (readonly T[])[]): T[] {
  let length = 0;
  for (const part of parts) length += part.length;
  keepArray(work, length);
  return joinSteps(...parts);
}

/** `steps` from `start` to `end` in one new array (a path's rest or a prefix of it), charged before it is made. */
export function keptSlice<T>(
  work: WorkLedger,
  steps: readonly T[],
  start: number,
  end = steps.length,
): T[] {
  keepArray(work, end - start);
  return steps.slice(start, end);
}

/**
 * `steps`, made elsewhere (a fresh array a producer returned, which cannot know whether its caller keeps it), charged
 * as kept here, where a structure keeps it.
 */
export function keptArray<T>(work: WorkLedger, steps: readonly T[]): readonly T[] {
  keepArray(work, steps.length);
  return steps;
}

/** Which limit an analysis reached: the work allowance, the statement nesting or the read depth. */
export type BudgetLimit = "work" | "nesting" | "read-depth";

const LIMIT_NAMES: Readonly<Record<BudgetLimit, string>> = {
  work: "work allowance",
  nesting: "nesting limit",
  "read-depth": "read-depth limit",
};

/**
 * Thrown by `charge` at the unit that exceeds the allowance and by `checkReadDepth` past the read-depth limit: the
 * analysis catches it and stops proving. A statement nested past the nesting limit stops nothing: it is checked when
 * the script runs (`nesting`).
 */
/**
 * A demand that crossed its allowance (S3 §5, TABLE B1): the solver gives it up between two steps of its computations,
 * so no computation is cut midway; its reader answers with its key's contract and the reason `budget`.
 */
export class DemandExhausted extends Error {
  public constructor() {
    super("A demand exceeded its allowance.");
    this.name = "DemandExhausted";
  }
}

export class BudgetExhausted extends Error {
  public constructor(public readonly limit: BudgetLimit) {
    super(`The analysis exceeded its ${LIMIT_NAMES[limit]}.`);
    this.name = "BudgetExhausted";
  }
}

/**
 * The work of one analysis. Counters change only through `charge`, which adds to the total too, so the counters always
 * sum to the total; the budget's test checks that identity over charged work. Until the analysis stops, each unit is
 * also counted to its spender (`spender`: 0 for setup, else a callable's number); after the stop (`stop`) the ledger
 * only counts the finishing work (`finishing`), never stopping it again.
 */
export class WorkLedger {
  readonly #counts = new Map<WorkCounter, number>();
  #total = 0;
  #stopped: BudgetLimit | null = null;
  /** Work counted as finishing work, the analysis not stopped (`finishing`'s callback). */
  #apart = false;
  #finishing = 0;
  /** The finishing work by counter: `apart`'s and after the stop (`apartCounts`). */
  readonly #apartCounts = new Map<WorkCounter, number>();
  /** Units charged while building an index the program shares (`shared`), outermost builds only. */
  #shared = 0;
  #sharing = false;
  readonly #spent: number[] = [0];
  #spender = 0;

  public constructor(public readonly allowance: number) {}

  /**
   * Charges `units` of work to `counter`; throws `BudgetExhausted` when the total then exceeds the allowance. After the
   * stop, counts them as finishing work.
   */
  public charge(counter: WorkCounter, units = 1): void {
    if (this.#stopped !== null || this.#apart) {
      this.#finishing += units;
      this.#apartCounts.set(counter, (this.#apartCounts.get(counter) ?? 0) + units);
      return;
    }
    this.#counts.set(counter, (this.#counts.get(counter) ?? 0) + units);
    this.#total += units;
    this.#spent[this.#spender] = (this.#spent[this.#spender] ?? 0) + units;
    if (this.#total > this.allowance) throw new BudgetExhausted("work");
  }

  public get total(): number {
    return this.#total;
  }

  /** The limit the analysis stopped at, from then on, or `null`. */
  public get stopped(): BudgetLimit | null {
    return this.#stopped;
  }

  /** Stops the analysis at `limit`: from now on its work only finishes (the first limit stays). */
  public stop(limit: BudgetLimit): void {
    this.#stopped ??= limit;
  }

  /** The work after the stop: the finishing path's. */
  public get finishing(): number {
    return this.#finishing;
  }

  /**
   * Runs `callback`, the first build of an index every later read of the program shares (the narrowing index): its
   * units count to the analysis as any, but to no demand's allowance, as the read that happened to ask first did not
   * make them its own work (S3 §5).
   */
  public shared<T>(callback: () => T): T {
    if (this.#sharing) return callback();
    const before = this.#total;
    this.#sharing = true;
    try {
      return callback();
    } finally {
      this.#sharing = false;
      this.#shared += this.#total - before;
    }
  }

  /** The analysis's units outside `shared` builds: what a demand's allowance measures (S3 §5). */
  public get own(): number {
    return this.#total - this.#shared;
  }

  /**
   * Runs `callback` as finishing work without a stop: the checks of statements nested past the nesting limit after an
   * analysis that ran to its end (D4 a′), a diagnostic's fix facts, what a stop forgets by (`countApart`), counted apart
   * and never stopping it. Inside another `apart` callback it stays apart to that callback's end.
   */
  public apart<T>(callback: () => T): T {
    const outer = this.#apart;
    this.#apart = true;
    try {
      return callback();
    } finally {
      this.#apart = outer;
    }
  }

  /** Who the next units are counted to: 0 for setup, a callable's number otherwise. */
  public set spender(spender: number) {
    this.#spender = spender;
  }

  /** The units each spender spent before the stop, by its number (unset numbers spent none). */
  public spent(): readonly number[] {
    return this.#spent;
  }

  /** The charged counters with their units, in the order they were first charged. */
  public counts(): ReadonlyMap<WorkCounter, number> {
    return new Map(this.#counts);
  }

  /** The finishing work's counters with their units (`apart`'s and after the stop), in the order first counted. */
  public apartCounts(): ReadonlyMap<WorkCounter, number> {
    return new Map(this.#apartCounts);
  }
}

/** `units` charged to `counter` apart from the allowance (`WorkLedger.apart`): counted, never stopping the analysis. */
export function countApart(work: WorkLedger, counter: WorkCounter, units = 1): void {
  work.apart(() => work.charge(counter, units));
}

/**
 * The levels of a read chain the analysis follows in one run of native calls: a read's projections and operations
 * (`value[0][0]…`, `value.x.y…`, `value.first.first…`), each read by a generator inside the one before (`Contract`'s
 * `contractOfValue` and `valueAt`, `Values`' `#valueAt`), so a deeper chain needs a deeper native stack. Past it the
 * analysis stops proving (`read-depth`) instead of overflowing that stack. A technical bound, not a language limit: on Node
 * 26.13.0's default stack (984 KiB) such a chain overflowed at 2,448 levels for index, property and `.first` reads, as
 * on 24.18.0 with the same build; 1,024 is about 40 % of that, leaving the stack a compile is called from and a heavier
 * level their room. `docs/RESOURCE-LIMITS.md` records it
 * (`compiler.core-read-depth`). After a stop, a read past it is not settled (`Solver.enterRead`).
 */
export const READ_DEPTH_LIMIT = 1_024;

/** Throws `BudgetExhausted` when a read chain `depth` levels deep exceeds the read-depth limit. */
export function checkReadDepth(depth: number): void {
  if (depth > READ_DEPTH_LIMIT) throw new BudgetExhausted("read-depth");
}

/** The allowance a test imposes on every analysis started inside `withTestAllowance`, or `null`. */
let testAllowance: number | null = null;
let testDemandAllowance: number | null = null;

/**
 * A demand's allowance (S3 §5, TABLE B1): 256 × the nodes of the reading site's callable, or a test's
 * (`withTestDemandAllowance`).
 */
export function demandAllowanceFor(callableNodes: number): number {
  return testDemandAllowance ?? WORK_PER_NODE * callableNodes;
}

/** Test-only: runs `callback` with `allowance` as every demand's allowance (`demandAllowanceFor`). */
export function withTestDemandAllowance<T>(allowance: number, callback: () => T): T {
  if (testDemandAllowance !== null) throw new Error("A test demand allowance is already active.");
  testDemandAllowance = allowance;
  try {
    return callback();
  } finally {
    testDemandAllowance = null;
  }
}

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
