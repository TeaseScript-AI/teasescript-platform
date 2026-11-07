import {
  compileProject,
  compileSource,
  createFreshRuntimeSession,
  createRuntimeSession,
  createTaggedRuntimeSession,
  deserializeRuntimeSession,
  restoreRuntimeSession,
  RuntimeDebugContext,
  runtimeTimedWork,
  serializeCheckpoint,
  type ActionCompletionOptions,
  type CompileOptions,
  type FreshRuntimeOptions,
  type InstructionPlan,
  type ProjectSourceFile,
  type RandomControlOptions,
  type RandomDecision,
  type RuntimeCheckpoint,
  type RuntimeSession,
  type RuntimeSessionOptions,
  type RuntimeSessionResult,
  type RuntimeSessionView,
  type RuntimeSnapshot,
  type TaggedRuntimeSnapshot,
} from "../../src/index.js";
import { compileProjectWithBackend, compileSourceWithBackend } from "../../src/compiler.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import {
  canonicalDigest,
  canonicalText,
  compareStructures,
  IDENTITY,
  MappingFailure,
  SerializerFailure,
  type Correspondence,
  type StructureMismatch,
} from "./runtime-state-comparison.js";

/*
 * The differential driver (docs/TESTING.md "Differential harness"): two pipelines compile and run the same input, one
 * instruction or wait settlement at a time, and every state's complete record is compared, in the uninterrupted run
 * and in every restore route from a bounded set of cut points. Here both pipelines are this build, in this process.
 */

export type Route = "legacy" | "core";

/** A source or an ordered project, its fresh-session options, and how the harness decides random draws. */
export interface DifferentialInput {
  readonly name: string;
  /** One file for a single source, or a project's files when `project` is set. */
  readonly sources: readonly ProjectSourceFile[];
  readonly project?: boolean;
  /** By default, the names of `fresh.globals` as the declared globals. */
  readonly compile?: CompileOptions;
  readonly fresh?: FreshRuntimeOptions;
  /**
   * Random control through the harness's decision callback, whose calls are logged and compared: `natural` keeps each
   * natural result, `choose` chooses it as an input with a receipt. Absent leaves every draw natural, without control.
   */
  readonly random?: "natural" | "choose";
}

/** What a pipeline gave for an input and route. */
export type Compiled =
  | { readonly kind: "plan"; readonly plan: InstructionPlan; readonly diagnostics: unknown }
  | { readonly kind: "rejected"; readonly diagnostics: unknown }
  | { readonly kind: "unsupported"; readonly reason: string };

/** A pipeline: how it compiles, and its public session API. */
export interface PipelineAdapter {
  readonly label: string;
  compile(input: DifferentialInput, route: Route): Compiled;
  readonly sessions: {
    readonly createFreshRuntimeSession: typeof createFreshRuntimeSession;
    readonly createRuntimeSession: typeof createRuntimeSession;
    readonly createTaggedRuntimeSession: typeof createTaggedRuntimeSession;
    readonly restoreRuntimeSession: typeof restoreRuntimeSession;
    readonly deserializeRuntimeSession: typeof deserializeRuntimeSession;
    readonly serializeCheckpoint: typeof serializeCheckpoint;
    readonly runtimeTimedWork: typeof runtimeTimedWork;
    readonly RuntimeDebugContext: typeof RuntimeDebugContext;
  };
}

/** This build, in this process. */
function thisBuild(label: string): PipelineAdapter {
  return {
    label,
    compile(input, route) {
      const options = input.compile ?? { globals: Object.keys(input.fresh?.globals ?? {}) };
      const first = input.sources[0]!.source;
      let result;
      try {
        if (route === "legacy")
          result = input.project
            ? compileProject(input.sources, options)
            : compileSource(first, options);
        else
          result = input.project
            ? compileProjectWithBackend(input.sources, options, CORE_BACKEND)
            : compileSourceWithBackend(first, options, CORE_BACKEND);
      } catch (error) {
        if (error instanceof CandidateOutsideSlice)
          return { kind: "unsupported", reason: error.message };
        throw error;
      }
      // Every field of every diagnostic, in order.
      const diagnostics = result.diagnostics.map((item) => ({ ...item }));
      return result.plan === null
        ? { kind: "rejected", diagnostics }
        : { kind: "plan", plan: result.plan, diagnostics };
    },
    sessions: {
      createFreshRuntimeSession,
      createRuntimeSession,
      createTaggedRuntimeSession,
      restoreRuntimeSession,
      deserializeRuntimeSession,
      serializeCheckpoint,
      runtimeTimedWork,
      RuntimeDebugContext,
    },
  };
}

/** How one side's run ended. */
export type SideOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "waiting" }
  | {
      readonly kind: "structured-fault";
      readonly code: string;
      readonly path: string;
      readonly span: unknown;
      readonly pc: number;
    }
  | { readonly kind: "compile-rejected"; readonly diagnostics: unknown }
  | { readonly kind: "unsupported-route"; readonly reason: string }
  | { readonly kind: "admission-rejected"; readonly error: string }
  | {
      readonly kind: "serializer-failure";
      readonly stage: Stage;
      readonly method: string | null;
      readonly error: string;
    }
  | {
      readonly kind: "harness-failure";
      readonly stage: Stage;
      readonly method: string | null;
      readonly error: string;
    }
  | { readonly kind: "censored"; readonly reason: string };

/**
 * The driver's stage, which a side's harness failure names with the call that threw: compilation, the left side's run
 * that places the cut points, the setup of the uninterrupted run, its opening records, its steps, the capture of
 * restore points, the restore routes, and the writing of records.
 */
export type Stage =
  "compile" | "probe" | "setup" | "opening" | "step" | "capture" | "restore" | "write";

/** Each restore route, independent: never one rebuilt from another. */
const RESTORE_TAILS = [
  "fork",
  "checked-snapshot",
  "trusted-snapshot",
  "tagged-snapshot",
  "checkpoint",
  "checkpoint-json",
] as const;

