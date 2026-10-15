/**
 * Explorer V2's search: generational concolic search over paths (design: `design/explorer-v2-design.md` in the
 * coordinator's notes). Paths play without a trace, and each yields targets: a decision whose other way no path took
 * yet, an answer an interaction offered that was not given there in that relevant state, and a later visit from each
 * storage state the session went through with new values of the keys conditions read. A decision target is solved from
 * a traced replay of its path: V2 varies the origins its condition read (and the origins of earlier decisions that
 * share them), the fewest first, checks each candidate by playing it, and plays the first that takes the other way on.
 * Origins no such decision read are left as they were. Decisions, answers, visits, and random walks share the time by
 * the new code each found lately.
 */
import { getHeapStatistics, writeHeapSnapshot } from "node:v8";
import { isRecord } from "../ast.ts";
import {
  branchDistance,
  conditionDistance,
  constantConditions,
  goalsFor,
  identifiersIn,
  savedFirstChecks,
  successors,
  unreachableInstructions,
  type AtomValue,
  type PlanDiagnostic,
} from "../explorer-analysis.ts";
import { instructionFiles, lineCoverage, type Target } from "../explorer-search.ts";
import {
  EPOCH_MS,
  storageOf,
  type Data,
  type Engine,
  type ExplorerInput,
  type RandomChoice,
  type StorageEntry,
} from "../explorer.ts";
import {
  CLOCK,
  Runner,
  sameInput,
  withChosenDraws,
  type Decision,
  type DrawEvent,
  type Origin,
  type Measure,
  type Path,
  type Played,
  type Resume,
  type Runtime2,
} from "./runner.ts";
import { CompactVisit, compactKey } from "./compact-visit.ts";
import { regexExamples } from "./regex-examples.ts";
import { Places, type Trap } from "./traps.ts";

export interface Explore2Options {
  readonly seed: number;
  readonly budgetMs: number;
  /** Inputs one path may give, and how many of them past its own (the inputs its search gave it). */
  readonly maxSteps: number;
  readonly extendSteps: number;
  /**
   * Instructions one step may run: a play without origins fails there with the runtime's step-limit error, as in the
   * Player; a traced replay stops there.
   */
  readonly maxStepInstructions: number;
  /**
   * Candidate checks one decision way gets, over all its attempts with what its condition reads unchanged, at most
   * (each target cut is counted).
   */
  readonly maxCandidates: number;
  /**
   * Attempts at a decision way from one relevant state of its parent; a way gets at most `SIDE_STATES` times as many in
   * all before it counts as unsolved.
   */
  readonly maxAttempts: number;
  /** The heap in use at which the search stops. */
  readonly maxHeapBytes?: number;
  readonly sources: ReadonlyMap<string, string>;
  /** The compiler's diagnostics, whose `TSV046` proves conditions constant (for the report's code that never runs). */
  readonly diagnostics?: readonly PlanDiagnostic[];
}

export const DEFAULT_OPTIONS: Omit<Explore2Options, "seed" | "sources"> = {
  budgetMs: 60_000,
  maxSteps: 300,
  extendSteps: 40,
  // The Player's instruction budget per run (the runtime's default).
  maxStepInstructions: 1_000_000,
  maxCandidates: 2048,
  maxAttempts: 3,
};

/** A child to play: a path, and for a decision target, the decision it must turn. */
interface Child {
  readonly path: Path;
  readonly score: number;
  /** The decision of `parent` whose other way the child is to take, or null for an answer target. */
  readonly target: Decision | null;
  readonly parent: Played | null;
  /** Candidates its target may try this time; a target that runs out comes back later with more. */
  readonly budget: number;
  /** Candidates its earlier times tried, in vain: this time goes on after them. */
  readonly tried: number;
  /** For an answer child, the instruction of the interaction it answers otherwise; else -1. */
  readonly place: number;
  /** For an answer child, its answer there (as `answerKey` gives it); else "". */
  readonly answer: string;
  /** A progress play's new go at its target (see `solve`), which has its own allowance of attempts. */
  readonly progress?: true;
  /** An answer child where its parent came closer to a watched condition than any play before (see `watched`). */
  readonly lead?: true;
  /**
   * For a decision child whose way other plays took already: the watched way (see `watched`) it is to lead to, from a
   * state where that way's condition would turn (see `reachGate`).
   */
  readonly reach?: number;
  /** A decision child whose parent was in a state where its watched condition would turn (see `observe`). */
  readonly ready?: true;
  /** For an answer child, its `instruction|answer|state` key in `answered`, freed again if the child is dropped. */
  readonly key?: string;
  /** For a decision child, its way and the relevant state its parent was in after the target's step. */
  readonly sideState?: string;
  /** Whether it holds a place in `queued` and `queuedHere` (a copy pushed with another score holds none). */
  readonly reserved?: boolean;
}

/** Steps past its own inputs a play goes on without new code before it stops. */
const PATIENCE = 12;

/** The share of the work each kind gets at least while it has work. */
const MIN_SHARE = 0.1;
/** The part of a kind's recent totals of new instructions and of work that each further piece of work lets lapse. */
const RATE_WEIGHT = 0.1;

/**
 * Relevant states a way is targeted from, at most: `maxAttempts` attempts from each, so that a target whose condition
 * needs a state that arrives later (a stored flag, a counter's value) gets another go then.
 */
const SIDE_STATES = 4;
/** Later visits in a row that found no code after which visits alone do not keep a run going. */
const MAX_IDLE_VISITS = 64;
/** Instructions before a decision searched for the calls whose results its condition reads. */
const CALL_LOOKBACK = 16;
/** Conditions watched for leads, at most (see `watched`). */
const MAX_WATCHED = 8;
/** Times a watched condition's lead gives answer children first, at most, and the interactions from it they answer. */
const MAX_LEAD_ROUNDS = 64;
const LEAD_STEPS = 2;
/**
 * Gates solved toward one watched way from its ready states, and children of that way from such states, at most; and the
 * candidates a gate gets.
 */
const MAX_REACH = 4;
const REACH_BUDGET = 128;
/** The decisions before a watched condition kept from a play that came to it. */
const MAX_REACHER = 256;
/** What an answer child at a lead has on top of its score: it comes before every other. */
const LEAD_SCORE = 1e18;
/** Gates one target's solving adds, at most (see `solve`). */
const MAX_GATES = 4;
/** Passes over a target's origins and checks one climb makes, at most (see `climb`). */
const MAX_CLIMB_PASSES = 64;
const MAX_CLIMB_CHECKS = 512;
/** Times after which a climb presses a button, in milliseconds: from half a second to five minutes. */
const PRESS_TIMES = [
  500, 1000, 2000, 3000, 5000, 8000, 10_000, 15_000, 20_000, 30_000, 60_000, 120_000, 300_000,
];
/** Plays of single changes an unsolved short-circuit condition gets, at most (see `solve`). */
const PROGRESS_PLAYS = 4;
/** Checks that found something besides their target, kept to be played on at most (see `sideFinds`). */
const MAX_SIDE_FINDS = 8;
/** Attempts at one way from progress plays, at most: a few operands' worth of `and`s and `or`s. */
const MAX_PROGRESS_ATTEMPTS = 8;

/** Instructions that leave a function or a file, where {@link explore2}'s gain stops following. */
const LEAVES = new Set(["returnValue", "returnVoid", "end"]);

/** The kinds of work that share the time. */
const KINDS = ["decisions", "answers", "visits", "walks"] as const;

/**
 * A value an origin can take: a draw's outcome, an input, a stored key's value at the start of a later visit (as
 * JSON text; null for a key not stored), the wall clock a session starts at, or a time the player continues later
 * (milliseconds) at the target's interaction.
 */
type Value =
  | { readonly draw: Data }
  | { readonly input: ExplorerInput }
  | { readonly stored: string; readonly value: string | null }
  | { readonly clock: number }
  | { readonly later: number };

/**
 * Children one queue keeps, at least: past half as many again, it keeps its best this many (each one dropped is counted).
 * Each keeps its parent's path and resume points.
 */
const MAX_QUEUE = 20_000;
/** Typed answers from the conditions an ask's domain adds, at most. */
const MAX_TYPED = 64;
/** The longest typed answer a climb makes for a count a condition compares a text's length with (V1's bound too). */
const MAX_TYPED_LENGTH = 200;
/** Combinations of form fields one form answer's domain holds, at most (each one cut is counted). */
const MAX_CANDIDATES = 4096;
/** Candidates a target tries first; each time it runs out, it comes back with this many times more. */
const FIRST_BUDGET = 64;
const BUDGET_GROWTH = 2;
/**
 * Interactions a check plays past the one its target was at, at most: the change may add or remove a few before the
 * other way comes.
 */
const CHECK_STEPS = 3;
/**
 * The text of the resume points (tagged snapshots) queued children and random walks keep, at most, in characters:
 * those of the latest plays.
 */
const MAX_RESUME_TEXT = 150_000_000;
/** Traced replays kept for further targets of the same play, at most: the latest ones. */
const MAX_TRACED = 4;
/**
 * Storage states kept for later visits, at most; past it, one with new values of the keys conditions read takes the
 * place of the oldest (each state left out or dropped is counted).
 */
const MAX_SAVED = 4096;
/** Values of one stored key a solver tries, at most: the first ones the saved states hold. */
const MAX_STORED_VALUES = 64;
const HOUR_MS = 3_600_000;
/** How much later the player may continue, for a condition on the time since a clock read: 1 min to 30 days. */
const LATER_GAPS = [1, 5, 15, 30, 60, 120, 360, 720, 1440, 2880, 10_080, 43_200].map(
  (minutes) => minutes * 60_000,
);
const DAY_MS = 24 * HOUR_MS;
/**
 * The wall clocks a session that starts at `now` may start at instead, for a condition that reads the clock: each hour
 * of its day (at half past), a little and a lot later (for times since a saved one), and later days, weeks, and months.
 */
function clockStarts(now: number): number[] {
  const day = now - (now % DAY_MS);
  const starts = new Set([
    ...Array.from({ length: 24 }, (_, hour) => day + hour * HOUR_MS + HOUR_MS / 2),
    ...[0.1, 0.5, 1, 2, 6, 12].map((hours) => now + hours * HOUR_MS),
    ...[1, 2, 3, 4, 5, 6, 7, 14, 30, 61, 91, 182, 365].map((days) => now + days * DAY_MS),
  ]);
  starts.delete(now);
  return [...starts].sort((left, right) => left - right);
}

/** A visit a witness needs before its own: its inputs, the outcomes its draws had, and how its session started. */
export interface Visit {
  /** Its inputs, each with the random outcomes its step needs (see `withChosenDraws`), and those of its start. */
  readonly inputs: readonly ExplorerInput[];
  readonly random?: readonly RandomChoice[];
  readonly draws: readonly { occurrence: number; outcome: Data }[];
  readonly storage?: readonly StorageEntry[];
  readonly wallClockMs?: number;
}

export interface Explore2Result {
  readonly search: {
    readonly stoppedBy: "exhausted" | "budget" | "memory";
    readonly audit: { readonly result: "complete" | "incomplete" | "capped" };
    readonly states: number;
    readonly operations: number;
    readonly elapsedMs: number;
    readonly plays: number;
    /** Sessions played, as the report counts visits: each play is one, from the start or from saved data. */
    readonly sessions: number;
    readonly checks: number;
    readonly solved: number;
    /** Attempts that found no way, by reason (an attempt's way may still be taken later). */
    readonly unsolved: Readonly<Record<string, number>>;
    /** Ways V2 tried to take that no path took. */
    readonly openWays: number;
    readonly candidatesCut: number;
    readonly climbed: number;
    readonly queueCut: number;
    readonly savedCut: number;
    readonly stepsCut: number;
    readonly visitsLeft: number;
  };
  /** As V1 reports it: the lines reached, those that can never run, and each missed way with what it depends on. */
  readonly coverage: ReturnType<typeof lineCoverage>;
  readonly crashes: readonly {
    code: string;
    message: string;
    path: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    inputs: readonly ExplorerInput[];
    random?: readonly RandomChoice[];
    draws: readonly { occurrence: number; outcome: Data }[];
    /** The storage its session started with, for a later visit, and its start wall clock, when not the usual. */
    storage?: readonly StorageEntry[];
    wallClockMs?: number;
    /** For a later visit, the visits that saved what it starts with, oldest first (see `Visit`). */
    earlier?: readonly Visit[];
  }[];
  /** Loops with no way out that V2 found (see `traps.ts`). */
  /** Loops with no way out, each with its witness and, for a later visit, the visits before it (see `Visit`). */
  readonly traps: readonly (Trap & { readonly earlier?: readonly Visit[] })[];
}

function list(value: unknown): Data[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function record(value: unknown): Data {
  return isRecord(value) ? value : {};
}

/** A binary max-heap of children by score. */
class Queue {
  readonly #items: Child[] = [];
  get size(): number {
    return this.#items.length;
  }
  push(child: Child): void {
    const items = this.#items;
    items.push(child);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent]!.score >= items[index]!.score) break;
      [items[parent], items[index]] = [items[index]!, items[parent]!];
      index = parent;
    }
  }
  pop(): Child | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let best = index;
        if (left < items.length && items[left]!.score > items[best]!.score) best = left;
        if (right < items.length && items[right]!.score > items[best]!.score) best = right;
        if (best === index) break;
        [items[best], items[index]] = [items[index]!, items[best]!];
        index = best;
      }
    }
    return top;
  }
  /**
   * Keeps the `limit` best children by their score now, once the queue holds half as many again; the children dropped.
   */
  keep(limit: number, scoreNow: (child: Child) => number): Child[] {
    if (this.#items.length <= limit + (limit >> 1)) return [];
    const rescored = this.#items.map((child) => ({ ...child, score: scoreNow(child) }));
    rescored.sort((left, right) => right.score - left.score);
    const dropped = rescored.splice(limit);
    this.#items.length = 0;
    // Sorted from best down, the kept children already form a max-heap.
    this.#items.push(...rescored);
    return dropped;
  }
}

