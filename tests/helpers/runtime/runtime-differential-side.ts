import type {
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
  ActionCompletionOptions,
  CompileOptions,
  FreshRuntimeOptions,
  InstructionPlan,
  ProjectSourceFile,
  RandomControlOptions,
  RandomDecision,
  RuntimeCheckpoint,
  RuntimeSession,
  RuntimeSessionOptions,
  RuntimeSessionResult,
  RuntimeSessionView,
  RuntimeSnapshot,
  TaggedRuntimeSnapshot,
} from "../../../src/index.js";
import type { compileProjectWithBackend, compileSourceWithBackend } from "../../../src/compiler.js";
import type { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import {
  canonicalDigest,
  canonicalText,
  SerializerFailure,
  type Correspondence,
  type StructureMismatch,
} from "../runtime-state-comparison.js";

/*
 * One side of the differential driver (docs/TESTING.md "Differential harness"): its types, its attribution of
 * exceptions, its runs and restore points, and the port the lockstep driver (`runtime-differential.ts`) steps it
 * through. It imports no engine, only the engine's types, so that a root's runner can load it before 0a's guard and
 * then drive the root's own build through `buildAdapter`.
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
   * natural result; `choose-natural` answers each draw with a `choose` decision of its natural outcome, an input with a
   * receipt, and a draw whose natural result is a failure with the natural decision. It covers the receipts and the
   * control path, never another outcome: `tests/runtime/controlled-random-explorer.test.ts` chooses those. Absent leaves every
   * draw natural, without control.
   */
  readonly random?: "natural" | "choose-natural";
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
      readonly member: string;
      readonly error: string;
    }
  | {
      readonly kind: "harness-failure";
      readonly stage: Stage;
      readonly member: string;
      readonly error: string;
    }
  | { readonly kind: "censored"; readonly reason: string };

/**
 * The driver's stage, which a side's classified failure names with the member: compilation, the left side's run that
 * places the cut points, the setup of the uninterrupted run, its opening records, its steps, the capture of restore
 * points, and the restore routes.
 */
export type Stage = "compile" | "probe" | "setup" | "opening" | "step" | "capture" | "restore";

