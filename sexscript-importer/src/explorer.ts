import { createHash } from "node:crypto";
import { isRecord } from "./ast.ts";
import { repositoryBuildUrl } from "./repository-build.ts";

/**
 * The session layer of the headless branch explorer: it runs a compiled TeaseScript project in the real runtime,
 * without the Player, applies one input at a time, and records what each step executed. The search over these steps
 * lives in `explorer-search.ts`.
 *
 * Each pending action is a branch point; its options are the buttons and choice options, typed answers
 * ({@link interactionOptions}), form answers, thinking before a timed button, permanent buttons, and letting time
 * pass to the next deadline. Directed search adds answers per ask and two seeded inputs: a stored value set from
 * outside, and a later wall clock. Media loads succeed with one second per pass, `takePhoto` finds no camera, and
 * `askImage` gets one stored image. When letting time pass is the only thing the player can do, the explorer does it
 * as part of the previous step (at most {@link MAX_AUTO_WAITS} times in a row).
 *
 * Execution is deterministic: a state is reproduced by the seed, the start {@link Setup}, and its input list
 * ({@link replay}).
 */

/** A runtime operation result read field by field; plans and snapshots inside it are passed back unchanged. */
export type Data = Readonly<Record<string, unknown>>;

const ENGINE_OPERATIONS = [
  "compileProject",
  "createFreshRuntimeSnapshot",
  "run",
  "executeInstruction",
  "completeAction",
  "updateInteraction",
  "observeTime",
  "reportMediaLoad",
  "pressPermanentButton",
  "applyExternalStorageEdit",
  "recordContinueCapture",
] as const;
const ENGINE_PROJECTIONS = ["mediaPlaybackProjection", "permanentButtonProjection"] as const;

/** The runtime operations the explorer drives, as `runtime-check.ts` reads them: each result must be an object. */
export interface Engine {
  call: (name: (typeof ENGINE_OPERATIONS)[number], ...args: unknown[]) => Data;
  /** The records of a projection of a snapshot, such as the playback of its media. */
  project: (name: (typeof ENGINE_PROJECTIONS)[number], snapshot: Data) => Data[];
}

const repositoryIndexUrl = repositoryBuildUrl("src/index.js");

/** Loads the runtime operations from the repository build (`npm run build:typescript`, or `TEASESCRIPT_DIST`). */
export async function loadEngine(): Promise<Engine> {
  const module: unknown = await import(repositoryIndexUrl.href);
  const exported = (name: string) => {
    const value = isRecord(module) ? module[name] : undefined;
    if (typeof value !== "function") throw new Error(`Repository build does not export ${name}().`);
    return value;
  };
  const functions = new Map(
    [...ENGINE_OPERATIONS, ...ENGINE_PROJECTIONS].map((name) => [name, exported(name)]),
  );
  return {
    call: (name, ...args) => {
      const operation = functions.get(name);
      if (operation === undefined) throw new Error(`Unknown runtime operation ${name}.`);
      const value: unknown = operation(...args);
      if (!isRecord(value)) throw new Error(`${name}() returned an unexpected result shape.`);
      return value;
    },
    project: (name, snapshot) => {
      const projection = functions.get(name);
      if (projection === undefined) throw new Error(`Unknown runtime projection ${name}.`);
      const value: unknown = projection(snapshot);
      return Array.isArray(value) ? value.filter(isRecord) : [];
    },
  };
}

/** A value to store: a scalar, or a composite value as the runtime keeps it in script storage. */
export type StoredValue = string | number | boolean | Data;

/** One input of a path from the start; `label` fields only explain the input to a reader. */
export type ExplorerInput =
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
  /** Seeded: a stored value set from outside, as an earlier session would have left it; `null` removes the key. */
  | { readonly kind: "storage"; readonly key: string; readonly value: StoredValue | null }
  /** Seeded: the player continues at another wall clock time (epoch milliseconds). */
  | { readonly kind: "clock"; readonly wallClockMs: number };

/** Whether an input prepares state the player cannot make by playing: a seeded input. */
export function isSeeding(input: ExplorerInput): boolean {
  return input.kind === "storage" || input.kind === "clock";
}