export function explore2(
  engine: Engine,
  runtime: Runtime2,
  plan: Data,
  options: Explore2Options,
): Explore2Result {
  const started = performance.now();
  const instructions = list(plan.instructions);
  const runner = new Runner(runtime, engine, plan, options.seed);
  const visited = new Uint8Array(instructions.length);
  const ways = new Set<number>();
  const next = successors(plan, instructions, new Map());
  // Decision targets, answer targets, later visits, and random walks share the time (see `charge`).
  const decisionsQueue = new Queue();
  const answersQueue = new Queue();
  /** Later visits: sessions from the storage states plays went through, in the order they were found. */
  const visitsQueue = new Queue();
  const visitKeys = new Set<string>();
  /** Recent played paths, which random walks go on from. */
  const recent: Played[] = [];
  /**
   * The plays of decision children, and the plays that went on from them (answers, visits and walks): code these find
   * counts for decisions as well, as a decision's value is in what it unlocks. The line stands in for what a decision
   * unlocked; it does not prove it.
   */
  const fromDecisions = new WeakSet<Played>();
  /** Whether the play under way is in such a line, and the kind that made it. */
  let underDecision = false;
  let playKind: (typeof KINDS)[number] = "answers";
  let state = options.seed >>> 0 || 1;
  const random = () => {
    // xorshift32: the walks depend on the seed alone.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  const attempts = new Map<number, number>();
  /** Children queued per decision way, which stops at twice its attempts. */
  const queued = new Map<number, number>();
  const answered = new Set<string>();
  const unsolved: Record<string, number> = {};
  /** Per way that solving left open, why it last did. */
  const reasonOf = new Map<number, string>();

  /** The places of the random draws plays made (the runtime's sites). */
  const drawnSites = new Set<string>();
  const crashes = new Map<string, Explore2Result["crashes"][number]>();
  /**
   * Checks that ran code or took a way no play had, or failed in a new place, without turning their target (another
   * case of a switch on a draw, the code behind another answer): each is played on as a play of its own, as a fuzzer
   * keeps every input that finds something new.
   */
  const sideFinds: { path: Path; from: number; parent: Played; guide: Played | null }[] = [];
  let plays = 0;
  let checks = 0;
  let solved = 0;
  let candidatesCut = 0;
  /** Targets solved by climbing on their distance. */
  let climbed = 0;
  const places = new Places();
  /** The resume points children keep, by play, oldest first. */
  const resumeLists: Resume[][] = [];
  let resumesKept = 0;
  /** Answers plays gave, by `instruction|answer|state` (`answered` also has those queued). */
  const givenAnswers = new Set<string>();
  /** Children not queued because their queue was full. */
  let queueCut = 0;
  /** Later visits in a row that found no code, and those left when the run ended (see the loop's end). */
  let idleVisits = 0;
  let visitsLeft = 0;
  /** Plays the run's step cap stopped. */
  let stepsCut = 0;
  /** Storage states plays went through, by their compressed JSON text: where later visits start. */
  const saved = new Map<string, readonly StorageEntry[]>();
  /** The wall clock at which the play that first saved each of {@link saved} had it. */
  const savedAt = new Map<string, number>();
  /**
   * A path that starts with a saved storage starts no earlier than the clock at which it was saved (a clock the solver
   * chose, or a next day counted from an earlier start, would have the session go back in time).
   */
  const notBeforeSave = (path: Path): Path => {
    if (path.storage === undefined) return path;
    const at = savedAt.get(compactKey(JSON.stringify(path.storage)));
    return at === undefined || (path.wallClockMs ?? EPOCH_MS) >= at
      ? path
      : { ...path, wallClockMs: at };
  };
  /** For each saved state, the visit that first had it: its inputs and draws up to there, and how it started. */
  // Kept compressed: only a crash or trap witness's earlier visits read one again.
  const producers = new Map<string, CompactVisit>();
  /**
   * The visits before one that starts from saved data, oldest first: each the one that saved the data the next starts
   * from, back to one from the start; none when one of them is no longer known.
   */
  const earlierOf = (storage: readonly StorageEntry[] | undefined): { earlier?: Visit[] } => {
    const chain: Visit[] = [];
    for (let at = storage; at !== undefined;) {
      const producer = producers.get(compactKey(JSON.stringify(at)))?.value;
      if (producer === undefined || chain.length > MAX_SAVED) return {};
      chain.unshift(producer);
      at = producer.storage;
    }
    return chain.length === 0 ? {} : { earlier: chain };
  };
  let savedCut = 0;
  /** Checks per target instruction, for diagnosis. */
  const checksOf = new Map<number, number>();
  const debugCheck = { ms: 0, instructions: 0, steps: 0, traced: 0, tracedMs: 0, tracedWork: 0 };
  const outOfTime = () => performance.now() - started >= options.budgetMs;

  /** Answer children played per interaction instruction. */
  const answeredAt = new Map<number, number>();
  /** Answer children played per interaction instruction and answer. */
  const answerTries = new Map<string, number>();
  // An answer never tried at its place first; then the places tried least; then the earliest steps.
  const answerScore = (place: number, answer: string, step: number) =>
    -(
      (answerTries.get(`${place}|${answer}`) ?? 0) * 1e9 +
      Math.min(answeredAt.get(place) ?? 0, 999_999) * 1000 +
      Math.min(step, 999)
    );
  /** A child's score now: a decision target's gain shrinks as code gets covered, an answer's as its place gets tried. */
  const scoreNow = (child: Child): number =>
    child.reach !== undefined
      ? // As a way's: the checks its gates took so far count against it.
        gain(child.reach >> 1, child.reach & 1) /
        (1 + (reachChecks.get(child.reach) ?? 0) / FIRST_BUDGET) ** 2
      : child.ready === true && child.target !== null
        ? gain(child.target.instruction, 1 - child.target.way)
        : child.target !== null
          ? (gain(child.target.instruction, 1 - child.target.way) +
              (boosts.get(child.target.instruction * 2 + (1 - child.target.way)) ?? 0)) /
            // The checks a way took so far count against it (squared), so that ways not tried yet get their turn: one that
            // took a few hundred falls behind any untried one with a few lines behind it.
            (1 +
              (checksBySide.get(child.target.instruction * 2 + (1 - child.target.way)) ?? 0) /
                FIRST_BUDGET) **
              2
          : child.place >= 0
            ? answerScore(child.place, child.answer, child.path.inputs.length - 1) +
              (child.lead === true ? LEAD_SCORE : 0)
            : child.score;

  /**
   * The instructions no path ran that a way leads to, up to where it meets code that ran, within its function and the
   * functions it calls, and on after those calls: not on through its own returns and file ends, which lead back to
   * every caller.
   */
  const gain = (instruction: number, way: number): number => {
    const target = way === 0 ? instruction + 1 : Number(instructions[instruction]?.target);
    if (!Number.isInteger(target) || visited[target] === 1) return 0;
    const seen = new Set([target]);
    const stack = [target];
    while (stack.length > 0 && seen.size < 10_000) {
      const at = stack.pop()!;
      const instruction = instructions[at];
      if (LEAVES.has(String(instruction?.kind))) continue;
      // A call goes into the function and on after it returns, there (not to every other caller).
      const after =
        instruction?.kind === "callFunction" ? [Number(instruction.returnInstruction)] : [];
      for (const following of [...(next[at] ?? []), ...after])
        if (visited[following] !== 1 && !seen.has(following)) {
          seen.add(following);
          stack.push(following);
        }
    }
    return seen.size;
  };

  /**
   * Whether code from `start` on comes to instruction `goal` without passing `avoid`, played or not (into calls and on
   * after them, as `gain`, and not back through returns).
   */
  const leadsTo = (start: number, goal: number, avoid: number): boolean => {
    if (!Number.isInteger(start) || start === avoid) return false;
    const seen = new Set([start]);
    const stack = [start];
    // The functions it is in without having called them (from `start` out): a return from one of those goes on where
    // the function's calls do (a helper's decision whose way returns to the condition); a function it called goes on
    // after that call. A return met before its function was one of those is gone through again once it is.
    const outer = new Set([functionAt(start)]);
    const parked = new Map<number, number[]>();
    while (stack.length > 0 && seen.size < 10_000) {
      const at = stack.pop()!;
      if (at === goal) return true;
      const instruction = instructions[at];
      const returns = instruction?.kind === "returnValue" || instruction?.kind === "returnVoid";
      const from = returns ? functionAt(at) : -1;
      if (returns && !outer.has(from)) {
        const waiting = parked.get(from) ?? [];
        waiting.push(at);
        parked.set(from, waiting);
      }
      const after =
        instruction?.kind === "callFunction"
          ? [Number(instruction.returnInstruction)]
          : returns && outer.has(from)
            ? (callersOf().get(from) ?? [])
            : [];
      if (returns)
        for (const each of after) {
          const into = functionAt(each);
          if (outer.has(into)) continue;
          outer.add(into);
          stack.push(...(parked.get(into) ?? []));
          parked.delete(into);
        }
      if (LEAVES.has(String(instruction?.kind)) && after.length === 0) continue;
      for (const following of [
        ...(LEAVES.has(String(instruction?.kind)) ? [] : (next[at] ?? [])),
        ...after,
      ])
        if (following !== avoid && !seen.has(following)) {
          seen.add(following);
          stack.push(following);
        }
    }
    return false;
  };
  /** Per function (by ID), where its calls go on after it returns; worked out when first needed. */
  let callers: Map<number, number[]> | null = null;
  const callersOf = (): Map<number, number[]> => {
    if (callers === null) {
      callers = new Map();
      for (const each of instructions)
        if (each.kind === "callFunction" && typeof each.functionId === "number") {
          const known = callers.get(each.functionId) ?? [];
          known.push(Number(each.returnInstruction));
          callers.set(each.functionId, known);
        }
    }
    return callers;
  };
  /** Per instruction, the innermost function (by ID) whose body it is in, or -1; worked out when first needed. */
  let functionsAt: Int32Array | null = null;
  const functionAt = (index: number): number => {
    if (functionsAt === null) {
      const found = new Int32Array(instructions.length).fill(-1);
      // Outermost first, so that a function inside another one's span overwrites it.
      const declared = list(plan.functions).sort(
        (left, right) =>
          Number(right.endInstruction) -
          Number(right.entryInstruction) -
          (Number(left.endInstruction) - Number(left.entryInstruction)),
      );
      for (const each of declared)
        for (let at = Number(each.entryInstruction); at <= Number(each.endInstruction); at += 1)
          if (at >= 0 && at < found.length) found[at] = Number(each.id);
      functionsAt = found;
    }
    return functionsAt[index] ?? -1;
  };
  /** Where a decision's way goes on. */
  const wayStart = (instruction: number, way: number): number =>
    way === 0 ? instruction + 1 : Number(instructions[instruction]?.target);
  /** Children queued from ready states per watched way (see `take`). */
  const readyQueued = new Map<number, number>();
  /** Gate children queued toward each watched way (see `reachGate`). */
  const reachQueued = new Map<number, number>();
  /** The step from which a check's turn counts: a gate's, from it on (it may have taken either way before). */
  let turnFrom = -Infinity;
  /** Checks gate children took toward each watched way. */
  const reachChecks = new Map<number, number>();
  /** Gate children tried toward each watched way. */
  const reachTried = new Map<number, number>();
  /**
   * A play that came to a state where a watched way's condition would turn (distance 0) but did not come to that
   * condition after it: of the decisions a play that came to the condition made before it, the last one this play made
   * the other way from there is a gate, solved from this play (a timed hit that a counter's state needs before the
   * reward it guards), when only the way the other play took leads on to the condition without coming back to it (not
   * a helper's decision, whose ways both return).
   */
  const reachGate = (
    played: Played,
    kept: Played,
    watching: (typeof watched)[number],
    step: number,
  ): void => {
    const side = watching.side;
    const queuedSoFar = reachQueued.get(side) ?? 0;
    if (queuedSoFar >= MAX_REACH) return;
    const goal = side >> 1;
    const after = played.decisions.filter((decision) => decision.step > step);
    if (after.some((decision) => decision.instruction === goal)) return;
    // The reacher's decisions that only its way leads on from to the condition, last first: worked out once.
    watching.gates ??= watching.reacher
      .filter(
        ({ instruction, way }, at, all) =>
          all.findLastIndex((each) => each.instruction === instruction) === at &&
          leadsTo(wayStart(instruction, way), goal, instruction) &&
          !leadsTo(wayStart(instruction, 1 - way), goal, instruction),
      )
      .reverse();
    let gate: Decision | undefined;
    for (const { instruction, way } of watching.gates) {
      gate = after.find((decision) => decision.instruction === instruction && decision.way !== way);
      if (gate !== undefined) break;
    }
    if (gate === undefined) return;
    reachQueued.set(side, queuedSoFar + 1);
    const child: Child = {
      path: played.path,
      score: 0,
      target: gate,
      parent: kept,
      budget: REACH_BUDGET,
      tried: 0,
      place: -1,
      answer: "",
      reach: side,
    };
    decisionsQueue.push({ ...child, score: scoreNow(child) });
    if (process.env.SX_V2_DEBUG)
      process.stderr.write(
        `reach ${goal}:${side & 1} gate ${gate.instruction}:${1 - gate.way} step ${gate.step}\n`,
      );
  };

  /** Traced replays of plays, by play, with the step each goes up to: the latest ones (see {@link MAX_TRACED}). */
  const traced = new Map<Played, { readonly upTo: number; readonly replay: Played }>();
  /** `played` again with origins, the same inputs and draw outcomes, up to (and with the decisions of) `step`. */
  const tracedUpTo = (played: Played, step: number): Played => {
    const known = traced.get(played);
    if (known !== undefined && known.upTo >= step) return known.replay;
    const tracedStarted = performance.now();
    const work = runner.work;
    const replay = runner.play(
      {
        // The play's outcomes, kept while each draw still matches (as they all do, unless the script differs).
        inputs: played.inputs.slice(0, step),
        draws: new Map(),
        inherited: played.draws,
        ...startOf(played.path),
      },
      {
        maxSteps: step,
        maxStepInstructions: options.maxStepInstructions,
        origins: true,
        keepResumes: true,
      },
    );
    debugCheck.tracedMs += performance.now() - tracedStarted;
    debugCheck.tracedWork += runner.work - work;
    debugCheck.traced += 1;
    traced.delete(played);
    traced.set(played, { upTo: step, replay });
    if (traced.size > MAX_TRACED) traced.delete(traced.keys().next().value!);
    return replay;
  };

  /** A play's answers by the place it gave them at, latest first, for {@link goOn}. */
  const answersAt = new WeakMap<Played, Map<number, ExplorerInput[]>>();
  const placesOf = (played: Played): Map<number, ExplorerInput[]> => {
    let places = answersAt.get(played);
    if (places === undefined) {
      places = new Map();
      played.interactions.forEach((interaction, step) => {
        const given = played.inputs[step];
        if (given === undefined) return;
        const list = places!.get(interaction.instruction) ?? [];
        list.unshift(given);
        places!.set(interaction.instruction, list);
      });
      answersAt.set(played, places);
    }
    return places;
  };
  /**
   * Goes on after a path's own inputs as its parent did: at the same step when it is the same place, else as the parent
   * last answered at that place (a later visit or a changed route reaches the parent's places at other steps); else
   * with the first answer offered.
   */
  const goOn =
    (parent: Played | null) => (interaction: Played["interactions"][number], step: number) => {
      // At the parent's place, its wait goes on to the deadline offered now (it moved with the clock; a photo it asked
      // for stays asked for), and a text it typed stays typed, also one no heuristic offers (a code the solver found,
      // such as 121 for "more than 120").
      const waitNow = interaction.options.find((option) => option.kind === "wait");
      const carried = (input: ExplorerInput): ExplorerInput | undefined =>
        input.kind === "wait"
          ? waitNow?.kind === "wait"
            ? { ...input, untilMs: waitNow.untilMs }
            : undefined
          : input.kind === "text" && interaction.options.some((option) => option.kind === "text")
            ? input
            : interaction.options.some((option) => sameInput(option, input))
              ? input
              : undefined;
      const offered = (input: ExplorerInput) => carried(input) !== undefined;
      const before = parent?.inputs[step];
      if (
        before !== undefined &&
        parent?.interactions[step]?.instruction === interaction.instruction &&
        offered(before)
      )
        return carried(before)!;
      const there =
        parent === null
          ? undefined
          : placesOf(parent)
              .get(interaction.instruction)
              ?.find((input) => offered(input));
      if (there !== undefined) return carried(there)!;
      if (before !== undefined && interaction.options.some((option) => sameInput(option, before)))
        return before;
      return (
        interaction.options.find((option) => option.kind !== "wait") ??
        interaction.options[0] ??
        null
      );
    };

  /**
   * Queues the answers not given at a play's interaction `step` in its relevant state, a child each (first of all, at a
   * lead: see `watched`).
   */
  const queueAnswers = (kept: Played, step: number, lead: boolean): void => {
    const interaction = kept.interactions[step];
    if (interaction === undefined) return;
    const given = kept.inputs[step];
    for (const option of interaction.options) {
      if (given !== undefined && sameInput(option, given)) continue;
      const key = `${interaction.instruction}|${JSON.stringify(option)}|${interaction.state}`;
      if (answered.has(key)) continue;
      answered.add(key);
      // Interactions answered otherwise least often first, and of those, earlier steps first.
      answersQueue.push({
        path: {
          inputs: [...kept.inputs.slice(0, step), option],
          draws: kept.path.draws,
          inherited: kept.draws,
          ...startOf(kept.path),
        },
        score:
          answerScore(interaction.instruction, answerKey(option), step) + (lead ? LEAD_SCORE : 0),
        target: null,
        parent: kept,
        budget: 0,
        tried: 0,
        place: interaction.instruction,
        answer: answerKey(option),
        key,
        ...(lead ? { lead: true as const } : {}),
      });
    }
  };

  /**
   * Counts a played path and queues its children: `shared`, the interaction up to which the path is its parent's (whose
   * children were queued already), or -1.
   */
  const take = (
    played: Played,
    shared: number,
  ): { found: number; kept: Played; played: Played } => {
    plays += 1;
    for (const draw of played.draws) drawnSites.add(draw.site);
    // The steps at which this play came closer to a watched condition (see `watch`).
    const leadSteps = leadsNow;
    leadsNow = [];
    places.add(played, (instruction) => runner.readsClock(instruction));
    const visits: (readonly StorageEntry[])[] = [];
    for (const [index, storage] of played.storages.entries()) {
      const text = compactKey(JSON.stringify(storage));
      if (saved.has(text)) continue;
      // The values of the keys conditions read: a state with new ones is worth a later visit, and keeping.
      const key = compactKey(
        JSON.stringify(storage.filter((entry) => runner.readKeys.has(entry.key))),
      );
      const novel = !visitKeys.has(key);
      if (saved.size >= MAX_SAVED) {
        // Full: a state with new values of those keys takes the place of the oldest one (a flag or count that only a
        // long route sets comes late), any other is left out.
        savedCut += 1;
        if (!novel) continue;
        const oldest = saved.keys().next().value!;
        saved.delete(oldest);
        producers.delete(oldest);
        savedAt.delete(oldest);
      }
      saved.set(text, storage);
      savedAt.set(text, played.storageClocks[index] ?? played.path.wallClockMs ?? EPOCH_MS);
      const step = played.storageSteps[index] ?? played.inputs.length;
      producers.set(
        text,
        new CompactVisit({
          ...withChosenDraws(
            played.inputs.slice(0, step),
            played.draws.filter((draw) => draw.step <= step),
          ),
          draws: played.draws
            .filter((draw) => draw.step <= step)
            .map((draw) => ({ occurrence: draw.occurrence, outcome: draw.outcome })),
          ...startOf(played.path),
        }),
      );
      if (!novel) continue;
      visitKeys.add(key);
      visits.push(storage);
    }
    let found = 0;
    for (const index of played.visited)
      if (visited[index] !== 1) {
        visited[index] = 1;
        found += 1;
      }
    for (const decision of played.decisions) {
      const way = decision.instruction * 2 + decision.way;
      ways.add(way);
      lastChildOf.delete(way);
    }
    if (played.end === "failed" && played.failure !== null) {
      const failure = played.failure;
      const key = `${failure.code}@${failure.path}:${failure.line}`;
      const known = crashes.get(key);
      if (known === undefined || known.inputs.length > played.inputs.length)
        crashes.set(key, {
          ...failure,
          ...withChosenDraws(played.inputs, played.draws),
          // The outcomes the play had (fixed by its path, inherited, or by site): they replay it.
          draws: played.draws.map((draw) => ({
            occurrence: draw.occurrence,
            outcome: draw.outcome,
          })),
          ...startOf(played.path),
          ...earlierOf(played.path.storage),
        });
    }
    // Children keep the play with only the resume points they go on from: the answer children's. A decision child's
    // parent is replayed from the start with a trace, and checks resume from that replay.
    // A play its step cap or patience stopped goes on from where it stopped: its last interaction's answers are children
    // too. One the run's step cap stopped is counted.
    const stopped = played.end === "steps" || played.end === "waiting";
    const capped = stopped && played.inputs.length >= options.maxSteps;
    if (capped) stepsCut += 1;
    const answers = (step: number): boolean =>
      step >= shared &&
      (step < played.inputs.length || (step === played.inputs.length && stopped && !capped));
    // A step whose input led to a request for a photo, given no camera: the same input once more, with a photo.
    const photos = played.captures.flatMap((step) => {
      const given = played.inputs[step - 1];
      const interaction = played.interactions[step - 1];
      if (
        step - 1 < shared ||
        given === undefined ||
        given.photo === true ||
        interaction === undefined
      )
        return [];
      const input: ExplorerInput = { ...given, photo: true };
      const key = `${interaction.instruction}|${JSON.stringify(input)}|${interaction.state}`;
      return answered.has(key)
        ? []
        : [{ step: step - 1, input, key, place: interaction.instruction }];
    });
    const answerSteps = new Set<number>(photos.map((photo) => photo.step));
    played.interactions.forEach((interaction, step) => {
      if (!answers(step)) return;
      const given = played.inputs[step];
      for (const option of interaction.options)
        if (
          (given === undefined || !sameInput(option, given)) &&
          !answered.has(`${interaction.instruction}|${JSON.stringify(option)}|${interaction.state}`)
        )
          answerSteps.add(step);
    });
    const resumes: Resume[] = [];
    for (const step of [...answerSteps, ...leadSteps.map((lead) => lead.step)]) {
      if (resumes[step] !== undefined) continue;
      const resume = played.resumes[step];
      if (resume === undefined) continue;
      resumes[step] = resume;
      resumesKept += resume.taggedChars;
    }
    // What children need of the play: its inputs, draws, interactions, start, and those resume points. Decision children
    // replay it with a trace; answer children take their own coverage and decisions after the step they change.
    const kept: Played = {
      path: played.path,
      inputs: played.inputs,
      visited: new Set(),
      decisions: [],
      interactions: played.interactions,
      draws: played.draws,
      end: played.end,
      failure: null,
      instructions: 0,
      resumes,
      storages: [],
      storageSteps: [],
      storageClocks: [],
      captures: [],
    };
    if (underDecision) {
      fromDecisions.add(kept);
      // Counted as it is found, it lapses as the decisions' other totals do.
      if (playKind !== "decisions" && found > 0 && recentWork.decisions > 0) {
        recentFound.decisions += found;
        rate.decisions = recentFound.decisions / recentWork.decisions;
      }
    }
    const replay = traced.get(played);
    if (replay !== undefined) traced.set(kept, replay);
    // The player comes back the next day and does as this play did where they can: a route that adds to a stored
    // value adds to it again, visit after visit.
    for (const storage of visits)
      visitsQueue.push({
        path: {
          inputs: [],
          draws: new Map(),
          inherited: [],
          storage,
          wallClockMs: Math.max(
            (played.path.wallClockMs ?? EPOCH_MS) + DAY_MS,
            savedAt.get(compactKey(JSON.stringify(storage))) ?? -Infinity,
          ),
        },
        score: -visitKeys.size,
        target: null,
        parent: kept,
        budget: 0,
        tried: 0,
        place: -1,
        answer: "",
      });
    for (const lead of leadSteps)
      if (lead.watched.best === lead.distance && lead.distance > 0)
        lead.watched.lead = { play: kept, step: lead.step };
    recent.push(kept);
    if (recent.length > 64) recent.splice(0, recent.length - 64);
    // Only the latest plays keep their resume points; a child of an older one plays from the start.
    resumeLists.push(resumes);
    while (resumesKept > MAX_RESUME_TEXT && resumeLists.length > 1) {
      const oldest = resumeLists.shift()!;
      for (const resume of oldest) if (resume !== undefined) resumesKept -= resume.taggedChars;
      oldest.length = 0;
    }
    // Where the play was in a state in which a watched way's condition would turn (see `observe`).
    const readyFrom = new Map<number, number>();
    for (const each of [...leadSteps.filter((lead) => lead.distance === 0), ...readyNow])
      if (!readyFrom.has(each.watched.side)) readyFrom.set(each.watched.side, each.step);
    // Decisions whose other way no path took: a child each, by the code that way leads to.
    for (const decision of played.decisions) {
      if (decision.step <= shared) continue;
      const other = decision.instruction * 2 + (1 - decision.way);
      if (ways.has(other)) continue;
      // A watched way's condition that came after such a state: its child comes first, whatever its ways cost so far (a
      // few such children per way).
      const ready =
        decision.step > (readyFrom.get(other) ?? Infinity) &&
        (readyQueued.get(other) ?? 0) < MAX_REACH;
      if (ready) readyQueued.set(other, (readyQueued.get(other) ?? 0) + 1);
      // A few children per way and relevant state, so that a target comes back from states that arrive later (a
      // stored flag, a counter's value), up to a bound per way.
      const count = queued.get(other) ?? 0;
      const sideState = `${other}|${played.interactions[decision.step]?.state ?? ""}`;
      const here = queuedHere.get(sideState) ?? 0;
      if (!ready && (count >= options.maxAttempts * SIDE_STATES * 2 || here >= 2)) continue;
      queued.set(other, count + 1);
      queuedHere.set(sideState, here + 1);
      const child: Child = {
        path: played.path,
        score: 0,
        target: decision,
        parent: kept,
        budget: FIRST_BUDGET,
        tried: 0,
        place: -1,
        answer: "",
        sideState,
        reserved: true,
        ...(ready ? { ready: true as const } : {}),
      };
      lastChildOf.set(other, child);
      decisionsQueue.push({ ...child, score: scoreNow(child) });
    }
    // Where the play came closer to a watched condition than any before, its answers there and just after come first:
    // a counter that falls by one answer given again (a retry that costs a point) falls on from there.
    const leadAt = new Set<number>();
    for (const lead of leadSteps)
      if (
        lead.closer &&
        lead.distance > 0 &&
        lead.watched.best === lead.distance &&
        lead.watched.rounds < MAX_LEAD_ROUNDS
      ) {
        lead.watched.rounds += 1;
        for (let step = lead.step; step < lead.step + LEAD_STEPS; step += 1) leadAt.add(step);
      }
    // A state where it would turn is no place to answer otherwise or walk from: the way's condition has to come. One
    // gate per watched way and play, from its first such state.
    for (const [side, step] of readyFrom) {
      const watching = watched.find((each) => each.side === side);
      if (watching !== undefined) reachGate(played, kept, watching, step);
    }
    readyNow = [];
    // Answers not given at an interaction in its relevant state: a child each.
    played.interactions.forEach((_, step) => {
      if (answers(step)) queueAnswers(kept, step, leadAt.has(step));
    });
    for (const photo of photos) {
      answered.add(photo.key);
      answersQueue.push({
        path: {
          inputs: [...played.inputs.slice(0, photo.step), photo.input],
          draws: played.path.draws,
          inherited: played.draws,
          ...startOf(played.path),
        },
        score: answerScore(photo.place, answerKey(photo.input), photo.step),
        target: null,
        parent: kept,
        budget: 0,
        tried: 0,
        place: photo.place,
        answer: answerKey(photo.input),
        key: photo.key,
      });
    }
    // The answers the path gave count as given in their states.
    played.interactions.forEach((interaction, step) => {
      const given = played.inputs[step];
      if (given === undefined) return;
      const key = `${interaction.instruction}|${JSON.stringify(given)}|${interaction.state}`;
      answered.add(key);
      givenAnswers.add(key);
    });
    // Each queue keeps its best children; a dropped one may be queued again by a later play.
    for (const queue of [decisionsQueue, answersQueue, visitsQueue])
      for (const dropped of queue.keep(MAX_QUEUE, scoreNow)) {
        queueCut += 1;
        // A dropped answer may be queued again, unless a play gave it meanwhile.
        if (dropped.key !== undefined && !givenAnswers.has(dropped.key))
          answered.delete(dropped.key);
        if (dropped.target !== null && dropped.reserved === true) {
          const other = dropped.target.instruction * 2 + (1 - dropped.target.way);
          queued.set(other, Math.max(0, (queued.get(other) ?? 1) - 1));
          if (dropped.sideState !== undefined)
            queuedHere.set(
              dropped.sideState,
              Math.max(0, (queuedHere.get(dropped.sideState) ?? 1) - 1),
            );
        }
      }
    return { found, kept, played };
  };

  /**
   * A path that takes `target`'s other way, found by trying the origins its condition and linked decisions read: first
   * those it read as data, then also those of the decisions its values were written under.
   */
  /** Children queued and attempts made per way and relevant state (see {@link SIDE_STATES}). */
  const queuedHere = new Map<string, number>();
  const attemptsHere = new Map<string, number>();
  /** Attempts per way from progress plays, which do not count against `maxAttempts`. */
  const progressAttempts = new Map<number, number>();
  /**
   * Checks a candidate: plays the parent's path with `assignment` (or `path` as it is, from `at`) up to the target's step
   * and `past` interactions on, until the target takes its other way. Null when the assignment changes nothing; else the check,
   * and the path that takes the other way when it did.
   */
  const checkCandidate = (
    parent: Played,
    target: Decision,
    assignment: ReadonlyMap<Origin, Value>,
    guide: Played,
    measure?: (snapshot: Data) => Measure,
    as?: { readonly path: Path; readonly from: number },
    past = CHECK_STEPS,
  ): {
    readonly check: Played;
    readonly shortened: Path;
    readonly from: number;
    readonly grown: number;
    readonly found: { path: Path; from: number } | null;
  } | null => {
    const applied = as?.path ?? apply(parent, assignment, saved, target.step);
    const candidate = applied === null ? null : notBeforeSave(applied);
    if (candidate === null) return null;
    checks += 1;
    // A climb's checks (which measure) have their own bound; the cap counts the others.
    if (measure === undefined) checkedOf.set(checking, (checkedOf.get(checking) ?? 0) + 1);
    const way = target.instruction * 2 + (1 - target.way);
    checksBySide.set(way, (checksBySide.get(way) ?? 0) + 1);
    if (process.env.SX_V2_DEBUG)
      checksOf.set(target.instruction, (checksOf.get(target.instruction) ?? 0) + 1);
    // Replay from the last interaction before the first origin it changes. A later visit or another start clock
    // starts a session of its own.
    const from =
      as?.from ??
      (candidate.storage !== parent.path.storage ||
      candidate.wallClockMs !== parent.path.wallClockMs
        ? -1
        : // The earliest of the changes: an answer, a draw, or continuing later at the target's interaction.
          Math.min(
            ...[...assignment].map(([origin, value]) =>
              "later" in value
                ? target.step - 1
                : origin.startsWith("i")
                  ? Number(origin.slice(1))
                  : origin.startsWith("d")
                    ? (parent.draws[Number(origin.slice(1))]?.step ?? 0) - 1
                    : -1,
            ),
          ));
    // The candidate counts when its play takes the other way anywhere, there or later: what matters is the code behind
    // that way, not that very occurrence. An input the candidate inserts (continuing later) moves the target's step on.
    const grown = Math.max(0, candidate.inputs.length - parent.inputs.length);
    const shortened = { ...candidate, inputs: candidate.inputs.slice(0, target.step + grown) };
    const checkStarted = performance.now();
    const turned = (decision: Decision) =>
      decision.instruction === target.instruction &&
      decision.way !== target.way &&
      decision.step >= turnFrom;
    const check = runner.play(shortened, {
      extend: withPlaced(candidate.placed, goOn(guide)),
      maxSteps: Math.min(options.maxSteps, target.step + grown + past),
      maxStepInstructions: options.maxStepInstructions,
      origins: false,
      until: turned,
      ...(measure === undefined
        ? {}
        : { measure: { at: target.step + grown, instruction: target.instruction, read: measure } }),
      ...(from >= 0 && parent.resumes[from] !== undefined ? { resume: { at: from, parent } } : {}),
    });
    if (process.env.SX_V2_CHECKS === String(target.instruction))
      process.stderr.write(
        `check ${target.instruction}: from ${from} storage ${JSON.stringify(shortened.storage ?? null).slice(0, 300)} clock ${shortened.wallClockMs ?? "-"} inputs ${shortened.inputs.length}->${check.inputs.length} end ${check.end} last ${JSON.stringify(check.inputs.slice(-3))} decisions at target ${check.decisions
          .filter((decision) => decision.instruction === target.instruction)
          .map((decision) => decision.way)
          .join("")}\n`,
      );
    debugCheck.ms += performance.now() - checkStarted;
    debugCheck.instructions += check.instructions;
    debugCheck.steps += check.inputs.length - Math.max(0, from);
    // The check's own play is the path: its inputs up to the turn and the outcomes its draws had (a later visit's route
    // and draws by site included).
    const checkPath = {
      inputs: check.inputs,
      draws: new Map(check.draws.map((draw) => [draw.occurrence, draw.outcome])),
      inherited: [],
      ...startOf(shortened),
    };
    const found = check.decisions.some(turned) ? { path: checkPath, from } : null;
    if (
      found === null &&
      sideFinds.length < MAX_SIDE_FINDS &&
      ([...check.visited].some((index) => visited[index] !== 1) ||
        check.decisions.some((decision) => !ways.has(decision.instruction * 2 + decision.way)) ||
        (check.failure !== null &&
          !crashes.has(`${check.failure.code}@${check.failure.path}:${check.failure.line}`)))
    )
      sideFinds.push({ path: checkPath, from, parent, guide });
    return { check, shortened, from, grown, found };
  };

  /**
   * Hill climbing on the branch distance of the target's condition from its other way (V1's measure): single changes
   * of the origins, nearest first, each kept when the distance read at the target's step falls, until the other way
   * comes or a whole pass brings it no closer. A counter that must reach a value takes many such changes. Typed answers
   * also try the values the condition compares with in that state, and buttons other times to be pressed after.
   */
  const climb = (
    parent: Played,
    target: Decision,
    domains: readonly { origin: Origin; values: Value[] }[],
    guide: Played,
  ): { path: Path; from: number } | null => {
    const instruction = instructions[target.instruction];
    const condition = instruction?.condition ?? instruction?.expression;
    const wanted = target.way === 1;
    const measure = (snapshot: Data) => conditionMeasure(condition, wanted, snapshot);
    // A climb's checks stop where they measure.
    const base = checkCandidate(
      parent,
      target,
      new Map(),
      guide,
      measure,
      {
        path: {
          inputs: parent.inputs,
          draws: parent.path.draws,
          inherited: parent.draws,
          ...startOf(parent.path),
        },
        from: target.step - 1,
      },
      0,
    );
    if (base === null) return null;
    if (base.found !== null) return base.found;
    // Only a condition on a number has a distance that falls step by step.
    const start = measured(base.check);
    if (process.env.SX_V2_DEBUG)
      process.stderr.write(
        `climb ${target.instruction}:${1 - target.way} start ${start === null ? "-" : `${start.distance} ${JSON.stringify(start.values)}`} origins ${domains.length}\n`,
      );
    if (
      start === null ||
      !(start.distance > 0) ||
      !start.values.some((value) => typeof value === "number")
    )
      return null;
    let best = start.distance;
    // Values the condition compares with, as typed answers, and for a count, texts that long (a code of so many digits
    // a script checks the length of); times to press a button after.
    const compared = start.values.flatMap((value) =>
      typeof value === "number"
        ? [value - 1, value, value + 1].flatMap((each) => [
            String(each),
            ...(Number.isInteger(each) && each > 0 && each <= MAX_TYPED_LENGTH
              ? ["1".repeat(each)]
              : []),
          ])
        : [String(value)],
    );
    const climbing = domains.map(({ origin, values }) => {
      const given = origin.startsWith("i") ? parent.inputs[Number(origin.slice(1))] : undefined;
      const extra: Value[] =
        given?.kind === "text"
          ? compared.map((text) => ({ input: { kind: "text", text } }))
          : given?.kind === "button"
            ? PRESS_TIMES.map((afterMs) => ({
                input: { kind: "button", label: given.label, afterMs },
              }))
            : [];
      return { origin, values: [...values, ...extra] };
    });
    let accepted = new Map<Origin, Value>();
    let tried = 0;
    // Where a change brought it closer (an answer's place, a draw's site): such origins come first after that.
    const placeOf = (origin: Origin) =>
      origin.startsWith("i")
        ? `i${parent.interactions[Number(origin.slice(1))]?.instruction}`
        : origin.startsWith("d")
          ? `d${parent.draws[Number(origin.slice(1))]?.site}`
          : origin;
    const good = new Set<string>();
    // Changes that brought it no closer are not tried again after another one did.
    const failed = new Set<string>();
    for (let pass = 0; pass < MAX_CLIMB_PASSES; pass += 1) {
      let closer = false;
      // Every origin's first changes early on: a climb has few checks, and the one that comes closer may be far.
      for (const change of assignments(climbing, 1, true)) {
        const [origin, value] = [...change][0]!;
        const key = `${origin} ${JSON.stringify(value)}`;
        if (failed.has(key)) continue;
        if (tried >= MAX_CLIMB_CHECKS || outOfTime()) return null;
        const assignment = new Map(accepted).set(origin, value);
        const checked = checkCandidate(parent, target, assignment, guide, measure, undefined, 0);
        if (checked === null) continue;
        tried += 1;
        if (checked.found !== null) {
          climbed += 1;
          return checked.found;
        }
        const now = measured(checked.check);
        if (now !== null && now.distance > 0 && now.distance < best) {
          best = now.distance;
          accepted = assignment;
          closer = true;
          // The next pass tries origins of the places that brought it closer first.
          good.add(placeOf(origin));
          break;
        }
        failed.add(key);
      }
      if (process.env.SX_V2_DEBUG)
        process.stderr.write(
          `climb ${target.instruction} pass ${pass} best ${best} tried ${tried}\n`,
        );
      if (!closer) break;
      climbing.sort(
        (left, right) =>
          Number(!good.has(placeOf(left.origin))) - Number(!good.has(placeOf(right.origin))),
      );
    }
    return null;
  };

  /** Decision children queued last per way, and extra gain per way from the conditions it may let read new values. */
  const lastChildOf = new Map<number, Child>();
  const boosts = new Map<number, number>();
  /**
   * Conditions on numbers that a round of solving did not turn (a counter or score that no change of a path's origins
   * brings to its value), watched at every interaction of later plays: the play and step that came closest so far is a lead,
   * which half the random walks go on from, so that a counter that grows over many steps grows on.
   */
  const watched: {
    readonly side: number;
    readonly condition: unknown;
    readonly wanted: boolean;
    best: number;
    lead: { readonly play: Played; readonly step: number } | null;
    rounds: number;
    /** The last decisions a play that came to the condition made before it (see `reachGate`). */
    reacher: readonly { readonly instruction: number; readonly way: number }[];
    /** Of those, the gates (see `reachGate`), once worked out. */
    gates?: readonly { readonly instruction: number; readonly way: number }[];
  }[] = [];
  /** The first state of the play under way where each watched condition would turn, as watched before. */
  let readyNow: { watched: (typeof watched)[number]; step: number }[] = [];
  let leadsNow: {
    watched: (typeof watched)[number];
    step: number;
    distance: number;
    /** Whether it was measured before: the first measure is no progress. */
    closer: boolean;
  }[] = [];
  const watch = (target: Decision, parent: Played): void => {
    const side = target.instruction * 2 + (1 - target.way);
    // A way covered since leaves its place to another.
    for (let at = watched.length - 1; at >= 0; at -= 1)
      if (ways.has(watched[at]!.side)) watched.splice(at, 1);
    if (watched.length >= MAX_WATCHED || watched.some((each) => each.side === side)) return;
    const instruction = instructions[target.instruction];
    const condition = instruction?.condition ?? instruction?.expression;
    if (!comparesNumbers(condition)) return;
    const entry: (typeof watched)[number] = {
      side,
      condition,
      wanted: target.way === 1,
      best: Infinity,
      lead: null,
      rounds: 0,
      // The play the target comes from came to the condition.
      reacher: parent.decisions
        .filter((decision) => decision.order < target.order)
        .slice(-MAX_REACHER)
        .map(({ instruction, way }) => ({ instruction, way })),
    };
    watched.push(entry);
  };
  const observe = (snapshot: Data, step: number): boolean => {
    let closer = false;
    for (const each of watched) {
      if (ways.has(each.side)) continue;
      const found = conditionMeasure(each.condition, each.wanted, snapshot);
      if (!found.values.some((value) => typeof value === "number")) continue;
      // A state where it would take its other way now, after one before: the play from there has to come to it.
      if (found.distance === 0 && each.best === 0) {
        if (!readyNow.some((ready) => ready.watched === each))
          readyNow.push({ watched: each, step });
        continue;
      }
      // Also where it would take its other way now (distance 0) the first time.
      if (found.distance < each.best) {
        leadsNow.push({
          watched: each,
          step,
          distance: found.distance,
          closer: each.best !== Infinity,
        });
        each.best = found.distance;
        closer = true;
      }
    }
    return closer;
  };
  /** The ways and signatures (as `checking`) a climb ran for: one climb each. */
  const climbedFor = new Set<string>();
  /** Checks per way and signature, and the way and signature being solved; checks per way. */
  const checkedOf = new Map<string, number>();
  const checksBySide = new Map<number, number>();
  let checking = "";
  /** What each way's attempts had to vary (see `signatureOf`). */
  const signaturesOf = new Map<number, Set<string>>();
  /**
   * What a target's condition reads, as an attempt at it sees it: the places of the answers and the sites of the draws
   * it comes from, how many answers each offers, the stored keys with how many values the saved states hold for each,
   * and the clock; for a loop's condition, also the step.
   */
  const signatureOf = (parent: Played, occurrences: readonly Decision[]): string => {
    const parts = new Set<string>();
    const target = occurrences[0]!;
    for (const origin of new Set(occurrences.flatMap((occurrence) => [...occurrence.origins]))) {
      const index = Number(origin.slice(1));
      if (origin.startsWith("i")) {
        const interaction = parent.interactions[index];
        parts.add(`i${interaction?.instruction}:${interaction?.options.length}`);
      } else if (origin.startsWith("d")) parts.add(`d${parent.draws[index]?.site}`);
      else if (origin.startsWith("k")) {
        const key = origin.slice(1);
        const values = new Set<string | null>();
        for (const storage of saved.values()) {
          values.add(storedText(storage, key));
          if (values.size >= MAX_STORED_VALUES) break;
        }
        parts.add(`${origin}=${values.size}`);
      } else parts.add(origin);
    }
    // A loop's condition at a later step is another situation (its rounds so far, a time since it began).
    if (instructions[target.instruction]?.kind === "loopStart") parts.add(`@${target.step}`);
    return [...parts].sort().join("|");
  };
  /** Attempts per way whose condition's values came from no origin. */
  const noOriginOf = new Map<number, number>();
  /** Ways whose stored keys writers got a boost (see `boostWriters`). */
  const storedBoosted = new Set<number>();
  /** The functions that save to storage themselves (a helper given the key), by ID; worked out when first needed. */
  let savingFunctions: Set<number> | null = null;
  const savesItself = (functionId: unknown): boolean => {
    if (savingFunctions === null) {
      savingFunctions = new Set();
      const files = instructionFiles(plan);
      const writes = instructions.flatMap((each, index) =>
        each.kind === "storageWrite"
          ? [{ file: files[index], at: Number(record(each.span).so) }]
          : [],
      );
      const bodies = new Map<number, string | undefined>();
      instructions.forEach((each, index) => {
        if (each.kind === "enterFunctionBody") bodies.set(Number(each.functionId), files[index]);
      });
      for (const declared of list(plan.functions)) {
        const span = record(declared.declarationSpan);
        const file = bodies.get(Number(declared.id));
        if (
          writes.some(
            (write) =>
              write.file === file && write.at >= Number(span.so) && write.at < Number(span.eo),
          )
        )
          savingFunctions.add(Number(declared.id));
      }
    }
    return savingFunctions.has(Number(functionId));
  };
  /**
   * A target whose condition reads values that came from no origin (a variable still holding its declared literal, a
   * write on a branch the path did not take), or only stored values no saved state holds otherwise: what flips it is a
   * write elsewhere, which no change of this path's origins makes. The open ways that lead to a write of those variables
   * or keys (a save, or a call of a helper that saves, given the key) no path ran get the target's gain on top of their
   * own, so that they come first.
   */
  const boostWriters = (target: Decision, reason: "noOrigin" | "stored"): void => {
    const side = target.instruction * 2 + (1 - target.way);
    if (reason === "noOrigin") {
      const count = (noOriginOf.get(side) ?? 0) + 1;
      noOriginOf.set(side, count);
      if (count > 1) return;
    } else {
      if (storedBoosted.has(side)) return;
      storedBoosted.add(side);
    }
    const instruction = instructions[target.instruction];
    const names = new Set(
      identifiersIn(instruction?.condition ?? instruction?.expression).map((node) =>
        String(node.name),
      ),
    );
    const keys = [...target.origins].flatMap((origin) =>
      origin.startsWith("k") ? [origin.slice(1)] : [],
    );
    const writers = new Set<number>();
    instructions.forEach((each, index) => {
      if (visited[index] === 1) return;
      if (reason === "stored") {
        if (
          (each.kind === "storageWrite" && mayGiveKey(each.key, keys)) ||
          (each.kind === "callFunction" &&
            list(each.arguments).some((argument) => mayGiveKey(argument.value, keys)) &&
            savesItself(each.functionId))
        )
          writers.add(index);
        return;
      }
      const written =
        each.kind === "assign"
          ? record(each.target).name
          : each.kind === "declareBinding" || each.kind === "declareGlobal"
            ? each.name
            : undefined;
      if (typeof written === "string" && names.has(written)) writers.add(index);
    });
    if (writers.size === 0) return;
    const extra = gain(target.instruction, 1 - target.way);
    let boosted = 0;
    for (const [other, child] of lastChildOf) {
      // A save on the way counts for a later visit, which the way's own code comes before: such a way's gain at most
      // doubles.
      const boost = reason === "stored" ? Math.min(extra, gain(other >> 1, other & 1)) : extra;
      if (ways.has(other) || (boosts.get(other) ?? 0) >= boost) continue;
      const start = other % 2 === 0 ? (other >> 1) + 1 : Number(instructions[other >> 1]?.target);
      if (!reaches(start, writers)) continue;
      boosts.set(other, boost);
      boosted += 1;
      decisionsQueue.push({ ...child, score: scoreNow(child), reserved: false });
    }
    if (process.env.SX_V2_DEBUG)
      process.stderr.write(
        `boost ${reason} ${target.instruction}:${1 - target.way} writers ${writers.size} ways ${boosted} extra ${extra}\n`,
      );
  };
  /** Whether code no path ran, from `start` on (as {@link gain} follows it), comes to one of `targets`. */
  const reaches = (start: number, targets: ReadonlySet<number>): boolean => {
    if (!Number.isInteger(start) || visited[start] === 1) return false;
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length > 0 && seen.size < 10_000) {
      const at = stack.pop()!;
      if (targets.has(at)) return true;
      const instruction = instructions[at];
      if (LEAVES.has(String(instruction?.kind))) continue;
      const after =
        instruction?.kind === "callFunction" ? [Number(instruction.returnInstruction)] : [];
      for (const following of [...(next[at] ?? []), ...after])
        if (visited[following] !== 1 && !seen.has(following)) {
          seen.add(following);
          stack.push(following);
        }
    }
    return false;
  };
  /**
   * The occurrences of a target's decision in its step that have origins: the latest first (a counter tested at each
   * round of a loop has the most behind it at its last test), then the others in order (a helper called more than once
   * can turn at any of its calls). Without origins, the first occurrence.
   */
  const occurrencesOf = (parent: Played, target: Decision): Decision[] => {
    const occurs = (decision: Decision) =>
      decision.instruction === target.instruction &&
      decision.way === target.way &&
      decision.step === target.step;
    const found = parent.decisions.filter(
      (decision) => occurs(decision) && decision.origins.size > 0,
    );
    if (found.length > 1) found.unshift(found.pop()!);
    const first = parent.decisions.find(occurs);
    return found.length > 0 || first === undefined ? found : [first];
  };
  /** Typed answers conditions compared with so far, by ask (see `solve`). */
  const typedPool = new Map<number, Set<string>>();
  /** Gates found per decision way: earlier decisions that its failed checks took the other way (see `solve`). */
  const gatesOf = new Map<number, Set<number>>();
  /** Plays an unsolved target's last solve found worth playing (see `solve`). */
  let progress: { path: Path; from: number }[] = [];
  /**
   * Solves a way not taken yet at the occurrences of its decision in one step of `parent` (see `occurrencesOf`), each with
   * what came before it, on one budget of candidates: the first is the target the rest of the search knows the way by.
   */
  const solve = (
    parent: Played,
    occurrences: readonly Decision[],
    budget: number,
    skip: number,
    guide: Played,
    fresh: boolean,
  ): { path: Path; from: number } | "more" | null => {
    const target = occurrences[0]!;
    let reason = "noOrigin";
    progress = [];
    const shortCircuit = shortCircuits(instructions[target.instruction]);
    let more = false;
    // Per occurrence, the origins and their values its last phase tried (a climb goes on from them).
    const lastDomains = new Map<Decision, { origin: Origin; values: Value[] }[]>();
    // Candidates so far, over both kinds of origins: the budget counts them all.
    let index = 0;
    // Gates found for this target's way before (a later round skips the candidates that found them) and now: earlier
    // decisions of the parent that a failed check took the other way (a candidate that starts a later visit or changes an
    // answer can turn away before the target), whose origins a last phase also varies.
    const side = target.instruction * 2 + (1 - target.way);
    const gateInstructions = gatesOf.get(side) ?? new Set<number>();
    gatesOf.set(side, gateInstructions);
    // The origins and their values tried so far: at another occurrence or phase, the same ones make the same candidates.
    const tried = new Set<string>();
    phases: for (const phase of ["data", "control", "gates"] as const)
      for (const occurrence of occurrences) {
        const control = phase !== "data";
        const of = (decision: Decision) => (control ? decision.origins : decision.dataOrigins);
        const parentWays = new Set(
          parent.decisions
            .filter((decision) => decision.order < occurrence.order)
            .map((decision) => decision.instruction * 2 + decision.way),
        );
        const gateOf = (instruction: number) =>
          parent.decisions.find(
            (each) =>
              each.instruction === instruction &&
              each.order < occurrence.order &&
              each.origins.size > 0,
          );
        const gates = new Set<Decision>();
        for (const instruction of gateInstructions) {
          const gate = gateOf(instruction);
          if (gate !== undefined) gates.add(gate);
        }
        if (phase === "gates" && gates.size === 0) continue;
        // The dependency-closed prefix: earlier decisions linked to the occurrence (and in the last phase, to the gates)
        // through shared origins, and the form fields every one of them reads.
        const origins = new Set<Origin>(of(occurrence));
        const linked = new Set<Decision>([occurrence]);
        if (phase === "gates")
          for (const gate of gates) {
            linked.add(gate);
            for (const origin of gate.origins) origins.add(origin);
          }
        for (let grown = true; grown;) {
          grown = false;
          for (const decision of parent.decisions) {
            if (decision.order >= occurrence.order) break;
            if (linked.has(decision) || ![...of(decision)].some((origin) => origins.has(origin)))
              continue;
            linked.add(decision);
            for (const origin of of(decision))
              if (!origins.has(origin)) {
                origins.add(origin);
                grown = true;
              }
          }
        }
        const fields = new Map<Origin, Set<string>>();
        for (const decision of linked)
          for (const [origin, read] of decision.fields)
            fields.set(origin, new Set([...(fields.get(origin) ?? []), ...read]));
        // The numbers the conditions compare with: a draw tries them (and one either side) first. With the texts they
        // compare with, a typed answer may try them too (a text a helper checks character by character, a separator it
        // looks for), alone and with characters around.
        const near = new Set<number>();
        const literals = new Set<string>();
        for (const decision of linked) {
          // The condition, and the arguments of the calls just before it whose results it reads (a helper given the text
          // to look for).
          const condition = [
            instructions[decision.instruction]?.condition ??
              instructions[decision.instruction]?.expression,
            ...argumentsRead(instructions, decision.instruction),
          ];
          for (const value of numbersIn(condition))
            for (const each of [value - 1, value, value + 1]) {
              near.add(each);
              literals.add(String(each));
            }
          for (const text of textsIn(condition))
            if (text !== "")
              for (const each of [text, `x${text}x`, `xxxxx${text}xxxxx`]) literals.add(each);
          // The texts a regex the condition tests matches (an email address the script checks), those the runtime's
          // matcher agrees with.
          for (const { source, flags } of regexesIn(condition))
            for (const text of regexExamples(source, flags))
              if (runtime.matchesWhole(source, flags, text)) literals.add(text);
        }
        // Typed answers the conditions compare with, by the ask they reach: V1's goals of the target's other way and of
        // the linked decisions either way.
        const typed = new Map<number, Set<string>>();
        for (const decision of linked) {
          const instruction = instructions[decision.instruction];
          const condition = instruction?.condition ?? instruction?.expression;
          for (const wanted of [true, false])
            for (const goal of goalsFor(runner.flow, condition, wanted, decision.instruction))
              if (goal.source.kind === "ask")
                for (const candidate of goal.candidates)
                  if (typeof candidate === "string")
                    typed.set(
                      goal.source.instruction,
                      (typed.get(goal.source.instruction) ?? new Set()).add(candidate),
                    );
        }
        // They join those of every condition solved so far, which come after them (and after the literals), as V1 gathers
        // its directed answers per ask: an answer one condition compares with often passes another's check.
        for (const [ask, texts] of typed) {
          const pool = typedPool.get(ask) ?? new Set<string>();
          for (const text of texts) if (pool.size < MAX_TYPED) pool.add(text);
          typedPool.set(ask, pool);
        }
        // The origins nearest the target first.
        const position = (origin: Origin) =>
          origin.startsWith("i")
            ? Number(origin.slice(1))
            : origin.startsWith("d")
              ? (parent.draws[Number(origin.slice(1))]?.step ?? 0) - 0.5
              : -1;
        const domains: { origin: Origin; values: Value[] }[] = [];
        for (const origin of [...origins].sort((left, right) => position(right) - position(left))) {
          const values = domainOf(
            origin,
            parent,
            fields.get(origin),
            runtime,
            saved,
            () => {
              candidatesCut += 1;
            },
            target.step,
            typed,
            near,
            literals,
            typedPool,
          );
          if (values === null) {
            reason = origin.startsWith("k") ? "stored" : "unknownDomain";
            continue;
          }
          if (values.length > 0) domains.push({ origin, values });
        }
        if (domains.length === 0) continue;
        lastDomains.set(occurrence, domains);
        const key = JSON.stringify(domains);
        if (tried.has(key)) continue;
        tried.add(key);
        reason = "noCandidate";
        // The fewest origins changed first: one at a time, then pairs, and so on.
        for (let changed = 1; changed <= domains.length; changed += 1) {
          for (const assignment of assignments(domains, changed)) {
            if (index >= budget) {
              if (process.env.SX_V2_DEBUG)
                process.stderr.write(
                  `more ${target.instruction}:${1 - target.way} step ${target.step} budget ${budget} domains ${domains.map((domain) => `${domain.origin}=${domain.values.length}`).join(",")}\n`,
                );
              if (budget < options.maxCandidates) {
                more = true;
                break phases;
              }
              candidatesCut += 1;
              reason = "candidates";
              break phases;
            }
            index += 1;
            if (index <= skip) continue;
            if (outOfTime()) return null;
            // The checks of this way and signature over all its attempts, at most `maxCandidates`.
            if ((checkedOf.get(checking) ?? 0) >= options.maxCandidates) {
              candidatesCut += 1;
              reason = "candidates";
              break phases;
            }
            const checked = checkCandidate(parent, target, assignment, guide);
            if (checked === null) continue;
            if (checked.found !== null) return checked.found;
            const { shortened, from } = checked;
            // A check that never came to the target: the parent's decisions it took the other way were gates.
            if (
              phase !== "gates" &&
              gates.size < MAX_GATES &&
              !checked.check.decisions.some(
                (decision) => decision.instruction === target.instruction,
              )
            )
              for (const decision of checked.check.decisions)
                if (
                  !parentWays.has(decision.instruction * 2 + decision.way) &&
                  parentWays.has(decision.instruction * 2 + (1 - decision.way))
                ) {
                  const gate = gateOf(decision.instruction);
                  if (gate === undefined || gates.has(gate) || gates.size >= MAX_GATES) continue;
                  gates.add(gate);
                  gateInstructions.add(decision.instruction);
                }
            // `a and b` reads `b` only once `a` holds: a single change of what the condition read that did not turn it may
            // still make it read more, which a play of it shows.
            if (
              shortCircuit &&
              changed === 1 &&
              progress.length < PROGRESS_PLAYS &&
              [...assignment.keys()].every((origin) => of(occurrence).has(origin))
            )
              progress.push({ path: shortened, from });
          }
        }
      }
    // The first time a target runs out of single and joint changes with what its condition reads: climb on the distance
    // its condition is from the other way (a counter that must reach a value takes many changes, each one closer).
    const climbing = occurrences.find(
      (occurrence) => (lastDomains.get(occurrence)?.length ?? 0) > 0,
    );
    if (
      skip === 0 &&
      fresh &&
      !climbedFor.has(checking) &&
      climbing !== undefined &&
      !outOfTime()
    ) {
      climbedFor.add(checking);
      const climbed = climb(parent, climbing, lastDomains.get(climbing)!, guide);
      if (climbed !== null) return climbed;
    }
    // A counter that must reach a value over many steps rarely comes from changes of one play: its condition is watched
    // from the first round on, which leaves it unsolved or wanting more.
    watch(target, parent);
    if (more) return "more";
    unsolved[reason] = (unsolved[reason] ?? 0) + 1;
    reasonOf.set(side, reason);
    if (reason === "noOrigin" || reason === "stored") boostWriters(target, reason);
    if (process.env.SX_V2_DEBUG) {
      const at = record(instructions[target.instruction]?.span);
      process.stderr.write(
        `unsolved ${reason} ${target.instruction}:${1 - target.way} ${instructions[target.instruction]?.kind} line ${Number(at.sl) + 1} file ${String(at.file ?? at.path ?? "")} origins ${[...target.origins].join(",")} data ${[...target.dataOrigins].join(",")}\n`,
      );
    }
    return null;
  };

  /**
   * Plays a child's path on from interaction `resumeAt` of `parent` (or from the start), going on as `guide` did, and
   * takes it; the new instructions it found. Plays run without a trace; a decision target gets its origins from a
   * traced replay when its turn comes. The first play has one, so that the relevant state knows the names and keys
   * conditions read from the start.
   */
  const playOn = (
    path: Path,
    parent: Played | null,
    resumeAt: number,
    guide: Played | null,
  ): { found: number; kept: Played; played: Played } => {
    const resumable = parent !== null && resumeAt >= 0 && parent.resumes[resumeAt] !== undefined;
    const first = plays === 0;
    const played = runner.play(path, {
      ...(resumable && parent !== null ? { resume: { at: resumeAt, parent } } : {}),
      known: visited,
      patience: PATIENCE,
      keepResumes: true,
      extend: goOn(guide),
      maxSteps: Math.min(options.maxSteps, path.inputs.length + options.extendSteps),
      maxStepInstructions: options.maxStepInstructions,
      origins: first,
      ...(watched.length > 0 ? { observe } : {}),
    });
    if (first) traced.set(played, { upTo: Infinity, replay: played });
    return take(played, resumable ? resumeAt : -1);
  };

  answersQueue.push({
    path: { inputs: [], draws: new Map(), inherited: [] },
    score: Infinity,
    target: null,
    parent: null,
    budget: 0,
    tried: 0,
    place: -1,
    answer: "",
  });
  let stoppedBy: "exhausted" | "budget" | "memory" = "exhausted";
  // The work each kind did so far (in the runner's units: see `Runner.work`), and the new instructions it found and the
  // work it took lately (moving totals): the kind that finds most per unit of work goes next, except that each kind gets
  // a share while it has work. Totals rather than an average of each play's ratio: a cheap play that finds one
  // instruction does not outweigh a costly one that finds many.
  const spent = { decisions: 0, answers: 0, visits: 0, walks: 0 };
  const recentFound = { decisions: 0, answers: 0, visits: 0, walks: 0 };
  const recentWork = { decisions: 0, answers: 0, visits: 0, walks: 0 };
  const rate = { decisions: Infinity, answers: Infinity, visits: Infinity, walks: Infinity };
  const charge = (kind: (typeof KINDS)[number], before: number, found: number) => {
    const work = Math.max(runner.work - before, 1);
    spent[kind] += work;
    recentFound[kind] = (1 - RATE_WEIGHT) * recentFound[kind] + found;
    recentWork[kind] = (1 - RATE_WEIGHT) * recentWork[kind] + work;
    rate[kind] = recentFound[kind] / recentWork[kind];
  };
  for (;;) {
    if (outOfTime()) {
      stoppedBy = "budget";
      break;
    }
    if (getHeapStatistics().used_heap_size >= (options.maxHeapBytes ?? Infinity)) {
      stoppedBy = "memory";
      break;
    }
    if (sideFinds.length > 0) {
      // What checks found besides their targets is decisions' work.
      const sideStarted = runner.work;
      playKind = "decisions";
      underDecision = true;
      let sideFound = 0;
      for (const side of sideFinds.splice(0)) {
        const { found } = playOn(side.path, side.parent, side.from, side.guide);
        sideFound += found;
        if (process.env.SX_V2_DEBUG)
          process.stderr.write(
            `play ${plays} side at ${Math.round(performance.now() - started)} ms found ${found}\n`,
          );
      }
      charge("decisions", sideStarted, sideFound);
      continue;
    }
    const ready = KINDS.filter((kind) => kind !== "walks" || recent.length > 0)
      .filter((kind) => kind !== "decisions" || decisionsQueue.size > 0)
      .filter((kind) => kind !== "answers" || answersQueue.size > 0)
      .filter((kind) => kind !== "visits" || visitsQueue.size > 0);
    const total = spent.decisions + spent.answers + spent.visits + spent.walks;
    const starved = ready.filter((kind) => spent[kind] < MIN_SHARE * total);
    const least =
      starved.length > 0
        ? starved.sort((left, right) => spent[left] - spent[right])[0]
        : ready.sort((left, right) => rate[right] - rate[left])[0];
    // Walks only fill in while targets remain, and the run ends when no target is left. Later visits alone keep it going
    // only while they find code: a value that changes at every visit (a count of launches, a time) makes visits without
    // end, which are left (and counted) once enough in a row found nothing.
    if (
      least === undefined ||
      (decisionsQueue.size === 0 &&
        answersQueue.size === 0 &&
        (visitsQueue.size === 0 || idleVisits >= MAX_IDLE_VISITS))
    ) {
      visitsLeft = visitsQueue.size;
      break;
    }
    if (least === "walks") {
      const walkStarted = runner.work;
      // A random walk: from a random point of a recent path on, random answers and random draw outcomes; with half the
      // chance, while a watched condition not yet met both ways has a lead, from the point closest to it.
      const leads = watched.flatMap((each) =>
        each.lead === null || ways.has(each.side) ? [] : [{ ...each.lead, watched: each }],
      );
      const lead =
        leads.length > 0 && random() < 0.5 ? leads[Math.floor(random() * leads.length)]! : null;
      const base = lead?.play ?? recent[Math.floor(random() * recent.length)]!;
      playKind = "walks";
      underDecision = fromDecisions.has(base);
      const cut = lead?.step ?? Math.floor(random() * (base.inputs.length + 1));
      // It resumes from the last point before the cut the play kept, if any.
      let at = cut;
      while (at >= 0 && base.resumes[at] === undefined) at -= 1;
      const draws = new Map(
        [...base.path.draws].filter(([occurrence]) => (base.draws[occurrence]?.step ?? 0) <= cut),
      );
      let walkDistance = Infinity;
      const policy = new Map<number, { input: ExplorerInput; distance: number }>();
      const walked = runner.play(
        {
          inputs: base.inputs.slice(0, cut),
          draws,
          inherited: base.draws.filter((draw) => draw.step <= cut),
          ...startOf(base.path),
        },
        {
          ...(at < 0 ? {} : { resume: { at, parent: base } }),
          keepResumes: true,
          extend: (interaction) => {
            const previous = lead === null ? undefined : policy.get(interaction.instruction);
            // Toward a lead, the answer last given at this place is given again while the condition got closer since
            // (a deck dealt card by card, a count of waits); otherwise one at random.
            const prior =
              previous !== undefined && walkDistance < previous.distance
                ? previous.input
                : undefined;
            const repeated =
              prior === undefined
                ? undefined
                : prior.kind === "text" &&
                    interaction.options.some((option) => option.kind === "text")
                  ? prior
                  : interaction.options.find((option) =>
                      prior.kind === "wait" ? option.kind === "wait" : sameInput(option, prior),
                    );
            const input =
              repeated ??
              interaction.options[Math.floor(random() * interaction.options.length)] ??
              null;
            if (lead !== null && input !== null)
              policy.set(interaction.instruction, { input, distance: walkDistance });
            return input;
          },
          maxSteps: Math.min(options.maxSteps, cut + options.extendSteps),
          maxStepInstructions: options.maxStepInstructions,
          origins: false,
          random,
          ...(watched.length > 0
            ? {
                observe: (snapshot: Data, step: number) => {
                  if (lead !== null)
                    walkDistance = conditionMeasure(
                      lead.watched.condition,
                      lead.watched.wanted,
                      snapshot,
                    ).distance;
                  return observe(snapshot, step);
                },
              }
            : {}),
        },
      );
      const { found: walkFound } = take(
        {
          ...walked,
          path: {
            ...walked.path,
            draws: new Map(walked.draws.map((draw) => [draw.occurrence, draw.outcome])),
          },
        },
        at,
      );
      charge("walks", walkStarted, walkFound);
      if (process.env.SX_V2_DEBUG)
        process.stderr.write(
          `play ${plays} walks at ${Math.round(performance.now() - started)} ms found ${walkFound}: cut ${cut} inputs ${walked.inputs.length} end ${walked.end}\n`,
        );
      continue;
    }
    const queue =
      least === "decisions" ? decisionsQueue : least === "answers" ? answersQueue : visitsQueue;
    // Scores only fall: a child whose score fell goes back with its score now, until the best one is up to date.
    let child = queue.pop();
    for (
      let now = child === undefined ? 0 : scoreNow(child);
      child !== undefined && now < child.score;
    ) {
      queue.push({ ...child, score: now });
      child = queue.pop();
      if (child !== undefined) now = scoreNow(child);
    }
    if (child === undefined) break;
    if (child.place >= 0) {
      answeredAt.set(child.place, (answeredAt.get(child.place) ?? 0) + 1);
      const tried = `${child.place}|${child.answer}`;
      answerTries.set(tried, (answerTries.get(tried) ?? 0) + 1);
    }
    playKind = least;
    underDecision =
      least === "decisions" || (child.parent !== null && fromDecisions.has(child.parent));
    const childStarted = runner.work;
    let path = child.path;
    let parent = child.parent;
    // An answer child goes on from where its answer differs; a decision child from where its first change is.
    let resumeAt = child.target === null ? child.path.inputs.length - 1 : -1;
    if (child.reach !== undefined && child.target !== null && child.parent !== null) {
      // A gate toward a watched way: solved once from its parent, with a fixed number of candidates.
      const target = child.target;
      const tries = reachTried.get(child.reach) ?? 0;
      if (ways.has(child.reach) || tries >= MAX_REACH) continue;
      reachTried.set(child.reach, tries + 1);
      parent = tracedUpTo(child.parent, target.step);
      const turned = occurrencesOf(parent, target);
      if (turned.length === 0) {
        charge(least, childStarted, 0);
        continue;
      }
      checking = `reach|${child.reach}|${target.instruction * 2 + (1 - target.way)}`;
      const checksBefore = checks;
      turnFrom = target.step;
      let found: ReturnType<typeof solve>;
      try {
        found = solve(parent, turned, child.budget, 0, child.parent, true);
      } finally {
        turnFrom = -Infinity;
      }
      reachChecks.set(child.reach, (reachChecks.get(child.reach) ?? 0) + checks - checksBefore);
      if (found === null || found === "more") {
        charge(least, childStarted, 0);
        continue;
      }
      path = found.path;
      resumeAt = found.from;
    } else if (child.target !== null && child.parent !== null) {
      const target = child.target;
      const side = target.instruction * 2 + (1 - target.way);
      if (ways.has(side)) continue;
      // A condition whose values come from no origin on two parents' paths is left to its writers (see `boostWriters`).
      if ((noOriginOf.get(side) ?? 0) >= 2) continue;
      const count = attempts.get(side) ?? 0;
      const extra = progressAttempts.get(side) ?? 0;
      const here = child.sideState === undefined ? 0 : (attemptsHere.get(child.sideState) ?? 0);
      if (
        child.progress === true
          ? extra >= MAX_PROGRESS_ATTEMPTS
          : count >= options.maxAttempts * SIDE_STATES ||
            (child.tried === 0 && here >= options.maxAttempts)
      )
        continue;
      // A later round of the same attempt (with a bigger budget) is no new attempt.
      if (child.sideState !== undefined && child.tried === 0)
        attemptsHere.set(child.sideState, here + 1);
      if (child.progress === true) progressAttempts.set(side, extra + 1);
      // The parent ran without a trace: its replay with origins, up to the target's step, is what the solver reads.
      parent = tracedUpTo(child.parent, target.step);
      const turned = occurrencesOf(parent, target);
      if (turned.length === 0) {
        unsolved.lost = (unsolved.lost ?? 0) + 1;
        attempts.set(side, count + 1);
        charge(least, childStarted, 0);
        continue;
      }
      // Past its first attempts, a way is tried again only when what its condition reads offers something new: other
      // places or draws, or more saved values of a stored key it reads.
      const signature = signatureOf(parent, turned);
      const seen = signaturesOf.get(side) ?? new Set<string>();
      signaturesOf.set(side, seen);
      const fresh = !seen.has(signature);
      // Checks one way gets with one signature, over all its attempts and rounds, at most `maxCandidates`; a way with no
      // code left behind it, one round.
      checking = `${side}|${signature}`;
      const checkedSoFar = checkedOf.get(checking) ?? 0;
      if (
        checkedSoFar >= options.maxCandidates ||
        (checkedSoFar > 0 &&
          gain(target.instruction, 1 - target.way) + (boosts.get(side) ?? 0) <= 0)
      ) {
        attempts.set(side, count + 1);
        charge(least, childStarted, 0);
        continue;
      }
      if (child.tried === 0 && child.progress !== true) {
        if (!fresh && count >= options.maxAttempts) {
          charge(least, childStarted, 0);
          continue;
        }
        seen.add(signature);
      }
      const found = solve(parent, turned, child.budget, child.tried, child.parent, fresh);
      if (found === "more") {
        const deeper = { ...child, tried: child.budget, budget: child.budget * BUDGET_GROWTH };
        decisionsQueue.push({ ...deeper, score: scoreNow(deeper) });
        charge(least, childStarted, 0);
        continue;
      }
      attempts.set(side, count + 1);
      if (found === null) {
        // Each progress play gets another go at the target, whatever the children queued for it so far.
        let progressFound = 0;
        for (const next of progress) {
          const tried = playOn(next.path, parent, next.from, child.parent);
          progressFound += tried.found;
          const again = lastDecision(tried, target);
          if (again !== undefined && !ways.has(side))
            decisionsQueue.push({
              path: tried.kept.path,
              score: gain(target.instruction, 1 - target.way),
              target: again,
              parent: tried.kept,
              budget: FIRST_BUDGET,
              tried: 0,
              place: -1,
              answer: "",
              progress: true,
            });
        }
        charge(least, childStarted, progressFound);
        continue;
      }
      solved += 1;
      path = found.path;
      resumeAt = found.from;
    }
    const { found: childFound } = playOn(path, parent, resumeAt, child.parent);
    if (process.env.SX_V2_DEBUG)
      process.stderr.write(
        `play ${plays} ${least} at ${Math.round(performance.now() - started)} ms found ${childFound}: ${child.target === null ? "answer" : `turn ${child.target.instruction}:${1 - child.target.way}`} inputs ${path.inputs.length} queues ${decisionsQueue.size}/${answersQueue.size} checks ${checks}\n`,
      );
    charge(least, childStarted, childFound);
    if (least === "visits") idleVisits = childFound > 0 ? 0 : idleVisits + 1;
  }
  if (process.env.SX_V2_DEBUG) {
    // The uncovered ways with the most code behind them, and how often V2 tried them.
    const open = [...ways]
      .filter((way) => !ways.has(way ^ 1))
      .map((way) => ({
        instruction: way >> 1,
        way: 1 - (way & 1),
        gain: gain(way >> 1, 1 - (way & 1)),
      }))
      .sort((left, right) => right.gain - left.gain)
      .slice(0, 25);
    for (const side of open)
      process.stderr.write(
        `open ${side.instruction}:${side.way} gain ${side.gain} attempts ${attempts.get(side.instruction * 2 + side.way) ?? 0} queued ${queued.get(side.instruction * 2 + side.way) ?? 0} line ${Number(record(instructions[side.instruction]?.span).sl) + 1}\n`,
      );
  }
  if (process.env.SX_V2_HEAP !== undefined) writeHeapSnapshot(process.env.SX_V2_HEAP);
  if (process.env.SX_V2_DEBUG)
    for (const [instruction, count] of [...checksOf]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12))
      process.stderr.write(
        `checks ${instruction} line ${Number(record(instructions[instruction]?.span).sl) + 1}: ${count}\n`,
      );
  if (process.env.SX_V2_KEYS !== undefined) {
    // The values saved states hold for the stored keys whose names match, for diagnosis.
    const pattern = new RegExp(process.env.SX_V2_KEYS);
    const values = new Map<string, Set<string>>();
    for (const storage of saved.values())
      for (const entry of storage)
        if (pattern.test(entry.key))
          values.set(
            entry.key,
            (values.get(entry.key) ?? new Set()).add(JSON.stringify(entry.value)),
          );
    for (const [key, found] of values)
      process.stderr.write(`key ${key}: ${[...found].slice(0, 40).join(" ")}\n`);
  }
  if (process.env.SX_V2_DEBUG) {
    let answeredChars = 0;
    for (const key of answered) answeredChars += key.length;
    let savedChars = 0;
    for (const key of saved.keys()) savedChars += key.length;
    process.stderr.write(
      `sizes queues ${decisionsQueue.size}/${answersQueue.size}/${visitsQueue.size} answered ${answered.size} (${answeredChars} chars) given ${givenAnswers.size} saved ${saved.size} (${savedChars} chars) visitKeys ${visitKeys.size} traced ${traced.size} resumeLists ${resumeLists.length} heap ${Math.round(getHeapStatistics().used_heap_size / 1048576)} MB\n`,
    );
  }
  if (process.env.SX_V2_DEBUG) {
    process.stderr.write(
      `spent ${JSON.stringify(spent)} checks ${JSON.stringify(debugCheck)} instructions ${runner.instructionsRun}\n`,
    );
    for (const each of watched)
      process.stderr.write(
        `watched ${each.side >> 1}:${each.side & 1} best ${each.best} lead ${each.lead === null ? "-" : each.lead.step} rounds ${each.rounds}\n`,
      );
  }
  // Ways V2 tried to take and no path took in the end: what keeps a run that ran out of work from being complete.
  const open = [...attempts.keys()].filter((side) => !ways.has(side)).length;
  const files = instructionFiles(plan);
  const coverage = coverageOf(
    plan,
    instructions,
    files,
    runner,
    visited,
    ways,
    attempts,
    checksBySide,
    reasonOf,
    stoppedBy,
    drawnSites,
    options,
  );
  return {
    search: {
      stoppedBy,
      audit: {
        result:
          stoppedBy !== "exhausted"
            ? "capped"
            : open === 0 &&
                queueCut === 0 &&
                savedCut === 0 &&
                stepsCut === 0 &&
                candidatesCut === 0 &&
                visitsLeft === 0
              ? "complete"
              : "incomplete",
      },
      states: plays + checks,
      operations: runner.instructionsRun,
      elapsedMs: Math.round(performance.now() - started),
      plays,
      sessions: plays,
      checks,
      solved,
      unsolved,
      openWays: open,
      candidatesCut,
      climbed,
      queueCut,
      savedCut,
      stepsCut,
      visitsLeft,
    },
    coverage,
    crashes: [...crashes.values()],
    traps: places
      .traps(givenAnswers, (index) => {
        const span = record(instructions[index]?.span);
        return `${files[index] ?? ""}:${typeof span.sl === "number" ? span.sl + 1 : 0}`;
      })
      .map((trap) => ({ ...trap, ...earlierOf(trap.storage) })),
  };
}

