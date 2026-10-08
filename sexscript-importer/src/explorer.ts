import { createHash } from "node:crypto";
import { isRecord } from "./ast.ts";
import type { ClockDifference, Constants } from "./explorer-analysis.ts";
import { repositoryBuildUrl } from "./repository-build.ts";

/**
 * The session layer of the headless branch explorer: it runs a compiled TeaseScript project in the real runtime,
 * without the Player, applies one input at a time, and records what each step executed. The search over these steps
 * lives in `explorer-search.ts`.
 *
 * Each pending action is a branch point; its options are the buttons and choice options, typed answers
 * ({@link interactionOptions}), form answers, thinking before a timed button, permanent buttons, and letting time
 * pass to the next deadline. Directed search adds answers per ask, and the player continuing at another wall clock
 * time. A session can start from the storage an explored session left, as the player's next session would. Media loads succeed with one second per pass, `takePhoto` finds no camera, and
 * `askImage` gets one stored image. When letting time pass is the only thing the player can do, the explorer does it
 * as part of the previous step (at most {@link MAX_AUTO_WAITS} times in a row).
 *
 * Execution is deterministic: a state is reproduced by the seed, its earlier sessions, its start clock, and its input
 * list ({@link replay}).
 *
 * Each path runs in an engine-owned runtime session (`docs/RUNTIME.md#runtime-sessions`), which keeps its state between
 * operations. The explorer handles the whole state only where it needs it: one tagged export per step
 * (`exportTaggedSnapshot`: the snapshot's JSON and a tag that proves this process's engine wrote it), which the search
 * reads for its state hash and keeps in its store as it is; a restore of that tagged JSON to go on from a stored state,
 * which the runtime does without checking it again while the tag holds; and a trusted copy (a fork) for each input
 * tried from one state but the last.
 */

/** A runtime result read field by field. */
export type Data = Readonly<Record<string, unknown>>;

const RUNTIME_OPERATIONS = [
  "run",
  "completeAction",
  "updateInteraction",
  "observeTime",
  "reportMediaLoad",
  "pressPermanentButton",
  "recordContinueCapture",
] as const;
const RUNTIME_PROJECTIONS = ["mediaPlaybackProjection", "permanentButtonProjection"] as const;
const RUNTIME_READS = [
  "view",
  "callReturnInstructions",
  "exportSnapshot",
  "exportTrustedSnapshot",
  "exportTaggedSnapshot",
  "fork",
] as const;

/**
 * A snapshot as the runtime writes it for a trusted host: its JSON, and a tag that proves this process's engine wrote it
 * for one plan (`TaggedRuntimeSnapshot`). Both are kept exactly as they are.
 */
export interface TaggedSnapshot {
  readonly json: string;
  readonly tag: string;
}

/**
 * One runtime session, as the explorer drives it. Its results, view, and projections are detached frozen data. An
 * operation that throws ends the session: every later call throws too, so the explorer goes on from another one.
 */
export interface Runtime {
  /** Runs one operation on the session's state; its result read field by field. */
  call: (name: (typeof RUNTIME_OPERATIONS)[number], ...args: unknown[]) => Data;
  /** The records of a projection of the current state, such as the playback of its media. */
  project: (name: (typeof RUNTIME_PROJECTIONS)[number]) => Data[];
  /** What a host acts on between operations: status, failure, times, `runnable`, and the pending actions. */
  view: () => Data;
  /** Where each active call continues when it returns, outermost first. */
  callReturnInstructions: () => number[];
  /**
   * The complete state as plain data that later operations do not change, copied without the runtime's check
   * (`exportTrustedSnapshot`): the explorer keeps it itself, and the runtime checks it when a session restores it.
   */
  exportTrustedSnapshot: () => Data;
  /** The same, checked by the runtime (`exportSnapshot`), for a host that keeps it apart from the explorer. */
  exportSnapshot: () => Data;
  /** The state as its JSON with the runtime's tag (`exportTaggedSnapshot`), which a restore in this process trusts. */
  exportTaggedSnapshot: () => TaggedSnapshot;
  /** An independent session with a copy of the state. */
  fork: () => Runtime;
}

/** The compiler and the runtime session factories the explorer and the smoke runs (`runtime-check.ts`) use. */
export interface Engine {
  compileProject: (sources: unknown, options: unknown) => Data;
  compileSource: (source: string, options: unknown) => Data;
  /** A session at the start of a plan; `options` may give the `capabilities` every operation uses. */
  createFreshRuntimeSession: (plan: Data, fresh: Data, options?: Data) => Runtime;
  /** A session that goes on from a snapshot, which the runtime checks completely; `options` as for a fresh one. */
  createRuntimeSession: (plan: Data, snapshot: Data, options?: Data) => Runtime;
  /**
   * A session that goes on from a tagged snapshot: unchecked when its tag proves that a session of this same plan object
   * exported it in this process, else checked completely; `options` as for a fresh one.
   */
  createTaggedRuntimeSession: (plan: Data, tagged: TaggedSnapshot, options?: Data) => Runtime;
  /** The outcomes of a random draw to try besides its natural one, at most `limit`, and whether they are all. */
  randomDrawAlternatives: (
    draw: Data,
    limit: number,
  ) => { alternatives: Data[]; complete: boolean };
}

const repositoryIndexUrl = repositoryBuildUrl("src/index.js");

/**
 * Loads the compiler and the runtime sessions from the repository build (`npm run build:typescript`, or
 * `TEASESCRIPT_DIST`).
 */
export async function loadEngine(): Promise<Engine> {
  const module: unknown = await import(repositoryIndexUrl.href);
  const exported = (name: string) => {
    const value = isRecord(module) ? module[name] : undefined;
    if (typeof value !== "function")
      throw new Error(
        `Repository build does not export ${name}(); the importer needs runtime sessions.`,
      );
    return value;
  };
  const compileProject = exported("compileProject");
  const compileSource = exported("compileSource");
  const fresh = exported("createFreshRuntimeSession");
  const restore = exported("createRuntimeSession");
  const restoreTagged = exported("createTaggedRuntimeSession");
  const alternatives = exported("randomDrawAlternatives");
  return {
    compileProject: (sources, options) => {
      const value: unknown = compileProject(sources, options);
      if (!isRecord(value))
        throw new Error("compileProject() returned an unexpected result shape.");
      return value;
    },
    compileSource: (source, options) => {
      const value: unknown = compileSource(source, options);
      if (!isRecord(value)) throw new Error("compileSource() returned an unexpected result shape.");
      return value;
    },
    createFreshRuntimeSession: (plan, start, options) => runtimeOf(fresh(plan, start, options)),
    createRuntimeSession: (plan, snapshot, options) =>
      runtimeOf(options === undefined ? restore(plan, snapshot) : restore(plan, snapshot, options)),
    createTaggedRuntimeSession: (plan, tagged, options) =>
      runtimeOf(
        options === undefined ? restoreTagged(plan, tagged) : restoreTagged(plan, tagged, options),
      ),
    randomDrawAlternatives: (draw, limit) => {
      const value: unknown = alternatives(draw, limit);
      const found = isRecord(value) ? value : {};
      return { alternatives: list(found.alternatives), complete: found.complete === true };
    },
  };
}