export type RestoreTail = (typeof RESTORE_TAILS)[number];

/** The run a record belongs to: the uninterrupted run, or a restore route from a cut point. */
export type Tail = "uninterrupted" | RestoreTail;

/**
 * Where a comparison was: the run, its cut, the state index (0 is the fresh state; a tail from cut `c` starts at state
 * `c`), and what the record was compared against.
 */
export interface ComparisonSite {
  readonly tail: Tail | "compile";
  readonly cut: number | null;
  readonly state: number;
  readonly against: "other-side" | "uninterrupted";
}

export type PairVerdict =
  | { readonly kind: "equivalent" }
  | {
      readonly kind: "discrepancy";
      readonly at: ComparisonSite;
      readonly mismatches: readonly StructureMismatch[];
    }
  | { readonly kind: "mapping-failure"; readonly at: ComparisonSite; readonly error: string }
  | {
      readonly kind: "not-compared";
      readonly side: "left" | "right";
      readonly because: SideOutcome["kind"];
    };

export interface DifferentialReport {
  readonly name: string;
  readonly route: Route;
  /** How each side ended, or `null` when the comparison stopped first. */
  readonly outcomes: { readonly left: SideOutcome | null; readonly right: SideOutcome | null };
  readonly verdict: PairVerdict;
  /** Each side's admitted plan as `canonicalDigest`, or `null` without one. */
  readonly plans: { readonly left: string | null; readonly right: string | null };
  /** Steps of the uninterrupted run. */
  readonly steps: number;
  readonly cuts: readonly number[];
  /** Whether the mandatory cuts alone passed the cap, so that all of them were kept. */
  readonly cutsOverCap: boolean;
  /** Steps the restore routes ran, per side. */
  readonly tailSteps: number;
  /** Describes only; never decides. */
  readonly cpuMs: number;
}

/**
 * A record as one side gave it, before writing. `state` is what every run of a side agrees on at the same state index;
 * `traces` (the observer log, the instruction trace, the debug trace) are compared only between the two sides of the
 * same run, since a restore starts a new debug epoch.
 */
export interface SideRecord {
  readonly state: {
    readonly operation: string;
    /** The host call that led to this state, as `recordedHost` records it, or `null`. */
    readonly host: unknown;
    readonly result: unknown;
    readonly decisions: readonly unknown[];
    readonly snapshot: unknown;
  };
  readonly traces: {
    readonly observer: readonly unknown[];
    readonly instructionTrace: unknown;
    readonly debug: unknown;
  };
}

/** Where an injection applies: the run, its cut, and the state index. */
export interface InjectionSite {
  readonly side: "left" | "right";
  readonly tail: Tail;
  readonly cut: number | null;
  readonly state: number;
}

export interface DifferentialOptions {
  readonly left?: PipelineAdapter;
  readonly right?: PipelineAdapter;
  readonly route?: Route;
  readonly correspondence?: Correspondence;
  /** The most cut points, unless the mandatory ones alone are more; 32 by default. */
  readonly maxCuts?: number;
  /** The steps after which a run is censored; 5,000 by default. */
  readonly maxSteps?: number;
  /** A corruption of a side's records, in the harness and never in the engine: the sensitivity controls. */
  readonly inject?: (record: SideRecord, at: InjectionSite) => SideRecord;
  /** The most mismatches a discrepancy reports; 10 by default. */
  readonly limit?: number;
  /**
   * The host, one per run, made by this factory for each side's uninterrupted run (and the cut probe's, as `left`). The driver
   * asks it whenever its side is neither runnable nor paused at a random draw; `null` ends the run as waiting. Without
   * it, the driver observes the next delay deadline. Restore routes replay their side's uninterrupted host calls at the
   * same state index, so every run of a side, and both sides, observe time at the same points; a captured-media
   * admission is replayed from the questions and answers its uninterrupted call recorded.
   */
  readonly host?: (side: "left" | "right") => HostDriver;
  /** Test only: a fault the side's guard throws in place of the call at each point it returns `true` for. */
  readonly fault?: (point: CallPoint) => boolean;
  /** Test only: told each call the harness makes into a side, in order. */
  readonly calls?: (point: CallPoint) => void;
  /** Test only: no guard, every call made directly, to show the guard changes no record. */
  readonly unguarded?: boolean;
}

/** A host of one side's run. */
export interface HostDriver {
  next(view: RuntimeSessionView): HostCall | null;
}

/** A host operation of the public session API, with its arguments; each takes the side's debug trace. */
export type HostCall =
  | { readonly kind: "observeTime"; readonly nowMs: number; readonly reports?: readonly unknown[] }
  | {
      readonly kind: "completeAction";
      readonly request: unknown;
      readonly capturedMedia?: ActionCompletionOptions["capturedMedia"];
    }
  | { readonly kind: "reportMediaLoad"; readonly mediaId: unknown; readonly report: unknown }
  | { readonly kind: "updateInteraction"; readonly request: unknown }
  | { readonly kind: "pressPermanentButton"; readonly buttonId: unknown }
  | { readonly kind: "recordContinueCapture"; readonly capture: unknown }
  | { readonly kind: "applyExternalStorageEdit"; readonly edit: unknown }
  | { readonly kind: "setDebugMode"; readonly enabled: unknown };

type CapturedMedia = NonNullable<ActionCompletionOptions["capturedMedia"]>;

/** One question a captured-media admission answered: as `player/debug-export.ts` records its admission queries. */
interface AdmissionQuery {
  readonly reference: string;
  readonly kind: Parameters<CapturedMedia["holds"]>[1];
  readonly result: boolean;
}

/**
 * A host call as its record holds it, plain data: a captured-media admission as the questions it was asked during the
 * call and its answers, in order, or `null` without one.
 */
type HostCallRecord =
  | Exclude<HostCall, { readonly kind: "completeAction" }>
  | (Omit<Extract<HostCall, { readonly kind: "completeAction" }>, "capturedMedia"> & {
      readonly capturedMedia: readonly AdmissionQuery[] | null;
    });