/** The values an origin can take, or null when V2 does not know them (a stored key, an unknown draw). */
function domainOf(
  origin: Origin,
  parent: Played,
  fields: ReadonlySet<string> | undefined,
  runtime: Runtime2,
  saved: ReadonlyMap<string, readonly StorageEntry[]>,
  cut: () => void,
  targetStep: number,
  typed: ReadonlyMap<number, ReadonlySet<string>>,
  near: ReadonlySet<number>,
  literals: ReadonlySet<string>,
  pool: ReadonlyMap<number, ReadonlySet<string>>,
): Value[] | null {
  if (origin === CLOCK)
    return [
      // Later in the same session first: a time since a clock read the session made.
      ...(targetStep > 0 ? LATER_GAPS.map((later) => ({ later })) : []),
      ...clockStarts(parent.path.wallClockMs ?? EPOCH_MS).map((clock) => ({ clock })),
    ];
  if (origin.startsWith("k")) {
    // The values the saved states hold for the key; null when none holds another than the parent's start.
    const key = origin.slice(1);
    const values = new Set<string | null>();
    for (const storage of saved.values()) {
      values.add(storedText(storage, key));
      if (values.size >= MAX_STORED_VALUES) break;
    }
    values.delete(storedText(parent.path.storage ?? [], key));
    // Numbers come the least and the greatest first, and on inwards: a condition compares a stored count with a bound.
    let found = [...values];
    const numbers = found.map((value) => (value === null ? NaN : Number(value)));
    if (numbers.every((number) => Number.isFinite(number))) {
      const sorted = found
        .map((value, index) => ({ value, number: numbers[index]! }))
        .sort((left, right) => left.number - right.number);
      found = [];
      for (let low = 0, high = sorted.length - 1; low <= high; low += 1, high -= 1) {
        found.push(sorted[low]!.value);
        if (high > low) found.push(sorted[high]!.value);
      }
    }
    return found.length === 0 ? null : found.map((value) => ({ stored: key, value }));
  }
  if (origin.startsWith("d")) {
    const draw = parent.draws[Number(origin.slice(1))];
    if (draw === undefined) return null;
    const support = draw.support;
    // Every outcome a draw with a small enough support can have (a `switch` over a draw can tell hundreds apart), as
    // the runtime checks them.
    const outcomes = (found: readonly Data[]): Value[] =>
      found
        .filter((outcome) => runtime.outcomeFits(support, outcome))
        .map((outcome) => ({ draw: outcome }));
    if (support.kind === "boolean" || support.kind === "chance")
      return outcomes([true, false].map((value) => ({ kind: "boolean", value })));
    if (support.kind === "integer") {
      const min = Number(support.min);
      const max = Number(support.max);
      if (max - min < MAX_CANDIDATES) {
        const values: Data[] = [];
        const first = [...near].filter(
          (value) => Number.isInteger(value) && value >= min && value <= max,
        );
        for (const value of first) values.push({ kind: "number", value });
        for (let value = min; value <= max; value += 1)
          if (!near.has(value)) values.push({ kind: "number", value });
        return outcomes(values);
      }
    }
    if (support.kind === "candidates" || support.kind === "weighted") {
      const count =
        list(support.candidates).length ||
        (Array.isArray(support.candidates) ? support.candidates.length : 0);
      if (count > 0 && count <= MAX_CANDIDATES)
        return outcomes(Array.from({ length: count }, (_, index) => ({ kind: "index", index })));
    }
    const found = record(
      runtime.randomDrawAlternatives(
        {
          drawId: draw.drawId,
          site: draw.site,
          kind: draw.kind,
          support: draw.support,
          natural: draw.natural,
        },
        16,
      ),
    );
    return outcomes([draw.natural, ...list(found.alternatives)]);
  }
  if (origin.startsWith("i")) {
    const step = Number(origin.slice(1));
    const interaction = parent.interactions[step];
    const given = parent.inputs[step];
    if (interaction === undefined || given === undefined) return null;
    // A form whose fields the conditions read: every combination of those fields' options, the rest as given.
    if (
      given.kind === "form" &&
      given.action === "submit" &&
      fields !== undefined &&
      fields.size > 0
    ) {
      const read = interaction.fields.filter((field) => fields.has(String(field.id)));
      // A toggle without options is off at index 0 and on at index 1, as V1 sets it.
      const choices = read.map((field) => {
        const count = Array.isArray(field.options) ? field.options.length : 0;
        return {
          id: String(field.id),
          values: count > 0 ? Array.from({ length: count }, (_, index) => index) : [0, 1],
        };
      });
      // Made one at a time, up to the candidate cap: their number grows exponentially with the fields.
      const combinations: Value[] = [];
      const at = choices.map(() => 0);
      for (let carry = 0; carry < at.length || combinations.length === 0;) {
        if (combinations.length >= MAX_CANDIDATES) {
          cut();
          break;
        }
        const set: Record<string, number | string> = { ...given.fields };
        choices.forEach((choice, index) => {
          set[choice.id] = choice.values[at[index]!]!;
        });
        combinations.push({ input: { kind: "form", action: "submit", fields: set } });
        for (carry = 0; carry < at.length; carry += 1) {
          at[carry]! += 1;
          if (at[carry]! < choices[carry]!.values.length) break;
          at[carry] = 0;
        }
      }
      return combinations;
    }
    // A typed answer may also be one a condition compares with (V1 offers only its own guesses there).
    // The target's own compared texts first, then the literals of its conditions, then those of other conditions.
    const texts = new Set([
      ...(typed.get(interaction.instruction) ?? []),
      ...literals,
      ...(pool.get(interaction.instruction) ?? []),
    ]);
    const offered = interaction.options.map((option): Value => ({ input: option }));
    if (given.kind !== "text" || texts.size === 0) return offered;
    const known = new Set(
      interaction.options.flatMap((option) => (option.kind === "text" ? [option.text] : [])),
    );
    return [
      ...offered,
      ...[...texts]
        .filter((text) => !known.has(text))
        .slice(0, MAX_TYPED)
        .map((text): Value => ({ input: { kind: "text", text } })),
    ];
  }
  return null;
}

