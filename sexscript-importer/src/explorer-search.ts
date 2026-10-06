import { deflateRawSync, inflateRawSync } from "node:zlib";
import { isRecord } from "./ast.ts";
import {
  concreteKeys,
  constantConditions,
  DataFlow,
  distance,
  goalsFor,
  unreachableInstructions,
  type Candidate,
  type Goal,
  type PlanDiagnostic,
} from "./explorer-analysis.ts";
import {
  EPOCH_MS,
  failureOf,
  isSeeding,
  PLAY_SETUP,
  Session,
  short,
  stateKeys,
  type Data,
  type Engine,
  type ExplorerInput,
  type Prompt,
  type Setup,
  type Step,
  type StoredValue,
} from "./explorer.ts";

/**
 * The explorer's search: it plays a compiled project through every branch it can reach within a budget
 * ({@link explore}).
 *
 * - States are deduplicated by `stateKeys`: a hash of the snapshot without what a script cannot observe.
 * - Search order: states of a directed attempt first ({@link Lead}), then play states, then seeded ones; within each,
 *   states whose step reached new instructions first, then states that differ from every explored one in more than
 *   clock, random state, and settled handles (their loop key), then the rest, least repeated first; and the newest
 *   first.
 * - Directed search (see {@link explore}) aims at each condition that a step reached but left only one way.
 * - Traps are described at {@link findTraps}.
 * - Coverage labels: a line is `play` when a play step executed it, `seeded` when only steps after a seeded input or
 *   from a seeded start did, `unreachable` when no execution can reach it from the session start (constant conditions
 *   taking only their one way), and `unknown` otherwise.
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
 * The part of all steps that directed work may take: directed attempts, and expansions of states in the first place.
 * Above it, play goes first again until it has caught up.
 */
const DIRECTED_SHARE = 1 / 3;
/** Expansions between two passes of directed search over the conditions left one way, or a tenth of the budget. */
const ANALYZE_EVERY = 50;
/** Directed attempts per condition way. */
const MAX_ATTEMPTS = 8;
/** Values tried per source of a condition. */
const MAX_CANDIDATES = 3;
/** Answers directed search adds to one ask. */
const MAX_DIRECTED_ANSWERS = 6;
/** Inputs replayed after a changed answer to reach the condition again. */
const MAX_SUFFIX = 60;
/** Variables whose closeness to a comparison steers the search at the same time. */
const MAX_DISTANCE_TARGETS = 8;
/** Compressed snapshots kept for going on from explored states; older ones are replayed when needed. */
const STORE_BYTES = 256 * 1024 * 1024;
/** Values of one stored key kept from play, to seed it elsewhere. */
const OBSERVED_VALUES = 3;

/** Wall clocks tried for a condition that reads the clock: times of day, weekdays, and later dates. */
const CLOCK_VARIANTS = [-11.5, -6, 6, 11.5, 24, 48, 72, 24 * 8, 24 * 40, 24 * 400].map(
  (hours) => EPOCH_MS + hours * 3_600_000,
);

type NodeStatus = "open" | "expanded" | "partial" | "completed" | "failed" | "stuck";

interface Node {
  readonly id: number;
  readonly parent: number | null;
  readonly input: ExplorerInput | null;
  readonly depth: number;
  readonly loop: string;
  /** The index of the start {@link Setup} of its path. */
  readonly setup: number;
  /** Whether the path started seeded or contains a seeded input. */
  readonly seeded: boolean;
  /** The directed attempt, or closeness to a comparison, whose first place it shares; null for none. */
  readonly lead: Lead | null;
  /** Its place in the search order apart from a lead: the tier, how often its loop key was seen, and its ID. */
  readonly rank: readonly number[];
  status: NodeStatus;
  readonly edges: number[];
  readonly texts: readonly string[];
  readonly prompt: Prompt;
}

export interface ExploreOptions {
  readonly seed: number;
  readonly budgetMs: number;
  readonly maxStates: number;
  /** Project sources by path, for the source text of conditions. */
  readonly sources: ReadonlyMap<string, string>;
  /** The compiler's diagnostics, whose `TSV046` proves conditions constant. */
  readonly diagnostics: readonly PlanDiagnostic[];
}

/** An input list from a start: the setup is present only for a seeded start. */
export interface Repro {
  readonly setup?: Setup;
  readonly inputs: readonly ExplorerInput[];
}