/**
 * A detached copy of a host call's plain data, so that a host that reuses its objects cannot change a recorded call.
 * Throws `SerializerFailure` for a call that is not plain data.
 */
function detached<T>(call: T): T {
  // EVIDENCE: validation: `canonicalText` writes plain data as JSON, which `JSON.parse` reads back as the same data.
  return JSON.parse(canonicalText(call)) as T;
}

/** Applies `call`, already detached, with its captured-media admission's questions and answers recorded. */
function recordedHost(
  session: RuntimeSession,
  call: HostCall,
  debugTrace: RuntimeDebugContext | null,
): {
  readonly result: RuntimeSessionResult & { readonly outcome?: unknown };
  readonly record: HostCallRecord;
} {
  if (call.kind !== "completeAction")
    return { result: applyHost(session, call, debugTrace), record: call };
  const { capturedMedia, ...rest } = call;
  if (capturedMedia === undefined)
    return {
      result: applyHost(session, rest, debugTrace),
      record: { ...rest, capturedMedia: null },
    };
  const queries: AdmissionQuery[] = [];
  const recording: CapturedMedia = {
    holds: (reference, kind) => {
      const result = capturedMedia.holds(reference, kind);
      queries.push({ reference, kind, result });
      return result;
    },
  };
  const result = applyHost(session, { ...rest, capturedMedia: recording }, debugTrace);
  return { result, record: { ...rest, capturedMedia: queries } };
}

/**
 * The host call a restore route replays from its record, independent of any host object's state: its captured-media
 * admission answers the recorded questions in order, and `false` to any other. A different or a missing question then
 * shows in the replay's own record, a discrepancy at `state.host`.
 */
function replayed(record: HostCallRecord): HostCall {
  if (record.kind !== "completeAction") return record;
  const { capturedMedia: queries, ...rest } = record;
  if (queries === null) return rest;
  let next = 0;
  return {
    ...rest,
    capturedMedia: {
      holds: (reference, kind) => {
        const expected = queries[next];
        next += 1;
        return expected !== undefined && expected.reference === reference && expected.kind === kind
          ? expected.result
          : false;
      },
    },
  };
}

/** Applies `call` to `session`, with `debugTrace`. */
function applyHost(
  session: RuntimeSession,
  call: HostCall,
  debugTrace: RuntimeDebugContext | null,
): RuntimeSessionResult & { readonly outcome?: unknown } {
  const trace = debugTrace === null ? {} : { debugTrace };
  switch (call.kind) {
    case "observeTime":
      return session.observeTime(call.nowMs, call.reports ?? [], trace);
    case "completeAction":
      return session.completeAction(call.request, {
        ...trace,
        ...(call.capturedMedia === undefined ? {} : { capturedMedia: call.capturedMedia }),
      });
    case "reportMediaLoad":
      return session.reportMediaLoad(call.mediaId, call.report, trace);
    case "updateInteraction":
      return session.updateInteraction(call.request, trace);
    case "pressPermanentButton":
      return session.pressPermanentButton(call.buttonId, trace);
    case "recordContinueCapture":
      return session.recordContinueCapture(call.capture, trace);
    case "applyExternalStorageEdit":
      return session.applyExternalStorageEdit(call.edit, trace);
    case "setDebugMode":
      return session.setDebugMode(call.enabled, trace);
  }
}

/** How a side's run gets its host calls: by the state index it is at, and its view. */
type HostSource = (state: number, view: RuntimeSessionView) => HostCall | null;

/** The driver's own host: it observes the next delay deadline, and settles nothing else. */
function deadlineHost(timedWork: typeof runtimeTimedWork): HostSource {
  return (_, view) => {
    const work = timedWork(view);
    if (work.length === 0) return null;
    if (work.some((item) => item.kind === "media"))
      throw new Error("The driver's own host settles delays only; give a host for media.");
    return { kind: "observeTime", nowMs: Math.min(...work.map((item) => item.deadlineMs)) };
  };
}

/** A host call with its plain data detached, so that a host that reuses its objects cannot change a recorded call. */
function detachedCall(call: HostCall): HostCall {
  if (call.kind !== "completeAction") return detached(call);
  const { capturedMedia, ...rest } = call;
  return capturedMedia === undefined ? detached(rest) : { ...detached(rest), capturedMedia };
}

const DEFAULT_MAX_CUTS = 32;
const DEFAULT_MAX_STEPS = 5_000;

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * A call from the harness into a side: the side, the driver's stage when it was made, the method (such as
 * `RuntimeSession.executeInstruction` or `host.next`), and its ordinal among the side's calls of that stage and method.
 */
export interface CallPoint {
  readonly side: "left" | "right";
  readonly stage: Stage;
  readonly method: string;
  readonly ordinal: number;
}

/** The public calls whose exceptions are the engine's own behaviour: an admission, or a restore that threw. */
const ENGINE_CALLS: ReadonlySet<string> = new Set([
  "createFreshRuntimeSession",
  "createRuntimeSession",
  "createTaggedRuntimeSession",
  "restoreRuntimeSession",
  "deserializeRuntimeSession",
  "RuntimeSession.fork",
]);

/** A side's own failure, at the call that threw: the pair ends `not-compared` with it. */
class SideFault extends Error {
  public constructor(
    readonly side: "left" | "right",
    readonly stage: Stage,
    readonly method: string,
    readonly fault: unknown,
  ) {
    super(`${side} ${stage}/${method}: ${errorText(fault)}`);
  }
}

/**
 * The one boundary between the harness and a side: every call the harness makes into a side's adapter, its sessions,
 * its debug contexts and its host passes through `call`, so that a side's exception is classified alike wherever it
 * happens, and a call site added later is covered by construction. It wraps only the harness's own calls: what the
 * engine receives (plans, snapshots, options, debug contexts, observers) is the side's own value, unchanged.
 */