/** The explorer's view of a runtime session of the repository build. */
function runtimeOf(session: unknown): Runtime {
  const methods = new Map(
    [...RUNTIME_OPERATIONS, ...RUNTIME_PROJECTIONS, ...RUNTIME_READS].map((name) => {
      const value = isRecord(session) ? session[name] : undefined;
      if (typeof value !== "function") throw new Error(`The runtime session has no ${name}().`);
      return [name, value] as const;
    }),
  );
  const result = (
    name:
      | (typeof RUNTIME_OPERATIONS)[number]
      | "view"
      | "exportSnapshot"
      | "exportTrustedSnapshot"
      | "exportTaggedSnapshot",
    ...args: unknown[]
  ): Data => {
    const value: unknown = methods.get(name)!.apply(session, args);
    if (!isRecord(value)) throw new Error(`${name}() returned an unexpected result shape.`);
    return value;
  };
  return {
    call: result,
    project: (name) => list(methods.get(name)!.apply(session, [])),
    view: () => result("view"),
    callReturnInstructions: () => {
      const value: unknown = methods.get("callReturnInstructions")!.apply(session, []);
      return Array.isArray(value)
        ? value.filter((position): position is number => typeof position === "number")
        : [];
    },
    exportTrustedSnapshot: () => result("exportTrustedSnapshot"),
    exportSnapshot: () => result("exportSnapshot"),
    exportTaggedSnapshot: () => {
      const value = result("exportTaggedSnapshot");
      if (typeof value.json !== "string" || typeof value.tag !== "string")
        throw new Error("exportTaggedSnapshot() returned an unexpected result shape.");
      return { json: value.json, tag: value.tag };
    },
    fork: () => runtimeOf(methods.get("fork")!.apply(session, [])),
  };
}

/** A stored value as the runtime keeps it in script storage: a scalar or a composite. */
export type StoredValue = string | number | boolean | Data;

/** The kinds of random draw the explorer chooses outcomes of with random choices: those that pick what happens. */
export const RANDOM_KINDS = [
  "chance",
  "randomInteger",
  "collectionRandom",
  "randomWeighted",
  "tagQuery",
  "glob",
] as const;

/** One key of script storage. */
export interface StorageEntry {
  readonly key: string;
  readonly value: StoredValue;
}

/**
 * A random draw's outcome the explorer chose instead of the natural one: the draw by its ID (the generator state before
 * it, the same in every replay of the path), its site to read, and the outcome as the runtime gives it.
 */
export interface RandomChoice {
  readonly drawId: number;
  readonly site: string;
  readonly outcome: Data;
}

/**
 * One input of a path from the start; `label` fields only explain the input to a reader. `random` chooses outcomes of
 * random draws the step after the input makes; every other draw takes its natural outcome.
 */
export type ExplorerInput = InputKind & { readonly random?: readonly RandomChoice[] };

type InputKind =
  | { readonly kind: "option"; readonly index: number; readonly label: string }
  /** `afterMs`: the player first thinks that long, for a button whose result is the time it took. */
  | { readonly kind: "button"; readonly label: string; readonly afterMs?: number }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image" }
  /**
   * A form, submitted or cancelled; before a submit, `fields` sets fields by ID: a toggle or cycle to an option index,
   * a typed field to text. Fields not named keep their starting values.
   */
  | {
      readonly kind: "form";
      readonly action: "submit" | "cancel";
      readonly fields?: Readonly<Record<string, number | string>>;
    }
  | { readonly kind: "wait"; readonly untilMs: number }
  | { readonly kind: "press"; readonly buttonId: number; readonly label: string }
  /** The player continues at another wall clock time (epoch milliseconds): a `clock` input. */
  | { readonly kind: "clock"; readonly wallClockMs: number }
  /** The player saves and continues `afterMs` later than the wall clock now; only a positive gap is accepted. */
  | { readonly kind: "later"; readonly afterMs: number };

/** Whether an input sets the wall clock. */
export function isClockInput(input: ExplorerInput): boolean {
  return input.kind === "clock";
}

/**
 * How a session starts: the storage an earlier explored session left (none for the first), and the wall clock. A
 * start at another wall clock than {@link EPOCH_MS} is a `clock` start unless `clock` says otherwise.
 */
export interface Setup {
  readonly storage: readonly StorageEntry[];
  readonly wallClockMs: number;
  readonly clock?: boolean;
}

/** One session of a path: its inputs, and its start wall clock when that is not {@link EPOCH_MS}. */
export interface SessionPath {
  readonly inputs: readonly ExplorerInput[];
  readonly wallClockMs?: number;
}

/** A state's script storage, as the session that reached it leaves it. */
export function storageOf(snapshot: Data): StorageEntry[] {
  return list(snapshot.scriptStorage).flatMap((entry) => {
    const value = entry.value;
    return typeof entry.key === "string" &&
      (typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        isRecord(value))
      ? [{ key: entry.key, value }]
      : [];
  });
}

/**
 * The wall clock where a state stands, in epoch milliseconds: the clock of its temporal capture in force (the session
 * start's, or the last Continue's) plus the session time since; {@link EPOCH_MS} plus the session time without one.
 */
export function wallClockOf(snapshot: Data): number {
  const now =
    typeof snapshot.observedSessionTimeMs === "number" ? snapshot.observedSessionTimeMs : 0;
  let capture: Data | undefined;
  for (const candidate of list(snapshot.temporalCaptures))
    if (typeof candidate.boundaryMs === "number" && candidate.boundaryMs <= now)
      capture = candidate;
  // Session times may hold fractions of a millisecond; the runtime rounds a wall clock to whole ones.
  return Math.round(
    typeof capture?.epochMs === "number" && typeof capture.boundaryMs === "number"
      ? capture.epochMs + now - capture.boundaryMs
      : EPOCH_MS + now,
  );
}

/** The wall clock at session time 0: 2026-10-02 12:00 UTC, as in `runtime-check.ts`. */
export const EPOCH_MS = Date.UTC(2026, 9, 2, 12, 0, 0);
export const PLAY_SETUP: Setup = { storage: [], wallClockMs: EPOCH_MS };

/** The answers the explorer gives to an interaction, as `completeAction` takes them. */
type InteractionPayload =
  | { readonly kind: "selectedOption"; readonly optionIndex: number }
  | { readonly kind: "activate" }
  | { readonly kind: "submittedText"; readonly submittedText: string }
  | { readonly kind: "image"; readonly reference: string }
  | { readonly kind: "submit" }
  | { readonly kind: "cancel" };

/** Duration of one pass of every media file. */
const MEDIA_PASS_MS = 1000;
/** The stored image that answers `askImage`. */
const EXPLORER_IMAGE = "explorer-image";
/** The product's instruction budget per `run` (the runtime's default). */
const INSTRUCTION_BUDGET = 1_000_000;
/** How long the player thinks before pressing a timed button without a compared constant nearby. */
const THINK_MS = 60_000;
/** Times in a row the explorer lets time pass when nothing else can happen, before it records a state. */
const MAX_AUTO_WAITS = 100;
/** Automatic operations of one step in all (waits, camera answers, media loads), before it records a state. */
const MAX_AUTO_OPERATIONS = 1000;
/** Said texts kept per step and per text, for trap samples and replay transcripts. */
const KEPT_TEXTS = 3;
const TEXT_LENGTH = 120;
/** Form answers tried per form. */
const MAX_FORM_OPTIONS = 16;

/** What the player can see and do in a state, in short, for reports. */
export interface Prompt {
  readonly text: string;
  /** The instruction that asked, or null without a foreground interaction. */
  readonly instruction: number | null;
}

/** The result of one input and everything that follows from it until the player is asked again. */
export interface Step {
  /** The state the step reached, exported once: later operations of {@link runtime} do not change it. */
  readonly snapshot: Data;
  /** The same export as the runtime wrote it, with its tag, to keep and restore as it is. */
  readonly tagged: TaggedSnapshot;
  /** The runtime session in that state, to go on from. */
  readonly runtime: Runtime;
  /** Instructions this step executed for the first time, for its kind of coverage (see {@link Session}). */
  readonly newInstructions: number;
  /** Every instruction the step executed, once each. */
  readonly instructions: readonly number[];
  /** The last texts said during the step. */
  readonly texts: readonly string[];
  /**
   * The condition ways the step took, each as `instruction * 2 + way`: way 0 continues with the next instruction (a
   * condition was true, a loop entered), way 1 goes to the instruction's target.
   */
  readonly ways: readonly number[];
  /** With random choices: the random draws the step made that the explorer may choose (`RANDOM_KINDS`), in order. */
  readonly draws: readonly Data[];
  /**
   * The step stopped only because it had let time pass {@link MAX_AUTO_WAITS} times in a row: the state it reached waits
   * with nothing to do but wait, as the ones before it did.
   */
  readonly forced: boolean;
}