/**
 * Every assignment that changes exactly `count` of the origins, each to another of its values. With `spread`, single
 * changes come in the order of (value's index + 1) · (origin's index + 1): the first origins' values first, yet every
 * origin's first values early on.
 */
function* assignments(
  domains: readonly { origin: Origin; values: readonly Value[] }[],
  count: number,
  spread = false,
): Generator<Map<Origin, Value>> {
  if (count === 1 && spread) {
    const next = domains.map(() => 0);
    for (;;) {
      let chosen = -1;
      let least = Infinity;
      for (let index = 0; index < domains.length; index += 1) {
        if (next[index]! >= domains[index]!.values.length) continue;
        const rank = (next[index]! + 1) * (index + 1);
        if (rank < least) {
          least = rank;
          chosen = index;
        }
      }
      if (chosen < 0) return;
      const domain = domains[chosen]!;
      yield new Map([[domain.origin, domain.values[next[chosen]!]!]]);
      next[chosen]! += 1;
    }
  }
  const chosen: number[] = [];
  function* pick(start: number): Generator<number[]> {
    if (chosen.length === count) {
      yield [...chosen];
      return;
    }
    for (let index = start; index < domains.length; index += 1) {
      chosen.push(index);
      yield* pick(index + 1);
      chosen.pop();
    }
  }
  for (const subset of pick(0)) {
    const lists = subset.map((index) => domains[index]!);
    const sizes = lists.map((domain) => domain.values.length);
    const at = sizes.map(() => 0);
    for (;;) {
      yield new Map(lists.map((domain, index) => [domain.origin, domain.values[at[index]!]!]));
      let carry = 0;
      for (; carry < at.length; carry += 1) {
        at[carry]! += 1;
        if (at[carry]! < sizes[carry]!) break;
        at[carry] = 0;
      }
      if (carry === at.length) break;
    }
  }
}

