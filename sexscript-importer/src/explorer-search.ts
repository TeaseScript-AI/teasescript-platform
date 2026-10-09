import { createHash } from "node:crypto";
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
  difference,
  distance,
  goalsFor,
  KEY_PLACEHOLDER,
  keyMatcher,
  namesIn,
  callsClock,
  successors,
  unreachableInstructions,
  type AtomValue,
  type Goal,
  type LoadAlias,
  type PlanDiagnostic,
  type Slot,
} from "./explorer-analysis.ts";
import { FAR, TreasureMap } from "./explorer-guidance.ts";
import {
  clockModel,
  exactPart,
  flipGap,
  holdsAt,
  storedHolds,
  timeContext,
} from "./explorer-time.ts";
import {
  EPOCH_MS,
  failureOf,
  isClockInput,
  parseSnapshot,
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
  type TaggedSnapshot,
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
/**
 * With depth phases: the share of play work that goes to the open depths other than the one gaining most, each in turn,
 * so that a depth whose gain rises again is seen. An eighth, as for a chain's routes: most work goes to the depth gaining
 * most, and every open depth is measured again now and then.
 */
const DEPTH_EXPLORE_SHARE = 1 / 8;
/**
 * With chain following: the share of all runtime operations that following long runs of waits may take. A sixteenth, as
 * for chosen random outcomes; past it, such states are ranked as any other.
 */
const FORCED_SHARE = 1 / 16;
/**
 * Until stalled: the operations without progress after which a run stops, at least, and more per coverable line; and
 * how many times the longest stretch without progress that progress still ended the window grows to.
 */
const STALL_OPERATIONS = 20_000;
const STALL_OPERATIONS_PER_LINE = 20;
const STALL_GAP_FACTOR = 3;
/** Until stalled: a stall is a spiral when one place took this share of the expansions since the last progress. */
const SPIRAL_SHARE = 1 / 2;

/**
 * Until stalled: how many operations without progress stop a run of a plan with `lines` coverable lines, when the
 * longest stretch without progress that progress ended so far was `gap` operations.
 */
export function stallWindow(lines: number, gap: number): number {
  return Math.max(STALL_OPERATIONS + STALL_OPERATIONS_PER_LINE * lines, STALL_GAP_FACTOR * gap);
}
/** With guidance: the fewest instructions a region of code not reached yet must have to be led toward. */
const MIN_REGION = 10;
/** The target of the guidance lead, which is no condition's. */
const GUIDED = -1;
/** Sessions one chain toward a stored value may take. */
const MAX_CHAIN = 100;
/** A chain's route replays at most this many inputs. */
const MAX_ROUTE_INPUTS = 1000;
/**
 * Every this many sessions of a chain, one replays another route than the best measured: effects depend on the state,
 * and a route that was worse can become better as the stored value changes. One in eight keeps most of the work on the
 * best route while every route seen gets measured over a chain of a few dozen sessions.
 */
const ROUTE_EXPLORE_EVERY = 8;
/** Routes kept per chain, the most efficient seen. */
const MAX_ROUTES = 8;
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
  /** Large answers: typed numbers are also answered with 1,000,000 (see `Session.largeAnswers`). Off by default. */
  readonly largeAnswers?: boolean;
  /**
   * Quit-anywhere next visits: a player can quit at any moment, and what was saved so far stays, so next sessions also
   * start from the storage of explored states a session did not complete (at most {@link MAX_QUIT_SESSIONS}, within the
   * next visits' share, once per storage): first the one with the most stored cells no next visit started from had,
   * the values of the keys conditions compare and their changes in its session. Off by default.
   */
  readonly quitAnywhere?: boolean;
  /**
   * Depth phases: the search decides how its play work goes to session numbers (depths) by their gain per operation
   * (new lines and condition ways any of a depth's steps reach, over all its work), instead of fixed shares. A new
   * player's first session goes first; the next depth opens when the deepest open one levels off (in the last quarter of
   * its work and in the quarter before, at most half its average gain per operation) or has nothing left, and left
   * storage to start from, and then gets an eighth of that depth's play work first. States whose step reached new code
   * go first in any open depth, as without phases. Otherwise the open depth with the most gain per operation in the last
   * quarter of its work gets play, and an eighth of play goes to the other open depths in turn, the one explored least
   * first, so that an earlier depth gets work back when it gains again. A depth starts a next session (from the storage
   * with the most compared values no session of that depth started from had) when none of its open states reached new
   * code. Directed work and random outcomes keep their shares. Off by default (see the README for why).
   */
  readonly depthPhases?: boolean;
  /**
   * Effect ranking (with cells): a play state's cell ranks by the runtime operations its expansions took per productive
   * one (a step that reached new code, a cell, slot value or change not seen before, or came closer to a comparison a
   * missed way needs), not by how many expansions it had: a cell whose expansions cost much and find little waits, a cheap
   * one or one that keeps finding something comes back sooner, and a new cell comes first. Off by default.
   */
  readonly effectRanking?: boolean;
  /**
   * Chain following: a state a step left after a hundred waits with nothing else to do (`Step.forced`) goes on waiting
   * in the same expansion, pass after pass, until something else can happen or a state seen before comes, as waiting
   * is no choice; within {@link FORCED_SHARE} of all runtime operations, past which such states are ranked as any other.
   * It reaches content behind long automatic chains at the cost of other content. Off by default.
   */
  readonly followChains?: boolean;
  /**
   * Run until done or stalled: no work budget is needed, and `budgetMs` is only a safety cap. The run stops after
   * {@link stallWindow} operations without progress: new code or a new condition way, or a state closer to a comparison
   * a missed way needs. New cells are counted but do not hold a run up: cells of counters keep coming long after
   * anything else does. `search.audit` says how the run ended. Off by default.
   */
  readonly untilStalled?: boolean;
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
  /**
   * For a `switch` case, whose condition text is its pattern: the kind of case (one value, several as in `case 3, 4`, or
   * a range); the text of what the switch compares; and when that is exactly one part of the date or time, the part
   * (`hour`, `weekdayNumber`, ...).
   */
  case?: "value" | "values" | "range";
  subject?: string;
  clockPart?: string;
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
  /** The variables, stored keys, asks, and clock the missed way depends on, as far as the data flow shows. */
  dependsOn: string[];
  /**
   * Coverable lines that no explored state ran and that the missed way leads to without passing code a state ran:
   * how much code waits behind it.
   */
  behindLines: number;
  /**
   * Of those lines, the ones no state reached and no analysis rules out (`unknown`), each counted once: under the missed
   * way with the most lines behind it, play's ways before those that can never be taken. They add up to at most the
   * `unknown` lines.
   */
  ownLines: number;
  /**
   * The parts of what the missed way needs, one per value source of each comparison in its condition (and, with
   * realignment, in the earlier conditions of its `else if` chain, which must not hold): `met` when some explored state
   * or stored value satisfied that part (not necessarily together with the others), `unmet` with the closest one,
   * `unmeasured` when nothing measures it.
   */
  parts: Part[];
  /** The unmet part measured furthest from holding, from `parts`: what keeps the way closed, as far as measured. */
  best?: Closest;
  /** The session chains toward the stored values the way needs that started sessions (see {@link ChainReport}). */
  chains?: ChainReport[];
  /** For a `clock` way, the shortest path found to it. */
  repro?: Repro;
}

/** One part of what a missed way needs: a comparison and the source of the value it reads. */
export interface Part {
  /** As `name operator constant`, `stored key operator constant`, `answer at path:line`, or `the clock`. */
  needs: string;
  /** `earlier condition` for a part of an earlier condition of the `else if` chain, which must not hold. */
  of: "condition" | "earlier condition";
  status: "met" | "unmet" | "unmeasured";
  closest?: Closest;
}

/**
 * A session chain toward a stored value: the sessions it ran, the closest value it reached, its result (`reached`
 * the way; storage `holds` what the way needs but a session from it did not reach it; its next session still `queued`
 * when the run ended; stopped at the session `limit`; or `stopped` as no route left brought the value closer), the
 * route it repeats, the routes it replayed (that one too, the most progress per operation first), and its last switches
 * between routes, with why.
 */
export interface ChainReport {
  key: string;
  sessions: number;
  closest: string;
  result: "reached" | "holds" | "queued" | "limit" | "stopped";
  route: RouteReport | null;
  routes: RouteReport[];
  switches: { sessions: number; from: string | null; to: string; reason: string }[];
}

/**
 * A route of a session chain: its first inputs and where its session ended, how many inputs its replay takes, the
 * sessions that replayed it and those of them that brought the value no closer, and its progress per 1,000 runtime
 * operations over whole sessions: over those sessions, or the session it comes from before any.
 */
export interface RouteReport {
  at: string;
  inputs: number;
  sessions: number;
  failures: number;
  progressPer1000Operations: number;
}

/** The closest an explored state, or a storage one left, came to a part of what a missed way needs. */
export interface Closest {
  /** The part's comparison, as in {@link Part.needs}. */
  needs: string;
  /**
   * A boolean variable's value is a boolean; for two values compared, their difference; a stored value is its JSON
   * text.
   */
  value: number | boolean | string;
  /** How far `value` is from the comparison holding, as directed search measures it. */
  distance: number;
  /** The session of that state; for a variable, the runtime operations done when a state first came that close. */
  session: number;
  atOperations?: number;
  /**
   * For a variable: `improving` when a state got closer than the first one watched, in the last quarter of the run's
   * operations.
   */
  trend?: "improving" | "flat";
}

