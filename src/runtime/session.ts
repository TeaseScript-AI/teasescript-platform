import type { InstructionPlan } from "../plan/model.js";
import { captureOrReuseInstructionPlan } from "../plan/capture.js";
import { interruptFrame } from "./activations.js";
import type {
  RuntimeForegroundActionSnapshot,
  RuntimePendingActionSnapshot,
} from "./actions/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  type RuntimeCheckpoint,
} from "./checkpoint.js";
import {
  executeValidatedInstruction,
  instructionBudget,
  runValidatedState,
  stepValidatedStateToEvent,
  type RuntimeRunOptions,
} from "./engine.js";
import type { RuntimeCapabilities } from "./evaluator.js";
import type { InterpreterEvent } from "./events.js";
import type { RuntimeInstructionTrace } from "./instruction-trace.js";
import type { RuntimeDebugContext } from "./debug-trace.js";
import {
  completeValidatedAction,
  type ActionCompletionOptions,
} from "./operations/complete-action.js";
import type {
  ActionCompletionOutcome,
  PendingActionOperationResult,
  RuntimeOperationResult,
  TimeObservationOutcome,
} from "./operations/model.js";
import { executionRunnable, observeValidatedTime } from "./operations/observe-time.js";
import {
  applyValidatedStorageEdit,
  type ExternalStorageEditOutcome,
} from "./operations/external-storage-edit.js";
import {
  recordValidatedContinueCapture,
  type ContinueCaptureOutcome,
} from "./operations/continue-capture.js";
import { reportValidatedMediaLoad, type MediaReportOutcome } from "./operations/media-reports.js";
import {
  pressValidatedPermanentButton,
  type PermanentButtonPressOutcome,
} from "./operations/press-permanent-button.js";
import {
  updateValidatedInteraction,
  type InteractionUpdateOutcome,
} from "./operations/update-interaction.js";
import { inspectRuntimeState, type RuntimeInspectionResult } from "./inspection.js";
import {
  mediaPlaybackProjection,
  stageProjection,
  type MediaPlaybackProjection,
  type StageProjection,
} from "./media-projection.js";
import { permanentButtonProjection, type PermanentButtonProjection } from "./permanent-buttons.js";
import { captureExecutableData } from "./operations/support.js";
import { isFrozenTemporalContext } from "../temporal.js";
import {
  createFreshRuntimeSnapshotWithValidatedPlan,
  withFrozenTemporalCaptures,
  type FreshRuntimeOptions,
  type RuntimeFailureSnapshot,
  type RuntimeInterruptibleActionSnapshot,
  type RuntimeSnapshot,
  type RuntimeStatus,
} from "./state.js";

/** What every operation of a session, and of the sessions forked from it, may call. */
export interface RuntimeSessionOptions {
  readonly capabilities?: RuntimeCapabilities;
}

/** What a session operation did: detached, deeply frozen data that shares nothing with the session's state. */
export interface RuntimeSessionResult {
  readonly events: readonly InterpreterEvent[];
  readonly instructionsExecuted: number;
  /** Present only when the operation was called with `instructionTrace: true`. */
  readonly instructionTrace?: RuntimeInstructionTrace;
}

export interface RuntimeSessionOutcomeResult<T> extends RuntimeSessionResult {
  readonly outcome: T;
}

/**
 * The operational state a host needs between operations, as detached, deeply frozen data. Variables, storage, and the
 * other script data stay inside the session; `exportSnapshot` is the complete view.
 */
export interface RuntimeSessionView {
  readonly status: RuntimeStatus;
  readonly failure: RuntimeFailureSnapshot | null;
  readonly nextInstruction: number;
  readonly currentSessionTimeMs: number;
  readonly observedSessionTimeMs: number;
  /** Whether `run` executes something now: the script, or a queued block that may start. */
  readonly runnable: boolean;
  readonly foregroundAction: RuntimeForegroundActionSnapshot | null;
  readonly backgroundActions: readonly RuntimePendingActionSnapshot[];
  /** The foreground action of the path a running timer, media, or button block interrupted, or `null`. */
  readonly suspendedAction: RuntimeInterruptibleActionSnapshot | null;
}

