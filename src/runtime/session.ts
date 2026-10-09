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
  serializeValidatedRuntimeJson,
  type RuntimeCheckpoint,
} from "./checkpoint.js";
import {
  executeValidatedInstruction,
  instructionBudget,
  resumeValidatedRandomDraw,
  runValidatedState,
  stepValidatedStateToEvent,
  type RuntimeRunOptions,
} from "./engine.js";
import {
  compileRandomPolicy,
  type RandomChoiceReceipt,
  type RandomControlOptions,
  type RandomDecisionRefusal,
  type RandomDrawResolutionOutcome,
  type RandomDrawView,
  type RandomPolicy,
} from "./random-control.js";
import type { RuntimeBuiltinFunction, RuntimeCapabilities } from "./evaluator.js";
import type { InterpreterEvent } from "./events.js";
import type { RuntimeInstructionTrace } from "./instruction-trace.js";
import { runtimeDebugPreview, type RuntimeDebugContext } from "./debug-trace.js";
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
import { setValidatedDebugMode, type DebugModeOutcome } from "./operations/debug-mode.js";
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
import { captureExecutableData, RuntimeDataError } from "./operations/support.js";
import { copyPlainData } from "./plain-data.js";
import { hasSnapshotTag, snapshotTag } from "./snapshot-tag.js";
import type { PresentationSettings } from "../temporal.js";
import type { SourceSpan } from "../source.js";
import {
  createFreshRuntimeSnapshotWithValidatedPlan,
  currentTemporalContext,
  withFrozenTemporalCaptures,
  type FreshRuntimeOptions,
  type RuntimeBindingSnapshot,
  type RuntimeCameraViewSnapshot,
  type RuntimeFailureSnapshot,
  type RuntimeCallFrameSnapshot,
  type RuntimeLiveMessageSnapshot,
  type RuntimeScopeFrameSnapshot,
  type RuntimeInterruptibleActionSnapshot,
  type RuntimeSnapshot,
  type RuntimeStatus,
} from "./state.js";

/** What every operation of a session, and of the sessions forked from it, may call. */
export interface RuntimeSessionOptions {
  readonly capabilities?: RuntimeCapabilities;
  /**
   * Which draws the host decides or pauses at (`docs/RUNTIME.md#controlled-randomness`); `null` or absent leaves every
   * draw natural. A fork inherits it unless its options give `randomControl`.
   */
  readonly randomControl?: RandomControlOptions | null;
}

/** What a session operation did: detached, deeply frozen data that shares nothing with the session's state. */
export interface RuntimeSessionResult {
  readonly events: readonly InterpreterEvent[];
  readonly instructionsExecuted: number;
  /** Present only when the operation was called with `instructionTrace: true`. */
  readonly instructionTrace?: RuntimeInstructionTrace;
  /** The chosen random outcomes the operation accepted, in draw order; present only when there are some. */
  readonly randomChoices?: readonly RandomChoiceReceipt[];
  /** Present only when the decision callback gave an outcome a draw cannot produce, so it paused instead. */
  readonly randomRefusal?: RandomDecisionRefusal;
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
  /** The default camera's view, or `null` before the first `showCamera`. */
  readonly cameraView: RuntimeCameraViewSnapshot | null;
  /** How many timer, media, and button blocks are queued to run. */
  readonly queuedBlocks: number;
  /** What the protected `debugMode` reads now. */
  readonly debugMode: boolean;
  /** The random draw execution is paused at, which `resumeRandomDraw` resolves, or `null`. */
  readonly randomDraw: RandomDrawView | null;
  /** How many chosen random outcomes the state's history accepted. */
  readonly forcedRandomChoices: number;
}

/**
 * A snapshot as its JSON and a tag that proves that this engine wrote the JSON in this process for one plan
 * (`RuntimeSession.exportTaggedSnapshot`). A host keeps both strings as they are.
 */
export interface TaggedRuntimeSnapshot {
  readonly json: string;
  readonly tag: string;
}

/** One active call, as a debugger shows it, without its variables or arguments. */
export type RuntimeSessionCall = RuntimeSessionCallBase &
  (
    | {
        readonly kind: "function";
        /** The plan ID and name of the called function or block. */
        readonly functionId: number;
        readonly functionName: string;
        /** For a running timer, media, or button block, the kind of block that interrupted the path; otherwise `null`. */
        readonly interruption: "timer" | "media" | "button" | null;
      }
    | {
        readonly kind: "file";
        readonly functionId: null;
        readonly functionName: null;
        readonly interruption: null;
      }
  );