function record(value: unknown): Data {
  return isRecord(value) ? value : {};
}

function list(value: unknown): Data[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function short(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > TEXT_LENGTH ? `${line.slice(0, TEXT_LENGTH - 1)}…` : line;
}

/** What one execution ran, until nothing was runnable. */
interface Execution {
  readonly events: readonly Data[];
  /** The instructions it executed, each once. */
  readonly instructions: readonly number[];
  /** The successors that conditions, loops, transfers, and `end` took: from an instruction to the next one executed. */
  readonly edges: readonly (readonly [number, number])[];
}

/**
 * Runs a session until nothing is runnable: one `run` with the product's instruction budget, and so `TSR037` where the
 * Player has it, and `instructionTrace: true`. The trace (`docs/RUNTIME.md#instruction-trace`) lists every instruction
 * the run executed, a failing one included, and the successor each condition, loop, transfer, and `end` took.
 */
function execute(runtime: Runtime): Execution {
  const result = runtime.call("run", {
    instructionBudget: INSTRUCTION_BUDGET,
    instructionTrace: true,
  });
  const trace = result.instructionTrace;
  if (!isRecord(trace)) throw new Error("run() returned no instruction trace.");
  return {
    events: list(result.events),
    instructions: Array.isArray(trace.instructions)
      ? trace.instructions.filter((index): index is number => typeof index === "number")
      : [],
    edges: (Array.isArray(trace.branches) ? trace.branches : [])
      .filter(
        (edge): edge is [number, number] =>
          Array.isArray(edge) && typeof edge[0] === "number" && typeof edge[1] === "number",
      )
      .map(([from, to]) => [from, to] as const),
  };
}

/** A step before the state it reached is exported. */
type Settled = Omit<Step, "snapshot" | "tagged" | "runtime">;

/**
 * The project's plan with the engine, which runs inputs and records the instructions and condition ways they execute.
 * Coverage accumulates over every step of the session object, apart for play and for clock steps: a clock step
 * starts at another wall clock or follows a {@link isClockInput} input. A step goes on in the runtime session it is
 * given; its state is exported once, when the step has settled.
 */
export class Session {
  /** Instructions play executed. */
  readonly visited: Uint8Array;
  /** Instructions clock steps executed. */
  readonly clockVisited: Uint8Array;
  /** Per conditional instruction, the ways play took: 1 for the next instruction, 2 for its target. */
  readonly branches: Uint8Array;
  readonly clockBranches: Uint8Array;
  /** Instructions and condition ways only play with a chosen random outcome executed ("play (chosen random)"). */
  readonly chosenVisited: Uint8Array;
  readonly chosenBranches: Uint8Array;
  /**
   * With random choices, sessions pause no draw but let the explorer decide the draws of {@link RANDOM_KINDS}: natural
   * unless an input chose an outcome for its draw ID; and the step reports those draws, for the explorer to try others.
   */
  randomChoices = false;
  /** The outcomes the input being applied chose, by draw ID, and the draws the current step made. */
  readonly #decisions = new Map<number, Data>();
  /** The draws an input's chosen outcomes were taken at, while it is applied. */
  readonly #taken = new Set<number>();
  /** While an input with chosen outcomes is applied: the coverage marks it set, undone when it does not fit. */
  #marks: { array: Uint8Array; index: number; value: number }[] | null = null;
  #draws: Data[] = [];
  /** Answers directed search adds to the candidates of a typed ask, by the ask's instruction. */
  readonly directedAnswers = new Map<number, string[]>();
  /**
   * The expressions the code compares a typed ask's answer with (`comparedWith`), by the ask's instruction: their
   * values in the state at the ask are answers too, such as the line the script asks the player to type.
   */
  readonly comparedWith = new Map<number, readonly unknown[]>();
  /**
   * The player may think before pressing a button that the code times (see {@link thinkTimes}): the expressions a
   * timed button's result is compared with, by its instruction (`(showButton "Done") / 1 s > count`); and the
   * differences of clock reads compared with constants (`clockDifferences`), for the buttons between the two reads.
   */
  readonly timedWith = new Map<number, readonly unknown[]>();
  readonly clockDifferences: ClockDifference[] = [];
  /**
   * Whether values in a state are read as the running code sees them ({@link bindingsOf}, {@link valueOf}), as compared
   * answers need; otherwise, for timed buttons alone, as before them.
   */
  scopedReads = false;
  /**
   * Runtime operations called so far, a deterministic measure of the work the session's steps took: fresh sessions,
   * runs, inputs, and automatic answers, but not restoring, forking, exporting, or reading a state.
   */
  operations = 0;
  readonly #engine: Engine;
  readonly #plan: Data;
  readonly #instructions: Data[];
  readonly #seed: number;
  /** Per instruction, the constants it compares with; computed at the first ask. */
  #literals: Literals[] | undefined;

  constructor(engine: Engine, plan: Data, seed: number) {
    this.#engine = engine;
    this.#plan = plan;
    this.#instructions = list(plan.instructions);
    this.#seed = seed;
    this.visited = new Uint8Array(this.#instructions.length);
    this.clockVisited = new Uint8Array(this.#instructions.length);
    this.branches = new Uint8Array(this.#instructions.length);
    this.clockBranches = new Uint8Array(this.#instructions.length);
    this.chosenVisited = new Uint8Array(this.#instructions.length);
    this.chosenBranches = new Uint8Array(this.#instructions.length);
  }

  /** The options sessions are made with: with random choices, the control that decides the explorer's draws. */
  #options(): Data | undefined {
    if (!this.randomChoices) return undefined;
    return {
      randomControl: {
        filter: { kinds: RANDOM_KINDS },
        decide: (draw: Data) => {
          this.#draws.push(draw);
          const outcome =
            typeof draw.drawId === "number" ? this.#decisions.get(draw.drawId) : undefined;
          if (outcome === undefined) return { kind: "natural" };
          this.#taken.add(Number(draw.drawId));
          return { kind: "choose", outcome };
        },
      },
    };
  }

  /**
   * A fresh session, run until the player is first asked; a clock session at another wall clock than the play one, and
   * a `chosen` one after a session whose path chose a random outcome.
   */
  start(setup: Setup = PLAY_SETUP, chosen = false): Step {
    this.operations += 1;
    const runtime = this.#counted(
      this.#engine.createFreshRuntimeSession(
        this.#plan,
        {
          seed: this.#seed,
          baseDelayMs: 0,
          delayPerWordMs: 0,
          delayPerCharacterMs: 0,
          // The runtime keeps storage sorted by key.
          scriptStorage: [...setup.storage].sort((left, right) =>
            left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
          ),
          wallClockMs: setup.wallClockMs,
        },
        this.#options(),
      ),
    );
    this.#draws = [];
    return this.#reached(
      runtime,
      this.#settle(runtime, setup.clock ?? setup.wallClockMs !== EPOCH_MS, chosen),
    );
  }

  /** A session that goes on from a tagged state this session's engine exported: unchecked while its tag holds. */
  restoreTagged(tagged: TaggedSnapshot): Runtime {
    const options = this.#options();
    return this.#counted(
      options === undefined
        ? this.#engine.createTaggedRuntimeSession(this.#plan, tagged)
        : this.#engine.createTaggedRuntimeSession(this.#plan, tagged, options),
    );
  }

  /** A session that goes on from a stored state. */
  restore(snapshot: Data): Runtime {
    const options = this.#options();
    return this.#counted(
      options === undefined
        ? this.#engine.createRuntimeSession(this.#plan, snapshot)
        : this.#engine.createRuntimeSession(this.#plan, snapshot, options),
    );
  }

  /**
   * Applies one input to the waiting state of `runtime` and runs until the player is asked again; null when the
   * runtime rejects the input. Either way `runtime` goes on in place: to try other inputs from the same state, give
   * each a fork.
   */
  apply(runtime: Runtime, input: ExplorerInput, clock: boolean, chosen = false): Step | null {
    const settled = this.#apply(runtime, input, clock, chosen);
    return settled === null ? null : this.#reached(runtime, settled);
  }

  /** {@link apply} without exporting the state reached, to replay a path: whether the runtime accepted the input. */
  advance(runtime: Runtime, input: ExplorerInput, clock: boolean, chosen = false): boolean {
    return this.#apply(runtime, input, clock, chosen) !== null;
  }

  /**
   * The inputs the player has in the state of `runtime` (whose `view` it is); none in an ended state. `state` gives its
   * snapshot, for the values a typed answer is compared with ({@link comparedWith}); without it, those are left out.
   */
  options(runtime: Runtime, view: Data = runtime.view(), state?: () => Data): ExplorerInput[] {
    if (view.status !== "waiting") return [];
    const options: ExplorerInput[] = [];
    const action = record(view.foregroundAction);
    const until = this.#nextDeadline(runtime, view);
    if (action.kind === "interaction") {
      const ui = record(action.ui);
      const literals = this.#nearbyLiterals(runtime, action);
      const ask = typeof action.owningInstruction === "number" ? action.owningInstruction : null;
      const directed = ask === null ? [] : (this.directedAnswers.get(ask) ?? []);
      const expressions = ask === null ? undefined : this.comparedWith.get(ask);
      const compared =
        expressions === undefined || state === undefined
          ? []
          : comparedValues(expressions, state(), ui.kind === "number" ? ui.integer === true : null);
      options.push(
        ...interactionOptions(ui, literals, [...compared, ...directed], record(action.form)),
      );
      // A button whose result the script keeps is timed: the player may also think first, as long as nothing else
      // happens meanwhile. So is a button between two clock reads whose difference a condition compares, and one
      // whose result is compared with a value in the state.
      const kept =
        ui.kind === "button" &&
        action.expectedResult === "duration" &&
        action.destinationTemporary !== null;
      const timed = ui.kind === "button" ? this.#timedConstants(runtime, action, state) : null;
      if (kept || (timed !== null && timed.numbers.length + timed.durations.length > 0)) {
        const now = Number(view.observedSessionTimeMs);
        const constants = kept
          ? {
              numbers: [...literals.numbers, ...(timed?.numbers ?? [])],
              durations: [...literals.durations, ...(timed?.durations ?? [])],
            }
          : timed!;
        for (const afterMs of thinkTimes(constants)) {
          if (until === null || now + afterMs < until)
            options.push({ kind: "button", label: String(ui.buttonLabel), afterMs });
        }
      }
    }
    for (const button of runtime.project("permanentButtonProjection")) {
      if (button.busy !== true && typeof button.buttonId === "number")
        options.push({ kind: "press", buttonId: button.buttonId, label: String(button.text) });
    }
    if (until !== null) options.push({ kind: "wait", untilMs: until });
    return options;
  }

  /** The foreground interaction of a state in short: its kind and labels. */
  prompt(snapshot: Data): Prompt {
    const action = record(snapshot.foregroundAction);
    if (action.kind !== "interaction") {
      return { text: typeof action.kind === "string" ? `(${action.kind})` : "", instruction: null };
    }
    const ui = record(action.ui);
    const instruction =
      typeof action.owningInstruction === "number" ? action.owningInstruction : null;
    if (ui.kind === "button") return { text: `[${String(ui.buttonLabel)}]`, instruction };
    if (ui.kind === "choice") {
      const labels = list(ui.options).map((option) => `[${String(option.text)}]`);
      return { text: short(labels.join(" ")), instruction };
    }
    if (ui.kind === "form") {
      const labels = list(ui.fields).map((field) => `[${String(field.text)}]`);
      return { text: short(`(form) ${labels.join(" ")}`), instruction };
    }
    return {
      text: `(ask ${String(ui.kind)}${ui.integer === true ? " integer" : ""})`,
      instruction,
    };
  }

  /** Counts the operations of a session and of its forks. */
  #counted(runtime: Runtime): Runtime {
    return {
      ...runtime,
      call: (name, ...args) => {
        this.operations += 1;
        return runtime.call(name, ...args);
      },
      fork: () => this.#counted(runtime.fork()),
    };
  }

  #apply(runtime: Runtime, input: ExplorerInput, clock: boolean, chosen: boolean): Settled | null {
    // The outcomes the input chose, for the draws the step makes; play with them is play with chosen randomness.
    this.#decisions.clear();
    if (input.random !== undefined && !this.randomChoices)
      throw new Error("An input with chosen random outcomes needs a session with random choices.");
    for (const choice of input.random ?? []) this.#decisions.set(choice.drawId, choice.outcome);
    this.#taken.clear();
    this.#marks = input.random === undefined ? null : [];
    this.#draws = [];
    try {
      const settled = this.#input(runtime, runtime.view(), input)
        ? this.#settle(
            runtime,
            clock || isClockInput(input),
            chosen || (input.random?.length ?? 0) > 0,
          )
        : null;
      // The input did not fit as recorded unless each outcome it chose was drawn and taken, and no draw waits (the
      // runtime holds a draw whose chosen outcome it refused).
      if (
        settled !== null &&
        input.random !== undefined &&
        (input.random.some((choice) => !this.#taken.has(choice.drawId)) ||
          runtime.view().randomDraw != null)
      ) {
        for (const { array, index, value } of (this.#marks ?? []).toReversed())
          array[index] = value;
        return null;
      }
      return settled;
    } finally {
      this.#decisions.clear();
      this.#taken.clear();
      this.#marks = null;
    }
  }

  #reached(runtime: Runtime, settled: Settled): Step {
    const tagged = runtime.exportTaggedSnapshot();
    return { ...settled, snapshot: parseSnapshot(tagged.json), tagged, runtime };
  }

  /** Gives the session in the state `view` shows one input; whether the runtime accepted it. */
  #input(runtime: Runtime, view: Data, input: ExplorerInput): boolean {
    const action = record(view.foregroundAction);
    const completion = (payload: InteractionPayload) =>
      runtime.call(
        "completeAction",
        {
          actionId: action.actionId,
          actionKind: "interaction",
          interactionKind: action.interactionKind,
          payload,
        },
        { capturedMedia: { holds: (reference: string) => reference === EXPLORER_IMAGE } },
      );
    let result: Data;
    let accepted: string;
    switch (input.kind) {
      case "option":
        result = completion({ kind: "selectedOption", optionIndex: input.index });
        accepted = "completed";
        break;
      case "button": {
        if (input.afterMs !== undefined) {
          const until = Number(view.observedSessionTimeMs) + input.afterMs;
          const observed = runtime.call(
            "observeTime",
            until,
            this.#mediaReports(runtime, view, until),
          );
          if (record(observed.outcome).kind !== "observed") return false;
        }
        // The press answers the button shown before the player thought.
        result = completion({ kind: "activate" });
        accepted = "completed";
        break;
      }
      case "text":
        result = completion({ kind: "submittedText", submittedText: input.text });
        accepted = "completed";
        break;
      case "image":
        result = completion({ kind: "image", reference: EXPLORER_IMAGE });
        accepted = "completed";
        break;
      case "form":
        if (input.action === "submit" && !this.#fill(runtime, action, input.fields ?? {}))
          return false;
        result = completion({ kind: input.action });
        accepted = "completed";
        break;
      case "press":
        result = runtime.call("pressPermanentButton", input.buttonId);
        accepted = "pressed";
        break;
      case "wait":
        result = runtime.call(
          "observeTime",
          input.untilMs,
          this.#mediaReports(runtime, view, input.untilMs),
        );
        accepted = "observed";
        break;
      case "clock":
        result = runtime.call("recordContinueCapture", { wallClockMs: input.wallClockMs });
        accepted = "recorded";
        break;
      case "later":
        if (!(input.afterMs > 0 && Number.isSafeInteger(input.afterMs))) return false;
        result = runtime.call("recordContinueCapture", {
          wallClockMs: wallClockOf(runtime.exportTrustedSnapshot()) + input.afterMs,
        });
        accepted = "recorded";
        break;
    }
    return record(result.outcome).kind === accepted;
  }

  /** Sets the named fields of the pending form: a toggle or cycle by option index, a typed field by its text. */
  #fill(
    runtime: Runtime,
    action: Data,
    fields: Readonly<Record<string, number | string>>,
  ): boolean {
    const update = (edit: Data): boolean => {
      const result = runtime.call("updateInteraction", {
        actionId: action.actionId,
        actionKind: "interaction",
        interactionKind: "form",
        update: edit,
      });
      const outcome = record(result.outcome).kind;
      return outcome === "updated" || outcome === "unchanged";
    };
    for (const [fieldId, value] of Object.entries(fields)) {
      const done =
        typeof value === "number"
          ? update({ kind: "select", fieldId, optionIndex: value })
          : update({ kind: "edit", fieldId }) &&
            update({ kind: "draft", fieldId, text: value }) &&
            update({ kind: "commit", fieldId });
      if (!done) return false;
    }
    return true;
  }

  /**
   * Runs until the player is asked: answers camera requests, loads media, and lets time pass while nothing else can
   * happen. Records what ran as play or as clock coverage.
   */
  #settle(runtime: Runtime, clock: boolean, chosen: boolean): Settled {
    const texts: string[] = [];
    const executed = new Set<number>();
    const ways = new Set<number>();
    let newInstructions = 0;
    let view = runtime.view();
    let waits = 0;
    let forced = false;
    for (let operations = 0; ; operations += 1) {
      if (view.runnable === true) {
        const execution = execute(runtime);
        collectTexts(execution.events, texts);
        newInstructions += this.#record(execution, clock, chosen, executed, ways);
        view = runtime.view();
      }
      if (view.status !== "waiting" || operations >= MAX_AUTO_OPERATIONS) break;
      const action = record(view.foregroundAction);
      if (action.kind === "capture") {
        const result = runtime.call("completeAction", {
          actionId: action.actionId,
          actionKind: "capture",
          payload: { kind: "unavailable", reason: "unconfigured" },
        });
        if (record(result.outcome).kind !== "completed") break;
        view = runtime.view();
        continue;
      }
      const unloaded = runtime
        .project("mediaPlaybackProjection")
        .find((media) => media.loaded !== true);
      if (unloaded !== undefined) {
        const result = runtime.call("reportMediaLoad", unloaded.mediaId, {
          kind: "loaded",
          durationMs: MEDIA_PASS_MS,
        });
        if (record(result.outcome).kind !== "accepted") break;
        view = runtime.view();
        continue;
      }
      const options = this.options(runtime, view);
      if (options.length !== 1 || options[0]!.kind !== "wait") break;
      if (waits >= MAX_AUTO_WAITS) {
        forced = true;
        break;
      }
      if (!this.#input(runtime, view, options[0]!)) break;
      view = runtime.view();
      waits += 1;
    }
    return {
      newInstructions,
      instructions: [...executed],
      texts: texts.slice(-KEPT_TEXTS),
      ways: [...ways],
      draws: this.#draws,
      forced,
    };
  }

  /**
   * Marks an execution's instructions and condition ways as play or clock coverage, adds them to the step's, and counts
   * the instructions new to it: new to play for a play step, new to both for a clock one.
   */
  #record(
    execution: Execution,
    clock: boolean,
    chosen: boolean,
    executed: Set<number>,
    ways: Set<number>,
  ): number {
    const visited = clock ? this.clockVisited : chosen ? this.chosenVisited : this.visited;
    const branches = clock ? this.clockBranches : chosen ? this.chosenBranches : this.branches;
    let fresh = 0;
    for (const index of execution.instructions) {
      if (index < 0 || index >= visited.length) continue;
      if (visited[index] === 0 && ((!clock && !chosen) || this.visited[index] === 0)) fresh += 1;
      if (visited[index] === 0) this.#marks?.push({ array: visited, index, value: 0 });
      visited[index] = 1;
      executed.add(index);
    }
    for (const [from, to] of execution.edges) {
      const instruction = this.#instructions[from];
      if (instruction?.kind !== "jumpIfFalse" && instruction?.kind !== "loopStart") continue;
      const way = to === from + 1 ? 0 : to === instruction.target ? 1 : -1;
      if (way < 0) continue;
      this.#marks?.push({ array: branches, index: from, value: branches[from]! });
      branches[from]! |= way === 0 ? 1 : 2;
      ways.add(from * 2 + way);
    }
    return fresh;
  }

  /**
   * The constants the code compares with near an ask: around the asking instruction and around the return point of
   * every call that leads to it, nearest first, so that an ask in a helper function also gets its caller's constants.
   */
  #nearbyLiterals(runtime: Runtime, action: Data): Literals {
    this.#literals ??= this.#instructions.map(comparedLiterals);
    const positions = [
      action.owningInstruction,
      ...runtime.callReturnInstructions().toReversed(),
    ].filter((position): position is number => typeof position === "number");
    const found: Literals = { numbers: [], strings: [], durations: [] };
    for (let distance = 0; distance <= LITERAL_WINDOW; distance += 1) {
      for (const position of positions) {
        for (const index of distance === 0
          ? [position]
          : [position - distance, position + distance]) {
          const literals = this.#literals[index];
          if (literals === undefined) continue;
          for (const value of literals.numbers)
            if (!found.numbers.includes(value)) found.numbers.push(value);
          for (const value of literals.strings)
            if (!found.strings.includes(value)) found.strings.push(value);
          for (const value of literals.durations)
            if (!found.durations.includes(value)) found.durations.push(value);
        }
      }
    }
    return {
      numbers: found.numbers.slice(0, MAX_LITERALS),
      strings: found.strings.slice(0, MAX_LITERALS),
      durations: found.durations.slice(0, MAX_LITERALS),
    };
  }

  /**
   * The constants a button is timed against beyond its compared literals: those of the clock differences whose two
   * reads enclose it, or enclose where a call that leads to it returns; and the values, in the state (when `state`
   * gives it), of what a timed button's result is compared with.
   */
  #timedConstants(runtime: Runtime, action: Data, state?: () => Data): Constants | null {
    if (this.clockDifferences.length === 0 && this.timedWith.size === 0) return null;
    const found: Constants = { numbers: [], durations: [] };
    const positions = [
      action.owningInstruction,
      ...(this.clockDifferences.length === 0 ? [] : runtime.callReturnInstructions()),
    ].filter((position): position is number => typeof position === "number");
    for (const difference of this.clockDifferences) {
      if (!positions.some((position) => difference.from < position && position <= difference.at))
        continue;
      found.numbers.push(...difference.numbers);
      found.durations.push(...difference.durations);
    }
    const expressions =
      typeof action.owningInstruction === "number"
        ? this.timedWith.get(action.owningInstruction)
        : undefined;
    if (expressions !== undefined && state !== undefined) {
      const bindings = bindingsOf(state(), this.scopedReads);
      for (const expression of expressions) {
        const value = valueOf(expression, bindings, this.scopedReads);
        const duration = record(value);
        if (typeof value === "number") found.numbers.push(value);
        else if (duration.kind === "duration" && typeof duration.milliseconds === "number")
          found.durations.push(duration.milliseconds);
      }
    }
    return found;
  }

  /** The earliest time at which something happens without the player, or null when nothing will. */
  #nextDeadline(runtime: Runtime, view: Data): number | null {
    const now = typeof view.observedSessionTimeMs === "number" ? view.observedSessionTimeMs : 0;
    const deadlines: number[] = [];
    const add = (value: unknown) => {
      if (typeof value === "number") deadlines.push(value);
    };
    const action = record(view.foregroundAction);
    if (action.kind === "delay" || action.kind === "chatPacingGate") add(action.deadlineMs);
    if (action.kind === "interaction" && typeof action.timeoutMs === "number")
      add(Number(action.createdAtMs) + action.timeoutMs);
    for (const background of list(view.backgroundActions)) {
      if (background.kind === "chatPacingGate") add(background.deadlineMs);
      if (background.kind === "timer") add(record(background.timer).deadlineMs);
    }
    // The wait that a running timer, media, or button block interrupted.
    const suspended = record(view.suspendedAction);
    if (suspended.kind === "delay") add(suspended.deadlineMs);
    // Media plays on through every observation, and the runtime catches up on its cues and passes; a stop at the end
    // of a pass is needed only where the story waits for that media, or where nothing else will happen.
    const running = runtime
      .project("mediaPlaybackProjection")
      .filter((media) => media.state === "running" && media.loaded === true);
    const awaited = running.filter(
      (media) => action.kind === "mediaPlayback" && media.mediaId === action.mediaId,
    );
    for (const media of awaited.length > 0 || deadlines.length > 0 ? awaited : running) {
      const progress = typeof media.reportedProgressMs === "number" ? media.reportedProgressMs : 0;
      add(now + Math.max(1, MEDIA_PASS_MS - (progress % MEDIA_PASS_MS)));
    }
    return deadlines.length === 0 ? null : Math.max(now + 1, Math.min(...deadlines));
  }

  /** Progress of every running media until `until`, which plays on in real time. */
  #mediaReports(
    runtime: Runtime,
    view: Data,
    until: number,
  ): { mediaId: unknown; segment: unknown; progressMs: number }[] {
    const now = typeof view.observedSessionTimeMs === "number" ? view.observedSessionTimeMs : 0;
    return runtime
      .project("mediaPlaybackProjection")
      .filter((media) => media.state === "running" && media.loaded === true)
      .map((media) => ({
        mediaId: media.mediaId,
        segment: media.segment,
        progressMs:
          (typeof media.reportedProgressMs === "number" ? media.reportedProgressMs : 0) +
          until -
          now,
      }));
  }
}

