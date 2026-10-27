/**
 * The work budget of the coarse core (checkpoint 9, TABLE §8): every unit of work the analysis does is charged to one
 * counter as it runs, and the charged total is checked against the program's allowance at each charge, so an analysis
 * stops at the unit that crosses it. The allowance is the larger of a fixed floor and a coefficient per syntax node;
 * statement nesting has its own limit. The fallback of a demand over its own allowance (TABLE B1: that read and the
 * reads that waited on it take the contract with the reason `budget`, while independent demands of the same key keep
 * their proofs) is not part of this module yet: here the allowance is only the emergency stop.
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
  // the checks of consumers and admission, evaluated and skipped by the quiet path; admission's passes after the first (A6)
  | "checks"
  | "checksSkipped"
  | "rejectPasses"
  // admission's copies (S6-CARRIERS §4): alias keys, signatures and groups; the eligibility index; the quiet proofs of a
  // class; the member visits a proof that is not quiet makes; the structure levels
  | "aliasSteps"
  | "eligibility"
  | "quietProofs"
  | "c1Visits"
  | "structureSteps"
  // the writers the result names
  | "evidence";

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
 * Thrown by `charge` at the unit that exceeds the allowance, by `checkNesting` past the nesting limit and by
 * `checkReadDepth` past the read-depth limit.
 */
export class BudgetExhausted extends Error {
  public constructor(public readonly limit: BudgetLimit) {
    super(`The analysis exceeded its ${LIMIT_NAMES[limit]}.`);
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

/**
 * The levels of a read chain the analysis follows in one run of native calls: a read's projections and operations
 * (`value[0][0]…`, `value.x.y…`, `value.first.first…`), each read by a generator inside the one before (`Contract`'s
 * `contractOfValue` and `#valueAt`, `Values`' `#valueAt`), so a deeper chain needs a deeper native stack. Past it the
 * analysis stops with `read-depth` instead of overflowing that stack. A technical bound, not a language limit: on Node
 * 24.18.0's default stack (984 KiB) such a chain overflowed at 2,552 levels, alike on the laptop worker and the agent
 * host, for index, property, `.first`, deep-literal and untyped reads; 1,024 is about 40 % of that, leaving the stack
 * a compile is called from and a heavier level their room. `docs/RESOURCE-LIMITS.md` records it
 * (`compiler.core-read-depth`).
 */
const READ_DEPTH_LIMIT = 1_024;

/** Throws `BudgetExhausted` when a read chain `depth` levels deep exceeds the read-depth limit. */
export function checkReadDepth(depth: number): void {
  if (depth > READ_DEPTH_LIMIT) throw new BudgetExhausted("read-depth");
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