class SideGuard {
  readonly #counts = new Map<string, number>();

  public constructor(
    readonly side: "left" | "right",
    private readonly phase: { stage: Stage },
    private readonly options: Pick<DifferentialOptions, "fault" | "calls" | "unguarded">,
  ) {}

  /** Runs one call into the side. An engine call's exception passes through as it is; any other is a `SideFault`. */
  public call<T>(method: string, run: () => T): T {
    if (this.options.unguarded === true) return run();
    const stage = this.phase.stage;
    const key = `${stage} ${method}`;
    const ordinal = this.#counts.get(key) ?? 0;
    this.#counts.set(key, ordinal + 1);
    const point: CallPoint = { side: this.side, stage, method, ordinal };
    this.options.calls?.(point);
    try {
      if (this.options.fault?.(point) === true)
        throw new Error(`test-only fault at ${stage} ${method} #${ordinal}`);
      return run();
    } catch (error) {
      if (ENGINE_CALLS.has(method) || error instanceof SideFault || error instanceof Stop)
        throw error;
      throw new SideFault(this.side, stage, method, error);
    }
  }

  /**
   * A view of `target` for the harness's own calls: each method call passes through `call`, bound to `target` itself,
   * so its private state, identity and order of effects are the target's. A method that returns a session returns its
   * view in turn. The harness never hands such a view to the engine.
   */
  public view<T extends object>(target: T, name: string): T {
    if (this.options.unguarded === true) return target;
    return new Proxy(target, {
      get: (object, key) => {
        // EVIDENCE: validation: a property read of the side's own object, which the proxy only forwards.
        const value: unknown = (object as Record<string | symbol, unknown>)[key];
        if (typeof value !== "function") return value;
        const method = `${name}.${String(key)}`;
        return (...args: unknown[]) => {
          const result: unknown = this.call(method, () => value.apply(object, args));
          return method === "RuntimeSession.fork" && typeof result === "object" && result !== null
            ? this.view(result, name)
            : result;
        };
      },
    });
  }

  /** The side's adapter, every function of it a call through this guard, every session it makes a view. */
  public adapter(adapter: PipelineAdapter): GuardedAdapter {
    const sessions = adapter.sessions;
    const session = (method: string, make: () => RuntimeSession) =>
      this.view(this.call(method, make), "RuntimeSession");
    return {
      compile: (input, route) => this.call("compile", () => adapter.compile(input, route)),
      createFreshRuntimeSession: (plan, fresh, options) =>
        session("createFreshRuntimeSession", () =>
          sessions.createFreshRuntimeSession(plan, fresh, options),
        ),
      createRuntimeSession: (plan, snapshot, options) =>
        session("createRuntimeSession", () =>
          sessions.createRuntimeSession(plan, snapshot, options),
        ),
      createTaggedRuntimeSession: (plan, tagged, options) =>
        session("createTaggedRuntimeSession", () =>
          sessions.createTaggedRuntimeSession(plan, tagged, options),
        ),
      restoreRuntimeSession: (checkpoint, options) =>
        session("restoreRuntimeSession", () => sessions.restoreRuntimeSession(checkpoint, options)),
      deserializeRuntimeSession: (json, options) =>
        session("deserializeRuntimeSession", () =>
          sessions.deserializeRuntimeSession(json, options),
        ),
      serializeCheckpoint: (checkpoint) =>
        this.call("serializeCheckpoint", () => sessions.serializeCheckpoint(checkpoint)),
      runtimeTimedWork: (view) =>
        this.call("runtimeTimedWork", () => sessions.runtimeTimedWork(view)),
      debugContext: () => {
        const context = this.call(
          "RuntimeDebugContext.constructor",
          () => new sessions.RuntimeDebugContext(),
        );
        return { context, calls: this.view(context, "RuntimeDebugContext") };
      },
    };
  }
}

/** A side's adapter as the driver calls it: through its guard. */
interface GuardedAdapter {
  compile(input: DifferentialInput, route: Route): Compiled;
  createFreshRuntimeSession(...args: Parameters<typeof createFreshRuntimeSession>): RuntimeSession;
  createRuntimeSession(...args: Parameters<typeof createRuntimeSession>): RuntimeSession;
  createTaggedRuntimeSession(
    ...args: Parameters<typeof createTaggedRuntimeSession>
  ): RuntimeSession;
  restoreRuntimeSession(...args: Parameters<typeof restoreRuntimeSession>): RuntimeSession;
  deserializeRuntimeSession(...args: Parameters<typeof deserializeRuntimeSession>): RuntimeSession;
  serializeCheckpoint(...args: Parameters<typeof serializeCheckpoint>): string;
  runtimeTimedWork(
    ...args: Parameters<typeof runtimeTimedWork>
  ): ReturnType<typeof runtimeTimedWork>;
  /** A new debug context: the side's own, which the engine receives, and the harness's view of it. */
  debugContext(): { readonly context: RuntimeDebugContext; readonly calls: RuntimeDebugContext };
}

/** The harness's decision callback, which logs each draw it is asked about. */
class DecisionLog {
  public calls: unknown[] = [];
  public constructor(private readonly mode: DifferentialInput["random"]) {}

  public options(): RuntimeSessionOptions {
    const mode = this.mode;
    if (mode === undefined) return {};
    const randomControl: RandomControlOptions = {
      decide: (draw): RandomDecision => {
        this.calls.push({
          drawId: draw.drawId,
          site: draw.site,
          kind: draw.kind,
          natural: draw.natural,
        });
        if (mode === "natural" || draw.natural.kind === "failure") return { kind: "natural" };
        return { kind: "choose", outcome: draw.natural };
      },
    };
    return { randomControl };
  }
}

type Operation =
  | { readonly kind: "resume"; readonly drawId: number }
  | { readonly kind: "execute" }
  | { readonly kind: "host"; readonly call: HostCall }
  | { readonly kind: "end"; readonly outcome: SideOutcome };

