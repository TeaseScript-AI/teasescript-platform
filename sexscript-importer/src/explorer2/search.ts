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
import { successors } from "../explorer-analysis.ts";
import { instructionFiles } from "../explorer-search.ts";
import {
  EPOCH_MS,
  type Data,
  type Engine,
  type ExplorerInput,
  type StorageEntry,
} from "../explorer.ts";
import {
  CLOCK,
  Runner,
  sameInput,
  type Decision,
  type DrawEvent,
  type Origin,
  type Path,
  type Played,
  type Resume,
  type Runtime2,
} from "./runner.ts";
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
  /** Candidate assignments tried for one target, at most (each one cut is counted). */
  readonly maxCandidates: number;
  /** Paths a decision way is targeted from before it counts as unsolved. */
  readonly maxAttempts: number;
  /** The heap in use at which the search stops. */
  readonly maxHeapBytes?: number;
  readonly sources: ReadonlyMap<string, string>;
}

export const DEFAULT_OPTIONS: Omit<Explore2Options, "seed" | "sources"> = {
  budgetMs: 60_000,
  maxSteps: 300,
  extendSteps: 40,
  // The Player's instruction budget per run (the runtime's default).
  maxStepInstructions: 1_000_000,
  maxCandidates: 4096,
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
}

/** Steps past its own inputs a play goes on without new code before it stops. */
const PATIENCE = 12;

/** The share of the work each kind gets at least while it has work. */
const MIN_SHARE = 0.1;
/** The weight of the latest piece of work in a kind's moving average of new instructions per unit of work. */
const RATE_WEIGHT = 0.1;

/** Plays of single changes an unsolved short-circuit condition gets, at most (see `solve`). */
const PROGRESS_PLAYS = 4;
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

/** Children waiting in one queue, at most: each keeps its parent's path and resume points. */
const MAX_QUEUE = 20_000;
/** Combinations of form fields one form answer's domain holds, at most (each one cut is counted). */
const MAX_CANDIDATES = 4096;
/** Candidates a target tries first; each time it runs out, it comes back with this many times more. */
const FIRST_BUDGET = 64;
const BUDGET_GROWTH = 8;
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
/** Storage states kept for later visits, at most (each one past it is counted). */
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

export interface Explore2Result {
  readonly search: {
    readonly stoppedBy: "exhausted" | "budget" | "memory";
    readonly audit: { readonly result: "complete" | "incomplete" | "capped" };
    readonly states: number;
    readonly operations: number;
    readonly elapsedMs: number;
    readonly plays: number;
    readonly checks: number;
    readonly solved: number;
    /** Attempts that found no way, by reason (an attempt's way may still be taken later). */
    readonly unsolved: Readonly<Record<string, number>>;
    /** Ways V2 tried to take that no path took. */
    readonly openWays: number;
    readonly candidatesCut: number;
    readonly queueCut: number;
    readonly savedCut: number;
    readonly stepsCut: number;
  };
  readonly coverage: {
    readonly coverableLines: number;
    readonly visitedLines: number;
    readonly percent: number;
    readonly files: readonly {
      path: string;
      coverableLines: number;
      visitedLines: number;
      percent: number;
      unvisited: readonly { lines: string; reach: "unknown" }[];
    }[];
    readonly unvisitedBranches: readonly never[];
  };
  readonly crashes: readonly {
    code: string;
    message: string;
    path: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    inputs: readonly ExplorerInput[];
    draws: readonly { occurrence: number; outcome: Data }[];
    /** The storage its session started with, for a later visit, and its start wall clock, when not the usual. */
    storage?: readonly StorageEntry[];
    wallClockMs?: number;
  }[];
  /** Loops with no way out that V2 found (see `traps.ts`). */
  readonly traps: readonly Trap[];
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
  const crashes = new Map<string, Explore2Result["crashes"][number]>();
  let plays = 0;
  let checks = 0;
  let solved = 0;
  let candidatesCut = 0;
  const places = new Places();
  /** The resume points children keep, by play, oldest first. */
  const resumeLists: Resume[][] = [];
  let resumesKept = 0;
  /** Answers plays gave, by `instruction|answer|state` (`answered` also has those queued). */
  const givenAnswers = new Set<string>();
  /** Children not queued because their queue was full. */
  let queueCut = 0;
  /** Plays the run's step cap stopped. */
  let stepsCut = 0;
  /** Storage states plays went through, by their JSON text: where later visits start. */
  const saved = new Map<string, readonly StorageEntry[]>();
  let savedCut = 0;
  const debugCheck = { ms: 0, instructions: 0, steps: 0 };
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
    child.target !== null
      ? gain(child.target.instruction, 1 - child.target.way) / (child.budget / FIRST_BUDGET)
      : child.place >= 0
        ? answerScore(child.place, child.answer, child.path.inputs.length - 1)
        : child.score;