/** The play's decision at the target's instruction that took the target's way, if it made one. */
function lastDecision(tried: { readonly played: Played }, target: Decision): Decision | undefined {
  return tried.played.decisions.find(
    (decision) => decision.instruction === target.instruction && decision.way === target.way,
  );
}

/**
 * Whether a key expression may give one of `keys`: a literal one, or a template whose texts come in the key in order (the
 * first at its start and the last at its end, when the template starts or ends with text), a few characters at least
 * (not just a separator).
 */
function mayGiveKey(expression: unknown, keys: readonly string[]): boolean {
  const node = record(expression);
  if (node.kind === "literal") return typeof node.value === "string" && keys.includes(node.value);
  if (node.kind !== "template") return false;
  const parts = list(node.parts);
  const texts = parts.flatMap((part) => (part.kind === "text" ? [String(part.value)] : []));
  if (texts.join("").length < 4) return false;
  return keys.some((key) => {
    let at = 0;
    for (const [index, part] of parts.entries()) {
      if (part.kind !== "text") continue;
      const text = String(part.value);
      const found = index === 0 ? (key.startsWith(text) ? 0 : -1) : key.indexOf(text, at);
      if (found < 0) return false;
      if (index === parts.length - 1 && !(key.endsWith(text) && key.length - text.length >= at))
        return false;
      at = found + text.length;
    }
    return true;
  });
}