/**
 * How a session starts: the storage an earlier session left, and the wall clock. Play starts with empty storage at
 * {@link EPOCH_MS}; any other start is seeded.
 */
export interface Setup {
  readonly storage: readonly { readonly key: string; readonly value: StoredValue }[];
  readonly wallClockMs: number;
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
/**
 * Without the runtime's instruction trace: instructions an execution records one by one without reaching one for the
 * first time, before it finishes with `run`, so that a long loop over known code is not stepped again.
 */
const TRACE_PATIENCE = 200;
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
  readonly snapshot: Data;
  /** Instructions this step executed for the first time, for its kind of coverage (see {@link Session}). */
  readonly newInstructions: number;
  /** The last texts said during the step. */
  readonly texts: readonly string[];
  /**
   * The condition ways the step took, each as `instruction * 2 + way`: way 0 continues with the next instruction (a
   * condition was true, a loop entered), way 1 goes to the instruction's target.
   */
  readonly ways: readonly number[];
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

/** What one execution ran, until nothing was runnable, as one `run` would have. */
interface Execution {
  readonly snapshot: Data;
  readonly events: readonly Data[];
  /** The instructions it recorded as executed, each once. */
  readonly instructions: readonly number[];
  /** The instruction transitions it recorded: from an instruction to the next one executed. */
  readonly edges: readonly (readonly [number, number])[];
}

/**
 * Records what an execution ran. With the runtime's instruction trace (`docs/RUNTIME.md#instruction-trace`) an
 * execution is one `run` with `instructionTrace: true`, whose trace lists every instruction it executed, a failing one
 * included, and the successor each condition, loop, transfer, and `end` took. A build without the trace ignores the
 * option and returns no trace; then the recorder runs the execution again instruction by instruction with
 * `executeInstruction` and keeps doing so. In that fallback, once {@link TRACE_PATIENCE} instructions in a row were
 * known (reached before, or earlier in this execution), it finishes with `run` and records nothing more. Both keep the
 * product's instruction budget per run, and so `TSR037` where the Player has it.
 */
class Recorder {
  /** Fallback runs finished with `run`, without recording their instructions, after {@link TRACE_PATIENCE} known ones. */
  untracedRuns = 0;
  /** Whether the runtime returns an instruction trace; unknown until the first run. */
  #traced: boolean | null = null;
  readonly #engine: Engine;
  readonly #plan: Data;

  constructor(engine: Engine, plan: Data) {
    this.#engine = engine;
    this.#plan = plan;
  }

  /** How executions are recorded: by the runtime's trace, or step by step without one. */
  get recording(): "trace" | "steps" | null {
    return this.#traced === null ? null : this.#traced ? "trace" : "steps";
  }

  execute(start: Data, known: (index: number) => boolean): Execution {
    if (!runnable(start)) return { snapshot: start, events: [], instructions: [], edges: [] };
    if (this.#traced !== false) {
      const result = this.#engine.call(
        "run",
        this.#plan,
        start,
        {},
        { instructionBudget: INSTRUCTION_BUDGET, instructionTrace: true },
      );
      const trace = result.instructionTrace;
      if (isRecord(trace)) {
        this.#traced = true;
        return {
          snapshot: record(result.snapshot),
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
      this.#traced = false;
    }
    return this.#step(start, known);
  }

  /** An instruction boundary that only starts a queued timer, cue, or button block executes no instruction of its own. */
  #step(start: Data, known: (index: number) => boolean): Execution {
    const events: Data[] = [];
    const executed = new Set<number>();
    const edges: (readonly [number, number])[] = [];
    let snapshot = start;
    let quiet = 0;
    for (let steps = 0; runnable(snapshot);) {
      if (quiet >= TRACE_PATIENCE) {
        this.untracedRuns += 1;
        const result = this.#engine.call(
          "run",
          this.#plan,
          snapshot,
          {},
          { instructionBudget: INSTRUCTION_BUDGET - steps },
        );
        events.push(...list(result.events));
        snapshot = record(result.snapshot);
        break;
      }
      const before = typeof snapshot.nextInstruction === "number" ? snapshot.nextInstruction : -1;
      const interrupts = interruptFrames(snapshot);
      const result = this.#engine.call("executeInstruction", this.#plan, snapshot, {});
      const count =
        typeof result.instructionsExecuted === "number" ? result.instructionsExecuted : 0;
      // Nothing was runnable; `run` would not have executed this boundary, nor settled due work after it.
      if (count === 0 || !isRecord(result.snapshot)) break;
      const after = result.snapshot;
      events.push(...list(result.events));
      if (before >= 0 && interruptFrames(after) <= interrupts) {
        if (known(before) || executed.has(before)) quiet += 1;
        else quiet = 0;
        executed.add(before);
        if (after.status !== "failed" && typeof after.nextInstruction === "number")
          edges.push([before, after.nextInstruction]);
      }
      snapshot = after;
      steps += count;
    }
    return { snapshot, events, instructions: [...executed], edges };
  }
}