function collectTexts(events: readonly Data[], texts: string[]): void {
  for (const event of events) {
    if (event.kind === "say" && typeof event.text === "string" && event.text.trim() !== "") {
      texts.push(short(event.text));
      if (texts.length > KEPT_TEXTS * 2) texts.splice(0, texts.length - KEPT_TEXTS);
    }
  }
}

const INTEGER_ANSWERS = ["0", "1", "-1", "1000000"];
const NUMBER_ANSWERS = [...INTEGER_ANSWERS, "0.5"];
const TEXT_ANSWERS = ["x"];
const TEMPORAL_ANSWERS: Readonly<Record<string, readonly string[]>> = {
  date: ["2026-10-02", "2026-01-01", "2026-12-31"],
  time: ["12:00", "00:00", "23:59"],
  datetime: ["2026-10-02T12:00", "2026-10-02T00:00", "2026-10-02T23:59"],
};

/** Constants an instruction compares with; durations in milliseconds. */
interface Literals extends Constants {
  numbers: number[];
  strings: string[];
  durations: number[];
}

/** Instructions searched on each side of an ask and of each return point for compared constants. */
const LITERAL_WINDOW = 40;
/** Compared constants tried per ask and type, nearest first. */
const MAX_LITERALS = 3;
const COMPARISONS = new Set(["==", "!=", "<", "<=", ">", ">="]);
/** Text methods whose literal argument an answer can match. */
const TEXT_TESTS = new Set(["contains", "startsWith", "endsWith", "equals", "equalsIgnoreCase"]);