  /**
   * The instructions no path ran that a way leads to, up to where it meets code that ran, within its function and the
   * functions it calls: not on through returns and file ends, which lead back to every caller.
   */
  const gain = (instruction: number, way: number): number => {
    const target = way === 0 ? instruction + 1 : Number(instructions[instruction]?.target);
    if (!Number.isInteger(target) || visited[target] === 1) return 0;
    const seen = new Set([target]);
    const stack = [target];
    while (stack.length > 0 && seen.size < 10_000) {
      const at = stack.pop()!;
      if (LEAVES.has(String(instructions[at]?.kind))) continue;
      for (const following of next[at] ?? [])
        if (visited[following] !== 1 && !seen.has(following)) {
          seen.add(following);
          stack.push(following);
        }
    }
    return seen.size;
  };

  /** Traced replays of plays, by play, with the step each goes up to: the latest ones (see {@link MAX_TRACED}). */
  const traced = new Map<Played, { readonly upTo: number; readonly replay: Played }>();
  /** `played` again with origins, the same inputs and draw outcomes, up to (and with the decisions of) `step`. */
  const tracedUpTo = (played: Played, step: number): Played => {
    const known = traced.get(played);
    if (known !== undefined && known.upTo >= step) return known.replay;
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
    traced.delete(played);
    traced.set(played, { upTo: step, replay });
    if (traced.size > MAX_TRACED) traced.delete(traced.keys().next().value!);
    return replay;
  };