/** What `run` would find runnable: a waiting session runs only to start a queued block. */
function runnable(snapshot: Data): boolean {
  return (
    snapshot.status === "ready" ||
    snapshot.status === "running" ||
    (snapshot.status === "waiting" && list(snapshot.pendingTimerHandlers).length > 0)
  );
}

/**
 * The project's plan with the engine, which runs inputs and records the instructions and condition ways they execute.
 * Coverage accumulates over every step of the session object, apart for play and for seeded steps: a seeded step
 * starts from a seeded {@link Setup} or follows a seeded input.
 */
export class Session {
  /** Instructions play executed. */
  readonly visited: Uint8Array;
  /** Instructions seeded steps executed. */
  readonly seededVisited: Uint8Array;
  /** Per conditional instruction, the ways play took: 1 for the next instruction, 2 for its target. */
  readonly branches: Uint8Array;
  readonly seededBranches: Uint8Array;
  /** Answers directed search adds to the candidates of a typed ask, by the ask's instruction. */
  readonly directedAnswers = new Map<number, string[]>();
  readonly #engine: Engine;
  readonly #plan: Data;
  readonly #instructions: Data[];
  readonly #seed: number;
  readonly #recorder: Recorder;
  /** Per instruction, the constants it compares with; computed at the first ask. */
  #literals: Literals[] | undefined;