/** The options of an operation that only takes a debug trace. */
interface TraceOptions {
  readonly debugTrace?: RuntimeDebugContext;
}

const CREATE = Symbol("RuntimeSession");

/**
 * An engine-owned runtime session: the validated immutable plan and the canonical snapshot stay private, and every
 * operation runs the same deterministic engine as the snapshot-taking API. See `docs/RUNTIME.md#runtime-sessions`.
 */
export class RuntimeSession {
  readonly #plan: InstructionPlan;
  readonly #capabilities: RuntimeCapabilities;
  #state: RuntimeSnapshot;
  #operating = false;
  /** What an operation threw, which ended the session, or `null`. */
  #thrown: { readonly error: unknown } | null = null;

  /** Sessions come from the session factories and `fork`; the token keeps callers from supplying their own state. */
  public constructor(
    token: typeof CREATE,
    plan: InstructionPlan,
    state: RuntimeSnapshot,
    capabilities: RuntimeCapabilities,
  ) {
    if (token !== CREATE) {
      throw new TypeError(
        "Create a runtime session with createRuntimeSession, createFreshRuntimeSession, or restoreRuntimeSession.",
      );
    }
    this.#plan = plan;
    this.#state = state;
    this.#capabilities = capabilities;
  }

  /** The validated, deeply frozen instruction plan the session runs. */
  public get plan(): InstructionPlan {
    return this.#plan;
  }

  public run(options: RuntimeRunOptions = {}): RuntimeSessionResult {
    return this.#operate(
      () => runOptions(options),
      (state, checked) => runValidatedState(this.#plan, state, this.#capabilities, checked),
      executed,
    );
  }

  public stepToEvent(options: RuntimeRunOptions = {}): RuntimeSessionResult {
    return this.#operate(
      () => runOptions(options),
      (state, checked) => stepValidatedStateToEvent(this.#plan, state, this.#capabilities, checked),
      executed,
    );
  }

  public executeInstruction(
    options: Pick<RuntimeRunOptions, "debugTrace" | "instructionTrace"> = {},
  ): RuntimeSessionResult {
    return this.#operate(
      () => ({ ...traceOptions(options), ...instructionTraceOption(options) }),
      (state, checked) =>
        executeValidatedInstruction(this.#plan, state, this.#capabilities, checked),
      executed,
    );
  }

  public observeTime(
    nowMs: unknown,
    mediaReports: unknown = [],
    options: TraceOptions = {},
  ): RuntimeSessionOutcomeResult<TimeObservationOutcome> {
    return this.#operate(
      () => traceOptions(options),
      (state, checked) => observeValidatedTime(this.#plan, state, nowMs, mediaReports, checked),
      settled,
    );
  }

  public completeAction(
    request: unknown,
    options: ActionCompletionOptions = {},
  ): RuntimeSessionOutcomeResult<ActionCompletionOutcome> {
    return this.#operate(
      () => completionOptions(options),
      (state, checked) => completeValidatedAction(this.#plan, state, request, checked),
      settled,
    );
  }

  public reportMediaLoad(
    mediaId: unknown,
    report: unknown,
    options: TraceOptions = {},
  ): RuntimeSessionOutcomeResult<MediaReportOutcome> {
    return this.#operate(
      () => traceOptions(options),
      (state, checked) => reportValidatedMediaLoad(this.#plan, state, mediaId, report, checked),
      settled,
    );
  }

  public updateInteraction(
    request: unknown,
    options: TraceOptions = {},
  ): RuntimeSessionOutcomeResult<InteractionUpdateOutcome> {
    return this.#operate(
      () => traceOptions(options),
      (state, checked) => updateValidatedInteraction(this.#plan, state, request, checked),
      settled,
    );
  }

  public pressPermanentButton(
    buttonId: unknown,
    options: TraceOptions = {},
  ): RuntimeSessionOutcomeResult<PermanentButtonPressOutcome> {
    return this.#operate(
      () => traceOptions(options),
      (state, checked) => pressValidatedPermanentButton(this.#plan, state, buttonId, checked),
      settled,
    );
  }

