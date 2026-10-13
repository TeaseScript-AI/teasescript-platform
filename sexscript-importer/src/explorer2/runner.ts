/**
 * Explorer V2's runner: plays one path of a plan and records what V2 reasons from: the interactions with the answers
 * they offered, the random draws with their outcomes, the storage states the session went through, and the branch
 * decisions. A play with origins runs one instruction at a time with the runtime's debug trace attached
 * (`docs/RUNTIME.md#debug-trace`) and records every decision in the order it ran, with the origins its condition's value
 * came from (an answer, a random draw, a stored key); a play without runs the script between interactions in one call
 * and records only which ways the decisions took. See the design in the coordinator's notes
 * (`design/explorer-v2-design.md`).
 *
 * Origins come from the trace: a variable's current version (found by its scope in a snapshot) and the records it
 * depends on lead to accepted inputs, draws, and loads. Temporaries, which the trace keys by call frame and does not let
 * a host look up, carry the origins of what was stored in them, as the runner saw it stored.
 */
import { createHash } from "node:crypto";
import { isRecord } from "../ast.ts";
import { clockDifferences, comparedWith, DataFlow } from "../explorer-analysis.ts";
import {
  EPOCH_MS,
  failureOf,
  Session,
  storageOf,
  wallClockOf,
  type Data,
  type Engine,
  type ExplorerInput,
  type RandomChoice,
  type Runtime,
  type StorageEntry,
  type TaggedSnapshot,
} from "../explorer.ts";
import { repositoryBuildUrl } from "../repository-build.ts";

/**
 * An origin of a value: an accepted input (`i<n>`, the n-th of the session), a draw (`d<n>`), a stored key (`k<key>`),
 * or the wall clock the session started at ({@link CLOCK}).
 */
export type Origin = string;

/** The origin of a value read from the clock. */
export const CLOCK: Origin = "c";

/** The runtime functions V2 uses, from the repository build. */
export interface Runtime2 {
  readonly createFreshRuntimeSession: (plan: Data, fresh: Data, options?: Data) => RawSession;
  readonly createTaggedRuntimeSession: (
    plan: Data,
    tagged: TaggedSnapshot,
    options?: Data,
  ) => RawSession;
  readonly createDebugContext: (options: Data) => DebugContext;
  readonly randomDrawAlternatives: (draw: Data, limit: number) => Data;
  /** Whether a draw with this support can have this outcome (the runtime's check). */
  readonly outcomeFits: (support: Data, outcome: Data) => boolean;
}

/** The operations of a runtime session (`RuntimeSession`) that V2 calls, each with its result read as a record. */
const SESSION_OPERATIONS = [
  "view",
  "executeInstruction",
  "completeAction",
  "updateInteraction",
  "observeTime",
  "reportMediaLoad",
  "pressPermanentButton",
  "recordContinueCapture",
  "run",
  "exportTrustedSnapshot",
  "exportSnapshot",
] as const;

type SessionOperation = (typeof SESSION_OPERATIONS)[number];

/** A runtime session as the repository build makes it, read field by field. */
type RawSession = Record<SessionOperation, (...args: unknown[]) => Data> & {
  callReturnInstructions: () => number[];
  exportTaggedSnapshot: () => TaggedSnapshot;
  mediaPlaybackProjection: () => Data[];
  permanentButtonProjection: () => Data[];
  fork: () => RawSession;
};

/**
 * The debug trace context (`RuntimeDebugContext`): `handle` is the runtime's own object, which operations take as
 * their `debugTrace`, and the rest reads it.
 */
interface DebugContext {
  readonly handle: unknown;
  status: () => Data;
  record: (id: number) => Data | null;
  variableRecord: (scope: number | "global", name: string) => number | null;
}

/**
 * Calls `target`'s method `name` with `args` and reads its result with `read`; an error names a method the repository
 * build lacks.
 */
function callOf<T>(target: unknown, name: string, read: (result: unknown) => T) {
  const method = isRecord(target) ? target[name] : undefined;
  if (typeof method !== "function")
    throw new Error(`The repository build has no ${name}(); explorer V2 needs it.`);
  return (...args: unknown[]): T => {
    const result: unknown = method.apply(target, args);
    return read(result);
  };
}

/** A runtime session's operations, with their results read as V2 uses them. */
function rawSession(session: unknown): RawSession {
  const operation = (name: SessionOperation) => callOf(session, name, record);
  return {
    view: operation("view"),
    executeInstruction: operation("executeInstruction"),
    completeAction: operation("completeAction"),
    updateInteraction: operation("updateInteraction"),
    observeTime: operation("observeTime"),
    reportMediaLoad: operation("reportMediaLoad"),
    pressPermanentButton: operation("pressPermanentButton"),
    recordContinueCapture: operation("recordContinueCapture"),
    run: operation("run"),
    exportTrustedSnapshot: operation("exportTrustedSnapshot"),
    exportSnapshot: operation("exportSnapshot"),
    callReturnInstructions: callOf(session, "callReturnInstructions", (value) =>
      Array.isArray(value)
        ? value.filter((entry): entry is number => typeof entry === "number")
        : [],
    ),
    exportTaggedSnapshot: callOf(session, "exportTaggedSnapshot", (value) => {
      const tagged = record(value);
      return { json: String(tagged.json), tag: String(tagged.tag) };
    }),
    mediaPlaybackProjection: callOf(session, "mediaPlaybackProjection", list),
    permanentButtonProjection: callOf(session, "permanentButtonProjection", list),
    fork: callOf(session, "fork", rawSession),
  };
}

export async function loadRuntime2(): Promise<Runtime2> {
  const module: unknown = await import(repositoryBuildUrl("src/index.js").href);
  const fresh = callOf(module, "createFreshRuntimeSession", rawSession);
  const restore = callOf(module, "createTaggedRuntimeSession", rawSession);
  const alternatives = callOf(module, "randomDrawAlternatives", record);
  // The runtime's own check of a chosen outcome against a draw's support (it answers a problem as text), so that V2
  // never chooses an outcome the runtime would refuse.
  const control: unknown = await import(repositoryBuildUrl("src/runtime/random-control.js").href);
  const checked = callOf(control, "checkedOutcome", (value) => typeof value !== "string");
  const context = isRecord(module) ? module.RuntimeDebugContext : undefined;
  if (typeof context !== "function")
    throw new Error("The repository build has no RuntimeDebugContext; explorer V2 needs it.");
  return {
    createFreshRuntimeSession: (plan, start, options) => fresh(plan, start, options),
    createTaggedRuntimeSession: (plan, tagged, options) => restore(plan, tagged, options),
    createDebugContext: (options) => {
      const handle: unknown = Reflect.construct(context, [options]);
      const status = callOf(handle, "status", record);
      const entry = callOf(handle, "record", (value) => (isRecord(value) ? value : null));
      const variable = callOf(handle, "variableRecord", (value) =>
        typeof value === "number" ? value : null,
      );
      return {
        handle,
        status: () => status(),
        record: (id) => entry(id),
        variableRecord: (scope, name) => variable(scope, name),
      };
    },
    randomDrawAlternatives: (draw, limit) => alternatives(draw, limit),
    outcomeFits: (support, outcome) => {
      try {
        return checked(support, outcome);
      } catch {
        return false;
      }
    },
  };
}

/** How far a state is from a condition's other way, and the values the condition read there (see `PlayOptions`). */
export interface Measure {
  readonly distance: number;
  readonly values: readonly (string | number | boolean)[];
}