  constructor(engine: Engine, plan: Data, seed: number) {
    this.#engine = engine;
    this.#plan = plan;
    this.#instructions = list(plan.instructions);
    this.#seed = seed;
    this.#recorder = new Recorder(engine, plan);
    this.visited = new Uint8Array(this.#instructions.length);
    this.seededVisited = new Uint8Array(this.#instructions.length);
    this.branches = new Uint8Array(this.#instructions.length);
    this.seededBranches = new Uint8Array(this.#instructions.length);
  }

  get untracedRuns(): number {
    return this.#recorder.untracedRuns;
  }

  /** How executions are recorded: by the runtime's instruction trace, or step by step on a build without it. */
  get recording(): "trace" | "steps" | null {
    return this.#recorder.recording;
  }

  /** A fresh session, run until the player is first asked; seeded unless `setup` is the play setup. */
  start(setup: Setup = PLAY_SETUP): Step {
    const fresh = this.#engine.call("createFreshRuntimeSnapshot", this.#plan, {
      seed: this.#seed,
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
      // The runtime keeps storage sorted by key.
      scriptStorage: [...setup.storage].sort((left, right) =>
        left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
      ),
      wallClockMs: setup.wallClockMs,
    });
    return this.#settle(fresh, setup !== PLAY_SETUP);
  }

  /** Applies one input to a waiting state; null when the runtime rejects it. */
  apply(snapshot: Data, input: ExplorerInput, seeded: boolean): Step | null {
    const next = this.#input(snapshot, input);
    return next === null ? null : this.#settle(next, seeded || isSeeding(input));
  }

  /** The inputs the player has in a waiting state; none in an ended state. */
  options(snapshot: Data): ExplorerInput[] {
    if (snapshot.status !== "waiting") return [];
    const options: ExplorerInput[] = [];
    const action = record(snapshot.foregroundAction);
    const until = this.#nextDeadline(snapshot);
    if (action.kind === "interaction") {
      const ui = record(action.ui);
      const literals = this.#nearbyLiterals(snapshot, action);
      const directed =
        typeof action.owningInstruction === "number"
          ? (this.directedAnswers.get(action.owningInstruction) ?? [])
          : [];
      options.push(...interactionOptions(ui, literals, directed, record(action.form)));
      // A button whose result the script keeps is timed: the player may also think first, as long as nothing else
      // happens meanwhile.
      if (
        ui.kind === "button" &&
        action.expectedResult === "duration" &&
        action.destinationTemporary !== null
      ) {
        const now = Number(snapshot.observedSessionTimeMs);
        for (const afterMs of thinkTimes(literals)) {
          if (until === null || now + afterMs < until)
            options.push({ kind: "button", label: String(ui.buttonLabel), afterMs });
        }
      }
    }
    for (const button of this.#engine.project("permanentButtonProjection", snapshot)) {
      if (button.busy !== true && typeof button.buttonId === "number")
        options.push({ kind: "press", buttonId: button.buttonId, label: String(button.text) });
    }
    if (until !== null) options.push({ kind: "wait", untilMs: until });
    return options;
  }

  /** The foreground interaction in short: its kind and labels. */
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

  #input(snapshot: Data, input: ExplorerInput): Data | null {
    const plan = this.#plan;
    const action = record(snapshot.foregroundAction);
    const completion = (payload: InteractionPayload, from = snapshot) =>
      this.#engine.call(
        "completeAction",
        plan,
        from,
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
        let from = snapshot;
        if (input.afterMs !== undefined) {
          const until = Number(snapshot.observedSessionTimeMs) + input.afterMs;
          const observed = this.#engine.call(
            "observeTime",
            plan,
            snapshot,
            until,
            this.#mediaReports(snapshot, until),
          );
          if (record(observed.outcome).kind !== "observed" || !isRecord(observed.snapshot))
            return null;
          from = observed.snapshot;
        }
        result = completion({ kind: "activate" }, from);
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
      case "form": {
        const filled =
          input.action === "submit" ? this.#fill(snapshot, action, input.fields ?? {}) : snapshot;
        if (filled === null) return null;
        result = completion({ kind: input.action }, filled);
        accepted = "completed";
        break;
      }
      case "press":
        result = this.#engine.call("pressPermanentButton", plan, snapshot, input.buttonId);
        accepted = "pressed";
        break;
      case "wait":
        result = this.#engine.call(
          "observeTime",
          plan,
          snapshot,
          input.untilMs,
          this.#mediaReports(snapshot, input.untilMs),
        );
        accepted = "observed";
        break;
      case "storage":
        result = this.#engine.call("applyExternalStorageEdit", plan, snapshot, {
          key: input.key,
          value: input.value,
        });
        accepted = "applied";
        break;
      case "clock":
        result = this.#engine.call("recordContinueCapture", plan, snapshot, {
          wallClockMs: input.wallClockMs,
        });
        accepted = "recorded";
        break;
    }
    return record(result.outcome).kind === accepted && isRecord(result.snapshot)
      ? result.snapshot
      : null;
  }

  /** Sets the named fields of the pending form: a toggle or cycle by option index, a typed field by its text. */
  #fill(
    snapshot: Data,
    action: Data,
    fields: Readonly<Record<string, number | string>>,
  ): Data | null {
    let current = snapshot;
    const update = (edit: Data): boolean => {
      const result = this.#engine.call("updateInteraction", this.#plan, current, {
        actionId: action.actionId,
        actionKind: "interaction",
        interactionKind: "form",
        update: edit,
      });
      const outcome = record(result.outcome).kind;
      if ((outcome !== "updated" && outcome !== "unchanged") || !isRecord(result.snapshot))
        return false;
      current = result.snapshot;
      return true;
    };
    for (const [fieldId, value] of Object.entries(fields)) {
      const done =
        typeof value === "number"
          ? update({ kind: "select", fieldId, optionIndex: value })
          : update({ kind: "edit", fieldId }) &&
            update({ kind: "draft", fieldId, text: value }) &&
            update({ kind: "commit", fieldId });
      if (!done) return null;
    }
    return current;
  }

  /**
   * Runs until the player is asked: answers camera requests, loads media, and lets time pass while nothing else can
   * happen. Records what ran as play or as seeded coverage.
   */
  #settle(start: Data, seeded: boolean): Step {
    const texts: string[] = [];
    const ways = new Set<number>();
    let newInstructions = 0;
    let snapshot = start;
    let waits = 0;
    for (let operations = 0; ; operations += 1) {
      const execution = this.#recorder.execute(
        snapshot,
        (index) => this.visited[index] === 1 || this.seededVisited[index] === 1,
      );
      snapshot = execution.snapshot;
      collectTexts(execution.events, texts);
      newInstructions += this.#record(execution, seeded, ways);
      if (snapshot.status !== "waiting" || operations >= MAX_AUTO_OPERATIONS) break;
      const action = record(snapshot.foregroundAction);
      if (action.kind === "capture") {
        const result = this.#engine.call("completeAction", this.#plan, snapshot, {
          actionId: action.actionId,
          actionKind: "capture",
          payload: { kind: "unavailable", reason: "unconfigured" },
        });
        if (record(result.outcome).kind !== "completed" || !isRecord(result.snapshot)) break;
        snapshot = result.snapshot;
        continue;
      }
      const unloaded = this.#engine
        .project("mediaPlaybackProjection", snapshot)
        .find((media) => media.loaded !== true);
      if (unloaded !== undefined) {
        const result = this.#engine.call(
          "reportMediaLoad",
          this.#plan,
          snapshot,
          unloaded.mediaId,
          { kind: "loaded", durationMs: MEDIA_PASS_MS },
        );
        if (record(result.outcome).kind !== "accepted" || !isRecord(result.snapshot)) break;
        snapshot = result.snapshot;
        continue;
      }
      const options = this.options(snapshot);
      if (waits >= MAX_AUTO_WAITS || options.length !== 1 || options[0]!.kind !== "wait") break;
      const next = this.#input(snapshot, options[0]!);
      if (next === null) break;
      snapshot = next;
      waits += 1;
    }
    return { snapshot, newInstructions, texts: texts.slice(-KEPT_TEXTS), ways: [...ways] };
  }

  /**
   * Marks an execution's instructions and condition ways as play or seeded coverage, and counts the instructions new
   * to it: new to play for a play step, new to both for a seeded one.
   */
  #record(execution: Execution, seeded: boolean, ways: Set<number>): number {
    const visited = seeded ? this.seededVisited : this.visited;
    const branches = seeded ? this.seededBranches : this.branches;
    let fresh = 0;
    for (const index of execution.instructions) {
      if (index < 0 || index >= visited.length) continue;
      if (visited[index] === 0 && (!seeded || this.visited[index] === 0)) fresh += 1;
      visited[index] = 1;
    }
    for (const [from, to] of execution.edges) {
      const instruction = this.#instructions[from];
      if (instruction?.kind !== "jumpIfFalse" && instruction?.kind !== "loopStart") continue;
      const way = to === from + 1 ? 0 : to === instruction.target ? 1 : -1;
      if (way < 0) continue;
      branches[from]! |= way === 0 ? 1 : 2;
      ways.add(from * 2 + way);
    }
    return fresh;
  }

  /**
   * The constants the code compares with near an ask: around the asking instruction and around the return point of
   * every call that leads to it, nearest first, so that an ask in a helper function also gets its caller's constants.
   */
  #nearbyLiterals(snapshot: Data, action: Data): Literals {
    this.#literals ??= this.#instructions.map(comparedLiterals);
    const positions = [
      action.owningInstruction,
      ...list(snapshot.callFrames)
        .reverse()
        .map((frame) => frame.returnInstruction),
    ].filter((position): position is number => typeof position === "number");
    const found: Literals = { numbers: [], strings: [] };
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
        }
      }
    }
    return {
      numbers: found.numbers.slice(0, MAX_LITERALS),
      strings: found.strings.slice(0, MAX_LITERALS),
    };
  }

  /** The earliest time at which something happens without the player, or null when nothing will. */
  #nextDeadline(snapshot: Data): number | null {
    const now =
      typeof snapshot.observedSessionTimeMs === "number" ? snapshot.observedSessionTimeMs : 0;
    const deadlines: number[] = [];
    const add = (value: unknown) => {
      if (typeof value === "number") deadlines.push(value);
    };
    const action = record(snapshot.foregroundAction);
    if (action.kind === "delay" || action.kind === "chatPacingGate") add(action.deadlineMs);
    if (action.kind === "interaction" && typeof action.timeoutMs === "number")
      add(Number(action.createdAtMs) + action.timeoutMs);
    for (const background of list(snapshot.backgroundActions)) {
      if (background.kind === "chatPacingGate") add(background.deadlineMs);
      if (background.kind === "timer") add(record(background.timer).deadlineMs);
    }
    for (const frame of list(snapshot.callFrames)) {
      const suspended = record(record(frame.timerInterruption).suspendedAction);
      if (suspended.kind === "delay") add(suspended.deadlineMs);
    }
    // Media plays on through every observation, and the runtime catches up on its cues and passes; a stop at the end
    // of a pass is needed only where the story waits for that media, or where nothing else will happen.
    const running = this.#engine
      .project("mediaPlaybackProjection", snapshot)
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
    snapshot: Data,
    until: number,
  ): { mediaId: unknown; segment: unknown; progressMs: number }[] {
    const now =
      typeof snapshot.observedSessionTimeMs === "number" ? snapshot.observedSessionTimeMs : 0;
    return this.#engine
      .project("mediaPlaybackProjection", snapshot)
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

function interruptFrames(snapshot: Data): number {
  return list(snapshot.callFrames).filter((frame) => isRecord(frame.timerInterruption)).length;
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

/** Constants an instruction compares with. */
interface Literals {
  numbers: number[];
  strings: string[];
}

/** Instructions searched on each side of an ask and of each return point for compared constants. */
const LITERAL_WINDOW = 40;
/** Compared constants tried per ask and type, nearest first. */
const MAX_LITERALS = 3;
const COMPARISONS = new Set(["==", "!=", "<", "<=", ">", ">="]);
/** Text methods whose literal argument an answer can match. */
const TEXT_TESTS = new Set(["contains", "startsWith", "endsWith", "equals", "equalsIgnoreCase"]);

/** The literals an instruction's expressions compare with (`x < 10`, `answer == "yes"`, `answer.contains("no")`). */
function comparedLiterals(instruction: Data): Literals {
  const found: Literals = { numbers: [], strings: [] };
  const take = (value: unknown) => {
    const literal = record(value);
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

/** Think times before a timed button: just past each compared constant, read as seconds, or {@link THINK_MS}. */
function thinkTimes(literals: Literals): number[] {
  const seconds = literals.numbers.filter((value) => value >= 1 && value <= 3600);
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
export function stateKeys(snapshot: Data): { state: string; loop: string } {
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
  return { state: key(false), loop: key(true) };
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
 * Replays an input list from a fresh session that starts with `setup`; the last step holds the final state. An
 * operation that throws ends the replay with its `error`.
 */
export function replay(
  engine: Engine,
  plan: Data,
  seed: number,
  inputs: readonly ExplorerInput[],
  setup: Setup = PLAY_SETUP,
): {
  steps: ReplayStep[];
  snapshot: Data;
  failure: ReturnType<typeof failureOf> | null;
  error: string | null;
} {
  const session = new Session(engine, plan, seed);
  let step = session.start(setup);
  let seeded = setup !== PLAY_SETUP;
  const describe = (input: ExplorerInput | null, current: Step): ReplayStep => ({
    input,
    texts: current.texts,
    prompt: session.prompt(current.snapshot).text,
    status: String(current.snapshot.status),
  });
  const steps = [describe(null, step)];
  let error: string | null = null;
  for (const input of inputs) {
    let next: Step | null;
    try {
      next = session.apply(step.snapshot, input, seeded);
    } catch (thrown) {
      error = String(thrown);
      break;
    }
    if (next === null)
      throw new Error(
        `The runtime rejected input ${JSON.stringify(input)} at step ${steps.length}.`,
      );
    seeded ||= isSeeding(input);
    step = next;
    steps.push(describe(input, step));
  }
  return {
    steps,
    snapshot: step.snapshot,
    failure: step.snapshot.status === "failed" ? failureOf(step.snapshot) : null,
    error,
  };
}