  public recordContinueCapture(
    capture: unknown,
    options: TraceOptions = {},
  ): RuntimeSessionOutcomeResult<ContinueCaptureOutcome> {
    return this.#operate(
      () => traceOptions(options),
      (state, checked) => recordValidatedContinueCapture(this.#plan, state, capture, checked),
      settled,
    );
  }

  public applyExternalStorageEdit(
    edit: unknown,
    options: TraceOptions = {},
  ): RuntimeSessionOutcomeResult<ExternalStorageEditOutcome> {
    return this.#operate(
      () => traceOptions(options),
      (state, checked) => applyValidatedStorageEdit(this.#plan, state, edit, checked),
      settled,
    );
  }

  public view(): RuntimeSessionView {
    return this.#read((state) =>
      published({
        status: state.status,
        failure: state.failure,
        nextInstruction: state.nextInstruction,
        currentSessionTimeMs: state.currentSessionTimeMs,
        observedSessionTimeMs: state.observedSessionTimeMs,
        runnable: executionRunnable(state),
        foregroundAction: state.foregroundAction,
        backgroundActions: state.backgroundActions,
        suspendedAction: interruptFrame(state)?.timerInterruption?.suspendedAction ?? null,
      }),
    );
  }

  /** What the Stage shows, as `stageProjection` gives it for a snapshot. */
  public stageProjection(): StageProjection {
    return this.#read((state) => published(stageProjection(state)));
  }

  /** The media a Player plays, as `mediaPlaybackProjection` gives them for a snapshot. */
  public mediaPlaybackProjection(): readonly MediaPlaybackProjection[] {
    return this.#read((state) => published(mediaPlaybackProjection(state)));
  }

  /** The shown permanent buttons, as `permanentButtonProjection` gives them for a snapshot. */
  public permanentButtonProjection(): readonly PermanentButtonProjection[] {
    return this.#read((state) => published(permanentButtonProjection(state)));
  }

  /**
   * The instruction where each active call continues when it returns, outermost first: after a function or file call,
   * or where a running timer, media, or button block resumes the path it interrupted. The work is proportional to the
   * call depth.
   */
  public callReturnInstructions(): readonly number[] {
    return this.#read((state) =>
      Object.freeze(state.callFrames.map((frame) => frame.returnInstruction)),
    );
  }

  /** `inspectRuntimeState`'s debugger inspection, which captures and validates the whole state first. */
  public inspect(): RuntimeInspectionResult {
    return this.#read((state) => inspectRuntimeState(this.#plan, state));
  }

  /** A complete snapshot, freshly captured and validated: plain data that later operations do not change. */
  public exportSnapshot(): RuntimeSnapshot {
    return this.#read((state) => captureExecutableData(this.#plan, state).snapshot);
  }

  /** A self-contained checkpoint of the plan and a freshly captured and validated snapshot. */
  public exportCheckpoint(): RuntimeCheckpoint {
    return this.#read((state) => createCheckpoint(this.#plan, state));
  }

  /**
   * An independent session with a trusted copy of this session's state, which keeps every record's property order and
   * so its checkpoint bytes. It shares only the immutable plan and deeply frozen temporal contexts.
   */
  public fork(options?: RuntimeSessionOptions): RuntimeSession {
    return this.#read((state) => {
      const capabilities =
        (options === undefined ? undefined : sessionCapabilities(options)) ?? this.#capabilities;
      return new RuntimeSession(CREATE, this.#plan, copyPlainData(state, false), capabilities);
    });
  }

  /**
   * Reads and checks the arguments once, then runs one operation on the session's state and publishes its result. An
   * argument error leaves the session unchanged and usable. Anything thrown after the operation started may leave part
   * of the state changed, so it ends the session.
   */
  #operate<O, R extends RuntimeOperationResult, P>(
    check: () => O,
    operate: (state: RuntimeSnapshot, checked: O) => R,
    publish: (done: R) => P,
  ): P {
    return this.#read((state) => {
      const checked = check();
      try {
        const done = operate(state, checked);
        this.#state = done.snapshot;
        return publish(done);
      } catch (error) {
        this.#thrown = { error };
        throw error;
      }
    });
  }

  #read<T>(read: (state: RuntimeSnapshot) => T): T {
    if (this.#thrown !== null) {
      throw new RuntimeSessionError(
        "This runtime session ended when one of its operations threw; continue from the last exported snapshot or checkpoint.",
        { cause: this.#thrown.error },
      );
    }
    if (this.#operating) {
      throw new RuntimeSessionError(
        "A runtime session operation cannot start while another operation of the same session runs.",
      );
    }
    this.#operating = true;
    try {
      return read(this.#state);
    } finally {
      this.#operating = false;
    }
  }
}