/** How a run until stalled ended, and the progress it made. */
export interface Audit {
  /**
   * `complete`: nothing was left to try and no line is of unknown reach; `stalled`: no progress for `window`
   * operations, or nothing left to try with lines of unknown reach; `spiral`: a stall in which one place took most
   * expansions since the last progress (`spiral`), a problem of the explorer; `capped`: the time or state cap came first.
   */
  result: "complete" | "stalled" | "spiral" | "capped";
  /** The stall window at the end ({@link stallWindow}). */
  window: number;
  /** The operations done at the last progress, and the longest stretch of operations without progress, the last one too. */
  lastProgressAt: number;
  longestGap: number;
  /**
   * Progress events: steps that ran new code, took a new way, or came closer to a comparison; and new cells, which do not
   * count as progress for the stall.
   */
  progress: { code: number; ways: number; cells: number; closer: number };
  spiral?: { location: string; prompt: string; share: number };
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
  /** The session chains toward stored values that started sessions for it. */
  chains?: ChainReport[];
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
    /**
     * Why the search stopped: `budget` is the time budget, `operations` the work budget, `stalled` no progress for the
     * stall window (with `untilStalled`).
     */
    stoppedBy: "exhausted" | "budget" | "operations" | "maxStates" | "stalled";
    /** With `untilStalled`: how the run ended, and its progress. */
    audit?: Audit;
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
     * By session number, the depth of a session (the first session of a new player first): the sessions started; the
     * explored states that completed one, such as how often a long first session came to its end, which later sessions
     * need; the runtime operations its sessions ran; the coverable lines its sessions reached first, and those of them
     * reached in the last quarter of those operations, its marginal gain; the condition ways it took first; and its
     * states (or stored values) that came closer to what a missed way needs.
     */
    bySession: {
      started: number[];
      completed: number[];
      operations: number[];
      linesFirst: number[];
      linesFirstLastQuarter: number[];
      waysFirst: number[];
      closer: number[];
    };
    /**
     * With depth phases, by session number as `bySession`: the operations at which each depth opened (null for one that
     * did not), the play work of its expansions and next sessions, the lines and ways they reached first, the next
     * sessions it started, and the play work of exploration turns in all.
     */
    phases?: {
      openedAt: (number | null)[];
      playOperations: number[];
      playGain: number[];
      nextSessions: number[];
      explorationOperations: number;
    };
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
    /**
     * Lines play reached, by the session numbers that ran them, as observed (a line no first session ran may still not
     * need a later one): those only a new player's first session ran, such as an intro; by the smallest session number
     * that ran them; and per file, those only the first session ran and those it never ran.
     */
    bySession: {
      onlyFirst: number;
      least: number[];
      files: { path: string; onlyFirst: number; notFirst: number }[];
    };
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
 * The snapshots of waiting states, so that directed search can go on from any explored state: the tagged snapshots the
 * runtime exported (`exportTaggedSnapshot`), their JSON's exact bytes packed with zstd level 1 (after the first few with
 * a dictionary made of the first ones' bytes) and their tag, so that a restore takes them unchecked. Above its limit (an eighth of the
 * memory by default, from 256 MiB to 4 GiB) the oldest ones that are not pinned are dropped; a state without one is
 * replayed.
 */
class SnapshotStore {
  peakBytes = 0;
  evicted = 0;
  readonly limitBytes: number;
  readonly #entries = new Map<number, { data: Uint8Array; dictionary: boolean; tag: string }>();
  readonly #pinned = new Set<number>();
  readonly #first: Uint8Array[] = [];
  #dictionary: Buffer | null = null;
  #bytes = 0;

  constructor(limitBytes = STORE_BYTES) {
    this.limitBytes = limitBytes;
  }

  /** Keeps a tagged snapshot: its JSON's bytes and its tag, exactly as the runtime wrote them. */
  put(id: number, tagged: TaggedSnapshot, pinned = false): void {
    this.putBytes(id, Buffer.from(tagged.json, "utf8"), tagged.tag, pinned);
  }

  /** A kept tagged snapshot as it was written, to restore. */
  getTagged(id: number): TaggedSnapshot | null {
    const entry = this.#entries.get(id);
    const bytes = this.getBytes(id);
    return entry === undefined || bytes === null
      ? null
      : { json: Buffer.from(bytes).toString("utf8"), tag: entry.tag };
  }

  /** A kept snapshot, read. */
  get(id: number): Data | null {
    const tagged = this.getTagged(id);
    return tagged === null ? null : parseSnapshot(tagged.json);
  }