  /** Goes on after a path's own inputs as its parent did where it can, else with the first answer offered. */
  const goOn =
    (parent: Played | null) => (interaction: Played["interactions"][number], step: number) => {
      const before = parent?.inputs[step];
      if (before !== undefined && interaction.options.some((option) => sameInput(option, before)))
        return before;
      return (
        interaction.options.find((option) => option.kind !== "wait") ??
        interaction.options[0] ??
        null
      );
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
    places.add(played, (instruction) => runner.readsClock(instruction));
    for (const storage of played.storages) {
      const text = JSON.stringify(storage);
      if (saved.has(text)) continue;
      if (saved.size >= MAX_SAVED) {
        savedCut += 1;
        continue;
      }
      saved.set(text, storage);
      // A later visit from it, unless one from a state with the same values of the keys conditions read is queued.
      const key = JSON.stringify(storage.filter((entry) => runner.readKeys.has(entry.key)));
      if (visitKeys.has(key)) continue;
      if (visitsQueue.size >= MAX_QUEUE) {
        queueCut += 1;
        continue;
      }
      visitKeys.add(key);
      // The player comes back the next day.
      visitsQueue.push({
        path: {
          inputs: [],
          draws: new Map(),
          inherited: [],
          storage,
          wallClockMs: (played.path.wallClockMs ?? EPOCH_MS) + DAY_MS,
        },
        score: -visitKeys.size,
        target: null,
        parent: null,
        budget: 0,
        tried: 0,
        place: -1,
        answer: "",
      });
    }
    let found = 0;
    for (const index of played.visited)
      if (visited[index] !== 1) {
        visited[index] = 1;
        found += 1;
      }
    for (const decision of played.decisions) ways.add(decision.instruction * 2 + decision.way);
    if (played.end === "failed" && played.failure !== null) {
      const failure = played.failure;
      const key = `${failure.code}@${failure.path}:${failure.line}`;
      const known = crashes.get(key);
      if (known === undefined || known.inputs.length > played.inputs.length)
        crashes.set(key, {
          ...failure,
          inputs: played.inputs,
          // The outcomes the play had (fixed by its path, inherited, or by site): they replay it.
          draws: played.draws.map((draw) => ({
            occurrence: draw.occurrence,
            outcome: draw.outcome,
          })),
          ...startOf(played.path),
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
    for (const step of answerSteps) {
      const resume = played.resumes[step];
      if (resume === undefined) continue;
      resumes[step] = resume;
      resumesKept += resume.tagged.json.length;
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
      captures: [],
    };
    const replay = traced.get(played);
    if (replay !== undefined) traced.set(kept, replay);
    recent.push(kept);
    if (recent.length > 64) recent.splice(0, recent.length - 64);
    // Only the latest plays keep their resume points; a child of an older one plays from the start.
    resumeLists.push(resumes);
    while (resumesKept > MAX_RESUME_TEXT && resumeLists.length > 1) {
      const oldest = resumeLists.shift()!;
      for (const resume of oldest)
        if (resume !== undefined) resumesKept -= resume.tagged.json.length;
      oldest.length = 0;
    }
    // Decisions whose other way no path took: a child each, by the code that way leads to.
    for (const decision of played.decisions) {
      if (decision.step <= shared) continue;
      const other = decision.instruction * 2 + (1 - decision.way);
      if (ways.has(other)) continue;
      const count = queued.get(other) ?? 0;
      if (count >= options.maxAttempts * 2) continue;
      if (decisionsQueue.size >= MAX_QUEUE) {
        queueCut += 1;
        continue;
      }
      queued.set(other, count + 1);
      decisionsQueue.push({
        path: played.path,
        score: gain(decision.instruction, 1 - decision.way),
        target: decision,
        parent: kept,
        budget: FIRST_BUDGET,
        tried: 0,
        place: -1,
        answer: "",
      });
    }
    // Answers not given at an interaction in its relevant state: a child each.
    played.interactions.forEach((interaction, step) => {
      if (!answers(step)) return;
      const given = played.inputs[step];
      for (const option of interaction.options) {
        if (given !== undefined && sameInput(option, given)) continue;
        const key = `${interaction.instruction}|${JSON.stringify(option)}|${interaction.state}`;
        if (answered.has(key)) continue;
        if (answersQueue.size >= MAX_QUEUE) {
          queueCut += 1;
          continue;
        }
        answered.add(key);
        // Interactions answered otherwise least often first, and of those, earlier steps first.
        answersQueue.push({
          path: {
            inputs: [...played.inputs.slice(0, step), option],
            draws: played.path.draws,
            inherited: played.draws,
            ...startOf(played.path),
          },
          score: answerScore(interaction.instruction, answerKey(option), step),
          target: null,
          parent: kept,
          budget: 0,
          tried: 0,
          place: interaction.instruction,
          answer: answerKey(option),
        });
      }
    });
    for (const photo of photos) {
      if (answersQueue.size >= MAX_QUEUE) {
        queueCut += 1;
        continue;
      }
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
    return { found, kept, played };
  };

  /**
   * A path that takes `target`'s other way, found by trying the origins its condition and linked decisions read: first
   * those it read as data, then also those of the decisions its values were written under.
   */
  /** Attempts per way from progress plays, which do not count against `maxAttempts`. */
  const progressAttempts = new Map<number, number>();
  /** Plays an unsolved target's last solve found worth playing (see `solve`). */
  let progress: { path: Path; from: number }[] = [];
  const solve = (
    parent: Played,
    target: Decision,
    budget: number,
    skip: number,
    guide: Played,
  ): { path: Path; from: number } | "more" | null => {
    let reason = "noOrigin";
    let before: Set<Origin> | null = null;
    progress = [];
    const shortCircuit = shortCircuits(instructions[target.instruction]);
    // Candidates so far, over both kinds of origins: the budget counts them all.
    let index = 0;
    phases: for (const control of [false, true]) {
      const of = (decision: Decision) => (control ? decision.origins : decision.dataOrigins);
      // The dependency-closed prefix: earlier decisions linked to the target through shared origins, and the form fields
      // every one of them reads.
      const origins = new Set<Origin>(of(target));
      const linked = new Set<Decision>([target]);
      for (let grown = true; grown;) {
        grown = false;
        for (const decision of parent.decisions) {
          if (decision.order >= target.order) break;
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
      if (before !== null && origins.size === before.size) break;
      before = origins;
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
        );
        if (values === null) {
          reason = origin.startsWith("k") ? "stored" : "unknownDomain";
          continue;
        }
        if (values.length > 0) domains.push({ origin, values });
      }
      if (domains.length === 0) continue;
      reason = "noCandidate";
      // The fewest origins changed first: one at a time, then pairs, and so on.
      for (let changed = 1; changed <= domains.length; changed += 1) {
        for (const assignment of assignments(domains, changed)) {
          if (index >= budget) {
            if (process.env.SX_V2_DEBUG)
              process.stderr.write(
                `more ${target.instruction}:${1 - target.way} step ${target.step} budget ${budget} domains ${domains.map((domain) => `${domain.origin}=${domain.values.length}`).join(",")}\n`,
              );
            if (budget < options.maxCandidates) return "more";
            candidatesCut += 1;
            reason = "candidates";
            break phases;
          }
          index += 1;
          if (index <= skip) continue;
          if (outOfTime()) return null;
          const candidate = apply(parent, assignment, saved, target.step);
          if (candidate === null) continue;
          checks += 1;
          // Replay from the last interaction before the first origin it changes.
          // A later visit starts a session of its own.
          const from =
            candidate.storage !== parent.path.storage ||
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
                );
          // The candidate counts when its play takes the other way anywhere, there or later: what matters is the code
          // behind that way, not that very occurrence.
          // An input the candidate inserts (continuing later) moves the target's step on by one.
          const grown = Math.max(0, candidate.inputs.length - parent.inputs.length);
          const shortened = {
            ...candidate,
            inputs: candidate.inputs.slice(0, target.step + grown),
          };
          const checkStarted = performance.now();
          const turned = (decision: Decision) =>
            decision.instruction === target.instruction && decision.way !== target.way;
          const check = runner.play(shortened, {
            extend: goOn(guide),
            maxSteps: Math.min(options.maxSteps, target.step + grown + CHECK_STEPS),
            maxStepInstructions: options.maxStepInstructions,
            origins: false,
            until: turned,
            ...(from >= 0 && parent.resumes[from] !== undefined
              ? { resume: { at: from, parent } }
              : {}),
          });
          debugCheck.ms += performance.now() - checkStarted;
          debugCheck.instructions += check.instructions;
          debugCheck.steps += check.inputs.length - Math.max(0, from);
          if (check.decisions.some(turned)) return { path: shortened, from };
          // `a and b` reads `b` only once `a` holds: a single change of what the condition read that did not turn it may
          // still make it read more, which a play of it shows.
          if (
            shortCircuit &&
            changed === 1 &&
            progress.length < PROGRESS_PLAYS &&
            [...assignment.keys()].every((origin) => of(target).has(origin))
          )
            progress.push({ path: shortened, from });
        }
      }
    }
    unsolved[reason] = (unsolved[reason] ?? 0) + 1;
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
  // The work each kind did so far (in the runner's units: see `Runner.work`), and the new instructions per unit it found
  // lately (a moving average): the kind that finds most goes next, except that each kind gets a share while it has work.
  const spent = { decisions: 0, answers: 0, visits: 0, walks: 0 };
  const rate = { decisions: Infinity, answers: Infinity, visits: Infinity, walks: Infinity };
  const charge = (kind: (typeof KINDS)[number], before: number, found: number) => {
    const work = Math.max(runner.work - before, 1);
    spent[kind] += work;
    rate[kind] =
      rate[kind] === Infinity
        ? found / work
        : (1 - RATE_WEIGHT) * rate[kind] + RATE_WEIGHT * (found / work);
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
    // Walks only fill in while targets remain, and the run ends when no target is left.
    if (
      least === undefined ||
      (decisionsQueue.size === 0 && answersQueue.size === 0 && visitsQueue.size === 0)
    )
      break;
    if (least === "walks") {
      const walkStarted = runner.work;
      // A random walk: from a random point of a recent path on, random answers and random draw outcomes.
      const base = recent[Math.floor(random() * recent.length)]!;
      const cut = Math.floor(random() * (base.inputs.length + 1));
      // It resumes from the last point before the cut the play kept, if any.
      let at = cut;
      while (at >= 0 && base.resumes[at] === undefined) at -= 1;
      const draws = new Map(
        [...base.path.draws].filter(([occurrence]) => (base.draws[occurrence]?.step ?? 0) <= cut),
      );
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
            return interaction.options[Math.floor(random() * interaction.options.length)] ?? null;
          },
          maxSteps: Math.min(options.maxSteps, cut + options.extendSteps),
          maxStepInstructions: options.maxStepInstructions,
          origins: false,
          random,
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
    const childStarted = runner.work;
    let path = child.path;
    let parent = child.parent;
    // An answer child goes on from where its answer differs; a decision child from where its first change is.
    let resumeAt = child.target === null ? child.path.inputs.length - 1 : -1;
    if (child.target !== null && child.parent !== null) {
      const target = child.target;
      const side = target.instruction * 2 + (1 - target.way);
      if (ways.has(side)) continue;
      const count = attempts.get(side) ?? 0;
      const extra = progressAttempts.get(side) ?? 0;
      if (child.progress === true ? extra >= MAX_PROGRESS_ATTEMPTS : count >= options.maxAttempts)
        continue;
      if (child.progress === true) progressAttempts.set(side, extra + 1);
      // The parent ran without a trace: its replay with origins, up to the target's step, is what the solver reads.
      parent = tracedUpTo(child.parent, target.step);
      const turned =
        parent.decisions.find(
          (decision) =>
            decision.instruction === target.instruction &&
            decision.way === target.way &&
            decision.step === target.step &&
            decision.origins.size > 0,
        ) ??
        parent.decisions.find(
          (decision) =>
            decision.instruction === target.instruction &&
            decision.way === target.way &&
            decision.step === target.step,
        );
      if (turned === undefined) {
        unsolved.lost = (unsolved.lost ?? 0) + 1;
        attempts.set(side, count + 1);
        charge(least, childStarted, 0);
        continue;
      }
      const found = solve(parent, turned, child.budget, child.tried, child.parent);
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
  if (process.env.SX_V2_DEBUG) {
    let answeredChars = 0;
    for (const key of answered) answeredChars += key.length;
    let savedChars = 0;
    for (const key of saved.keys()) savedChars += key.length;
    process.stderr.write(
      `sizes queues ${decisionsQueue.size}/${answersQueue.size}/${visitsQueue.size} answered ${answered.size} (${answeredChars} chars) given ${givenAnswers.size} saved ${saved.size} (${savedChars} chars) visitKeys ${visitKeys.size} traced ${traced.size} resumeLists ${resumeLists.length} heap ${Math.round(getHeapStatistics().used_heap_size / 1048576)} MB\n`,
    );
  }
  if (process.env.SX_V2_DEBUG)
    process.stderr.write(
      `spent ${JSON.stringify(spent)} checks ${JSON.stringify(debugCheck)} instructions ${runner.instructionsRun}\n`,
    );
  // Ways V2 tried to take and no path took in the end: what keeps a run that ran out of work from being complete.
  const open = [...attempts.keys()].filter((side) => !ways.has(side)).length;
  const coverage = lineCoverage(plan, instructions, visited, options.sources);
  const files = instructionFiles(plan);
  return {
    search: {
      stoppedBy,
      audit: {
        result:
          stoppedBy !== "exhausted"
            ? "capped"
            : open === 0 && queueCut === 0 && savedCut === 0 && stepsCut === 0
              ? "complete"
              : "incomplete",
      },
      states: plays + checks,
      operations: runner.instructionsRun,
      elapsedMs: Math.round(performance.now() - started),
      plays,
      checks,
      solved,
      unsolved,
      openWays: open,
      candidatesCut,
      queueCut,
      savedCut,
      stepsCut,
    },
    coverage,
    crashes: [...crashes.values()],
    traps: places.traps(givenAnswers, (index) => {
      const span = record(instructions[index]?.span);
      return `${files[index] ?? ""}:${typeof span.sl === "number" ? span.sl + 1 : 0}`;
    }),
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
    return values.size === 0 ? null : [...values].map((value) => ({ stored: key, value }));
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
        for (let value = min; value <= max; value += 1) values.push({ kind: "number", value });
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
    return interaction.options.map((option) => ({ input: option }));
  }
  return null;
}

/** Every assignment that changes exactly `count` of the origins, each to another of its values. */
function* assignments(
  domains: readonly { origin: Origin; values: readonly Value[] }[],
  count: number,
): Generator<Map<Origin, Value>> {
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

/** An answer as the place it is given at tells answers apart: what it does, whatever random outcomes it fixes. */
function answerKey(input: ExplorerInput): string {
  const { random: _random, ...answer } = input;
  return JSON.stringify(answer);
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
 * Stored values make it a later visit: a session of its own from the first saved state that holds them all, which goes
 * on as the parent did where it can: its inputs no longer line up with the parent's, and its draws keep the parent's
 * outcomes (or the solved ones) by site.
 */
function apply(
  parent: Played,
  assignment: ReadonlyMap<Origin, Value>,
  saved: ReadonlyMap<string, readonly StorageEntry[]>,
  targetStep: number,
): Path | null {
  const stored = [...assignment.values()].flatMap((value) => ("stored" in value ? [value] : []));
  if (stored.length > 0) {
    for (const storage of saved.values())
      if (stored.every((value) => storedText(storage, value.stored) === value.value)) {
        // The parent's draws by site, the solved ones changed.
        const siteDraws = new Map<string, DrawEvent[]>();
        for (const draw of parent.draws) {
          const value = assignment.get(`d${draw.occurrence}`);
          const outcome = value !== undefined && "draw" in value ? value.draw : draw.outcome;
          siteDraws.set(draw.site, [...(siteDraws.get(draw.site) ?? []), { ...draw, outcome }]);
        }
        const clock = [...assignment.values()].find((value) => "clock" in value);
        return {
          inputs: [],
          draws: new Map(),
          inherited: [],
          storage,
          siteDraws,
          ...(clock !== undefined && "clock" in clock ? { wallClockMs: clock.clock } : {}),
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

/** Line coverage as V1 counts it: a line counts when an instruction starts on it, and is visited when one of those ran. */
function lineCoverage(
  plan: Data,
  instructions: readonly Data[],
  visited: Uint8Array,
  sources: ReadonlyMap<string, string>,
): Explore2Result["coverage"] {
  const files = instructionFiles(plan);
  const lines = new Map<string, Map<number, boolean>>();
  instructions.forEach((instruction, index) => {
    const span = record(instruction.span);
    if (typeof span.sl !== "number") return;
    const line = span.sl + 1;
    const path = files[index]!;
    if (instruction.kind === "end") {
      const text = sources.get(path)?.split("\n")[line - 1];
      if (sources.has(path) && (text === undefined || text.trim() === "")) return;
    }
    const file = lines.get(path) ?? new Map<number, boolean>();
    file.set(line, (file.get(line) ?? false) || visited[index] === 1);
    lines.set(path, file);
  });
  const percent = (part: number, whole: number) =>
    whole === 0 ? 100 : Math.round((part / whole) * 1000) / 10;
  const fileCoverage = [...lines]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([path, fileLines]) => {
      const sorted = [...fileLines].sort(([left], [right]) => left - right);
      const unvisited: { lines: string; reach: "unknown" }[] = [];
      let open: { from: number; to: number } | null = null;
      for (const [line, ran] of sorted) {
        if (ran) open = null;
        else if (open !== null) open.to = line;
        else {
          open = { from: line, to: line };
          unvisited.push({ lines: "", reach: "unknown" });
        }
        if (open !== null)
          unvisited[unvisited.length - 1]!.lines =
            open.from === open.to ? `${open.from}` : `${open.from}-${open.to}`;
      }
      const visitedLines = sorted.filter(([, ran]) => ran).length;
      return {
        path,
        coverableLines: sorted.length,
        visitedLines,
        percent: percent(visitedLines, sorted.length),
        unvisited,
      };
    });
  const coverable = fileCoverage.reduce((sum, file) => sum + file.coverableLines, 0);
  const visitedLines = fileCoverage.reduce((sum, file) => sum + file.visitedLines, 0);
  return {
    coverableLines: coverable,
    visitedLines,
    percent: percent(visitedLines, coverable),
    files: fileCoverage,
    unvisitedBranches: [],
  };
}