/** A crash: one entry per runtime failure code and source span. */
export interface CrashReport {
  code: string;
  message: string;
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** States that ended in this failure. */
  states: number;
  /** Whether every path found to it is seeded: it may need state that play does not make. */
  seeded: boolean;
  /** The shortest input list found to the failure, a play one when there is. */
  inputs: ExplorerInput[];
  setup?: Setup;
  texts: readonly string[];
}

/** How a line was reached (see the module documentation). */
export type Reach = "play" | "seeded" | "unreachable" | "unknown";

/** Line coverage of one file; `unvisited` ranges hold the lines play did not reach, with what else is known. */
export interface FileCoverage {
  path: string;
  coverableLines: number;
  visitedLines: number;
  percent: number;
  unvisited: { lines: string; reach: Exclude<Reach, "play"> }[];
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
  /** `seeded` when a seeded step took the missed way, `unreachable` for a constant condition. */
  reach: Exclude<Reach, "play">;
  /** What directed search found the condition depends on, and the attempts it made. */
  sources: SourceKind[];
  attempts: number;
  /** For a `seeded` way, the shortest input list found to it. */
  repro?: Repro;
}

/** A condition way that was missed when directed search first looked at it, and was reached later. */
export interface ReachedBranch {
  path: string;
  line: number;
  condition: string;
  /** The way that was reached. */
  way: "true" | "false" | "enter" | "exit";
  reach: "play" | "seeded";
  /** `directed` when a directed attempt or a step after one took it, `search` otherwise. */
  via: "directed" | "search";
  sources: SourceKind[];
  /** The shortest input list found to it, a play one when there is. */
  repro: Repro;
}

export interface TrapReport {
  /** `loop`: the explored states repeat; `stuck`: a state where the player can do nothing and nothing happens. */
  kind: "loop" | "stuck";
  /** Explored states in the trap, and those outside it from which every explored path leads into it. */
  states: number;
  feederStates: number;
  /** Where the player is asked inside the trap, as `path:line`. */
  locations: string[];
  sampleTexts: string[];
  samplePrompts: string[];
  /** Whether the shortest path into it is seeded. */
  seeded: boolean;
  /** The shortest input list found from the start into the trap. */
  inputs: ExplorerInput[];
  setup?: Setup;
}

export interface ExploreResult {
  search: {
    states: number;
    transitions: number;
    expanded: number;
    /** Inputs the runtime did not accept, such as an answer to an interaction inside a running timer block. */
    rejectedInputs: number;
    /**
     * Inputs whose operation threw, such as a runtime that rejects a snapshot it produced itself (`TSR101`): a problem
     * of the explorer or the runtime, not of the package. `first` has the input list from the start that throws.
     */
    engineErrors: { count: number; first: { message: string; inputs: ExplorerInput[] } | null };
    /** How executions were recorded: `trace` by the runtime's instruction trace, `steps` on a build without it. */
    recording: "trace" | "steps" | null;
    /** With `steps`: runs whose rest went unrecorded after a long stretch of known instructions. */
    untracedRuns: number;
    stoppedBy: "exhausted" | "budget" | "maxStates";
    elapsedMs: number;
    /** The compressed snapshot store: its largest size, the snapshots it dropped, and the replays that made up for them. */
    store: { peakBytes: number; evicted: number; replays: number };
  };
  endStates: { completed: number; failed: number; stuck: number; open: number };
  coverage: {
    coverableLines: number;
    /** Lines play reached. */
    visitedLines: number;
    percent: number;
    /** Coverable lines by label. */
    reach: Record<Reach, number>;
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
    /** Condition ways play or seeded steps had left one way when directed search looked at them. */
    targets: number;
    attempts: number;
    /** Steps that directed attempts took. */
    transitions: number;
    reached: { play: number; seeded: number };
    /** Targets and reached targets by what their condition depends on. */
    bySource: Record<SourceKind | "none", { targets: number; reached: number }>;
    ways: ReachedBranch[];
  };
  crashes: CrashReport[];
  traps: TrapReport[];
}

/**
 * The snapshots of waiting states as deflated JSON, so that directed search can go on from any explored state. Above
 * {@link STORE_BYTES} the oldest ones that are not pinned are dropped; a state without one is replayed.
 */
class SnapshotStore {
  peakBytes = 0;
  evicted = 0;
  readonly #entries = new Map<number, Uint8Array>();
  readonly #pinned = new Set<number>();
  #bytes = 0;