/** A random draw of a played path, in the order of the session's draw operations. */
export interface DrawEvent {
  readonly occurrence: number;
  /** The step (input number) during which it was drawn: 0 before the first input. */
  readonly step: number;
  readonly drawId: number;
  readonly site: string;
  readonly kind: string;
  readonly support: Data;
  readonly natural: Data;
  /** The outcome the draw had: the natural one, or the one the path fixed or inherited. */
  readonly outcome: Data;
}

/** A branch decision of a played path. */
export interface Decision {
  /** Its place in the path's sequence of decisions. */
  readonly order: number;
  readonly instruction: number;
  /** 0: the next instruction (a condition true, a loop round), 1: the instruction's target. */
  readonly way: 0 | 1;
  readonly step: number;
  /** The how-manieth decision at this instruction within its step, from 0. */
  readonly nth: number;
  /** The origins the condition's value came from, also through the decisions its values were written under. */
  readonly origins: ReadonlySet<Origin>;
  /** Those it read as data only, without the decisions its values were written under. */
  readonly dataOrigins: ReadonlySet<Origin>;
  /** Fields of a form answer the condition reads, by the answer's origin (`i<n>`). */
  readonly fields: ReadonlyMap<Origin, ReadonlySet<string>>;
}

/** An interaction a played path answered, or the one it ended waiting at. */
export interface Interaction {
  readonly step: number;
  readonly instruction: number;
  readonly options: readonly ExplorerInput[];
  /** For a form, its fields as the runtime shows them (with `id`, `kind`, and `options`). */
  readonly fields: readonly Data[];
  /** The values of the variables and stored keys the conditions seen so far read, as text (see `relevantState`). */
  readonly state: string;
}

/** A path: the inputs, one per step, and the outcomes fixed for draws by occurrence. */
export interface Path {
  readonly inputs: readonly ExplorerInput[];
  readonly draws: ReadonlyMap<number, Data>;
  /** The draws of the path this one was made from, whose outcomes it keeps while they still match. */
  readonly inherited: readonly DrawEvent[];
  /** The storage the session starts with, sorted by key: a later visit, from a state some play saved. */
  readonly storage?: readonly StorageEntry[];
  /** The wall clock the session starts at, when not {@link EPOCH_MS}. */
  readonly wallClockMs?: number;
  /**
   * For a later visit, whose draws do not line up with its parent's by occurrence: outcomes by draw site, in the order
   * of the draws there, which a draw keeps while its kind and support match.
   */
  readonly siteDraws?: ReadonlyMap<string, readonly DrawEvent[]>;
  /**
   * For a later visit, the answers a solver changed, by where the parent gave them: the interaction's instruction and
   * which of its occurrences there, where the visit gives them when they are offered.
   */
  readonly placed?: readonly {
    readonly place: number;
    readonly nth: number;
    readonly input: ExplorerInput;
  }[];
}

export interface Played {
  readonly path: Path;
  /** Inputs given: the path's own, then the ones the runner chose to go on (see {@link PlayOptions.extend}). */
  readonly inputs: readonly ExplorerInput[];
  readonly visited: ReadonlySet<number>;
  readonly decisions: readonly Decision[];
  readonly interactions: readonly Interaction[];
  readonly draws: readonly DrawEvent[];
  /** How the path ended: the script exited or failed, it waits for an input it was not given, or a cap stopped it. */
  readonly end:
    "exit" | "failed" | "waiting" | "steps" | "instructions" | "diverged" | "stuck" | "reached";
  readonly failure: ReturnType<typeof failureOf> | null;
  readonly instructions: number;
  /** Per interaction the path came to, a point a play of a path that agrees up to there can resume from. */
  readonly resumes: readonly Resume[];
  /** The storage states the session went through, at its start, its interactions, and its end, each once. */
  readonly storages: readonly (readonly StorageEntry[])[];
  /** For each of {@link storages}, the inputs given when the session first had it. */
  readonly storageSteps: readonly number[];
  /** The steps during which the script asked for a photo. */
  readonly captures: readonly number[];
  /** What `PlayOptions.measure` read, when the play came to its interaction. */
  readonly measured?: Measure;
}

/**
 * A point to resume from: the state waiting at an interaction, the draws made before it, and the origins of the
 * variables then (by `scope:name`, also as data only), for the values a resumed play reads that the new trace did not
 * see made.
 */
export interface Resume {
  readonly tagged: TaggedSnapshot;
  readonly draws: number;
  readonly origins: ReadonlyMap<string, ReadonlySet<Origin>>;
  readonly dataOrigins: ReadonlyMap<string, ReadonlySet<Origin>>;
}

export interface PlayOptions {
  /** Go on after the path's inputs: at each interaction, the input `extend` picks, up to `maxSteps` steps in all. */
  readonly extend?: (interaction: Interaction, played: number) => ExplorerInput | null;
  readonly maxSteps: number;
  /**
   * Instructions one step may run: without origins the run fails there with the runtime's step-limit error; with
   * origins the play stops there as stuck.
   */
  readonly maxStepInstructions: number;
  /**
   * Trace origins; without it the runner records only which ways the decisions of each run took, and runs the script
   * between interactions in one call instead of instruction by instruction (a check replay).
   */
  readonly origins: boolean;
  /** Stop once a decision this holds for was made (a check that found what it looks for). */
  readonly until?: (decision: Decision) => boolean;
  /**
   * Reads a measure (a check's distance from its target's other way) from the state waiting at interaction `at`, or with
   * `instruction`, from the states about to run it in the step that leads there: the nearest of those that read values.
   */
  readonly measure?: {
    readonly at: number;
    readonly instruction?: number;
    readonly read: (snapshot: Data) => Measure;
  };
  /**
   * Sees the state waiting at each interaction (a search's watch on how close a counter is to a value); true when it saw
   * progress, which counts like new code for `patience`.
   */
  readonly observe?: (snapshot: Data, step: number) => boolean;
  /**
   * Go on from interaction `at` of `parent`, an earlier play of a path that agrees with this one up to there: its
   * decisions, interactions, draws, and resume points up to there are this play's too.
   */
  readonly resume?: { readonly at: number; readonly parent: Played };
  /** Keep resume points (for a path whose checks will resume from them). */
  readonly keepResumes?: boolean;
  /** Draws the path neither fixes nor inherits get a random outcome from this generator instead of the natural one. */
  readonly random?: () => number;
  /**
   * Instructions some path ran already (1 for ran): past its own inputs, a play stops going on after `patience` steps
   * that ran none new.
   */
  readonly known?: Uint8Array;
  readonly patience?: number;
}

/**
 * Instructions after which every name is still bound in the same scope (V2 reads the scopes again after any other):
 * evaluating, storing a temporary, assigning, and branching.
 */
const KEEPS_SCOPES = new Set([
  "storeTemporary",
  "clearTemporary",
  "clearTemporaries",
  "assign",
  "evaluate",
  "jumpIfFalse",
  "jump",
  "say",
  "wait",
  "validateAssignmentTarget",
  "prepareReference",
  "prepareSayText",
  "prepareSaySpeaker",
  "prepareSayContextualSpeaker",
  "prepareInteractionSpeaker",
  "interaction",
  "storageWrite",
  "showImage",
  "playMedia",
]);