/**
 * The literals an instruction's expressions compare with (`x < 10`, `answer == "yes"`, `answer.contains("no")`,
 * `beg < 15 s`).
 */
function comparedLiterals(instruction: Data): Literals {
  const found: Literals = { numbers: [], strings: [], durations: [] };
  const take = (value: unknown) => {
    const literal = record(value);
    if (literal.kind === "duration" && typeof literal.milliseconds === "number")
      found.durations.push(literal.milliseconds);
    if (literal.kind !== "literal") return;
    if (typeof literal.value === "number") found.numbers.push(literal.value);
    if (typeof literal.value === "string" && literal.value.trim() !== "")
      found.strings.push(literal.value);
  };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    if (!isRecord(value)) return;
    if (value.kind === "binary" && COMPARISONS.has(String(value.operator))) {
      take(value.left);
      take(value.right);
    }
    if (value.kind === "call" && TEXT_TESTS.has(String(record(value.callee).name))) {
      for (const argument of list(value.arguments)) take(argument.value);
    }
    for (const [key, item] of Object.entries(value)) if (key !== "span") walk(item);
  };
  walk(instruction);
  return found;
}

/** Values a typed answer is compared with, tried per ask. */
const MAX_COMPARED_VALUES = 3;

/**
 * The values of compared expressions in a state, as answers to a typed ask: texts for a text ask (`integer` null); for a
 * number ask (`integer` tells whether it takes integers only), each number `v` as `v - 1`, `v`, and `v + 1`. Variables
 * are read from their innermost binding.
 */