/** A session used while one of its operations runs, or after one of its operations threw. */
export class RuntimeSessionError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeSessionError";
  }
}

function executed(done: RuntimeOperationResult): RuntimeSessionResult {
  return published(
    done.instructionTrace === undefined
      ? { events: done.events, instructionsExecuted: done.instructionsExecuted }
      : {
          events: done.events,
          instructionsExecuted: done.instructionsExecuted,
          instructionTrace: done.instructionTrace,
        },
  );
}

function settled<T>(done: PendingActionOperationResult<T>): RuntimeSessionOutcomeResult<T> {
  return published({
    events: done.events,
    instructionsExecuted: done.instructionsExecuted,
    outcome: done.outcome,
  });
}

/*
 * Argument checks read each option once and return plain options holding those values, which the operation then uses:
 * an accessor cannot give the check one value and the operation another.
 */

function runOptions(options: RuntimeRunOptions): RuntimeRunOptions {
  const trace = traceOptions(options);
  const budget = options.instructionBudget;
  instructionBudget(budget);
  return {
    ...trace,
    ...instructionTraceOption(options),
    ...(budget === undefined ? {} : { instructionBudget: budget }),
  };
}

function traceOptions(options: TraceOptions): TraceOptions {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Runtime session operation options must be an object.");
  }
  const debugTrace = options.debugTrace;
  if (debugTrace === undefined) return {};
  if (typeof debugTrace !== "object" || debugTrace === null) {
    throw new TypeError("debugTrace must be a RuntimeDebugContext.");
  }
  return { debugTrace };
}

function instructionTraceOption(
  options: Pick<RuntimeRunOptions, "instructionTrace">,
): Pick<RuntimeRunOptions, "instructionTrace"> {
  return options.instructionTrace === true ? { instructionTrace: true } : {};
}

function completionOptions(options: ActionCompletionOptions): ActionCompletionOptions {
  const trace = traceOptions(options);
  const admission = options.capturedMedia;
  if (admission === undefined) return trace;
  const holds = typeof admission === "object" && admission !== null ? admission.holds : undefined;
  if (typeof holds !== "function") {
    throw new TypeError("capturedMedia must have a holds(reference, kind) method.");
  }
  return {
    ...trace,
    capturedMedia: { holds: (reference, kind) => holds.call(admission, reference, kind) },
  };
}

/** The capabilities `options` gives, read once into a plain record after checking their shape, or `undefined`. */
function sessionCapabilities(options: RuntimeSessionOptions): RuntimeCapabilities | undefined {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Runtime session options must be an object.");
  }
  const capabilities = options.capabilities;
  if (capabilities === undefined) return undefined;
  if (typeof capabilities !== "object" || capabilities === null) {
    throw new TypeError("capabilities must be an object.");
  }
  const builtins = capabilities.builtins;
  if (builtins !== undefined && (typeof builtins !== "object" || builtins === null)) {
    throw new TypeError("capabilities.builtins must be an object.");
  }
  const random = capabilities.random;
  if (
    random !== undefined &&
    (typeof random !== "object" || random === null || typeof random.next !== "function")
  ) {
    throw new TypeError("capabilities.random must have a next() method.");
  }
  return {
    ...(builtins === undefined ? {} : { builtins }),
    ...(random === undefined ? {} : { random }),
  };
}

/** A session that runs `snapshot`, which it captures and completely validates as external data. */
export function createRuntimeSession(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  options: RuntimeSessionOptions = {},
): RuntimeSession {
  const capabilities = sessionCapabilities(options) ?? {};
  const captured = captureExecutableData(plan, snapshot);
  return new RuntimeSession(CREATE, captured.plan, captured.snapshot, capabilities);
}