/** What a side does next at `state` from `view`: resume a paused draw, execute, make its host's call, or end. */
function nextOperation(view: RuntimeSessionView, state: number, host: HostSource): Operation {
  if (view.status === "halted") return { kind: "end", outcome: { kind: "completed" } };
  if (view.status === "failed") {
    const failure = view.failure!;
    return {
      kind: "end",
      outcome: {
        kind: "structured-fault",
        code: failure.code,
        path: failure.path,
        span: failure.span,
        pc: view.nextInstruction,
      },
    };
  }
  if (view.randomDraw !== null) return { kind: "resume", drawId: view.randomDraw.drawId };
  if (view.runnable) return { kind: "execute" };
  const call = host(state, view);
  return call === null ? { kind: "end", outcome: { kind: "waiting" } } : { kind: "host", call };
}

/** One side's session, stepped one instruction or settlement at a time, with its own debug context and logs. */
class Side {
  /** The side's debug context, which the engine receives, and the harness's view of it. */
  private readonly debug: RuntimeDebugContext;
  private readonly debugCalls: RuntimeDebugContext;
  private nextRecord: number;
  /** The host calls this run made, as their records, by the state index each was made at. */
  public readonly calls = new Map<number, HostCallRecord>();

  public constructor(
    adapter: GuardedAdapter,
    public readonly session: RuntimeSession,
    private readonly decisions: DecisionLog,
    origin: "start" | "restore",
    private readonly host: HostSource,
    /** The state index the run is at. */
    private state: number,
  ) {
    ({ context: this.debug, calls: this.debugCalls } = adapter.debugContext());
    this.debugCalls.reset(origin);
    this.nextRecord = this.debugCalls.status().nextRecord;
  }

  /** The record of the state the side starts the run at. */
  public opening(operation: "start" | "restore"): SideRecord {
    return this.record(operation, null, null, [], null);
  }

  /** What the side does next, decided without doing it. */
  public next(): Operation {
    return nextOperation(this.session.view(), this.state, this.host);
  }

  /** Does `next`, an operation `next()` decided. */
  public apply(next: Exclude<Operation, { readonly kind: "end" }>): SideRecord {
    const observer: unknown[] = [];
    // A passive observer: it never returns `true`, so it never ends an operation.
    const traced = {
      debugTrace: this.debug,
      instructionTrace: true,
      instructionObserver: {
        before: (instruction: number, call: number) => {
          observer.push({ hook: "before", instruction, call });
        },
        after: (instruction: number, next: number, call: number) => {
          observer.push({ hook: "after", instruction, nextInstruction: next, call });
        },
        dispatch: (block: number, call: number) => {
          observer.push({ hook: "dispatch", block, call });
        },
      },
    };
    this.decisions.calls = [];
    let result: RuntimeSessionResult & { readonly outcome?: unknown };
    let operation: string;
    let call: HostCallRecord | null = null;
    if (next.kind === "resume") {
      operation = `resume ${next.drawId}`;
      result = this.session.resumeRandomDraw({ drawId: next.drawId, outcome: "natural" }, traced);
    } else if (next.kind === "execute") {
      operation = "execute";
      result = this.session.executeInstruction(traced);
    } else {
      // A host operation takes the debug trace only, as the public contract gives it.
      operation = `host ${next.call.kind}`;
      ({ result, record: call } = recordedHost(this.session, next.call, this.debug));
      this.calls.set(this.state, call);
    }
    this.state += 1;
    return this.record(operation, call, result, observer, result.instructionTrace ?? null);
  }

  private record(
    operation: string,
    host: unknown,
    result: (RuntimeSessionResult & { readonly outcome?: unknown }) | null,
    observer: readonly unknown[],
    instructionTrace: unknown,
  ): SideRecord {
    const status = this.debugCalls.status();
    const records: unknown[] = [];
    for (let id = this.nextRecord; id < status.nextRecord; id += 1)
      records.push(this.debugCalls.record(id));
    this.nextRecord = status.nextRecord;
    return {
      state: {
        operation,
        host,
        result:
          result === null
            ? null
            : // Only the fields the result has, so that the record reads back from its text unchanged.
              {
                events: result.events,
                instructionsExecuted: result.instructionsExecuted,
                ...(result.randomChoices === undefined
                  ? {}
                  : { randomChoices: result.randomChoices }),
                ...(result.randomRefusal === undefined
                  ? {}
                  : { randomRefusal: result.randomRefusal }),
                ...("outcome" in result ? { outcome: result.outcome } : {}),
              },
        decisions: this.decisions.calls,
        snapshot: this.session.exportTrustedSnapshot(),
      },
      traces: { observer, instructionTrace, debug: { status, records } },
    };
  }
}

/** A record and its two parts as `canonicalText`. */
interface Written {
  readonly record: SideRecord;
  readonly state: string;
  readonly traces: string;
}

/** Ends the pair early: with a verdict, and for a side outcome that leaves it not compared, that outcome. */
class Stop extends Error {
  public constructor(
    readonly verdict: PairVerdict,
    readonly outcome: {
      readonly side: "left" | "right";
      readonly outcome: SideOutcome;
    } | null = null,
  ) {
    super(verdict.kind);
  }
}

function notCompared(side: "left" | "right", outcome: SideOutcome): Stop {
  return new Stop({ kind: "not-compared", side, because: outcome.kind }, { side, outcome });
}

/** Writes a record's two parts as `canonicalText`. */
function write(record: SideRecord): Written {
  return { record, state: canonicalText(record.state), traces: canonicalText(record.traces) };
}

/**
 * The cut points of a run of `steps` steps; cut `c` restores the state after step `c`. First the mandatory cuts: the
 * fresh state, the state before a fault, the first and last waits, and the states before the first and last
 * event-emitting steps. Then, up to `cap` in all, the other waits and event steps at evenly spaced positions, then
 * every k-th state. All by index, without randomness.
 */