/** The work of an instruction run one at a time with the trace, against one run without (measured: 6.6–9 µs vs 1.1). */
const TRACED_WORK = 8;
/** The work of what a play records at an interaction (answers, relevant state, snapshots), in instructions. */
const INTERACTION_WORK = 1000;

/** The origins of a decision whose origins the runner did not work out: one shared empty value. */
const NO_ORIGINS: Pick<Decision, "origins" | "dataOrigins" | "fields"> = {
  origins: new Set(),
  dataOrigins: new Set(),
  fields: new Map(),
};

/** Decisions at one instruction in one step whose origins the runner works out, at most. */
const ORIGINS_PER_INSTRUCTION = 4;

const MAX_AUTO_WAITS = 100;
/** States a play measures before its target instruction runs (a loop may run it often in one step), at most. */
const MAX_MEASURES = 64;
const MEDIA_PASS_MS = 1000;
const EXPLORER_IMAGE = "explorer:photo";

/**
 * The V1 runtime interface over a raw session, so that V1's `Session.options` lists the answers of an interaction
 * exactly as V1 offers them (V1's code stays as it is).
 */
function asRuntime(session: RawSession): Runtime {
  return {
    call: (name, ...args) => session[name](...args),
    project: (name) => session[name](),
    view: () => session.view(),
    callReturnInstructions: () => [...session.callReturnInstructions()],
    exportTrustedSnapshot: () => session.exportTrustedSnapshot(),
    exportSnapshot: () => session.exportSnapshot(),
    exportTaggedSnapshot: () => session.exportTaggedSnapshot(),
    fork: () => asRuntime(session.fork()),
  };
}

function record(value: unknown): Data {
  return isRecord(value) ? value : {};
}

function list(value: unknown): Data[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The scope each visible variable name is bound in, in a snapshot, as the running code sees it (V1's `bindingsOf`). */
function scopesOf(snapshot: Data): Map<string, number | "global"> {
  const scopes = new Map<string, number | "global">();
  for (const binding of list(snapshot.globals))
    if (typeof binding.name === "string") scopes.set(binding.name, "global");
  const frames = list(snapshot.frames);
  const take = (scope: Data | undefined) => {
    for (const binding of list(scope?.bindings))
      if (typeof binding.name === "string" && typeof scope?.id === "number")
        scopes.set(binding.name, scope.id);
  };
  const call = list(snapshot.callFrames).at(-1);
  if (call === undefined) {
    for (const frame of frames) take(frame);
    return scopes;
  }
  const byId = new Map(
    [...frames, ...list(snapshot.retainedScopes)].map((scope) => [scope.id, scope]),
  );
  take(byId.get(call.rootScopeId));
  for (const capture of list(call.captures))
    if (typeof capture.name === "string" && typeof capture.scopeId === "number")
      scopes.set(capture.name, capture.scopeId);
  for (const frame of frames.slice(Number(call.scopeBaseDepth) || 0)) take(frame);
  return scopes;
}

/** The identifiers and temporaries an expression reads, and the constant fields it reads of each identifier. */
function readsOf(expression: unknown): {
  names: Set<string>;
  temporaries: Set<number>;
  fields: Map<string, Set<string>>;
  keys: Set<string>;
} {
  const names = new Set<string>();
  const keys = new Set<string>();
  const temporaries = new Set<number>();
  const fields = new Map<string, Set<string>>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!isRecord(value)) return;
    if (value.kind === "identifier" && typeof value.name === "string") names.add(value.name);
    if (value.kind === "temporary" && typeof value.temporaryId === "number")
      temporaries.add(value.temporaryId);
    const key = record(value.key);
    if (value.kind === "storageLoad" && key.kind === "literal" && typeof key.value === "string")
      keys.add(key.value);
    // A field read: `answer.cane`, `picked[3]`.
    const object = record(value.object);
    const index = record(value.index);
    if (object.kind === "identifier" && typeof object.name === "string") {
      const field =
        value.kind === "property" && typeof value.name === "string"
          ? value.name
          : value.kind === "index" && index.kind === "literal" && index.value !== null
            ? String(index.value)
            : null;
      if (field !== null)
        fields.set(object.name, (fields.get(object.name) ?? new Set()).add(field));
    }
    for (const [key, item] of Object.entries(value)) if (key !== "span") walk(item);
  };
  walk(expression);
  return { names, temporaries, fields, keys };
}

/**
 * Plays paths of one plan. One runner keeps V1's `Session` only to list the answers an interaction offers.
 */
export class Runner {
  readonly #runtime: Runtime2;
  readonly #plan: Data;
  readonly #instructions: readonly Data[];
  readonly #seed: number;
  readonly #options: Session;
  /** V1's data flow of the plan, which V2's solver asks for the values conditions compare. */
  readonly flow: DataFlow;
  /** Whether a decision's condition reads the clock (through the variables it reads too), by instruction. */
  readonly #clockReads = new Map<number, boolean>();
  /** Every variable name a condition read so far, for {@link relevantState}. */
  readonly readNames = new Set<string>();
  readonly readKeys = new Set<string>();
  /** Instructions whose names {@link readNames} has from a run without a trace. */
  readonly #namesRead = new Set<number>();
  /** Instructions all paths executed. */
  instructionsRun = 0;
  /**
   * The work all plays did, in units of an instruction run without a trace: what the search shares out instead of
   * measured time, so that a run that ends by running out of work does not depend on timing.
   */
  work = 0;