/** `extend` giving a later visit's placed answers (see `Path.placed`) at their occurrences, where they are offered. */
function withPlaced(
  placed: Path["placed"],
  extend: (interaction: Played["interactions"][number], step: number) => ExplorerInput | null,
): (interaction: Played["interactions"][number], step: number) => ExplorerInput | null {
  if (placed === undefined) return extend;
  const seen = new Map<number, number>();
  return (interaction, step) => {
    const nth = seen.get(interaction.instruction) ?? 0;
    seen.set(interaction.instruction, nth + 1);
    const input = placed.find(
      (each) => each.place === interaction.instruction && each.nth === nth,
    )?.input;
    const offered =
      input !== undefined &&
      interaction.options.some((option) =>
        input.kind === "text" || input.kind === "form"
          ? option.kind === input.kind
          : sameInput(option, input),
      );
    return offered ? input : extend(interaction, step);
  };
}

/**
 * An answer as the place it is given at tells answers apart: what it does, whatever random outcomes it fixes. Waiting is
 * one answer, whenever its deadline falls (a deadline that moves made every wait look new, and come first).
 */
function answerKey(input: ExplorerInput): string {
  if (input.kind === "wait") return JSON.stringify({ kind: "wait" });
  const { random: _random, ...answer } = input;
  return JSON.stringify(answer);
}