function cutPoints(
  steps: number,
  waits: readonly number[],
  emitting: readonly number[],
  faulted: boolean,
  cap: number,
): { readonly cuts: readonly number[]; readonly overCap: boolean } {
  const valid = (cut: number) => cut >= 0 && cut < steps;
  const ascending = (cuts: Iterable<number>) => [...cuts].sort((a, b) => a - b);
  const before = emitting.map((step) => step - 1);
  const mandatory = new Set(
    [
      0,
      ...(faulted ? [steps - 1] : []),
      ...(waits.length > 0 ? [waits[0]!, waits.at(-1)!] : []),
      ...(before.length > 0 ? [before[0]!, before.at(-1)!] : []),
    ].filter(valid),
  );
  if (mandatory.size >= cap) return { cuts: ascending(mandatory), overCap: mandatory.size > cap };
  const chosen = new Set(mandatory);
  const pool = ascending(
    new Set([...waits, ...before].filter((cut) => valid(cut) && !chosen.has(cut))),
  );
  const room = cap - chosen.size;
  if (pool.length <= room) for (const cut of pool) chosen.add(cut);
  else
    for (let index = 0; index < room; index += 1)
      chosen.add(pool[Math.floor((index * pool.length) / room)]!);
  const rest = cap - chosen.size;
  if (rest > 0) {
    const stride = Math.max(1, Math.ceil(steps / rest));
    for (let cut = 0; cut < steps && chosen.size < cap; cut += stride) chosen.add(cut);
  }
  return { cuts: ascending(chosen), overCap: false };
}

/** A state's restore material, one per route, taken when the uninterrupted run is at that state. */
interface RestorePoint {
  /** The fork, or what its public call threw: a restore that threw, compared like any other route. */
  readonly fork:
    { readonly session: RuntimeSession; readonly log: DecisionLog } | { readonly thrown: string };
  readonly "checked-snapshot": RuntimeSnapshot;
  readonly "trusted-snapshot": RuntimeSnapshot;
  readonly "tagged-snapshot": TaggedRuntimeSnapshot;
  readonly checkpoint: RuntimeCheckpoint;
  readonly "checkpoint-json": string;
}

/** What a public restore call threw, as the restored route's own state, which disagrees with the uninterrupted run. */
function thrownRecord(thrown: string): SideRecord {
  return {
    state: { operation: "restore", host: null, result: { thrown }, decisions: [], snapshot: null },
    traces: { observer: [], instructionTrace: null, debug: null },
  };
}

/**
 * Runs `input` through two pipelines on one route and compares them completely: the compile results, then every state
 * of the uninterrupted run, then every restore route from every cut point to its end, each state against the other
 * side's same run and against its own side's uninterrupted run. Every call into a side passes through its `SideGuard`,
 * so a side's own exception at any stage ends the pair `not-compared` with that side's classified outcome.
 */