/** Each restore route, independent: never one rebuilt from another. */
export const RESTORE_TAILS = [
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
  /**
   * The most mismatches a discrepancy reports: a positive safe integer, 10 by default. Any other value throws a
   * `RangeError` before either side's run starts (`mismatchLimit`).
   */
  readonly limit?: number;
  /**
   * The host, one per run, made by this factory for each side's uninterrupted run (and the cut probe's, as `left`). The driver
   * asks it whenever its side is neither runnable nor paused at a random draw; `null` ends the run as waiting. Without
   * it, the driver observes the next delay deadline. Restore routes replay their side's uninterrupted host calls at the
   * same state index, so every run of a side, and both sides, observe time at the same points; a captured-media
   * admission is replayed from the questions and answers its uninterrupted call recorded.
   */
  readonly host?: (side: "left" | "right") => HostDriver;
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

/** One question a captured-media admission answered: as `player/debug/debug-export.ts` records its admission queries. */
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

/** A side of a pair. */
export type SideName = "left" | "right";

/**
 * Any callable of a side, whatever it returns: the driver passes its result on to the caller's own typed use.
 */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- EVIDENCE: the generic bound of a side's callables, whose results each call site types through `ReturnType`.
type SideCallable = (...args: never[]) => unknown;

/**
 * The one application of a side's callable, which `invoke` and `callback` share: with its own receiver and arguments,
 * reading no member of the callable.
 */
function applied<F extends SideCallable>(
  callable: F,
  receiver: unknown,
  args: Parameters<F>,
): ReturnType<F> {
  // oxlint-disable-next-line anti-slop/no-reflect-apply -- EVIDENCE: the one owner of calls into a side applies the callable with its own receiver and reads no member of it, which a typed `callable.call(...)` would.
  return Reflect.apply(callable, receiver, args);
}

/** A failure of one of the harness's own callbacks, latched before it rethrows so that an engine cannot erase it. */
export interface Latched {
  readonly side: SideName;
  readonly stage: Stage;
  readonly member: string;
  /** In an envelope, so that `throw null` still counts. */
  readonly error: unknown;
}

/** The latched callback failure, raised after the engine invocation it happened in, however that invocation ended. */
export class CallbackFailure extends Error {
  public constructor(readonly failure: Latched) {
    super(`${failure.side} ${failure.stage} ${failure.member}`);
  }
}

/**
 * How the driver attributes exceptions: a cursor of plain fields naming the side, the stage and the member the driver
 * is operating on, set before each operation on a side's object (acquiring a member, invoking it, reading what it
 * returned, writing a record), and a latch for the harness's own callbacks. The driver's one outer catch classifies by
 * them. The cursor names the active operation, not a verified origin (#1923). It wraps nothing, so what the engine
 * receives is the side's own value.
 */
export class Attribution {
  public readonly cursor: { side: SideName; stage: Stage; member: string } = {
    side: "left",
    stage: "compile",
    member: "options",
  };
  #latched: Latched | null = null;

  /** Runs one operation on `side`'s object, with the cursor at `member`; a latched callback failure wins. */
  public op<T>(side: SideName, member: string, run: () => T): T {
    this.cursor.side = side;
    this.cursor.member = member;
    let result: T;
    try {
      result = run();
    } catch (error) {
      this.raiseLatched();
      throw error;
    }
    this.raiseLatched();
    return result;
  }

  /** Runs one of the harness's own callbacks, which the engine calls: its first failure is latched, then rethrown. */
  public latched<T>(side: SideName, member: string, run: () => T): T {
    try {
      return run();
    } catch (error) {
      this.#latched ??= { side, stage: this.cursor.stage, member, error };
      throw error;
    }
  }

  /**
   * The one way the driver invokes a side's callable: `Reflect.apply` with its own receiver and arguments already made,
   * reading no member of the callable, as one operation at `member`.
   */
  public invoke<F extends SideCallable>(
    side: SideName,
    member: string,
    receiver: unknown,
    callable: F,
    args: Parameters<F>,
  ): ReturnType<F> {
    return this.op(side, member, () => applied(callable, receiver, args));
  }

  /** Acquires `receiver[key]` as one operation, then invokes it with `receiver` through `invoke`. */
  public call<R extends object, K extends keyof R>(
    side: SideName,
    member: string,
    receiver: R,
    key: K,
    args: Parameters<Extract<R[K], SideCallable>>,
  ): ReturnType<Extract<R[K], SideCallable>> {
    // EVIDENCE: validation: the driver calls only the side's callable members; a non-callable one throws in `invoke`.
    const callable = this.op(side, member, () => receiver[key]) as Extract<R[K], SideCallable>;
    return this.invoke(side, member, receiver, callable, args);
  }

  /** Constructs a side's class with `args` as one operation at `member`. */
  public construct<C extends new (...args: never[]) => object>(
    side: SideName,
    member: string,
    Class: C,
    args: ConstructorParameters<C>,
  ): InstanceType<C> {
    return this.op(side, member, () => {
      // EVIDENCE: validation: `Reflect.construct` of `Class` makes an instance of `Class`.
      const instance = Reflect.construct(Class, args) as InstanceType<C>;
      return instance;
    });
  }

  /**
   * Inside one of the harness's callbacks: calls the side's `receiver[key]` the way `invoke` does, its failure latched
   * by the callback, without moving the cursor of the engine invocation it runs within.
   */
  public callback<R extends object, K extends keyof R>(
    side: SideName,
    member: string,
    receiver: R,
    key: K,
    args: Parameters<Extract<R[K], SideCallable>>,
  ): ReturnType<Extract<R[K], SideCallable>> {
    return this.latched(side, member, () => {
      // EVIDENCE: validation: as in `call`; a non-callable member throws in `Reflect.apply`.
      const callable = receiver[key] as Extract<R[K], SideCallable>;
      return applied(callable, receiver, args);
    });
  }

  /** The latched callback failure, if any, which takes priority over every verdict. */
  public pending(): Latched | null {
    return this.#latched;
  }

  private raiseLatched(): void {
    if (this.#latched !== null) throw new CallbackFailure(this.#latched);
  }
}

/**
 * What an operation's result is to the harness, read at once, inside the operation that returned it: its record (only
 * the fields the result has, so that the record reads back from its text unchanged), whether it emitted events, and its
 * instruction trace.
 */
interface ResultData {
  readonly record: unknown;
  readonly emitted: boolean;
  readonly instructionTrace: unknown;
}

function resultData(result: RuntimeSessionResult & { readonly outcome?: unknown }): ResultData {
  return {
    record: {
      events: result.events,
      instructionsExecuted: result.instructionsExecuted,
      ...(result.randomChoices === undefined ? {} : { randomChoices: result.randomChoices }),
      ...(result.randomRefusal === undefined ? {} : { randomRefusal: result.randomRefusal }),
      ...("outcome" in result ? { outcome: result.outcome } : {}),
    },
    emitted: result.events.length > 0,
    instructionTrace: result.instructionTrace ?? null,
  };
}

/** Applies `call`, already detached, with its captured-media admission's questions and answers recorded. */
function recordedHost(
  attribution: Attribution,
  side: SideName,
  session: RuntimeSession,
  call: HostCall,
  debugTrace: RuntimeDebugContext | null,
): { readonly result: ResultData; readonly record: HostCallRecord } {
  if (call.kind !== "completeAction")
    return { result: applyHost(attribution, side, session, call, debugTrace), record: call };
  const { capturedMedia, ...rest } = call;
  if (capturedMedia === undefined)
    return {
      result: applyHost(attribution, side, session, rest, debugTrace),
      record: { ...rest, capturedMedia: null },
    };
  const queries: AdmissionQuery[] = [];
  const recording: CapturedMedia = {
    holds: (reference, kind) =>
      attribution.latched(side, "capturedMedia.holds", () => {
        const result = attribution.callback(side, "capturedMedia.holds", capturedMedia, "holds", [
          reference,
          kind,
        ]);
        queries.push({ reference, kind, result });
        return result;
      }),
  };
  const result = applyHost(
    attribution,
    side,
    session,
    { ...rest, capturedMedia: recording },
    debugTrace,
  );
  return { result, record: { ...rest, capturedMedia: queries } };
}

/**
 * The host call a restore route replays from its record, independent of any host object's state: its captured-media
 * admission answers the recorded questions in order, and `false` to any other. A different or a missing question then
 * shows in the replay's own record, a discrepancy at `state.host`.
 */
function replayed(attribution: Attribution, side: SideName, record: HostCallRecord): HostCall {
  if (record.kind !== "completeAction") return record;
  const { capturedMedia: queries, ...rest } = record;
  if (queries === null) return rest;
  let next = 0;
  return {
    ...rest,
    capturedMedia: {
      holds: (reference, kind) =>
        attribution.latched(side, "capturedMedia.replay", () => {
          const expected = queries[next];
          next += 1;
          return expected !== undefined &&
            expected.reference === reference &&
            expected.kind === kind
            ? expected.result
            : false;
        }),
    },
  };
}

/** Applies `call` to `session`, with `debugTrace`, as one operation on the side. */
function applyHost(
  attribution: Attribution,
  side: SideName,
  session: RuntimeSession,
  call: HostCall,
  debugTrace: RuntimeDebugContext | null,
): ResultData {
  const trace = debugTrace === null ? {} : { debugTrace };
  const member = `RuntimeSession.${call.kind}`;
  // The call and the reading of its result are one operation.
  const op = (run: () => RuntimeSessionResult & { readonly outcome?: unknown }) =>
    attribution.op(side, member, () => resultData(run()));
  switch (call.kind) {
    case "observeTime":
      return op(() =>
        attribution.call(side, member, session, "observeTime", [
          call.nowMs,
          call.reports ?? [],
          trace,
        ]),
      );
    case "completeAction":
      return op(() =>
        attribution.call(side, member, session, "completeAction", [
          call.request,
          {
            ...trace,
            ...(call.capturedMedia === undefined ? {} : { capturedMedia: call.capturedMedia }),
          },
        ]),
      );
    case "reportMediaLoad":
      return op(() =>
        attribution.call(side, member, session, "reportMediaLoad", [
          call.mediaId,
          call.report,
          trace,
        ]),
      );
    case "updateInteraction":
      return op(() =>
        attribution.call(side, member, session, "updateInteraction", [call.request, trace]),
      );
    case "pressPermanentButton":
      return op(() =>
        attribution.call(side, member, session, "pressPermanentButton", [call.buttonId, trace]),
      );
    case "recordContinueCapture":
      return op(() =>
        attribution.call(side, member, session, "recordContinueCapture", [call.capture, trace]),
      );
    case "applyExternalStorageEdit":
      return op(() =>
        attribution.call(side, member, session, "applyExternalStorageEdit", [call.edit, trace]),
      );
    case "setDebugMode":
      return op(() =>
        attribution.call(side, member, session, "setDebugMode", [call.enabled, trace]),
      );
  }
}

/** How a side's run gets its host calls: by the state index it is at, and its view. */
type HostSource = (state: number, view: RuntimeSessionView) => HostCall | null;

/** The driver's own host: it observes the next delay deadline, and settles nothing else. */
function deadlineHost(
  timedWork: (view: RuntimeSessionView) => ReturnType<typeof runtimeTimedWork>,
): HostSource {
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

export const DEFAULT_MAX_CUTS = 32;
export const DEFAULT_MAX_STEPS = 5_000;

/** An exception's text, or a fixed text when the thrown value cannot be read. */
function errorText(error: unknown): string {
  try {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch {
    return "an exception whose text cannot be read";
  }
}

/** The harness's decision callback, which logs each draw it is asked about. */
class DecisionLog {
  public calls: unknown[] = [];
  public constructor(
    private readonly mode: DifferentialInput["random"],
    private readonly side: SideName,
    private readonly attribution: Attribution,
  ) {}

  public options(): RuntimeSessionOptions {
    const mode = this.mode;
    if (mode === undefined) return {};
    const randomControl: RandomControlOptions = {
      decide: (draw): RandomDecision =>
        this.attribution.latched(this.side, "decision.decide", () => {
          this.calls.push({
            drawId: draw.drawId,
            site: draw.site,
            kind: draw.kind,
            natural: draw.natural,
          });
          if (mode === "natural" || draw.natural.kind === "failure") return { kind: "natural" };
          return { kind: "choose", outcome: draw.natural };
        }),
    };
    return { randomControl };
  }
}

type Operation =
  | { readonly kind: "resume"; readonly drawId: number }
  | { readonly kind: "execute" }
  | { readonly kind: "host"; readonly call: HostCall }
  | { readonly kind: "end"; readonly outcome: SideOutcome };

/** The fields of a side's view that decide its next operation, read at once into plain data. */
interface ViewFacts {
  readonly status: RuntimeSessionView["status"];
  readonly failure: { readonly code: string; readonly path: string; readonly span: unknown } | null;
  readonly nextInstruction: number;
  readonly randomDrawId: number | null;
  readonly runnable: boolean;
}

function viewFacts(view: RuntimeSessionView): ViewFacts {
  const failure = view.failure;
  const draw = view.randomDraw;
  return {
    status: view.status,
    failure:
      failure === null ? null : { code: failure.code, path: failure.path, span: failure.span },
    nextInstruction: view.nextInstruction,
    randomDrawId: draw === null ? null : draw.drawId,
    runnable: view.runnable,
  };
}

/**
 * What a side does next at `state`, from its view's `facts`: resume a paused draw, execute, make its host's call (which
 * receives the side's own `view`), or end.
 */
function nextOperation(
  facts: ViewFacts,
  view: RuntimeSessionView,
  state: number,
  host: HostSource,
): Operation {
  if (facts.status === "halted") return { kind: "end", outcome: { kind: "completed" } };
  if (facts.status === "failed") {
    const failure = facts.failure!;
    return {
      kind: "end",
      outcome: {
        kind: "structured-fault",
        code: failure.code,
        path: failure.path,
        span: failure.span,
        pc: facts.nextInstruction,
      },
    };
  }
  if (facts.randomDrawId !== null) return { kind: "resume", drawId: facts.randomDrawId };
  if (facts.runnable) return { kind: "execute" };
  const call = host(state, view);
  return call === null ? { kind: "end", outcome: { kind: "waiting" } } : { kind: "host", call };
}

/** One side's session, stepped one instruction or settlement at a time, with its own debug context and logs. */
class Side {
  private readonly debug: RuntimeDebugContext;
  private nextRecord: number;
  /** The host calls this run made, as their records, by the state index each was made at. */
  public readonly calls = new Map<number, HostCallRecord>();

  public constructor(
    private readonly attribution: Attribution,
    private readonly name: SideName,
    adapter: PipelineAdapter,
    public readonly session: RuntimeSession,
    private readonly decisions: DecisionLog,
    origin: "start" | "restore",
    private readonly host: HostSource,
    /** The state index the run is at. */
    private state: number,
  ) {
    const at = attribution;
    const sessions = this.op("sessions", () => adapter.sessions);
    const Context = this.op("RuntimeDebugContext", () => sessions.RuntimeDebugContext);
    this.debug = at.construct(name, "RuntimeDebugContext", Context, []);
    at.call(name, "RuntimeDebugContext.reset", this.debug, "reset", [origin]);
    this.nextRecord = this.op(
      "RuntimeDebugContext.status",
      () => at.call(name, "RuntimeDebugContext.status", this.debug, "status", []).nextRecord,
    );
  }

  private op<T>(member: string, run: () => T): T {
    return this.attribution.op(this.name, member, run);
  }

  /** The record of the state the side starts the run at. */
  public opening(operation: "start" | "restore"): SideRecord {
    return this.record(operation, null, null, []);
  }

  /** What the side does next, decided without doing it. */
  public next(): Operation {
    // The view's fields that decide the next operation are read inside the view's own operation.
    const { view, facts } = this.op("RuntimeSession.view", () => {
      const view = this.attribution.call(
        this.name,
        "RuntimeSession.view",
        this.session,
        "view",
        [],
      );
      return { view, facts: viewFacts(view) };
    });
    return nextOperation(facts, view, this.state, this.host);
  }

  /** Does `next`, an operation `next()` decided. */
  public apply(next: Exclude<Operation, { readonly kind: "end" }>): SideRecord {
    const observer: unknown[] = [];
    const latched = (member: string, entry: () => object) =>
      this.attribution.latched(this.name, member, () => {
        observer.push(entry());
      });
    // A passive observer: it never returns `true`, so it never ends an operation.
    const traced = {
      debugTrace: this.debug,
      instructionTrace: true,
      instructionObserver: {
        before: (instruction: number, call: number) => {
          latched("observer.before", () => ({ hook: "before", instruction, call }));
        },
        after: (instruction: number, next: number, call: number) => {
          latched("observer.after", () => ({
            hook: "after",
            instruction,
            nextInstruction: next,
            call,
          }));
        },
        dispatch: (block: number, call: number) => {
          latched("observer.dispatch", () => ({ hook: "dispatch", block, call }));
        },
      },
    };
    this.decisions.calls = [];
    let result: ResultData;
    let operation: string;
    let call: HostCallRecord | null = null;
    if (next.kind === "resume") {
      operation = `resume ${next.drawId}`;
      result = this.op("RuntimeSession.resumeRandomDraw", () =>
        resultData(
          this.attribution.call(
            this.name,
            "RuntimeSession.resumeRandomDraw",
            this.session,
            "resumeRandomDraw",
            [{ drawId: next.drawId, outcome: "natural" }, traced],
          ),
        ),
      );
    } else if (next.kind === "execute") {
      operation = "execute";
      result = this.op("RuntimeSession.executeInstruction", () =>
        resultData(
          this.attribution.call(
            this.name,
            "RuntimeSession.executeInstruction",
            this.session,
            "executeInstruction",
            [traced],
          ),
        ),
      );
    } else {
      // A host operation takes the debug trace only, as the public contract gives it.
      operation = `host ${next.call.kind}`;
      ({ result, record: call } = recordedHost(
        this.attribution,
        this.name,
        this.session,
        next.call,
        this.debug,
      ));
      this.calls.set(this.state, call);
    }
    this.state += 1;
    return this.record(operation, call, result, observer);
  }

  private record(
    operation: string,
    host: unknown,
    result: ResultData | null,
    observer: readonly unknown[],
  ): SideRecord {
    const at = this.attribution;
    const status = at.call(this.name, "RuntimeDebugContext.status", this.debug, "status", []);
    const records: unknown[] = [];
    for (let id = this.nextRecord; id < status.nextRecord; id += 1)
      records.push(at.call(this.name, "RuntimeDebugContext.record", this.debug, "record", [id]));
    this.nextRecord = status.nextRecord;
    const snapshot = at.call(
      this.name,
      "RuntimeSession.exportTrustedSnapshot",
      this.session,
      "exportTrustedSnapshot",
      [],
    );
    return {
      state: {
        operation,
        host,
        result: result === null ? null : result.record,
        decisions: this.decisions.calls,
        snapshot,
      },
      traces: {
        observer,
        instructionTrace: result === null ? null : result.instructionTrace,
        debug: { status, records },
      },
    };
  }
}

/** A record and its two parts as `canonicalText`. */
export interface Written {
  readonly record: SideRecord;
  readonly state: string;
  readonly traces: string;
}

/** Ends the pair early: with a verdict, and for a side outcome that leaves it not compared, that outcome. */
export class Stop extends Error {
  public constructor(
    readonly verdict: PairVerdict,
    readonly outcome: { readonly side: SideName; readonly outcome: SideOutcome } | null = null,
  ) {
    super(verdict.kind);
  }
}

export function notCompared(side: SideName, outcome: SideOutcome): Stop {
  return new Stop({ kind: "not-compared", side, because: outcome.kind }, { side, outcome });
}

/** Writes a record's two parts as `canonicalText`. */
export function write(record: SideRecord): Written {
  return { record, state: canonicalText(record.state), traces: canonicalText(record.traces) };
}

/**
 * The cut points of a run of `steps` steps; cut `c` restores the state after step `c`. First the mandatory cuts: the
 * fresh state, the state before a fault, the first and last waits, and the states before the first and last
 * event-emitting steps. Then, up to `cap` in all, the other waits and event steps at evenly spaced positions, then
 * every k-th state. All by index, without randomness.
 */
export function cutPoints(
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

/** A side's failure as its outcome: `serializer-failure` for the harness's writing, else `harness-failure`. */
export function classifiedFailure(at: Latched): SideOutcome {
  return at.error instanceof SerializerFailure
    ? { kind: "serializer-failure", stage: at.stage, member: at.member, error: errorText(at.error) }
    : { kind: "harness-failure", stage: at.stage, member: at.member, error: errorText(at.error) };
}

/** What a public restore call threw, as the restored route's own state, which disagrees with the uninterrupted run. */
function thrownRecord(thrown: string): SideRecord {
  return {
    state: { operation: "restore", host: null, result: { thrown }, decisions: [], snapshot: null },
    traces: { observer: [], instructionTrace: null, debug: null },
  };
}

/*
 * The side port: one side's half of a pair, as the lockstep driver steps it. In-process, `LocalPort` is the driver's
 * own per-side code behind this interface; across processes, `RemotePort` (`runtime-differential-remote.ts`) calls the
 * same `LocalPort` inside a root's runner. One control flow, the driver's, decides in both cases.
 */

/** What compiling gave, as the driver compares it; the plan stays inside the port. */
export type CompiledFacts =
  | { readonly kind: "plan"; readonly diagnostics: unknown }
  | { readonly kind: "rejected"; readonly diagnostics: unknown }
  | { readonly kind: "unsupported"; readonly reason: string };

/** The left side's run that places the cut points, as facts. */
export interface ProbeFacts {
  readonly steps: number;
  readonly waits: readonly number[];
  readonly emitting: readonly number[];
  readonly faulted: boolean;
}

/** A record a port gave: the record, and its texts when the port wrote them (across processes). */
export interface PortRecord {
  readonly record: SideRecord;
  readonly texts?: { readonly state: string; readonly traces: string };
}

/** What a run does next, decided without doing it: end with an outcome, or go on. */
export type NextFacts =
  { readonly kind: "end"; readonly outcome: SideOutcome } | { readonly kind: "go" };

/** A side's failure the port reports as classified data, across processes. */
export interface ClassifiedSideFailure {
  readonly side: SideName;
  readonly outcome: SideOutcome;
}

/** One side's half of a pair. Run 0 is the uninterrupted run; `restore` makes the others. */
export interface SidePort {
  compile(): CompiledFacts;
  planDigest(): string;
  probe(): ProbeFacts;
  start(): void;
  opening(run: number): PortRecord;
  next(run: number): NextFacts;
  apply(run: number): PortRecord;
  capture(state: number): void;
  /** A restored run; `live` is false when its public restore call threw, its opening the thrown record. */
  restore(tail: RestoreTail, cut: number): { readonly run: number; readonly live: boolean };
  /** A latched callback failure that has not yet reached a verdict, as the side's outcome. */
  pending(): ClassifiedSideFailure | null;
}

/** A side's classified failure that a port reported (across processes): the pair ends `not-compared` with it. */
export class PortFailure extends Error {
  public constructor(readonly failure: ClassifiedSideFailure) {
    super(`${failure.side} ${failure.outcome.kind}`);
  }
}

/** What a port needs from the pair: the input, the route, and the options that shape one side's run. */
export interface PortContext {
  readonly input: DifferentialInput;
  readonly route: Route;
  readonly maxSteps: number;
  readonly maxCuts: number;
  readonly host: DifferentialOptions["host"];
}

/** The driver's own per-side code: one side's sessions, runs, restore points and host, in this process. */
export class LocalPort implements SidePort {
  #plan: InstructionPlan | null = null;
  #start: Side | null = null;
  readonly #points = new Map<number, RestorePoint>();
  readonly #runs = new Map<number, Side | SideRecord>();
  readonly #pending = new Map<number, Exclude<Operation, { readonly kind: "end" }>>();

  public constructor(
    private readonly attribution: Attribution,
    private readonly side: SideName,
    private readonly adapter: PipelineAdapter,
    private readonly context: PortContext,
  ) {}

  private op<T>(member: string, run: () => T): T {
    return this.attribution.op(this.side, member, run);
  }

  private log(): DecisionLog {
    return new DecisionLog(this.context.input.random, this.side, this.attribution);
  }

  private plan(): InstructionPlan {
    if (this.#plan === null) throw new Error("The port has no plan before compiling.");
    return this.#plan;
  }

  public compile(): CompiledFacts {
    const compiled = this.attribution.call(this.side, "compile", this.adapter, "compile", [
      this.context.input,
      this.context.route,
    ]);
    if (compiled.kind === "plan") {
      this.#plan = compiled.plan;
      return { kind: "plan", diagnostics: compiled.diagnostics };
    }
    return compiled;
  }

  public planDigest(): string {
    const plan = this.plan();
    return this.op("plan", () => canonicalDigest(plan));
  }

  /** A fresh session: what its public call throws is the side's admission refusing the input. */
  private fresh(decisions: DecisionLog): RuntimeSession {
    const side = this.side;
    const sessions = this.op("sessions", () => this.adapter.sessions);
    const create = this.op("createFreshRuntimeSession", () => sessions.createFreshRuntimeSession);
    const plan = this.plan();
    const freshOptions = this.context.input.fresh ?? {};
    const sessionOptions = decisions.options();
    return engine(
      () =>
        this.attribution.invoke(side, "createFreshRuntimeSession", sessions, create, [
          plan,
          freshOptions,
          sessionOptions,
        ]),
      (error) => {
        throw notCompared(side, { kind: "admission-rejected", error: errorText(error) });
      },
    );
  }

  /** A new host for one side's run from the start: the caller's, or the driver's own. */
  private newHost(): HostSource {
    const side = this.side;
    const attribution = this.attribution;
    const make = this.context.host;
    if (make === undefined) {
      const own = deadlineHost((view) => {
        const sessions = this.op("sessions", () => this.adapter.sessions);
        return attribution.call(side, "runtimeTimedWork", sessions, "runtimeTimedWork", [view]);
      });
      return (state, view) => own(state, view);
    }
    const driver = attribution.invoke(side, "host", undefined, make, [side]);
    return (_, view) =>
      this.op("host.next", () => {
        const call = attribution.call(side, "host.next", driver, "next", [view]);
        return call === null ? null : detachedCall(call);
      });
  }

  public probe(): ProbeFacts {
    const attribution = this.attribution;
    const side = this.side;
    const probe = this.fresh(this.log());
    const host = this.newHost();
    const waits: number[] = [];
    const emitting: number[] = [];
    let steps = 0;
    const next0 = () =>
      this.op("RuntimeSession.view", () => {
        const view = attribution.call(side, "RuntimeSession.view", probe, "view", []);
        return { view, facts: viewFacts(view) };
      });
    const decide = () => {
      const { view, facts } = next0();
      return nextOperation(facts, view, steps, host);
    };
    let next = decide();
    while (next.kind !== "end" && steps < this.context.maxSteps) {
      const operation = next;
      const emitted =
        operation.kind === "resume"
          ? this.op(
              "RuntimeSession.resumeRandomDraw",
              () =>
                attribution.call(
                  side,
                  "RuntimeSession.resumeRandomDraw",
                  probe,
                  "resumeRandomDraw",
                  [{ drawId: operation.drawId, outcome: "natural" }],
                ).events.length > 0,
            )
          : operation.kind === "execute"
            ? this.op(
                "RuntimeSession.executeInstruction",
                () =>
                  attribution.call(
                    side,
                    "RuntimeSession.executeInstruction",
                    probe,
                    "executeInstruction",
                    [],
                  ).events.length > 0,
              )
            : applyHost(attribution, side, probe, operation.call, null).emitted;
      steps += 1;
      if (emitted) emitting.push(steps);
      next = decide();
      if (next.kind === "host") waits.push(steps);
    }
    return {
      steps,
      waits,
      emitting,
      faulted: next.kind === "end" && next.outcome.kind === "structured-fault",
    };
  }

  public start(): void {
    const decisions = this.log();
    const session = this.fresh(decisions);
    const host = this.newHost();
    const run = new Side(
      this.attribution,
      this.side,
      this.adapter,
      session,
      decisions,
      "start",
      host,
      0,
    );
    this.#start = run;
    this.#runs.set(0, run);
  }

  private run(id: number): Side | SideRecord {
    const run = this.#runs.get(id);
    if (run === undefined) throw new Error(`The port has no run ${id}.`);
    return run;
  }

  public opening(id: number): PortRecord {
    const run = this.run(id);
    return { record: run instanceof Side ? run.opening(id === 0 ? "start" : "restore") : run };
  }

  public next(id: number): NextFacts {
    const run = this.run(id);
    if (!(run instanceof Side)) throw new Error(`The run ${id} restored no session.`);
    const next = run.next();
    if (next.kind === "end") return next;
    this.#pending.set(id, next);
    return { kind: "go" };
  }

  public apply(id: number): PortRecord {
    const run = this.run(id);
    const next = this.#pending.get(id);
    if (!(run instanceof Side) || next === undefined)
      throw new Error(`The run ${id} has no operation to apply.`);
    this.#pending.delete(id);
    return { record: run.apply(next) };
  }

  public capture(state: number): void {
    const attribution = this.attribution;
    const side = this.side;
    const session = this.#start!.session;
    const forkLog = this.log();
    const fork = this.op("RuntimeSession.fork", () => session.fork);
    const forkOptions = forkLog.options();
    const forked = engine<RestorePoint["fork"]>(
      () => ({
        session: attribution.invoke(side, "RuntimeSession.fork", session, fork, [forkOptions]),
        log: forkLog,
      }),
      (error) => ({ thrown: errorText(error) }),
    );
    const sessions = this.op("sessions", () => this.adapter.sessions);
    const checkpoint = attribution.call(
      side,
      "RuntimeSession.exportCheckpoint",
      session,
      "exportCheckpoint",
      [],
    );
    this.#points.set(state, {
      fork: forked,
      "checked-snapshot": attribution.call(
        side,
        "RuntimeSession.exportSnapshot",
        session,
        "exportSnapshot",
        [],
      ),
      "trusted-snapshot": attribution.call(
        side,
        "RuntimeSession.exportTrustedSnapshot",
        session,
        "exportTrustedSnapshot",
        [],
      ),
      "tagged-snapshot": attribution.call(
        side,
        "RuntimeSession.exportTaggedSnapshot",
        session,
        "exportTaggedSnapshot",
        [],
      ),
      checkpoint,
      "checkpoint-json": attribution.call(
        side,
        "serializeCheckpoint",
        sessions,
        "serializeCheckpoint",
        [checkpoint],
      ),
    });
  }

  public restore(tail: RestoreTail, cut: number): { readonly run: number; readonly live: boolean } {
    const id = this.#runs.size;
    const made = this.restored(tail, cut);
    this.#runs.set(id, made);
    return { run: id, live: made instanceof Side };
  }

  private restored(tail: RestoreTail, cut: number): Side | SideRecord {
    const attribution = this.attribution;
    const side = this.side;
    const point = this.#points.get(cut)!;
    const plan = this.plan();
    let session: RuntimeSession;
    let runLog = this.log();
    if (tail === "fork") {
      if ("thrown" in point.fork) return thrownRecord(point.fork.thrown);
      session = point.fork.session;
      runLog = point.fork.log;
    } else {
      const sessions = this.op("sessions", () => this.adapter.sessions);
      const sessionOptions = runLog.options();
      type Made = { readonly session: RuntimeSession } | { readonly record: SideRecord };
      const refused = (error: unknown): Made => ({ record: thrownRecord(errorText(error)) });
      let made: Made;
      if (tail === "checked-snapshot" || tail === "trusted-snapshot") {
        const make = this.op("createRuntimeSession", () => sessions.createRuntimeSession);
        const snapshot = point[tail];
        made = engine<Made>(
          () => ({
            session: attribution.invoke(side, "createRuntimeSession", sessions, make, [
              plan,
              snapshot,
              sessionOptions,
            ]),
          }),
          refused,
        );
      } else if (tail === "tagged-snapshot") {
        const make = this.op(
          "createTaggedRuntimeSession",
          () => sessions.createTaggedRuntimeSession,
        );
        const tagged = point[tail];
        made = engine<Made>(
          () => ({
            session: attribution.invoke(side, "createTaggedRuntimeSession", sessions, make, [
              plan,
              tagged,
              sessionOptions,
            ]),
          }),
          refused,
        );
      } else if (tail === "checkpoint") {
        const make = this.op("restoreRuntimeSession", () => sessions.restoreRuntimeSession);
        const checkpoint = point[tail];
        made = engine<Made>(
          () => ({
            session: attribution.invoke(side, "restoreRuntimeSession", sessions, make, [
              checkpoint,
              sessionOptions,
            ]),
          }),
          refused,
        );
      } else {
        const make = this.op("deserializeRuntimeSession", () => sessions.deserializeRuntimeSession);
        const json = point[tail];
        made = engine<Made>(
          () => ({
            session: attribution.invoke(side, "deserializeRuntimeSession", sessions, make, [
              json,
              sessionOptions,
            ]),
          }),
          refused,
        );
      }
      if ("record" in made) return made.record;
      session = made.session;
    }
    // The side's uninterrupted host calls, replayed by state index.
    const calls = this.#start!.calls;
    return new Side(
      attribution,
      side,
      this.adapter,
      session,
      runLog,
      "restore",
      (state) => {
        const recorded = calls.get(state);
        return recorded === undefined ? null : replayed(attribution, side, recorded);
      },
      cut,
    );
  }

  public pending(): ClassifiedSideFailure | null {
    const latched = this.attribution.pending();
    return latched === null ? null : { side: latched.side, outcome: classifiedFailure(latched) };
  }
}

/**
 * A public engine call: the callee is acquired and its arguments are made outside the narrow catch, and only the
 * invocation runs inside it, so that only the engine's own exception is engine behaviour.
 */
function engine<T>(invoke: () => T, refused: (error: unknown) => T): T {
  try {
    return invoke();
  } catch (error) {
    if (error instanceof CallbackFailure) throw error;
    return refused(error);
  }
}

/** The modules of one build that make its adapter: its authoring entry, its compiler and its core backend. */
export interface BuildModules {
  readonly index: {
    readonly compileProject: typeof compileProject;
    readonly compileSource: typeof compileSource;
    readonly createFreshRuntimeSession: typeof createFreshRuntimeSession;
    readonly createRuntimeSession: typeof createRuntimeSession;
    readonly createTaggedRuntimeSession: typeof createTaggedRuntimeSession;
    readonly restoreRuntimeSession: typeof restoreRuntimeSession;
    readonly deserializeRuntimeSession: typeof deserializeRuntimeSession;
    readonly serializeCheckpoint: typeof serializeCheckpoint;
    readonly runtimeTimedWork: typeof runtimeTimedWork;
    readonly RuntimeDebugContext: typeof RuntimeDebugContext;
  };
  readonly compiler: {
    readonly compileProjectWithBackend: typeof compileProjectWithBackend;
    readonly compileSourceWithBackend: typeof compileSourceWithBackend;
  };
  readonly backend: {
    readonly CORE_BACKEND: typeof CORE_BACKEND;
    readonly CandidateOutsideSlice: typeof CandidateOutsideSlice;
  };
}

/** A build's adapter, from its modules: this checkout's (`thisBuild`), or a root's own, loaded under 0a's guard. */
export function buildAdapter(label: string, modules: BuildModules): PipelineAdapter {
  const { index, compiler, backend } = modules;
  return {
    label,
    compile(input, route) {
      const options = input.compile ?? { globals: Object.keys(input.fresh?.globals ?? {}) };
      const first = input.sources[0]!.source;
      let result;
      try {
        if (route === "legacy")
          result = input.project
            ? index.compileProject(input.sources, options)
            : index.compileSource(first, options);
        else
          result = input.project
            ? compiler.compileProjectWithBackend(input.sources, options, backend.CORE_BACKEND)
            : compiler.compileSourceWithBackend(first, options, backend.CORE_BACKEND);
      } catch (error) {
        if (error instanceof backend.CandidateOutsideSlice)
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
      createFreshRuntimeSession: index.createFreshRuntimeSession,
      createRuntimeSession: index.createRuntimeSession,
      createTaggedRuntimeSession: index.createTaggedRuntimeSession,
      restoreRuntimeSession: index.restoreRuntimeSession,
      deserializeRuntimeSession: index.deserializeRuntimeSession,
      serializeCheckpoint: index.serializeCheckpoint,
      runtimeTimedWork: index.runtimeTimedWork,
      RuntimeDebugContext: index.RuntimeDebugContext,
    },
  };
}