/**
 * A condition's branch distance from coming out `wanted` in a state (V1's {@link conditionDistance}), with the values of
 * the variables and stored keys it reads there.
 */
function conditionMeasure(condition: unknown, wanted: boolean, snapshot: Data): Measure {
  const variables = new Map<string, unknown>();
  for (const scope of [{ bindings: snapshot.globals }, ...list(snapshot.frames)])
    for (const binding of list(scope.bindings))
      if (typeof binding.name === "string") variables.set(binding.name, binding.value);
  const storage = new Map(storageOf(snapshot).map((entry) => [entry.key, entry.value]));
  const scalar = (value: unknown): AtomValue =>
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
      ? value
      : undefined;
  const values: (string | number | boolean)[] = [];
  // A draw the condition makes itself (`mood > randomInteger(0..25)`) has not come out where it is measured: it counts at
  // its first outcome, then at its last, and the nearer distance is the measure, as a draw origin can give either.
  let last = false;
  let draws = false;
  const valueOf = (subject: unknown): AtomValue => {
    const node = record(subject);
    if (node.kind === "literal") return scalar(node.value);
    if (node.kind === "group") return valueOf(node.expression);
    if (node.kind === "identifier" && typeof node.name === "string")
      return scalar(variables.get(node.name));
    // A list's length (a deck dealt card by card gets closer to `cards.length <= 0`), or a text's.
    const object = record(node.object);
    if (
      node.kind === "property" &&
      node.name === "length" &&
      object.kind === "identifier" &&
      typeof object.name === "string"
    ) {
      const value = variables.get(object.name);
      // A text's length counts its characters, as the runtime's does.
      if (typeof value === "string") return [...value].length;
      const collection = record(value);
      if (collection.kind === "list" && Array.isArray(collection.items))
        return collection.items.length;
    }
    // What the condition compares with may be worked out of numbers: `limit - 1`, `3 * min(LIMITS)`.
    if (node.kind === "unary" && node.operator === "-") {
      const operand = valueOf(node.operand);
      return typeof operand === "number" ? -operand : undefined;
    }
    if (node.kind === "binary" && ["+", "-", "*", "/"].includes(String(node.operator))) {
      const left = valueOf(node.left);
      const right = valueOf(node.right);
      if (typeof left !== "number" || typeof right !== "number") return undefined;
      const value =
        node.operator === "+"
          ? left + right
          : node.operator === "-"
            ? left - right
            : node.operator === "*"
              ? left * right
              : left / right;
      return Number.isFinite(value) ? value : undefined;
    }
    const callee = record(node.callee);
    const name = callee.kind === "identifier" ? callee.name : undefined;
    if (node.kind === "call" && (name === "min" || name === "max" || name === "abs")) {
      const given = list(node.arguments).map((argument) => record(argument).value);
      const one = record(given[0]);
      const named =
        given.length === 1 && one.kind === "identifier" && typeof one.name === "string"
          ? record(variables.get(one.name))
          : {};
      const items: unknown = named.kind === "list" ? named.items : given.map(valueOf);
      const values: unknown[] = Array.isArray(items) ? items : [];
      const numbers = values.filter((value): value is number => typeof value === "number");
      if (numbers.length === 0 || numbers.length < values.length) return undefined;
      // A long list is no argument list: its least and greatest come by a pass over it.
      return name === "min"
        ? numbers.reduce((least, value) => Math.min(least, value), Infinity)
        : name === "max"
          ? numbers.reduce((most, value) => Math.max(most, value), -Infinity)
          : numbers.length === 1
            ? Math.abs(numbers[0]!)
            : undefined;
    }
    const key = record(node.key);
    if (node.kind === "storageLoad" && key.kind === "literal" && typeof key.value === "string")
      return scalar(storage.has(key.value) ? storage.get(key.value) : record(node.default).value);
    const range = record(list(node.arguments)[0]?.value);
    if (node.kind === "call" && name === "randomInteger" && range.kind === "range") {
      const start = valueOf(range.start);
      const end = valueOf(range.end);
      if (typeof start !== "number" || typeof end !== "number") return undefined;
      draws = true;
      return last ? end - (range.inclusive === true ? 0 : 1) : start;
    }
    return undefined;
  };
  const read = (subject: unknown): AtomValue => {
    const value = valueOf(subject);
    if (value !== undefined && value !== null) values.push(value);
    return value;
  };
  let distance = branchDistance(conditionDistance(condition, wanted, read));
  if (draws) {
    last = true;
    distance = Math.min(distance, branchDistance(conditionDistance(condition, wanted, read)));
  }
  return { distance, values };
}

