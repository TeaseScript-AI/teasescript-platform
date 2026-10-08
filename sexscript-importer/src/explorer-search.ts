import { totalmem } from "node:os";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { isRecord } from "./ast.ts";
import {
  comparedSlots,
  clockDifferences,
  branchDistance,
  comparedWith,
  conditionDistance,
  conjunctive,
  constantConditions,
  DataFlow,
  distance,
  goalsFor,
  KEY_PLACEHOLDER,
  keyMatcher,
  namesIn,
  callsClock,
  unreachableInstructions,
  type AtomValue,
  type Goal,
  type LoadAlias,
  type PlanDiagnostic,
  type Slot,
} from "./explorer-analysis.ts";
import { FAR, TreasureMap } from "./explorer-guidance.ts";
import { clockModel, flipGap, holdsAt, storedHolds, timeContext } from "./explorer-time.ts";
import {
  EPOCH_MS,
  failureOf,
  isClockInput,
  Session,
  wallClockOf,
  short,
  stateKeys,
  storageOf,
  type Data,
  type Engine,
  type ExplorerInput,
  type Prompt,
  type Runtime,
  type SessionPath,
  type Setup,
  type Step,
  type StorageEntry,
} from "./explorer.ts";

/**
 * The explorer's search: it plays a compiled project through every branch it can reach within a budget
 * ({@link explore}), across sessions.
 *
 * - States are deduplicated by `stateKeys`: a hash of the snapshot without what a script cannot observe.
 * - Sessions: the first starts with empty storage; a later one starts from the storage an explored state left, as the
 *   player's next session would after playing to that point. No stored value is made up.
 * - Search order: play states of a directed attempt first ({@link Lead}), then play states, then clock ones; within
 *   each, states whose step reached new instructions first, in any session; then, earlier sessions first, states that
 *   differ from every explored one in more than clock, random state, and settled handles (their loop key), then the
 *   rest, least repeated first; and the newest first. With cells ({@link Cells}), a step that shows a compared value or
 *   change of value for the first time counts as reaching new instructions, and the states of the cells expanded least
 *   go before the more repeated ones.
 * - Directed search (see {@link explore}) aims at each condition that a step reached but left only one way.
 * - Traps are described at {@link findTraps}.
 * - A corpus carries a run's work to the next one: input lists from the start that together cover what the run
 *   covered, and reach its crashes and traps (see {@link explore}).
 * - Coverage labels: a line is `play` when a step of play executed it, in any session; `clock` when only steps after
 *   the wall clock was set did (with forward time, set back); `unreachable` when no execution can reach it from the session start, constant
 *   conditions taking only their one way (a literal, a condition the compiler proves constant, or one that reads only
 *   stored keys whose values this package fixes); and `unknown` otherwise.
 */

function record(value: unknown): Data {
  return isRecord(value) ? value : {};
}