function comparedValues(
  expressions: readonly unknown[],
  snapshot: Data,
  integer: boolean | null,
): string[] {
  const bindings = bindingsOf(snapshot, true);
  const found = new Set<string>();
  for (const expression of expressions) {
    const value = valueOf(expression, bindings, true);
    if (integer === null && typeof value === "string" && value.trim() !== "") found.add(value);
    if (integer !== null && typeof value === "number" && (!integer || Number.isSafeInteger(value)))
      for (const near of [value - 1, value, value + 1]) found.add(String(near));
    if (found.size >= MAX_COMPARED_VALUES) break;
  }
  return [...found];
}

/**
 * The variables of a state by name. `scoped`: those the running code sees, each by its innermost binding: the scopes of
 * the active call, the variables it captured (a timer, media, or button block keeps them), the scope it was declared
 * in, and the globals. Otherwise every scope's, the innermost last, and the globals.
 */
function bindingsOf(snapshot: Data, scoped: boolean): Map<string, unknown> {
  const bindings = new Map<string, unknown>();
  const take = (scope: Data | undefined) => {
    for (const binding of list(scope?.bindings))
      if (typeof binding.name === "string") bindings.set(binding.name, binding.value);
  };
  for (const binding of list(snapshot.globals))
    if (typeof binding.name === "string") bindings.set(binding.name, binding.value);
  const frames = list(snapshot.frames);
  const call = list(snapshot.callFrames).at(-1);
  if (!scoped || call === undefined) {
    for (const frame of frames) take(frame);
    return bindings;
  }
  const scopes = new Map(
    [...frames, ...list(snapshot.retainedScopes)].map((scope) => [scope.id, scope]),
  );
  take(scopes.get(call.rootScopeId));
  for (const capture of list(call.captures)) {
    const binding = list(scopes.get(capture.scopeId)?.bindings).find(
      (entry) => entry.name === capture.name,
    );
    if (binding !== undefined && typeof capture.name === "string")
      bindings.set(capture.name, binding.value);
  }
  for (const frame of frames.slice(Number(call.scopeBaseDepth) || 0)) take(frame);
  return bindings;
}