  /** Keeps a snapshot's exact bytes and its tag, which {@link getBytes} and {@link getTagged} give back as they were. */
  putBytes(id: number, bytes: Uint8Array, tag: string, pinned = false): void {
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
    this.#entries.set(id, { data, dictionary, tag });
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

/**
 * Open states with depth phases ({@link ExploreOptions.depthPhases}): those with a lead, those after a chosen random
 * outcome, and the others by their session number, each in its own queue, so that the search chooses the depth to
 * expand. A depth also counts its open states whose step reached new code.
 */
class DepthFrontier {
  readonly #lead: Pick<Frontier, "size" | "push" | "pop">;
  readonly #chosen: Pick<Frontier, "size" | "push" | "pop">;
  readonly #depths: Pick<Frontier, "size" | "push" | "pop">[] = [];
  readonly #fresh: number[] = [];
  readonly #freshNodes = new Set<number>();
  readonly #make: () => Pick<Frontier, "size" | "push" | "pop">;
  readonly #depthOf: (node: number) => number;
  readonly #isChosen: (node: number) => boolean;
  #size = 0;

  constructor(
    make: (chosen: boolean) => Pick<Frontier, "size" | "push" | "pop">,
    depthOf: (node: number) => number,
    isChosen: (node: number) => boolean,
  ) {
    this.#lead = make(false);
    this.#chosen = make(true);
    this.#make = () => make(false);
    this.#depthOf = depthOf;
    this.#isChosen = isChosen;
  }

  get size(): number {
    return this.#size;
  }

  get leads(): number {
    return this.#lead.size;
  }

  get chosen(): number {
    return this.#chosen.size;
  }

  /** The open states of a depth, and its fresh ones: play states whose step reached new code, not resumed. */
  sizeOf(depth: number): number {
    return this.#depths[depth]?.size ?? 0;
  }

  freshOf(depth: number): number {
    return this.#fresh[depth] ?? 0;
  }

  /** The deepest depth with a queue. */
  get deepest(): number {
    return this.#depths.length - 1;
  }

  /** Queues a state at `rank` (see `order`): by its lead (`rank[1]` 0), its chosen outcome, or else its depth. */
  push(node: number, rank: readonly number[]): void {
    this.#size += 1;
    if (this.#isChosen(node)) return this.#chosen.push(node, rank);
    if (rank[1] === 0) return this.#lead.push(node, rank);
    const depth = this.#depthOf(node);
    while (this.#depths.length <= depth) this.#depths.push(this.#make());
    this.#depths[depth]!.push(node, rank);
    // Fresh: a play state (not resumed from a corpus, not on the clock) whose step reached new code, which comes first
    // in its depth's queue.
    if (rank[0] === 0 && rank[1] === 1 && rank[2] === 0 && !this.#freshNodes.has(node)) {
      this.#freshNodes.add(node);
      this.#fresh[depth] = (this.#fresh[depth] ?? 0) + 1;
    }
  }

  popLead(): number | undefined {
    return this.#taken(this.#lead.pop());
  }

  popChosen(): number | undefined {
    return this.#taken(this.#chosen.pop());
  }

  /** The first state with a lead, else after a chosen outcome, else of the shallowest depth. */
  pop(): number | undefined {
    if (this.#lead.size > 0) return this.popLead();
    const depth = this.#depths.findIndex((queue) => queue !== undefined && queue.size > 0);
    return depth >= 0 ? this.popDepth(depth) : this.popChosen();
  }

  popDepth(depth: number): number | undefined {
    const node = this.#taken(this.#depths[depth]?.pop());
    if (node !== undefined && this.#freshNodes.delete(node)) this.#fresh[depth]! -= 1;
    return node;
  }

  #taken(node: number | undefined): number | undefined {
    if (node !== undefined) this.#size -= 1;
    return node;
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
    // A state's age is its cell's expansions when it was queued, last: the states queued when their cell was expanded
    // least, the ones that waited longest, go first, before the tier, within a cell and between cells expanded as often.
    this.#entries[id]!.states.push(node, [this.#expansions(cell), ...rank.slice(GROUP + 1)]);
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
  /** Expansions by cell; and of play states, the runtime operations they took and how many were productive. */
  readonly expansions: number[] = [];
  readonly work: number[] = [];
  readonly productive: number[] = [];
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
  /** The slot values seen, as `source, bucket, ...` lists in source order: their IDs by a hash of the list, and each one's list. */
  readonly #values = new Map<string, number>();
  readonly #vectors: (Uint16Array | Int32Array)[] = [];
  readonly #cells = new Map<string, number>();
  /** Changes of a value's bucket seen (`source:from:to`), and the pairs of slot values compared for them. */
  readonly #transitions = new Set<string>();
  readonly #pairs = new Set<number>();

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
   * from the state before (`from`, the ID of its slot values), seen for the first time. A state that only waits, after
   * a long run of waits (`forced`), has a cell without the passes of its loops: those passes are the time going by, not
   * places the player gets to by choosing.
   */
  of(
    snapshot: Data,
    waitsAt: number | null,
    from: number | null,
    clock: readonly (readonly [string, string])[] = [],
    forced = false,
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
    const sorted = [...found].sort(([left], [right]) => left - right).flat();
    // Kept small, as a run keeps one per distinct set of slot values: by a hash, in 16 bits when the numbers fit.
    const vector = sorted.every((number) => number < 0x10000)
      ? Uint16Array.from(sorted)
      : Int32Array.from(sorted);
    const text = createHash("sha1").update(sorted.join(",")).digest("base64");
    let values = this.#values.get(text);
    if (values === undefined) {
      values = this.#vectors.length;
      this.#values.set(text, values);
      this.#vectors.push(vector);
    }
    // A pair of value IDs as one number: IDs stay far below 2^26.
    const pair = from === null ? 0 : from * 0x4000000 + values;
    if (from !== null && from !== values && !this.#pairs.has(pair)) {
      this.#pairs.add(pair);
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
    const place = `${waitsAt ?? "-"}/${returns.join("/")}/${forced ? "" : loops.join("/")}|${values}`;
    let cell = this.#cells.get(place);
    const fresh = cell === undefined;
    if (cell === undefined) {
      cell = this.#cells.size;
      this.#cells.set(place, cell);
      this.expansions.push(0);
      this.work.push(0);
      this.productive.push(0);
    }
    return { cell, values, novel, fresh };
  }

  /** The compared values of a storage: each stored key a slot matches, with its value's bucket for that slot. */
  storageValues(entries: readonly StorageEntry[]): string[] {
    const values: string[] = [];
    for (const { key, value } of entries) {
      let slots = this.#byKey.get(key);
      if (slots === undefined) {
        slots = this.#patterns.filter(({ matches }) => matches(key)).map(({ slot }) => slot);
        this.#byKey.set(key, slots);
      }
      for (const slot of slots) values.push(`${slot}:${key}=${bucket(this.slots[slot]!, value)}`);
    }
    return values;
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
function changes(from: Uint16Array | Int32Array, to: Uint16Array | Int32Array): string[] {
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
  /** Sessions of this chain that ran (one more may be queued). */
  started: number;
  /** An attempt of this chain is still queued. */
  queued: boolean;
  /** The storages measured so far, and the closest of them. */
  scanned: number;
  closest: { left: Left; distance: number; value: string } | null;
  readonly matches: (key: string) => boolean;
  /**
   * Routes: the sessions seen to bring the stored value closer, by their inputs (a hash of them as JSON), with the work
   * and progress of the first such session and, once replayed, the measured work and progress of the replays. The
   * chosen one; those replayed since the last closer value; the exploration turns taken; and the switches.
   */
  readonly routes: Map<string, Route>;
  route: string | null;
  readonly tried: Set<string>;
  turns: number;
  readonly switches: { sessions: number; from: number | null; to: number; reason: string }[];
}

/** A session seen to bring a chain's stored value closer, replayed as a route: the path to `node`. */
interface Route {
  readonly node: number;
  readonly work: number;
  readonly progress: number;
  tries: number;
  /** Replays in a row that brought the value no closer. */
  fails: number;
  failures: number;
  workSum: number;
  progressSum: number;
}

/**
 * A comparison of a variable with a constant, or with another value by their difference, that a target's missed way
 * needs, and the closest state so far.
 */
interface Watch {
  readonly target: number;
  readonly goal: Goal;
  /** The function the condition is in (0 for none): its variables are read in its innermost running call. */
  readonly scope: number;
  readonly name: string;
  readonly operator: string;
  readonly constant: number;
  readonly shown: number | boolean;
  /** The other value of a comparison of two values ({@link Goal.comparison}); undefined for a constant. */
  readonly against: unknown;
  /** `closer` once a state came closer than the first one watched; `value` is the difference for two values. */
  closest: {
    value: number | boolean;
    distance: number;
    session: number;
    operations: number;
    closer: boolean;
  } | null;
}

/** A storage's identity: a hash of its entries as JSON, so that the storages kept do not hold their JSON twice. */
function storageKey(entries: readonly StorageEntry[]): string {
  return createHash("sha1").update(JSON.stringify(entries)).digest("base64");
}

/** The chains of a target that started sessions, as the report gives them (see {@link ChainReport}). */
function chainReports(
  target: Target | undefined,
  routeOf: (node: number) => { at: string; inputs: number },
): ChainReport[] {
  return [...(target?.chains ?? [])]
    .filter(([, chain]) => chain.started > 0 || chain.queued)
    .map(([key, chain]) => {
      const report = (route: Route): RouteReport => ({
        ...routeOf(route.node),
        sessions: route.tries,
        failures: route.failures,
        progressPer1000Operations: Number((routeRateOf(route) * 1000).toPrecision(3)),
      });
      // The route the chain repeats: the usable one with the most progress per operation, not one an exploration turn
      // replayed last.
      const [route] = [...chain.routes.values()]
        .filter((known) => known.fails < 2)
        .sort((left, right) => routeRateOf(right) - routeRateOf(left));
      return {
        key: key.replaceAll(KEY_PLACEHOLDER, "*"),
        sessions: chain.started,
        closest: chain.value,
        result:
          target?.reach != null && target.reach.label !== "chosen"
            ? "reached"
            : chain.queued
              ? "queued"
              : chain.best === 0
                ? "holds"
                : chain.started >= MAX_CHAIN
                  ? "limit"
                  : "stopped",
        route: route === undefined ? null : report(route),
        routes: [...chain.routes.values()]
          .filter((known) => known.tries > 0)
          .sort((left, right) => routeRateOf(right) - routeRateOf(left))
          .map(report),
        switches: chain.switches
          .slice(-5)
          .map((change) => ({
            sessions: change.sessions,
            from: change.from === null ? null : routeOf(change.from).at,
            to: routeOf(change.to).at,
            reason: change.reason,
          })),
      };
    });
}

/**
 * A route's progress per runtime operation over whole sessions, their starts included: as its replays measured it, or
 * as the session it comes from did before any. The work to get there is the distance left over this, so the route with
 * the most is the one with the least work in all, however long its sessions are.
 */
function routeRateOf(route: Route): number {
  return route.tries === 0
    ? route.progress / Math.max(1, route.work)
    : route.progressSum / Math.max(1, route.workSum);
}

/** How the comparisons of a condition combine to take a way: all needed, any one enough, both, or one comparison. */
function combination(condition: unknown, wanted: boolean): "all" | "any" | "mixed" | "one" {
  const value = record(condition);
  if (value.kind === "group") return combination(value.expression, wanted);
  if (value.kind === "unary" && value.operator === "not")
    return combination(value.operand, !wanted);
  if (value.kind !== "binary" || (value.operator !== "and" && value.operator !== "or"))
    return "one";
  const kind = (value.operator === "and") === wanted ? "all" : "any";
  return [combination(value.left, wanted), combination(value.right, wanted)].every(
    (side) => side === kind || side === "one",
  )
    ? kind
    : "mixed";
}

/**
 * The form of a `switch` case: its subject, held in a temporary, compared with one value (`==`), several (an `or` of
 * those), or a range (`in`); null for another form. An `if` can have the same form (`level() == 5`), so whether the
 * script wrote `case` is told by its text.
 */
function caseForm(
  condition: unknown,
): { kind: "value" | "values" | "range"; temporary: number } | null {
  const value = record(condition);
  const left = record(value.left);
  if (value.kind !== "binary") return null;
  if (
    (value.operator === "==" || value.operator === "in") &&
    left.kind === "temporary" &&
    typeof left.temporaryId === "number"
  )
    return { kind: value.operator === "in" ? "range" : "value", temporary: left.temporaryId };
  if (value.operator !== "or") return null;
  const [first, second] = [caseForm(value.left), caseForm(value.right)];
  return first !== null && second !== null && first.temporary === second.temporary
    ? { kind: "values", temporary: first.temporary }
    : null;
}

/**
 * The variables of a state by the function whose code reads them: for a function, those of its innermost running call,
 * over the top-level variables of the file activation it was called in (`rootScopeId`); for 0, those of code outside
 * functions (the scopes before the first call, and those of called files). An inner binding hides an outer one.
 */
function scopeValues(snapshot: Data): Map<number, Map<string, unknown>> {
  const frames = list(snapshot.frames);
  const byId = new Map(
    [...list(snapshot.retainedScopes), ...frames].map((frame) => [frame.id, frame]),
  );
  const calls = list(snapshot.callFrames);
  const take = (into: Map<string, unknown>, scopes: readonly Data[]) => {
    for (const scope of scopes)
      for (const binding of list(scope.bindings))
        if (typeof binding.name === "string") into.set(binding.name, binding.value);
    return into;
  };
  const outside = take(
    new Map(),
    frames.slice(0, calls.length === 0 ? frames.length : Number(calls[0]!.scopeBaseDepth)),
  );
  const scopes = new Map<number, Map<string, unknown>>([[0, outside]]);
  calls.forEach((call, place) => {
    const own = frames.slice(
      Number(call.scopeBaseDepth),
      place + 1 < calls.length ? Number(calls[place + 1]!.scopeBaseDepth) : frames.length,
    );
    if (call.kind !== "function") take(outside, own);
    else {
      const root = byId.get(call.rootScopeId);
      scopes.set(
        Number(call.functionId),
        take(take(new Map(), root === undefined ? [] : [root]), own),
      );
    }
  });
  return scopes;
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
  /** What keeps directed search from the way, per stored-value goal, when known (see {@link noteOf}). */
  readonly notes: Map<Goal, string>;
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
  /** A chain's attempt: the goal it measures, and the route it replays, if any (see {@link Chain.routes}). */
  readonly goal?: Goal;
  readonly route?: string;
  /** With forward time, an attempt that continues later: like a clock attempt, its states take no first place. */
  readonly later?: true;
}

/**
 * What steers the search toward a target by closeness: a variable's to a comparison (with `against`, its difference from
 * another value, see {@link Goal.comparison}), or, for a way that needs all parts of its condition, the condition's
 * branch distance (`conditionDistance`).
 */
type DistanceTarget =
  | {
      readonly kind: "variable";
      readonly target: number;
      readonly name: string;
      readonly operator: string;
      readonly constant: number;
      readonly against: unknown;
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
  /** A hash of the storage as JSON ({@link storageKey}), which tells storages apart. */
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
 * - a variable the code counts or sets: states closer to the comparison, by `distance` (compared with another value,
 *   of their `difference`), take the first place.
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
  session.largeAnswers = options.largeAnswers === true;
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
  /** A play cell's place in the order: its expansions, or with effect ranking their operations per productive one. */
  const playRank = (cell: number): number =>
    cells === null
      ? 0
      : options.effectRanking === true
        ? cells.work[cell]! / (1 + cells.productive[cell]!)
        : cells.expansions[cell]!;
  const expansionsOf = (node: Node): number =>
    cells === null ? 0 : node.chosen ? (chosenExpansions[node.cell] ?? 0) : playRank(node.cell);
  const queue = (expansions: (cell: number) => number): Pick<Frontier, "size" | "push" | "pop"> =>
    cells === null ? new Frontier() : new CellFrontier((node) => nodes[node]!.cell, expansions);
  const phased = options.depthPhases === true;
  const depthFrontier = phased
    ? new DepthFrontier(
        (chosen) => queue((cell) => (chosen ? (chosenExpansions[cell] ?? 0) : playRank(cell))),
        (node) => starts[nodes[node]!.start]!.session,
        (node) => nodes[node]!.chosen,
      )
    : null;
  // Also for a corpus whose paths chose outcomes: their states keep to their share as well.
  const frontier: Pick<Frontier, "size" | "push" | "pop"> =
    depthFrontier ??
    (session.randomChoices
      ? new SplitFrontier(
          queue(playRank),
          queue((cell) => chosenExpansions[cell] ?? 0),
          (node) => nodes[node]!.chosen,
          () => withinChosenShare(),
        )
      : queue(playRank));
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
  /**
   * For the report, by variable name: the comparisons with a constant that targets' missed ways need, and the closest
   * state since each became a target. Only read, never steering.
   */
  const watched = new Map<string, Watch[]>();
  /** Per state, the runtime operations its session took to reach it. */
  const costOf: number[] = [];
  /** Per instruction, the function it is in, or 0. */
  const functionAt = new Int32Array(instructions.length);
  for (const definition of list(plan.functions))
    for (
      let index = Number(definition.entryInstruction);
      index <= Number(definition.endInstruction);
      index += 1
    )
      functionAt[index] = Number(definition.id);
  const untilStalled = options.untilStalled === true;
  /**
   * The run's progress (steps that ran new code, took a new condition way, or came closer to a comparison a missed way
   * needs; and new cells, which are only counted), the operations done at the last one, the longest stretch without
   * progress that progress ended, and where expansions went since the last progress.
   */
  const progress = { code: 0, ways: 0, cells: 0, closer: 0 };
  let progressAt = 0;
  let longestGap = 0;
  const sinceProgress = new Map<number | null, number>();
  const progressed = (kind: keyof typeof progress): void => {
    progress[kind] += 1;
    if (kind === "cells") return;
    longestGap = Math.max(longestGap, session.operations - progressAt);
    progressAt = session.operations;
    sinceProgress.clear();
  };
  const waysTaken = new Uint8Array(instructions.length * 2);
  /**
   * What each session number (each depth: 1 for a new player's first session) did, indexed by it: the runtime
   * operations its steps ran, the condition ways it took first, and its states that came closer to what a missed way
   * needs. Operations go to the session whose runtime runs them ({@link working}).
   */
  const depthWork: number[] = [0, 0];
  const depthWays: number[] = [];
  const depthCloser: number[] = [];
  let depthNow = 1;
  let depthMark = 0;
  /** Charges the operations run since the last call to the session that ran them; the next ones run in `depth`. */
  const working = (depth: number): void => {
    depthWork[depthNow] = (depthWork[depthNow] ?? 0) + session.operations - depthMark;
    depthMark = session.operations;
    depthNow = depth;
  };
  /**
   * Coverable lines (a file's line that an instruction starts on), by instruction (-1 for none): per line, the session
   * that reached it first and the operations that session had run by then, the smallest session that ran it, and
   * whether a session after the first did. Play with or without chosen random outcomes, as line coverage counts it.
   */
  const lineIds = new Int32Array(instructions.length).fill(-1);
  const lineFiles: string[] = [];
  {
    const known = new Map<string, number>();
    instructions.forEach((instruction, index) => {
      const line = coverableLine(instruction, files[index]!, options.sources);
      if (line == null) return;
      const key = `${files[index]}\u0000${line}`;
      let id = known.get(key);
      if (id === undefined) {
        id = lineFiles.length;
        known.set(key, id);
        lineFiles.push(files[index]!);
      }
      lineIds[index] = id;
    });
  }
  /**
   * With depth phases ({@link ExploreOptions.depthPhases}), per depth: the play work its expansions and next sessions
   * took, the lines and condition ways they reached first, marks of both at each analysis pass, its work in exploration
   * turns, the work it still gets first after it opened, and the next sessions it started; then the deepest open depth,
   * the operations at which each depth opened, all play work, the work of exploration turns, and the storages left to
   * start a next session of each depth from.
   */
  const depths: {
    work: number;
    gain: number;
    readonly marks: { work: number; gain: number }[];
    explored: number;
    owed: number;
    seeds: number;
  }[] = [];
  const depthOf = (depth: number) =>
    (depths[depth] ??= {
      work: 0,
      gain: 0,
      marks: [{ work: 0, gain: 0 }],
      explored: 0,
      owed: 0,
      seeds: 0,
    });
  let deepestOpen = 1;
  const openedAt: number[] = [0, 0];
  let playWork = 0;
  let explorationWork = 0;
  const pendingSeeds: number[] = [];
  /**
   * Lines reached first and condition ways taken first so far, by any step; and by the session number of the step, with
   * the first session's start and a corpus replay too, which no play work is charged for.
   */
  let gainCount = 0;
  const depthNew: number[] = [];
  /** A storage a session of `depth` left that a session of the next depth can start from. */
  const seedLeft = (depth: number): void => {
    pendingSeeds[depth + 1] = (pendingSeeds[depth + 1] ?? 0) + 1;
  };
  const lineFirst = new Uint16Array(lineFiles.length);
  const lineFirstWork = new Float64Array(lineFiles.length);
  const lineLeast = new Uint16Array(lineFiles.length);
  const lineLater = new Uint8Array(lineFiles.length);
  // Answers in the same session go first, then session chains, then clock attempts.
  const playAttempts: Attempt[] = [];
  /**
   * With forward time: states, or session starts (with the start's index), that left a step which read a clock
   * condition first, to give their time steps (see {@link runTimeJob}).
   */
  const timeJobs: { node: number | null; start: number }[] = [];
  const chainAttempts: Attempt[] = [];
  /**
   * A chain's next session along a route, right after a session of that chain: these go before other attempts, so that
   * a route that brings the value closer is repeated at once. A chain's other sessions (from a storage's own session,
   * or toward the condition once storage holds the value) wait their turn among the chain attempts.
   */
  const repeatAttempts: Attempt[] = [];
  const clockAttempts: Attempt[] = [];
  const distanceTargets: DistanceTarget[] = [];
  /** Waiting states by the ask instruction they wait at, a few each. */
  const askNodes = new Map<number, number[]>();
  /** Each distinct storage a play state left, in the order found, and the ones of completed sessions. */
  const left: Left[] = [];
  const leftKeys = new Map<string, number>();
  /** The stored entries of the kept storages, each one object however many storages hold it. */
  const keptEntries = new Map<string, StorageEntry>();
  const completedKeys = new Set<string>();
  const completedLeft: number[] = [];
  let nextFromCompleted = 0;
  let quitVisits = 0;
  let completedVisits = 0;
  /** With quit-anywhere next visits: the stored cells of the storages next visits started from. */
  const seedCells = new Set<string>();
  const cellsOfLeft = new Map<number, readonly string[]>();
  /** Storage that started a next session without a target. */
  const startedFrom = new Set<string>([storageKey([])]);
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
  const items =
    options.corpus === undefined ? null : corpusItems(instructions, files, options.sources);
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
  /** With chain following: runtime operations of long runs of waits followed, within {@link FORCED_SHARE}. */
  let forcedWork = 0;
  const withinForcedShare = () => forcedWork <= (session.operations - replayWork) * FORCED_SHARE;
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
    // The lines the step ran, for the session that ran them; its operations go to that session too.
    const depth = start.session;
    working(depth);
    if (!clock)
      for (const instruction of step.instructions) {
        const line = lineIds[instruction] ?? -1;
        if (line < 0) continue;
        if (lineFirst[line] === 0) {
          gainCount += 1;
          depthNew[depth] = (depthNew[depth] ?? 0) + 1;
          lineFirst[line] = depth;
          lineFirstWork[line] = depthWork[depth] ?? 0;
          lineLeast[line] = depth;
        } else if (depth < lineLeast[line]!) lineLeast[line] = depth;
        if (depth > 1) lineLater[line] = 1;
      }
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
        step.forced,
      ) ?? null;
    lastStepNew = step.newInstructions > 0 || place?.novel === true || place?.fresh === true;
    const newWays = step.ways.filter((way) => waysTaken[way] === 0).length;
    const newWay = newWays > 0;
    depthWays[depth] = (depthWays[depth] ?? 0) + newWays;
    depthNew[depth] = (depthNew[depth] ?? 0) + newWays;
    gainCount += newWays;
    for (const way of step.ways) waysTaken[way] = 1;
    if (step.newInstructions > 0) progressed("code");
    else if (newWay) progressed("ways");
    else if (place?.novel === true || place?.fresh === true) progressed("cells");
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
    // The runtime operations from the session's start to this state, as the steps that reached it took them.
    costOf[node.id] = (parent === null ? 0 : costOf[parent.id]!) + step.operations;
    if (later) wallEnd[node.id] = wallClockOf(step.snapshot);
    byState.set(stateKey, node.id);
    if (watched.size > 0) watch(step.snapshot, start.session);
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
      store.put(node.id, step.tagged, parent === null);
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
    const found = storageOf(snapshot);
    const key = storageKey(found);
    const known = leftKeys.get(key);
    if (known === undefined) {
      // Storages differ in a few entries: each kept storage shares the entries it has in common with the others.
      const entries = found.map((entry) => {
        const id = `${entry.key}\u0000${JSON.stringify(entry.value)}`;
        const shared = keptEntries.get(id);
        if (shared !== undefined) return shared;
        keptEntries.set(id, entry);
        return entry;
      });
      leftKeys.set(key, left.length);
      left.push({ node: node.id, entries, key, sessions: starts[node.start]!.session });
      if (node.status === "completed") {
        completedLeft.push(left.length - 1);
        completedKeys.add(key);
      }
      if (node.status === "completed" || quitAnywhere) seedLeft(starts[node.start]!.session);
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
    if (!quitAnywhere) seedLeft(starts[node.start]!.session);
  };

  /**
   * A runtime session in the state of a node whose snapshot was not stored: from its nearest ancestor that has one,
   * with the inputs after that ancestor replayed in it.
   */
  const replayTo = (node: Node): Runtime | null => {
    const chain: Node[] = [];
    let current: Node | undefined = node;
    let snapshot: TaggedSnapshot | null = null;
    while (current !== undefined && snapshot === null) {
      snapshot = store.getTagged(current.id);
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
    const stored = store.getTagged(node.id);
    return stored === null ? replayTo(node) : restore(node, stored);
  };

  /** A node's snapshot: stored, or exported after a replay. */
  const snapshotOf = (node: Node): Data | null =>
    store.get(node.id) ?? replayTo(node)?.exportTrustedSnapshot() ?? null;

  /**
   * A runtime session in the state of a node's tagged snapshot (`docs/RUNTIME.md#runtime-sessions`), which the runtime
   * takes unchecked while its tag holds and checks otherwise: a snapshot it refuses (`RuntimeDataError`) is a problem of
   * the explorer or the runtime, counted with the engine errors; null then.
   */
  const restore = (node: Node, snapshot: TaggedSnapshot): Runtime | null => {
    working(starts[node.start]!.session);
    try {
      return session.restoreTagged(snapshot);
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
    working(starts[node.start]!.session);
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

  /**
   * With chain following: follows a long run of waits from the state `first` its step left (see
   * {@link ExploreOptions.followChains}): each state with nothing to do but wait goes on waiting at once, until something
   * else can happen, a state seen before comes, or the share is spent. The states passed are expanded on the way.
   */
  const followWaits = (first: Node, firstStep: Step): void => {
    let current = first;
    let last = firstStep;
    while (last.forced && current.status === "open" && withinForcedShare() && !outOfBudget()) {
      const runtime = last.runtime;
      const offered = session.options(runtime, runtime.view(), () =>
        runtime.exportTrustedSnapshot(),
      );
      if (offered.length !== 1 || offered[0]!.kind !== "wait") return;
      const work = session.operations;
      const next = step(current, runtime, offered[0]!);
      forcedWork += session.operations - work;
      if (next === null) return;
      current.status = "expanded";
      const known = nodes.length;
      const reached = transition(current, offered[0]!, next, current.start, null);
      if (reached.id < known) return;
      current = reached;
      last = next;
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
  ): { node: Node; runtime: Runtime | null; first: Step } => {
    starts.push(start);
    working(start.session);
    const first = session.start(start, chosenStart(start));
    const node = transition(null, null, first, starts.length - 1, lead);
    firstNodeOf.set(starts.length - 1, node.id);
    // A session that ends in its first step keeps no snapshot; its time steps read the state it ended in.
    if (later && first.snapshot.status !== "waiting")
      startSnapshots.set(starts.length - 1, first.snapshot);
    return { node, runtime: first.snapshot.status === "waiting" ? first.runtime : null, first };
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

  /** Keeps each watched comparison's closest state up to date with a new state of session `number`. */
  const watch = (snapshot: Data, number: number): void => {
    const scopes = scopeValues(snapshot);
    const globals = new Map(
      list(snapshot.globals).map((binding) => [binding.name, binding.value] as const),
    );
    let stored: ((subject: unknown) => AtomValue) | null = null;
    for (const [name, watches] of watched) {
      for (const entry of watches) {
        // A function's variables only while it runs; a value of another type than the constant compares as no value.
        const variables = scopes.get(entry.scope);
        if (variables === undefined) continue;
        const read = (variable: string) =>
          variables.has(variable) ? variables.get(variable) : globals.get(variable);
        let value = read(name);
        if (entry.against !== undefined) {
          // Two values: their difference, when the other one can be read too, as a variable there, or else a stored
          // value or a variable that only holds one load; both numbers, or both booleans.
          const other = record(entry.against);
          const known =
            other.kind === "identifier" &&
            typeof other.name === "string" &&
            (variables.has(other.name) || globals.has(other.name));
          const gap = difference(
            value,
            known
              ? read(String(other.name))
              : (stored ??= atomReader(
                  new Map(),
                  new Map(storageOf(snapshot).map((item) => [item.key, item.value])),
                ))(entry.against),
          );
          if (gap === undefined) continue;
          value = gap;
        }
        if (
          typeof value !== typeof entry.shown ||
          (typeof value !== "number" && typeof value !== "boolean")
        )
          continue;
        const away = distance(Number(value), entry.operator, entry.constant);
        // Coming closer counts as progress only toward a way play has not taken yet.
        if (
          entry.closest !== null &&
          away < entry.closest.distance &&
          !settled(targets.get(entry.target))
        ) {
          progressed("closer");
          depthCloser[number] = (depthCloser[number] ?? 0) + 1;
        }
        if (entry.closest === null || away < entry.closest.distance)
          entry.closest = {
            value,
            distance: away,
            session: number,
            operations: session.operations,
            closer: entry.closest !== null,
          };
      }
    }
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
      if (goal.against !== undefined) {
        read ??= atomReader(
          variablesOf(snapshot),
          new Map(storageOf(snapshot).map((entry) => [entry.key, entry.value])),
        );
        const gap = difference(read({ kind: "identifier", name: goal.name }), read(goal.against));
        return gap === undefined ? Infinity : distance(gap, goal.operator, goal.constant);
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
    if (chain !== undefined) chain.started += 1;
    attemptCount += 1;
    const work = session.operations;
    // A chain's next session comes from the storage it reached, so its states take no first place of their own.
    const lead: Lead | null =
      attempt.chain !== undefined
        ? null
        : { remaining: attempt.later === true ? 0 : ATTEMPT_EXPANSIONS, target: attempt.target };
    let node: Node;
    let runtime: Runtime | null;
    // The last step the attempt took: in a new session, its start's at least, which can store already.
    let reached: Step | null = null;
    if (attempt.start !== null) {
      ({ node, runtime, first: reached } = startSession(attempt.start, lead));
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
      reached = next;
      runtime = next.snapshot.status === "waiting" ? next.runtime : null;
    }
    directedWork += session.operations - work;
    // A chain's session: what its route did, measured from the storage it started at to the one it reached; then the
    // next session at once, while the value gets closer.
    if (chain === undefined || attempt.goal === undefined || reached === null) return;
    const route = attempt.route === undefined ? undefined : chain.routes.get(attempt.route);
    if (route !== undefined) {
      const gain =
        chain.best -
        chainDistance(target, chain, attempt.goal, storageOf(reached.snapshot)).distance;
      route.tries += 1;
      route.workSum += session.operations - work;
      if (Number.isFinite(gain) && gain > 0) {
        route.progressSum += gain;
        route.fails = 0;
      } else {
        route.fails += 1;
        route.failures += 1;
      }
    }
    chainStep(attempt.target, target, attempt.goal, true);
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
  /** How far a storage is from what a chain's goal needs: with its guards, and the parts of a whole condition. */
  const chainDistance = (
    target: Target,
    chain: Chain,
    goal: Goal,
    entries: readonly StorageEntry[],
  ): { distance: number; value: string } => {
    const condition =
      instructions[target.instruction]!.condition ?? instructions[target.instruction]!.expression;
    const whole = options.conjunctive === true && conjunctive(condition, target.way === 0);
    const measured = storageDistance(entries, chain.matches, goal);
    // With realignment, a storage is only as close as the earlier conditions of the chain let it be.
    for (const guard of target.guards) measured.distance += guardDistance(entries, guard);
    // With the parts on other keys: fewer parts unsatisfied first, then the nearer in sum.
    if (whole && measured.distance < Infinity) {
      const parts = conditionDistance(
        condition,
        target.way === 0,
        atomReader(new Map(), storageMap(entries), chain.matches),
      );
      measured.distance = branchDistance({
        unsatisfied: parts.unsatisfied + (measured.distance > 0 ? 1 : 0),
        sum: parts.sum + measured.distance,
      });
    }
    return measured;
  };

  const routeRate = routeRateOf;

  /**
   * The route a chain's next session replays. After a closer value: the one with the most progress per operation
   * (see {@link routeRateOf}), except every {@link ROUTE_EXPLORE_EVERY}th session, which replays another usable route,
   * each in turn in the order they were found. After a session that came no closer (`stale`): the usable route with the
   * most progress per operation not replayed since the last closer value; none when every one was. A route stays
   * usable until two replays in a row bring the value no closer.
   */
  const chooseRoute = (chain: Chain, stale: boolean): { route: string; reason: string } | null => {
    const usable = [...chain.routes].filter(
      ([id, route]) => route.fails < 2 && !(stale && chain.tried.has(id)),
    );
    const [best] = [...usable].sort(([, left], [, right]) => routeRate(right) - routeRate(left));
    if (best === undefined) return null;
    if (stale)
      return {
        route: best[0],
        reason: "no closer value: the best route not replayed since the last closer one",
      };
    const others = usable.filter(([id]) => id !== best[0]);
    if (others.length > 0 && chain.started % ROUTE_EXPLORE_EVERY === ROUTE_EXPLORE_EVERY - 1) {
      const [route] = others[chain.turns % others.length]!;
      chain.turns += 1;
      return { route, reason: "another route, measured again" };
    }
    return {
      route: best[0],
      reason:
        best[1].tries === 0
          ? "most progress per operation seen"
          : "most progress per operation measured",
    };
  };

  /**
   * One step of a session chain toward a stored value: from the closest storage an explored play state left, a
   * session that replays the witness path when that storage satisfies the condition, or else a route that brought the
   * value closer before, to get closer still: the one with the most progress per operation, now and then another
   * (see {@link chooseRoute}); the storage's own session when no route is known. After a session that came no closer,
   * the other routes in turn; then the chain waits until play leaves a closer storage. `repeat`: right after a session
   * of the chain, whose next one then goes first when it replays a route (see `repeatAttempts`).
   */
  const chainStep = (code: number, target: Target, goal: Goal, repeat = false): boolean => {
    if (goal.source.kind !== "storage" || settled(target)) return false;
    const key = goal.source.key;
    let chain = target.chains.get(key);
    if (chain === undefined) {
      chain = {
        best: Infinity,
        value: "",
        sessions: 0,
        started: 0,
        queued: false,
        scanned: 0,
        closest: null,
        matches: keyMatcher(key),
        routes: new Map(),
        route: null,
        tried: new Set(),
        turns: 0,
        switches: [],
      };
      target.chains.set(key, chain);
    }
    const found = chain;
    if (found.queued) return false;
    // Only the storages found since the last pass are measured.
    for (; found.scanned < left.length; found.scanned += 1) {
      const entry = left[found.scanned]!;
      const measured = chainDistance(target, found, goal, entry.entries);
      const closest = found.closest;
      if (
        measured.distance < Infinity &&
        (closest === null ||
          measured.distance < closest.distance ||
          (measured.distance === closest.distance && entry.sessions < closest.left.sessions))
      )
        found.closest = { left: entry, ...measured };
      // A session that brought the value closer is a route: its inputs, from its start's storage to the storage it
      // left. Sessions with the same inputs are one route, whose replays measure it.
      if (measured.distance === Infinity) continue;
      const start = starts[nodes[entry.node]!.start]!;
      const progress =
        chainDistance(target, found, goal, start.storage).distance - measured.distance;
      if (!Number.isFinite(progress) || progress <= 0) continue;
      const inputs = pathTo(nodes, nodes[entry.node]!).slice(0, MAX_ROUTE_INPUTS);
      const id = createHash("sha1").update(JSON.stringify(inputs)).digest("base64");
      if (found.routes.has(id)) continue;
      found.routes.set(id, {
        node: entry.node,
        work: costOf[entry.node] ?? 0,
        progress,
        tries: 0,
        fails: 0,
        failures: 0,
        workSum: 0,
        progressSum: 0,
      });
      // The most efficient routes are kept, and the chosen one.
      if (found.routes.size > MAX_ROUTES) {
        const [worst] = [...found.routes]
          .filter(([known]) => known !== found.route)
          .sort(([, a], [, b]) => routeRate(a) - routeRate(b));
        if (worst !== undefined) found.routes.delete(worst[0]);
      }
    }
    const best = found.closest;
    const need = describeNeed(key, goal);
    if (best === null) {
      target.notes.set(goal, `needs ${need}; no explored session stored it`);
      return false;
    }
    // With forward time, the next session follows the rhythm of the one that left the storage: as long after it.
    const fromBest = (inputs: readonly ExplorerInput[], route?: string): Attempt => ({
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
      inputs: inputs.slice(0, MAX_ROUTE_INPUTS),
      chain: key,
      goal,
      ...(route === undefined ? {} : { route }),
    });
    // A session of a route from the closest storage; the storage's own session when no route is known.
    const replay = (choice: { route: string; reason: string } | null): void => {
      const route = choice === null ? undefined : found.routes.get(choice.route)!;
      if (choice !== null && route !== undefined && choice.route !== found.route) {
        const from = found.route === null ? undefined : found.routes.get(found.route);
        found.switches.push({
          sessions: best.left.sessions + 1,
          from: from?.node ?? null,
          to: route.node,
          reason: choice.reason,
        });
        found.route = choice.route;
      }
      if (choice !== null) found.tried.add(choice.route);
      found.queued = true;
      (repeat && route !== undefined ? repeatAttempts : chainAttempts).push(
        fromBest(pathTo(nodes, nodes[route?.node ?? best.left.node]!), choice?.route),
      );
    };
    // A storage closer than the chain's best so far (not its first measure) is progress.
    if (best.distance < found.best && Number.isFinite(found.best)) {
      progressed("closer");
      depthCloser[best.left.sessions] = (depthCloser[best.left.sessions] ?? 0) + 1;
    }
    if (best.distance === 0) {
      if (found.best === 0) {
        target.notes.set(
          goal,
          `needs ${need}; a session from storage that has it did not reach the condition`,
        );
        return false;
      }
      Object.assign(found, {
        best: 0,
        value: best.value,
        sessions: best.left.sessions,
        queued: true,
      });
      chainAttempts.push(fromBest(witnessOf(target).inputs.slice(0, MAX_SUFFIX)));
      return true;
    }
    const noted = () => {
      target.notes.set(
        goal,
        `needs ${need}; best reached: ${found.value} after ${found.sessions} session${found.sessions === 1 ? "" : "s"}`,
      );
      return false;
    };
    if (found.started >= MAX_CHAIN) return noted();
    if (best.distance < found.best) {
      Object.assign(found, {
        best: best.distance,
        value: best.value,
        sessions: best.left.sessions,
      });
      found.tried.clear();
      replay(chooseRoute(found, false));
      return true;
    }
    // No closer storage: another usable route from the same one, while one was not replayed since.
    const choice = chooseRoute(found, true);
    if (choice === null) return noted();
    replay(choice);
    return true;
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
    const guard = { condition: before, aliases, goals: goalsFor(flow, before, false, earlier) };
    guardsByCondition.set(earlier, guard);
    return guard;
  };

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
      if (snapshot !== null && completed) sessionOrigins.push({ key, entry, snapshot, now, begun });
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

  /**
   * With depth phases: all a depth did, its play and directed work and the new lines and ways any of its steps reached,
   * which the rates compare; its gain per operation in the last quarter of that work (as marked).
   */
  const totalOf = (depth: number) => ({ work: depthWork[depth] ?? 0, gain: depthNew[depth] ?? 0 });
  const recentRate = (depth: number): number => windowRate(depth, 0.75, 1) ?? Infinity;
  /**
   * A depth's gain per operation between two fractions of all its work (as marked: from the last mark at or before the
   * first to the last at or before the second); null when no work lies between them.
   */
  const windowRate = (depth: number, from: number, to: number): number | null => {
    const known = depthOf(depth);
    const total = totalOf(depth);
    const end =
      to >= 1
        ? total
        : (known.marks.findLast((mark) => mark.work <= total.work * to) ?? known.marks[0]!);
    const start = known.marks.findLast((mark) => mark.work <= total.work * from) ?? known.marks[0]!;
    return end.work > start.work ? (end.gain - start.gain) / (end.work - start.work) : null;
  };
  /** Opens the depths down to `depth`; the deepest gets `owed` play work first. */
  const openDepth = (depth: number, owed: number): void => {
    for (let next = deepestOpen + 1; next <= depth; next += 1) openedAt[next] = session.operations;
    deepestOpen = depth;
    depthOf(depth).owed = owed;
  };
  /**
   * At each analysis pass: marks each depth's work and gain, and opens the next depth when the deepest open one levels
   * off and storage to start from is left. Levelling off holds over two windows, not one lull: in the last quarter of
   * its work and in the quarter before, its gain per operation is at most half its average. The new depth first gets an
   * eighth of the work of the one before.
   */
  const markDepths = (): void => {
    working(depthNow);
    for (let depth = 1; depth < depthWork.length; depth += 1) {
      const known = depthOf(depth);
      const total = totalOf(depth);
      if (total.work > known.marks.at(-1)!.work) known.marks.push(total);
    }
    // A depth with nothing left to expand or start from has levelled off too; one that reached nothing new opens none.
    const deepest = depthOf(deepestOpen);
    const idle = depthFrontier!.sizeOf(deepestOpen) === 0 && (pendingSeeds[deepestOpen] ?? 0) === 0;
    if (
      (depthNew[deepestOpen] ?? 0) > 0 &&
      (pendingSeeds[deepestOpen + 1] ?? 0) > 0 &&
      (idle ||
        (deepest.owed <= 0 &&
          totalOf(deepestOpen).work > 0 &&
          [windowRate(deepestOpen, 0.75, 1), windowRate(deepestOpen, 0.5, 0.75)].every(
            (rate) =>
              rate !== null && rate <= totalOf(deepestOpen).gain / totalOf(deepestOpen).work / 2,
          )))
    )
      openDepth(deepestOpen + 1, deepest.work / 8);
  };
  const charge = (depth: number, work: number, gain: number, exploring: boolean): void => {
    const known = depthOf(depth);
    known.work += work;
    known.gain += gain;
    known.owed -= work;
    playWork += work;
    if (!exploring) return;
    known.explored += work;
    explorationWork += work;
  };
  /**
   * The depth whose play goes next, among the open ones with open states or storage to start from, and whether it is
   * an exploration turn: a depth with states whose step reached new code first; when the open depths have nothing
   * left, the next depth with something opens; null when none.
   */
  const chooseDepth = (): { depth: number; exploring: boolean } | null => {
    const frontierOf = depthFrontier!;
    const has = (depth: number) => frontierOf.sizeOf(depth) > 0 || (pendingSeeds[depth] ?? 0) > 0;
    const open: number[] = [];
    for (let depth = 1; depth <= deepestOpen; depth += 1) if (has(depth)) open.push(depth);
    // Nothing left in the open depths: the next with open states opens, such as states of chain sessions, or the next
    // one to start from when the deepest open one reached something new.
    if (open.length === 0) {
      const next = deepestOpen + 1;
      const opens =
        (depthNew[deepestOpen] ?? 0) > 0 && (pendingSeeds[next] ?? 0) > 0
          ? next
          : Array.from(
              { length: frontierOf.deepest - deepestOpen },
              (_, index) => next + index,
            ).find((depth) => frontierOf.sizeOf(depth) > 0);
      if (opens === undefined) return null;
      openDepth(opens, 0);
      open.push(opens);
    }
    // States whose step reached new code go first in any open depth, as without phases: the one gaining most first.
    const fresh = open.filter((depth) => frontierOf.freshOf(depth) > 0);
    if (fresh.length > 0) {
      const [first] = fresh.sort(
        (left, right) => recentRate(right) - recentRate(left) || left - right,
      );
      return { depth: first!, exploring: false };
    }
    const owed = open.findLast((depth) => depthOf(depth).owed > 0);
    if (owed !== undefined) return { depth: owed, exploring: false };
    const [best, ...others] = open.sort(
      (left, right) => recentRate(right) - recentRate(left) || left - right,
    );
    if (others.length > 0 && explorationWork < playWork * DEPTH_EXPLORE_SHARE) {
      const [least] = others.sort(
        (left, right) => depthOf(left).explored - depthOf(right).explored || left - right,
      );
      return { depth: least!, exploring: true };
    }
    return { depth: best!, exploring: false };
  };
  /**
   * Starts a next session of `depth` from the storage a session of the depth before left, of those not started from:
   * the one with the most compared values no session of `depth` started from had, completed sessions' first. With
   * `varied`, only from one that has such a value. False when none is left (with `varied`: none such).
   */
  const seededValues: Set<string>[] = [];
  const valuesOfLeft = new Map<number, readonly string[]>();
  const startSeed = (depth: number, exploring: boolean, varied: boolean): boolean => {
    const seen = (seededValues[depth] ??= new Set());
    let best: number | null = null;
    let bestNew = -1;
    const consider = (index: number) => {
      const entry = left[index]!;
      if (entry.sessions !== depth - 1 || startedFrom.has(entry.key)) return;
      let values = valuesOfLeft.get(index);
      if (values === undefined) {
        values = cells?.storageValues(entry.entries) ?? [];
        valuesOfLeft.set(index, values);
      }
      const fresh = values.filter((value) => !seen.has(value)).length;
      if (fresh > bestNew) {
        best = index;
        bestNew = fresh;
      }
    };
    for (const index of completedLeft) consider(index);
    if (quitAnywhere) left.forEach((_, index) => consider(index));
    if (best === null) {
      pendingSeeds[depth] = 0;
      return false;
    }
    if (varied && bestNew <= 0) return false;
    const entry = left[best]!;
    startedFrom.add(entry.key);
    pendingSeeds[depth] = Math.max(0, (pendingSeeds[depth] ?? 0) - 1);
    for (const value of valuesOfLeft.get(best) ?? []) seen.add(value);
    const work = session.operations;
    const gain = gainCount;
    const before = starts.length;
    const completed = completedKeys.has(entry.key);
    if (!completed) quitVisits += 1;
    visitFrom(entry, entry.key, completed);
    depthOf(depth).seeds += starts.length - before;
    charge(depth, session.operations - work, gainCount - gain, exploring);
    return true;
  };

  /** Makes targets of the condition ways left one way, schedules their attempts, and goes on with session chains. */
  const analyze = (): boolean => {
    storageMaps.clear();
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
        ...(conditional ? goalsFor(flow, condition, way === 0, index) : []),
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
        notes: new Map(),
      };
      targets.set(code, target);
      for (const goal of goals) {
        if (goal.source.kind !== "variable" || goal.comparison === null) continue;
        const { name } = goal.source;
        const { operator, constant, shown } = goal.comparison;
        watched
          .set(name, watched.get(name) ?? [])
          .get(name)!
          .push({
            target: code,
            goal,
            scope: functionAt[index]!,
            name,
            operator,
            constant,
            shown,
            against: goal.comparison.against?.subject,
            closest: null,
          });
      }
      scheduled = schedule(code, target) || scheduled;
    });
    // A few next sessions from what completed sessions stored, as the player's next visit; with depth phases, a depth
    // starts them when it needs one (see `startSeed`).
    for (; !phased && nextFromCompleted < completedLeft.length; nextFromCompleted += 1) {
      // With quit-anywhere next visits, completed ones have their own count.
      if (
        (quitAnywhere
          ? completedVisits >= MAX_NEXT_SESSIONS
          : startedFrom.size > MAX_NEXT_SESSIONS) ||
        !withinNextShare()
      )
        break;
      const entry = left[completedLeft[nextFromCompleted]!]!;
      const key = entry.key;
      if (startedFrom.has(key)) continue;
      startedFrom.add(key);
      completedVisits += 1;
      visitFrom(entry, key, true);
      scheduled = true;
    }
    // With quit-anywhere next visits, one per pass from the storage of a state a session did not complete: the one with
    // the most stored cells no next visit started from had.
    if (!phased && quitAnywhere && quitVisits < MAX_QUIT_SESSIONS && withinNextShare()) {
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
      // With depth phases, all of them, as play work of the depth they start.
      for (const { key, entry, snapshot, now, begun } of sessionOrigins) {
        if (!phased && !withinNextShare()) break;
        const work = session.operations;
        const gain = gainCount;
        const steps = sessionGaps(snapshot, now, `storage ${key}`).map((gap) => now + gap - begun);
        for (const gap of steps)
          startSession(laterStart(entry.node, entry.entries, NEXT_SESSION_GAP + gap), null);
        timeStepsTaken.sessions += steps.length;
        nextWork += session.operations - work;
        if (phased) {
          charge(entry.sessions + 1, session.operations - work, gainCount - gain, false);
          depthOf(entry.sessions + 1).seeds += steps.length;
        }
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
            against: goal.comparison.against?.subject,
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
  /** Until stalled: the coverable lines, and the operations without progress that stop the run now. */
  const lines = untilStalled
    ? new Set(
        instructions.flatMap((instruction, index) => {
          const span = compactSpan(instruction.span);
          return span === null ? [] : [`${files[index]}:${span.line}`];
        }),
      ).size
    : 0;
  const window = () => (untilStalled ? stallWindow(lines, longestGap) : Infinity);
  const spent = (): "operations" | "budget" | "stalled" | null =>
    session.operations >= budgetOps
      ? "operations"
      : performance.now() - started >= options.budgetMs
        ? "budget"
        : !replaying && session.operations - progressAt >= window()
          ? "stalled"
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
  // Until stalled, the stall window starts after the corpus: its replay comes before any directed target is watched.
  if (replayed !== null) progressAt = session.operations;
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
    // Until stalled, a quarter of the stall window, so that directed search looks again before the run stops.
    const due = untilStalled
      ? session.operations - analyzedOps >= window() / 4
      : options.budgetOps === undefined
        ? performance.now() - analyzedAt >= options.budgetMs / 10
        : session.operations - analyzedOps >= options.budgetOps / 10;
    if (sinceAnalysis >= ANALYZE_EVERY || due) {
      sinceAnalysis = 0;
      analyzedAt = performance.now();
      analyzedOps = session.operations;
      if (phased) markDepths();
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
      repeatAttempts.length > 0
        ? repeatAttempts
        : playAttempts.length > 0
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
    // With depth phases, the states with a lead first, then those after a chosen outcome in their turn, then the depth
    // chosen; a depth whose open states reached no new code starts a next session first when it can.
    let turn: { depth: number; exploring: boolean } | null = null;
    let picked: number | undefined;
    if (depthFrontier !== null) {
      if (depthFrontier.leads > 0) picked = depthFrontier.popLead();
      else if (depthFrontier.chosen > 0 && withinChosenShare()) picked = depthFrontier.popChosen();
      else {
        turn = chooseDepth();
        if (turn === null) {
          if (depthFrontier.chosen > 0) picked = depthFrontier.popChosen();
          else if (analyze()) continue;
          else break;
        } else if (
          depthFrontier.freshOf(turn.depth) === 0 &&
          (pendingSeeds[turn.depth] ?? 0) > 0 &&
          startSeed(turn.depth, turn.exploring, depthFrontier.sizeOf(turn.depth) > 0)
        )
          continue;
        else if (depthFrontier.sizeOf(turn.depth) === 0) continue;
        else picked = depthFrontier.popDepth(turn.depth);
      }
    } else if (frontier.size === 0) {
      if (analyze()) continue;
      break;
    } else picked = frontier.pop();
    const node = nodes[picked!]!;
    if (node.status !== "open") continue;
    // With depth phases, a state whose lead was spent goes back to its depth.
    if (depthFrontier !== null && turn === null && !node.chosen && !leads(node)) {
      frontier.push(node.id, order(node));
      continue;
    }
    // A lead that was spent, or whose target was reached, gives its states back their own place.
    if (depthFrontier === null && node.lead !== null && !leads(node) && frontier.size > 0) {
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
    const workBefore = session.operations;
    const gainBefore = gainCount;
    // The state's runtime session stays as it is: each input is tried in a fork of it, the last one in it.
    const tagged = store.getTagged(node.id);
    const base = tagged === null ? replayTo(node) : restore(node, tagged);
    // The stored snapshot read only where it is needed.
    let read: Data | null | undefined;
    const storedSnapshot = () => (read ??= tagged === null ? null : parseSnapshot(tagged.json));
    if (base === null) {
      node.status = "expanded";
      continue;
    }
    const inputs = session.options(
      base,
      base.view(),
      () => storedSnapshot() ?? base.exportTrustedSnapshot(),
    );
    // With forward time, a state that waits where a clock condition is read next can also continue later.
    if (times !== null && clockAfter.has(clockKey(node.waitsAt)))
      for (const gap of timeSteps(
        storedSnapshot() ?? base.exportTrustedSnapshot(),
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
    sinceProgress.set(node.waitsAt, (sinceProgress.get(node.waitsAt) ?? 0) + 1);
    let productive = false;
    node.status = "partial";
    const closeness =
      distanceTargets.length === 0
        ? []
        : distances(storedSnapshot() ?? base.exportTrustedSnapshot());
    // A state after a chosen random outcome goes back to its queue when its share is spent, to go on later with the
    // inputs it has not tried.
    let ran = 0;
    let cut = false;
    for (const [index, input] of inputs.entries()) {
      const stop = spent();
      if (stop !== null) {
        stoppedBy = stop;
        if (turn !== null && !leading)
          charge(
            turn.depth,
            session.operations - workBefore,
            gainCount - gainBefore,
            turn.exploring,
          );
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
      const child = transition(node, input, next, node.start, lead);
      if (lastStepNew || closer >= 0 || guided) {
        if (!productive) at.productive += 1;
        productive = true;
        at.inputs.add(inputKey(input));
      }
      if (options.followChains === true && next.forced && !node.chosen && child.status === "open")
        followWaits(child, next);
    }
    if (turn !== null && !leading)
      charge(turn.depth, session.operations - workBefore, gainCount - gainBefore, turn.exploring);
    if (cells !== null && !node.chosen) {
      cells.work[node.cell]! += session.operations - workBefore;
      if (productive) cells.productive[node.cell]! += 1;
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

  storageMaps.clear();
  /**
   * A route as its first inputs read and where its session ended, and how many inputs its replay takes; once per route,
   * as targets share them.
   */
  const described = new Map<number, { at: string; inputs: number }>();
  const routeOf = (node: number): { at: string; inputs: number } => {
    const known = described.get(node);
    if (known !== undefined) return known;
    const path = pathTo(nodes, nodes[node]!);
    const label = (input: ExplorerInput): string =>
      input.kind === "option" || input.kind === "button"
        ? input.label
        : input.kind === "text"
          ? `"${input.text}"`
          : input.kind;
    const at = nodes[node]!.waitsAt;
    const span = at === null ? null : compactSpan(instructions[at]?.span);
    const end =
      at === null ? "the session's end" : `${files[at]}${span === null ? "" : `:${span.line}`}`;
    const route = {
      at: `${path.length === 0 ? "no input" : path.slice(0, 3).map(label).join(" → ")}${path.length > 3 ? " → …" : ""} to ${end}`,
      inputs: Math.min(path.length, MAX_ROUTE_INPUTS),
    };
    described.set(node, route);
    return route;
  };
  const coverage = lineCoverage(
    plan,
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
    watched,
    routeOf,
    session.randomChoices,
    (subject) => (times === null ? null : exactPart(subject, times)),
  );
  // Until stalled: a stall in which one place took most expansions since the last progress is a spiral.
  let audit: Audit | undefined;
  if (untilStalled) {
    const since = [...sinceProgress.values()].reduce((sum, expansions) => sum + expansions, 0);
    const [spot, most] = [...sinceProgress].sort((left, right) => right[1] - left[1])[0] ?? [
      null,
      0,
    ];
    const share = since === 0 ? 0 : most / since;
    const spiral = stoppedBy === "stalled" && since >= ANALYZE_EVERY && share >= SPIRAL_SHARE;
    const span = spot === null ? null : compactSpan(instructions[spot]?.span);
    audit = {
      result:
        stoppedBy === "stalled"
          ? spiral
            ? "spiral"
            : "stalled"
          : stoppedBy === "exhausted"
            ? (coverage.reach.unknown ?? 0) === 0 &&
              coverage.unvisitedBranches.every((branch) => branch.reach !== "unknown")
              ? "complete"
              : "stalled"
            : "capped",
      window: window(),
      lastProgressAt: progressAt,
      longestGap: Math.max(longestGap, session.operations - progressAt),
      progress: { ...progress },
      ...(spiral
        ? {
            spiral: {
              location:
                spot === null
                  ? "(nothing in the foreground)"
                  : `${files[spot]}${span === null ? "" : `:${span.line}`}`,
              prompt: expansionsAt.get(spot)?.prompt ?? "",
              share: Math.round(share * 1000) / 10,
            },
          }
        : {}),
    };
  }
  const count = (status: NodeStatus) => nodes.filter((node) => node.status === status).length;
  const sessionCount = Math.max(0, ...starts.map((start) => start.session));
  working(depthNow);
  const bySessionNumber = <T>(value: (depth: number) => T): T[] =>
    Array.from({ length: sessionCount }, (_, index) => value(index + 1));
  const bySession = {
    started: bySessionNumber(() => 0),
    completed: bySessionNumber(() => 0),
    operations: bySessionNumber((depth) => depthWork[depth] ?? 0),
    linesFirst: bySessionNumber(() => 0),
    linesFirstLastQuarter: bySessionNumber(() => 0),
    waysFirst: bySessionNumber((depth) => depthWays[depth] ?? 0),
    closer: bySessionNumber((depth) => depthCloser[depth] ?? 0),
  };
  for (const start of starts) bySession.started[start.session - 1]! += 1;
  for (const node of nodes)
    if (node.status === "completed") bySession.completed[starts[node.start]!.session - 1]! += 1;
  // Lines by the sessions that ran them: the one that reached each first (in the last quarter of its work or before),
  // and per file, those only the first session ran and those it never ran, by the smallest session that did.
  const linesBySession = {
    onlyFirst: 0,
    least: bySessionNumber(() => 0),
    files: new Map<string, { onlyFirst: number; notFirst: number }>(),
  };
  lineFirst.forEach((depth, line) => {
    if (depth === 0) return;
    bySession.linesFirst[depth - 1]! += 1;
    if (lineFirstWork[line]! * 4 >= (depthWork[depth] ?? 0) * 3)
      bySession.linesFirstLastQuarter[depth - 1]! += 1;
    const least = lineLeast[line]!;
    linesBySession.least[least - 1]! += 1;
    const onlyFirst = least === 1 && lineLater[line] === 0;
    if (onlyFirst) linesBySession.onlyFirst += 1;
    if (!onlyFirst && least === 1) return;
    const file = lineFiles[line]!;
    const counts = linesBySession.files.get(file) ?? { onlyFirst: 0, notFirst: 0 };
    if (onlyFirst) counts.onlyFirst += 1;
    else counts.notFirst += 1;
    linesBySession.files.set(file, counts);
  });
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
    routeOf,
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
      ...(audit === undefined ? {} : { audit }),
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
      ...(phased
        ? {
            phases: {
              openedAt: bySessionNumber((depth) => openedAt[depth] ?? null),
              playOperations: bySessionNumber((depth) => depths[depth]?.work ?? 0),
              playGain: bySessionNumber((depth) => depths[depth]?.gain ?? 0),
              nextSessions: bySessionNumber((depth) => depths[depth]?.seeds ?? 0),
              explorationOperations: explorationWork,
            },
          }
        : {}),
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
    coverage: {
      ...coverage,
      bySession: {
        onlyFirst: linesBySession.onlyFirst,
        least: linesBySession.least,
        files: [...linesBySession.files]
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([path, counts]) => ({ path, ...counts })),
      },
    },
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
function corpusItems(
  instructions: readonly Data[],
  files: readonly string[],
  sources: ReadonlyMap<string, string>,
) {
  const ids = new Map<string, number>();
  const lineIds = Int32Array.from(instructions, (instruction, index) => {
    const line = coverableLine(instruction, files[index]!, sources);
    if (line === null) return -1;
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

/**
 * The values of a storage by key, made once per analysis pass, in which many chains and guards measure the same
 * storages; kept no longer, or the storages a run keeps would hold all their values twice.
 */
const storageMaps = new Map<readonly StorageEntry[], ReadonlyMap<string, unknown>>();
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

/**
 * What keeps directed search from a way, as one note. A stored value the condition itself needs that an explored
 * session left says so, whatever keys that value was copied from before; otherwise a note of the condition's own goals,
 * and only without one a note of its `else if` chain's, each a goal with progress before one no session stored.
 */
export function noteOf(
  target:
    | {
        readonly goals: readonly Goal[];
        readonly guards: readonly { readonly goals: readonly Goal[] }[];
        readonly chains: ReadonlyMap<
          string,
          { readonly best: number; readonly closest: { readonly distance: number } | null }
        >;
        readonly notes: ReadonlyMap<Goal, string>;
      }
    | undefined,
): string | undefined {
  if (target === undefined) return undefined;
  const guarded = new Set(target.guards.flatMap((guard) => guard.goals));
  const own = target.goals.filter((goal) => !guarded.has(goal));
  for (const goal of own) {
    if (goal.source.kind !== "storage") continue;
    const chain = target.chains.get(goal.source.key);
    if (chain !== undefined && (chain.best === 0 || chain.closest?.distance === 0))
      return `needs ${describeNeed(goal.source.key, goal)}; a session from storage that has it did not reach the condition`;
  }
  // The condition's own notes, if any, before its chain's; within each, one with progress first.
  const pick = (goals: readonly Goal[]) => {
    const noted = goals
      .map((goal) => target.notes.get(goal))
      .filter((note): note is string => note !== undefined);
    return noted.find((note) => !note.endsWith("no explored session stored it")) ?? noted[0];
  };
  return pick(own) ?? pick(target.goals.filter((goal) => guarded.has(goal)));
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

/**
 * The line an instruction counts on in line coverage, or null for none. The compiler's own `end` of a file, on a line
 * with no source text after the last statement, is no line of the script: a script that ends with `goto` or `exit`
 * never reaches it, which is no code that can never run.
 */
function coverableLine(
  instruction: Data,
  path: string,
  sources: ReadonlyMap<string, string>,
): number | null {
  const line = compactSpan(instruction.span)?.line ?? null;
  const source = sources.get(path);
  // Without the file's text, an `end` the author wrote cannot be told apart: it counts.
  if (line === null || instruction.kind !== "end" || source === undefined) return line;
  const text = source.split("\n")[line - 1];
  return text === undefined || text.trim() === "" ? null : line;
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
  plan: Data,
  instructions: readonly Data[],
  files: readonly string[],
  session: Session,
  sources: ReadonlyMap<string, string>,
  unreachable: { readonly fromStart: Uint8Array; readonly withStorage: Uint8Array },
  constants: ReadonlyMap<number, boolean>,
  fixed: ReadonlyMap<number, { value: boolean; reason: string }>,
  targets: ReadonlyMap<number, Target>,
  watched: ReadonlyMap<string, readonly Watch[]>,
  routeOf: (node: number) => { at: string; inputs: number },
  randomChoices: boolean,
  clockPartOf: (subject: unknown) => string | null,
): Omit<ExploreResult["coverage"], "bySession"> {
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
  const lineOf = instructions.map((instruction, index) =>
    coverableLine(instruction, files[index]!, sources),
  );
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
  // Code behind a missed way: what it leads to through code no state ran. A call goes into the function and on after
  // it; a return, an end, or a transfer to a computed destination stops the walk, so it stays in the code that way
  // opens.
  const ran = (index: number) =>
    session.visited[index] === 1 ||
    session.chosenVisited[index] === 1 ||
    session.clockVisited[index] === 1;
  const next = successors(plan, instructions, constants);
  instructions.forEach((instruction, index) => {
    if (instruction.kind === "callFunction")
      next[index] = [...next[index]!, Number(instruction.returnInstruction)];
    else if (
      instruction.kind === "returnValue" ||
      instruction.kind === "returnVoid" ||
      instruction.kind === "end"
    )
      next[index] = [];
    else if (instruction.kind === "transfer" && "value" in record(instruction.destination))
      next[index] = [];
  });
  const behind = (from: number): Set<string> => {
    const found = new Set<string>();
    if (from < 0 || from >= instructions.length || ran(from)) return found;
    const seen = new Set([from]);
    const queue = [from];
    for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
      const line = lineOf[at];
      const label = line == null ? undefined : lines.get(files[at]!)?.get(line)?.reach;
      if (label !== undefined && label !== "play" && label !== "chosen")
        found.add(`${files[at]}:${line}`);
      for (const to of next[at] ?? [])
        if (to >= 0 && to < instructions.length && !ran(to) && !seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
    }
    return found;
  };
  /**
   * A condition the script wrote as a `switch` case: its form, and what the switch compares, from where the switch
   * stored it, the nearest store of its temporary before the case (with its text, and the part of the clock it is).
   */
  const caseAt = (index: number, condition: unknown): Partial<UnvisitedBranch> => {
    const form = caseForm(condition);
    const span = compactSpan(record(condition).span);
    const source = sources.get(files[index]!);
    if (form === null || span === null || source === undefined) return {};
    if (!/\bcase\s*$/u.test(source.slice(Math.max(0, span.start - 40), span.start))) return {};
    for (let at = index - 1; at >= 0; at -= 1) {
      const stored = instructions[at]!;
      if (stored.kind !== "storeTemporary" || stored.temporaryId !== form.temporary) continue;
      const subject = compactSpan(record(stored.value).span);
      const part = clockPartOf(stored.value);
      return {
        case: form.kind,
        ...(subject === null || files[at] !== files[index]
          ? {}
          : { subject: short(source.slice(subject.start, subject.end)) }),
        ...(part === null ? {} : { clockPart: part }),
      };
    }
    return { case: form.kind };
  };
  /** The lines behind each missed way, by its place in `unvisitedBranches`. */
  const regions: Set<string>[] = [];
  const watchOf = new Map<Goal, Watch>();
  for (const watches of watched.values())
    for (const entry of watches) watchOf.set(entry.goal, entry);
  const sourceText = (source: Goal["source"]): string =>
    source.kind === "ask"
      ? `ask at ${files[source.instruction]}:${lineOf[source.instruction] ?? 0}`
      : source.kind === "storage"
        ? `stored ${shownKey(source.key)}`
        : source.kind === "clock"
          ? "the clock"
          : source.name;
  const shownKey = (key: string) => key.replaceAll(KEY_PLACEHOLDER, "*");
  const partsOf = (target: Target | undefined): Part[] => {
    if (target === undefined) return [];
    const earlier = new Set(target.guards.flatMap((guard) => guard.goals));
    const parts = new Map<string, Part>();
    for (const goal of target.goals) {
      const { source, comparison } = goal;
      const compared =
        comparison === null
          ? ""
          : `${comparison.against === undefined ? "" : ` - ${comparison.against.text}`} ${comparison.operator} ${String(comparison.shown)}`;
      const needs =
        source.kind === "variable"
          ? `${source.name}${compared}`
          : source.kind === "storage"
            ? `stored ${shownKey(source.key)}${compared}`
            : source.kind === "ask"
              ? `answer at ${files[source.instruction]}:${lineOf[source.instruction] ?? 0}`
              : "the clock";
      const of = earlier.has(goal) ? "earlier condition" : "condition";
      let closest: Closest | undefined;
      const watch = watchOf.get(goal)?.closest;
      const chain = source.kind === "storage" ? target.chains.get(source.key) : undefined;
      if (watch != null)
        closest = {
          needs,
          value: watch.value,
          distance: watch.distance,
          session: watch.session,
          atOperations: watch.operations,
          trend:
            watch.closer && watch.operations * 4 > session.operations * 3 ? "improving" : "flat",
        };
      // A stored value measures a part only as the constant's type: a timestamp is no distance from `true`.
      else if (
        chain !== undefined &&
        Number.isFinite(chain.best) &&
        (typeof comparison?.shown !== "boolean" || /= (true|false)$/u.test(chain.value))
      )
        closest = { needs, value: chain.value, distance: chain.best, session: chain.sessions };
      const status =
        closest === undefined ? "unmeasured" : closest.distance === 0 ? "met" : "unmet";
      // One part per text: an atom read from two places of the same source is one part.
      const known = parts.get(`${of} ${needs}`);
      if (known === undefined || (known.status === "unmeasured" && status !== "unmeasured"))
        parts.set(`${of} ${needs}`, {
          needs,
          of,
          status,
          ...(closest === undefined ? {} : { closest }),
        });
    }
    return [...parts.values()];
  };
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
          ? noteOf(directed)
          : undefined;
    const reached = directed?.reach;
    const parts = partsOf(directed);
    const chains = chainReports(directed, routeOf);
    // What keeps the way closed, as far as measured: of the condition's own unmet parts, the furthest from holding when
    // the way needs all of them, the nearest when any one would do; none when they combine both ways.
    const combined = combination(condition, way === 0);
    const unmet = parts
      .filter(
        (part) => part.of === "condition" && part.status === "unmet" && part.closest !== undefined,
      )
      .sort((left, right) => left.closest!.distance - right.closest!.distance);
    const best =
      combined === "mixed" ? undefined : (combined === "any" ? unmet[0] : unmet.at(-1))?.closest;
    unvisitedBranches.push({
      instruction: index,
      kind: instruction.kind === "jumpIfFalse" ? "if" : "loop",
      path: files[index]!,
      line: lineOf[index] ?? 0,
      condition: conditionText(instruction, files[index]!, sources),
      missed: wayName(instruction, way),
      ...(instruction.kind === "jumpIfFalse" ? caseAt(index, condition) : {}),
      targetInstruction: missedTarget ? target : index + 1,
      targetLine: lineOf[firstStatement(instructions, missedTarget ? target : index + 1)] ?? null,
      reach: label,
      ...(reason === undefined ? {} : { reason }),
      sources: directed === undefined ? [] : sourceKinds(directed.goals),
      attempts: directed?.attempts ?? 0,
      dependsOn: [...new Set((directed?.goals ?? []).map((goal) => sourceText(goal.source)))],
      behindLines: (regions[unvisitedBranches.length] = behind(missedTarget ? target : index + 1))
        .size,
      ownLines: 0,
      parts,
      ...(best === undefined ? {} : { best }),
      ...(chains.length === 0 ? {} : { chains }),
      ...(label === "clock" && reached != null ? { repro: reached.repro } : {}),
    });
  });
  // Each line no state reached once, under the missed way with the most lines behind it (the first found of equal
  // ones), play's ways first.
  const counted = new Set<string>();
  const never = (index: number) => (unvisitedBranches[index]!.reach === "unreachable" ? 1 : 0);
  [...unvisitedBranches.keys()]
    .sort(
      (left, right) =>
        never(left) - never(right) || regions[right]!.size - regions[left]!.size || left - right,
    )
    .forEach((index) => {
      let own = 0;
      for (const line of regions[index]!) {
        const split = line.lastIndexOf(":");
        if (
          counted.has(line) ||
          lines.get(line.slice(0, split))?.get(Number(line.slice(split + 1)))?.reach !== "unknown"
        )
          continue;
        counted.add(line);
        own += 1;
      }
      unvisitedBranches[index]!.ownLines = own;
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
  routeOf: (node: number) => { at: string; inputs: number },
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
    const chains = chainReports(target, routeOf);
    ways.push({
      path,
      line: compactSpan(instruction.span)?.line ?? 0,
      condition: conditionText(instruction, path, sources)?.text ?? "",
      way: wayName(instruction, target.way),
      reach: target.reach.label,
      via: target.reach.via,
      sources: kinds,
      sessions,
      ...(chains.length === 0 ? {} : { chains }),
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