function list(value: unknown): Data[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Expansions the states of one directed attempt keep the first place in the search order for, in all. */
const ATTEMPT_EXPANSIONS = 20;
/** Expansions, in all, that states closer to a target's comparison keep the first place for. */
const CLOSER_EXPANSIONS = 40;
/**
 * The part of all runtime operations that directed work may take: directed attempts, next sessions, and expansions of
 * states in the first place. Above it, play goes first again until it has caught up.
 */
const DIRECTED_SHARE = 1 / 3;
/** The share of all runtime operations next visits may take to start, apart from directed work's. */
const NEXT_SHARE = 1 / 3;
/** Expansions between two passes of directed search over the conditions left one way, or a tenth of the budget. */
const ANALYZE_EVERY = 50;
/** Directed attempts per condition way, apart from session chains. */
const MAX_ATTEMPTS = 8;
/** Values tried per source of a condition. */
const MAX_CANDIDATES = 3;
/** Answers directed search adds to one ask. */
const MAX_DIRECTED_ANSWERS = 6;
/** Inputs replayed after a changed answer, or in a new session, to reach the condition again. */
const MAX_SUFFIX = 60;
/** Variables whose closeness to a comparison steers the search at the same time. */
const MAX_DISTANCE_TARGETS = 8;
/**
 * With random choices: the other outcomes tried of one draw, the outcomes they are taken from (all of a small support,
 * representative ones of a large one), and the draws of one step that get them.
 */
const RANDOM_ALTERNATIVES = 3;
const RANDOM_SUPPORT = 16;
const RANDOM_DRAWS_PER_STEP = 4;
/**
 * With random choices: the share of all runtime operations that steps with a chosen random outcome and the expansions
 * of states after one may take while play states are open. Such steps can cost much more than others.
 */
const CHOSEN_SHARE = 1 / 16;
/** With guidance: the fewest instructions a region of code not reached yet must have to be led toward. */
const MIN_REGION = 10;
/** The target of the guidance lead, which is no condition's. */
const GUIDED = -1;
/** Sessions one chain toward a stored value may take. */
const MAX_CHAIN = 100;
/** Next sessions started from the storage of completed sessions without a target. */
const MAX_NEXT_SESSIONS = 10;
/** With quit-anywhere next visits: next sessions started from the storage of states a session did not complete. */
const MAX_QUIT_SESSIONS = 20;
/** Compressed snapshots kept for going on from explored states; older ones are replayed when needed. */
const STORE_BYTES = Math.min(4 * 1024 ** 3, Math.max(256 * 1024 ** 2, Math.floor(totalmem() / 8)));
/** The stored snapshots whose bytes, up to {@link DICTIONARY_BYTES}, make the dictionary the later ones are packed with. */
const DICTIONARY_SNAPSHOTS = 8;
const DICTIONARY_BYTES = 64 * 1024;

/** Wall clocks tried for a condition that reads the clock: times of day, weekdays, and later dates. */
const CLOCK_VARIANTS = [-11.5, -6, 6, 11.5, 24, 48, 72, 24 * 8, 24 * 40, 24 * 400].map(
  (hours) => EPOCH_MS + hours * 3_600_000,
);
/**
 * With forward time ({@link ExploreOptions.later}): the gaps after which the player continues, for a condition that
 * reads the clock: the next hour, evening, night, morning, and day, a few days, a week, a month, and a year.
 */
const LATER_GAPS = [1, 6, 11.5, 18, 24, 48, 72, 24 * 8, 24 * 40, 24 * 400].map(
  (hours) => hours * 3_600_000,
);
/** With forward time: the gap before a next session, and before the next day's session of a plan that reads the clock. */
const NEXT_SESSION_GAP = 60_000;
const NEXT_DAY_GAP = 24 * 3_600_000;
/** With realignment: inputs a replay may skip, and buttons it may press that its path does not have, per replay. */
const MAX_SKIPS = 8;
const MAX_FORCED = 8;
/** With forward time: the time steps a state gets at most. */
const MAX_TIME_STEPS = 6;
/** The next sessions at most that start in the windows of the clock comparisons sessions read, from one storage. */
const MAX_SESSION_GAPS = 8;
/** How far before a moment a clock comparison changes a next session starts, to be just inside the window before it. */
const SESSION_MARGIN = 60_000;
/** With forward time: steps before the step that evaluated a clock condition at which the player may also continue. */
const LATER_BACK = 1;

type NodeStatus = "open" | "expanded" | "partial" | "completed" | "failed" | "stuck";

/**
 * How one session of the search starts: from the storage an explored state left (`origin`; none for the first
 * session), at a wall clock.
 */
interface Start extends Setup {
  readonly origin: number | null;
  /** The sessions up to and including this one. */
  readonly session: number;
}

interface Node {
  readonly id: number;
  readonly parent: number | null;
  readonly input: ExplorerInput | null;
  readonly depth: number;
  readonly loop: string;
  /** The index of the {@link Start} of its session. */
  readonly start: number;
  /** Whether its session started at another wall clock, or its path set the clock. */
  readonly clock: boolean;
  /**
   * Whether its path, or one of an earlier session it continues, chose a random outcome (`ExplorerInput.random`). Such
   * a state is another state than play's in the same runtime state, so that play reaches its own.
   */
  readonly chosen: boolean;
  /**
   * With random choices, for a state after a chosen outcome whose expansion its share cut short: the inputs tried, and
   * those it had left, which are tried later even if they are not offered again (time steps are offered once).
   */
  tried?: Set<string>;
  left?: ExplorerInput[];
  /** The directed attempt, or closeness to a comparison, whose first place it shares; null for none. */
  readonly lead: Lead | null;
  /** Its place in the search order apart from a lead: the tier, how often its loop key was seen, and its ID. */
  readonly rank: readonly number[];
  /** With cells ({@link ExploreOptions.cells}): its cell, and the ID of its slot values; -1 without. */
  readonly cell: number;
  readonly values: number;
  /** A corpus replay went on from it, so an earlier run expanded it: it comes after every other state. */
  resumed: boolean;
  /** With a corpus: the lines and condition ways the step that reached it covered ({@link corpusItems}). */
  readonly items: Uint32Array;
  status: NodeStatus;
  readonly edges: number[];
  readonly texts: readonly string[];
  readonly prompt: Prompt;
  /** Where it waits: the instruction of its foreground action, or null without one. */
  readonly waitsAt: number | null;
}

export interface ExploreOptions {
  readonly seed: number;
  /** The time budget; `Infinity` for none. */
  readonly budgetMs: number;
  /**
   * The work budget: the runtime operations the run may call (`Session.operations`), the corpus replay's included; none
   * when absent. It is checked before each step, and a step that started finishes, so a run can go over it by the
   * operations of its last step. A run that only this budget and `maxStates` limit is deterministic.
   */
  readonly budgetOps?: number;
  readonly maxStates: number;
  /** Project sources by path, for the source text of conditions. */
  readonly sources: ReadonlyMap<string, string>;
  /** The compiler's diagnostics, whose `TSV046` proves conditions constant. */
  readonly diagnostics: readonly PlanDiagnostic[];
  /** The corpus of earlier runs, replayed first; given, even empty, the result has the corpus to keep. */
  readonly corpus?: readonly CorpusEntry[];
  /**
   * Cell ranking ({@link Cells}): among states that reached nothing new, those whose cell was expanded least go first,
   * and a step that shows a compared slot's value or change of value for the first time counts as reaching something
   * new. On unless `false`.
   */
  readonly cells?: boolean;
  /**
   * Forward time as play: a later session starts after the wall clock where its origin state ended, and a condition
   * that reads the clock is tried with the player continuing later (`later` inputs, and later session starts) instead
   * of at other wall clocks. Only a start before the clock its origin ended at is a `clock` start. Off by default.
   */
  readonly later?: boolean;
  /**
   * Typed answers from compared values: a typed ask is also answered with the values, in the state at the ask, of what
   * the code compares its answer with (`comparedWith`), such as the line it asks the player to type; and directed
   * search also aims answers at asks whose prompt the code computes. Off by default.
   */
  readonly comparedAnswers?: boolean;
  /**
   * Replay realignment: a directed attempt or corpus entry that meets an input which no longer fits goes on with the
   * input that fits there (the same option or button by label, the wait there is, a later input of the path), or the
   * only button there is, instead of stopping; and the goals of a condition after `else` include the earlier conditions
   * of its chain taking their other way. Off by default.
   */
  readonly realign?: boolean;
  /**
   * Progress keeps a lead: an expansion in the first place for a variable's closeness to a comparison that brings a
   * state closer still does not use up an expansion of that lead, so a loop that needs many rounds to cross a compared
   * constant is followed to it, while one that gets no closer uses its lead up. Off by default.
   */
  readonly progressLeads?: boolean;
  /**
   * A way that needs all parts of its condition (`and` true, `or` false) is steered by the condition's branch distance:
   * a state is closer when fewer of its atoms are unsatisfied, or as many but nearer in sum, and a storage chain counts
   * the parts on other keys too. Off by default.
   */
  readonly conjunctive?: boolean;
  /**
   * Static guidance: a step that brings a state nearer, by the plan's control flow (`TreasureMap`), to the largest region
   * of code play has not reached yet shares a lead toward it, as closeness to a comparison does. Off by default.
   */
  readonly guidance?: boolean;
  /**
   * Random outcomes as choices: the random draws a step makes that pick what happens (`RANDOM_KINDS`) also get their
   * other outcomes (at most {@link RANDOM_ALTERNATIVES} each, each outcome of a site once), as steps with the same input
   * and that choice (`ExplorerInput.random`), which their paths keep; natural outcomes are not recorded. Play after a
   * chosen outcome is labelled "play (chosen random)" (`chosen`). Off by default.
   */
  readonly randomChoices?: boolean;
  /**
   * Quit-anywhere next visits: a player can quit at any moment, and what was saved so far stays, so next sessions also
   * start from the storage of explored states a session did not complete (at most {@link MAX_QUIT_SESSIONS}, within the
   * next visits' share, once per storage): first the one with the most stored cells no next visit started from had,
   * the values of the keys conditions compare and their changes in its session. Off by default.
   */
  readonly quitAnywhere?: boolean;
  /** The snapshot store's limit in bytes; an eighth of the memory by default, from 256 MiB to 4 GiB. */
  readonly storeBytes?: number;
}

/**
 * A path across sessions: the earlier sessions, each from the storage the one before it left (the first from none),
 * then the inputs of the last one, which starts at `wallClockMs` when that is not the play clock.
 */
export interface Repro {
  readonly earlier?: readonly SessionPath[];
  readonly wallClockMs?: number;
  readonly inputs: readonly ExplorerInput[];
}

/** A corpus entry: a path from the start with its seed, kept for the coverage it adds or the crash or trap it reaches. */
export interface CorpusEntry extends Repro {
  readonly seed: number;
  readonly reason: "coverage" | "crash" | "trap";
}

/** Play coverage: lines as in the report's `coverage`, and the condition ways taken. */
export interface CoverageCount {
  percent: number;
  visitedLines: number;
  branchWays: number;
}

/** What a corpus brought to a run, and the corpus to keep after it. */
export interface CorpusResult {
  /** Entries given; replayed (entries of another seed, or past the budget, are kept unreplayed); stale; kept. */
  loaded: number;
  replayed: number;
  /**
   * Replayed entries with an input that no longer fits the pending action, or that the runtime rejects; with
   * realignment, one that no input of the entry, nor a lone button, fits.
   */
  stale: number;
  /** With realignment: replayed entries that went on past an input that no longer fit. */
  realigned?: number;
  written: number;
  /** Inputs the replay applied, and the time it took from the budget. */
  replaySteps: number;
  replayMs: number;
  coverageAtStart: CoverageCount;
  coverageAtEnd: CoverageCount;
  entries: CorpusEntry[];
}

/** A crash: one entry per runtime failure code and source span. */
export interface CrashReport extends Repro {
  code: string;
  message: string;
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** States that ended in this failure. */
  states: number;
  /** Whether every path found to it set the wall clock. */
  clock: boolean;
  /** True when its path chose a random outcome: then no play path without chosen outcomes was found. */
  chosen?: boolean;
  /** The shortest path found to the failure (`earlier`, `wallClockMs`, `inputs`), a play one when there is. */
  texts: readonly string[];
}

/**
 * How a line or way was reached: by play; by play with a chosen random outcome ("play (chosen random)", which counts as
 * play); only by clock steps; or not, proven unreachable or of unknown reach.
 */
export type Reach = "play" | "chosen" | "clock" | "unreachable" | "unknown";

/** Line coverage of one file; `unvisited` ranges hold the lines play did not reach, with what else is known. */
export interface FileCoverage {
  path: string;
  coverableLines: number;
  visitedLines: number;
  percent: number;
  unvisited: { lines: string; reach: Exclude<Reach, "play" | "chosen">; reason?: string }[];
}

/** What a condition's missed way depends on, as directed search read it. */
export type SourceKind = "ask" | "storage" | "clock" | "counter" | "variable";

/** A condition that play reached but left only one way. */
export interface UnvisitedBranch {
  instruction: number;
  kind: "if" | "loop";
  path: string;
  line: number;
  condition: {
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    text: string;
  } | null;
  /** The missed way: `true`/`false` for a condition, `enter`/`exit` for a loop. */
  missed: "true" | "false" | "enter" | "exit";
  /** The first instruction and line of the missed way. */
  targetInstruction: number;
  targetLine: number | null;
  /** `clock` when a clock step took the missed way, `unreachable` for a constant condition. */
  reach: Exclude<Reach, "play" | "chosen">;
  /** Why the way is unreachable, or what kept directed search from it. */
  reason?: string;
  /** What directed search found the condition depends on, and the attempts it made. */
  sources: SourceKind[];
  attempts: number;
  /** For a `clock` way, the shortest path found to it. */
  repro?: Repro;
}

/** A condition way that was missed when directed search first looked at it, and was reached later. */
export interface ReachedBranch {
  path: string;
  line: number;
  condition: string;
  /** The way that was reached. */
  way: "true" | "false" | "enter" | "exit";
  reach: "play" | "chosen" | "clock";
  /** `directed` when a directed attempt or a step after one took it, `search` otherwise. */
  via: "directed" | "search";
  sources: SourceKind[];
  /** The sessions of its shortest path: 1 within the first session. */
  sessions: number;
  /** The shortest path found to it, a play one when there is. */
  repro: Repro;
}

export interface TrapReport extends Repro {
  /** `loop`: the explored states repeat; `stuck`: a state where the player can do nothing and nothing happens. */
  kind: "loop" | "stuck";
  /** Explored states in the trap, and those outside it from which every explored path leads into it. */
  states: number;
  feederStates: number;
  /** Where the player is asked inside the trap, as `path:line`. */
  locations: string[];
  sampleTexts: string[];
  samplePrompts: string[];
  /** Whether the shortest path into it (`earlier`, `wallClockMs`, `inputs`) sets the wall clock. */
  clock: boolean;
}

/**
 * The expansions of states that wait at one place: its `path:line`, the prompt of the first one expanded there, and how
 * many expansions were productive: a step from them reached new instructions, a cell or slot value or change of value
 * not seen before (with cells), or a state closer to a directed comparison. `kind` reads the place (see
 * {@link hotspotKind}).
 */
export interface PromptShare {
  location: string;
  prompt: string;
  expansions: number;
  percent: number;
  productive: number;
  kind: "hub" | "progressing loop" | "spiral";
}

/**
 * What a place where expansions wait is: a `spiral` when fewer than half of its expansions were productive, as when the
 * search goes round a loop that changes nothing any condition reads; else a `hub` when steps by two or more inputs
 * were productive, as at a menu many paths pass; else a `progressing loop`, one input taken again and again with
 * something new each time, as a counter that moves toward a compared constant.
 */
function hotspotKind(expansions: number, productive: number, inputs: number): PromptShare["kind"] {
  if (productive * 2 < expansions) return "spiral";
  return inputs >= 2 ? "hub" : "progressing loop";
}

export interface ExploreResult {
  search: {
    states: number;
    transitions: number;
    expanded: number;
    /** Sessions started: the first, and those from the storage an explored state left. */
    sessions: number;
    /** Inputs the runtime did not accept, such as an answer to an interaction inside a running timer block. */
    rejectedInputs: number;
    /**
     * Inputs whose operation threw, such as a runtime whose event sequence runs out (`TSR101`), and stored states the
     * runtime refused to restore: a problem of the explorer or the runtime, not of the package. `first` has the path
     * from the start that throws, or to the state that was refused.
     */
    engineErrors: { count: number; first: ({ message: string } & Repro) | null };
    /** Why the search stopped: `budget` is the time budget, `operations` the work budget. */
    stoppedBy: "exhausted" | "budget" | "operations" | "maxStates";
    /** Runtime operations the run called: the work that `budgetOps` limits. */
    operations: number;
    elapsedMs: number;
    /** CPU time of the process during the run. */
    cpuMs: number;
    /**
     * Where expanded states waited, by the instruction of their foreground action: the five places with the most
     * expansions, and their share of all expansions. Most of them at one place is usually a loop the search goes round.
     */
    expansionsByPrompt: PromptShare[];
    /** The compressed snapshot store: its largest size, the snapshots it dropped, and the replays that made up for them. */
    /** The snapshot store: its limit, its peak, the snapshots dropped above the limit, and the states replayed. */
    store: { limitBytes: number; peakBytes: number; evicted: number; replays: number };
    /** With cells: the compared slots, and the cells, slot values, and changes of a slot's value found. */
    cells?: { slots: number; cells: number; values: number; transitions: number };
    /**
     * With forward time: the conditions that read the clock, the places a state waits at before one
     * is read, and the time steps taken: by states (`later` inputs) and by next sessions.
     */
    time?: { conditions: number; places: number; steps: number; sessions: number };
    /** With guidance: the regions of code not reached yet that the search was led toward, and those it reached. */
    guidance?: { regions: number; reached: number };
    /** With quit-anywhere next visits: those started from the storage of a state a session did not complete. */
    quitVisits?: number;
    /**
     * By session number (the first session first): the sessions started, and the explored states that completed one,
     * such as how often a long first session came to its end, which later sessions need.
     */
    bySession: { started: number[]; completed: number[] };
  };
  endStates: { completed: number; failed: number; stuck: number; open: number };
  coverage: {
    coverableLines: number;
    /** Lines play reached, also with chosen random outcomes. */
    visitedLines: number;
    percent: number;
    /** Coverable lines by reach; `chosen` only with random choices. */
    reach: Partial<Record<Reach, number>>;
    instructions: number;
    visitedInstructions: number;
    /**
     * Instructions that ran although the static analysis found them unreachable; when not 0, the analysis missed a way
     * execution continues, and no line is labelled `unreachable`.
     */
    staticContradictions: number;
    files: FileCoverage[];
    unvisitedBranches: UnvisitedBranch[];
  };
  directed: {
    /** Condition ways steps had left one way when directed search looked at them. */
    targets: number;
    attempts: number;
    /** Steps that directed attempts took. */
    transitions: number;
    /** With random choices also `chosen`: ways only play with a chosen random outcome reached. */
    reached: { play: number; clock: number; chosen?: number };
    /** Reached targets whose shortest path spans more than one session, and the most sessions one took. */
    multiSession: { ways: number; longestChain: number };
    /** Targets and reached targets by what their condition depends on. */
    bySource: Record<SourceKind | "none", { targets: number; reached: number }>;
    ways: ReachedBranch[];
  };
  crashes: CrashReport[];
  traps: TrapReport[];
  /** With {@link ExploreOptions.corpus}; null without. */
  corpus: CorpusResult | null;
}

/**
 * The snapshots of waiting states, so that directed search can go on from any explored state: the exact bytes a snapshot
 * is written as (its JSON now; the engine's exported bytes with their MAC once restores can take them), packed with zstd
 * level 1 and, after the first few, a dictionary made of the first ones' bytes. Above its limit (an eighth of the
 * memory by default, from 256 MiB to 4 GiB) the oldest ones that are not pinned are dropped; a state without one is
 * replayed.
 */
class SnapshotStore {
  peakBytes = 0;
  evicted = 0;
  readonly limitBytes: number;
  readonly #entries = new Map<number, { data: Uint8Array; dictionary: boolean }>();
  readonly #pinned = new Set<number>();
  readonly #first: Uint8Array[] = [];
  #dictionary: Buffer | null = null;
  #bytes = 0;

  constructor(limitBytes = STORE_BYTES) {
    this.limitBytes = limitBytes;
  }

  put(id: number, snapshot: Data, pinned = false): void {
    this.putBytes(id, snapshotBytes(snapshot), pinned);
  }

  get(id: number): Data | null {
    const bytes = this.getBytes(id);
    return bytes === null ? null : snapshotFrom(bytes);
  }

  /** Keeps a snapshot's exact bytes, which {@link getBytes} gives back as they were. */
  putBytes(id: number, bytes: Uint8Array, pinned = false): void {
    if (this.#dictionary === null && this.#first.length < DICTIONARY_SNAPSHOTS) {
      this.#first.push(bytes);
      if (this.#first.length === DICTIONARY_SNAPSHOTS) {
        this.#dictionary = Buffer.from(Buffer.concat(this.#first).subarray(0, DICTIONARY_BYTES));
        this.#first.length = 0;
      }
    }
    const dictionary = this.#dictionary !== null;
    // zstd's result shares a larger pooled block that one kept entry would keep alive; a plain copy has its own size.
    const data = new Uint8Array(
      zstdCompressSync(bytes, {
        params: { [constants.ZSTD_c_compressionLevel]: 1 },
        ...(this.#dictionary === null ? {} : { dictionary: this.#dictionary }),
      }),
    );
    const known = this.#entries.get(id);
    if (known !== undefined) this.#bytes -= known.data.length;
    this.#entries.set(id, { data, dictionary });
    this.#bytes += data.length;
    if (pinned) this.#pinned.add(id);
    this.peakBytes = Math.max(this.peakBytes, this.#bytes);
    for (const [key, value] of this.#entries) {
      if (this.#bytes <= this.limitBytes) break;
      if (this.#pinned.has(key) || key === id) continue;
      this.#entries.delete(key);
      this.#bytes -= value.data.length;
      this.evicted += 1;
    }
  }

  getBytes(id: number): Uint8Array | null {
    const entry = this.#entries.get(id);
    if (entry === undefined) return null;
    return zstdDecompressSync(
      entry.data,
      entry.dictionary && this.#dictionary !== null ? { dictionary: this.#dictionary } : {},
    );
  }

  drop(id: number): void {
    const entry = this.#entries.get(id);
    if (entry === undefined || this.#pinned.has(id)) return;
    this.#entries.delete(id);
    this.#bytes -= entry.data.length;
  }
}

/**
 * The exact bytes the store keeps of a snapshot: its JSON. A restore that checks the engine's own exported bytes (with
 * their MAC) would keep those instead, and {@link snapshotFrom} would hand them back.
 */
function snapshotBytes(snapshot: Data): Uint8Array {
  return Buffer.from(JSON.stringify(snapshot), "utf8");
}

function snapshotFrom(bytes: Uint8Array): Data | null {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  return isRecord(value) ? value : null;
}

/** A binary heap of open states by rank: lower comes first, compared element by element. */
class Frontier {
  readonly #items: { node: number; rank: readonly number[] }[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(node: number, rank: readonly number[]): void {
    const items = this.#items;
    items.push({ node, rank });
    for (let index = items.length - 1; index > 0;) {
      const parent = (index - 1) >> 1;
      if (!before(items[index]!.rank, items[parent]!.rank)) break;
      [items[index], items[parent]] = [items[parent]!, items[index]!];
      index = parent;
    }
  }

  /** The rank of the state that comes first. */
  peek(): readonly number[] | undefined {
    return this.#items[0]?.rank;
  }

  pop(): number | undefined {
    return this.popEntry()?.node;
  }

  /** The state that comes first, with the rank it was queued at. */
  popEntry(): { node: number; rank: readonly number[] } | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined || items.length === 0) return top;
    items[0] = last;
    for (let index = 0; ;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;
      if (left < items.length && before(items[left]!.rank, items[best]!.rank)) best = left;
      if (right < items.length && before(items[right]!.rank, items[best]!.rank)) best = right;
      if (best === index) break;
      [items[index], items[best]] = [items[best]!, items[index]!];
      index = best;
    }
    return top;
  }
}

/**
 * The frontier with cells: the open states of each cell (and place in the order before cells), with one place in the
 * order per cell, which its least expansions and best state give. Expanding a cell moves only its own place, so the
 * search finds the state that comes first without reordering every state of that cell.
 */
/**
 * Open states in two queues: those whose path chose a random outcome come first only in their turn, and when no other
 * state is open.
 */
class SplitFrontier {
  readonly #play: Pick<Frontier, "size" | "push" | "pop">;
  readonly #chosen: Pick<Frontier, "size" | "push" | "pop">;
  readonly #isChosen: (node: number) => boolean;
  readonly #turn: () => boolean;

  constructor(
    play: Pick<Frontier, "size" | "push" | "pop">,
    chosen: Pick<Frontier, "size" | "push" | "pop">,
    isChosen: (node: number) => boolean,
    turn: () => boolean,
  ) {
    this.#play = play;
    this.#chosen = chosen;
    this.#isChosen = isChosen;
    this.#turn = turn;
  }

  get size(): number {
    return this.#play.size + this.#chosen.size;
  }

  push(node: number, rank: readonly number[]): void {
    (this.#isChosen(node) ? this.#chosen : this.#play).push(node, rank);
  }

  pop(): number | undefined {
    return this.#chosen.size > 0 && (this.#play.size === 0 || this.#turn())
      ? this.#chosen.pop()
      : this.#play.pop();
  }
}

class CellFrontier {
  /**
   * The open states by cell and by the order before cells (the first {@link GROUP} order elements), each group with its
   * place in the order when queued.
   */
  readonly #groups = new Map<string, number>();
  readonly #entries: {
    readonly cell: number;
    readonly group: readonly number[];
    readonly states: Frontier;
    queued: readonly number[] | null;
  }[] = [];
  readonly #order = new Frontier();
  readonly #cellOf: (node: number) => number;
  readonly #expansions: (cell: number) => number;
  #size = 0;

  constructor(cellOf: (node: number) => number, expansions: (cell: number) => number) {
    this.#cellOf = cellOf;
    this.#expansions = expansions;
  }

  get size(): number {
    return this.#size;
  }

  /** Queues a state at `rank`: the order before cells, its cell's expansions, then the state's own order. */
  push(node: number, rank: readonly number[]): void {
    const cell = this.#cellOf(node);
    const group = rank.slice(0, GROUP);
    const key = `${cell}|${group.join(",")}`;
    let id = this.#groups.get(key);
    if (id === undefined) {
      id = this.#entries.length;
      this.#groups.set(key, id);
      this.#entries.push({ cell, group, states: new Frontier(), queued: null });
    }
    this.#entries[id]!.states.push(node, rank.slice(GROUP + 1));
    this.#size += 1;
    this.#queue(id);
  }

  pop(): number | undefined {
    for (let next = this.#order.popEntry(); next !== undefined; next = this.#order.popEntry()) {
      const entry = this.#entries[next.node]!;
      // Only the place a group was last queued at counts; an earlier one is from before a better state came.
      if (entry.queued !== next.rank) continue;
      entry.queued = null;
      const now = this.#rank(entry);
      if (now === null) continue;
      if (before(next.rank, now)) {
        // The cell was expanded since: its place moves back.
        this.#queue(next.node);
        continue;
      }
      const node = entry.states.pop()!;
      this.#size -= 1;
      this.#queue(next.node);
      return node;
    }
    return undefined;
  }

  #rank(entry: {
    cell: number;
    group: readonly number[];
    states: Frontier;
  }): readonly number[] | null {
    const first = entry.states.peek();
    return first === undefined ? null : [...entry.group, this.#expansions(entry.cell), ...first];
  }

  /** Gives a group its place in the order now, unless it already has an earlier or equal one. */
  #queue(id: number): void {
    const entry = this.#entries[id]!;
    const rank = this.#rank(entry);
    if (rank === null || (entry.queued !== null && !before(rank, entry.queued))) return;
    entry.queued = rank;
    this.#order.push(id, rank);
  }
}

/** The order elements before a state's cell expansions: lead, clock, new instructions, and session (see `order`). */
const GROUP = 4;

/**
 * The cells of the search ({@link ExploreOptions.cells}). A state's cell is where it waits (its pending action, the
 * return points of its active calls, and the pass of each active `for` and `repeat` loop, as those loops make progress)
 * with the bucket of each compared slot's value (`comparedSlots`), each stored key a pattern matches apart: unset, null,
 * a boolean, a compared text or other text, or a number's or a duration's place among the constants it is compared
 * with, such as below, at, or above `15` for `t < 15`. A cell groups states coarsely: what a condition computes from a
 * slot (`n + 1 == 3`) can still tell states of one cell apart. The search expands the cells expanded least first. The
 * buckets are read from the step's snapshot, from the slots' bindings (in scope, or kept for a timer, media, or button
 * block) and storage entries only.
 */
class Cells {
  readonly slots: readonly Slot[];
  /** Expansions by cell. */
  readonly expansions: number[] = [];
  /** Binding slots by name, and storage slots by stored key (found by key or pattern once per key). */
  readonly #byName = new Map<string, number[]>();
  readonly #byKey = new Map<string, readonly number[]>();
  readonly #patterns: readonly {
    readonly slot: number;
    readonly matches: (key: string) => boolean;
  }[];
  /**
   * The slot values read so far: a binding slot, or a storage slot with one stored key, by `slot` or `slot:key`; and
   * the buckets of each, by text, numbered from 1 (0 is unset).
   */
  readonly #sources = new Map<string, number>();
  readonly #buckets: Map<string, number>[] = [];
  /** The slot values seen, as `source,bucket,...` lists in source order, by ID; and each one's list. */
  readonly #values = new Map<string, number>();
  readonly #vectors: Int32Array[] = [];
  readonly #cells = new Map<string, number>();
  /** Changes of a value's bucket seen (`source:from:to`), and the pairs of slot values compared for them. */
  readonly #transitions = new Set<string>();
  readonly #pairs = new Set<string>();

  constructor(slots: readonly Slot[]) {
    this.slots = slots;
    const patterns: { slot: number; matches: (key: string) => boolean }[] = [];
    slots.forEach((slot, index) => {
      if (slot.kind === "storage") patterns.push({ slot: index, matches: keyMatcher(slot.name) });
      else this.#byName.set(slot.name, [...(this.#byName.get(slot.name) ?? []), index]);
    });
    this.#patterns = patterns;
  }

  get stats() {
    return {
      slots: this.slots.length,
      cells: this.#cells.size,
      values: this.#buckets.reduce((sum, buckets) => sum + buckets.size, 0),
      transitions: this.#transitions.size,
    };
  }

  /**
   * The cell of a waiting state, and the ID of its slot values; `novel` when a slot shows a value, or a change of value
   * from the state before (`from`, the ID of its slot values), seen for the first time.
   */
  of(
    snapshot: Data,
    waitsAt: number | null,
    from: number | null,
    clock: readonly (readonly [string, string])[] = [],
  ): { cell: number; values: number; novel: boolean; fresh: boolean } {
    let novel = false;
    const found = new Map<number, number>();
    const note = (key: string, text: string) => {
      let source = this.#sources.get(key);
      if (source === undefined) {
        source = this.#buckets.length;
        this.#sources.set(key, source);
        this.#buckets.push(new Map());
      }
      if (found.has(source)) return;
      const buckets = this.#buckets[source]!;
      let id = buckets.get(text);
      if (id === undefined) {
        id = buckets.size + 1;
        buckets.set(text, id);
        novel = true;
      }
      found.set(source, id);
    };
    const put = (slot: number, key: string, value: unknown) =>
      note(key, bucket(this.slots[slot]!, value));
    // With forward time, whether each clock comparison read after where the state waits holds at its wall clock.
    for (const [key, text] of clock) note(key, text);
    // The innermost binding of a name in scope first, then the globals; each scope kept for a block is read apart, as
    // which of them a block sees depends on the call that kept it.
    const read = (scopes: readonly Data[], key: (slot: number, scope: number) => string) =>
      scopes.forEach((scope, index) => {
        for (const binding of list(scope.bindings)) {
          const slots =
            typeof binding.name === "string" ? this.#byName.get(binding.name) : undefined;
          for (const slot of slots ?? []) put(slot, key(slot, index), binding.value);
        }
      });
    read([...list(snapshot.frames).toReversed(), { bindings: snapshot.globals }], (slot) =>
      String(slot),
    );
    read(list(snapshot.retainedScopes), (slot, index) => `${slot}@${index}`);
    for (const entry of list(snapshot.scriptStorage)) {
      const key = entry.key;
      if (typeof key !== "string") continue;
      let slots = this.#byKey.get(key);
      if (slots === undefined) {
        slots = this.#patterns.filter(({ matches }) => matches(key)).map(({ slot }) => slot);
        this.#byKey.set(key, slots);
      }
      for (const slot of slots) put(slot, `${slot}:${key}`, entry.value);
    }
    const vector = Int32Array.from([...found].sort(([left], [right]) => left - right).flat());
    const text = vector.join(",");
    let values = this.#values.get(text);
    if (values === undefined) {
      values = this.#vectors.length;
      this.#values.set(text, values);
      this.#vectors.push(vector);
    }
    if (from !== null && from !== values && !this.#pairs.has(`${from}>${values}`)) {
      this.#pairs.add(`${from}>${values}`);
      for (const change of changes(this.#vectors[from]!, vector)) {
        if (this.#transitions.has(change)) continue;
        this.#transitions.add(change);
        novel = true;
      }
    }
    const returns = list(snapshot.callFrames).map((frame) => frame.returnInstruction);
    const loops = list(snapshot.loopFrames).map((frame) =>
      frame.kind === "for"
        ? `f${String(frame.position)}`
        : frame.kind === "repeat"
          ? `r${String(frame.remaining)}`
          : "w",
    );
    const place = `${waitsAt ?? "-"}/${returns.join("/")}/${loops.join("/")}|${values}`;
    let cell = this.#cells.get(place);
    const fresh = cell === undefined;
    if (cell === undefined) {
      cell = this.#cells.size;
      this.#cells.set(place, cell);
      this.expansions.push(0);
    }
    return { cell, values, novel, fresh };
  }
}

/** A value's bucket for a slot (see {@link Cells}); a length as the runtime counts it, in code points or entries. */
function bucket(slot: Slot, value: unknown): string {
  const data = record(value);
  if (slot.length) {
    const length =
      typeof value === "string"
        ? [...value].length
        : Array.isArray(data.items)
          ? data.items.length
          : Array.isArray(data.entries)
            ? data.entries.length
            : null;
    return length === null ? "other" : numberBucket(slot.numbers, length);
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return numberBucket(slot.numbers, value);
  if (typeof value === "string") return slot.strings.has(value) ? JSON.stringify(value) : "text";
  if (
    data.kind === "duration" &&
    typeof data.milliseconds === "number" &&
    data.months === undefined &&
    data.days === undefined
  )
    return `d${numberBucket(slot.durations, data.milliseconds)}`;
  return "other";
}

/** A number's place among ascending constants: at one (`=c`), or how many are below it (`#n`). */
function numberBucket(constants: readonly number[], value: number): string {
  let below = 0;
  for (const constant of constants) {
    if (constant === value) return `=${constant}`;
    if (constant < value) below += 1;
  }
  return `#${below}`;
}

/** The changes of a bucket between two slot value lists (`source, bucket, ...` in source order), as `source:from:to`. */
function changes(from: Int32Array, to: Int32Array): string[] {
  const found: string[] = [];
  let left = 0;
  let right = 0;
  while (left < from.length || right < to.length) {
    const leftSource = left < from.length ? from[left]! : Infinity;
    const rightSource = right < to.length ? to[right]! : Infinity;
    const source = Math.min(leftSource, rightSource);
    const before = leftSource === source ? from[left + 1]! : 0;
    const after = rightSource === source ? to[right + 1]! : 0;
    if (before !== after) found.push(`${source}:${before}:${after}`);
    if (leftSource === source) left += 2;
    if (rightSource === source) right += 2;
  }
  return found;
}

function before(left: readonly number[], right: readonly number[]): boolean {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return (left[index] ?? 0) < (right[index] ?? 0);
  }
  return false;
}

/**
 * The first place in the search order, shared by the states of one directed attempt (or by the states closer to one
 * target's comparison) for a number of expansions in all, and only until the target is reached.
 */
interface Lead {
  remaining: number;
  readonly target: number;
}

/** A session chain toward a stored value: the closest value reached so far, and how. */
interface Chain {
  /** The distance of the best storage so far from what the condition needs; 0 when it holds. */
  best: number;
  /** The storage entry with that value, as text, and the sessions it took. */
  value: string;
  sessions: number;
  /** Sessions this chain started. */
  started: number;
  /** Passes without a closer value since the last session it started. */
  stale: number;
  /** An attempt of this chain is still queued. */
  queued: boolean;
  /** The storages measured so far, and the closest of them. */
  scanned: number;
  closest: { left: Left; distance: number; value: string } | null;
  readonly matches: (key: string) => boolean;
}

/** A condition way that directed search aims at. */
interface Target {
  readonly instruction: number;
  /** 0 continues with the next instruction (condition true, loop entered), 1 goes to the target. */
  readonly way: 0 | 1;
  readonly goals: readonly Goal[];
  /** With realignment: the goals of the earlier conditions of its `else if` chain taking their other way. */
  readonly guards: readonly Guard[];
  attempts: number;
  reach: { label: "play" | "chosen" | "clock"; via: "directed" | "search"; repro: Repro } | null;
  /** Session chains toward the stored values its condition needs, by key. */
  readonly chains: Map<string, Chain>;
  /** What keeps directed search from the way, when known. */
  note: string | null;
}

/**
 * A directed attempt: from an explored state, or in a new session from `start`, apply `inputs` in turn. A chain
 * attempt is a session that raises a stored value toward a target.
 */
interface Attempt {
  readonly target: number;
  readonly from: number | null;
  readonly start: Start | null;
  readonly inputs: readonly ExplorerInput[];
  readonly chain?: string;
  /** With forward time, an attempt that continues later: like a clock attempt, its states take no first place. */
  readonly later?: true;
}

/**
 * What steers the search toward a target by closeness: a variable's to a comparison, or, for a way that needs all parts
 * of its condition, the condition's branch distance (`conditionDistance`).
 */
type DistanceTarget =
  | {
      readonly kind: "variable";
      readonly target: number;
      readonly name: string;
      readonly operator: string;
      readonly constant: number;
    }
  | {
      readonly kind: "condition";
      readonly target: number;
      readonly condition: unknown;
      readonly wanted: boolean;
    };

/** A plain value as a condition's atom reads it; undefined for another. */
function atomScalar(value: unknown): AtomValue {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
    ? value
    : undefined;
}

/** The first step that evaluated a condition: from a state (`null` for a session start) with an input. */
interface Witness {
  readonly node: number | null;
  readonly start: number;
  readonly input: ExplorerInput | null;
}

/** Storage an explored state left: the state, its entries, and the sessions it took. */
interface Left {
  readonly node: number;
  readonly entries: readonly StorageEntry[];
  /** The storage as JSON, which tells storages apart. */
  readonly key: string;
  readonly sessions: number;
}

/**
 * Explores a compiled project's plan from a fresh session until every state is expanded and directed search has
 * nothing left to try, or a limit is reached. Sessions after the first start from the storage an explored state left:
 * a few from completed sessions, and chains toward the stored values conditions need.
 *
 * Directed search: every {@link ANALYZE_EVERY} expansions, and whenever nothing else is left, each condition that a
 * step reached but left one way becomes a target. The static data flow (`DataFlow`) finds what its condition reads,
 * and `goalsFor` the values that take the missed way:
 *
 * - an ask's answer: the ask is answered again on the path of the step that first evaluated the condition (its
 *   witness), with each value, and the rest of that path is replayed; the values also become answers of that ask
 *   wherever the search meets it;
 * - a stored value: sessions are chained. When an explored state left storage that satisfies the condition, a session
 *   starts from it and replays the witness path; otherwise a session starts from the storage closest to it and
 *   replays the path that led to that storage, as long as each session gets closer ({@link MAX_CHAIN} at most);
 * - the clock: the player continues at other wall clock times before the witness step (`clock`);
 * - a variable the code counts or sets: states closer to the comparison, by `distance`, take the first place.
 *
 * An answer attempt's states share the first place for {@link ATTEMPT_EXPANSIONS} expansions in all, until the target
 * is reached (a session chain goes on from the storage it reached instead), and play states closer to a variable's comparison share it for {@link CLOSER_EXPANSIONS}; clock states
 * take only their attempt's own steps and otherwise come after all play states. Directed work takes at most
 * {@link DIRECTED_SHARE} of all runtime operations, which measure what steps cost.
 *
 * A corpus ({@link ExploreOptions.corpus}) is replayed before the search, from the budget (`replayCorpus`); its
 * operations are no part of the directed share. The corpus to keep is the result's: the paths to crashes and traps,
 * then a greedy set cover over the lines and condition ways the run covered, by paths of steps that covered one first.
 */
export function explore(engine: Engine, plan: Data, options: ExploreOptions): ExploreResult {
  const started = performance.now();
  const cpuAtStart = process.cpuUsage();
  const instructions = list(plan.instructions);
  const files = instructionFiles(plan);
  const session = new Session(engine, plan, options.seed);
  const chooses = options.randomChoices === true;
  const quitAnywhere = options.quitAnywhere === true;
  // Corpus paths with chosen random outcomes replay them also without random choices; other draws stay natural.
  session.randomChoices =
    chooses ||
    (options.corpus ?? []).some((entry) =>
      [...(entry.earlier ?? []), entry].some((part) =>
        part.inputs.some((input) => input.random !== undefined),
      ),
    );
  /** With random choices: the outcomes tried of each draw site, by place and input, so that each is tried once there. */
  const randomTried = new Set<string>();
  /** With random choices: the steps with another random outcome not taken yet, from `chosenAt` on. */
  const chosenSteps: { node: number; input: ExplorerInput }[] = [];
  let chosenAt = 0;
  /** Condition ways play with a chosen random outcome took before they were targets, with the step that took each. */
  const chosenWays = new Map<
    number,
    { parent: number | null; input: ExplorerInput | null; start: number }
  >();
  const flow = new DataFlow(plan, instructions, {
    computedPrompts: options.comparedAnswers === true,
  });
  if (options.comparedAnswers === true) {
    session.scopedReads = true;
    for (const [ask, expressions] of comparedWith(flow, instructions, "asks"))
      session.comparedWith.set(ask, expressions);
  }
  for (const [button, expressions] of comparedWith(flow, instructions, "timed"))
    session.timedWith.set(button, expressions);
  const differences = clockDifferences(flow, instructions);
  session.clockDifferences.push(
    ...differences.filter(
      (difference) => difference.numbers.length + difference.durations.length > 0,
    ),
  );
  /** The conditions that compare a difference of clock reads around a button. */
  const measured = new Set(differences.flatMap((difference) => difference.conditions));
  const constants = constantConditions(instructions, files, options.diagnostics);
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
  const cells = options.cells === false ? null : new Cells(comparedSlots(flow, instructions));
  const elseIfs =
    options.realign === true ? elseIfChains(instructions) : new Map<number, number[]>();
  // With guidance, the map of the plan, measured again from what play has not reached at each analysis.
  const map = options.guidance === true ? new TreasureMap(plan, instructions, allConstants) : null;
  const dead = map === null ? null : unreachableInstructions(plan, instructions, allConstants);
  /**
   * With guidance: the region of code not reached yet the search is led toward, by its first instruction, the regions
   * tried, and the lead that states which come nearer to the region share; measured again at each analysis, and once
   * the region is reached or its lead spent, the next largest region not tried yet.
   */
  const guidance: {
    region: ReadonlySet<number> | null;
    lead: Lead | null;
    readonly tried: Set<number>;
    reached: number;
  } = { region: null, lead: null, tried: new Set(), reached: 0 };
  const guide = () => {
    if (map === null) return;
    const { region, lead } = guidance;
    const reached = region !== null && [...region].some((index) => session.visited[index] === 1);
    if (reached) guidance.reached += 1;
    if (region !== null && !reached && lead !== null && lead.remaining > 0) return;
    if (lead !== null) lead.remaining = 0;
    const unreached = (index: number) => session.visited[index] === 0 && dead?.[index] === 0;
    const next = map
      .regions(unreached)
      .find((members) => members.length >= MIN_REGION && !guidance.tried.has(members[0]!));
    guidance.lead = null;
    guidance.region = null;
    if (next === undefined) return;
    const members = new Set(next);
    guidance.region = members;
    guidance.tried.add(next[0]!);
    map.update((index) => members.has(index));
    guidance.lead = { remaining: CLOSER_EXPANSIONS, target: GUIDED };
  };
  const store = new SnapshotStore(options.storeBytes);
  const nodes: Node[] = [];
  const byState = new Map<string, number>();
  const loopSeen = new Map<string, number>();
  /**
   * With random choices, the loop keys and cell expansions of states after a chosen random outcome are counted apart, so
   * that they do not move play states back.
   */
  const chosenLoopSeen = new Map<string, number>();
  const chosenExpansions: number[] = [];
  const expansionsOf = (node: Node): number =>
    cells === null
      ? 0
      : node.chosen
        ? (chosenExpansions[node.cell] ?? 0)
        : cells.expansions[node.cell]!;
  const queue = (expansions: (cell: number) => number): Pick<Frontier, "size" | "push" | "pop"> =>
    cells === null ? new Frontier() : new CellFrontier((node) => nodes[node]!.cell, expansions);
  // Also for a corpus whose paths chose outcomes: their states keep to their share as well.
  const frontier = session.randomChoices
    ? new SplitFrontier(
        queue((cell) => cells?.expansions[cell] ?? 0),
        queue((cell) => chosenExpansions[cell] ?? 0),
        (node) => nodes[node]!.chosen,
        () => withinChosenShare(),
      )
    : queue((cell) => cells?.expansions[cell] ?? 0);
  const crashes = new Map<string, CrashReport>();
  const starts: Start[] = [{ origin: null, storage: [], wallClockMs: EPOCH_MS, session: 1 }];
  const later = options.later === true;
  /** With forward time: the wall clock where each state stands, by ID. */
  const wallEnd: number[] = [];
  /**
   * The start of a session from an explored state's storage (`origin`; the first session for none), `gap` after the
   * wall clock where that state stands: a play start for a positive gap, as time goes forward.
   */
  const laterStart = (origin: number | null, storage: readonly StorageEntry[], gap: number) => ({
    origin,
    storage,
    wallClockMs: (origin === null ? EPOCH_MS : wallEnd[origin]!) + gap,
    clock: gap <= 0,
    session: origin === null ? 1 : starts[nodes[origin]!.start]!.session + 1,
  });
  /** A plan that reads the clock gets a next day's session too. */
  const readsClock = later && instructions.some((instruction) => flow.flowOf(instruction).clock);
  /**
   * With quit-anywhere next visits: whether a stored key is one the script reads: one a condition compares, one a load
   * reads (a template's computed parts any text), and one a call gives a function that loads its parameter.
   */
  const comparedKey = (() => {
    if (!quitAnywhere) return () => false;
    const keyOf = (expression: unknown): string | null => {
      const node = record(expression);
      if (node.kind === "literal") return typeof node.value === "string" ? node.value : null;
      if (node.kind !== "template") return null;
      return list(node.parts)
        .map((part) =>
          part.kind === "text" && typeof part.value === "string" ? part.value : KEY_PLACEHOLDER,
        )
        .join("");
    };
    const keys = new Set<string>();
    const loadsParameter = new Map<number, Set<unknown>>();
    for (const definition of list(plan.functions)) {
      const parameters = new Set(list(definition.parameters).map((parameter) => parameter.name));
      const end = Math.min(Number(definition.endInstruction), instructions.length);
      for (let index = Number(definition.entryInstruction); index < end; index += 1)
        visitNodes(instructions[index], (node) => {
          const key = record(node.key);
          if (
            node.kind === "storageLoad" &&
            key.kind === "identifier" &&
            parameters.has(key.name)
          ) {
            const loaded = loadsParameter.get(Number(definition.id)) ?? new Set();
            loadsParameter.set(Number(definition.id), loaded.add(key.name));
          }
        });
    }
    instructions.forEach((instruction) => {
      if (instruction.kind === "jumpIfFalse" || instruction.kind === "loopStart")
        for (const key of flow.flowOf(instruction.condition ?? instruction.expression).keys)
          keys.add(key);
      visitNodes(instruction, (node) => {
        const key = node.kind === "storageLoad" ? keyOf(node.key) : null;
        if (key !== null) keys.add(key);
      });
      const loaded = loadsParameter.get(Number(instruction.functionId));
      if (instruction.kind === "callFunction" && loaded !== undefined)
        for (const argument of list(instruction.arguments)) {
          const key = loaded.has(argument.parameterName) ? keyOf(argument.value) : null;
          if (key !== null) keys.add(key);
        }
    });
    const matchers = [...keys].map(keyMatcher);
    const known = new Map<string, boolean>();
    return (key: string): boolean => {
      let compared = known.get(key);
      if (compared === undefined) {
        compared = matchers.some((matches) => matches(key));
        known.set(key, compared);
      }
      return compared;
    };
  })();
  /** The stored cells of a storage a session left: the values of compared keys, and their changes from its start. */
  const cellsOf = (entries: readonly StorageEntry[], before: readonly StorageEntry[]): string[] => {
    const prior = new Map(before.map((entry) => [entry.key, JSON.stringify(entry.value)]));
    const cells: string[] = [];
    const present = new Set<string>();
    for (const { key, value } of entries) {
      present.add(key);
      if (!comparedKey(key)) continue;
      const now = JSON.stringify(value);
      cells.push(`${key}=${now}`);
      const was = prior.get(key) ?? "none";
      if (was !== now) cells.push(`${key}:${was}>${now}`);
    }
    for (const [key, was] of prior)
      if (!present.has(key) && comparedKey(key)) cells.push(`${key}:${was}>none`);
    return cells;
  };
  /**
   * With forward time: the clock comparisons of the plan, and where the player waits right before a step evaluates
   * one, by where the state waits (its pending action's instruction, or `start` for a session start), with those
   * conditions. A state that waits there gets time steps ({@link timeSteps}), and the comparisons' outcomes at its wall
   * clock are part of its cell.
   */
  const times = later ? clockModel(plan, instructions) : null;
  const clockAfter = new Map<string, Set<number>>();
  const clockKey = (waitsAt: unknown) => (typeof waitsAt === "number" ? String(waitsAt) : "start");
  /** The outcomes of the clock comparisons read after where a state waits, at a wall clock: `1`, `0`, or `?`. */
  const outcomes = (snapshot: Data, waitsAt: unknown, now: number): [string, string][] => {
    const after = times === null ? undefined : clockAfter.get(clockKey(waitsAt));
    if (times === null || after === undefined) return [];
    const context = timeContext(snapshot);
    return [...after].flatMap((instruction) =>
      times.comparisons.get(instruction)!.map((comparison, index): [string, string] => {
        const holds = holdsAt(comparison, times, context, now);
        return [`clock:${instruction}:${index}`, holds === undefined ? "?" : holds ? "1" : "0"];
      }),
    );
  };
  /** Time steps tried, from a cell (or a session start's storage) to the outcomes they lead to. */
  const timeStepsTried = new Set<string>();
  /** The first state of each session start, by the start's index; and the state of one that ended in its first step. */
  const firstNodeOf = new Map<number, number>([[0, 0]]);
  const startSnapshots = new Map<number, Data>();
  const timeStepsTaken = { steps: 0, sessions: 0 };
  /**
   * The time steps of a state that waits where a clock condition is read next: for each of those comparisons that
   * comes out the other way within the horizon, a `later` input just past that moment (`flipGap`); nearest first, at
   * most {@link MAX_TIME_STEPS}, and each only once from one cell (`from`) to the outcomes it leads to, so that time,
   * which never ends, adds only the states that compare differently.
   */
  const timeSteps = (snapshot: Data, waitsAt: unknown, now: number, from: string): number[] => {
    const after = times === null ? undefined : clockAfter.get(clockKey(waitsAt));
    if (times === null || after === undefined) return [];
    const context = timeContext(snapshot);
    const gaps = new Set<number>();
    for (const instruction of after)
      for (const comparison of times.comparisons.get(instruction)!) {
        const gap = flipGap(comparison, times, context, now);
        if (gap !== null) gaps.add(gap);
      }
    const steps: number[] = [];
    for (const gap of [...gaps].sort((left, right) => left - right)) {
      const to = `${from}>${JSON.stringify(outcomes(snapshot, waitsAt, now + gap))}`;
      if (timeStepsTried.has(to)) continue;
      timeStepsTried.add(to);
      steps.push(gap);
      if (steps.length >= MAX_TIME_STEPS) break;
    }
    return steps;
  };
  /**
   * The gaps a next session can start after, from the first state of one that starts now: for every clock comparison
   * a session has read anywhere so far (a return window: back too soon, too late), each moment it comes out the other
   * way, just past and just before it, and midway between two such moments; each only once from a storage (`from`) to
   * the outcomes of all those comparisons it leads to, at most {@link MAX_SESSION_GAPS}, nearest first. A next session
   * computes its values from the clock again, so the comparisons are read with none kept.
   */
  const sessionGaps = (snapshot: Data, now: number, from: string): number[] => {
    if (times === null) return [];
    const context = timeContext(snapshot);
    const read = [...new Set([...clockAfter.values()].flatMap((after) => [...after]))].flatMap(
      (instruction) => times.comparisons.get(instruction)!,
    );
    const moments = [
      ...new Set(
        read.flatMap((comparison) => {
          const gap = flipGap(comparison, times, context, now);
          return gap === null ? [] : [gap];
        }),
      ),
    ].sort((left, right) => left - right);
    const candidates = new Set<number>();
    moments.forEach((gap, index) => {
      candidates.add(gap);
      if (gap > 3 * SESSION_MARGIN) candidates.add(gap - 2 * SESSION_MARGIN);
      const next = moments[index + 1];
      if (next !== undefined) candidates.add(Math.round((gap + next) / 2));
    });
    const outcomesAt = (at: number) =>
      read.map((comparison) => {
        const holds = holdsAt(comparison, times, context, at);
        return holds === undefined ? "?" : holds ? "1" : "0";
      });
    const gaps: number[] = [];
    for (const gap of [...candidates].sort((left, right) => left - right)) {
      const to = `${from}>${outcomesAt(now + gap).join("")}`;
      if (timeStepsTried.has(to)) continue;
      timeStepsTried.add(to);
      gaps.push(gap);
      if (gaps.length >= MAX_SESSION_GAPS) break;
    }
    return gaps;
  };
  /** A start is a clock start when it says so; without forward time, when it is not at the play clock. */
  const clockStart = (start: Start): boolean => start.clock ?? start.wallClockMs !== EPOCH_MS;
  /** Whether a session continues from a state whose path chose a random outcome. */
  const chosenStart = (start: Start): boolean =>
    start.origin !== null && nodes[start.origin]!.chosen;
  /**
   * With forward time, a next session that does not start after the clock where its origin stands, or a first session
   * before the play clock, is a clock start: a player comes back later.
   */
  const backwards = (origin: number | null, wallClockMs: number): boolean =>
    origin === null ? wallClockMs < EPOCH_MS : wallClockMs <= wallEnd[origin]!;
  /** How long after its origin a session started; {@link NEXT_SESSION_GAP} for the first one, or a shorter gap. */
  const gapOf = (startIndex: number): number => {
    const start = starts[startIndex]!;
    const gap = start.origin === null ? 0 : start.wallClockMs - wallEnd[start.origin]!;
    return Math.max(NEXT_SESSION_GAP, gap);
  };
  const laterAttempts: Attempt[] = [];
  const witnesses = new Map<number, Witness>();
  const targets = new Map<number, Target>();
  // Answers in the same session go first, then session chains, then clock attempts.
  const playAttempts: Attempt[] = [];
  /**
   * With forward time: states, or session starts (with the start's index), that left a step which read a clock
   * condition first, to give their time steps (see {@link runTimeJob}).
   */
  const timeJobs: { node: number | null; start: number }[] = [];
  const chainAttempts: Attempt[] = [];
  const clockAttempts: Attempt[] = [];
  const distanceTargets: DistanceTarget[] = [];
  /** Waiting states by the ask instruction they wait at, a few each. */
  const askNodes = new Map<number, number[]>();
  /** Each distinct storage a play state left, in the order found, and the ones of completed sessions. */
  const left: Left[] = [];
  const leftKeys = new Map<string, number>();
  const completedKeys = new Set<string>();
  const completedLeft: number[] = [];
  let nextFromCompleted = 0;
  let quitVisits = 0;
  let completedVisits = 0;
  /** With quit-anywhere next visits: the stored cells of the storages next visits started from. */
  const seedCells = new Set<string>();
  const cellsOfLeft = new Map<number, readonly string[]>();
  /** Storage that started a next session without a target. */
  const startedFrom = new Set<string>([JSON.stringify([])]);
  /**
   * With forward time: the storages next sessions started from, with the first state of the one a minute later and
   * its wall clock, to start more in windows sessions read later; and how many comparisons sessions had read then.
   */
  const sessionOrigins: {
    readonly key: string;
    readonly entry: Left;
    readonly snapshot: Data;
    readonly now: number;
    readonly begun: number;
  }[] = [];
  let learnedAtOrigins = 0;
  let transitions = 0;
  /** Whether the step {@link transition} last took reached something new, for the productive expansions. */
  let lastStepNew = false;
  /** Steps of directed attempts. */
  let directedTransitions = 0;
  /**
   * Runtime operations of directed work: attempts, next sessions, and expansions in the first place. A step's
   * operations measure its cost, which differs a lot between packages and steps.
   */
  let directedWork = 0;
  /** Runtime operations next visits took to start, within {@link NEXT_SHARE}. */
  let nextWork = 0;
  /** Runtime operations of the corpus replay, which are no part of this run's work. */
  let replayWork = 0;
  /** With random choices: runtime operations of steps with a chosen outcome, within {@link CHOSEN_SHARE}. */
  let chosenWork = 0;
  let attemptCount = 0;
  let expanded = 0;
  let rejectedInputs = 0;
  let replays = 0;
  const engineErrors: ExploreResult["search"]["engineErrors"] = { count: 0, first: null };
  const items = options.corpus === undefined ? null : corpusItems(instructions, files);
  /** With a corpus: the items covered so far, the steps that covered one first, and the state of each crash. */
  const covered = new Uint8Array(items?.size ?? 0);
  const candidates: Candidate[] = [];
  const crashNodes = new Map<string, number>();
  /** While the corpus is replayed, its open states wait here for the frontier. */
  let replaying = false;
  const replayedOpen: number[] = [];

  const reproOf = (node: Node | null, input: ExplorerInput | null, startIndex: number): Repro => {
    const inputs = node === null ? [] : pathTo(nodes, node);
    if (input !== null) inputs.push(input);
    const earlier: SessionPath[] = [];
    for (let start = starts[startIndex]!; start.origin !== null;) {
      const origin = nodes[start.origin]!;
      const before = starts[origin.start]!;
      earlier.unshift(sessionPath(pathTo(nodes, origin), before.wallClockMs));
      start = before;
    }
    const wallClockMs = starts[startIndex]!.wallClockMs;
    return {
      ...(earlier.length === 0 ? {} : { earlier }),
      ...(wallClockMs === EPOCH_MS ? {} : { wallClockMs }),
      inputs,
    };
  };

  const withinShare = () => directedWork <= (session.operations - replayWork) * DIRECTED_SHARE;
  const withinNextShare = () => nextWork <= (session.operations - replayWork) * NEXT_SHARE;
  const withinChosenShare = () => chosenWork <= (session.operations - replayWork) * CHOSEN_SHARE;
  /**
   * Whether directed search is done with a target: a way only play with a chosen random outcome reached is still aimed
   * at by play without one, whose states are not limited by {@link CHOSEN_SHARE}.
   */
  const settled = (target: Target | undefined): boolean =>
    target?.reach != null && target.reach.label !== "chosen";
  const active = (lead: Lead | null): lead is Lead =>
    lead !== null && lead.remaining > 0 && !settled(targets.get(lead.target)) && withinShare();
  /**
   * The order of a state: play states with a lead first, then play, then clock, then the states an earlier run
   * expanded. Within those, states whose step reached new instructions first, in any session; otherwise earlier
   * sessions first, so that next sessions do not crowd out the ones before them; then by tier, repeats, and newest. A
   * clock attempt takes its own steps but no first place after them, so that play goes first.
   */
  const leads = (node: Node): boolean => !node.clock && active(node.lead);
  /** With guidance, how many decisions a state waiting at an instruction is from the region it is led toward. */
  const approachAt = (waitsAt: unknown): number =>
    map === null || typeof waitsAt !== "number" ? FAR : (map.distances[waitsAt] ?? FAR);
  const order = (node: Node): readonly number[] => {
    const [tier = 0, ...rest] = node.rank;
    return [
      node.resumed ? 1 : 0,
      leads(node) ? 0 : node.clock ? 2 : 1,
      tier === 0 ? 0 : 1,
      starts[node.start]!.session,
      // With cells, the states of the cell expanded least first (see `CellFrontier`).
      ...(cells === null ? [] : [expansionsOf(node)]),
      tier,
      ...rest,
    ];
  };

  /** Adds the state a step reached, or finds it among the explored ones; records witnesses, targets, and crashes. */
  const transition = (
    parent: Node | null,
    input: ExplorerInput | null,
    step: Step,
    startIndex: number,
    lead: Lead | null,
  ): Node => {
    const start = starts[startIndex]!;
    const clock = (parent?.clock ?? clockStart(start)) || (input !== null && isClockInput(input));
    const chosen = (parent?.chosen ?? chosenStart(start)) || (input?.random?.length ?? 0) > 0;
    // Play after a chosen random outcome takes no lead, time steps, witness, or storage for later sessions: it stays
    // within its share, apart from directed work and next visits.
    const inherited = chosen
      ? null
      : (lead ?? (parent !== null && active(parent.lead) ? parent.lead : null));
    const length = (parent === null ? 0 : parent.depth) + (input === null ? 0 : 1);
    const stepItems = items === null ? NO_ITEMS : items.of(step, clock);
    let first = false;
    for (const item of stepItems) {
      if (covered[item] === 1) continue;
      covered[item] = 1;
      first = true;
    }
    if (first)
      candidates.push({ parent: parent?.id ?? null, input, start: startIndex, items: stepItems });
    if (parent !== null && input !== null) offerChoices(parent, input, step);
    for (const way of step.ways) {
      const instruction = way >> 1;
      if (times?.comparisons.has(instruction) === true && !chosen) {
        const at = clockKey(parent?.waitsAt);
        const known = clockAfter.get(at) ?? new Set();
        // The state the step left was expanded already: it gets its time steps now.
        if (!known.has(instruction)) timeJobs.push({ node: parent?.id ?? null, start: startIndex });
        clockAfter.set(at, known.add(instruction));
      }
      if (!witnesses.has(instruction) && !chosen)
        witnesses.set(instruction, { node: parent?.id ?? null, start: startIndex, input });
      const target = targets.get(way);
      if (target === undefined) {
        // A way chosen play takes before directed search aims at it: reached when it does.
        if (chosen && !clock && !chosenWays.has(way))
          chosenWays.set(way, { parent: parent?.id ?? null, input, start: startIndex });
        continue;
      }
      const label = clock ? "clock" : chosen ? "chosen" : "play";
      const known = target.reach;
      const knownSessions = known === null ? 0 : 1 + (known.repro.earlier?.length ?? 0);
      const strength = (reach: "play" | "chosen" | "clock") =>
        reach === "play" ? 0 : reach === "chosen" ? 1 : 2;
      if (
        known === null ||
        strength(label) < strength(known.label) ||
        (known.label === label &&
          (start.session < knownSessions ||
            (start.session === knownSessions && length < known.repro.inputs.length)))
      )
        target.reach = {
          label,
          via: inherited !== null ? "directed" : "search",
          repro: reproOf(parent, input, startIndex),
        };
    }
    const waitsAt = record(step.snapshot.foregroundAction).owningInstruction;
    // A step to a known state also records the slot values and changes it shows.
    const place =
      cells?.of(
        step.snapshot,
        typeof waitsAt === "number" ? waitsAt : null,
        parent === null ? null : parent.values,
        step.snapshot.status === "waiting"
          ? outcomes(step.snapshot, waitsAt, wallClockOf(step.snapshot))
          : [],
      ) ?? null;
    lastStepNew = step.newInstructions > 0 || place?.novel === true || place?.fresh === true;
    const keys = stateKeys(step.snapshot);
    const stateKey = chosen ? `chosen ${keys.state}` : keys.state;
    const known = byState.get(stateKey);
    if (known !== undefined) {
      const node = nodes[known]!;
      if (parent !== null && !parent.edges.includes(node.id)) parent.edges.push(node.id);
      return node;
    }
    const status = step.snapshot.status;
    const seen = chosen ? chosenLoopSeen : loopSeen;
    const repeats = seen.get(keys.loop) ?? 0;
    const id = nodes.length;
    const node: Node = {
      id,
      parent: parent?.id ?? null,
      input,
      depth: parent === null ? 0 : parent.depth + 1,
      loop: keys.loop,
      start: startIndex,
      clock,
      chosen,
      lead: inherited,
      rank: [
        step.newInstructions > 0 || place?.novel === true ? 0 : repeats === 0 ? 1 : 2,
        repeats,
        -id,
      ],
      cell: place?.cell ?? -1,
      values: place?.values ?? -1,
      resumed: false,
      items: stepItems,
      status: status === "halted" ? "completed" : status === "failed" ? "failed" : "open",
      edges: [],
      texts: step.texts,
      prompt: session.prompt(step.snapshot),
      waitsAt: typeof waitsAt === "number" ? waitsAt : null,
    };
    nodes.push(node);
    if (later) wallEnd[node.id] = wallClockOf(step.snapshot);
    byState.set(stateKey, node.id);
    if (parent !== null) parent.edges.push(node.id);
    if (!clock && !chosen) remember(step.snapshot, node);
    if (node.status === "failed") {
      const crash = recordCrash(
        crashes,
        step,
        node,
        start.session,
        reproOf(parent, input, startIndex),
      );
      if (crash !== null) crashNodes.set(crash, node.id);
    }
    if (node.status === "open") {
      store.put(node.id, step.snapshot, parent === null);
      const ask = node.prompt.instruction;
      if (ask !== null && !chosen) {
        const waiting = askNodes.get(ask) ?? [];
        if (waiting.length < 5) waiting.push(node.id);
        askNodes.set(ask, waiting);
      }
      if (replaying) replayedOpen.push(node.id);
      else frontier.push(node.id, order(node));
    }
    seen.set(keys.loop, (seen.get(keys.loop) ?? 0) + 1);
    return node;
  };

  /**
   * Keeps the storage a play state left, once per distinct storage, for later sessions to start from; a session that
   * completes with a storage an earlier state already left (saved before its last prompt) still counts as completed.
   */
  const remember = (snapshot: Data, node: Node): void => {
    const entries = storageOf(snapshot);
    const key = JSON.stringify(entries);
    const known = leftKeys.get(key);
    if (known === undefined) {
      leftKeys.set(key, left.length);
      left.push({ node: node.id, entries, key, sessions: starts[node.start]!.session });
      if (node.status === "completed") {
        completedLeft.push(left.length - 1);
        completedKeys.add(key);
      }
      return;
    }
    if (node.status !== "completed" || completedKeys.has(key)) return;
    completedKeys.add(key);
    left.push({
      node: node.id,
      entries: left[known]!.entries,
      key,
      sessions: starts[node.start]!.session,
    });
    completedLeft.push(left.length - 1);
  };

  /**
   * A runtime session in the state of a node whose snapshot was not stored: from its nearest ancestor that has one,
   * with the inputs after that ancestor replayed in it.
   */
  const replayTo = (node: Node): Runtime | null => {
    const chain: Node[] = [];
    let current: Node | undefined = node;
    let snapshot: Data | null = null;
    while (current !== undefined && snapshot === null) {
      snapshot = store.get(current.id);
      if (snapshot === null) {
        chain.push(current);
        current = current.parent === null ? undefined : nodes[current.parent];
      }
    }
    if (snapshot === null || current === undefined) return null;
    replays += 1;
    const runtime = restore(current, snapshot);
    if (runtime === null) return null;
    for (const step of chain.reverse()) {
      if (step.input === null || !session.advance(runtime, step.input, step.clock, step.chosen))
        return null;
    }
    return runtime;
  };

  /** A runtime session in a node's state: from its stored snapshot, or replayed. */
  const runtimeOf = (node: Node): Runtime | null => {
    const stored = store.get(node.id);
    return stored === null ? replayTo(node) : restore(node, stored);
  };

  /** A node's snapshot: stored, or exported after a replay. */
  const snapshotOf = (node: Node): Data | null =>
    store.get(node.id) ?? replayTo(node)?.exportTrustedSnapshot() ?? null;

  /**
   * A runtime session in the state of a node's snapshot. The snapshots are trusted exports (`docs/RUNTIME.md#runtime-
   * sessions`), which the runtime checks here, where they cross into it again: a snapshot it refuses
   * (`RuntimeDataError`) is a problem of the explorer or the runtime, counted with the engine errors; null then.
   */
  const restore = (node: Node, snapshot: Data): Runtime | null => {
    try {
      return session.restore(snapshot);
    } catch (error) {
      if (error instanceof Error && error.name === "RuntimeSessionError") throw error;
      engineErrors.count += 1;
      engineErrors.first ??= { message: String(error), ...reproOf(node, null, node.start) };
      return null;
    }
  };

  /**
   * Applies one input in `runtime`, which goes on in place; null when the runtime rejects the input or throws. Either
   * way the caller does not use `runtime` again: a throw ended it, and a rejected input may have left it part of the
   * way.
   */
  const step = (node: Node, runtime: Runtime, input: ExplorerInput): Step | null => {
    try {
      const next = session.apply(runtime, input, node.clock, node.chosen);
      if (next === null) rejectedInputs += 1;
      else transitions += 1;
      return next;
    } catch (error) {
      // A session the explorer used after it ended is the explorer's own mistake: no result can be trusted then.
      if (error instanceof Error && error.name === "RuntimeSessionError") throw error;
      // The runtime refused data it was given (RuntimeDataError): a harness problem, not a script failure.
      engineErrors.count += 1;
      engineErrors.first ??= { message: String(error), ...reproOf(node, input, node.start) };
      return null;
    }
  };

  /**
   * With random choices, queues the other outcomes of the draws a step made, each as a step with the same input: each
   * outcome of a site once per place and input, the first ones not tried there yet. An outcome chosen for the same draw
   * before is replaced.
   */
  const offerChoices = (node: Node, input: ExplorerInput, next: Step): void => {
    if (!chooses) return;
    const { random: _, ...plain } = input;
    const context = `${node.waitsAt ?? "-"} ${JSON.stringify(plain)}`;
    for (const draw of next.draws.slice(0, RANDOM_DRAWS_PER_STEP)) {
      if (typeof draw.drawId !== "number" || typeof draw.site !== "string") continue;
      let taken = 0;
      for (const outcome of engine.randomDrawAlternatives(draw, RANDOM_SUPPORT).alternatives) {
        if (taken === RANDOM_ALTERNATIVES) break;
        const tried = `${context} ${draw.site} ${JSON.stringify(outcome)}`;
        if (randomTried.has(tried)) continue;
        randomTried.add(tried);
        taken += 1;
        const others = (input.random ?? []).filter((choice) => choice.drawId !== draw.drawId);
        chosenSteps.push({
          node: node.id,
          input: {
            ...input,
            random: [...others, { drawId: draw.drawId, site: draw.site, outcome }],
          },
        });
      }
    }
  };

  /** Takes a queued step with another random outcome from the state it was offered at. */
  const runChosen = (job: { node: number; input: ExplorerInput }): void => {
    const node = nodes[job.node]!;
    const work = session.operations;
    const runtime = runtimeOf(node);
    const next = runtime === null ? null : step(node, runtime, job.input);
    if (next !== null) transition(node, job.input, next, node.start, null);
    chosenWork += session.operations - work;
  };

  /** Starts a session from `start`; its first state, and its runtime session when it waits for the player. */
  const startSession = (
    start: Start,
    lead: Lead | null,
  ): { node: Node; runtime: Runtime | null } => {
    starts.push(start);
    const first = session.start(start, chosenStart(start));
    const node = transition(null, null, first, starts.length - 1, lead);
    firstNodeOf.set(starts.length - 1, node.id);
    // A session that ends in its first step keeps no snapshot; its time steps read the state it ended in.
    if (later && first.snapshot.status !== "waiting")
      startSnapshots.set(starts.length - 1, first.snapshot);
    return { node, runtime: first.snapshot.status === "waiting" ? first.runtime : null };
  };

  /** Variables' values in a state, by name: the innermost binding, numbers and booleans as numbers. */
  const bindings = (snapshot: Data): Map<string, number> => {
    const values = new Map<string, number>();
    const take = (entries: Data[]) => {
      for (const binding of entries) {
        const value = binding.value;
        if (typeof binding.name !== "string") continue;
        if (typeof value === "number") values.set(binding.name, value);
        else if (typeof value === "boolean") values.set(binding.name, value ? 1 : 0);
      }
    };
    take(list(snapshot.globals));
    for (const frame of list(snapshot.frames)) take(list(frame.bindings));
    return values;
  };

  /** Per distance target, the lead its closer states share. */
  const closerLeads = new Map<number, Lead>();
  const closerLead = (index: number): Lead => {
    const target = distanceTargets[index]!.target;
    const known = closerLeads.get(target) ?? { remaining: CLOSER_EXPANSIONS, target };
    closerLeads.set(target, known);
    return known;
  };

  /**
   * Reads a condition's atoms from variables and stored values: a load, or a variable that only holds one load when it
   * has no value of its own. A stored key `skip` passes is not read.
   */
  const atomReader =
    (
      variables: ReadonlyMap<string, unknown>,
      storage: ReadonlyMap<string, unknown>,
      skip: (key: string) => boolean = () => false,
    ) =>
    (subject: unknown): AtomValue => {
      const node = record(subject);
      const stored = (key: string, fallback: unknown): AtomValue =>
        skip(key) ? undefined : atomScalar(storage.has(key) ? storage.get(key) : fallback);
      if (node.kind === "storageLoad") {
        const key = record(node.key);
        const fallback = record(node.default);
        if (key.kind !== "literal" || typeof key.value !== "string") return undefined;
        if (node.default != null && fallback.kind !== "literal") return undefined;
        return stored(key.value, node.default == null ? null : fallback.value);
      }
      if (node.kind !== "identifier" || typeof node.name !== "string") return undefined;
      if (variables.has(node.name)) return atomScalar(variables.get(node.name));
      const alias = flow.loadAlias(node.name);
      return alias === null ? undefined : stored(alias.key, alias.fallback);
    };
  /** The variables of a state by name, innermost binding last, as they are. */
  const variablesOf = (snapshot: Data): Map<string, unknown> => {
    const values = new Map<string, unknown>();
    for (const scope of [{ bindings: snapshot.globals }, ...list(snapshot.frames)])
      for (const binding of list(scope.bindings))
        if (typeof binding.name === "string") values.set(binding.name, binding.value);
    return values;
  };

  const distances = (snapshot: Data): number[] => {
    const values = bindings(snapshot);
    let read: ((subject: unknown) => AtomValue) | null = null;
    return distanceTargets.map((goal) => {
      if (goal.kind === "condition") {
        read ??= atomReader(
          variablesOf(snapshot),
          new Map(storageOf(snapshot).map((entry) => [entry.key, entry.value])),
        );
        return branchDistance(conditionDistance(goal.condition, goal.wanted, read));
      }
      const value = values.get(goal.name);
      return value === undefined ? Infinity : distance(value, goal.operator, goal.constant);
    });
  };

  /**
   * With realignment: how a replayed path goes on in the state of `runtime` before its input `index`. The input that
   * fits there ({@link aligned}): the path's own, or one a few inputs on (skipping those between); or, when none does,
   * the only button there is, before the same input again. Null to stop: nothing fits, or the allowance is spent.
   */
  const realign = (
    runtime: Runtime,
    inputs: readonly ExplorerInput[],
    index: number,
    allowance: { skipped: number; forced: number },
  ): { input: ExplorerInput; next: number } | null => {
    const choices = session.options(runtime);
    const last = Math.min(inputs.length, index + 1 + MAX_SKIPS - allowance.skipped);
    for (let ahead = index; ahead < last; ahead += 1) {
      const input = aligned(inputs[ahead]!, choices);
      if (input === null) continue;
      allowance.skipped += ahead - index;
      return { input, next: ahead + 1 };
    }
    // The only button there is, pressed at once (a timed one also offers presses after thinking).
    const others = choices.filter((choice) => choice.kind !== "wait" && choice.kind !== "press");
    const button = others.find(
      (choice): choice is Extract<ExplorerInput, { kind: "button" }> =>
        choice.kind === "button" && choice.afterMs === undefined,
    );
    if (
      button === undefined ||
      others.some((choice) => !(choice.kind === "button" && choice.label === button.label)) ||
      allowance.forced >= MAX_FORCED
    )
      return null;
    allowance.forced += 1;
    return { input: button, next: index };
  };

  /** Where time steps from a state count as tried: its cell, or without cells its loop key. */
  const timeCell = (node: Node): string =>
    node.cell >= 0 ? `cell ${node.cell}` : `loop ${node.loop}`;

  /**
   * The time steps of a place where a step read a clock condition for the first time, from the state that step left (it
   * was expanded before the place was known) or, for a step that started a session, as more starts of that session:
   * from the same storage, at the gaps its first state gives.
   */
  const runTimeJob = (job: { node: number | null; start: number }): void => {
    const work = session.operations;
    if (job.node !== null) {
      const node = nodes[job.node]!;
      const snapshot =
        node.status === "open" || node.status === "expanded" ? snapshotOf(node) : null;
      const gaps =
        snapshot === null
          ? []
          : timeSteps(snapshot, node.waitsAt, wallEnd[node.id]!, timeCell(node));
      for (const gap of gaps) {
        const runtime = runtimeOf(node);
        if (runtime === null || outOfBudget()) break;
        const input: ExplorerInput = { kind: "later", afterMs: gap };
        const next = step(node, runtime, input);
        if (next !== null) transition(node, input, next, node.start, null);
        timeStepsTaken.steps += 1;
      }
    } else {
      const start = starts[job.start]!;
      const first = firstNodeOf.get(job.start);
      const snapshot =
        first === undefined ? null : (store.get(first) ?? startSnapshots.get(job.start) ?? null);
      const gaps =
        snapshot === null || first === undefined
          ? []
          : timeSteps(snapshot, null, wallEnd[first]!, `start ${job.start}`).map(
              (gap) => wallEnd[first]! + gap,
            );
      // Only later than where the session's origin stands: a start of an old corpus entry may be earlier.
      const origin = start.origin === null ? EPOCH_MS : wallEnd[start.origin]!;
      for (const at of gaps) {
        if (outOfBudget()) break;
        if (at - origin <= 0) continue;
        startSession(laterStart(start.origin, start.storage, at - origin), null);
        timeStepsTaken.sessions += 1;
      }
    }
    directedWork += session.operations - work;
  };

  const runAttempt = (attempt: Attempt): void => {
    const target = targets.get(attempt.target);
    if (target === undefined) return;
    const chain = attempt.chain === undefined ? undefined : target.chains.get(attempt.chain);
    if (chain !== undefined) chain.queued = false;
    if (settled(target)) return;
    attemptCount += 1;
    const work = session.operations;
    // A chain's next session comes from the storage it reached, so its states take no first place of their own.
    const lead: Lead | null =
      attempt.chain !== undefined
        ? null
        : { remaining: attempt.later === true ? 0 : ATTEMPT_EXPANSIONS, target: attempt.target };
    let node: Node;
    let runtime: Runtime | null;
    if (attempt.start !== null) {
      ({ node, runtime } = startSession(attempt.start, lead));
      directedTransitions += 1;
    } else {
      node = nodes[attempt.from ?? 0]!;
      runtime = runtimeOf(node);
      if (runtime?.view().status !== "waiting") runtime = null;
    }
    const allowance = { skipped: 0, forced: 0 };
    for (let index = 0; index < attempt.inputs.length;) {
      if (runtime === null || outOfBudget()) break;
      let input = attempt.inputs[index]!;
      index += 1;
      if (options.realign === true) {
        const found = realign(runtime, attempt.inputs, index - 1, allowance);
        if (found === null) break;
        ({ input, next: index } = found);
      }
      const next = step(node, runtime, input);
      if (next === null) break;
      directedTransitions += 1;
      node = transition(node, input, next, node.start, lead);
      runtime = next.snapshot.status === "waiting" ? next.runtime : null;
    }
    directedWork += session.operations - work;
  };

  /** The witness of a target: its state, the inputs from its session start through its step, and that start. */
  const witnessOf = (target: Target) => {
    const witness = witnesses.get(target.instruction);
    const node = witness?.node == null ? null : nodes[witness.node]!;
    const inputs = node === null ? [] : pathTo(nodes, node);
    if (witness?.input != null) inputs.push(witness.input);
    return { witness, node, inputs, start: starts[witness?.start ?? 0]! };
  };

  /**
   * One step of a session chain toward a stored value: from the closest storage an explored play state left, a
   * session that replays the witness path when that storage satisfies the condition, or else the path that led to that
   * storage, to get closer still. Stops when sessions stop getting closer.
   */
  const chainStep = (code: number, target: Target, goal: Goal): boolean => {
    if (goal.source.kind !== "storage" || settled(target)) return false;
    const key = goal.source.key;
    let chain = target.chains.get(key);
    if (chain === undefined) {
      chain = {
        best: Infinity,
        value: "",
        sessions: 0,
        started: 0,
        stale: 0,
        queued: false,
        scanned: 0,
        closest: null,
        matches: keyMatcher(key),
      };
      target.chains.set(key, chain);
    }
    if (chain.queued || chain.stale >= 2) return false;
    // A way that needs all parts of its condition: a storage is also as far as the parts on other keys are.
    const condition =
      instructions[target.instruction]!.condition ?? instructions[target.instruction]!.expression;
    const whole = options.conjunctive === true && conjunctive(condition, target.way === 0);
    // Only the storages found since the last pass are measured.
    for (; chain.scanned < left.length; chain.scanned += 1) {
      const entry = left[chain.scanned]!;
      const measured = storageDistance(entry.entries, chain.matches, goal);
      // With realignment, a storage is only as close as the earlier conditions of the chain let it be.
      for (const guard of target.guards) measured.distance += guardDistance(entry.entries, guard);
      // With the parts on other keys: fewer parts unsatisfied first, then the nearer in sum.
      if (whole && measured.distance < Infinity) {
        const parts = conditionDistance(
          condition,
          target.way === 0,
          atomReader(new Map(), storageMap(entry.entries), chain.matches),
        );
        measured.distance = branchDistance({
          unsatisfied: parts.unsatisfied + (measured.distance > 0 ? 1 : 0),
          sum: parts.sum + measured.distance,
        });
      }
      const closest = chain.closest;
      if (
        measured.distance < Infinity &&
        (closest === null ||
          measured.distance < closest.distance ||
          (measured.distance === closest.distance && entry.sessions < closest.left.sessions))
      )
        chain.closest = { left: entry, ...measured };
    }
    const best = chain.closest;
    const need = describeNeed(key, goal);
    if (best === null) {
      target.note = `needs ${need}; no explored session stored it`;
      return false;
    }
    // With forward time, the next session follows the rhythm of the one that left the storage: as long after it.
    const fromBest = (inputs: readonly ExplorerInput[]): Attempt => ({
      target: code,
      from: null,
      start: later
        ? laterStart(best.left.node, best.left.entries, gapOf(nodes[best.left.node]!.start))
        : {
            origin: best.left.node,
            storage: best.left.entries,
            wallClockMs: EPOCH_MS,
            session: best.left.sessions + 1,
          },
      inputs,
      chain: key,
    });
    if (best.distance === 0) {
      if (chain.best === 0) {
        chain.stale = 2;
        target.note = `needs ${need}; a session from storage that has it did not reach the condition`;
        return false;
      }
      Object.assign(chain, {
        best: 0,
        value: best.value,
        sessions: best.left.sessions,
        queued: true,
      });
      chain.started += 1;
      chainAttempts.push(fromBest(witnessOf(target).inputs.slice(0, MAX_SUFFIX)));
      return true;
    }
    if (best.distance < chain.best && chain.started < MAX_CHAIN) {
      Object.assign(chain, {
        best: best.distance,
        value: best.value,
        sessions: best.left.sessions,
        stale: 0,
        queued: true,
      });
      chain.started += 1;
      // The path that led to the closest storage, played again from it, to raise the value once more.
      chainAttempts.push(fromBest(pathTo(nodes, nodes[best.left.node]!).slice(0, MAX_SUFFIX)));
      return true;
    }
    chain.stale += 1;
    target.note = `needs ${need}; best reached: ${chain.value} after ${chain.sessions} session${chain.sessions === 1 ? "" : "s"}`;
    return false;
  };

  /** With realignment: the guard of each earlier condition of an `else if` chain, one for all the conditions after it. */
  const guardsByCondition = new Map<number, Guard>();
  const guardOf = (earlier: number): Guard => {
    const known = guardsByCondition.get(earlier);
    if (known !== undefined) return known;
    const before = instructions[earlier]!.condition;
    const aliases = new Map<string, LoadAlias>();
    for (const name of namesIn(before)) {
      const alias = flow.loadAlias(name);
      if (alias !== null) aliases.set(name, alias);
    }
    const guard = { condition: before, aliases, goals: goalsFor(flow, before, false) };
    guardsByCondition.set(earlier, guard);
    return guard;
  };

  /** Makes targets of the condition ways left one way, schedules their attempts, and goes on with session chains. */
  const analyze = (): boolean => {
    let scheduled = false;
    instructions.forEach((instruction, index) => {
      if (instruction.kind !== "jumpIfFalse" && instruction.kind !== "loopStart") return;
      const taken = session.branches[index]! | session.clockBranches[index]!;
      if (taken !== 1 && taken !== 2) return;
      if (allConstants.has(index) || Number(instruction.target) === index + 1) return;
      const way: 0 | 1 = taken === 1 ? 1 : 0;
      const code = index * 2 + way;
      const known = targets.get(code);
      if (known !== undefined) {
        for (const goal of known.goals) scheduled = chainStep(code, known, goal) || scheduled;
        return;
      }
      const condition = instruction.condition ?? instruction.expression;
      const conditional = instruction.kind === "jumpIfFalse" || instruction.loopKind === "while";
      const guards = options.realign === true ? (elseIfs.get(index) ?? []).map(guardOf) : [];
      const goals = [
        ...(conditional ? goalsFor(flow, condition, way === 0) : []),
        ...guards.flatMap((guard) => guard.goals),
      ];
      const witness = chosenWays.get(code);
      const target: Target = {
        instruction: index,
        way,
        goals,
        guards,
        attempts: 0,
        reach:
          witness === undefined
            ? null
            : {
                label: "chosen",
                via: "search",
                repro: reproOf(
                  witness.parent === null ? null : nodes[witness.parent]!,
                  witness.input,
                  witness.start,
                ),
              },
        chains: new Map(),
        note: null,
      };
      targets.set(code, target);
      scheduled = schedule(code, target) || scheduled;
    });
    /** A next visit from the storage a state left: a minute later, and in the windows of the comparisons read. */
    const visitFrom = (entry: (typeof left)[number], key: string, completed: boolean): void => {
      if (quitAnywhere)
        for (const cell of cellsOf(entry.entries, starts[nodes[entry.node]!.start]!.storage))
          seedCells.add(cell);
      const work = session.operations;
      if (later) {
        // A minute later; then in the windows of the clock comparisons sessions read (`sessionGaps`), as its first
        // state reads them; a day later when none can be read.
        const first = startSession(laterStart(entry.node, entry.entries, NEXT_SESSION_GAP), null);
        const snapshot = store.get(first.node.id) ?? startSnapshots.get(first.node.start) ?? null;
        const begun = wallEnd[entry.node]! + NEXT_SESSION_GAP;
        const now = wallEnd[first.node.id]!;
        // A quit visit gets the windows read so far once, not again as sessions read more.
        if (snapshot !== null && completed)
          sessionOrigins.push({ key, entry, snapshot, now, begun });
        const steps =
          snapshot === null
            ? []
            : sessionGaps(snapshot, now, `storage ${key}`).map((gap) => now + gap - begun);
        for (const gap of steps)
          startSession(laterStart(entry.node, entry.entries, NEXT_SESSION_GAP + gap), null);
        timeStepsTaken.sessions += steps.length;
        if (steps.length === 0 && readsClock)
          startSession(laterStart(entry.node, entry.entries, NEXT_DAY_GAP), null);
      } else
        startSession(
          {
            origin: entry.node,
            storage: entry.entries,
            wallClockMs: EPOCH_MS,
            session: entry.sessions + 1,
          },
          null,
        );
      nextWork += session.operations - work;
    };
    // A few next sessions from what completed sessions stored, as the player's next visit.
    for (; nextFromCompleted < completedLeft.length; nextFromCompleted += 1) {
      // With quit-anywhere next visits, completed ones have their own count.
      if (
        (quitAnywhere
          ? completedVisits >= MAX_NEXT_SESSIONS
          : startedFrom.size > MAX_NEXT_SESSIONS) ||
        !withinNextShare()
      )
        break;
      const entry = left[completedLeft[nextFromCompleted]!]!;
      const key = JSON.stringify(entry.entries);
      if (startedFrom.has(key)) continue;
      startedFrom.add(key);
      completedVisits += 1;
      visitFrom(entry, key, true);
      scheduled = true;
    }
    // With quit-anywhere next visits, one per pass from the storage of a state a session did not complete: the one with
    // the most stored cells no next visit started from had.
    if (quitAnywhere && quitVisits < MAX_QUIT_SESSIONS && withinNextShare()) {
      let best: number | null = null;
      let bestNew = 0;
      left.forEach((entry, index) => {
        // A completed session's storage is a completed visit's.
        if (startedFrom.has(entry.key) || completedKeys.has(entry.key)) return;
        let cells = cellsOfLeft.get(index);
        if (cells === undefined) {
          cells = cellsOf(entry.entries, starts[nodes[entry.node]!.start]!.storage);
          cellsOfLeft.set(index, cells);
        }
        const fresh = cells.filter((cell) => !seedCells.has(cell)).length;
        if (fresh > bestNew) {
          best = index;
          bestNew = fresh;
        }
      });
      if (best !== null) {
        const entry = left[best]!;
        startedFrom.add(entry.key);
        quitVisits += 1;
        visitFrom(entry, entry.key, false);
        scheduled = true;
      }
    }
    // Comparisons sessions read since: the storages next sessions started from get their windows too.
    const learned = [...clockAfter.values()].reduce((sum, after) => sum + after.size, 0);
    if (later && learned > learnedAtOrigins) {
      learnedAtOrigins = learned;
      for (const { key, entry, snapshot, now, begun } of sessionOrigins) {
        if (!withinNextShare()) break;
        const work = session.operations;
        const steps = sessionGaps(snapshot, now, `storage ${key}`).map((gap) => now + gap - begun);
        for (const gap of steps)
          startSession(laterStart(entry.node, entry.entries, NEXT_SESSION_GAP + gap), null);
        timeStepsTaken.sessions += steps.length;
        nextWork += session.operations - work;
        scheduled = scheduled || steps.length > 0;
      }
    }
    return scheduled;
  };

  const schedule = (code: number, target: Target): boolean => {
    const { witness, node: witnessNode, inputs: fullPath, start: witnessStart } = witnessOf(target);
    const plan: Attempt[] = [];
    const add = (attempt: Attempt) => {
      if (plan.length < MAX_ATTEMPTS) plan.push(attempt);
    };
    let chained = false;
    /** With forward time: the attempts that continue later, once per target. */
    const laterPlan: Attempt[] = [];
    let timed = false;
    // A way that needs all parts of its condition is steered by the condition's branch distance, not each part's.
    const condition =
      instructions[target.instruction]!.condition ?? instructions[target.instruction]!.expression;
    const whole = options.conjunctive === true && conjunctive(condition, target.way === 0);
    let measuredWhole = false;
    for (const goal of target.goals) {
      const source = goal.source;
      if (source.kind === "ask") {
        const answers = goal.candidates
          .filter((value): value is string => typeof value === "string")
          .slice(0, MAX_CANDIDATES);
        const known = session.directedAnswers.get(source.instruction) ?? [];
        for (const answer of answers)
          if (!known.includes(answer) && known.length < MAX_DIRECTED_ANSWERS) known.push(answer);
        session.directedAnswers.set(source.instruction, known);
        // On the witness path: answer the ask again, then replay the rest of the path.
        const chain = witnessNode === null ? [] : ancestry(nodes, witnessNode);
        const at = chain.findLastIndex((node) => node.prompt.instruction === source.instruction);
        if (at >= 0) {
          // The path's input `at` answered the ask; the new answer replaces it, and the inputs after it follow.
          const suffix = fullPath.slice(at + 1).slice(0, MAX_SUFFIX);
          for (const answer of answers)
            add({
              target: code,
              from: chain[at]!.id,
              start: null,
              inputs: [{ kind: "text", text: answer }, ...suffix],
            });
        } else {
          for (const from of askNodes.get(source.instruction) ?? [])
            for (const answer of answers)
              add({ target: code, from, start: null, inputs: [{ kind: "text", text: answer }] });
        }
      } else if (source.kind === "storage") {
        chained = chainStep(code, target, goal) || chained;
      } else if (source.kind === "clock" && later) {
        if (timed) continue;
        timed = true;
        // A condition that compares how long the player took between two clock reads (a reaction, a hold) with what
        // does not read the clock is reached by thinking before the button between them, which its options have;
        // coming back later changes nothing.
        if (
          measured.has(target.instruction) &&
          (times?.comparisons.get(target.instruction) ?? []).every(
            (comparison) => comparison.exact && comparison.parts.size === 0,
          )
        )
          continue;
        // A condition whose clock comparisons can all be read where it was evaluated, one of which comes out the other
        // way later there, gets time steps there instead.
        const comparisons = times?.comparisons.get(target.instruction) ?? [];
        const before = witnessNode === null ? null : snapshotOf(witnessNode);
        const context =
          times === null ? null : timeContext(before ?? { scriptStorage: witnessStart.storage });
        const at = witnessNode === null ? witnessStart.wallClockMs : wallEnd[witnessNode.id]!;
        if (
          context !== null &&
          times !== null &&
          comparisons.length > 0 &&
          comparisons.every(
            (comparison) =>
              comparison.exact && holdsAt(comparison, times, context, at) !== undefined,
          ) &&
          comparisons.some((comparison) => flipGap(comparison, times, context, at) !== null)
        )
          continue;
        // A condition that reads the clock itself: the player continues later just before the step that evaluated it, or
        // a step before. One that reads it through a variable, which may have been set when the session started: also
        // the whole session starts later, and its path follows.
        const direct = callsClock(
          instructions[target.instruction]!.condition ??
            instructions[target.instruction]!.expression,
        );
        const chain = witnessNode === null ? [] : ancestry(nodes, witnessNode);
        if (witness?.input != null)
          for (let back = 0; back <= (direct ? LATER_BACK : 0) && back < chain.length; back += 1) {
            const at = chain.length - 1 - back;
            for (const gap of LATER_GAPS)
              laterPlan.push({
                target: code,
                from: chain[at]!.id,
                start: null,
                inputs: [{ kind: "later", afterMs: gap }, ...fullPath.slice(at, at + MAX_SUFFIX)],
                later: true,
              });
          }
        if (
          witness !== undefined &&
          (!direct || witnessNode === null) &&
          fullPath.length <= MAX_SUFFIX
        )
          for (const gap of LATER_GAPS)
            laterPlan.push({
              target: code,
              from: null,
              start: laterStart(witnessStart.origin, witnessStart.storage, gap),
              inputs: fullPath,
              later: true,
            });
      } else if (source.kind === "clock") {
        for (const wallClockMs of CLOCK_VARIANTS) {
          if (witnessNode !== null && witness?.input != null)
            add({
              target: code,
              from: witnessNode.id,
              start: null,
              inputs: [{ kind: "clock", wallClockMs }, witness.input],
            });
          else if (fullPath.length <= MAX_SUFFIX)
            add({
              target: code,
              from: null,
              start: { ...witnessStart, wallClockMs },
              inputs: fullPath,
            });
        }
      } else if (goal.comparison !== null && distanceTargets.length < MAX_DISTANCE_TARGETS) {
        if (whole) {
          if (!measuredWhole)
            distanceTargets.push({
              kind: "condition",
              target: code,
              condition,
              wanted: target.way === 0,
            });
          measuredWhole = true;
        } else
          distanceTargets.push({
            kind: "variable",
            target: code,
            name: source.name,
            operator: goal.comparison.operator,
            constant: goal.comparison.constant,
          });
      }
    }
    target.attempts = plan.length + laterPlan.length;
    for (const attempt of plan)
      (attempt.inputs.some(isClockInput) || (attempt.start?.wallClockMs ?? EPOCH_MS) !== EPOCH_MS
        ? clockAttempts
        : playAttempts
      ).push(attempt);
    laterAttempts.push(...laterPlan);
    return plan.length > 0 || laterPlan.length > 0 || chained;
  };

  const budgetOps = options.budgetOps ?? Infinity;
  /** The budget that is spent: `operations` for work, `budget` for time; null while neither is. */
  const spent = (): "operations" | "budget" | null =>
    session.operations >= budgetOps
      ? "operations"
      : performance.now() - started >= options.budgetMs
        ? "budget"
        : null;
  const outOfBudget = () => spent() !== null;
  const full = () => outOfBudget() || nodes.length >= options.maxStates;

  /**
   * Replays the corpus entries of this run's seed, each session from the storage the one before it left, through the
   * search's own steps, so that their coverage, the storage their sessions left, and their states are there as if this
   * run had found them. Inputs already applied to a state are not applied again. An entry whose input no longer fits
   * the pending action ({@link fitsPending}), or that the runtime rejects, is stale: its replay stops there. Entries of
   * another seed, and those the budget leaves no room for, are kept as they are.
   */
  const replayCorpus = (entries: readonly CorpusEntry[], first: Step) => {
    const began = performance.now();
    const steps = transitions;
    const kept: CorpusEntry[] = [];
    let replayed = 0;
    let stale = 0;
    /** With realignment: the entries whose replay realigned an input, and the entry being replayed. */
    const realigned = new Set<CorpusEntry>();
    /** The inputs from a state that applied another input there (`applied`), which count as realigned. */
    const realignedKeys = new Set<string>();
    let currentEntry: CorpusEntry | null = null;
    /** The state an input led to from a state, and the start of a session from a state's storage at a wall clock. */
    const applied = new Map<string, number>();
    const startFrom = new Map<string, number>([[`-@${EPOCH_MS}`, 0]]);
    const firstOf = new Map<number, number>([[0, 0]]);
    /** The storage of ended states, which keep no snapshot. */
    const ended = new Map<number, readonly StorageEntry[]>();
    if (nodes[0]!.status !== "open") ended.set(0, storageOf(first.snapshot));
    const reach = (node: Node, snapshot: Data) => {
      if (node.status !== "open") ended.set(node.id, storageOf(snapshot));
    };
    const sessionStart = (origin: Node | null, wallClockMs: number): number | null => {
      const key = `${origin?.id ?? "-"}@${wallClockMs}`;
      const known = startFrom.get(key);
      if (known !== undefined) return known;
      const left = origin === null || ended.has(origin.id) ? null : snapshotOf(origin);
      const storage = origin === null ? [] : left === null ? ended.get(origin.id) : storageOf(left);
      if (storage === undefined) return null;
      const sessions = origin === null ? 1 : starts[origin.start]!.session + 1;
      const clock = later ? backwards(origin?.id ?? null, wallClockMs) : undefined;
      starts.push({
        origin: origin?.id ?? null,
        storage,
        wallClockMs,
        ...(clock === undefined ? {} : { clock }),
        session: sessions,
      });
      const begun = session.start(starts.at(-1)!, chosenStart(starts.at(-1)!));
      const node = transition(null, null, begun, starts.length - 1, null);
      reach(node, begun.snapshot);
      // A session after a chosen outcome leaves play its own next visit from the same storage.
      if (origin !== null && !origin.chosen && !clockStart(starts.at(-1)!)) {
        startedFrom.add(JSON.stringify(storage));
        // A next visit a corpus path made counts as one started from its storage for the cells quit visits look for.
        if (quitAnywhere)
          for (const cell of cellsOf(storage, starts[origin.start]!.storage)) seedCells.add(cell);
      }
      startFrom.set(key, starts.length - 1);
      firstOf.set(starts.length - 1, node.id);
      firstNodeOf.set(starts.length - 1, node.id);
      if (later && begun.snapshot.status !== "waiting")
        startSnapshots.set(starts.length - 1, begun.snapshot);
      return starts.length - 1;
    };
    /**
     * Applies one session's inputs; the state reached, null when an input does not fit, "full" at a limit. The inputs
     * go on in one runtime session; after an input applied before, from the state it reached.
     */
    const walk = (start: number, inputs: readonly ExplorerInput[]): Node | null | "full" => {
      let node = nodes[firstOf.get(start)!]!;
      let runtime: Runtime | null = null;
      const allowance = { skipped: 0, forced: 0 };
      for (let index = 0; index < inputs.length;) {
        if (full()) return "full";
        const input = inputs[index]!;
        const key = `${node.id} ${JSON.stringify(input)}`;
        const known = applied.get(key);
        if (known !== undefined) {
          if (realignedKeys.has(key) && currentEntry !== null) realigned.add(currentEntry);
          node = nodes[known]!;
          runtime = null;
          index += 1;
          continue;
        }
        runtime ??= node.status === "open" ? runtimeOf(node) : null;
        if (runtime === null) return null;
        // With realignment, an input that no longer fits is replaced, skipped, or preceded by the only button there is.
        let applying = input;
        let next = index + 1;
        if (options.realign === true) {
          const found = realign(runtime, inputs, index, allowance);
          if (found === null) return null;
          ({ input: applying, next } = found);
          const moved = JSON.stringify(applying) !== JSON.stringify(input) || next !== index + 1;
          if (moved && currentEntry !== null) realigned.add(currentEntry);
          // An input applied here before, such as the only button another entry pressed first, is not applied again.
          const before = applied.get(`${node.id} ${JSON.stringify(applying)}`);
          if (before !== undefined) {
            if (next === index + 1) {
              applied.set(key, before);
              if (moved) realignedKeys.add(key);
            }
            node = nodes[before]!;
            runtime = null;
            index = next;
            continue;
          }
        } else if (!fitsPending(input, session.options(runtime))) return null;
        const stepped = step(node, runtime, applying);
        if (stepped === null) return null;
        const reached = transition(node, applying, stepped, node.start, null);
        reach(reached, stepped.snapshot);
        applied.set(`${node.id} ${JSON.stringify(applying)}`, reached.id);
        if (next === index + 1) {
          applied.set(key, reached.id);
          if (JSON.stringify(applying) !== JSON.stringify(input)) realignedKeys.add(key);
        }
        node = reached;
        runtime = stepped.snapshot.status === "waiting" ? stepped.runtime : null;
        index = next;
      }
      return node;
    };
    const replayEntry = (entry: CorpusEntry): "done" | "stale" | "full" => {
      let origin: Node | null = null;
      for (const part of [...(entry.earlier ?? []), entry]) {
        // A spent budget also ends the replay between sessions, which may have no inputs.
        if (full()) return "full";
        const start = sessionStart(origin, part.wallClockMs ?? EPOCH_MS);
        const reached = start === null ? null : walk(start, part.inputs);
        if (reached === null || reached === "full") return reached ?? "stale";
        origin = reached;
      }
      return "done";
    };
    for (const entry of entries) {
      currentEntry = entry;
      const outcome = entry.seed !== options.seed || full() ? "full" : replayEntry(entry);
      if (outcome === "full") kept.push(entry);
      else replayed += 1;
      if (outcome === "stale") stale += 1;
    }
    return {
      replayed,
      stale,
      realigned: realigned.size,
      kept,
      replaySteps: transitions - steps,
      replayMs: performance.now() - began,
    };
  };

  /** Lines play visited and the condition ways it took, as the report counts lines. */
  const coverageCount = (lineIds: Int32Array, lines: number): CoverageCount => {
    const visited = new Set<number>();
    // Play with chosen random outcomes is play.
    session.visited.forEach((value, index) => {
      if ((value === 1 || session.chosenVisited[index] === 1) && lineIds[index]! >= 0)
        visited.add(lineIds[index]!);
    });
    let branchWays = 0;
    session.branches.forEach((play, index) => {
      const taken = play | session.chosenBranches[index]!;
      branchWays += (taken & 1) + (taken >> 1);
    });
    const percent = lines === 0 ? 100 : Math.round((visited.size / lines) * 1000) / 10;
    return { percent, visitedLines: visited.size, branchWays };
  };

  replaying = options.corpus !== undefined;
  const firstStep = session.start(starts[0]!);
  transition(null, null, firstStep, 0, null);
  if (later && firstStep.snapshot.status !== "waiting") startSnapshots.set(0, firstStep.snapshot);
  const replayed = options.corpus === undefined ? null : replayCorpus(options.corpus, firstStep);
  replaying = false;
  replayWork = replayed === null ? 0 : session.operations;
  guide();
  for (const id of replayedOpen) {
    const node = nodes[id]!;
    node.resumed = node.edges.length > 0;
    frontier.push(id, order(node));
  }
  const coverageAtStart = items === null ? null : coverageCount(items.lineIds, items.lines);
  let stoppedBy: ExploreResult["search"]["stoppedBy"] = "exhausted";
  let sinceAnalysis = 0;
  let analyzedAt = started;
  let analyzedOps = 0;
  /** Expansions by where the expanded state waited, with the prompt of the first one. */
  const expansionsAt = new Map<
    number | null,
    { expansions: number; prompt: string; productive: number; inputs: Set<string> }
  >();
  search: for (;;) {
    const stop = spent();
    if (stop !== null) {
      stoppedBy = stop;
      break;
    }
    if (nodes.length >= options.maxStates) {
      stoppedBy = "maxStates";
      break;
    }
    // A tenth of the budget: of the work budget when there is one, so that a run it limits stays deterministic.
    const due =
      options.budgetOps === undefined
        ? performance.now() - analyzedAt >= options.budgetMs / 10
        : session.operations - analyzedOps >= options.budgetOps / 10;
    if (sinceAnalysis >= ANALYZE_EVERY || due) {
      sinceAnalysis = 0;
      analyzedAt = performance.now();
      analyzedOps = session.operations;
      analyze();
      guide();
    }
    // With forward time, the time steps of a place where a clock condition was read for the first time.
    if (timeJobs.length > 0 && (frontier.size === 0 || withinShare())) {
      runTimeJob(timeJobs.shift()!);
      continue;
    }
    // Directed attempts and the rest of the search take turns, by steps.
    const pending =
      playAttempts.length > 0
        ? playAttempts
        : chainAttempts.length > 0
          ? chainAttempts
          : laterAttempts.length > 0
            ? laterAttempts
            : clockAttempts;
    if (pending.length > 0 && (frontier.size === 0 || withinShare())) {
      runAttempt(pending.shift()!);
      continue;
    }
    // With random choices, steps with another random outcome take their share, and all the work when no state is open.
    if (chosenAt < chosenSteps.length && (frontier.size === 0 || withinChosenShare())) {
      runChosen(chosenSteps[chosenAt]!);
      chosenAt += 1;
      continue;
    }
    if (frontier.size === 0) {
      if (analyze()) continue;
      break;
    }
    const node = nodes[frontier.pop()!]!;
    if (node.status !== "open") continue;
    // A lead that was spent, or whose target was reached, gives its states back their own place.
    if (node.lead !== null && !leads(node) && frontier.size > 0) {
      const own = order(node);
      const next = frontier.pop()!;
      frontier.push(next, order(nodes[next]!));
      if (before(order(nodes[next]!), own)) {
        frontier.push(node.id, own);
        continue;
      }
    }
    const leading = leads(node);
    if (leading && node.lead !== null) node.lead.remaining -= 1;
    let refunded = false;
    // The state's runtime session stays as it is: each input is tried in a fork of it, the last one in it.
    const stored = store.get(node.id);
    const base = stored === null ? replayTo(node) : restore(node, stored);
    if (base === null) {
      node.status = "expanded";
      continue;
    }
    const inputs = session.options(base, base.view(), () => stored ?? base.exportTrustedSnapshot());
    // With forward time, a state that waits where a clock condition is read next can also continue later.
    if (times !== null && clockAfter.has(clockKey(node.waitsAt)))
      for (const gap of timeSteps(
        stored ?? base.exportTrustedSnapshot(),
        node.waitsAt,
        wallEnd[node.id]!,
        timeCell(node),
      )) {
        inputs.push({ kind: "later", afterMs: gap });
        timeStepsTaken.steps += 1;
      }
    if (node.left !== undefined) {
      const offered = new Set(inputs.map((input) => JSON.stringify(input)));
      for (const input of node.left) {
        const key = JSON.stringify(input);
        if (offered.has(key)) continue;
        offered.add(key);
        inputs.push(input);
      }
    }
    if (inputs.length === 0) {
      node.status = "stuck";
      store.drop(node.id);
      continue;
    }
    expanded += 1;
    sinceAnalysis += 1;
    if (cells !== null && node.chosen)
      chosenExpansions[node.cell] = (chosenExpansions[node.cell] ?? 0) + 1;
    else if (cells !== null) cells.expansions[node.cell]! += 1;
    let at = expansionsAt.get(node.waitsAt);
    if (at === undefined) {
      at = { expansions: 0, prompt: node.prompt.text, productive: 0, inputs: new Set() };
      expansionsAt.set(node.waitsAt, at);
    }
    at.expansions += 1;
    let productive = false;
    node.status = "partial";
    const closeness =
      distanceTargets.length === 0 ? [] : distances(stored ?? base.exportTrustedSnapshot());
    // A state after a chosen random outcome goes back to its queue when its share is spent, to go on later with the
    // inputs it has not tried.
    let ran = 0;
    let cut = false;
    for (const [index, input] of inputs.entries()) {
      const stop = spent();
      if (stop !== null) {
        stoppedBy = stop;
        break search;
      }
      const tried = node.chosen ? JSON.stringify(input) : "";
      if (node.tried?.has(tried) === true) continue;
      if (node.chosen && ran > 0 && !withinChosenShare()) {
        cut = true;
        break;
      }
      ran += 1;
      if (node.chosen) (node.tried ??= new Set()).add(tried);
      const work = session.operations;
      const next = step(node, index === inputs.length - 1 ? base : base.fork(), input);
      if (leading) directedWork += session.operations - work;
      if (node.chosen) chosenWork += session.operations - work;
      if (next === null) continue;
      // A step that brings a variable closer to a comparison a target needs shares that target's lead.
      const after = closeness.length === 0 ? [] : distances(next.snapshot);
      const closer = after.findIndex((value, index) => value < (closeness[index] ?? Infinity));
      // With guidance, a step that brings a state nearer to the region of code not reached yet shares the guidance lead.
      const guideLead = guidance.lead;
      const guided =
        closer < 0 &&
        guideLead !== null &&
        guideLead.remaining > 0 &&
        approachAt(record(next.snapshot.foregroundAction).owningInstruction) <
          approachAt(node.waitsAt);
      const lead = closer >= 0 ? closerLead(closer) : guided ? guideLead : null;
      // With progress leads, an expansion of a state that leads by closeness, and that gets closer again, is given back;
      // not one of the guidance lead, which a loop could bring nearer each round.
      if (
        options.progressLeads === true &&
        leading &&
        lead !== null &&
        !guided &&
        node.lead === lead &&
        !refunded
      ) {
        lead.remaining += 1;
        refunded = true;
      }
      transition(node, input, next, node.start, lead);
      if (lastStepNew || closer >= 0 || guided) {
        if (!productive) at.productive += 1;
        productive = true;
        at.inputs.add(inputKey(input));
      }
    }
    if (cut) {
      node.status = "open";
      node.left = inputs.filter((input) => node.tried?.has(JSON.stringify(input)) !== true);
      frontier.push(node.id, order(node));
    } else {
      node.status = "expanded";
      delete node.tried;
      delete node.left;
    }
  }

  const coverage = lineCoverage(
    instructions,
    files,
    session,
    options.sources,
    {
      fromStart: unreachableInstructions(plan, instructions, constants),
      withStorage: unreachableInstructions(plan, instructions, allConstants),
    },
    constants,
    fixed,
    targets,
    session.randomChoices,
  );
  const count = (status: NodeStatus) => nodes.filter((node) => node.status === status).length;
  const sessionCount = Math.max(0, ...starts.map((start) => start.session));
  const bySession = {
    started: Array.from({ length: sessionCount }, () => 0),
    completed: Array.from({ length: sessionCount }, () => 0),
  };
  for (const start of starts) bySession.started[start.session - 1]! += 1;
  for (const node of nodes)
    if (node.status === "completed") bySession.completed[starts[node.start]!.session - 1]! += 1;
  const traps = findTraps(nodes, instructions, files, (node) => reproOf(node, null, node.start));

  /**
   * The corpus to keep: the paths to crashes and traps, then, by greedy set cover, paths of steps that covered a line or
   * condition way first, until they cover all that this run covered (see {@link cover}); then the entries kept
   * unreplayed.
   */
  const corpusResult = (): CorpusResult | null => {
    if (items === null || replayed === null || coverageAtStart === null) return null;
    const stamp = new Uint32Array(items.size);
    let generation = 0;
    /**
     * The items of every step on the path to a state (through its earlier sessions) and of one more step; without the
     * clock items of what play covered, which no report label needs.
     */
    const pathItems = (last: Node | null, startIndex: number, own: Uint32Array) => {
      generation += 1;
      const found: number[] = [];
      let cost = 0;
      const add = (list: Uint32Array) => {
        cost += 1;
        for (const item of list) {
          if (stamp[item] === generation) continue;
          stamp[item] = generation;
          const play = items.playOf(item);
          if (play < 0 || covered[play] === 0) found.push(item);
        }
      };
      add(own);
      for (let node = last, start = startIndex; ;) {
        for (const current of node === null ? [] : ancestry(nodes, node)) add(current.items);
        const origin = starts[start]!.origin;
        if (origin === null) break;
        node = nodes[origin]!;
        start = node.start;
      }
      return { items: Uint32Array.from(found), cost };
    };
    const entry = (repro: Repro, reason: CorpusEntry["reason"]): CorpusEntry => ({
      seed: options.seed,
      reason,
      ...(repro.earlier === undefined ? {} : { earlier: repro.earlier }),
      ...(repro.wallClockMs === undefined ? {} : { wallClockMs: repro.wallClockMs }),
      inputs: repro.inputs,
    });
    const pinned = [
      ...[...crashNodes].map(([key, id]) => ({ id, entry: entry(crashes.get(key)!, "crash") })),
      ...traps.map(({ report, entry: id }) => ({ id, entry: entry(report, "trap") })),
    ];
    const parentOf = (candidate: Candidate) =>
      candidate.parent === null ? null : nodes[candidate.parent]!;
    const kept = cover(
      candidates.map((candidate) =>
        pathItems(parentOf(candidate), candidate.start, candidate.items),
      ),
      pinned.map(({ id }) => pathItems(nodes[id]!, nodes[id]!.start, NO_ITEMS).items),
      items.size,
    );
    const entries = [
      ...pinned.map((pin) => pin.entry),
      ...kept.map((index) => {
        const candidate = candidates[index]!;
        return entry(reproOf(parentOf(candidate), candidate.input, candidate.start), "coverage");
      }),
      ...replayed.kept,
    ];
    return {
      loaded: options.corpus?.length ?? 0,
      replayed: replayed.replayed,
      stale: replayed.stale,
      ...(options.realign === true ? { realigned: replayed.realigned } : {}),
      written: entries.length,
      replaySteps: replayed.replaySteps,
      replayMs: Math.round(replayed.replayMs),
      coverageAtStart,
      coverageAtEnd: coverageCount(items.lineIds, items.lines),
      entries,
    };
  };
  const directed = directedSummary(
    instructions,
    files,
    options.sources,
    targets,
    attemptCount,
    directedTransitions,
    session.randomChoices,
  );
  const corpus = corpusResult();
  // The run's time and CPU time end here, with everything but the search figures computed.
  const cpu = process.cpuUsage(cpuAtStart);
  return {
    search: {
      states: nodes.length,
      transitions,
      expanded,
      sessions: starts.length,
      rejectedInputs,
      engineErrors,
      stoppedBy,
      operations: session.operations,
      elapsedMs: Math.round(performance.now() - started),
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      expansionsByPrompt: [...expansionsAt]
        .sort((left, right) => right[1].expansions - left[1].expansions)
        .slice(0, 5)
        .map(([at, { expansions, prompt, productive, inputs }]) => {
          const span = at === null ? null : compactSpan(instructions[at]?.span);
          return {
            location:
              at === null
                ? "(nothing in the foreground)"
                : `${files[at]}${span === null ? "" : `:${span.line}`}`,
            prompt,
            expansions,
            percent: Math.round((expansions / expanded) * 1000) / 10,
            productive,
            kind: hotspotKind(expansions, productive, inputs.size),
          };
        }),
      store: {
        limitBytes: store.limitBytes,
        peakBytes: store.peakBytes,
        evicted: store.evicted,
        replays,
      },
      bySession,
      ...(cells === null ? {} : { cells: cells.stats }),
      ...(map === null
        ? {}
        : { guidance: { regions: guidance.tried.size, reached: guidance.reached } }),
      ...(quitAnywhere ? { quitVisits } : {}),
      ...(times === null
        ? {}
        : {
            time: {
              conditions: times.comparisons.size,
              places: clockAfter.size,
              ...timeStepsTaken,
            },
          }),
    },
    endStates: {
      completed: count("completed"),
      failed: count("failed"),
      stuck: count("stuck"),
      open: count("open") + count("partial"),
    },
    coverage,
    directed,
    crashes: [...crashes.values()],
    traps: traps.map((trap) => trap.report),
    corpus,
  };
}

const NO_ITEMS = new Uint32Array(0);

/** A step that covered a line or condition way first in its run: a candidate corpus entry, as `parent` + `input`. */
interface Candidate {
  readonly parent: number | null;
  readonly input: ExplorerInput | null;
  readonly start: number;
  readonly items: Uint32Array;
}

/**
 * What a corpus covers, as numbered items: each line holding instructions (by file and line, as the report counts
 * lines) and each condition way, apart for play and for clock steps.
 */
function corpusItems(instructions: readonly Data[], files: readonly string[]) {
  const ids = new Map<string, number>();
  const lineIds = Int32Array.from(instructions, (instruction, index) => {
    const line = compactSpan(instruction.span)?.line;
    if (line === undefined) return -1;
    const key = `${files[index]}:${line}`;
    if (!ids.has(key)) ids.set(key, ids.size);
    return ids.get(key)!;
  });
  const lines = ids.size;
  const ways = instructions.length * 2;
  return {
    lineIds,
    lines,
    size: 2 * lines + 2 * ways,
    /** The play item of a clock item; -1 for a play item. */
    playOf: (item: number): number =>
      item < lines || (item >= 2 * lines && item < 2 * lines + ways)
        ? -1
        : item < 2 * lines
          ? item - lines
          : item - ways,
    /** A step's items: the lines it executed and the condition ways it took, as play or as clock coverage. */
    of: (step: Step, clock: boolean): Uint32Array => {
      const found = new Set<number>();
      for (const index of step.instructions) {
        const line = lineIds[index] ?? -1;
        if (line >= 0) found.add((clock ? lines : 0) + line);
      }
      for (const way of step.ways) found.add(2 * lines + (clock ? ways : 0) + way);
      return Uint32Array.from(found);
    },
  };
}

/**
 * Greedy set cover of every item the sets hold: with the items of `pinned` covered first, it takes the set that covers
 * the most items not yet covered (the cheaper one on a tie) until no set adds one, and then drops, latest first, each
 * taken set whose items the others all cover. Returns the indices of the sets kept, in the order taken.
 */
function cover(
  sets: readonly { items: Uint32Array; cost: number }[],
  pinned: readonly Uint32Array[],
  size: number,
): number[] {
  const count = new Uint32Array(size);
  for (const items of pinned) for (const item of items) count[item]! += 1;
  const gain = (items: Uint32Array) =>
    items.reduce((sum, item) => sum + (count[item] === 0 ? 1 : 0), 0);
  // Gains only shrink, so a set whose gain still equals the one it was queued with is the best.
  const queued = sets.map((set) => gain(set.items));
  const heap = new Frontier();
  sets.forEach((set, index) => {
    if (queued[index]! > 0) heap.push(index, [-queued[index]!, set.cost, index]);
  });
  const taken: number[] = [];
  for (let index = heap.pop(); index !== undefined; index = heap.pop()) {
    const set = sets[index]!;
    const now = gain(set.items);
    if (now === 0) continue;
    if (now < queued[index]!) {
      queued[index] = now;
      heap.push(index, [-now, set.cost, index]);
      continue;
    }
    taken.push(index);
    for (const item of set.items) count[item]! += 1;
  }
  const kept: number[] = [];
  for (const index of taken.reverse()) {
    const items = sets[index]!.items;
    if (items.every((item) => count[item]! >= 2)) for (const item of items) count[item]! -= 1;
    else kept.push(index);
  }
  return kept.reverse();
}

/** An input as one of the choices at a prompt: the input itself, apart from its label, which only explains it. */
/** Each node of an expression or instruction, depth first. */
function visitNodes(value: unknown, each: (node: Data) => void): void {
  if (Array.isArray(value)) for (const item of value) visitNodes(item, each);
  else if (isRecord(value)) {
    each(value);
    for (const [key, item] of Object.entries(value)) if (key !== "span") visitNodes(item, each);
  }
}

function inputKey(input: ExplorerInput): string {
  const { label: _label, ...choice } = { label: undefined, ...input };
  return JSON.stringify(choice);
}

/**
 * With realignment: the input of a replayed path as it fits the pending action, whose options are given, or null. The
 * option with the same label (at the same index if there is one), the button with the same label, the permanent button
 * with the same label (by its ID now), the wait for the deadline now, and a typed answer, image, or form where one is
 * asked; another wall clock or a later continue fits any waiting state.
 */
function aligned(input: ExplorerInput, options: readonly ExplorerInput[]): ExplorerInput | null {
  // An input that fits as it is stays the same input.
  if (fitsPending(input, options)) return input;
  // One that takes its place keeps the random outcomes it chose.
  const found = alignedKind(input, options);
  return found === null || input.random === undefined ? found : { ...found, random: input.random };
}

function alignedKind(
  input: ExplorerInput,
  options: readonly ExplorerInput[],
): ExplorerInput | null {
  switch (input.kind) {
    case "option":
      return (
        options.find((option) => option.kind === "option" && option.label === input.label) ?? null
      );
    case "press":
      return (
        options.find((option) => option.kind === "press" && option.label === input.label) ?? null
      );
    case "wait":
      return options.find((option) => option.kind === "wait") ?? null;
    default:
      return null;
  }
}

/**
 * The `else if` chains of a plan: for each condition after an `else`, the earlier conditions of its chain, nearest
 * first. A condition's `else` starts where its jump goes when it is false, after the jump that ends its true block;
 * only temporaries and calls may come before the next condition there.
 */
function elseIfChains(instructions: readonly Data[]): Map<number, number[]> {
  const chains = new Map<number, number[]>();
  const between = new Set(["storeTemporary", "clearTemporary", "clearTemporaries", "callFunction"]);
  instructions.forEach((instruction, index) => {
    const target = Number(instruction.target);
    if (instruction.kind !== "jumpIfFalse" || instructions[target - 1]?.kind !== "jump") return;
    for (let next = target; next < instructions.length; next += 1) {
      const kind = instructions[next]!.kind;
      if (kind === "jumpIfFalse") {
        chains.set(next, [index, ...(chains.get(index) ?? [])]);
        return;
      }
      if (!between.has(String(kind))) return;
    }
  });
  return chains;
}

/**
 * An earlier condition of an `else if` chain, which must take its other way, with the goals for that way and the
 * variables it reads that only hold a load, by name.
 */
interface Guard {
  readonly condition: unknown;
  readonly aliases: ReadonlyMap<string, LoadAlias>;
  readonly goals: readonly Goal[];
}

/**
 * How far a storage is from what an earlier condition of an `else if` chain needs, to take its other way: 0 when the
 * condition, read from the storage alone (`storedHolds`, with each load's default for an unset key, also through a
 * variable that only holds one load), is false;
 * otherwise, or when it reads more than storage, how far its stored values are from its goals (see
 * {@link storageDistance}), at least 1 when it holds.
 */
function guardDistance(entries: readonly StorageEntry[], guard: Guard): number {
  let measured = guardDistances.get(entries);
  if (measured === undefined) {
    measured = new Map();
    guardDistances.set(entries, measured);
  }
  const known = measured.get(guard);
  if (known !== undefined) return known;
  const found = measureGuard(entries, guard);
  measured.set(guard, found);
  return found;
}

/** The distances of guards from storages measured so far, by storage. */
const guardDistances = new WeakMap<readonly StorageEntry[], Map<Guard, number>>();

function measureGuard(entries: readonly StorageEntry[], guard: Guard): number {
  const storage = storageMap(entries);
  const loaded = new Map<string, unknown>();
  for (const [name, alias] of guard.aliases)
    loaded.set(name, storage.has(alias.key) ? storage.get(alias.key) : alias.fallback);
  const holds = storedHolds(guard.condition, storage, loaded);
  if (holds === false) return 0;
  let distance = 0;
  for (const goal of guard.goals) {
    if (goal.source.kind !== "storage") continue;
    const matches = matcherOf(goal.source.key);
    if (!entries.some((entry) => matches(entry.key))) continue;
    const measured = storageDistance(entries, matches, goal).distance;
    distance += Number.isFinite(measured) ? measured : 1;
  }
  return holds === true ? Math.max(1, distance) : distance;
}

/** The values of a storage by key, made once per storage, which many guards and chains measure. */
const storageMaps = new WeakMap<readonly StorageEntry[], ReadonlyMap<string, unknown>>();
function storageMap(entries: readonly StorageEntry[]): ReadonlyMap<string, unknown> {
  let found = storageMaps.get(entries);
  if (found === undefined) {
    found = new Map(entries.map((entry) => [entry.key, entry.value]));
    storageMaps.set(entries, found);
  }
  return found;
}

/** The matcher of a stored key or key pattern ({@link keyMatcher}), made once per key. */
const matchers = new Map<string, (key: string) => boolean>();
function matcherOf(key: string): (key: string) => boolean {
  let found = matchers.get(key);
  if (found === undefined) {
    found = keyMatcher(key);
    matchers.set(key, found);
  }
  return found;
}

/**
 * Whether a corpus input fits the pending action: one of the options the explorer tries there, by kind, label, and
 * index or ID. A typed answer needs a typed ask, a form a form (with cancel for a cancel), a wait the same deadline;
 * another wall clock, or continuing later, fits any waiting state, and the runtime decides the rest.
 */
function fitsPending(input: ExplorerInput, options: readonly ExplorerInput[]): boolean {
  if (input.kind === "clock" || input.kind === "later") return true;
  return options.some((option) => {
    switch (input.kind) {
      case "option":
        return (
          option.kind === "option" && option.index === input.index && option.label === input.label
        );
      case "button":
        return option.kind === "button" && option.label === input.label;
      case "press":
        return (
          option.kind === "press" &&
          option.buttonId === input.buttonId &&
          option.label === input.label
        );
      case "wait":
        return option.kind === "wait" && option.untilMs === input.untilMs;
      case "form":
        return option.kind === "form" && (input.action === "submit" || option.action === "cancel");
      default:
        return option.kind === input.kind;
    }
  });
}

function sessionPath(inputs: readonly ExplorerInput[], wallClockMs: number): SessionPath {
  return wallClockMs === EPOCH_MS ? { inputs } : { inputs, wallClockMs };
}

/** How far a storage is from what a goal needs of a key: 0 when it holds; Infinity when nothing tells. */
function storageDistance(
  entries: readonly StorageEntry[],
  matches: (key: string) => boolean,
  goal: Goal,
): { distance: number; value: string } {
  const measure = (value: StorageEntry["value"] | undefined): number => {
    if (value === undefined)
      return goal.candidates.some((candidate) => typeof candidate === "object") ? 0 : Infinity;
    const numeric =
      typeof value === "number" ? value : typeof value === "boolean" ? Number(value) : null;
    if (goal.comparison !== null && numeric !== null)
      return distance(numeric, goal.comparison.operator, goal.comparison.constant);
    if (goal.candidates.length === 0) return 0;
    return goal.candidates.some((candidate) => candidate === value) ? 0 : Infinity;
  };
  let best = { distance: measure(undefined), value: "nothing stored" };
  for (const entry of entries) {
    if (!matches(entry.key)) continue;
    const measured = measure(entry.value);
    if (measured < best.distance || best.value === "nothing stored")
      best = { distance: measured, value: `${entry.key} = ${JSON.stringify(entry.value)}` };
  }
  return best;
}

/** What a goal needs of a stored key, in words, such as `score > 100`. */
function describeNeed(key: string, goal: Goal): string {
  const name = key.replaceAll("\u0000", "*");
  if (goal.comparison !== null)
    return `${name} ${goal.comparison.operator} ${JSON.stringify(goal.comparison.shown)}`;
  const values = goal.candidates.map((candidate) =>
    typeof candidate === "object" ? "nothing stored" : JSON.stringify(candidate),
  );
  return values.length === 0 ? `a value stored as ${name}` : `${name} = ${values.join(" or ")}`;
}

function ancestry(nodes: readonly Node[], node: Node): Node[] {
  const chain: Node[] = [];
  for (let current: Node | undefined = node; current !== undefined;) {
    chain.push(current);
    current = current.parent === null ? undefined : nodes[current.parent];
  }
  return chain.reverse();
}

/** The inputs from a state's session start to it. */
function pathTo(nodes: readonly Node[], node: Node): ExplorerInput[] {
  return ancestry(nodes, node)
    .map((current) => current.input)
    .filter((input): input is ExplorerInput => input !== null);
}

/** Counts a failed state in its crash; returns the crash's key when its path is the crash's path now, or null. */
function recordCrash(
  crashes: Map<string, CrashReport>,
  step: Step,
  node: Node,
  sessions: number,
  repro: Repro,
): string | null {
  const failure = failureOf(step.snapshot);
  const key = `${failure.code}@${failure.path}:${failure.line}:${failure.column}-${failure.endLine}:${failure.endColumn}`;
  const known = crashes.get(key);
  if (known === undefined) {
    crashes.set(key, {
      ...failure,
      states: 1,
      clock: node.clock,
      ...(node.chosen ? { chosen: true } : {}),
      ...repro,
      texts: step.texts,
    });
    return key;
  }
  known.states += 1;
  const knownSessions = 1 + (known.earlier?.length ?? 0);
  // A play path is better than one with chosen random outcomes, which is better than a clock one.
  const rank = (clock: boolean, chosen: boolean) => (clock ? 2 : chosen ? 1 : 0);
  const knownRank = rank(known.clock, known.chosen === true);
  const nodeRank = rank(node.clock, node.chosen);
  const better =
    nodeRank < knownRank ||
    (nodeRank === knownRank &&
      (sessions < knownSessions ||
        (sessions === knownSessions && repro.inputs.length < known.inputs.length)));
  if (!better) return null;
  crashes.set(key, {
    ...failure,
    states: known.states,
    clock: node.clock,
    ...(node.chosen ? { chosen: true } : {}),
    ...repro,
    texts: step.texts,
  });
  return key;
}

/** Plan spans are compact: zero-based start/end line and column, and offsets into the file's source. */
function compactSpan(value: unknown) {
  const span = record(value);
  return typeof span.sl === "number" && typeof span.el === "number"
    ? {
        line: span.sl + 1,
        column: Number(span.sc) + 1,
        endLine: span.el + 1,
        endColumn: Number(span.ec) + 1,
        start: Number(span.so),
        end: Number(span.eo),
      }
    : null;
}

/** The file of each instruction, as the runtime reports a failure's path (`instructionSourcePath`). */
export function instructionFiles(plan: Data): string[] {
  const files = list(plan.files);
  return list(plan.instructions).map((instruction, index) => {
    if (
      (instruction.kind === "declareGlobal" || instruction.kind === "declareSpeaker") &&
      typeof instruction.file === "number"
    )
      return String(files[instruction.file]?.path);
    const file =
      files.find(
        (candidate) =>
          index >= Number(candidate.startInstruction) && index < Number(candidate.endInstruction),
      ) ?? files[0];
    return String(file?.path);
  });
}

/** Instructions that only open or close a block, which a way's first line should skip. */
const STRUCTURAL = new Set([
  "enterScope",
  "leaveScope",
  "clearTemporary",
  "clearTemporaries",
  "jump",
]);

/** The first instruction at or after `index` that is not structural, within a few steps. */
function firstStatement(instructions: readonly Data[], index: number): number {
  for (let current = index; current < Math.min(instructions.length, index + 5); current += 1) {
    if (!STRUCTURAL.has(String(instructions[current]?.kind))) return current;
  }
  return index;
}

function wayName(instruction: Data, way: number): "true" | "false" | "enter" | "exit" {
  return instruction.kind === "jumpIfFalse"
    ? way === 0
      ? "true"
      : "false"
    : way === 0
      ? "enter"
      : "exit";
}

function sourceKinds(goals: readonly Goal[]): SourceKind[] {
  const kinds = new Set<SourceKind>();
  for (const { source } of goals)
    kinds.add(source.kind === "variable" ? (source.counter ? "counter" : "variable") : source.kind);
  return [...kinds].sort();
}

function conditionText(instruction: Data, path: string, sources: ReadonlyMap<string, string>) {
  const span = compactSpan(record(instruction.condition ?? instruction.expression).span);
  const source = sources.get(path);
  return span === null
    ? null
    : {
        line: span.line,
        column: span.column,
        endLine: span.endLine,
        endColumn: span.endColumn,
        text: source === undefined ? "" : short(source.slice(span.start, span.end)),
      };
}

const NO_PATH = "no execution path from the session start";
const STORAGE_FIXED =
  "only behind a condition on stored values that this package's saves never meet";

function lineCoverage(
  instructions: readonly Data[],
  files: readonly string[],
  session: Session,
  sources: ReadonlyMap<string, string>,
  unreachable: { readonly fromStart: Uint8Array; readonly withStorage: Uint8Array },
  constants: ReadonlyMap<number, boolean>,
  fixed: ReadonlyMap<number, { value: boolean; reason: string }>,
  targets: ReadonlyMap<number, Target>,
  randomChoices: boolean,
): ExploreResult["coverage"] {
  // An instruction that ran but is statically unreachable shows the analysis missed a way: then claim nothing.
  let contradictions = 0;
  instructions.forEach((_, index) => {
    if (
      unreachable.withStorage[index] === 1 &&
      (session.visited[index] === 1 ||
        session.chosenVisited[index] === 1 ||
        session.clockVisited[index] === 1)
    )
      contradictions += 1;
  });
  const claims = contradictions === 0;
  const labelOf = (index: number): Reach =>
    session.visited[index] === 1
      ? "play"
      : session.chosenVisited[index] === 1
        ? "chosen"
        : session.clockVisited[index] === 1
          ? "clock"
          : claims && unreachable.withStorage[index] === 1
            ? "unreachable"
            : "unknown";
  const order: readonly Reach[] = ["play", "chosen", "clock", "unknown", "unreachable"];
  // Per file, per line: the strongest label of the instructions starting on it, and for `unreachable` its reason.
  const lines = new Map<string, Map<number, { reach: Reach; reason?: string }>>();
  const lineOf = instructions.map((instruction) => compactSpan(instruction.span)?.line ?? null);
  instructions.forEach((_, index) => {
    const line = lineOf[index];
    if (line == null) return;
    const file = lines.get(files[index]!) ?? new Map<number, { reach: Reach; reason?: string }>();
    const label = labelOf(index);
    const known = file.get(line);
    if (known === undefined || order.indexOf(label) < order.indexOf(known.reach))
      file.set(
        line,
        label === "unreachable"
          ? { reach: label, reason: unreachable.fromStart[index] === 1 ? NO_PATH : STORAGE_FIXED }
          : { reach: label },
      );
    lines.set(files[index]!, file);
  });
  const percent = (part: number, whole: number) =>
    whole === 0 ? 100 : Math.round((part / whole) * 1000) / 10;
  const reach: Partial<Record<Reach, number>> = {
    play: 0,
    ...(randomChoices ? { chosen: 0 } : {}),
    clock: 0,
    unreachable: 0,
    unknown: 0,
  };
  const fileCoverage: FileCoverage[] = [...lines]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([path, fileLines]) => {
      const sorted = [...fileLines].sort(([left], [right]) => left - right);
      for (const [, { reach: label }] of sorted) reach[label] += 1;
      const visited = sorted.filter(
        ([, { reach: label }]) => label === "play" || label === "chosen",
      ).length;
      // Lines of one label and reason with no other line between them form one range.
      const ranges: {
        from: number;
        to: number;
        reach: Exclude<Reach, "play" | "chosen">;
        reason?: string;
      }[] = [];
      let open: (typeof ranges)[number] | null = null;
      for (const [line, { reach: label, reason }] of sorted) {
        if (label === "play" || label === "chosen") open = null;
        else if (open !== null && open.reach === label && open.reason === reason) open.to = line;
        else
          ranges.push(
            (open = {
              from: line,
              to: line,
              reach: label,
              ...(reason === undefined ? {} : { reason }),
            }),
          );
      }
      return {
        path,
        coverableLines: sorted.length,
        visitedLines: visited,
        percent: percent(visited, sorted.length),
        unvisited: ranges.map(({ from, to, reach: label, reason }) => ({
          lines: from === to ? `${from}` : `${from}-${to}`,
          reach: label,
          ...(reason === undefined ? {} : { reason }),
        })),
      };
    });
  const coverable = fileCoverage.reduce((sum, file) => sum + file.coverableLines, 0);
  const visited = fileCoverage.reduce((sum, file) => sum + file.visitedLines, 0);
  const unvisitedBranches: UnvisitedBranch[] = [];
  instructions.forEach((instruction, index) => {
    if (instruction.kind !== "jumpIfFalse" && instruction.kind !== "loopStart") return;
    // Play with chosen random outcomes is play.
    const play = session.branches[index]! | session.chosenBranches[index]!;
    const clock = session.clockBranches[index]!;
    const target = Number(instruction.target);
    // A condition play never evaluated, or with both ways equal, is not listed.
    if (play === 0 || play === 3 || target === index + 1) return;
    const condition = record(instruction.condition ?? instruction.expression);
    if (condition.kind === "literal") return;
    const way = play === 1 ? 1 : 0;
    const missedTarget = way === 1;
    const constant = constants.get(index);
    const storage = fixed.get(index);
    const directed = targets.get(index * 2 + way);
    const label: Exclude<Reach, "play" | "chosen"> =
      (clock & (way === 0 ? 1 : 2)) !== 0
        ? "clock"
        : claims && (constant !== undefined || storage !== undefined)
          ? "unreachable"
          : "unknown";
    const reason =
      label === "unreachable"
        ? constant !== undefined
          ? `the compiler proves the condition always ${constant}`
          : storage?.reason
        : label === "unknown"
          ? (directed?.note ?? undefined)
          : undefined;
    const reached = directed?.reach;
    unvisitedBranches.push({
      instruction: index,
      kind: instruction.kind === "jumpIfFalse" ? "if" : "loop",
      path: files[index]!,
      line: lineOf[index] ?? 0,
      condition: conditionText(instruction, files[index]!, sources),
      missed: wayName(instruction, way),
      targetInstruction: missedTarget ? target : index + 1,
      targetLine: lineOf[firstStatement(instructions, missedTarget ? target : index + 1)] ?? null,
      reach: label,
      ...(reason === undefined ? {} : { reason }),
      sources: directed === undefined ? [] : sourceKinds(directed.goals),
      attempts: directed?.attempts ?? 0,
      ...(label === "clock" && reached != null ? { repro: reached.repro } : {}),
    });
  });
  return {
    coverableLines: coverable,
    visitedLines: visited,
    percent: percent(visited, coverable),
    reach,
    instructions: instructions.length,
    visitedInstructions: session.visited.reduce((sum, value) => sum + value, 0),
    staticContradictions: contradictions,
    files: fileCoverage,
    unvisitedBranches,
  };
}

function directedSummary(
  instructions: readonly Data[],
  files: readonly string[],
  sources: ReadonlyMap<string, string>,
  targets: ReadonlyMap<number, Target>,
  attempts: number,
  transitions: number,
  randomChoices: boolean,
): ExploreResult["directed"] {
  const bySource: ExploreResult["directed"]["bySource"] = {
    ask: { targets: 0, reached: 0 },
    storage: { targets: 0, reached: 0 },
    clock: { targets: 0, reached: 0 },
    counter: { targets: 0, reached: 0 },
    variable: { targets: 0, reached: 0 },
    none: { targets: 0, reached: 0 },
  };
  const reached: { play: number; clock: number; chosen?: number } = { play: 0, clock: 0 };
  if (randomChoices) reached.chosen = 0;
  const multiSession = { ways: 0, longestChain: 0 };
  const ways: ReachedBranch[] = [];
  for (const target of targets.values()) {
    const kinds = sourceKinds(target.goals);
    for (const kind of kinds.length === 0 ? (["none"] as const) : kinds) {
      bySource[kind].targets += 1;
      if (target.reach !== null) bySource[kind].reached += 1;
    }
    if (target.reach === null) continue;
    if (target.reach.label === "chosen") reached.chosen = (reached.chosen ?? 0) + 1;
    else reached[target.reach.label] += 1;
    const sessions = 1 + (target.reach.repro.earlier?.length ?? 0);
    if (sessions > 1) multiSession.ways += 1;
    multiSession.longestChain = Math.max(multiSession.longestChain, sessions);
    const instruction = instructions[target.instruction]!;
    const path = files[target.instruction]!;
    ways.push({
      path,
      line: compactSpan(instruction.span)?.line ?? 0,
      condition: conditionText(instruction, path, sources)?.text ?? "",
      way: wayName(instruction, target.way),
      reach: target.reach.label,
      via: target.reach.via,
      sources: kinds,
      sessions,
      repro: target.reach.repro,
    });
  }
  return { targets: targets.size, attempts, transitions, reached, multiSession, bySource, ways };
}

/**
 * Traps: loops the player cannot leave. Explored states are grouped by loop key (the state without clock, random
 * state, and settled handles), with an edge wherever an explored input leads from one group to another. A group
 * escapes when one of its states ended (completed or failed), or when none of its states was fully expanded, so its
 * future is unknown; so does every group with an edge to an escaping group. The remaining groups form the trapped
 * part: every explored input from them leads back into it. Each strongly connected part of it that no explored input
 * leaves is one trap; trapped groups outside such a part lead into one and are counted as its feeders. A state where
 * the player can do nothing and nothing will happen is a `stuck` trap of its own.
 *
 * The verdict covers only the inputs tried: a loop that waits for a typed word the candidates do not contain, or for
 * a clock time the explorer does not try, is reported as a trap. Each trap comes with the state its path leads to.
 */
function findTraps(
  nodes: readonly Node[],
  instructions: readonly Data[],
  files: readonly string[],
  reproOf: (node: Node) => Repro,
): { report: TrapReport; entry: number }[] {
  const groups = new Map<string, Node[]>();
  for (const node of nodes) {
    const members = groups.get(node.loop);
    if (members === undefined) groups.set(node.loop, [node]);
    else members.push(node);
  }
  const successors = new Map<string, Set<string>>();
  for (const [loop, members] of groups) {
    successors.set(
      loop,
      new Set(members.flatMap((member) => member.edges.map((edge) => nodes[edge]!.loop))),
    );
  }
  const escaping = new Set<string>();
  for (const [loop, members] of groups) {
    const ended = members.some((node) => node.status === "completed" || node.status === "failed");
    const explored = members.some((node) => node.status === "expanded" || node.status === "stuck");
    if (ended || !explored) escaping.add(loop);
  }
  const predecessors = new Map<string, string[]>();
  for (const [loop, next] of successors) {
    for (const target of next) {
      const previous = predecessors.get(target);
      if (previous === undefined) predecessors.set(target, [loop]);
      else previous.push(loop);
    }
  }
  const queue = [...escaping];
  while (queue.length > 0) {
    for (const previous of predecessors.get(queue.pop()!) ?? []) {
      if (!escaping.has(previous)) {
        escaping.add(previous);
        queue.push(previous);
      }
    }
  }
  const trapped = [...groups.keys()].filter((loop) => !escaping.has(loop));
  const components = stronglyConnected(trapped, (loop) => [...successors.get(loop)!]);
  const componentOf = new Map<string, number>();
  components.forEach((component, index) => {
    for (const loop of component) componentOf.set(loop, index);
  });
  const bottom = components
    .map((component, index) => ({ component, index }))
    .filter(({ component, index }) =>
      component.every((loop) =>
        [...successors.get(loop)!].every((next) => componentOf.get(next) === index),
      ),
    );
  // Feeders: trapped groups outside the bottom components, each counted for the first one a backward search from the
  // bottom components reaches it from.
  const feeders = new Map<number, number>();
  const owner = new Map<string, number>();
  const pending: string[] = [];
  for (const { component, index } of bottom) {
    for (const loop of component) {
      owner.set(loop, index);
      pending.push(loop);
    }
  }
  for (let next = 0; next < pending.length; next += 1) {
    const loop = pending[next]!;
    for (const previous of predecessors.get(loop) ?? []) {
      if (owner.has(previous) || escaping.has(previous)) continue;
      const index = owner.get(loop)!;
      owner.set(previous, index);
      feeders.set(index, (feeders.get(index) ?? 0) + groups.get(previous)!.length);
      pending.push(previous);
    }
  }
  const traps = bottom.map(({ component, index }) => {
    const members = component.flatMap((loop) => groups.get(loop)!);
    const cyclic = component.length > 1 || successors.get(component[0]!)!.has(component[0]!);
    // The shortest way in, a play one when there is.
    const entry = members.reduce((best, node) =>
      (node.clock ? 1 : 0) < (best.clock ? 1 : 0) ||
      ((node.clock ? 1 : 0) === (best.clock ? 1 : 0) && node.depth < best.depth)
        ? node
        : best,
    );
    const locations = new Set<string>();
    for (const node of members) {
      const at = node.prompt.instruction;
      const span = at === null ? null : compactSpan(instructions[at]?.span);
      if (at !== null && span !== null) locations.add(`${files[at]}:${span.line}`);
    }
    const report: TrapReport = {
      kind: cyclic ? "loop" : "stuck",
      states: members.length,
      feederStates: feeders.get(index) ?? 0,
      locations: [...locations].slice(0, 10),
      sampleTexts: [...new Set(members.flatMap((node) => node.texts))].slice(0, 8),
      samplePrompts: [
        ...new Set(members.map((node) => node.prompt.text).filter((text) => text !== "")),
      ].slice(0, 8),
      clock: entry.clock,
      ...reproOf(entry),
    };
    return { report, entry: entry.id };
  });
  // Later sessions meet the same loop with other storage: one trap per kind and place, by its shortest way in.
  const merged = new Map<string, { report: TrapReport; entry: number }>();
  for (const { report: trap, entry } of traps) {
    const key = `${trap.kind}@${trap.locations.join("|")}`;
    const known = merged.get(key)?.report;
    if (known === undefined) {
      merged.set(key, { report: trap, entry });
      continue;
    }
    known.states += trap.states;
    known.feederStates += trap.feederStates;
    const shorter =
      (known.clock && !trap.clock) ||
      (known.clock === trap.clock &&
        (trap.earlier?.length ?? 0) * 1_000_000 + trap.inputs.length <
          (known.earlier?.length ?? 0) * 1_000_000 + known.inputs.length);
    if (shorter)
      merged.set(key, {
        report: { ...trap, states: known.states, feederStates: known.feederStates },
        entry,
      });
  }
  return [...merged.values()];
}

/** Tarjan's strongly connected components, iteratively. */
function stronglyConnected(
  vertices: readonly string[],
  next: (vertex: string) => string[],
): string[][] {
  const inside = new Set(vertices);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let counter = 0;
  for (const root of vertices) {
    if (index.has(root)) continue;
    const work: { vertex: string; edges: string[]; position: number }[] = [];
    const open = (vertex: string) => {
      index.set(vertex, counter);
      low.set(vertex, counter);
      counter += 1;
      stack.push(vertex);
      onStack.add(vertex);
      work.push({
        vertex,
        edges: next(vertex).filter((target) => inside.has(target)),
        position: 0,
      });
    };
    open(root);
    while (work.length > 0) {
      const frame = work.at(-1)!;
      if (frame.position < frame.edges.length) {
        const target = frame.edges[frame.position++]!;
        if (!index.has(target)) open(target);
        else if (onStack.has(target))
          low.set(frame.vertex, Math.min(low.get(frame.vertex)!, index.get(target)!));
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent !== undefined)
        low.set(parent.vertex, Math.min(low.get(parent.vertex)!, low.get(frame.vertex)!));
      if (low.get(frame.vertex) === index.get(frame.vertex)) {
        const component: string[] = [];
        for (let vertex: string | undefined; vertex !== frame.vertex;) {
          vertex = stack.pop()!;
          onStack.delete(vertex);
          component.push(vertex);
        }
        components.push(component);
      }
    }
  }
  return components;
}