interface RuntimeSessionCallBase {
  readonly id: number;
  readonly callSiteSpan: SourceSpan;
  /** Where execution continues when the call returns. */
  readonly returnInstruction: number;
  /** The scopes from this depth on belong to the call. */
  readonly scopeBaseDepth: number;
}

/** A variable as a debugger lists it: its name and a bounded preview of its value. */
export interface RuntimeSessionVariablePreview {
  readonly name: string;
  /** The value as `runtimeDebugPreview` shows it, at most `RUNTIME_DEBUG_TRACE_LIMITS.maxPreviewCharacters` long. */
  readonly preview: string;
  readonly truncated: boolean;
  /** For a message handle, its message, whose current text `liveMessages` holds; otherwise `null`. */
  readonly messageId: number | null;
}

/** A scope's variables, as a debugger lists them. */
export interface RuntimeSessionScopePreview {
  readonly id: number;
  /** The file of an activation root, `null` for any other scope. */
  readonly file: number | null;
  readonly variables: readonly RuntimeSessionVariablePreview[];
}

/** The variables of a session as a debugger lists them, with bounded previews of their values. */
export interface RuntimeSessionVariablePreviews {
  readonly globals: readonly RuntimeSessionVariablePreview[];
  readonly frames: readonly RuntimeSessionScopePreview[];
  /** Scopes that were left but that timer, media, or button blocks still share. */
  readonly retainedScopes: readonly RuntimeSessionScopePreview[];
  /** The text that each message with a handle shows now. */
  readonly liveMessages: readonly RuntimeLiveMessageSnapshot[];
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
  #randomPolicy: RandomPolicy | null;
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
    randomPolicy: RandomPolicy | null,
  ) {
    if (token !== CREATE) {
      throw new TypeError(
        "Create a runtime session with createRuntimeSession, createFreshRuntimeSession, or restoreRuntimeSession.",
      );
    }
    this.#plan = plan;
    this.#state = state;
    this.#capabilities = capabilities;
    this.#randomPolicy = randomPolicy;
  }

  /** The validated, deeply frozen instruction plan the session runs. */
  public get plan(): InstructionPlan {
    return this.#plan;
  }

  public run(options: RuntimeRunOptions = {}): RuntimeSessionResult {
    return this.#operate(
      () => runOptions(options),
      (state, checked) =>
        runValidatedState(this.#plan, state, this.#capabilities, {
          ...checked,
          randomPolicy: this.#randomPolicy,
        }),
      executed,
    );
  }

  public stepToEvent(options: RuntimeRunOptions = {}): RuntimeSessionResult {
    return this.#operate(
      () => runOptions(options),
      (state, checked) =>
        stepValidatedStateToEvent(this.#plan, state, this.#capabilities, {
          ...checked,
          randomPolicy: this.#randomPolicy,
        }),
      executed,
    );
  }

  public executeInstruction(
    options: Pick<RuntimeRunOptions, "debugTrace" | "instructionTrace"> = {},
  ): RuntimeSessionResult {
    return this.#operate(
      () => ({
        ...traceOptions(options),
        ...instructionTraceOption(options),
        randomPolicy: this.#randomPolicy,
      }),
      (state, checked) =>
        executeValidatedInstruction(this.#plan, state, this.#capabilities, checked),
      executed,
    );
  }

  /**
   * Resolves the random draw execution is paused at and finishes the operation it interrupted, with the session's
   * random control for later draws. `{ drawId, outcome: "natural" }` keeps the natural result; a chosen outcome is an
   * input with a receipt in `randomChoices`. A request that does not fit the paused draw changes nothing.
   */
  public resumeRandomDraw(
    request: unknown,
    options: Pick<RuntimeRunOptions, "debugTrace" | "instructionTrace"> = {},
  ): RuntimeSessionOutcomeResult<RandomDrawResolutionOutcome> {
    return this.#operate(
      () => {
        if (this.#capabilities.random !== undefined)
          throw new TypeError(
            "A paused random draw resumes with the session generator, so capabilities.random must not be injected.",
          );
        return {
          ...traceOptions(options),
          ...instructionTraceOption(options),
          randomPolicy: this.#randomPolicy,
        };
      },
      (state, checked) =>
        resumeValidatedRandomDraw(this.#plan, state, request, this.#capabilities, checked),
      settled,
    );
  }

  /**
   * Changes which draws the host decides or pauses at, from the next operation on; `null` leaves every draw natural.
   * A draw already paused stays paused until `resumeRandomDraw` resolves it.
   */
  public setRandomControl(randomControl: RandomControlOptions | null): void {
    this.#read(() => {
      this.#randomPolicy = sessionRandomPolicy(this.#plan, randomControl, this.#capabilities);
    });
  }

  public observeTime(
    nowMs: unknown,
    mediaReports: unknown = [],
    options: TraceOptions = {},
  ): RuntimeSessionOutcomeResult<TimeObservationOutcome> {
    return this.#operate(
      () => ({ ...traceOptions(options), randomPolicy: this.#randomPolicy }),
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
      () => ({ ...traceOptions(options), randomPolicy: this.#randomPolicy }),
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

  public setDebugMode(
    enabled: unknown,
    options: TraceOptions = {},
  ): RuntimeSessionOutcomeResult<DebugModeOutcome> {
    return this.#operate(
      () => traceOptions(options),
      (state, checked) => setValidatedDebugMode(this.#plan, state, enabled, checked),
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
        runnable: executionRunnable(state) && state.randomControl?.pending == null,
        foregroundAction: state.foregroundAction,
        backgroundActions: state.backgroundActions,
        suspendedAction: interruptFrame(state)?.timerInterruption?.suspendedAction ?? null,
        cameraView: state.cameraView,
        queuedBlocks: state.pendingTimerHandlers.length,
        debugMode: state.debugMode,
        randomDraw: state.randomControl?.pending?.draw ?? null,
        forcedRandomChoices: state.randomControl?.forcedChoices ?? 0,
      }),
    );
  }

  /** The date and time presentation in force where execution stands. */
  public temporalPresentation(): PresentationSettings {
    return this.#read((state) => published(currentTemporalContext(state).presentation));
  }

  /** The active calls, outermost first, in work proportional to the call depth. */
  public callStack(): readonly RuntimeSessionCall[] {
    return this.#read((state) =>
      published(
        state.callFrames.map((frame): RuntimeSessionCall => ({
          id: frame.id,
          callSiteSpan: frame.callSiteSpan,
          returnInstruction: frame.returnInstruction,
          scopeBaseDepth: frame.scopeBaseDepth,
          ...(frame.kind === "function"
            ? {
                kind: "function",
                functionId: frame.functionId,
                functionName: frame.functionName,
                interruption: interruptionKind(frame),
              }
            : { kind: "file", functionId: null, functionName: null, interruption: null }),
        })),
      ),
    );
  }

  /**
   * The globals, scopes, and kept scopes with bounded previews of their values, and the live message texts: an
   * explicit inspection whose work is proportional to the number of variables and the live message texts, not to the
   * size of the values.
   */
  public variablePreviews(): RuntimeSessionVariablePreviews {
    return this.#read((state) => {
      const scope = (frame: RuntimeScopeFrameSnapshot): RuntimeSessionScopePreview => ({
        id: frame.id,
        file: frame.file,
        variables: frame.bindings.map(variablePreview),
      });
      return published({
        globals: state.globals.map(variablePreview),
        frames: state.frames.map(scope),
        retainedScopes: state.retainedScopes.map(scope),
        liveMessages: state.liveMessages,
      });
    });
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

  /**
   * The snapshot `exportSnapshot()` returns, as the same JSON, copied without capture and validation in work
   * proportional to the state: for a trusted host that keeps it itself, such as a search frontier. It is no boundary;
   * wherever the snapshot crosses one later, such as `createRuntimeSession`, it is captured and validated there.
   */
  public exportTrustedSnapshot(): RuntimeSnapshot {
    return this.#read((state) => copyPlainData(state, "export"));
  }

  /**
   * The JSON of the snapshot `exportSnapshot()` returns, written without capture and validation, and a tag that proves
   * that this engine wrote it in this process for this session's plan. `createTaggedRuntimeSession` restores it without
   * capture and validation while its tag holds.
   */
  public exportTaggedSnapshot(): TaggedRuntimeSnapshot {
    return this.#read((state) => {
      const json = serializeValidatedRuntimeJson(state);
      return Object.freeze({ json, tag: snapshotTag(this.#plan, json) });
    });
  }

  /** A self-contained checkpoint of the plan and a freshly captured and validated snapshot. */
  public exportCheckpoint(): RuntimeCheckpoint {
    return this.#read((state) => createCheckpoint(this.#plan, state));
  }

  /**
   * An independent session with a trusted copy of this session's state, which keeps every record's property order and
   * so its checkpoint bytes. It shares only the immutable plan and deeply frozen temporal contexts, and keeps each of
   * this session's capabilities that `options` do not give.
   */
  public fork(options?: RuntimeSessionOptions): RuntimeSession {
    return this.#read((state) => {
      const given = options === undefined ? undefined : sessionCapabilities(options);
      const capabilities =
        given === undefined ? this.#capabilities : { ...this.#capabilities, ...given };
      const randomPolicy =
        options !== undefined && "randomControl" in options
          ? sessionRandomPolicy(this.#plan, options.randomControl ?? null, capabilities)
          : this.#randomPolicy;
      if (randomPolicy !== null && capabilities.random !== undefined)
        throw new TypeError(
          "randomControl cannot be used with an injected capabilities.random: a paused draw needs the session generator.",
        );
      return new RuntimeSession(
        CREATE,
        this.#plan,
        copyPlainData(state, "fork"),
        capabilities,
        randomPolicy,
      );
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
        "This runtime session ended when one of its operations threw. Continue from the last exported snapshot or checkpoint.",
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

function interruptionKind(frame: RuntimeCallFrameSnapshot): "timer" | "media" | "button" | null {
  const interruption = frame.timerInterruption;
  if (interruption === null) return null;
  if ("timerId" in interruption) return "timer";
  return "mediaId" in interruption ? "media" : "button";
}

function variablePreview(binding: RuntimeBindingSnapshot): RuntimeSessionVariablePreview {
  const { text, truncated } = runtimeDebugPreview(binding.value);
  const value = binding.value;
  return {
    name: binding.name,
    preview: text,
    truncated,
    messageId:
      typeof value === "object" && value !== null && value.kind === "messageHandle"
        ? value.messageId
        : null,
  };
}

function executed(done: RuntimeOperationResult): RuntimeSessionResult {
  return published({
    events: done.events,
    instructionsExecuted: done.instructionsExecuted,
    ...(done.instructionTrace === undefined ? {} : { instructionTrace: done.instructionTrace }),
    ...(done.randomChoices === undefined ? {} : { randomChoices: done.randomChoices }),
    ...(done.randomRefusal === undefined ? {} : { randomRefusal: done.randomRefusal }),
  });
}

function settled<T>(done: PendingActionOperationResult<T>): RuntimeSessionOutcomeResult<T> {
  return published({
    events: done.events,
    instructionsExecuted: done.instructionsExecuted,
    ...(done.instructionTrace === undefined ? {} : { instructionTrace: done.instructionTrace }),
    ...(done.randomChoices === undefined ? {} : { randomChoices: done.randomChoices }),
    ...(done.randomRefusal === undefined ? {} : { randomRefusal: done.randomRefusal }),
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
  const admitted = builtins === undefined ? undefined : admittedBuiltins(builtins);
  const random = capabilities.random;
  if (
    random !== undefined &&
    (typeof random !== "object" || random === null || typeof random.next !== "function")
  ) {
    throw new TypeError("capabilities.random must have a next() method.");
  }
  return {
    ...(admitted === undefined ? {} : { builtins: admitted }),
    ...(random === undefined ? {} : { random }),
  };
}

/**
 * The functions `builtins` gives, each read once into a prototype-free record, so a call never meets a value that is
 * not a function. An explicit `undefined` gives no builtin of that name.
 */
function admittedBuiltins(
  builtins: Readonly<Record<string, RuntimeBuiltinFunction>>,
): Readonly<Record<string, RuntimeBuiltinFunction>> {
  const admitted: Record<string, RuntimeBuiltinFunction> = Object.create(null);
  for (const name of Object.keys(builtins)) {
    const builtin = builtins[name];
    if (builtin === undefined) continue;
    if (typeof builtin !== "function") {
      throw new TypeError(`capabilities.builtins.${name} must be a function.`);
    }
    admitted[name] = builtin;
  }
  return Object.freeze(admitted);
}

/** The random policy `randomControl` gives a session of `plan`, checked once; `null` leaves every draw natural. */
function sessionRandomPolicy(
  plan: InstructionPlan,
  randomControl: RandomControlOptions | null | undefined,
  capabilities: RuntimeCapabilities,
): RandomPolicy | null {
  return randomControl === undefined || randomControl === null
    ? null
    : compileRandomPolicy(plan, randomControl, capabilities.random !== undefined);
}

/** The random control a session's options give, read once. */
function sessionRandomControl(options: RuntimeSessionOptions): RandomControlOptions | null {
  return typeof options === "object" && options !== null ? (options.randomControl ?? null) : null;
}

/** A session that runs `snapshot`, which it captures and completely validates as external data. */
export function createRuntimeSession(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  options: RuntimeSessionOptions = {},
): RuntimeSession {
  const capabilities = sessionCapabilities(options) ?? {};
  const randomControl = sessionRandomControl(options);
  const captured = captureExecutableData(plan, snapshot);
  return new RuntimeSession(
    CREATE,
    captured.plan,
    captured.snapshot,
    capabilities,
    sessionRandomPolicy(captured.plan, randomControl, capabilities),
  );
}

/**
 * A session that runs the JSON of a tagged snapshot. When the tag proves that a session of this same plan object
 * exported the JSON in this process, the session runs it without capture and validation; otherwise the JSON is captured
 * and completely validated as external data, as `createRuntimeSession` does. Either way the state is the one that
 * `createRuntimeSession(plan, JSON.parse(json))` gives.
 */
export function createTaggedRuntimeSession(
  plan: InstructionPlan,
  tagged: TaggedRuntimeSnapshot,
  options: RuntimeSessionOptions = {},
): RuntimeSession {
  const capabilities = sessionCapabilities(options) ?? {};
  const randomControl = sessionRandomControl(options);
  const capturedPlan = captureOrReuseInstructionPlan(plan);
  if (!capturedPlan.validation.valid || capturedPlan.plan === null) {
    throw new RuntimeDataError(
      "TSR100",
      capturedPlan.validation.errors[0]?.message ?? "Malformed instruction plan.",
    );
  }
  const validPlan = capturedPlan.plan;
  // A host's tagged snapshot is external data: each part is read once, and only text is used.
  const given = typeof tagged === "object" && tagged !== null;
  const json: unknown = given ? tagged.json : undefined;
  const tag: unknown = given ? tagged.tag : undefined;
  if (typeof json !== "string") {
    throw new RuntimeDataError(
      "TSR101",
      "A tagged runtime snapshot must give its JSON as a string.",
    );
  }
  if (typeof tag === "string" && hasSnapshotTag(validPlan, json, tag)) {
    // EVIDENCE: invariant: the tag proves that a session of this plan wrote this JSON of its validated state.
    const state = JSON.parse(json) as RuntimeSnapshot;
    return new RuntimeSession(
      CREATE,
      validPlan,
      withFrozenTemporalCaptures(state),
      capabilities,
      sessionRandomPolicy(validPlan, randomControl, capabilities),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RuntimeDataError("TSR101", `Runtime snapshot JSON is invalid: ${message}`);
  }
  // EVIDENCE: invariant: captureExecutableData captures and completely validates `parsed` as external data.
  const captured = captureExecutableData(validPlan, parsed as RuntimeSnapshot);
  return new RuntimeSession(
    CREATE,
    captured.plan,
    captured.snapshot,
    capabilities,
    sessionRandomPolicy(captured.plan, randomControl, capabilities),
  );
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
  const randomPolicy = sessionRandomPolicy(
    capturedPlan.plan,
    sessionRandomControl(options),
    capabilities,
  );
  const state = createFreshRuntimeSnapshotWithValidatedPlan(capturedPlan.plan, fresh);
  return new RuntimeSession(
    CREATE,
    capturedPlan.plan,
    withFrozenTemporalCaptures(state),
    capabilities,
    randomPolicy,
  );
}

/** A session that continues a checkpoint, which `restoreCheckpoint` captures and completely validates. */
export function restoreRuntimeSession(
  checkpoint: unknown,
  options: RuntimeSessionOptions = {},
): RuntimeSession {
  const capabilities = sessionCapabilities(options) ?? {};
  const randomControl = sessionRandomControl(options);
  return adoptCheckpoint(restoreCheckpoint(checkpoint), capabilities, randomControl);
}

/** A session that continues checkpoint JSON, which `deserializeCheckpoint` parses and completely validates. */
export function deserializeRuntimeSession(
  json: string,
  options: RuntimeSessionOptions = {},
): RuntimeSession {
  const capabilities = sessionCapabilities(options) ?? {};
  const randomControl = sessionRandomControl(options);
  return adoptCheckpoint(deserializeCheckpoint(json), capabilities, randomControl);
}

/** The restored checkpoint was created by this restore, so no caller holds its snapshot. */
function adoptCheckpoint(
  checkpoint: RuntimeCheckpoint,
  capabilities: RuntimeCapabilities,
  randomControl: RandomControlOptions | null,
): RuntimeSession {
  return new RuntimeSession(
    CREATE,
    checkpoint.plan,
    checkpoint.snapshot,
    capabilities,
    sessionRandomPolicy(checkpoint.plan, randomControl, capabilities),
  );
}

/** A deeply frozen copy of plain engine output, so that nothing a session publishes shares an object with its state. */
function published<T>(value: T): T {
  return copyPlainData(value, "publish");
}