  constructor(runtime: Runtime2, engine: Engine, plan: Data, seed: number) {
    this.#runtime = runtime;
    this.#plan = plan;
    this.#instructions = list(plan.instructions);
    this.#seed = seed;
    this.#options = new Session(engine, plan, seed);
    // The answers V1 offers: with compared answers on, as V1's search sets them up.
    const flow = new DataFlow(plan, this.#instructions, { computedPrompts: true });
    this.flow = flow;
    const options = this.#options;
    options.scopedReads = true;
    for (const [ask, expressions] of comparedWith(
      flow,
      this.#instructions,
      "asks",
      options.comparedElsewhere,
    ))
      options.comparedWith.set(ask, expressions);
    for (const [button, expressions] of comparedWith(flow, this.#instructions, "timed"))
      options.timedWith.set(button, expressions);
    options.clockDifferences.push(
      ...clockDifferences(flow, this.#instructions).filter(
        (difference) => difference.numbers.length + difference.durations.length > 0,
      ),
    );
  }

  /** Plays `path` from the session start, then goes on as `options.extend` chooses. */
  play(path: Path, options: PlayOptions): Played {
    const trace = options.origins
      ? this.#runtime.createDebugContext({ maxRecords: 4_000_000, maxAccountedBytes: 1 << 30 })
      : undefined;
    const traced = trace === undefined ? {} : { debugTrace: trace.handle };
    const at = options.resume?.at ?? 0;
    const from: Resume | undefined = options.resume?.parent.resumes[at];
    if (options.resume !== undefined && from === undefined)
      throw new Error(`No resume point at interaction ${at}.`);
    const drawBase = from?.draws ?? 0;
    // A resumed play has its parent's draws up to the resume point, and counts on from there.
    const draws: DrawEvent[] = options.resume?.parent.draws.slice(0, drawBase) ?? [];
    let step = at;
    const inherited = new Map(path.inherited.map((draw) => [draw.occurrence, draw]));
    let diverged = false;
    const atSite = new Map<string, number>();
    for (const draw of draws) atSite.set(draw.site, (atSite.get(draw.site) ?? 0) + 1);
    const decide = (draw: Data) => {
      const occurrence = draws.length;
      const site = String(draw.site);
      const nth = atSite.get(site) ?? 0;
      atSite.set(site, nth + 1);
      const bySite = path.siteDraws?.get(site)?.[nth];
      const sameSite =
        bySite !== undefined &&
        bySite.kind === draw.kind &&
        JSON.stringify(bySite.support) === JSON.stringify(draw.support);
      const parent = inherited.get(occurrence);
      const same =
        parent !== undefined &&
        !diverged &&
        parent.site === draw.site &&
        parent.kind === draw.kind &&
        JSON.stringify(parent.support) === JSON.stringify(draw.support);
      if (parent !== undefined && !same) diverged = true;
      const natural = record(draw.natural);
      const support = record(draw.support);
      // An outcome the draw's support does not have (the path diverged before it) is not forced: the runtime would
      // refuse it and keep the draw pending.
      const wanted = path.draws.get(occurrence);
      const fixed =
        (wanted !== undefined && this.#runtime.outcomeFits(support, wanted) ? wanted : undefined) ??
        (same ? parent.outcome : undefined) ??
        (sameSite ? bySite.outcome : undefined) ??
        (options.random === undefined ? undefined : randomOutcome(support, options.random));
      const outcome = fixed ?? natural;
      draws.push({
        occurrence,
        step,
        drawId: Number(draw.drawId),
        site: String(draw.site),
        kind: String(draw.kind),
        support,
        natural,
        outcome,
      });
      return fixed === undefined || natural.kind === "failure"
        ? { kind: "natural" }
        : { kind: "choose", outcome: fixed };
    };
    const session =
      from === undefined
        ? this.#runtime.createFreshRuntimeSession(
            this.#plan,
            {
              seed: this.#seed,
              baseDelayMs: 0,
              delayPerWordMs: 0,
              delayPerCharacterMs: 0,
              scriptStorage: path.storage ?? [],
              wallClockMs: path.wallClockMs ?? EPOCH_MS,
            },
            { randomControl: { decide } },
          )
        : this.#runtime.createTaggedRuntimeSession(this.#plan, from.tagged, {
            randomControl: { decide },
          });
    const runtime = asRuntime(session);
    const visited = new Set<number>();
    const parent = options.resume?.parent;
    const decisions: Decision[] = parent?.decisions.filter((decision) => decision.step <= at) ?? [];
    const interactions: Interaction[] = parent?.interactions.slice(0, at) ?? [];
    const inputs: ExplorerInput[] = path.inputs.slice(0, at);
    const resumes: Resume[] = parent?.resumes.slice(0, at) ?? [];
    let instructions = 0;
    let lastNew = at;
    // Origins of temporaries as stored, by call depth and temporary ID; and of accepted inputs by action ID.
    const temporaryOrigins = new Map<string, Set<Origin>>();
    const inputOf = new Map<number, Origin>();
    let depth = 0;
    /** The temporaries the calls under way return into (null for none), innermost last. */
    const destinations: (number | null)[] = [];
    let inputCount = at;
    const recordOrigins = new Map<number, Set<Origin>>();
    const recordDataOrigins = new Map<number, Set<Origin>>();
    /** The origins a record has itself: the input, draw, or load it is, or a value's from before the resume point. */
    const ownOrigins = (entry: Data, control: boolean): Set<Origin> => {
      const found = new Set<Origin>();
      const detail = record(entry.detail);
      const variable = record(entry.variable);
      if (entry.kind === "unrecorded" && from !== undefined && typeof variable.name === "string") {
        // A value from before the resume point: its origins as the parent knew them there.
        const known = (control ? from.origins : from.dataOrigins).get(
          `${String(variable.scope)}:${variable.name}`,
        );
        for (const origin of known ?? []) found.add(origin);
      } else if (entry.kind === "input" && typeof detail.actionId === "number") {
        const origin = inputOf.get(detail.actionId);
        if (origin !== undefined) found.add(origin);
      } else if (entry.kind === "random") {
        const state = detail.stateBefore;
        const draw = draws.find((each) => each.drawId === state);
        if (draw !== undefined) found.add(`d${draw.occurrence}`);
      } else if (entry.kind === "load" && typeof detail.key === "string") {
        found.add(`k${detail.key}`);
        this.readKeys.add(detail.key);
      }
      return found;
    };
    /**
     * A record's origins: its own and those of what it read, and of the decision whose taken side it was written on (a
     * value set in an `if` depends on its condition too). Worked out depth first without recursion: a counter updated
     * thousands of times makes chains deeper than the call stack.
     */
    const originsOfRecord = (id: number, control = true): Set<Origin> => {
      const memo = control ? recordOrigins : recordDataOrigins;
      const known = memo.get(id);
      if (known !== undefined) return known;
      if (trace === undefined) return new Set();
      const path: { id: number; entry: Data | null; dependencies: number[]; next: number }[] = [];
      const onPath = new Set<number>();
      const enter = (each: number) => {
        const entry = trace.record(each);
        const dependencies =
          entry === null
            ? []
            : [...list(entry.dependencies), ...(control ? [record(entry.control)] : [])].flatMap(
                (dependency) => (typeof dependency.id === "number" ? [dependency.id] : []),
              );
        path.push({ id: each, entry, dependencies, next: 0 });
        onPath.add(each);
      };
      enter(id);
      while (path.length > 0) {
        const top = path[path.length - 1]!;
        if (top.next < top.dependencies.length) {
          const dependency = top.dependencies[top.next]!;
          top.next += 1;
          // One on the path already is a cycle, which adds nothing.
          if (!memo.has(dependency) && !onPath.has(dependency)) enter(dependency);
          continue;
        }
        path.pop();
        onPath.delete(top.id);
        const found = top.entry === null ? new Set<Origin>() : ownOrigins(top.entry, control);
        for (const dependency of top.dependencies)
          for (const origin of memo.get(dependency) ?? []) found.add(origin);
        memo.set(top.id, found);
      }
      return memo.get(id)!;
    };
    // Origins of the records an instruction made while it ran: the draws, inputs, and loads it read itself.
    const madeSince = (first: number): Set<Origin> => {
      const found = new Set<Origin>();
      if (trace === undefined) return found;
      const last = record(trace.status()).lastRecord;
      if (typeof last !== "number") return found;
      for (let id = first; id <= last; id += 1) {
        const entry = trace.record(id);
        if (entry !== null && (entry.kind === "random" || entry.kind === "load"))
          for (const origin of originsOfRecord(id)) found.add(origin);
      }
      return found;
    };
    /** The records made from `first` on. */
    const recordsSince = (first: number): number[] => {
      const last = trace === undefined ? null : record(trace.status()).lastRecord;
      if (typeof last !== "number") return [];
      return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);
    };
    const nextRecord = () => {
      const last = trace === undefined ? null : record(trace.status()).lastRecord;
      return typeof last === "number" ? last + 1 : 1;
    };
    const originsOfReads = (expression: unknown, first: number) => {
      const reads = readsOf(expression);
      const origins = madeSince(first);
      const data = new Set(origins);
      const fields = new Map<Origin, Set<string>>();
      if (trace !== undefined && reads.names.size > 0) {
        if (scopes === null) {
          scopes = scopesOf(session.exportTrustedSnapshot());
          // The blocks entered before are not known: leaving one looks the scopes up again.
          declaredIn.length = 0;
          loopDepths.clear();
        }
        for (const name of reads.names) {
          this.readNames.add(name);
          const scope = scopes.get(name);
          const id = scope === undefined ? null : trace.variableRecord(scope, name);
          if (id === null) continue;
          const from = originsOfRecord(id);
          for (const origin of from) origins.add(origin);
          for (const origin of originsOfRecord(id, false)) data.add(origin);
          // A field the condition reads of a form answer it holds.
          for (const field of reads.fields.get(name) ?? [])
            for (const origin of from)
              if (origin.startsWith("i"))
                fields.set(origin, (fields.get(origin) ?? new Set()).add(field));
        }
      }
      for (const temporary of reads.temporaries)
        for (const origin of temporaryOrigins.get(`${depth}:${temporary}`) ?? []) {
          origins.add(origin);
          data.add(origin);
        }
      return { origins, data, fields };
    };
    /** This state as a resume point, with the origins of the variables named like ones a condition read so far. */
    const resumePoint = (snapshot: Data): Resume => {
      const origins = new Map<string, Set<Origin>>();
      const dataOrigins = new Map<string, Set<Origin>>();
      if (trace !== undefined) {
        const name = (scope: number | "global", binding: Data) => {
          if (typeof binding.name !== "string" || !this.readNames.has(binding.name)) return;
          const id = trace.variableRecord(scope, binding.name);
          if (id === null) return;
          origins.set(`${String(scope)}:${binding.name}`, originsOfRecord(id));
          dataOrigins.set(`${String(scope)}:${binding.name}`, originsOfRecord(id, false));
        };
        for (const binding of list(snapshot.globals)) name("global", binding);
        for (const scope of [...list(snapshot.frames), ...list(snapshot.retainedScopes)])
          if (typeof scope.id === "number")
            for (const binding of list(scope.bindings)) name(scope.id, binding);
      }
      return { tagged: session.exportTaggedSnapshot(), draws: draws.length, origins, dataOrigins };
    };
    let measured: Measure | undefined;
    let measures = 0;
    const storages: StorageEntry[][] = [];
    const storageSteps: number[] = [];
    /** Steps that took a photo or found no camera, and whether the current step's input asks for a photo. */
    const captures = new Set<number>();
    let photo = false;
    const storageTexts = new Set<string>();
    /** Keeps a state's storage, once. */
    const saved = (snapshot: Data): void => {
      const storage = storageOf(snapshot);
      const text = JSON.stringify(storage);
      if (storageTexts.has(text)) return;
      storageTexts.add(text);
      storages.push(storage);
      storageSteps.push(inputs.length);
    };
    if (from === undefined) {
      storages.push([...(path.storage ?? [])]);
      storageSteps.push(0);
    }
    storageTexts.add(JSON.stringify(path.storage ?? []));
    const decisionCount = new Map<string, number>();
    const tracedAt = new Map<string, number>();
    // The scope of each visible name, read from a snapshot when needed and kept until an instruction changes scopes. A
    // block's scope and its declarations update it as they come (a loop's body enters one per round): per block entered
    // since, the names it declared and the scopes they had before.
    let scopes: Map<string, number | "global"> | null = null;
    const declaredIn: [string, number | "global" | undefined][][] = [];
    /** The blocks entered when each loop last started: a `break` or `continue` leaves the ones entered since. */
    const loopDepths = new Map<number, number>();
    const forgetScopes = () => {
      scopes = null;
      declaredIn.length = 0;
      loopDepths.clear();
    };
    /**
     * The callers' scopes, blocks, and loops, kept while their calls run, with the calls under way and the instruction
     * each returns to (a return elsewhere, such as a timer block's, is not theirs).
     */
    const callers: {
      readonly depth: number;
      readonly stack: string;
      readonly returnsTo: number;
      readonly scopes: Map<string, number | "global"> | null;
      readonly declaredIn: [string, number | "global" | undefined][][];
      readonly loopDepths: Map<number, number>;
    }[] = [];
    /** Leaves the innermost block entered: its declarations no longer hide the names' earlier scopes. */
    const leaveBlock = (): void => {
      const left = declaredIn.pop();
      if (left === undefined || scopes === null) forgetScopes();
      else
        for (const [name, before] of left.reverse())
          if (before === undefined) scopes.delete(name);
          else scopes.set(name, before);
    };
    let stepInstructions = 0;
    let end: Played["end"] | null = null;
    const executeOne = (next: unknown): boolean => {
      const first = nextRecord();
      // A call's arguments read in the caller's scope, before the call leaves it (a value's records keep only so many
      // dependencies, so the names they read count too).
      const call = typeof next === "number" ? this.#instructions[next] : undefined;
      const argumentOrigins =
        call?.kind === "callFunction" && typeof call.destinationTemporary === "number"
          ? originsOfReads(call.arguments, first).origins
          : null;
      if (call?.kind === "callFunction") {
        const stack = session.callReturnInstructions();
        callers.push({
          depth: stack.length,
          stack: JSON.stringify(stack),
          returnsTo: Number(call.returnInstruction),
          scopes,
          declaredIn: [...declaredIn],
          loopDepths: new Map(loopDepths),
        });
      }
      const result = session.executeInstruction({ ...traced, instructionTrace: true });
      if (result.randomRefusal !== undefined) end = "diverged";
      const executed = record(result.instructionTrace);
      instructions += 1;
      stepInstructions += 1;
      const declared: string[] = [];
      let declares = false;
      for (const index of Array.isArray(executed.instructions) ? executed.instructions : []) {
        if (typeof index !== "number") continue;
        visited.add(index);
        if (options.known !== undefined && options.known[index] !== 1) lastNew = step;
        const instruction = this.#instructions[index]!;
        if (instruction.kind === "enterScope") declaredIn.push([]);
        else if (instruction.kind === "leaveScope") leaveBlock();
        else if (instruction.kind === "declareBinding" && typeof instruction.name === "string") {
          declared.push(instruction.name);
          declares = true;
        } else if (instruction.kind === "loopStart") {
          loopDepths.set(Number(instruction.loopId), declaredIn.length);
          declares = true;
        } else if (instruction.kind === "loopControl") {
          const depth = loopDepths.get(Number(instruction.loopId));
          if (depth === undefined || depth > declaredIn.length) forgetScopes();
          else while (scopes !== null && declaredIn.length > depth) leaveBlock();
        } else if (!KEEPS_SCOPES.has(String(instruction.kind))) forgetScopes();
        if (options.origins && instruction.kind === "storeTemporary") {
          const { origins } = originsOfReads(instruction.value, first);
          temporaryOrigins.set(`${depth}:${String(instruction.temporaryId)}`, origins);
        }
        // A call's result, which a condition may read from its temporary, has the origins of the arguments it was given.
        if (
          options.origins &&
          instruction.kind === "callFunction" &&
          typeof instruction.destinationTemporary === "number"
        ) {
          // And the records the call made.
          const origins = new Set<Origin>(argumentOrigins ?? []);
          for (const id of recordsSince(first))
            for (const origin of originsOfRecord(id)) origins.add(origin);
          temporaryOrigins.set(`${depth}:${instruction.destinationTemporary}`, origins);
        }
        // A function's result also has the origins of what it returns, and of the decisions it returned under: the
        // records the return made (the step ran it, so the callee's names are out of scope by now).
        if (options.origins && instruction.kind === "returnValue" && depth > 0) {
          const destination = destinations[destinations.length - 1];
          if (destination !== undefined && destination !== null) {
            const key = `${depth - 1}:${destination}`;
            const origins = new Set(temporaryOrigins.get(key) ?? []);
            for (const id of recordsSince(first))
              for (const origin of originsOfRecord(id)) origins.add(origin);
            temporaryOrigins.set(key, origins);
          }
        }
        if (instruction.kind === "callFunction") {
          depth += 1;
          destinations.push(
            typeof instruction.destinationTemporary === "number"
              ? instruction.destinationTemporary
              : null,
          );
        }
        if (instruction.kind === "returnValue" || instruction.kind === "returnVoid") {
          depth = Math.max(0, depth - 1);
          destinations.pop();
        }
      }
      // The bindings declared (also a loop's variables), in the scopes the trace names; one it does not name is looked up
      // again.
      if (declares && scopes !== null && trace !== undefined) {
        const known: Map<string, number | "global"> = scopes;
        for (const id of recordsSince(first)) {
          const entry = trace.record(id);
          const variable = record(entry?.variable);
          if (
            entry === null ||
            !["declaration", "loopValue"].includes(String(entry.kind)) ||
            typeof variable.name !== "string" ||
            (typeof variable.scope !== "number" && variable.scope !== "global")
          )
            continue;
          declaredIn.at(-1)?.push([variable.name, known.get(variable.name)]);
          known.set(variable.name, variable.scope);
          const at = declared.indexOf(variable.name);
          if (at >= 0) declared.splice(at, 1);
        }
        if (declared.length > 0) forgetScopes();
      }
      // Back in a caller, its scopes are as they were (a call that did not come back, or not as V2 saw it, forgets them).
      const kinds = (Array.isArray(executed.instructions) ? executed.instructions : []).map(
        (index) => this.#instructions[Number(index)]?.kind,
      );
      // A transfer to another file leaves every call under way.
      if (kinds.includes("transfer")) callers.length = 0;
      if (kinds.some((kind) => kind === "returnValue" || kind === "returnVoid" || kind === "end")) {
        const now = session.callReturnInstructions();
        while (callers.length > 0 && callers.at(-1)!.depth > now.length) callers.pop();
        const back = callers.at(-1);
        if (
          back !== undefined &&
          back.stack === JSON.stringify(now) &&
          back.returnsTo === session.view().nextInstruction &&
          kinds.at(-1) !== "end"
        ) {
          callers.pop();
          forgetScopes();
          scopes = back.scopes;
          declaredIn.push(...back.declaredIn);
          for (const [loop, depth] of back.loopDepths) loopDepths.set(loop, depth);
        } else forgetScopes();
      }
      for (const branch of Array.isArray(executed.branches) ? executed.branches : []) {
        if (!Array.isArray(branch)) continue;
        const [from, to]: unknown[] = branch;
        if (typeof from !== "number" || typeof to !== "number") continue;
        const instruction = this.#instructions[from];
        if (instruction?.kind !== "jumpIfFalse" && instruction?.kind !== "loopStart") continue;
        const way: 0 | 1 = to === from + 1 ? 0 : 1;
        const key = `${step}:${from}`;
        const nth = decisionCount.get(key) ?? 0;
        decisionCount.set(key, nth + 1);
        const traced = tracedAt.get(key) ?? 0;
        // A decision whose other way is covered gets them too: a later target's dependency-closed prefix needs them.
        const wanted = options.origins && traced < ORIGINS_PER_INSTRUCTION;
        if (wanted) tracedAt.set(key, traced + 1);
        if (!wanted) {
          decisions.push({
            order: decisions.length,
            instruction: from,
            way,
            step,
            nth,
            ...NO_ORIGINS,
          });
          continue;
        }
        const reads = originsOfReads(
          instruction.condition ?? instruction.expression ?? instruction.source,
          first,
        );
        // The trace has no clock reads: the data flow tells whether the condition reads the clock.
        if (this.readsClock(from)) {
          reads.origins.add(CLOCK);
          reads.data.add(CLOCK);
        }
        decisions.push({
          order: decisions.length,
          instruction: from,
          way,
          step,
          nth,
          origins: reads.origins,
          dataOrigins: reads.data,
          fields: reads.fields,
        });
      }
      return true;
    };
    /**
     * Without origins: runs the script until it waits, in one call, recording each way its decisions took once. A run
     * over its instruction budget fails with the runtime's step-limit error, as in the Player.
     */
    const runAll = (): void => {
      absorb(
        session.run({ instructionTrace: true, instructionBudget: options.maxStepInstructions }),
      );
    };
    /** The step's instructions when the current run began (runs of single instructions count as one run). */
    let runStart = 0;
    /** Runs one instruction, measuring the state first when it is the one `options.measure` reads before. */
    const measureOne = (next: unknown): void => {
      // Past the measures, or at the run's last instruction, the rest runs as a whole: it fails at the budget as one run
      // would (its message names the budget left; a check's failure is not reported: the path it finds plays again).
      const left = options.maxStepInstructions - (stepInstructions - runStart);
      if (measures >= MAX_MEASURES || left <= 1) {
        absorb(
          session.run({ instructionTrace: true, instructionBudget: Math.max(1, left) }),
          measuredWays,
        );
        return;
      }
      const snapshot =
        next === options.measure?.instruction ? session.exportTrustedSnapshot() : null;
      const result = session.executeInstruction({ instructionTrace: true });
      // The state counts when that instruction ran next (a timer block that was due runs before it otherwise).
      const executed = record(result.instructionTrace).instructions;
      if (snapshot !== null && Array.isArray(executed) && executed[0] === next) {
        measures += 1;
        const found = options.measure!.read(snapshot);
        if (
          found.values.length > 0 &&
          (measured === undefined || found.distance < measured.distance)
        )
          measured = found;
      }
      absorb(result, measuredWays);
    };
    /** The ways decisions took in the measured step's run so far, recorded once as a whole run records them. */
    const measuredWays = new Set<number>();
    /**
     * Takes in what a run of instructions executed: the instructions, and each way its decisions took once (`once`
     * carries that over runs of single instructions).
     */
    const absorb = (result: Data, once?: Set<number>): void => {
      if (result.randomRefusal !== undefined) end = "diverged";
      const executed = record(result.instructionTrace);
      const count =
        typeof result.instructionsExecuted === "number" ? result.instructionsExecuted : 0;
      instructions += count;
      stepInstructions += count;
      for (const index of Array.isArray(executed.instructions) ? executed.instructions : [])
        if (typeof index === "number") {
          visited.add(index);
          if (options.known !== undefined && options.known[index] !== 1) lastNew = step;
          this.#readNamesOf(index);
        }
      for (const branch of Array.isArray(executed.branches) ? executed.branches : []) {
        if (!Array.isArray(branch)) continue;
        const [from, to]: unknown[] = branch;
        if (typeof from !== "number" || typeof to !== "number") continue;
        const kind = this.#instructions[from]?.kind;
        if (kind !== "jumpIfFalse" && kind !== "loopStart") continue;
        const way = to === from + 1 ? 0 : 1;
        if (once !== undefined) {
          if (once.has(from * 2 + way)) continue;
          once.add(from * 2 + way);
        }
        decisions.push({
          order: decisions.length,
          instruction: from,
          way,
          step,
          nth: 0,
          ...NO_ORIGINS,
        });
      }
    };
    const failed = () => record(session.view()).status === "failed";
    /** Runs until the player has to act, letting time pass when that is all there is to do. */
    const settle = (): void => {
      stepInstructions = 0;
      let waits = 0;
      for (;;) {
        let view = session.view();
        runStart = stepInstructions;
        measuredWays.clear();
        while (view.runnable === true) {
          if (options.origins) executeOne(view.nextInstruction);
          else if (options.measure?.instruction !== undefined && step === options.measure.at) {
            measureOne(view.nextInstruction);
            if (end !== null) return;
            // As for a whole run: the step's cap counts once the run is over, and not after one that failed.
            view = session.view();
            if (view.runnable === true) continue;
            if (view.status === "failed") return;
          } else runAll();
          if (end !== null) return;
          if (stepInstructions >= options.maxStepInstructions) {
            end = "stuck";
            return;
          }
          view = session.view();
        }
        if (view.status !== "waiting") return;
        const action = record(view.foregroundAction);
        if (action.kind === "capture") {
          const result = session.completeAction(
            {
              actionId: action.actionId,
              actionKind: "capture",
              // As V1: a photo when the step's input asks for one, else no camera.
              payload: photo
                ? { kind: "captured", media: { kind: "image", reference: EXPLORER_IMAGE } }
                : { kind: "unavailable", reason: "unconfigured" },
            },
            {
              ...traced,
              capturedMedia: { holds: (reference: string) => reference === EXPLORER_IMAGE },
            },
          );
          if (record(result.outcome).kind !== "completed") return;
          captures.add(step);
          continue;
        }
        const unloaded = session.mediaPlaybackProjection().find((media) => media.loaded !== true);
        if (unloaded !== undefined) {
          const result = session.reportMediaLoad(
            unloaded.mediaId,
            { kind: "loaded", durationMs: MEDIA_PASS_MS },
            traced,
          );
          if (record(result.outcome).kind !== "accepted") return;
          continue;
        }
        const offered = this.#options.options(runtime, view);
        if (offered.length !== 1 || offered[0]!.kind !== "wait" || waits >= MAX_AUTO_WAITS) return;
        if (!this.#give(session, view, offered[0]!, traced)) return;
        waits += 1;
      }
    };
    let checked = decisions.length;
    /** Whether a decision made since the last look is one `options.until` stops at. */
    const reached = (): boolean => {
      const found =
        options.until !== undefined &&
        decisions.slice(checked).some((decision) => options.until!(decision));
      checked = decisions.length;
      return found;
    };
    if (from === undefined) settle();
    for (;;) {
      if (end === null && reached()) end = "reached";
      if (end !== null) break;
      const view = session.view();
      if (view.status === "failed") {
        end = "failed";
        break;
      }
      if (view.status !== "waiting") {
        end = "exit";
        break;
      }
      const action = record(view.foregroundAction);
      const snapshot = session.exportTrustedSnapshot();
      const offered = this.#options.options(runtime, view, () => snapshot);
      const interaction: Interaction = {
        step: inputs.length,
        instruction: typeof action.owningInstruction === "number" ? action.owningInstruction : -1,
        options: offered,
        fields: list(record(action.ui).fields),
        // A check is not counted as a path: it needs no states.
        state: options.until === undefined ? this.relevantState(snapshot) : "",
      };
      interactions.push(interaction);
      if (
        options.measure !== undefined &&
        options.measure.instruction === undefined &&
        interactions.length - 1 === options.measure.at
      )
        measured = options.measure.read(snapshot);
      if (options.observe?.(snapshot, interactions.length - 1) === true) lastNew = inputs.length;
      if (options.until === undefined) saved(snapshot);
      if (options.keepResumes === true) resumes[inputs.length] = resumePoint(snapshot);
      if (inputs.length >= options.maxSteps) {
        end = "steps";
        break;
      }
      const tired = options.patience !== undefined && inputs.length - lastNew >= options.patience;
      const given =
        inputs.length < path.inputs.length
          ? path.inputs[inputs.length]!
          : tired
            ? null
            : (options.extend?.(interaction, inputs.length) ?? null);
      if (given === null) {
        end = "waiting";
        break;
      }
      // An input of a kind this state does not offer, or a choice it does not have: the path no longer fits. A form's
      // fields or a typed text may be ones V1 does not list (a solver made them).
      // Continuing later or at another wall clock fits any interaction (a solver makes those for the clock).
      // A button pressed after another time than those offered fits where the same button is offered (a solver chose the
      // time; a press after the deadline does not go through).
      const fits =
        given.kind === "later" || given.kind === "clock"
          ? true
          : given.kind === "form" || given.kind === "text"
            ? offered.some((option) => option.kind === given.kind)
            : given.kind === "button" && given.afterMs !== undefined
              ? offered.some((option) => option.kind === "button" && option.label === given.label)
              : offered.some((option) => sameInput(option, given));
      if (!fits) {
        end = "diverged";
        break;
      }
      if (action.kind === "interaction" && typeof action.actionId === "number")
        inputOf.set(action.actionId, `i${inputCount}`);
      if (typeof action.destinationTemporary === "number")
        temporaryOrigins.set(
          `${depth}:${action.destinationTemporary}`,
          new Set([`i${inputCount}`]),
        );
      inputCount += 1;
      step = inputs.length + 1;
      inputs.push(given);
      photo = given.photo === true;
      if (!this.#give(session, view, given, traced)) {
        end = "diverged";
        break;
      }
      settle();
      if (failed()) {
        end = "failed";
        break;
      }
    }
    this.instructionsRun += instructions;
    this.work +=
      instructions * (options.origins ? TRACED_WORK : 1) +
      (interactions.length - (options.resume?.at ?? 0)) * INTERACTION_WORK;
    const view = session.view();
    const last = session.exportTrustedSnapshot();
    if (options.until === undefined) saved(last);
    return {
      path,
      inputs,
      visited,
      decisions,
      interactions,
      draws,
      end: end ?? "exit",
      failure: view.status === "failed" ? failureOf(last) : null,
      instructions,
      resumes,
      storages,
      storageSteps,
      captures: [...captures],
      ...(measured === undefined ? {} : { measured }),
    };
  }

  /** Whether the condition of the decision at `index` reads the clock (through the variables it reads too). */
  readsClock(index: number): boolean {
    let reads = this.#clockReads.get(index);
    if (reads === undefined) {
      const instruction = this.#instructions[index];
      reads = this.flow.flowOf(
        instruction?.condition ?? instruction?.expression ?? instruction?.source,
      ).clock;
      this.#clockReads.set(index, reads);
    }
    return reads;
  }

  /**
   * Adds the names a condition, a temporary, or a call's arguments read at `index` to {@link readNames}, and the keys
   * they load by name to {@link readKeys}, the first time it runs without a trace.
   */
  #readNamesOf(index: number): void {
    if (this.#namesRead.has(index)) return;
    this.#namesRead.add(index);
    const instruction = this.#instructions[index];
    const expression =
      instruction?.kind === "storeTemporary"
        ? instruction.value
        : instruction?.kind === "callFunction" &&
            typeof instruction.destinationTemporary === "number"
          ? instruction.arguments
          : instruction?.kind === "jumpIfFalse" || instruction?.kind === "loopStart"
            ? (instruction.condition ?? instruction.expression ?? instruction.source)
            : undefined;
    if (expression === undefined) return;
    const reads = readsOf(expression);
    for (const name of reads.names) this.readNames.add(name);
    // The stored keys it loads by name (a traced run learns computed keys from the loads it records).
    for (const key of reads.keys) this.readKeys.add(key);
  }

  /**
   * The values, in a state, of the variables the conditions seen so far read and of the stored keys loads read, with
   * where the calls under way return and the loops under way stand (a `repeat`'s rounds left): what tells two visits of
   * one place apart for the conditions that matter.
   */
  relevantState(snapshot: Data): string {
    const values: string[] = [
      `calls ${list(snapshot.callFrames)
        .map((frame) => String(frame.returnInstruction))
        .join(",")}`,
      `loops ${JSON.stringify(
        list(snapshot.loopFrames).map(({ callFrameId: _, scopeDepth: __, ...loop }) => loop),
      )}`,
    ];
    const scopes = new Map<string, unknown>();
    for (const binding of list(snapshot.globals))
      if (typeof binding.name === "string") scopes.set(binding.name, binding.value);
    for (const frame of list(snapshot.frames))
      for (const binding of list(frame.bindings))
        if (typeof binding.name === "string") scopes.set(binding.name, binding.value);
    for (const name of [...this.readNames].sort())
      if (scopes.has(name)) values.push(`${name}=${JSON.stringify(scopes.get(name))}`);
    const stored = new Map(list(snapshot.scriptStorage).map((entry) => [entry.key, entry.value]));
    for (const key of [...this.readKeys].sort())
      values.push(`${key}:${JSON.stringify(stored.get(key) ?? null)}`);
    return hash(values.join("|"));
  }

  /** Gives the session one input; whether the runtime accepted it. */
  #give(session: RawSession, view: Data, input: ExplorerInput, traced: Data): boolean {
    const action = record(view.foregroundAction);
    const complete = (payload: Data) =>
      session.completeAction(
        {
          actionId: action.actionId,
          actionKind: "interaction",
          interactionKind: action.interactionKind,
          payload,
        },
        {
          ...traced,
          capturedMedia: { holds: (reference: string) => reference === EXPLORER_IMAGE },
        },
      );
    let result: Data;
    let accepted = "completed";
    switch (input.kind) {
      case "option":
        result = complete({ kind: "selectedOption", optionIndex: input.index });
        break;
      case "button":
        if (input.afterMs !== undefined) {
          const until = Number(view.observedSessionTimeMs) + input.afterMs;
          const observed = session.observeTime(until, mediaReports(session, view, until), traced);
          if (record(observed.outcome).kind !== "observed") return false;
        }
        result = complete({ kind: "activate" });
        break;
      case "text":
        result = complete({ kind: "submittedText", submittedText: input.text });
        break;
      case "image":
        result = complete({ kind: "image", reference: EXPLORER_IMAGE });
        break;
      case "form": {
        // As V1 fills a form: a toggle or cycle by option index, a typed field by edit, draft, and commit.
        const update = (edit: Data): boolean => {
          const outcome = record(
            session.updateInteraction(
              {
                actionId: action.actionId,
                actionKind: "interaction",
                interactionKind: "form",
                update: edit,
              },
              traced,
            ).outcome,
          ).kind;
          return outcome === "updated" || outcome === "unchanged";
        };
        if (input.action === "submit")
          for (const [fieldId, value] of Object.entries(input.fields ?? {})) {
            const done =
              typeof value === "number"
                ? update({ kind: "select", fieldId, optionIndex: value })
                : update({ kind: "edit", fieldId }) &&
                  update({ kind: "draft", fieldId, text: value }) &&
                  update({ kind: "commit", fieldId });
            if (!done) return false;
          }
        result = complete({ kind: input.action });
        break;
      }
      case "press":
        result = session.pressPermanentButton(input.buttonId, traced);
        accepted = "pressed";
        break;
      case "wait":
        result = session.observeTime(
          input.untilMs,
          mediaReports(session, view, input.untilMs),
          traced,
        );
        accepted = "observed";
        break;
      // As V1: the player continues at another wall clock, or saves and continues later.
      case "clock":
        result = session.recordContinueCapture({ wallClockMs: input.wallClockMs }, traced);
        accepted = "recorded";
        break;
      case "later":
        if (!(input.afterMs > 0 && Number.isSafeInteger(input.afterMs))) return false;
        result = session.recordContinueCapture(
          { wallClockMs: wallClockOf(session.exportTrustedSnapshot()) + input.afterMs },
          traced,
        );
        accepted = "recorded";
        break;
      default:
        return false;
    }
    return record(result.outcome).kind === accepted;
  }
}

