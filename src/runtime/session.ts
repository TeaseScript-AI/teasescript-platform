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
import { captureExecutableData } from "./operations/support.js";
import {
  cloneCapturedRuntimeSnapshot,
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

const CREATE = Symbol("RuntimeSession");

/**
 * An engine-owned runtime session: the validated immutable plan and the canonical snapshot stay private, and every
 * operation runs the same deterministic engine as the snapshot-taking API. See `docs/RUNTIME.md#runtime-sessions`.
 */
export class RuntimeSession {
  /** The validated, deeply frozen instruction plan the session runs. */
  public readonly plan: InstructionPlan;
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
    this.plan = plan;
    this.#state = state;
    this.#capabilities = capabilities;
  }

  public run(options: RuntimeRunOptions = {}): RuntimeSessionResult {
    return this.#execute(
      () => checkRunOptions(options),
      (state) => runValidatedState(this.plan, state, this.#capabilities, options),
    );
  }

  public stepToEvent(options: RuntimeRunOptions = {}): RuntimeSessionResult {
    return this.#execute(
      () => checkRunOptions(options),
      (state) => stepValidatedStateToEvent(this.plan, state, this.#capabilities, options),
    );
  }

  public executeInstruction(
    options: Pick<RuntimeRunOptions, "debugTrace" | "instructionTrace"> = {},
  ): RuntimeSessionResult {
    return this.#execute(
      () => checkTraceOptions(options),
      (state) => executeValidatedInstruction(this.plan, state, this.#capabilities, options),
    );
  }

  public observeTime(
    nowMs: unknown,
    mediaReports: unknown = [],
    options: { readonly debugTrace?: RuntimeDebugContext } = {},
  ): RuntimeSessionOutcomeResult<TimeObservationOutcome> {
    return this.#settle(
      () => checkTraceOptions(options),
      (state) => observeValidatedTime(this.plan, state, nowMs, mediaReports, options),
    );
  }

  public completeAction(
    request: unknown,
    options: ActionCompletionOptions = {},
  ): RuntimeSessionOutcomeResult<ActionCompletionOutcome> {
    return this.#settle(
      () => checkCompletionOptions(options),
      (state) => completeValidatedAction(this.plan, state, request, options),
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

  /** A complete snapshot, freshly captured and validated: plain data that later operations do not change. */
  public exportSnapshot(): RuntimeSnapshot {
    return this.#read((state) => captureExecutableData(this.plan, state).snapshot);
  }

  /** A self-contained checkpoint of the plan and a freshly captured and validated snapshot. */
  public exportCheckpoint(): RuntimeCheckpoint {
    return this.#read((state) => createCheckpoint(this.plan, state));
  }

  /** An independent session with a copy of this session's state that shares only the immutable plan. */
  public fork(options: RuntimeSessionOptions = {}): RuntimeSession {
    const capabilities = sessionCapabilities(options) ?? this.#capabilities;
    return this.#read(
      (state) =>
        new RuntimeSession(CREATE, this.plan, cloneCapturedRuntimeSnapshot(state), capabilities),
    );
  }

  #execute(
    check: () => void,
    operate: (state: RuntimeSnapshot) => RuntimeOperationResult,
  ): RuntimeSessionResult {
    const done = this.#commit(check, operate);
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

  #settle<T>(
    check: () => void,
    operate: (state: RuntimeSnapshot) => PendingActionOperationResult<T>,
  ): RuntimeSessionOutcomeResult<T> {
    const done = this.#commit(check, operate);
    return published({
      events: done.events,
      instructionsExecuted: done.instructionsExecuted,
      outcome: done.outcome,
    });
  }

  /**
   * Checks the arguments, then runs one operation on the session's state. An operation that throws may have changed
   * part of the state, so it finishes the session; an argument error leaves it unchanged and usable.
   */
  #commit<R extends RuntimeOperationResult>(
    check: () => void,
    operate: (state: RuntimeSnapshot) => R,
  ): R {
    return this.#read((state) => {
      check();
      let done: R;
      try {
        done = operate(state);
      } catch (error) {
        this.#thrown = { error };
        throw error;
      }
      this.#state = done.snapshot;
      return done;
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

function checkRunOptions(options: RuntimeRunOptions): void {
  checkTraceOptions(options);
  instructionBudget(options.instructionBudget);
}

function checkTraceOptions(options: { readonly debugTrace?: RuntimeDebugContext }): void {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Runtime session operation options must be an object.");
  }
  if (
    options.debugTrace !== undefined &&
    (typeof options.debugTrace !== "object" || options.debugTrace === null)
  ) {
    throw new TypeError("debugTrace must be a RuntimeDebugContext.");
  }
}

function checkCompletionOptions(options: ActionCompletionOptions): void {
  checkTraceOptions(options);
  const admission = options.capturedMedia;
  if (
    admission !== undefined &&
    (typeof admission !== "object" || admission === null || typeof admission.holds !== "function")
  ) {
    throw new TypeError("capturedMedia must have a holds(reference, kind) method.");
  }
}

/** The capabilities `options` gives, after checking their shape, or `undefined`. */
function sessionCapabilities(options: RuntimeSessionOptions): RuntimeCapabilities | undefined {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Runtime session options must be an object.");
  }
  const capabilities = options.capabilities;
  if (capabilities === undefined) return undefined;
  if (typeof capabilities !== "object" || capabilities === null) {
    throw new TypeError("capabilities must be an object.");
  }
  if (
    capabilities.builtins !== undefined &&
    (typeof capabilities.builtins !== "object" || capabilities.builtins === null)
  ) {
    throw new TypeError("capabilities.builtins must be an object.");
  }
  const random = capabilities.random;
  if (
    random !== undefined &&
    (typeof random !== "object" || random === null || typeof random.next !== "function")
  ) {
    throw new TypeError("capabilities.random must have a next() method.");
  }
  return capabilities;
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

/**
 * A deeply frozen copy of plain engine output, so that nothing a session publishes shares an object with its state. The
 * work is proportional to the published data.
 */
function published<T>(value: T): T {
  const copy = structuredClone(value);
  const work: unknown[] = [copy];
  while (work.length > 0) {
    const current = work.pop();
    if (typeof current !== "object" || current === null) continue;
    Object.freeze(current);
    for (const nested of Object.values(current)) work.push(nested);
  }
  return copy;
}
