import { createHash } from "node:crypto";
import { isRecord } from "./ast.ts";

/**
 * Headless branch explorer: plays a compiled TeaseScript project in the real runtime through every branch it can
 * reach within a budget, without the Player. Each pending action is a branch point; its options are the buttons and
 * choice options, typed answers from fixed candidates per field type, permanent buttons, and letting time pass to the
 * next deadline. Media loads succeed with one second per pass, `takePhoto` finds no camera, and `askImage` gets one
 * stored image. When letting time pass is the only thing the player can do, the explorer does it as part of the
 * previous step (at most {@link MAX_AUTO_WAITS} times in a row).
 *
 * Execution is deterministic: a state is reproduced by the seed and its input list from the start ({@link replay}).
 *
 * - Coverage: instructions are executed one by one with `executeInstruction`, so every executed instruction is
 *   recorded; a step that runs longer than {@link STEP_CAP} instructions finishes with `run` and the rest of the
 *   product's instruction budget, which keeps `TSR037` where the Player has it.
 * - States are deduplicated by {@link stateKeys}: a hash of the snapshot without what a script cannot observe.
 * - Search order: states whose step reached new instructions first, then states that differ from every explored one
 *   in more than clock, random state, and settled handles (their loop key), then the rest, least repeated first.
 * - Traps are described at {@link findTraps}.
 */

type Data = Readonly<Record<string, unknown>>;

const ENGINE_FUNCTIONS = [
  "compileProject",
  "createFreshRuntimeSnapshot",
  "run",
  "executeInstruction",
  "completeAction",
  "observeTime",
  "reportMediaLoad",
  "pressPermanentButton",
  "mediaPlaybackProjection",
  "permanentButtonProjection",
] as const;

export type Engine = Record<(typeof ENGINE_FUNCTIONS)[number], (...args: unknown[]) => unknown>;

const repositoryIndexUrl = new URL("../../dist/src/index.js", import.meta.url);

/** Loads the runtime operations from the repository build (`npm run build:typescript`). */
export async function loadEngine(): Promise<Engine> {
  const module: unknown = await import(repositoryIndexUrl.href);
  const engine: Partial<Engine> = {};
  for (const name of ENGINE_FUNCTIONS) {
    const value = isRecord(module) ? module[name] : undefined;
    if (typeof value !== "function") throw new Error(`Repository build does not export ${name}().`);
    engine[name] = value as (...args: unknown[]) => unknown;
  }
  return engine as Engine;
}