/** A short hash of a text, to keep many states apart without keeping their text. */
function hash(text: string): string {
  return createHash("sha1").update(text).digest("base64");
}

/** An outcome of a draw's support picked by `random`, or undefined for a support V2 does not pick from. */
function randomOutcome(support: Data, random: () => number): Data | undefined {
  if (support.kind === "boolean") return { kind: "boolean", value: random() < 0.5 };
  if (support.kind === "integer") {
    const min = Number(support.min);
    const max = Number(support.max);
    if (Number.isSafeInteger(min) && Number.isSafeInteger(max) && max >= min)
      return { kind: "number", value: min + Math.floor(random() * (max - min + 1)) };
  }
  if (support.kind === "candidates" || support.kind === "weighted") {
    const count = Array.isArray(support.candidates) ? support.candidates.length : 0;
    if (count > 0) return { kind: "index", index: Math.floor(random() * count) };
  }
  return undefined;
}

/** The progress of the media playing while time passes until `until`, as V1 reports it. */
function mediaReports(session: RawSession, view: Data, until: number): Data[] {
  const now = typeof view.observedSessionTimeMs === "number" ? view.observedSessionTimeMs : 0;
  return session
    .mediaPlaybackProjection()
    .filter((media) => media.state === "running" && media.loaded === true)
    .map((media) => ({
      mediaId: media.mediaId,
      segment: media.segment,
      progressMs:
        (typeof media.reportedProgressMs === "number" ? media.reportedProgressMs : 0) + until - now,
    }));
}