/** A session at the start of `plan`, with state that `createFreshRuntimeSnapshot` would create. */
export function createFreshRuntimeSession(
  plan: InstructionPlan,
  fresh: FreshRuntimeOptions = {},
  options: RuntimeSessionOptions = {},
): RuntimeSession {
  const capabilities = sessionCapabilities(options) ?? {};
  const capturedPlan = captureOrReuseInstructionPlan(plan);
  if (!capturedPlan.validation.valid || capturedPlan.plan === null) {
    throw new TypeError(
      capturedPlan.validation.errors[0]?.message ?? "Malformed instruction plan.",
    );
  }
  const state = createFreshRuntimeSnapshotWithValidatedPlan(capturedPlan.plan, fresh);
  return new RuntimeSession(
    CREATE,
    capturedPlan.plan,
    withFrozenTemporalCaptures(state),
    capabilities,
  );
}

/** A session that continues a checkpoint, which `restoreCheckpoint` captures and completely validates. */
export function restoreRuntimeSession(
  checkpoint: unknown,
  options: RuntimeSessionOptions = {},
): RuntimeSession {
  const capabilities = sessionCapabilities(options) ?? {};
  return adoptCheckpoint(restoreCheckpoint(checkpoint), capabilities);
}

/** A session that continues checkpoint JSON, which `deserializeCheckpoint` parses and completely validates. */
export function deserializeRuntimeSession(
  json: string,
  options: RuntimeSessionOptions = {},
): RuntimeSession {
  const capabilities = sessionCapabilities(options) ?? {};
  return adoptCheckpoint(deserializeCheckpoint(json), capabilities);
}

/** The restored checkpoint was created by this restore, so no caller holds its snapshot. */
function adoptCheckpoint(
  checkpoint: RuntimeCheckpoint,
  capabilities: RuntimeCapabilities,
): RuntimeSession {
  return new RuntimeSession(CREATE, checkpoint.plan, checkpoint.snapshot, capabilities);
}

/** JSON-safe engine data: the shape of runtime state and of everything an operation returns. */
type PlainValue = string | number | boolean | null | undefined | PlainValue[] | PlainRecord;
type PlainRecord = { [key: string]: PlainValue };

/** A deeply frozen copy of plain engine output, so that nothing a session publishes shares an object with its state. */
function published<T>(value: T): T {
  return copyPlainData(value, true);
}

/**
 * Copies JSON-safe engine data without recursion, keeping each record's property order, in work proportional to the
 * data. `publish` freezes every copy; otherwise the copy is a trusted state copy, which shares the deeply frozen
 * temporal contexts.
 */
function copyPlainData<T>(value: T, publish: boolean): T {
  const work: Array<readonly [PlainValue[], PlainValue[]] | readonly [PlainRecord, PlainRecord]> =
    [];
  const enter = (nested: PlainValue): PlainValue => {
    if (typeof nested !== "object" || nested === null) return nested;
    if (!publish && isFrozenTemporalContext(nested)) return nested;
    if (Array.isArray(nested)) {
      const copy = new Array<PlainValue>(nested.length);
      work.push([nested, copy]);
      return copy;
    }
    const copy: PlainRecord = Object.getPrototypeOf(nested) === null ? Object.create(null) : {};
    work.push([nested, copy]);
    return copy;
  };
  // EVIDENCE: invariant: engine state and operation output are JSON-safe plain data.
  const root = enter(value as PlainValue);
  for (let step = work.pop(); step !== undefined; step = work.pop()) {
    if (Array.isArray(step[0]) && Array.isArray(step[1])) {
      const [source, copy] = step;
      for (let index = 0; index < source.length; index += 1) copy[index] = enter(source[index]);
    } else if (!Array.isArray(step[0]) && !Array.isArray(step[1])) {
      const [source, copy] = step;
      for (const key of Object.keys(source)) copy[key] = enter(source[key]);
    }
    if (publish) Object.freeze(step[1]);
  }
  // EVIDENCE: invariant: the copy has the same JSON-safe structure as `value`.
  return root as T;
}