/** A check's measure (see {@link conditionMeasure}), or null when it read nothing. */
function measured(check: Played): Measure | null {
  const found = check.measured;
  return found === undefined || found.values.length === 0 ? null : found;
}

/** The arguments of the calls shortly before a decision whose results (temporaries) its condition reads. */
function argumentsRead(instructions: readonly Data[], index: number): unknown[] {
  const instruction = instructions[index];
  const read = new Set<number>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (isRecord(value)) {
      if (value.kind === "temporary" && typeof value.temporaryId === "number")
        read.add(value.temporaryId);
      for (const [key, item] of Object.entries(value)) if (key !== "span") walk(item);
    }
  };
  walk(instruction?.condition ?? instruction?.expression);
  const found: unknown[] = [];
  for (let at = index - 1; at >= Math.max(0, index - CALL_LOOKBACK) && read.size > 0; at -= 1) {
    const each = instructions[at];
    if (each?.kind === "callFunction" && read.has(Number(each.destinationTemporary))) {
      found.push(each.arguments);
      // A call given another call's result (a helper wrapping a helper).
      walk(each.arguments);
    }
    // A temporary the condition reads that holds another one's value (a part of an `and`).
    if (each?.kind === "storeTemporary" && read.has(Number(each.temporaryId))) {
      found.push(each.value);
      walk(each.value);
    }
  }
  return found;
}

/** The text literals in an expression. */
function textsIn(expression: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!isRecord(value)) return;
    if (value.kind === "literal" && typeof value.value === "string") found.push(value.value);
    for (const [key, item] of Object.entries(value)) if (key !== "span") walk(item);
  };
  walk(expression);
  return found;
}

/** The regex literals in an expression. */
function regexesIn(expression: unknown): { source: string; flags: string }[] {
  const found: { source: string; flags: string }[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!isRecord(value)) return;
    if (value.kind === "regex" && typeof value.source === "string")
      found.push({
        source: value.source,
        flags: typeof value.flags === "string" ? value.flags : "",
      });
    for (const [key, item] of Object.entries(value)) if (key !== "span") walk(item);
  };
  walk(expression);
  return found;
}

/** The number literals in an expression. */
function numbersIn(expression: unknown): number[] {
  const found: number[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!isRecord(value)) return;
    if (value.kind === "literal" && typeof value.value === "number") found.push(value.value);
    for (const [key, item] of Object.entries(value)) if (key !== "span") walk(item);
  };
  walk(expression);
  return found;
}

/** Whether a condition compares something with a number or two values by order: one a counter can come closer to. */
function comparesNumbers(condition: unknown): boolean {
  const walk = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(walk);
    if (!isRecord(value)) return false;
    if (
      value.kind === "binary" &&
      ["<", "<=", ">", ">=", "==", "!="].includes(String(value.operator)) &&
      [value.left, value.right].some(
        (side) => record(side).kind === "literal" && typeof record(side).value === "number",
      )
    )
      return true;
    if (value.kind === "binary" && ["<", "<=", ">", ">="].includes(String(value.operator)))
      return true;
    return Object.entries(value).some(([key, item]) => key !== "span" && walk(item));
  };
  return walk(condition);
}

/** Whether a decision's condition has an `and` or `or`, whose right side it may not read. */
function shortCircuits(instruction: Data | undefined): boolean {
  const walk = (value: unknown): boolean =>
    Array.isArray(value)
      ? value.some(walk)
      : isRecord(value) &&
        ((value.kind === "binary" && (value.operator === "and" || value.operator === "or")) ||
          Object.entries(value).some(([key, item]) => key !== "span" && walk(item)));
  return walk(instruction?.condition ?? instruction?.expression);
}

/** How a path's session starts (its storage and wall clock), for a path made from it. */
function startOf(path: Path): Pick<Path, "storage" | "wallClockMs"> {
  return {
    ...(path.storage === undefined ? {} : { storage: path.storage }),
    ...(path.wallClockMs === undefined ? {} : { wallClockMs: path.wallClockMs }),
  };
}

/** A key's value in a storage, as JSON text, or null when it is not stored. */
function storedText(storage: readonly StorageEntry[], key: string): string | null {
  const entry = storage.find((each) => each.key === key);
  return entry === undefined ? null : JSON.stringify(entry.value);
}

/**
 * The parent's path with the origins of `assignment` changed, up to the parent's inputs; null when it changes nothing.
 * Stored values make it a later visit: a session of its own from the saved state closest to the parent's start that
 * holds them all, which goes on as the parent did where it can: its inputs no longer line up with the parent's, so the
 * answers changed with them go where the parent gave them, and its draws keep the parent's outcomes (or the solved ones)
 * by site.
 */
function apply(
  parent: Played,
  assignment: ReadonlyMap<Origin, Value>,
  saved: ReadonlyMap<string, readonly StorageEntry[]>,
  targetStep: number,
): Path | null {
  const stored = [...assignment.values()].flatMap((value) => ("stored" in value ? [value] : []));
  if (stored.length > 0) {
    // Of the saved states that hold them all, the one closest to the parent's start: the fewest keys missing or added
    // (each counting twice) and other values differing, so that the later visit goes the parent's way.
    const start = new Map(
      (parent.path.storage ?? []).map((entry) => [entry.key, JSON.stringify(entry.value)]),
    );
    const differences = (storage: readonly StorageEntry[]) => {
      let count = 0;
      const keys = new Set(start.keys());
      for (const entry of storage) {
        const before = start.get(entry.key);
        keys.delete(entry.key);
        if (before === undefined) count += 2;
        else if (before !== JSON.stringify(entry.value)) count += 1;
      }
      return count + keys.size * 2;
    };
    let best: { storage: readonly StorageEntry[]; count: number } | null = null;
    for (const storage of saved.values())
      if (stored.every((value) => storedText(storage, value.stored) === value.value)) {
        const count = differences(storage);
        if (best === null || count < best.count) best = { storage, count };
      }
    if (best !== null) {
      const storage = best.storage;
      // The parent's draws by site, the solved ones changed.
      const siteDraws = new Map<string, DrawEvent[]>();
      for (const draw of parent.draws) {
        const value = assignment.get(`d${draw.occurrence}`);
        const outcome = value !== undefined && "draw" in value ? value.draw : draw.outcome;
        siteDraws.set(draw.site, [...(siteDraws.get(draw.site) ?? []), { ...draw, outcome }]);
      }
      const clock = [...assignment.values()].find((value) => "clock" in value);
      // The answers changed with them, given where the parent gave them.
      const placed = [...assignment].flatMap(([origin, value]) => {
        if (!origin.startsWith("i") || !("input" in value)) return [];
        const step = Number(origin.slice(1));
        const place = parent.interactions[step]?.instruction;
        if (place === undefined) return [];
        const nth = parent.interactions
          .slice(0, step)
          .filter((interaction) => interaction.instruction === place).length;
        return [{ place, nth, input: value.input }];
      });
      return {
        inputs: [],
        draws: new Map(),
        inherited: [],
        storage,
        siteDraws,
        ...(placed.length > 0 ? { placed } : {}),
        // At the clock the parent started at, unless the solver chose another.
        ...(clock !== undefined && "clock" in clock
          ? { wallClockMs: clock.clock }
          : parent.path.wallClockMs === undefined
            ? {}
            : { wallClockMs: parent.path.wallClockMs }),
      };
    }
    return null;
  }
  const inputs = [...parent.inputs];
  const draws = new Map(parent.path.draws);
  let changed = false;
  let wallClockMs = parent.path.wallClockMs;
  let later: number | null = null;
  for (const [origin, value] of assignment) {
    const index = Number(origin.slice(1));
    if ("stored" in value) continue;
    if ("later" in value) {
      later = value.later;
      changed = true;
      continue;
    }
    if ("clock" in value) {
      if (value.clock !== (parent.path.wallClockMs ?? EPOCH_MS)) {
        wallClockMs = value.clock;
        changed = true;
      }
      continue;
    }
    if ("draw" in value) {
      const draw = parent.draws[index];
      if (draw === undefined) return null;
      if (JSON.stringify(draw.outcome) === JSON.stringify(value.draw)) continue;
      draws.set(index, value.draw);
      changed = true;
    } else {
      const given = inputs[index];
      if (given === undefined) return null;
      if (sameInput(given, value.input)) continue;
      inputs[index] = value.input;
      changed = true;
    }
  }
  // The player continues later at the interaction before the target's step, before answering it as the parent did.
  if (later !== null) inputs.splice(targetStep - 1, 0, { kind: "later", afterMs: later });
  return changed
    ? {
        inputs,
        draws,
        inherited: parent.draws,
        ...startOf(parent.path),
        ...(wallClockMs === undefined ? {} : { wallClockMs }),
      }
    : null;
}

/**
 * What the report says of a way solving left open, by the reason it last did (V1's words where they mean the same: see
 * `tools/explore-report.ts`).
 */
const OPEN_NOTES: Readonly<Record<string, string>> = {
  stored: "no explored session stored it",
  // What it reads comes from no answer, draw, or saved data, only from the script (code elsewhere may still set it).
  noOrigin: "no answer, random outcome, or saved data changes what it reads",
  noCandidate: "no answer, random outcome, or saved data tried turned it",
  candidates: "no answer, random outcome, or saved data tried turned it",
};
/** What the report says of a way the search did not finish with when it stopped, by why it stopped. */
const STOP_NOTES = {
  budget: {
    trying: "the time ran out while the playtester tried it",
    untried: "the time ran out before the playtester tried it",
  },
  memory: {
    trying: "the playtester ran out of memory while it tried it",
    untried: "the playtester ran out of memory before it tried it",
  },
};

/**
 * Line coverage as V1 reports it ({@link lineCoverage}): the lines play reached, those the compiler and the package's
 * saves prove can never run, and each condition play took one way only, with what it depends on (the goals V1 derives
 * from it) and, for a way V2 tried and left open, why.
 */
function coverageOf(
  plan: Data,
  instructions: readonly Data[],
  files: readonly string[],
  runner: Runner,
  visited: Uint8Array,
  ways: ReadonlySet<number>,
  attempts: ReadonlyMap<number, number>,
  checksBySide: ReadonlyMap<number, number>,
  reasonOf: ReadonlyMap<number, string>,
  stoppedBy: Explore2Result["search"]["stoppedBy"],
  drawnSites: ReadonlySet<string>,
  options: Explore2Options,
): Explore2Result["coverage"] {
  const flow = runner.flow;
  const constants = constantConditions(instructions, files, options.diagnostics ?? []);
  // Conditions that read only stored keys whose values this package fixes have one value too.
  const fixed = new Map<number, { value: boolean; reason: string }>();
  instructions.forEach((instruction, index) => {
    const conditional =
      instruction.kind === "jumpIfFalse" ||
      (instruction.kind === "loopStart" && instruction.loopKind === "while");
    if (!conditional || constants.has(index)) return;
    const found = flow.constantFromStorage(instruction.condition ?? instruction.expression);
    if (found !== null) fixed.set(index, found);
  });
  const allConstants = new Map(constants);
  for (const [index, found] of fixed) allConstants.set(index, found.value);
  // The ways play took: 1 for the next instruction, 2 for the target.
  const branches = new Uint8Array(instructions.length);
  for (const side of ways) branches[side >> 1]! |= (side & 1) === 0 ? 1 : 2;
  const none = new Uint8Array(instructions.length);
  // The missed ways with the goals V1 derives from their conditions (what they depend on).
  const targets = new Map<number, Target>();
  instructions.forEach((instruction, index) => {
    if (instruction.kind !== "jumpIfFalse" && instruction.kind !== "loopStart") return;
    if (branches[index] !== 1 && branches[index] !== 2) return;
    const way: 0 | 1 = branches[index] === 1 ? 1 : 0;
    targets.set(index * 2 + way, {
      instruction: index,
      way,
      goals: goalsFor(flow, instruction.condition ?? instruction.expression, way === 0, index),
      guards: [],
      attempts: attempts.get(index * 2 + way) ?? 0,
      reach: null,
      chains: new Map(),
      notes: new Map(),
    });
  });
  const coverage = lineCoverage(
    plan,
    instructions,
    files,
    {
      visited,
      chosenVisited: none,
      clockVisited: none,
      branches,
      chosenBranches: none,
      clockBranches: none,
      operations: runner.instructionsRun,
    },
    options.sources,
    {
      fromStart: unreachableInstructions(plan, instructions, constants),
      withStorage: unreachableInstructions(plan, instructions, allConstants),
    },
    constants,
    fixed,
    targets,
    new Map(),
    () => ({ at: "", inputs: 0 }),
    false,
    () => null,
    (condition, at) => flow.readsSetInPlay(condition, at),
    savedFirstChecks(plan, instructions, constants, flow),
    drawnSites,
  );
  // Each way it could not tell can never run says what V2 found out about it.
  for (const branch of coverage.unvisitedBranches) {
    if (branch.reach !== "unknown" || branch.reason !== undefined) continue;
    const side =
      branch.instruction * 2 + (branch.targetInstruction === branch.instruction + 1 ? 0 : 1);
    const stop = stoppedBy === "exhausted" ? undefined : STOP_NOTES[stoppedBy];
    const note =
      OPEN_NOTES[reasonOf.get(side) ?? ""] ??
      (stop === undefined
        ? undefined
        : (checksBySide.get(side) ?? 0) > 0
          ? stop.trying
          : stop.untried);
    if (note !== undefined) branch.reason = note;
  }
  return coverage;
}