/** Whether two inputs are the same answer. */
/** Whether two inputs give the same answer, whatever photo they let a capture take and random outcomes they fix. */
/**
 * A play's inputs with the outcomes its path fixed (other than the draws' natural ones) on the input whose step drew
 * them, as V1's `random` (where a player needs luck: the report says so), and those drawn before the first input. Plays
 * and replays go by the path's draws, not by these.
 */
export function withChosenDraws(
  inputs: readonly ExplorerInput[],
  draws: readonly DrawEvent[],
): { inputs: ExplorerInput[]; random?: RandomChoice[] } {
  const chosen = (step: number): RandomChoice[] =>
    draws
      .filter(
        (draw) =>
          draw.step === step && JSON.stringify(draw.outcome) !== JSON.stringify(draw.natural),
      )
      .map((draw) => ({ drawId: draw.drawId, site: draw.site, outcome: draw.outcome }));
  const first = chosen(0);
  return {
    inputs: inputs.map((input, index) => {
      const random = chosen(index + 1);
      return random.length === 0 ? input : { ...input, random };
    }),
    ...(first.length === 0 ? {} : { random: first }),
  };
}

export function sameInput(left: ExplorerInput, right: ExplorerInput): boolean {
  const { random: _left, photo: _leftPhoto, ...a } = left;
  const { random: _right, photo: _rightPhoto, ...b } = right;
  return JSON.stringify(a) === JSON.stringify(b);
}