  put(id: number, snapshot: Data, pinned = false): void {
    // zlib's result, like a pooled Buffer copy, shares a larger memory block that one kept entry would keep alive;
    // a plain copy has a block of its own size.
    const data = new Uint8Array(deflateRawSync(JSON.stringify(snapshot), { level: 1 }));
    this.#entries.set(id, data);
    this.#bytes += data.length;
    if (pinned) this.#pinned.add(id);
    this.peakBytes = Math.max(this.peakBytes, this.#bytes);
    for (const [key, value] of this.#entries) {
      if (this.#bytes <= STORE_BYTES) break;
      if (this.#pinned.has(key) || key === id) continue;
      this.#entries.delete(key);
      this.#bytes -= value.length;
      this.evicted += 1;
    }
  }

  get(id: number): Data | null {
    const data = this.#entries.get(id);
    if (data === undefined) return null;
    const value: unknown = JSON.parse(inflateRawSync(data).toString("utf8"));
    return isRecord(value) ? value : null;
  }

  drop(id: number): void {
    const data = this.#entries.get(id);
    if (data === undefined || this.#pinned.has(id)) return;
    this.#entries.delete(id);
    this.#bytes -= data.length;
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

  pop(): number | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined || items.length === 0) return top?.node;
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
    return top.node;
  }
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

/** A condition way that directed search aims at. */
interface Target {
  readonly instruction: number;
  /** 0 continues with the next instruction (condition true, loop entered), 1 goes to the target. */
  readonly way: 0 | 1;
  readonly goals: readonly Goal[];
  attempts: number;
  reach: { label: "play" | "seeded"; via: "directed" | "search"; repro: Repro } | null;
}

/** A directed attempt: from an explored state, or from a new start with `setup`, apply `inputs` in turn. */
interface Attempt {
  readonly target: number;
  readonly from: number | null;
  readonly setup: Setup | null;
  readonly inputs: readonly ExplorerInput[];
}

/** A variable whose closeness to a comparison steers the search toward a target. */
interface DistanceTarget {
  readonly target: number;
  readonly name: string;
  readonly operator: string;
  readonly constant: number;
}

/** The first step that evaluated a condition: from a state (`null` for the session start) with an input. */
interface Witness {
  readonly node: number | null;
  readonly input: ExplorerInput | null;
}

/**
 * Explores a compiled project's plan from a fresh session until every state is expanded and directed search has
 * nothing left to try, or a limit is reached.
 *
 * Directed search: every {@link ANALYZE_EVERY} expansions, and whenever nothing else is left, each condition that a
 * step reached but left one way becomes a target. The static data flow (`DataFlow`) finds what its condition reads,
 * and `goalsFor` the values that take the missed way:
 *
 * - an ask's answer: the ask is answered again on the path of the step that first evaluated the condition (its
 *   witness), with each value, and the rest of that path is replayed; the values also become answers of that ask
 *   wherever the search meets it;
 * - a stored value: the value is set from outside right before the witness step (`seeded`), and failing that, a new
 *   session starts with it in storage and replays the witness path;
 * - the clock: the player continues at other wall clock times before the witness step (`seeded`);
 * - a variable the code counts or sets: states closer to the comparison, by `distance`, take the first place.
 *
 * An attempt's states share the first place for {@link ATTEMPT_EXPANSIONS} expansions in all, until the target is
 * reached; states closer to a variable's comparison share it for {@link CLOSER_EXPANSIONS}. Directed work takes at
 * most {@link DIRECTED_SHARE} of all steps.
 */
export function explore(engine: Engine, plan: Data, options: ExploreOptions): ExploreResult {
  const started = performance.now();
  const instructions = list(plan.instructions);
  const files = instructionFiles(plan);
  const session = new Session(engine, plan, options.seed);
  const flow = new DataFlow(plan, instructions);
  const constants = constantConditions(instructions, files, options.diagnostics);
  const store = new SnapshotStore();
  const nodes: Node[] = [];
  const byState = new Map<string, number>();
  const loopSeen = new Map<string, number>();
  const frontier = new Frontier();
  const crashes = new Map<string, CrashReport>();
  const setups: Setup[] = [PLAY_SETUP];
  const witnesses = new Map<number, Witness>();
  const targets = new Map<number, Target>();
  // Attempts that can reach a way by play (answers) go before seeded ones.
  const playAttempts: Attempt[] = [];
  const seededAttempts: Attempt[] = [];
  const distanceTargets: DistanceTarget[] = [];
  /** Waiting states by the ask instruction they wait at, a few each. */
  const askNodes = new Map<number, number[]>();
  /** Values play stored, by key, for seeding a key elsewhere. */
  const observed = new Map<string, Map<string, StoredValue>>();
  let transitions = 0;
  /** Steps of directed attempts. */
  let directedTransitions = 0;
  /** Steps of directed attempts and of expansions in the first place. */
  let directedWork = 0;
  let attemptCount = 0;
  let expanded = 0;
  let rejectedInputs = 0;
  let replays = 0;
  const engineErrors: ExploreResult["search"]["engineErrors"] = { count: 0, first: null };

  const reproOf = (node: Node | null, input: ExplorerInput | null): Repro => {
    const inputs = node === null ? [] : pathTo(nodes, node);
    if (input !== null) inputs.push(input);
    const setup = setups[node?.setup ?? 0]!;
    return setup === PLAY_SETUP ? { inputs } : { setup, inputs };
  };

  /** Adds the state a step reached, or finds it among the explored ones; records witnesses, targets, and crashes. */
  const withinShare = () => directedWork <= transitions * DIRECTED_SHARE;
  const active = (lead: Lead | null): lead is Lead =>
    lead !== null && lead.remaining > 0 && targets.get(lead.target)?.reach == null && withinShare();
  /**
   * The order of a state: play states with a lead first, then play, then seeded; within those by tier, repeats, and
   * newest. A seeded attempt takes its own steps but no first place after them, so that play goes first.
   */
  const leads = (node: Node): boolean => !node.seeded && active(node.lead);
  const order = (node: Node): readonly number[] => [
    leads(node) ? 0 : node.seeded ? 2 : 1,
    ...node.rank,
  ];

  const transition = (
    parent: Node | null,
    input: ExplorerInput | null,
    step: Step,
    setup: number,
    lead: Lead | null,
  ): Node => {
    const seeded = (parent?.seeded ?? setup !== 0) || (input !== null && isSeeding(input));
    const inherited = lead ?? (parent !== null && active(parent.lead) ? parent.lead : null);
    for (const way of step.ways) {
      const instruction = way >> 1;
      if (!witnesses.has(instruction))
        witnesses.set(instruction, { node: parent?.id ?? null, input });
      const target = targets.get(way);
      if (target === undefined) continue;
      const label = seeded ? "seeded" : "play";
      const length = (parent === null ? 0 : parent.depth) + (input === null ? 0 : 1);
      const known = target.reach;
      if (
        known === null ||
        (known.label === "seeded" && label === "play") ||
        (known.label === label && length < known.repro.inputs.length)
      )
        target.reach = {
          label,
          via: inherited !== null ? "directed" : "search",
          repro: reproOf(parent, input),
        };
    }
    const keys = stateKeys(step.snapshot);
    const known = byState.get(keys.state);
    if (known !== undefined) {
      const node = nodes[known]!;
      if (parent !== null && !parent.edges.includes(node.id)) parent.edges.push(node.id);
      return node;
    }
    const status = step.snapshot.status;
    const repeats = loopSeen.get(keys.loop) ?? 0;
    const id = nodes.length;
    const node: Node = {
      id,
      parent: parent?.id ?? null,
      input,
      depth: parent === null ? 0 : parent.depth + 1,
      loop: keys.loop,
      setup,
      seeded,
      lead: inherited,
      rank: [step.newInstructions > 0 ? 0 : repeats === 0 ? 1 : 2, repeats, -id],
      status: status === "halted" ? "completed" : status === "failed" ? "failed" : "open",
      edges: [],
      texts: step.texts,
      prompt: session.prompt(step.snapshot),
    };
    nodes.push(node);
    byState.set(keys.state, node.id);
    if (parent !== null) parent.edges.push(node.id);
    if (node.status === "failed") recordCrash(crashes, step, node, reproOf(parent, input));
    if (node.status === "open") {
      store.put(node.id, step.snapshot, parent === null);
      if (!seeded) observe(step.snapshot);
      const ask = node.prompt.instruction;
      if (ask !== null) {
        const waiting = askNodes.get(ask) ?? [];
        if (waiting.length < 5) waiting.push(node.id);
        askNodes.set(ask, waiting);
      }
      frontier.push(node.id, order(node));
    }
    loopSeen.set(keys.loop, (loopSeen.get(keys.loop) ?? 0) + 1);
    return node;
  };

  const observe = (snapshot: Data): void => {
    for (const entry of list(snapshot.scriptStorage)) {
      if (typeof entry.key !== "string") continue;
      const value = entry.value;
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean" &&
        !isRecord(value)
      )
        continue;
      const values = observed.get(entry.key) ?? new Map<string, StoredValue>();
      if (values.size < OBSERVED_VALUES) values.set(JSON.stringify(value), value);
      observed.set(entry.key, values);
    }
  };

  /** A state's snapshot: stored, or replayed from its nearest ancestor that has one. */
  const snapshotOf = (node: Node): Data | null => {
    const stored = store.get(node.id);
    if (stored !== null) return stored;
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
    if (snapshot === null) return null;
    replays += 1;
    for (const step of chain.reverse()) {
      if (step.input === null) return null;
      const next = session.apply(snapshot, step.input, step.seeded);
      if (next === null) return null;
      snapshot = next.snapshot;
    }
    return snapshot;
  };

  /** Applies one input to a state; null when the runtime rejects it or throws. */
  const step = (node: Node, snapshot: Data, input: ExplorerInput): Step | null => {
    try {
      const next = session.apply(snapshot, input, node.seeded);
      if (next === null) rejectedInputs += 1;
      else transitions += 1;
      return next;
    } catch (error) {
      // The runtime refused data it was given (RuntimeDataError): a harness problem, not a script failure.
      engineErrors.count += 1;
      engineErrors.first ??= { message: String(error), inputs: [...pathTo(nodes, node), input] };
      return null;
    }
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

  const distances = (snapshot: Data): number[] => {
    const values = bindings(snapshot);
    return distanceTargets.map((goal) => {
      const value = values.get(goal.name);
      return value === undefined ? Infinity : distance(value, goal.operator, goal.constant);
    });
  };

  const runAttempt = (attempt: Attempt): void => {
    const target = targets.get(attempt.target);
    if (target === undefined || target.reach !== null) return;
    attemptCount += 1;
    const lead: Lead = { remaining: ATTEMPT_EXPANSIONS, target: attempt.target };
    let node: Node;
    let snapshot: Data | null;
    if (attempt.setup !== null) {
      setups.push(attempt.setup);
      const start = session.start(attempt.setup);
      directedTransitions += 1;
      directedWork += 1;
      node = transition(null, null, start, setups.length - 1, lead);
      snapshot = start.snapshot.status === "waiting" ? start.snapshot : null;
    } else {
      node = nodes[attempt.from ?? 0]!;
      snapshot = snapshotOf(node);
    }
    for (const input of attempt.inputs) {
      if (snapshot === null || snapshot.status !== "waiting") break;
      const next = step(node, snapshot, input);
      if (next === null) break;
      directedTransitions += 1;
      directedWork += 1;
      node = transition(node, input, next, node.setup, lead);
      snapshot = next.snapshot.status === "waiting" ? next.snapshot : null;
    }
  };

  /** Makes targets of the condition ways left one way, and schedules their attempts. */
  const analyze = (): boolean => {
    let scheduled = false;
    instructions.forEach((instruction, index) => {
      if (instruction.kind !== "jumpIfFalse" && instruction.kind !== "loopStart") return;
      const taken = session.branches[index]! | session.seededBranches[index]!;
      if (taken !== 1 && taken !== 2) return;
      if (constants.has(index) || Number(instruction.target) === index + 1) return;
      const way: 0 | 1 = taken === 1 ? 1 : 0;
      const code = index * 2 + way;
      if (targets.has(code)) return;
      const condition = instruction.condition ?? instruction.expression;
      const conditional = instruction.kind === "jumpIfFalse" || instruction.loopKind === "while";
      const goals = conditional ? goalsFor(flow, condition, way === 0) : [];
      const target: Target = { instruction: index, way, goals, attempts: 0, reach: null };
      targets.set(code, target);
      scheduled = schedule(code, target) || scheduled;
    });
    return scheduled;
  };

  const schedule = (code: number, target: Target): boolean => {
    const witness = witnesses.get(target.instruction);
    const plan: Attempt[] = [];
    const add = (attempt: Attempt) => {
      if (plan.length < MAX_ATTEMPTS) plan.push(attempt);
    };
    const witnessNode =
      witness?.node === null || witness === undefined ? null : nodes[witness.node]!;
    const fullPath = (): ExplorerInput[] => {
      const inputs = witnessNode === null ? [] : pathTo(nodes, witnessNode);
      if (witness?.input != null) inputs.push(witness.input);
      return inputs;
    };
    const replayable = fullPath().length <= MAX_SUFFIX;
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
          const suffix = fullPath()
            .slice(at + 1)
            .slice(0, MAX_SUFFIX);
          for (const answer of answers)
            add({
              target: code,
              from: chain[at]!.id,
              setup: null,
              inputs: [{ kind: "text", text: answer }, ...suffix],
            });
        } else {
          for (const from of askNodes.get(source.instruction) ?? [])
            for (const answer of answers)
              add({ target: code, from, setup: null, inputs: [{ kind: "text", text: answer }] });
        }
      } else if (source.kind === "storage") {
        for (const key of concreteKeys(source.key, observed.keys())) {
          for (const value of storedCandidates(goal.candidates, observed.get(key))) {
            const seed: ExplorerInput = { kind: "storage", key, value };
            if (witnessNode !== null && witness?.input != null)
              add({
                target: code,
                from: witnessNode.id,
                setup: null,
                inputs: [seed, witness.input],
              });
            if (replayable)
              add({
                target: code,
                from: null,
                setup: { storage: value === null ? [] : [{ key, value }], wallClockMs: EPOCH_MS },
                inputs: fullPath(),
              });
          }
        }
      } else if (source.kind === "clock") {
        for (const wallClockMs of CLOCK_VARIANTS) {
          if (witnessNode !== null && witness?.input != null)
            add({
              target: code,
              from: witnessNode.id,
              setup: null,
              inputs: [{ kind: "clock", wallClockMs }, witness.input],
            });
          else if (replayable)
            add({
              target: code,
              from: null,
              setup: { storage: [], wallClockMs },
              inputs: fullPath(),
            });
        }
      } else if (goal.comparison !== null && distanceTargets.length < MAX_DISTANCE_TARGETS) {
        distanceTargets.push({
          target: code,
          name: source.name,
          operator: goal.comparison.operator,
          constant: goal.comparison.constant,
        });
      }
    }
    target.attempts = plan.length;
    for (const attempt of plan)
      (attempt.setup === null && !attempt.inputs.some(isSeeding)
        ? playAttempts
        : seededAttempts
      ).push(attempt);
    return plan.length > 0;
  };

  transition(null, null, session.start(), 0, null);
  let stoppedBy: ExploreResult["search"]["stoppedBy"] = "exhausted";
  const outOfBudget = () => performance.now() - started >= options.budgetMs;
  let sinceAnalysis = 0;
  let analyzedAt = started;
  search: for (;;) {
    if (outOfBudget()) {
      stoppedBy = "budget";
      break;
    }
    if (nodes.length >= options.maxStates) {
      stoppedBy = "maxStates";
      break;
    }
    if (sinceAnalysis >= ANALYZE_EVERY || performance.now() - analyzedAt >= options.budgetMs / 10) {
      sinceAnalysis = 0;
      analyzedAt = performance.now();
      analyze();
    }
    // Directed attempts and the rest of the search take turns, by steps.
    const pending = playAttempts.length > 0 ? playAttempts : seededAttempts;
    if (pending.length > 0 && (frontier.size === 0 || withinShare())) {
      runAttempt(pending.shift()!);
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
    const snapshot = snapshotOf(node);
    if (snapshot === null) {
      node.status = "expanded";
      continue;
    }
    const inputs = session.options(snapshot);
    if (inputs.length === 0) {
      node.status = "stuck";
      store.drop(node.id);
      continue;
    }
    expanded += 1;
    sinceAnalysis += 1;
    node.status = "partial";
    const closeness = distanceTargets.length === 0 ? [] : distances(snapshot);
    for (const input of inputs) {
      if (outOfBudget()) {
        stoppedBy = "budget";
        break search;
      }
      const next = step(node, snapshot, input);
      if (next === null) continue;
      if (leading) directedWork += 1;
      // A step that brings a variable closer to a comparison a target needs shares that target's lead.
      const after = closeness.length === 0 ? [] : distances(next.snapshot);
      const closer = after.findIndex((value, index) => value < (closeness[index] ?? Infinity));
      transition(node, input, next, node.setup, closer < 0 ? null : closerLead(closer));
    }
    node.status = "expanded";
  }

  const unreachable = unreachableInstructions(plan, instructions, constants);
  const coverage = lineCoverage(
    instructions,
    files,
    session,
    options.sources,
    unreachable,
    constants,
    targets,
  );
  const count = (status: NodeStatus) => nodes.filter((node) => node.status === status).length;
  return {
    search: {
      states: nodes.length,
      transitions,
      expanded,
      rejectedInputs,
      engineErrors,
      recording: session.recording,
      untracedRuns: session.untracedRuns,
      stoppedBy,
      elapsedMs: Math.round(performance.now() - started),
      store: { peakBytes: store.peakBytes, evicted: store.evicted, replays },
    },
    endStates: {
      completed: count("completed"),
      failed: count("failed"),
      stuck: count("stuck"),
      open: count("open") + count("partial"),
    },
    coverage,
    directed: directedSummary(
      instructions,
      files,
      options.sources,
      targets,
      attemptCount,
      directedTransitions,
    ),
    crashes: [...crashes.values()],
    traps: findTraps(nodes, instructions, files, setups),
  };
}

/** Values to seed a stored key with: the solved ones, else values play stored under it, else a few scalars. */
function storedCandidates(
  candidates: readonly Candidate[],
  observedValues: ReadonlyMap<string, StoredValue> | undefined,
): (StoredValue | null)[] {
  const values: (StoredValue | null)[] = candidates.map((value) =>
    typeof value === "object" ? null : value,
  );
  if (values.length === 0) values.push(...(observedValues?.values() ?? []));
  if (values.length === 0) values.push(true, 1, "x");
  return values.slice(0, MAX_CANDIDATES);
}

function ancestry(nodes: readonly Node[], node: Node): Node[] {
  const chain: Node[] = [];
  for (let current: Node | undefined = node; current !== undefined;) {
    chain.push(current);
    current = current.parent === null ? undefined : nodes[current.parent];
  }
  return chain.reverse();
}

function pathTo(nodes: readonly Node[], node: Node): ExplorerInput[] {
  return ancestry(nodes, node)
    .map((current) => current.input)
    .filter((input): input is ExplorerInput => input !== null);
}

function recordCrash(
  crashes: Map<string, CrashReport>,
  step: Step,
  node: Node,
  repro: Repro,
): void {
  const failure = failureOf(step.snapshot);
  const key = `${failure.code}@${failure.path}:${failure.line}:${failure.column}-${failure.endLine}:${failure.endColumn}`;
  const known = crashes.get(key);
  const entry = {
    seeded: node.seeded,
    inputs: [...repro.inputs],
    ...(repro.setup === undefined ? {} : { setup: repro.setup }),
    texts: step.texts,
  };
  if (known === undefined) {
    crashes.set(key, { ...failure, states: 1, ...entry });
    return;
  }
  known.states += 1;
  const better =
    (known.seeded && !node.seeded) ||
    (known.seeded === node.seeded && entry.inputs.length < known.inputs.length);
  if (!better) return;
  known.seeded = entry.seeded;
  known.inputs = entry.inputs;
  known.texts = entry.texts;
  if (entry.setup === undefined) delete known.setup;
  else known.setup = entry.setup;
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

function lineCoverage(
  instructions: readonly Data[],
  files: readonly string[],
  session: Session,
  sources: ReadonlyMap<string, string>,
  unreachable: Uint8Array,
  constants: ReadonlyMap<number, boolean>,
  targets: ReadonlyMap<number, Target>,
): ExploreResult["coverage"] {
  // An instruction that ran but is statically unreachable shows the analysis missed a way: then claim nothing.
  let contradictions = 0;
  instructions.forEach((_, index) => {
    if (
      unreachable[index] === 1 &&
      (session.visited[index] === 1 || session.seededVisited[index] === 1)
    )
      contradictions += 1;
  });
  const claims = contradictions === 0;
  const labelOf = (index: number): Reach =>
    session.visited[index] === 1
      ? "play"
      : session.seededVisited[index] === 1
        ? "seeded"
        : claims && unreachable[index] === 1
          ? "unreachable"
          : "unknown";
  const order: readonly Reach[] = ["play", "seeded", "unknown", "unreachable"];
  // Per file, per line: the strongest label of the instructions starting on it.
  const lines = new Map<string, Map<number, Reach>>();
  const lineOf = instructions.map((instruction) => compactSpan(instruction.span)?.line ?? null);
  instructions.forEach((_, index) => {
    const line = lineOf[index];
    if (line == null) return;
    const file = lines.get(files[index]!) ?? new Map<number, Reach>();
    const label = labelOf(index);
    const known = file.get(line);
    if (known === undefined || order.indexOf(label) < order.indexOf(known)) file.set(line, label);
    lines.set(files[index]!, file);
  });
  const percent = (part: number, whole: number) =>
    whole === 0 ? 100 : Math.round((part / whole) * 1000) / 10;
  const reach: Record<Reach, number> = { play: 0, seeded: 0, unreachable: 0, unknown: 0 };
  const fileCoverage: FileCoverage[] = [...lines]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([path, fileLines]) => {
      const sorted = [...fileLines].sort(([left], [right]) => left - right);
      for (const [, label] of sorted) reach[label] += 1;
      const visited = sorted.filter(([, label]) => label === "play").length;
      // Lines of one label with no line of another label between them form one range.
      const ranges: { from: number; to: number; reach: Exclude<Reach, "play"> }[] = [];
      let open: (typeof ranges)[number] | null = null;
      for (const [line, label] of sorted) {
        if (label === "play") open = null;
        else if (open !== null && open.reach === label) open.to = line;
        else ranges.push((open = { from: line, to: line, reach: label }));
      }
      return {
        path,
        coverableLines: sorted.length,
        visitedLines: visited,
        percent: percent(visited, sorted.length),
        unvisited: ranges.map(({ from, to, reach: label }) => ({
          lines: from === to ? `${from}` : `${from}-${to}`,
          reach: label,
        })),
      };
    });
  const coverable = fileCoverage.reduce((sum, file) => sum + file.coverableLines, 0);
  const visited = fileCoverage.reduce((sum, file) => sum + file.visitedLines, 0);
  const unvisitedBranches: UnvisitedBranch[] = [];
  instructions.forEach((instruction, index) => {
    if (instruction.kind !== "jumpIfFalse" && instruction.kind !== "loopStart") return;
    const play = session.branches[index]!;
    const seeded = session.seededBranches[index]!;
    const target = Number(instruction.target);
    // A condition play never evaluated, or with both ways equal, is not listed.
    if (play === 0 || play === 3 || target === index + 1) return;
    const condition = record(instruction.condition ?? instruction.expression);
    if (condition.kind === "literal") return;
    const way = play === 1 ? 1 : 0;
    const missedTarget = way === 1;
    const constant = constants.get(index);
    const directed = targets.get(index * 2 + way);
    const label: Exclude<Reach, "play"> =
      (seeded & (way === 0 ? 1 : 2)) !== 0
        ? "seeded"
        : claims && constant !== undefined
          ? "unreachable"
          : "unknown";
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
      sources: directed === undefined ? [] : sourceKinds(directed.goals),
      attempts: directed?.attempts ?? 0,
      ...(label === "seeded" && reached != null ? { repro: reached.repro } : {}),
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
): ExploreResult["directed"] {
  const bySource: ExploreResult["directed"]["bySource"] = {
    ask: { targets: 0, reached: 0 },
    storage: { targets: 0, reached: 0 },
    clock: { targets: 0, reached: 0 },
    counter: { targets: 0, reached: 0 },
    variable: { targets: 0, reached: 0 },
    none: { targets: 0, reached: 0 },
  };
  const reached = { play: 0, seeded: 0 };
  const ways: ReachedBranch[] = [];
  for (const target of targets.values()) {
    const kinds = sourceKinds(target.goals);
    for (const kind of kinds.length === 0 ? (["none"] as const) : kinds) {
      bySource[kind].targets += 1;
      if (target.reach !== null) bySource[kind].reached += 1;
    }
    if (target.reach === null) continue;
    reached[target.reach.label] += 1;
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
      repro: target.reach.repro,
    });
  }
  return { targets: targets.size, attempts, transitions, reached, bySource, ways };
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
 * a clock time the explorer does not try, is reported as a trap.
 */
function findTraps(
  nodes: readonly Node[],
  instructions: readonly Data[],
  files: readonly string[],
  setups: readonly Setup[],
): TrapReport[] {
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
  return bottom.map(({ component, index }) => {
    const members = component.flatMap((loop) => groups.get(loop)!);
    const cyclic = component.length > 1 || successors.get(component[0]!)!.has(component[0]!);
    // The shortest way in, a play one when there is.
    const entry = members.reduce((best, node) =>
      (node.seeded ? 1 : 0) < (best.seeded ? 1 : 0) ||
      ((node.seeded ? 1 : 0) === (best.seeded ? 1 : 0) && node.depth < best.depth)
        ? node
        : best,
    );
    const locations = new Set<string>();
    for (const node of members) {
      const at = node.prompt.instruction;
      const span = at === null ? null : compactSpan(instructions[at]?.span);
      if (at !== null && span !== null) locations.add(`${files[at]}:${span.line}`);
    }
    const setup = setups[entry.setup]!;
    return {
      kind: cyclic ? ("loop" as const) : ("stuck" as const),
      states: members.length,
      feederStates: feeders.get(index) ?? 0,
      locations: [...locations].slice(0, 10),
      sampleTexts: [...new Set(members.flatMap((node) => node.texts))].slice(0, 8),
      samplePrompts: [
        ...new Set(members.map((node) => node.prompt.text).filter((text) => text !== "")),
      ].slice(0, 8),
      seeded: entry.seeded,
      inputs: pathTo(nodes, entry),
      ...(setup === PLAY_SETUP ? {} : { setup }),
    };
  });
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