export function differentialRun(
  input: DifferentialInput,
  options: DifferentialOptions = {},
): DifferentialReport {
  const phase: { stage: Stage } = { stage: "compile" };
  const guards = {
    left: new SideGuard("left", phase, options),
    right: new SideGuard("right", phase, options),
  };
  const adapters = {
    left: guards.left.adapter(options.left ?? thisBuild("left")),
    right: guards.right.adapter(options.right ?? thisBuild("right")),
  };
  const route = options.route ?? "legacy";
  const correspondence = options.correspondence ?? IDENTITY;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const limit = options.limit ?? 10;
  const started = process.cpuUsage();
  const progress: { steps: number; cuts: readonly number[]; overCap: boolean; tailSteps: number } =
    { steps: 0, cuts: [], overCap: false, tailSteps: 0 };
  let outcomes: DifferentialReport["outcomes"] = { left: null, right: null };
  let planDigests: DifferentialReport["plans"] = { left: null, right: null };
  const report = (verdict: PairVerdict): DifferentialReport => {
    const used = process.cpuUsage(started);
    return {
      name: input.name,
      route,
      outcomes,
      verdict,
      plans: planDigests,
      steps: progress.steps,
      cuts: progress.cuts,
      cutsOverCap: progress.overCap,
      tailSteps: progress.tailSteps,
      cpuMs: Math.round((used.user + used.system) / 1000),
    };
  };
  /** Compares plain data; a difference or a mapping failure stops the pair. */
  const compareData = (oracle: unknown, candidate: unknown, at: ComparisonSite) => {
    let comparison;
    try {
      comparison = compareStructures(oracle, candidate, { correspondence, limit });
    } catch (error) {
      if (error instanceof MappingFailure)
        throw new Stop({ kind: "mapping-failure", at, error: error.message });
      throw error;
    }
    if (!comparison.equal)
      throw new Stop({ kind: "discrepancy", at, mismatches: comparison.mismatches });
  };
  /** Compares written records: by their texts when the correspondence is the identity, else by structure. */
  const compare = (oracle: Written, candidate: Written, at: ComparisonSite) => {
    if (
      correspondence.identity &&
      oracle.state === candidate.state &&
      oracle.traces === candidate.traces
    )
      return;
    compareData(oracle.record, candidate.record, at);
  };
  /**
   * A side's record, injected into when the options say so, and written. Writing is the harness's own work, not a call
   * into a side: a record it cannot write is that side's `serializer-failure`, and a throwing injection its
   * `harness-failure`, both at the write stage.
   */
  const written = (
    side: "left" | "right",
    record: () => SideRecord,
    at: Omit<InjectionSite, "side">,
  ): Written => {
    const made = record();
    let injected: SideRecord;
    try {
      injected = options.inject?.(made, { ...at, side }) ?? made;
    } catch (error) {
      throw notCompared(side, {
        kind: "harness-failure",
        stage: "write",
        method: "inject",
        error: errorText(error),
      });
    }
    try {
      return write(injected);
    } catch (error) {
      if (!(error instanceof SerializerFailure)) throw error;
      throw notCompared(side, {
        kind: "serializer-failure",
        stage: "write",
        method: null,
        error: error.message,
      });
    }
  };

  try {
    // Compile on both sides: equal rejections are equivalent, compared as diagnostics.
    const compiled = {
      left: adapters.left.compile(input, route),
      right: adapters.right.compile(input, route),
    };
    const compileSite: ComparisonSite = {
      tail: "compile",
      cut: null,
      state: 0,
      against: "other-side",
    };
    if (compiled.left.kind === "rejected" && compiled.right.kind === "rejected") {
      outcomes = {
        left: { kind: "compile-rejected", diagnostics: compiled.left.diagnostics },
        right: { kind: "compile-rejected", diagnostics: compiled.right.diagnostics },
      };
      compareData(compiled.left.diagnostics, compiled.right.diagnostics, compileSite);
      return report({ kind: "equivalent" });
    }
    for (const side of ["left", "right"] as const) {
      const item = compiled[side];
      if (item.kind === "unsupported")
        throw notCompared(side, { kind: "unsupported-route", reason: item.reason });
    }
    for (const side of ["left", "right"] as const) {
      const item = compiled[side];
      if (item.kind === "rejected")
        throw notCompared(side, { kind: "compile-rejected", diagnostics: item.diagnostics });
    }
    const { left, right } = compiled;
    if (left.kind !== "plan" || right.kind !== "plan")
      throw new Error("Both sides have a plan here.");
    compareData(left.diagnostics, right.diagnostics, compileSite);
    const plans = { left: left.plan, right: right.plan };
    planDigests = { left: canonicalDigest(left.plan), right: canonicalDigest(right.plan) };
    /** A fresh session: what its public call throws is the side's admission refusing the input. */
    const fresh = (side: "left" | "right", log: DecisionLog) => {
      try {
        return adapters[side].createFreshRuntimeSession(
          plans[side],
          input.fresh ?? {},
          log.options(),
        );
      } catch (error) {
        if (error instanceof SideFault) throw error;
        throw notCompared(side, { kind: "admission-rejected", error: errorText(error) });
      }
    };
    /** A new host for one side's run from the start: the caller's, or the driver's own. */
    const newHost = (side: "left" | "right"): HostSource => {
      const guard = guards[side];
      if (options.host === undefined) {
        const own = deadlineHost((view) => adapters[side].runtimeTimedWork(view));
        return (state, view) => guard.call("host.next", () => own(state, view));
      }
      const make = options.host;
      const driver = guard.call("host", () => make(side));
      return (_, view) =>
        guard.call("host.next", () => {
          const call = driver.next(view);
          return call === null ? null : detachedCall(call);
        });
    };

    // Where the cuts are, from the left side's uninterrupted run without records; a host call is a wait.
    phase.stage = "probe";
    {
      const probe = fresh("left", new DecisionLog(input.random));
      const host = newHost("left");
      const waits: number[] = [];
      const emitting: number[] = [];
      let steps = 0;
      let next = nextOperation(probe.view(), steps, host);
      while (next.kind !== "end" && steps < maxSteps) {
        const result =
          next.kind === "resume"
            ? probe.resumeRandomDraw({ drawId: next.drawId, outcome: "natural" })
            : next.kind === "execute"
              ? probe.executeInstruction()
              : applyHost(probe, next.call, null);
        steps += 1;
        if (result.events.length > 0) emitting.push(steps);
        next = nextOperation(probe.view(), steps, host);
        if (next.kind === "host") waits.push(steps);
      }
      const faulted = next.kind === "end" && next.outcome.kind === "structured-fault";
      const cutInfo = cutPoints(
        steps,
        waits,
        emitting,
        faulted,
        options.maxCuts ?? DEFAULT_MAX_CUTS,
      );
      progress.cuts = cutInfo.cuts;
      progress.overCap = cutInfo.overCap;
    }
    const cuts = new Set(progress.cuts);

    // The uninterrupted run, both sides in lockstep, keeping each side's state texts and its restore points.
    phase.stage = "setup";
    const logs = { left: new DecisionLog(input.random), right: new DecisionLog(input.random) };
    const start = (side: "left" | "right") =>
      new Side(adapters[side], fresh(side, logs[side]), logs[side], "start", newHost(side), 0);
    const sides = { left: start("left"), right: start("right") };
    const states: { readonly left: string[]; readonly right: string[] } = { left: [], right: [] };
    const points = {
      left: new Map<number, RestorePoint>(),
      right: new Map<number, RestorePoint>(),
    };
    const capture = (side: "left" | "right", state: number) => {
      const session = sides[side].session;
      const log = new DecisionLog(input.random);
      let fork: RestorePoint["fork"];
      try {
        fork = { session: session.fork(log.options()), log };
      } catch (error) {
        // The guard passes an engine call's own exception through; any other is the side's.
        if (error instanceof SideFault) throw error;
        fork = { thrown: errorText(error) };
      }
      const checkpoint = session.exportCheckpoint();
      points[side].set(state, {
        fork,
        "checked-snapshot": session.exportSnapshot(),
        "trusted-snapshot": session.exportTrustedSnapshot(),
        "tagged-snapshot": session.exportTaggedSnapshot(),
        checkpoint,
        "checkpoint-json": adapters[side].serializeCheckpoint(checkpoint),
      });
    };
    let ended: { readonly left: SideOutcome; readonly right: SideOutcome };
    {
      let state = 0;
      const at = () => ({ tail: "uninterrupted" as const, cut: null, state });
      phase.stage = "opening";
      let records = {
        left: written("left", () => sides.left.opening("start"), at()),
        right: written("right", () => sides.right.opening("start"), at()),
      };
      phase.stage = "step";
      for (;;) {
        compare(records.left, records.right, { ...at(), against: "other-side" });
        states.left.push(records.left.state);
        states.right.push(records.right.state);
        if (cuts.has(state)) {
          phase.stage = "capture";
          capture("left", state);
          capture("right", state);
          phase.stage = "step";
        }
        const leftNext = sides.left.next();
        const rightNext = sides.right.next();
        if (leftNext.kind === "end" || rightNext.kind === "end") {
          const unfinished = { kind: "censored", reason: "the other side ended first" } as const;
          ended = {
            left: leftNext.kind === "end" ? leftNext.outcome : unfinished,
            right: rightNext.kind === "end" ? rightNext.outcome : unfinished,
          };
          break;
        }
        // A run that would take a step past the limit is censored before it takes it; one that ends at the limit is not.
        if (state >= maxSteps) {
          const censored = { kind: "censored", reason: `${maxSteps} steps` } as const;
          outcomes = { left: censored, right: censored };
          throw new Stop({ kind: "not-compared", side: "left", because: "censored" });
        }
        state += 1;
        progress.steps = state;
        records = {
          left: written("left", () => sides.left.apply(leftNext), at()),
          right: written("right", () => sides.right.apply(rightNext), at()),
        };
      }
    }
    outcomes = ended;
    compareData(ended.left, ended.right, {
      tail: "uninterrupted",
      cut: null,
      state: progress.steps,
      against: "other-side",
    });

    // Every restore route from every cut, both sides in lockstep, to the end.
    phase.stage = "restore";
    for (const cut of progress.cuts)
      for (const tail of RESTORE_TAILS) {
        const restore = (side: "left" | "right"): Side | SideRecord => {
          const point = points[side].get(cut)!;
          const api = adapters[side];
          const log = new DecisionLog(input.random);
          let session: RuntimeSession;
          let runLog = log;
          // Only the public restore call itself: what it throws is engine behaviour, compared below.
          try {
            if (tail === "fork") {
              if ("thrown" in point.fork) return thrownRecord(point.fork.thrown);
              session = point.fork.session;
              runLog = point.fork.log;
            } else if (tail === "checked-snapshot" || tail === "trusted-snapshot")
              session = api.createRuntimeSession(plans[side], point[tail], log.options());
            else if (tail === "tagged-snapshot")
              session = api.createTaggedRuntimeSession(plans[side], point[tail], log.options());
            else if (tail === "checkpoint")
              session = api.restoreRuntimeSession(point[tail], log.options());
            else session = api.deserializeRuntimeSession(point[tail], log.options());
          } catch (error) {
            if (error instanceof SideFault) throw error;
            return thrownRecord(errorText(error));
          }
          // The side's uninterrupted host calls, replayed by state index.
          const calls = sides[side].calls;
          return new Side(
            api,
            session,
            runLog,
            "restore",
            (state) => {
              const recorded = calls.get(state);
              return recorded === undefined ? null : replayed(recorded);
            },
            cut,
          );
        };
        const runs = { left: restore("left"), right: restore("right") };
        let state = cut;
        const at = () => ({ tail, cut, state });
        const opening = (side: "left" | "right") => () => {
          const run = runs[side];
          return run instanceof Side ? run.opening("restore") : run;
        };
        let records = {
          left: written("left", opening("left"), at()),
          right: written("right", opening("right"), at()),
        };
        for (;;) {
          compare(records.left, records.right, { ...at(), against: "other-side" });
          for (const side of ["left", "right"] as const) {
            const expected = states[side][state]!;
            if (state !== cut && records[side].state === expected) continue;
            // EVIDENCE: validation: `states` holds `canonicalText` of a record's state, which `JSON.parse` reads back.
            const reference = JSON.parse(expected) as SideRecord["state"];
            // A restored state has no operation that led to it, which its uninterrupted counterpart has.
            const counterpart =
              state === cut
                ? { ...reference, operation: "restore", host: null, result: null, decisions: [] }
                : reference;
            // Within one side the identity holds: both records are the same build's.
            const within = compareStructures(
              { state: counterpart },
              { state: records[side].record.state },
              { limit },
            );
            if (!within.equal)
              throw new Stop({
                kind: "discrepancy",
                at: { ...at(), against: "uninterrupted" },
                mismatches: within.mismatches,
              });
          }
          const leftRun = runs.left;
          const rightRun = runs.right;
          if (!(leftRun instanceof Side) || !(rightRun instanceof Side)) break;
          const leftNext = leftRun.next();
          const rightNext = rightRun.next();
          const leftEnd = leftNext.kind === "end" ? leftNext.outcome : null;
          const rightEnd = rightNext.kind === "end" ? rightNext.outcome : null;
          // Each side's restored run ends as, and where, its uninterrupted run ended.
          const ends = compareStructures(
            state === progress.steps
              ? { left: ended.left, right: ended.right }
              : { left: null, right: null },
            { left: leftEnd, right: rightEnd },
            { limit },
          );
          if (!ends.equal)
            throw new Stop({
              kind: "discrepancy",
              at: { ...at(), against: "uninterrupted" },
              mismatches: ends.mismatches,
            });
          if (leftNext.kind === "end" || rightNext.kind === "end") break;
          state += 1;
          progress.tailSteps += 1;
          records = {
            left: written("left", () => leftRun.apply(leftNext), at()),
            right: written("right", () => rightRun.apply(rightNext), at()),
          };
        }
      }
    return report({ kind: "equivalent" });
  } catch (error) {
    if (error instanceof SideFault) {
      const outcome: SideOutcome =
        error.fault instanceof SerializerFailure
          ? {
              kind: "serializer-failure",
              stage: error.stage,
              method: error.method,
              error: error.fault.message,
            }
          : {
              kind: "harness-failure",
              stage: error.stage,
              method: error.method,
              error: errorText(error.fault),
            };
      outcomes = { ...outcomes, [error.side]: outcome };
      return report({ kind: "not-compared", side: error.side, because: outcome.kind });
    }
    if (!(error instanceof Stop)) throw error;
    if (error.outcome !== null)
      outcomes = { ...outcomes, [error.outcome.side]: error.outcome.outcome };
    return report(error.verdict);
  }
}