/** One input of a path from the start; `label` fields only explain the input to a reader. */
export type ExplorerInput =
  | { readonly kind: "option"; readonly index: number; readonly label: string }
  | { readonly kind: "button"; readonly label: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image" }
  | { readonly kind: "wait"; readonly untilMs: number }
  | { readonly kind: "press"; readonly buttonId: number; readonly label: string };

/** The wall clock at session time 0: 2026-10-02 12:00 UTC, as in `runtime-check.ts`. */
const EPOCH_MS = Date.UTC(2026, 9, 2, 12, 0, 0);
/** Duration of one pass of every media file. */
const MEDIA_PASS_MS = 1000;
/** The stored image that answers `askImage`. */
const EXPLORER_IMAGE = "explorer-image";
/** The product's instruction budget per `run` (the runtime's default). */
const INSTRUCTION_BUDGET = 1_000_000;
/** Instructions one step executes one by one, for coverage, before it finishes with `run`. */
const STEP_CAP = 5000;
/** Times in a row the explorer lets time pass when nothing else can happen, before it records a state. */
const MAX_AUTO_WAITS = 100;
/** Said texts kept per step and per text, for trap samples and replay transcripts. */
const KEPT_TEXTS = 3;
const TEXT_LENGTH = 120;

/** What the player can see and do in a state, in short, for reports. */
interface Prompt {
  readonly text: string;
  /** The instruction that asked, or null without a foreground interaction. */
  readonly instruction: number | null;
}

/** The result of one input and everything that follows from it until the player is asked again. */
export interface Step {
  readonly snapshot: Data;
  /** Instructions this step executed for the first time in the session. */
  readonly newInstructions: number;
  /** The last texts said during the step. */
  readonly texts: readonly string[];
}

function record(value: unknown): Data {
  return isRecord(value) ? value : {};
}

function list(value: unknown): Data[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function short(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > TEXT_LENGTH ? `${line.slice(0, TEXT_LENGTH - 1)}…` : line;
}

/**
 * The project's plan with the engine, which runs inputs and records the instructions and branch edges they execute.
 * Coverage accumulates over every step of the session object.
 */
export class Session {
  readonly visited: Uint8Array;
  /** Per conditional instruction: 1 when it continued with the next instruction, 2 when it went to its target. */
  readonly branches: Uint8Array;
  /** Steps whose instructions were only partly recorded because they ran longer than {@link STEP_CAP}. */
  truncatedSteps = 0;
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
    this.branches = new Uint8Array(this.#instructions.length);
  }

  /** The fresh session, run until the player is first asked. */
  start(): Step {
    const fresh = record(
      this.#engine.createFreshRuntimeSnapshot(this.#plan, {
        seed: this.#seed,
        baseDelayMs: 0,
        delayPerWordMs: 0,
        delayPerCharacterMs: 0,
        scriptStorage: [],
        wallClockMs: EPOCH_MS,
      }),
    );
    return this.#settle(fresh);
  }

  /** Applies one input to a waiting state; null when the runtime rejects it. */
  apply(snapshot: Data, input: ExplorerInput): Step | null {
    const next = this.#input(snapshot, input);
    return next === null ? null : this.#settle(next);
  }

  /** The inputs the player has in a waiting state; none in an ended state. */
  options(snapshot: Data): ExplorerInput[] {
    if (snapshot.status !== "waiting") return [];
    const options: ExplorerInput[] = [];
    const action = record(snapshot.foregroundAction);
    if (action.kind === "interaction")
      options.push(...interactionOptions(record(action.ui), this.#nearbyLiterals(snapshot, action)));
    for (const button of list(this.#engine.permanentButtonProjection(snapshot))) {
      if (button.busy !== true && typeof button.buttonId === "number")
        options.push({ kind: "press", buttonId: button.buttonId, label: String(button.text) });
    }
    const until = this.#nextDeadline(snapshot);
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
    const instruction = typeof action.owningInstruction === "number" ? action.owningInstruction : null;
    if (ui.kind === "button") return { text: `[${String(ui.buttonLabel)}]`, instruction };
    if (ui.kind === "choice") {
      const labels = list(ui.options).map((option) => `[${String(option.text)}]`);
      return { text: short(labels.join(" ")), instruction };
    }
    return { text: `(ask ${String(ui.kind)}${ui.integer === true ? " integer" : ""})`, instruction };
  }

  #input(snapshot: Data, input: ExplorerInput): Data | null {
    const plan = this.#plan;
    const action = record(snapshot.foregroundAction);
    const completion = (payload: object) =>
      record(
        this.#engine.completeAction(
          plan,
          snapshot,
          {
            actionId: action.actionId,
            actionKind: "interaction",
            interactionKind: action.interactionKind,
            payload,
          },
          { capturedMedia: { holds: (reference: string) => reference === EXPLORER_IMAGE } },
        ),
      );
    let result: Data;
    let accepted: string;
    switch (input.kind) {
      case "option":
        result = completion({ kind: "selectedOption", optionIndex: input.index });
        accepted = "completed";
        break;
      case "button":
        result = completion({ kind: "activate" });
        accepted = "completed";
        break;
      case "text":
        result = completion({ kind: "submittedText", submittedText: input.text });
        accepted = "completed";
        break;
      case "image":
        result = completion({ kind: "image", reference: EXPLORER_IMAGE });
        accepted = "completed";
        break;
      case "press":
        result = record(this.#engine.pressPermanentButton(plan, snapshot, input.buttonId));
        accepted = "pressed";
        break;
      case "wait":
        result = record(
          this.#engine.observeTime(plan, snapshot, input.untilMs, this.#mediaReports(snapshot, input.untilMs)),
        );
        accepted = "observed";
        break;
    }
    return record(result.outcome).kind === accepted && isRecord(result.snapshot) ? result.snapshot : null;
  }

  /** Runs until the player is asked: answers camera requests, loads media, and lets time pass while nothing else can happen. */
  #settle(start: Data): Step {
    const texts: string[] = [];
    let newInstructions = 0;
    let snapshot = start;
    let waits = 0;
    for (;;) {
      const executed = this.#execute(snapshot, texts);
      snapshot = executed.snapshot;
      newInstructions += executed.newInstructions;
      if (snapshot.status !== "waiting") break;
      const action = record(snapshot.foregroundAction);
      if (action.kind === "capture") {
        const result = record(
          this.#engine.completeAction(this.#plan, snapshot, {
            actionId: action.actionId,
            actionKind: "capture",
            payload: { kind: "unavailable", reason: "unconfigured" },
          }),
        );
        if (record(result.outcome).kind !== "completed" || !isRecord(result.snapshot)) break;
        snapshot = result.snapshot;
        continue;
      }
      const unloaded = list(this.#engine.mediaPlaybackProjection(snapshot)).find(
        (media) => media.loaded !== true,
      );
      if (unloaded !== undefined) {
        const result = record(
          this.#engine.reportMediaLoad(this.#plan, snapshot, unloaded.mediaId, {
            kind: "loaded",
            durationMs: MEDIA_PASS_MS,
          }),
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
    return { snapshot, newInstructions, texts: texts.slice(-KEPT_TEXTS) };
  }

  /**
   * Executes what is runnable, as one `run` would, instruction by instruction to record coverage. An instruction
   * boundary that only starts a queued timer, cue, or button block executes no instruction of its own.
   */
  #execute(start: Data, texts: string[]): { snapshot: Data; newInstructions: number } {
    let snapshot = start;
    let newInstructions = 0;
    for (let steps = 0; ; ) {
      // What `run` would find runnable; a waiting session runs only to start a queued block.
      const runnable =
        snapshot.status === "ready" ||
        snapshot.status === "running" ||
        (snapshot.status === "waiting" && list(snapshot.pendingTimerHandlers).length > 0);
      if (!runnable) return { snapshot, newInstructions };
      if (steps >= STEP_CAP) {
        this.truncatedSteps += 1;
        const result = record(
          this.#engine.run(this.#plan, snapshot, {}, { instructionBudget: INSTRUCTION_BUDGET - steps }),
        );
        collectTexts(result.events, texts);
        return { snapshot: record(result.snapshot), newInstructions };
      }
      const before = typeof snapshot.nextInstruction === "number" ? snapshot.nextInstruction : -1;
      const interrupts = interruptFrames(snapshot);
      const result = record(this.#engine.executeInstruction(this.#plan, snapshot, {}));
      const executed = typeof result.instructionsExecuted === "number" ? result.instructionsExecuted : 0;
      // Nothing was runnable; `run` would not have executed this boundary, nor settled due work after it.
      if (executed === 0 || !isRecord(result.snapshot)) return { snapshot, newInstructions };
      const after = result.snapshot;
      collectTexts(result.events, texts);
      if (before >= 0 && before < this.visited.length && interruptFrames(after) <= interrupts) {
        if (this.visited[before] === 0) {
          this.visited[before] = 1;
          newInstructions += 1;
        }
        this.#recordBranch(before, after);
      }
      snapshot = after;
      steps += executed;
    }
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
        for (const index of distance === 0 ? [position] : [position - distance, position + distance]) {
          const literals = this.#literals[index];
          if (literals === undefined) continue;
          for (const value of literals.numbers) if (!found.numbers.includes(value)) found.numbers.push(value);
          for (const value of literals.strings) if (!found.strings.includes(value)) found.strings.push(value);
        }
      }
    }
    return {
      numbers: found.numbers.slice(0, MAX_LITERALS),
      strings: found.strings.slice(0, MAX_LITERALS),
    };
  }

  #recordBranch(index: number, after: Data): void {
    const instruction = this.#instructions[index]!;
    if (instruction.kind !== "jumpIfFalse" && instruction.kind !== "loopStart") return;
    if (after.status === "failed" || typeof after.nextInstruction !== "number") return;
    if (after.nextInstruction === instruction.target) this.branches[index]! |= 2;
    else if (after.nextInstruction === index + 1) this.branches[index]! |= 1;
  }

  /** The earliest time at which something happens without the player, or null when nothing will. */
  #nextDeadline(snapshot: Data): number | null {
    const now = typeof snapshot.observedSessionTimeMs === "number" ? snapshot.observedSessionTimeMs : 0;
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
    const running = list(this.#engine.mediaPlaybackProjection(snapshot)).filter(
      (media) => media.state === "running" && media.loaded === true,
    );
    const awaited = running.filter((media) => action.kind === "mediaPlayback" && media.mediaId === action.mediaId);
    for (const media of awaited.length > 0 || deadlines.length > 0 ? awaited : running) {
      const progress = typeof media.reportedProgressMs === "number" ? media.reportedProgressMs : 0;
      add(now + Math.max(1, MEDIA_PASS_MS - (progress % MEDIA_PASS_MS)));
    }
    return deadlines.length === 0 ? null : Math.max(now + 1, Math.min(...deadlines));
  }

  /** Progress of every running media until `until`, which plays on in real time. */
  #mediaReports(snapshot: Data, until: number): object[] {
    const now = typeof snapshot.observedSessionTimeMs === "number" ? snapshot.observedSessionTimeMs : 0;
    return list(this.#engine.mediaPlaybackProjection(snapshot))
      .filter((media) => media.state === "running" && media.loaded === true)
      .map((media) => ({
        mediaId: media.mediaId,
        segment: media.segment,
        progressMs:
          (typeof media.reportedProgressMs === "number" ? media.reportedProgressMs : 0) + until - now,
      }));
  }
}