/** A runtime value as the explorer reads it: a scalar, a composite record, or undefined for none it can read. */
type ReadValue = string | number | boolean | null | Data | undefined;

function readValue(value: unknown): ReadValue {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
    ? value
    : isRecord(value)
      ? value
      : undefined;
}

/** An expression's value in a state, from its variables' values, or undefined when it cannot be read. */
function valueOf(
  expression: unknown,
  bindings: ReadonlyMap<string, unknown>,
  current: boolean,
): ReadValue {
  const value = record(expression);
  switch (value.kind) {
    case "literal":
      return readValue(value.value);
    case "identifier":
      return typeof value.name === "string" ? readValue(bindings.get(value.name)) : undefined;
    case "group":
      return valueOf(value.expression, bindings, current);
    case "unary": {
      const operand = valueOf(value.operand, bindings, current);
      return value.operator === "-" && typeof operand === "number" ? -operand : undefined;
    }
    case "binary": {
      const left = valueOf(value.left, bindings, current);
      const right = valueOf(value.right, bindings, current);
      if (value.operator === "+" && typeof left === "string" && typeof right === "string")
        return left + right;
      if (typeof left !== "number" || typeof right !== "number") return undefined;
      switch (value.operator) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return right === 0 ? undefined : left / right;
        case "%":
          return right === 0 ? undefined : left % right;
        default:
          return undefined;
      }
    }
    case "property": {
      const object = valueOf(value.object, bindings, current);
      const holder = record(object);
      // Read as before compared answers: the length of a text or list, else an object's property.
      if (!current)
        return value.name === "length"
          ? typeof object === "string"
            ? [...object].length
            : Array.isArray(holder.items)
              ? holder.items.length
              : undefined
          : readValue(
              (holder.kind === "object" ? list(holder.properties) : []).find(
                (property) => property.name === value.name,
              )?.value,
            );
      // An object's property by name, also one named `length`; the length of a text, list, set, or dict.
      if (holder.kind === "object")
        return readValue(
          list(holder.properties).find((property) => property.name === value.name)?.value,
        );
      if (value.name !== "length") return undefined;
      if (typeof object === "string") return [...object].length;
      if (Array.isArray(holder.items)) return holder.items.length;
      return Array.isArray(holder.entries) ? holder.entries.length : undefined;
    }
    case "index": {
      const object = record(valueOf(value.object, bindings, current));
      const index = valueOf(value.index, bindings, current);
      if (object.kind === "list" && typeof index === "number" && Array.isArray(object.items))
        return current && (!Number.isSafeInteger(index) || index < 0)
          ? undefined
          : readValue(object.items.at(index));
      if (object.kind === "dict" && typeof index === "string")
        return readValue(list(object.entries).find((entry) => entry.key === index)?.value);
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Think times before a timed button: just past each compared number, read as seconds, and each compared duration, in
 * whole seconds; {@link THINK_MS} without one.
 */
function thinkTimes(literals: Constants): number[] {
  const seconds = [
    ...literals.numbers,
    ...literals.durations.map((milliseconds) => milliseconds / 1000),
  ].filter((value) => value >= 1 && value <= 3600);
  return seconds.length === 0
    ? [THINK_MS]
    : [...new Set(seconds.map((value) => (Math.floor(value) + 1) * 1000))];
}

/**
 * The answers tried for an interaction: every button and option; for typed asks the default (the prefilled answer),
 * boundary values of the field type, the constants the code compares with nearby (for a number `c`: `c - 1`, `c`, and
 * `c + 1`), and the answers directed search added for this ask. Blank text is never an answer, so it is not tried.
 */
function interactionOptions(
  ui: Data,
  literals: Literals,
  directed: readonly string[],
  form: Data,
): ExplorerInput[] {
  const typed = (candidates: readonly string[]): ExplorerInput[] =>
    [
      ...new Set([
        ...(typeof ui.prefill === "string" ? [ui.prefill] : []),
        ...candidates,
        ...directed,
      ]),
    ].map((text) => ({ kind: "text", text }));
  const near = (integer: boolean) =>
    literals.numbers
      .filter((value) => !integer || Number.isSafeInteger(value))
      .flatMap((value) => [value - 1, value, value + 1])
      .map(String);
  switch (ui.kind) {
    case "button":
      return [{ kind: "button", label: String(ui.buttonLabel) }];
    case "choice":
      return list(ui.options).map((option, index) => ({
        kind: "option",
        index,
        label: String(option.text),
      }));
    case "text":
      return typed([...TEXT_ANSWERS, ...literals.strings]);
    case "number":
      return typed([
        ...(ui.integer === true ? INTEGER_ANSWERS : NUMBER_ANSWERS),
        ...near(ui.integer === true),
      ]);
    case "temporal":
      return typed(TEMPORAL_ANSWERS[String(ui.temporalKind)] ?? []);
    case "image":
      return [{ kind: "image" }];
    case "form":
      return formOptions(ui, form);
    default:
      return [];
  }
}

/**
 * The answers tried for a form: its starting values; each toggle switched, and all toggles on and all off; each other
 * option of a cycle; each typed field at its boundaries (`min`, `max`, or the candidates of its type); and cancel
 * where the form offers it. A required typed field without a starting value gets its first candidate in every answer.
 */
function formOptions(ui: Data, form: Data): ExplorerInput[] {
  const fields = list(ui.fields);
  const values: unknown[] = Array.isArray(form.values) ? form.values : [];
  const optionIndex = (field: Data, wanted: unknown): number => {
    const options = list(field.options);
    if (field.kind === "boolean" && options.length === 0) return wanted === true ? 1 : 0;
    return options.findIndex((option) => option.value === wanted);
  };
  const candidatesOf = (field: Data): readonly string[] => {
    const bounded = [field.min, field.max].filter((value) => typeof value === "number").map(String);
    switch (field.kind) {
      case "integer":
        return [...bounded, ...INTEGER_ANSWERS];
      case "number":
        return [...bounded, ...NUMBER_ANSWERS];
      case "text":
        return TEXT_ANSWERS;
      default:
        return TEMPORAL_ANSWERS[String(field.kind)] ?? [];
    }
  };
  const base: Record<string, number | string> = {};
  fields.forEach((field, index) => {
    const typed = field.kind !== "boolean" && field.kind !== "cycle";
    if (typed && field.optional !== true && (values[index] ?? null) === null) {
      const first = candidatesOf(field)[0];
      if (first !== undefined) base[String(field.id)] = first;
    }
  });
  const answers: Record<string, number | string>[] = [{ ...base }];
  const toggles = fields.filter((field) => field.kind === "boolean");
  fields.forEach((field, index) => {
    const id = String(field.id);
    if (field.kind === "boolean") {
      const flipped = optionIndex(field, values[index] !== true);
      if (flipped >= 0) answers.push({ ...base, [id]: flipped });
    } else if (field.kind === "cycle") {
      list(field.options).forEach((_, option) => {
        if (option !== optionIndex(field, values[index])) answers.push({ ...base, [id]: option });
      });
    } else {
      for (const candidate of candidatesOf(field)) answers.push({ ...base, [id]: candidate });
    }
  });
  if (toggles.length > 1) {
    for (const wanted of [true, false]) {
      const all: Record<string, number | string> = { ...base };
      for (const field of toggles) all[String(field.id)] = optionIndex(field, wanted);
      answers.push(all);
    }
  }
  const unique = new Map(answers.map((fields) => [JSON.stringify(fields), fields]));
  const options: ExplorerInput[] = [...unique.values()]
    .slice(0, MAX_FORM_OPTIONS - 1)
    .map((fields) =>
      Object.keys(fields).length === 0
        ? { kind: "form", action: "submit" }
        : { kind: "form", action: "submit", fields },
    );
  if (isRecord(ui.cancel)) options.push({ kind: "form", action: "cancel" });
  return options;
}

/** Counters and records no script can observe: event sequence numbers, the next free IDs, and the last settlement. */
const UNOBSERVABLE_KEYS = new Set([
  "nextEventSequence",
  "requestEventSequence",
  "completionEventSequence",
  "transcriptEventSequence",
  "warningEventSequence",
  "sinceEventSequence",
  "nextActionId",
  "nextScopeId",
  "nextCallFrameId",
  "nextTimerId",
  "nextMediaId",
  "nextPermanentButtonId",
  "lastSettlement",
  // How many random outcomes were chosen: the script cannot see it, and the explorer pauses at no draw.
  "randomControl",
]);
/** IDs the runtime hands out as it goes; only their equality and order matter, so they are renumbered by rank. */
const ID_FAMILIES: Readonly<Record<string, string>> = {
  actionId: "action",
  rootScopeId: "scope",
  handlerRootScopeId: "scope",
  callFrameId: "call",
  ownerCallFrameId: "call",
  timerId: "timer",
  mediaId: "media",
  videoMediaId: "media",
  buttonId: "button",
};
/** Also left out of the loop key: the random state and handles kept only so they stay readable. */
const LOOP_IGNORED_KEYS = new Set(["rng", "settledTimers", "settledMedia"]);

function idFamily(holder: unknown, key: string): string | undefined {
  // A scope frame has bindings; a call frame has a return instruction. Other `id`s are plan or speaker IDs.
  if (key === "id" && isRecord(holder))
    return "bindings" in holder ? "scope" : "returnInstruction" in holder ? "call" : undefined;
  return ID_FAMILIES[key];
}

/**
 * Two hashes of a snapshot. The state key leaves out only what no script can observe (see {@link UNOBSERVABLE_KEYS})
 * and renumbers the runtime's IDs, so two states with the same key behave alike; it keeps the clock, which scripts can
 * read. The loop key also leaves out every time (`…Ms`), the random state, and settled handles: a heuristic that
 * makes the iterations of a loop that waits, or picks at random, look alike.
 */
export function stateKeys(snapshot: Data): { readonly state: string; readonly loop: string } {
  const ids = new Map<string, Set<number>>();
  const collect = (value: unknown, holder: unknown, key: string): void => {
    if (Array.isArray(value)) for (const item of value) collect(item, value, "");
    else if (isRecord(value))
      for (const [name, item] of Object.entries(value)) collect(item, value, name);
    else if (typeof value === "number") {
      const family = idFamily(holder, key);
      if (family !== undefined) {
        const values = ids.get(family) ?? new Set();
        values.add(value);
        ids.set(family, values);
      }
    }
  };
  collect(snapshot, null, "");
  const ranks = new Map<string, Map<number, number>>();
  for (const [family, values] of ids)
    ranks.set(
      family,
      new Map([...values].sort((a, b) => a - b).map((value, rank) => [value, rank])),
    );
  const key = (loop: boolean) =>
    createHash("sha1")
      .update(
        JSON.stringify(snapshot, function (this: unknown, name: string, value: unknown) {
          if (UNOBSERVABLE_KEYS.has(name)) return undefined;
          if (loop && (name.endsWith("Ms") || LOOP_IGNORED_KEYS.has(name))) return undefined;
          if (typeof value === "number") {
            const family = idFamily(this, name);
            if (family !== undefined) return ranks.get(family)?.get(value) ?? value;
          }
          return value;
        }),
      )
      .digest("base64");
  // The loop key only for a state not seen before: a known state's is known.
  let loop: string | null = null;
  return {
    state: key(false),
    get loop() {
      loop ??= key(true);
      return loop;
    },
  };
}

/** A snapshot read back from the JSON the runtime wrote. */
export function parseSnapshot(json: string): Data {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) throw new Error("A snapshot's JSON is not an object.");
  return value;
}

/** A runtime failure as a report shows it, with one-based lines and columns. */
export function failureOf(snapshot: Data) {
  const failure = record(snapshot.failure);
  const span = record(failure.span);
  const start = record(span.start);
  const end = record(span.end);
  const position = (value: unknown) => (typeof value === "number" ? value + 1 : 0);
  return {
    code: typeof failure.code === "string" ? failure.code : "UNKNOWN",
    message: typeof failure.message === "string" ? failure.message : "",
    path: typeof failure.path === "string" ? failure.path : "",
    line: position(start.line),
    column: position(start.column),
    endLine: position(end.line),
    endColumn: position(end.column),
  };
}

/** One step of a replayed path, for a transcript. */
export interface ReplayStep {
  readonly input: ExplorerInput | null;
  readonly texts: readonly string[];
  readonly prompt: string;
  readonly status: string;
}

/**
 * Replays a path: each earlier session from the storage the one before it left (the first from none), then the input
 * list of the last one; the steps are those of the last session. An operation that throws ends the replay with its
 * `error`, at the state the last step before it reached.
 */
export function replay(
  engine: Engine,
  plan: Data,
  seed: number,
  inputs: readonly ExplorerInput[],
  path: { readonly earlier?: readonly SessionPath[]; readonly wallClockMs?: number } = {},
): {
  steps: ReplayStep[];
  snapshot: Data;
  failure: ReturnType<typeof failureOf> | null;
  error: string | null;
  /** How each earlier session ended: `halted` when it completed, else where the player quit (`waiting`). */
  earlier: string[];
} {
  const session = new Session(engine, plan, seed);
  // A path with chosen random outcomes replays them; its other draws stay natural, as without control.
  session.randomChoices = [...(path.earlier ?? []).map((earlier) => earlier.inputs), inputs].some(
    (list) => list.some((input) => input.random !== undefined),
  );
  let storage: readonly StorageEntry[] = [];
  const run = (wallClockMs: number, list: readonly ExplorerInput[], record: boolean) => {
    let step = session.start({ storage, wallClockMs });
    let clock = wallClockMs !== EPOCH_MS;
    const describe = (input: ExplorerInput | null, current: Step): ReplayStep => ({
      input,
      texts: current.texts,
      prompt: session.prompt(current.snapshot).text,
      status: String(current.snapshot.status),
    });
    const steps = record ? [describe(null, step)] : [];
    let error: string | null = null;
    for (const input of list) {
      let next: Step | null;
      try {
        next = session.apply(step.runtime, input, clock);
      } catch (thrown) {
        // The throw ended the runtime session; `step` keeps the state it exported before.
        error = String(thrown);
        break;
      }
      if (next === null)
        throw new Error(
          `The runtime rejected input ${JSON.stringify(input)} at step ${steps.length}.`,
        );
      clock ||= isClockInput(input);
      step = next;
      if (record) steps.push(describe(input, step));
    }
    return { step, steps, error };
  };
  const ends: string[] = [];
  for (const earlier of path.earlier ?? []) {
    const done = run(earlier.wallClockMs ?? EPOCH_MS, earlier.inputs, false);
    if (done.error !== null)
      return {
        steps: [],
        snapshot: done.step.snapshot,
        failure: null,
        error: done.error,
        earlier: ends,
      };
    ends.push(String(done.step.snapshot.status));
    storage = storageOf(done.step.snapshot);
  }
  const last = run(path.wallClockMs ?? EPOCH_MS, inputs, true);
  return {
    steps: last.steps,
    snapshot: last.step.snapshot,
    failure: last.step.snapshot.status === "failed" ? failureOf(last.step.snapshot) : null,
    error: last.error,
    earlier: ends,
  };
}