function interruptFrames(snapshot: Data): number {
  return list(snapshot.callFrames).filter((frame) => isRecord(frame.timerInterruption)).length;
}

function collectTexts(events: unknown, texts: string[]): void {
  for (const event of list(events)) {
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
    if (typeof literal.value === "string" && literal.value.trim() !== "") found.strings.push(literal.value);
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

/**
 * The answers tried for an interaction: every button and option; for typed asks the default (the prefilled answer),
 * boundary values of the field type, and the constants the code compares with nearby (for a number `c`: `c - 1`, `c`,
 * and `c + 1`). Blank text is never an answer, so it is not tried.
 */
function interactionOptions(ui: Data, literals: Literals): ExplorerInput[] {
  const typed = (candidates: readonly string[]): ExplorerInput[] =>
    [...new Set([...(typeof ui.prefill === "string" ? [ui.prefill] : []), ...candidates])].map(
      (text) => ({ kind: "text", text }),
    );
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
    default:
      return [];
  }
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
    else if (isRecord(value)) for (const [name, item] of Object.entries(value)) collect(item, value, name);
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
    ranks.set(family, new Map([...values].sort((a, b) => a - b).map((value, rank) => [value, rank])));
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

type NodeStatus = "open" | "expanded" | "partial" | "completed" | "failed" | "stuck";

interface Node {
  readonly id: number;
  readonly parent: number | null;
  readonly input: ExplorerInput | null;
  readonly depth: number;
  readonly loop: string;
  status: NodeStatus;
  /** Kept until the state is expanded. */
  snapshot: Data | null;
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
  /** The shortest input list found from the start to the failure. */
  inputs: ExplorerInput[];
  texts: readonly string[];
}

/** Line coverage of one file; `unvisited` ranges carry what is known about them besides real play. */
export interface FileCoverage {
  path: string;
  coverableLines: number;
  visitedLines: number;
  percent: number;
  unvisited: { lines: string; reach: Reach }[];
}

/**
 * How a line was reached: `play` by inputs alone from a fresh session, `seededState` only from a prepared state (such
 * as storage set directly), `unreachable` proven so by a static reason, `unknown` otherwise. This version only plays,
 * so unvisited lines are `unknown`.
 */
export type Reach = "play" | "seededState" | "unreachable" | "unknown";

/** A conditional instruction that real play reached but left only one way: targets for a directed search. */
export interface UnvisitedBranch {
  instruction: number;
  kind: "if" | "loop";
  path: string;
  line: number;
  condition: { line: number; column: number; endLine: number; endColumn: number; text: string } | null;
  /** The missed way: `true`/`false` for a condition, `enter`/`exit` for a loop. */
  missed: "true" | "false" | "enter" | "exit";
  /** The first instruction and line of the missed way. */
  targetInstruction: number;
  targetLine: number | null;
  reach: Reach;
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
  /** The shortest input list found from the start into the trap. */
  inputs: ExplorerInput[];
}

export interface ExploreResult {
  search: {
    states: number;
    transitions: number;
    expanded: number;
    rejectedInputs: number;
    truncatedSteps: number;
    stoppedBy: "exhausted" | "budget" | "maxStates";
    elapsedMs: number;
  };
  endStates: { completed: number; failed: number; stuck: number; open: number };
  coverage: {
    coverableLines: number;
    visitedLines: number;
    percent: number;
    instructions: number;
    visitedInstructions: number;
    files: FileCoverage[];
    unvisitedBranches: UnvisitedBranch[];
  };
  crashes: CrashReport[];
  traps: TrapReport[];
}

/** A binary heap of open states by (tier, repeats, newest first). */
class Frontier {
  readonly #items: { node: number; rank: [number, number, number] }[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(node: number, tier: number, repeats: number): void {
    const items = this.#items;
    items.push({ node, rank: [tier, repeats, -node] });
    for (let index = items.length - 1; index > 0; ) {
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
    for (let index = 0; ; ) {
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
    if (left[index] !== right[index]) return left[index]! < right[index]!;
  }
  return false;
}

/** Explores a compiled project's plan from a fresh session until every state is expanded or a limit is reached. */
export function explore(engine: Engine, plan: Data, options: ExploreOptions): ExploreResult {
  const started = performance.now();
  const session = new Session(engine, plan, options.seed);
  const nodes: Node[] = [];
  const byState = new Map<string, number>();
  const loopSeen = new Map<string, number>();
  const frontier = new Frontier();
  const crashes = new Map<string, CrashReport>();
  let transitions = 0;
  let expanded = 0;
  let rejectedInputs = 0;

  const add = (step: Step, parent: Node | null, input: ExplorerInput | null): number => {
    const keys = stateKeys(step.snapshot);
    const known = byState.get(keys.state);
    if (known !== undefined) return known;
    const status = step.snapshot.status;
    const node: Node = {
      id: nodes.length,
      parent: parent?.id ?? null,
      input,
      depth: parent === null ? 0 : parent.depth + 1,
      loop: keys.loop,
      status: status === "halted" ? "completed" : status === "failed" ? "failed" : "open",
      snapshot: status === "waiting" ? step.snapshot : null,
      edges: [],
      texts: step.texts,
      prompt: session.prompt(step.snapshot),
    };
    nodes.push(node);
    byState.set(keys.state, node.id);
    if (node.status === "failed") recordCrash(crashes, step, pathTo(nodes, node));
    if (node.status === "open") {
      const repeats = loopSeen.get(keys.loop) ?? 0;
      frontier.push(node.id, step.newInstructions > 0 ? 0 : repeats === 0 ? 1 : 2, repeats);
    }
    loopSeen.set(keys.loop, (loopSeen.get(keys.loop) ?? 0) + 1);
    return node.id;
  };

  add(session.start(), null, null);
  let stoppedBy: ExploreResult["search"]["stoppedBy"] = "exhausted";
  const outOfBudget = () => performance.now() - started >= options.budgetMs;
  search: while (frontier.size > 0) {
    if (outOfBudget()) {
      stoppedBy = "budget";
      break;
    }
    if (nodes.length >= options.maxStates) {
      stoppedBy = "maxStates";
      break;
    }
    const node = nodes[frontier.pop()!]!;
    const snapshot = node.snapshot!;
    const inputs = session.options(snapshot);
    if (inputs.length === 0) {
      node.status = "stuck";
      node.snapshot = null;
      continue;
    }
    expanded += 1;
    node.status = "partial";
    for (const input of inputs) {
      if (outOfBudget()) {
        stoppedBy = "budget";
        break search;
      }
      let step: Step | null;
      try {
        step = session.apply(snapshot, input);
      } catch (error) {
        // The runtime refused data it was given (RuntimeDataError): a harness problem, not a script failure.
        process.emitWarning(`Explorer input ${JSON.stringify(input)} failed: ${String(error)}`);
        step = null;
      }
      if (step === null) {
        rejectedInputs += 1;
        continue;
      }
      transitions += 1;
      const child = add(step, node, input);
      if (!node.edges.includes(child)) node.edges.push(child);
    }
    node.status = "expanded";
    node.snapshot = null;
  }

  const visitedInstructions = session.visited.reduce((sum, value) => sum + value, 0);
  const coverage = lineCoverage(plan, session, options.sources);
  const count = (status: NodeStatus) => nodes.filter((node) => node.status === status).length;
  return {
    search: {
      states: nodes.length,
      transitions,
      expanded,
      rejectedInputs,
      truncatedSteps: session.truncatedSteps,
      stoppedBy,
      elapsedMs: Math.round(performance.now() - started),
    },
    endStates: {
      completed: count("completed"),
      failed: count("failed"),
      stuck: count("stuck"),
      open: count("open") + count("partial"),
    },
    coverage: {
      ...coverage,
      instructions: session.visited.length,
      visitedInstructions,
    },
    crashes: [...crashes.values()],
    traps: findTraps(nodes, plan),
  };
}

function pathTo(nodes: readonly Node[], node: Node): ExplorerInput[] {
  const inputs: ExplorerInput[] = [];
  for (let current: Node | undefined = node; current?.input; ) {
    inputs.push(current.input);
    current = current.parent === null ? undefined : nodes[current.parent];
  }
  return inputs.reverse();
}

function failureOf(snapshot: Data) {
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

function recordCrash(crashes: Map<string, CrashReport>, step: Step, inputs: ExplorerInput[]): void {
  const failure = failureOf(step.snapshot);
  const key = `${failure.code}@${failure.path}:${failure.line}:${failure.column}-${failure.endLine}:${failure.endColumn}`;
  const known = crashes.get(key);
  if (known === undefined) {
    crashes.set(key, { ...failure, states: 1, inputs, texts: step.texts });
    return;
  }
  known.states += 1;
  if (inputs.length < known.inputs.length) {
    known.inputs = inputs;
    known.texts = step.texts;
  }
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

/** The file an instruction belongs to, as the runtime reports a failure's path (`instructionSourcePath`). */
function instructionFiles(plan: Data): string[] {
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

function lineCoverage(plan: Data, session: Session, sources: ReadonlyMap<string, string>) {
  const instructions = list(plan.instructions);
  const files = instructionFiles(plan);
  // Per file, per line: whether some instruction starting on it ran.
  const lines = new Map<string, Map<number, boolean>>();
  const lineOf = instructions.map((instruction) => compactSpan(instruction.span)?.line ?? null);
  instructions.forEach((_, index) => {
    const line = lineOf[index];
    if (line == null) return;
    const file = lines.get(files[index]!) ?? new Map<number, boolean>();
    file.set(line, (file.get(line) ?? false) || session.visited[index] === 1);
    lines.set(files[index]!, file);
  });
  const percent = (part: number, whole: number) =>
    whole === 0 ? 100 : Math.round((part / whole) * 1000) / 10;
  const fileCoverage: FileCoverage[] = [...lines]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([path, fileLines]) => {
      const sorted = [...fileLines].sort(([left], [right]) => left - right);
      const visited = sorted.filter(([, seen]) => seen).length;
      // Unvisited lines with no visited line between them form one range.
      const ranges: [number, number][] = [];
      let open: [number, number] | null = null;
      for (const [line, seen] of sorted) {
        if (seen) open = null;
        else if (open === null) ranges.push((open = [line, line]));
        else open[1] = line;
      }
      return {
        path,
        coverableLines: sorted.length,
        visitedLines: visited,
        percent: percent(visited, sorted.length),
        unvisited: ranges.map(([from, to]) => ({
          lines: from === to ? `${from}` : `${from}-${to}`,
          reach: "unknown" as const,
        })),
      };
    });
  const coverable = fileCoverage.reduce((sum, file) => sum + file.coverableLines, 0);
  const visited = fileCoverage.reduce((sum, file) => sum + file.visitedLines, 0);
  const unvisitedBranches: UnvisitedBranch[] = [];
  instructions.forEach((instruction, index) => {
    const taken = session.branches[index]!;
    if (session.visited[index] !== 1 || taken === 0 || taken === 3) return;
    if (instruction.kind !== "jumpIfFalse" && instruction.kind !== "loopStart") return;
    const target = Number(instruction.target);
    const condition = record(instruction.condition ?? instruction.expression);
    // A constant condition, such as `while true`, has only one way.
    if (target === index + 1 || condition.kind === "literal") return;
    const missedTarget = taken === 1;
    const span = compactSpan(condition.span);
    const source = sources.get(files[index]!);
    const isIf = instruction.kind === "jumpIfFalse";
    unvisitedBranches.push({
      instruction: index,
      kind: isIf ? "if" : "loop",
      path: files[index]!,
      line: lineOf[index] ?? 0,
      condition:
        span === null
          ? null
          : {
              line: span.line,
              column: span.column,
              endLine: span.endLine,
              endColumn: span.endColumn,
              text: source === undefined ? "" : short(source.slice(span.start, span.end)),
            },
      missed: isIf ? (missedTarget ? "false" : "true") : missedTarget ? "exit" : "enter",
      targetInstruction: missedTarget ? target : index + 1,
      targetLine: lineOf[firstStatement(instructions, missedTarget ? target : index + 1)] ?? null,
      reach: "unknown",
    });
  });
  return {
    coverableLines: coverable,
    visitedLines: visited,
    percent: percent(visited, coverable),
    files: fileCoverage,
    unvisitedBranches,
  };
}

/** Instructions that only open or close a block, which a way's first line should skip. */
const STRUCTURAL = new Set(["enterScope", "leaveScope", "clearTemporary", "clearTemporaries", "jump"]);

/** The first instruction at or after `index` that is not structural, within a few steps. */
function firstStatement(instructions: readonly Data[], index: number): number {
  for (let current = index; current < Math.min(instructions.length, index + 5); current += 1) {
    if (!STRUCTURAL.has(String(instructions[current]?.kind))) return current;
  }
  return index;
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
export function findTraps(nodes: readonly Node[], plan: Data): TrapReport[] {
  const groups = new Map<string, Node[]>();
  for (const node of nodes) groups.set(node.loop, [...(groups.get(node.loop) ?? []), node]);
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
  for (const [loop, next] of successors)
    for (const target of next) predecessors.set(target, [...(predecessors.get(target) ?? []), loop]);
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
      component.every((loop) => [...successors.get(loop)!].every((next) => componentOf.get(next) === index)),
    );
  // Feeders: trapped groups outside a bottom component, attributed to the first bottom component they reach.
  const feeders = new Map<number, number>();
  for (const loop of trapped) {
    const index = componentOf.get(loop)!;
    if (bottom.some((entry) => entry.index === index)) continue;
    const seen = new Set([loop]);
    const pending = [loop];
    let target: number | undefined;
    while (pending.length > 0 && target === undefined) {
      for (const next of successors.get(pending.pop()!)!) {
        const component = componentOf.get(next)!;
        if (bottom.some((entry) => entry.index === component)) target = component;
        else if (!seen.has(next)) {
          seen.add(next);
          pending.push(next);
        }
      }
    }
    if (target !== undefined)
      feeders.set(target, (feeders.get(target) ?? 0) + groups.get(loop)!.length);
  }
  const files = instructionFiles(plan);
  const instructions = list(plan.instructions);
  return bottom.map(({ component, index }) => {
    const members = component.flatMap((loop) => groups.get(loop)!);
    const cyclic =
      component.length > 1 || successors.get(component[0]!)!.has(component[0]!);
    const entry = members.reduce((best, node) => (node.depth < best.depth ? node : best));
    const locations = new Set<string>();
    for (const node of members) {
      const at = node.prompt.instruction;
      const span = at === null ? null : compactSpan(instructions[at]?.span);
      if (at !== null && span !== null) locations.add(`${files[at]}:${span.line}`);
    }
    return {
      kind: cyclic ? ("loop" as const) : ("stuck" as const),
      states: members.length,
      feederStates: feeders.get(index) ?? 0,
      locations: [...locations].slice(0, 10),
      sampleTexts: [...new Set(members.flatMap((node) => node.texts))].slice(0, 8),
      samplePrompts: [...new Set(members.map((node) => node.prompt.text).filter((text) => text !== ""))].slice(0, 8),
      inputs: pathTo(nodes, entry),
    };
  });
}

/** Tarjan's strongly connected components, iteratively. */
function stronglyConnected(vertices: readonly string[], next: (vertex: string) => string[]): string[][] {
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
      work.push({ vertex, edges: next(vertex).filter((target) => inside.has(target)), position: 0 });
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
        for (let vertex: string | undefined; vertex !== frame.vertex; ) {
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

/** One step of a replayed path, for a transcript. */
export interface ReplayStep {
  readonly input: ExplorerInput | null;
  readonly texts: readonly string[];
  readonly prompt: string;
  readonly status: string;
}

/** Replays an input list from a fresh session; the last step holds the final state. */
export function replay(
  engine: Engine,
  plan: Data,
  seed: number,
  inputs: readonly ExplorerInput[],
): { steps: ReplayStep[]; snapshot: Data; failure: ReturnType<typeof failureOf> | null } {
  const session = new Session(engine, plan, seed);
  let step = session.start();
  const describe = (input: ExplorerInput | null, current: Step): ReplayStep => ({
    input,
    texts: current.texts,
    prompt: session.prompt(current.snapshot).text,
    status: String(current.snapshot.status),
  });
  const steps = [describe(null, step)];
  for (const input of inputs) {
    const next = session.apply(step.snapshot, input);
    if (next === null) throw new Error(`The runtime rejected input ${JSON.stringify(input)} at step ${steps.length}.`);
    step = next;
    steps.push(describe(input, step));
  }
  return {
    steps,
    snapshot: step.snapshot,
    failure: step.snapshot.status === "failed" ? failureOf(step.snapshot) : null,
  };
}
