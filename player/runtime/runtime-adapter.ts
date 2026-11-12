import {
  CHECKPOINT_FORMAT,
  CHECKPOINT_VERSION,
  createFreshRuntimeSession,
  deserializeRuntimeSession,
  restoreRuntimeSession,
  RuntimeSessionError,
  serializeCheckpoint,
  type ActionCompletionOutcome,
  type ContinueCaptureOutcome,
  type DebugModeOutcome,
  type ExternalStorageEditOutcome,
  type InstructionPlan,
  type InterpreterEvent,
  type MediaLoadReport,
  type MediaPlaybackProjection,
  type MediaProgressReport,
  type MediaReportOutcome,
  type StageProjection,
  type PermanentButtonPressOutcome,
  type PermanentButtonProjection,
  type PresentationSettings,
  type UnreadablePackageFile,
  type RuntimeInteractionActionSnapshot,
  type CapturedMediaAdmission,
  type CaptureUnavailableReason,
  type RuntimeLockNotice,
  type RuntimeScriptStorageEntrySnapshot,
  type RuntimeSession,
  type RuntimeSessionCall,
  type RuntimeSessionResult,
  type RuntimeSessionVariablePreviews,
  type RuntimeSessionView,
  type RuntimeSnapshot,
  type SerializableRuntimeValue,
  type TemporalContext,
  type TimeObservationOutcome,
  type InteractionUpdateOutcome,
  type RandomControlOptions,
  type RandomDrawRequest,
  type RandomDrawResolutionOutcome,
  textSha256,
} from "../../src/playback.js";
import type { ProjectImageFile, ProjectSourceFile } from "../../src/index.js";
import {
  activeInteraction,
  appendTranscript,
  choiceOptionId,
  DEFAULT_SPEAKERS,
  nextPlayerRuntimeCatchUpStepMs,
  nextPlayerRuntimeEventMs,
  playerRuntimeAwaitsHost,
  playerRuntimePacingGate,
  type PlayerSessionView,
} from "./runtime-view.js";
import type { RuntimeChatPacingGateActionSnapshot } from "../../src/runtime/actions/model.js";
import { routeComposerText } from "../../src/interaction-completion.js";

import type { RuntimePlayerProfileInput } from "../../src/runtime/host-data/player-profile.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint.js";

import type { MessagePresentation } from "../../src/message-presentation.js";
import type { DebugAnswerInput } from "../debug/debug-export.js";
import type { DebugRecorder } from "../debug/debug-recorder.js";
import type { RuntimeDebugContext } from "../../src/runtime/debug/debug-trace.js";
import type {
  PlayerSpeakerPresentation,
  PlayerTranscriptEntryPresentation,
} from "../presentation/model.js";

/**
 * What one publication of a session shows: the engine's operational view with the Stage, media, permanent buttons,
 * active calls, and date and time presentation, as detached, frozen data that later operations never change.
 */
export interface PlayerRuntimeState extends RuntimeSessionView {
  readonly stage: StageProjection;
  readonly media: readonly MediaPlaybackProjection[];
  readonly permanentButtons: readonly PermanentButtonProjection[];
  readonly calls: readonly RuntimeSessionCall[];
  readonly temporalPresentation: PresentationSettings;
  /** How the player's answer shows if it completes now, which the Player's predicted line takes. */
  readonly answerPresentation: MessagePresentation;
}

export interface PlayerRuntimeSession extends PlayerSessionView {
  /** The engine's side keeps the full state, active calls included; a publication carries the critical view. */
  readonly state: PlayerRuntimeState;
  readonly plan: InstructionPlan;
  /** The engine-owned runner of the session; only this adapter's functions operate it. */
  readonly engine: PlayerRuntimeEngine;
  /** Records the session's engine calls for a debug export; it never changes them. */
  readonly recorder: DebugRecorder | null;
  /**
   * The host's opt-in value trace, which every engine call of the session receives (`docs/RUNTIME.md#debug-trace`); it
   * never changes them and is in no snapshot, checkpoint, restore point, or recorded call. `null` when Debug is off.
   */
  readonly debugTrace: RuntimeDebugContext | null;
}

/** A publication as its engine reads it. */
type PlayerRuntimePublication = Pick<PlayerRuntimeSession, "revision" | "recorder">;

/**
 * The engine-owned runtime session behind a Player session's publications (`docs/RUNTIME.md#runtime-sessions`). Every
 * operation goes through a publication that shows the current state: once an operation changed the state, one made from
 * an earlier publication throws. When an engine call throws, the runtime session ends; the next use rebuilds the state
 * of the latest publication from the calls the session's debug recorder logged, so the session continues where the
 * Player showed it, as it did before the call. Without a recorder, or when its log does not reach that publication, the
 * original error is thrown again. A call cannot start while another runs, such as from a random decision it reaches.
 * A late observation may catch up on a copy of the runner, which the session adopts as its runner or drops; any use of
 * the session's own runner drops it.
 */
export class PlayerRuntimeEngine {
  #runtime: RuntimeSession;
  /** The latest publication. */
  #revision: number;
  /** The first publication that shows the current state; it and every later one share it. */
  #current: number;
  #thrown: { readonly error: unknown } | null = null;
  /** Which random draws the host decides or pauses at, which a rebuilt runner takes over. */
  #randomControl: RandomControlOptions | null = null;
  /** Whether a call runs; the runner is busy then, so a call it reaches would only throw and end it. */
  #calling = false;
  /**
   * A copy of the runner that a late observation catches up on (`beginPlayerRuntimeCatchUp`), the state it copied, and
   * the recorder that logs its calls; `null` without one. Any use of the session's own runner drops it.
   */
  #copy: {
    readonly runtime: RuntimeSession;
    readonly from: number;
    readonly recorder: DebugRecorder | null;
  } | null = null;

  public constructor(runtime: RuntimeSession, revision: number) {
    this.#runtime = runtime;
    this.#revision = revision;
    this.#current = revision;
  }

  /** Whether an operation made from publication `revision` may run, as `runtimeAt` decides. */
  accepts(revision: number): boolean {
    return revision >= this.#current && revision <= this.#revision;
  }

  /** Whether a call threw since the runner was last built: the next use rebuilds it, or throws that error again. */
  get broken(): boolean {
    return this.#thrown !== null;
  }

  /** The runner for publication `at`, rebuilt from its recorder after a call threw. */
  runtimeAt(at: PlayerRuntimePublication): RuntimeSession {
    if (at.revision < this.#current || at.revision > this.#revision)
      throw new Error("This Player session was replaced by a newer one; use the latest.");
    if (this.#thrown === null) return this.#runtime;
    const rebuilt = at.recorder?.recover(this, this.#revision) ?? null;
    if (rebuilt === null) throw this.#thrown.error;
    rebuilt.setRandomControl(this.#randomControl);
    this.#runtime = rebuilt;
    this.#thrown = null;
    return rebuilt;
  }

  /** Makes one engine call on publication `at`'s runner, through its recorder when there is one. */
  call<
    R extends {
      readonly events: RuntimeSessionResult["events"];
      readonly outcome?: { readonly kind: string };
    },
  >(
    at: PlayerRuntimePublication,
    kind: Parameters<DebugRecorder["call"]>[1],
    args: readonly unknown[],
    invoke: (
      runtime: RuntimeSession,
      admission: (store: CapturedMediaAdmission) => CapturedMediaAdmission,
    ) => R,
    continuation = false,
  ): R {
    if (this.#calling)
      throw new RuntimeSessionError(
        "A Player session call cannot start while another call of the same session runs.",
      );
    this.#dropCopy();
    const runtime = this.runtimeAt(at);
    this.#calling = true;
    try {
      if (at.recorder === null) return invoke(runtime, (store) => store);
      return at.recorder.call(
        this,
        kind,
        () => runtime.exportTrustedSnapshot(),
        args,
        (admission) => {
          const result = invoke(runtime, admission);
          const view = runtime.view();
          return {
            ...result,
            status: view.status,
            failure: view.failure,
            pausedAt: view.randomDraw?.drawId ?? null,
          };
        },
        continuation,
      );
    } catch (error) {
      if (ended(runtime)) this.#thrown = { error };
      throw error;
    } finally {
      this.#calling = false;
    }
  }

  /**
   * Publishes what the session shows after the calls made through publication `from`, as the next revision; `changed`
   * says whether those calls may have changed the state, which ends the use of earlier publications.
   */
  publish(
    from: PlayerRuntimePublication,
    changed = true,
  ): { readonly revision: number; readonly state: PlayerRuntimeState } {
    this.#dropCopy();
    const runtime = this.runtimeAt(from);
    this.#revision += 1;
    if (changed) this.#current = this.#revision;
    from.recorder?.published(this, this.#revision);
    return { revision: this.#revision, state: shownState(runtime) };
  }

  /** What publication `at` shows, read again. */
  stateAt(at: PlayerRuntimePublication): PlayerRuntimeState {
    return shownState(this.runtimeAt(at));
  }

  /** The complete state of publication `at`, freshly exported and validated. */
  exportSnapshot(at: PlayerRuntimePublication): RuntimeSnapshot {
    return this.runtimeAt(at).exportSnapshot();
  }

  /**
   * The complete state of publication `at` as the runtime session's trusted export: the same JSON as `exportSnapshot`,
   * copied without capture and validation, for a snapshot the Player keeps itself and restores only through validation.
   */
  exportTrustedSnapshot(at: PlayerRuntimePublication): RuntimeSnapshot {
    return this.runtimeAt(at).exportTrustedSnapshot();
  }

  /** A self-contained checkpoint of publication `at`, freshly exported and validated. */
  exportCheckpoint(at: PlayerRuntimePublication) {
    return this.runtimeAt(at).exportCheckpoint();
  }

  /** Publication `at`'s variables with bounded previews, for Debug. */
  variablePreviews(at: PlayerRuntimePublication): RuntimeSessionVariablePreviews {
    return this.runtimeAt(at).variablePreviews();
  }

  /** Changes which random draws the host decides or pauses at, for publication `at`'s runner and any rebuilt later. */
  setRandomControl(at: PlayerRuntimePublication, randomControl: RandomControlOptions | null): void {
    this.#dropCopy();
    this.runtimeAt(at).setRandomControl(randomControl);
    this.#randomControl = randomControl;
  }

  /**
   * Starts `recorder`'s recording at publication `at`, whose state is the latest publication's. The recorder keeps its
   * anchors as trusted exports, which a debug export checkpoints and a rebuild restores; the state at the end or at a
   * failure it takes checked, so a state the session cannot export leaves the recording incomplete.
   */
  beginRecording(
    at: PlayerRuntimePublication,
    plan: InstructionPlan,
    recorder: DebugRecorder,
  ): void {
    this.#dropCopy();
    recorder.begin(
      plan,
      this.exportTrustedSnapshot(at),
      () => this.#runtime.exportSnapshot(),
      this,
      this.#revision,
    );
  }

  /**
   * A copy of publication `at`'s runner for a late observation to catch up on; the session's own runner stays as it is.
   * The recorder logs the copy's calls as the session's until the session adopts the copy or drops it.
   */
  copy(at: PlayerRuntimePublication): RuntimeSession {
    const runtime = this.runtimeAt(at).fork();
    this.#dropCopy();
    this.#copy = { runtime, from: this.#current, recorder: at.recorder };
    at.recorder?.stage(this, () => runtime.exportSnapshot());
    return runtime;
  }

  /**
   * Makes one engine call on copy `runtime`, logged as a call of the session; `null` once the copy was dropped. A call
   * that throws drops the copy, and the session stays as it was.
   */
  callCopy<R extends RuntimeSessionResult & { readonly outcome?: { readonly kind: string } }>(
    runtime: RuntimeSession,
    kind: Parameters<DebugRecorder["call"]>[1],
    args: readonly unknown[],
    invoke: (runtime: RuntimeSession) => R,
    continuation = false,
  ): R | null {
    const copy = this.#copy;
    if (copy?.runtime !== runtime) return null;
    if (this.#calling)
      throw new RuntimeSessionError(
        "A Player session call cannot start while another call of the same session runs.",
      );
    this.#calling = true;
    try {
      if (copy.recorder === null) return invoke(runtime);
      return copy.recorder.call(
        this,
        kind,
        () => runtime.exportTrustedSnapshot(),
        args,
        () => {
          const result = invoke(runtime);
          const view = runtime.view();
          return {
            ...result,
            status: view.status,
            failure: view.failure,
            pausedAt: view.randomDraw?.drawId ?? null,
          };
        },
        continuation,
      );
    } catch (error) {
      this.#dropCopy();
      throw error;
    } finally {
      this.#calling = false;
    }
  }

  /** What copy `runtime` shows now, or `null` once it was dropped. */
  copyView(runtime: RuntimeSession): RuntimeSessionView | null {
    return this.#copy?.runtime === runtime ? runtime.view() : null;
  }

  /**
   * Makes copy `runtime` the session's runner after publication `at`, if nothing used the session's own runner since it
   * was copied; its logged calls become the session's. `false` when the copy was dropped.
   */
  adopt(at: PlayerRuntimePublication, runtime: RuntimeSession): boolean {
    const copy = this.#copy;
    if (copy?.runtime !== runtime) return false;
    if (this.#current !== copy.from) {
      this.#dropCopy();
      return false;
    }
    this.runtimeAt(at);
    this.#copy = null;
    this.#runtime = runtime;
    copy.recorder?.commit(this);
    return true;
  }

  /** Drops copy `runtime`, if it is still the session's copy. */
  drop(runtime: RuntimeSession): void {
    if (this.#copy?.runtime === runtime) this.#dropCopy();
  }

  #dropCopy(): void {
    const copy = this.#copy;
    if (copy === null) return;
    this.#copy = null;
    copy.recorder?.rollback(this);
  }
}

/** What a session shows, as detached, frozen data. */
function shownState(runtime: RuntimeSession): PlayerRuntimeState {
  return Object.freeze({
    ...runtime.view(),
    stage: runtime.stageProjection(),
    media: runtime.mediaPlaybackProjection(),
    permanentButtons: runtime.permanentButtonProjection(),
    calls: runtime.callStack(),
    temporalPresentation: runtime.temporalPresentation(),
    answerPresentation: runtime.answerPresentation(),
  });
}

/**
 * Whether `runtime` can no longer be read, as after one of its operations threw; one that refused malformed arguments
 * stays readable.
 */
function ended(runtime: RuntimeSession): boolean {
  try {
    runtime.view();
    return false;
  } catch {
    return true;
  }
}

export interface PlayerRuntimeSessionOptions {
  /** The script's stored values from the host's storage provider. */
  readonly scriptStorage?: readonly RuntimeScriptStorageEntrySnapshot[];
  /**
   * Whether the host persists script storage. Then every `save` and `delete` waits until the host reports the write
   * through `completePlayerRuntimeStorageWrite`; otherwise storage is session-local.
   */
  readonly persistentScriptStorage?: boolean;
  /** The player's zone and date and time presentation, captured when the session starts. */
  readonly temporalContext?: TemporalContext;
  /** The UTC wall clock when the session starts, in epoch milliseconds. */
  readonly wallClockMs?: number;
  /** Records the session's engine calls, from before its first run, for a debug export. */
  readonly recorder?: DebugRecorder;
  /** Traces the session from Start; the trace begins a new epoch. */
  readonly debugTrace?: RuntimeDebugContext;
  /** Whether the session starts in Debug, which the script reads as `debugMode`; `false` by default. */
  readonly debugMode?: boolean;
  /** Which random draws the host decides or pauses at from Start (`docs/RUNTIME.md#controlled-randomness`). */
  readonly randomControl?: RandomControlOptions;
  /** The references of the stored files the stored values hold, which the host's file store vouches for (V30 §33). */
  readonly storedFiles?: readonly string[];
  /** The player's person fields, which the script reads as `playerProfile` (V30 §37); none by default. */
  readonly playerProfile?: RuntimePlayerProfileInput;
}

/** Runtime checkpoint plus an in-memory presentation cache; only checkpointJson is canonical save data. */
export interface PlayerRuntimeRestorePoint {
  readonly checkpointJson: string;
  readonly events: readonly InterpreterEvent[];
}

export interface PlayerRuntimeControlResult<
  T = ActionCompletionOutcome | TimeObservationOutcome | InteractionUpdateOutcome,
> {
  readonly session: PlayerRuntimeSession;
  readonly outcome: T;
}

/**
 * The `.tease` files of a package, its images, and the files the host could not load; a session starts at the top of
 * `main.tease` (ADR 0022).
 */
export interface PlayerProject {
  readonly files: readonly ProjectSourceFile[];
  /** The package images that tag queries search; none by default. */
  readonly images?: readonly ProjectImageFile[];
  /** The package files and folders the host could not load, which compiling reports; none by default. */
  readonly unreadableFiles?: readonly UnreadablePackageFile[];
}

/** A diagnostic as the Player lists it: the file or image it belongs to, its one-based line and column, its message. */
export interface PlayerScriptDiagnostic {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly severity: "error" | "warning" | "info";
  readonly code: string;
  readonly message: string;
}

/** The plan of a script, or `null` when it does not compile; with every diagnostic of its files and images. */
export interface PlayerCompilation {
  readonly plan: InstructionPlan | null;
  readonly diagnostics: readonly PlayerScriptDiagnostic[];
}

/** Starts a session of a plan; `compile-project.ts` starts one of a script's source. */
export function createPlayerRuntimeSession(
  plan: InstructionPlan,
  options: PlayerRuntimeSessionOptions = {},
): PlayerRuntimeSession {
  const runtime = createFreshRuntimeSession(plan, {
    ...(options.scriptStorage === undefined ? {} : { scriptStorage: options.scriptStorage }),
    persistentScriptStorage: options.persistentScriptStorage ?? false,
    ...(options.temporalContext === undefined ? {} : { temporalContext: options.temporalContext }),
    ...(options.wallClockMs === undefined ? {} : { wallClockMs: options.wallClockMs }),
    ...(options.debugMode === undefined ? {} : { debugMode: options.debugMode }),
    ...(options.storedFiles === undefined ? {} : { storedFiles: options.storedFiles }),
    ...(options.playerProfile === undefined ? {} : { playerProfile: options.playerProfile }),
  });
  const recorder = options.recorder ?? null;
  const debugTrace = options.debugTrace ?? null;
  debugTrace?.reset("start");
  const session = emptySession(runtime.plan, runtime, recorder, debugTrace);
  if (recorder !== null) session.engine.beginRecording(session, session.plan, recorder);
  if (options.randomControl !== undefined)
    session.engine.setRandomControl(session, options.randomControl);
  const operation = session.engine.call(session, "run", [{}], (current) =>
    current.run(traceOptions(debugTrace)),
  );
  return publish(appendRuntimeEvents(session, operation.events));
}

export function createPlayerRuntimeRestorePoint(
  session: PlayerRuntimeSession,
): PlayerRuntimeRestorePoint {
  return Object.freeze({
    checkpointJson: serializeCheckpoint(session.engine.exportCheckpoint(session)),
    events: Object.freeze([...session.events]),
  });
}

/** Restores `restorePoint`, whose checkpoint is parsed and validated once, as `deserializeCheckpoint` does. */
export function restorePlayerRuntimeSession(
  restorePoint: PlayerRuntimeRestorePoint,
  recorder: DebugRecorder | null = null,
  debugTrace: RuntimeDebugContext | null = null,
): PlayerRuntimeSession {
  return restoredSession(
    deserializeRuntimeSession(restorePoint.checkpointJson),
    restorePoint.events,
    recorder,
    debugTrace,
  );
}

/**
 * The session's complete state, freshly exported and validated: a snapshot a debug export or storage adoption keeps. It
 * costs work in proportion to the whole state, so ordinary presentation reads `state` instead.
 */
export function playerRuntimeSnapshot(session: PlayerRuntimeSession): RuntimeSnapshot {
  return session.engine.exportSnapshot(session);
}

/** `playerRuntimeSnapshot`, or `null` when the session's state cannot be read, such as after a call threw. */
export function playerRuntimeSnapshotOrNull(session: PlayerRuntimeSession): RuntimeSnapshot | null {
  try {
    return playerRuntimeSnapshot(session);
  } catch {
    return null;
  }
}

/**
 * The session's state as JSON, the same as `playerRuntimeSnapshot`'s, written from the trusted export without capture
 * and validation: for the Player's own saves, its kept session and Debug's rewind history, which are validated when they
 * are restored (`restorePlayerRuntimeSessionAt`).
 */
export function playerRuntimeSnapshotJson(session: PlayerRuntimeSession): string {
  return serializeValidatedRuntimeJson(session.engine.exportTrustedSnapshot(session));
}

/**
 * What Debug's Variables view lists for the session: its variables with bounded previews, read now, and its active
 * calls.
 */
export function playerRuntimeDebugVariables(session: PlayerRuntimeSession): {
  readonly variables: RuntimeSessionVariablePreviews;
  readonly calls: readonly RuntimeSessionCall[];
} {
  return Object.freeze({
    variables: session.engine.variablePreviews(session),
    calls: session.state.calls,
  });
}

/** Starts `recorder`'s recording at the session as it stands, such as a restored session that continues. */
export function beginPlayerRuntimeRecording(
  session: PlayerRuntimeSession,
  recorder: DebugRecorder,
): void {
  session.engine.beginRecording(session, session.plan, recorder);
}

/**
 * Restores a kept state, such as Debug's rewind history position or the kept session that Continue resumes: the state
 * `snapshotJson` holds, captured and validated once against `plan` as `restoreCheckpoint` does, with the transcript
 * rebuilt from the `events` that led to it. Nothing runs; the recorder and the value trace begin anew there.
 */
export function restorePlayerRuntimeSessionAt(
  plan: InstructionPlan,
  snapshotJson: string,
  events: readonly InterpreterEvent[],
  recorder: DebugRecorder | null = null,
  debugTrace: RuntimeDebugContext | null = null,
): PlayerRuntimeSession {
  const runtime = restoreRuntimeSession({
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    plan,
    snapshot: JSON.parse(snapshotJson),
  });
  return restoredSession(runtime, events, recorder, debugTrace);
}

/**
 * A session continuing `runtime`, which the engine's restore just created from the state it validated, so the state is
 * not validated again; its recording and value trace begin anew there, and nothing runs.
 */
function restoredSession(
  runtime: RuntimeSession,
  events: readonly InterpreterEvent[],
  recorder: DebugRecorder | null,
  debugTrace: RuntimeDebugContext | null,
): PlayerRuntimeSession {
  const session = emptySession(
    runtime.plan,
    runtime,
    recorder,
    debugTrace,
    runtime.view().nextEventSequence,
  );
  if (recorder !== null) session.engine.beginRecording(session, session.plan, recorder);
  // Restored values are trustworthy, but their history is not part of the checkpoint.
  debugTrace?.reset("restore");
  return publish(appendRuntimeEvents(session, events));
}

/**
 * The session with Debug's value trace turned on (`context`) or off (`null`). A trace turned on mid-session attaches
 * at its next operation, so values from before read as not recorded.
 */
export function withPlayerRuntimeDebugTrace(
  session: PlayerRuntimeSession,
  context: RuntimeDebugContext | null,
): PlayerRuntimeSession {
  return session.debugTrace === context
    ? session
    : Object.freeze({ ...session, debugTrace: context });
}

/**
 * Runs `answer`, an operation on `session`, so that its debug recording keeps `input` as how the player gave the
 * answer (DEBUGGER.md "Debug export").
 */
export function answeredByPlayerInput<T>(
  session: PlayerRuntimeSession,
  input: DebugAnswerInput,
  answer: () => T,
): T {
  return session.recorder === null ? answer() : session.recorder.answeredBy(input, answer);
}

/** How the Player answers a pending `takePhoto()`. */
export type PlayerCaptureAnswer =
  | { readonly kind: "captured"; readonly reference: string }
  | { readonly kind: "unavailable"; readonly reason: CaptureUnavailableReason };

/**
 * Answers a pending capture and continues on success. A captured reference is accepted only when `capturedMedia`
 * vouches for it. On `executionPending` the host runs the session and offers the same answer again.
 */
export function answerPlayerRuntimeCapture(
  session: PlayerRuntimeSession,
  actionId: number,
  answer: PlayerCaptureAnswer,
  capturedMedia?: CapturedMediaAdmission,
): PlayerRuntimeControlResult<ActionCompletionOutcome> {
  const payload =
    answer.kind === "captured"
      ? { kind: "captured", media: { kind: "image", reference: answer.reference } }
      : { kind: "unavailable", reason: answer.reason };
  const request = { actionId, actionKind: "capture", payload };
  const operation = session.engine.call(
    session,
    "completeAction",
    [request],
    (runtime, admission) =>
      runtime.completeAction(
        request,
        capturedMedia === undefined
          ? traceOptions(session.debugTrace)
          : { ...traceOptions(session.debugTrace), capturedMedia: admission(capturedMedia) },
      ),
  );
  return Object.freeze({
    session: applyOperation(session, operation, "completed"),
    outcome: operation.outcome,
  });
}

/**
 * The Player's answer to a file store: the stored files' references, the read files' Base64, the hashed files' SHA-256
 * as 64 lowercase hexadecimal digits, or a failure.
 */
export type PlayerFileStoreAnswer =
  | { readonly kind: "stored"; readonly references: readonly string[] }
  | { readonly kind: "read"; readonly files: readonly string[] }
  | { readonly kind: "hashed"; readonly hashes: readonly string[] }
  | { readonly kind: "failed" };

/**
 * Answers a pending file store and continues on success. A stored file's reference is accepted only when
 * `capturedMedia` vouches for it. On `executionPending` the host runs the session and offers the same answer again.
 */
export function answerPlayerRuntimeFileStore(
  session: PlayerRuntimeSession,
  actionId: number,
  answer: PlayerFileStoreAnswer,
  capturedMedia?: CapturedMediaAdmission,
): PlayerRuntimeControlResult<ActionCompletionOutcome> {
  const request = { actionId, actionKind: "fileStore", payload: answer };
  const operation = session.engine.call(
    session,
    "completeAction",
    [request],
    (runtime, admission) =>
      runtime.completeAction(
        request,
        capturedMedia === undefined
          ? traceOptions(session.debugTrace)
          : { ...traceOptions(session.debugTrace), capturedMedia: admission(capturedMedia) },
      ),
  );
  return Object.freeze({
    session: applyOperation(session, operation, "completed"),
    outcome: operation.outcome,
  });
}

/**
 * The Player's answer to a lock step (V30 §13): a lock as Base64 or a locked stored file, an opened text or file of its
 * type, that it did not open, that it failed, or that it must ask the player; or the dialog's submission or cancel.
 */
export type PlayerLockAnswer =
  | { readonly kind: "locked"; readonly text: string }
  | { readonly kind: "locked"; readonly file: string }
  | { readonly kind: "opened"; readonly text: string }
  | { readonly kind: "opened"; readonly file: string; readonly type: string }
  | { readonly kind: "notOpened" }
  | { readonly kind: "failed"; readonly reason: "unreadable" | "unavailable" }
  | { readonly kind: "ask"; readonly notice?: RuntimeLockNotice }
  | { readonly kind: "submitted" }
  | { readonly kind: "cancelled" };

/**
 * Answers a pending lock step and continues on success. A stored file is accepted only when `capturedMedia` vouches for
 * it. On `executionPending` the host runs the session and offers the same answer again.
 */
export function answerPlayerRuntimeLock(
  session: PlayerRuntimeSession,
  actionId: number,
  answer: PlayerLockAnswer,
  capturedMedia?: CapturedMediaAdmission,
): PlayerRuntimeControlResult<ActionCompletionOutcome> {
  const request = { actionId, actionKind: "lock", payload: answer };
  const operation = session.engine.call(
    session,
    "completeAction",
    [request],
    (runtime, admission) =>
      runtime.completeAction(
        request,
        capturedMedia === undefined
          ? traceOptions(session.debugTrace)
          : { ...traceOptions(session.debugTrace), capturedMedia: admission(capturedMedia) },
      ),
  );
  return Object.freeze({
    session: applyOperation(session, operation, "completed"),
    outcome: operation.outcome,
  });
}

function actionRequest(
  action: RuntimeInteractionActionSnapshot | RuntimeChatPacingGateActionSnapshot,
  payload: Record<string, unknown>,
) {
  return {
    actionId: action.actionId,
    actionKind: action.kind,
    ...(action.kind === "interaction" ? { interactionKind: action.interactionKind } : {}),
    payload,
  };
}

export function submitPlayerRuntimeComposer(
  session: PlayerRuntimeSession,
  submittedText: string,
): PlayerRuntimeControlResult<ActionCompletionOutcome | InteractionUpdateOutcome> | null {
  const action = activeInteraction(session.state);
  const route = routeComposerText(action, submittedText);
  if (route === null || action === null) return null;
  switch (route.kind) {
    case "complete":
      return completePlayerAction(session, action, { ...route.payload });
    // A password is answered with the SHA-256 of what was typed, as hashText gives it; the text itself goes nowhere.
    case "password":
      return completePlayerAction(session, action, {
        kind: "submittedPassword",
        hash: textSha256(route.text),
      });
    case "imageSkip":
      return skipPlayerRuntimeImage(session);
    case "formCommit":
      return commitPlayerRuntimeFormField(session, route.text);
    case "formSubmit":
      return submitPlayerRuntimeForm(session);
    case "formCancel":
      return cancelPlayerRuntimeForm(session);
    case "formStep":
      return stepPlayerRuntimeFormField(session, route.fieldId);
  }
}

/**
 * Answers the pending `askImage` with an image the trusted store holds, and continues on success. The runtime accepts
 * only a reference `capturedMedia` vouches for.
 */
export function answerPlayerRuntimeImage(
  session: PlayerRuntimeSession,
  reference: string,
  capturedMedia: CapturedMediaAdmission,
): PlayerRuntimeControlResult<ActionCompletionOutcome> | null {
  const action = activeInteraction(session.state);
  if (action?.ui.kind !== "image") return null;
  const request = {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "image",
    payload: { kind: "image", reference },
  };
  const operation = session.engine.call(
    session,
    "completeAction",
    [request],
    (runtime, admission) =>
      runtime.completeAction(request, {
        ...traceOptions(session.debugTrace),
        capturedMedia: admission(capturedMedia),
      }),
  );
  return Object.freeze({
    session: applyOperation(session, operation, "completed"),
    outcome: operation.outcome,
  });
}

type FormControlResult = PlayerRuntimeControlResult<
  InteractionUpdateOutcome | ActionCompletionOutcome
>;

/**
 * Brings the form's draft up to the composer's text before another edit, so the edit commits what the player typed.
 * Returns the refusal when the draft is not taken, or the session to continue with.
 */
function withComposerDraft(
  session: PlayerRuntimeSession,
  draft: string | undefined,
): { readonly session: PlayerRuntimeSession } | FormControlResult {
  const action = activeInteraction(session.state);
  const editor = action?.form?.editor ?? null;
  if (action === null || editor === null || draft === undefined || draft === editor.text)
    return { session };
  const result = updatePlayerRuntimeForm(session, action, {
    kind: "draft",
    fieldId: editor.fieldId,
    text: draft,
  });
  return result.outcome.kind === "updated" || result.outcome.kind === "unchanged"
    ? { session: result.session }
    : result;
}

/** Runs `next` on the session after the composer's draft is taken, or returns the draft's refusal. */
function afterDraft(
  session: PlayerRuntimeSession,
  draft: string | undefined,
  next: (session: PlayerRuntimeSession) => FormControlResult | null,
): FormControlResult | null {
  const drafted = withComposerDraft(session, draft);
  return "outcome" in drafted ? drafted : next(drafted.session);
}

/**
 * Advances a form field one step: a toggle switches, a cycle shows its next option, wrapping around, and a typed field
 * opens in the composer. Each edit names what it selects, so a repeated report changes nothing more. `draft` is the
 * composer's text, which the field being edited takes first.
 */
export function stepPlayerRuntimeFormField(
  session: PlayerRuntimeSession,
  fieldId: string,
  draft?: string,
): FormControlResult | null {
  return afterDraft(session, draft, (current) => {
    const action = activeInteraction(current.state);
    if (action?.ui.kind !== "form" || action.form === undefined) return null;
    const index = action.ui.fields.findIndex((field) => field.id === fieldId);
    const field = action.ui.fields[index];
    const value = action.form.values[index];
    if (field === undefined) return null;
    if (field.kind !== "boolean" && field.kind !== "cycle")
      return updatePlayerRuntimeForm(current, action, { kind: "edit", fieldId });
    let optionIndex: number;
    if (field.kind === "cycle" && typeof value === "number")
      optionIndex = (value + 1) % field.options.length;
    else if (field.kind === "boolean" && typeof value === "boolean")
      optionIndex =
        field.options === null
          ? value
            ? 0
            : 1
          : field.options.findIndex((option) => option.value === !value);
    else return null;
    return updatePlayerRuntimeForm(current, action, { kind: "select", fieldId, optionIndex });
  });
}

/** Commits the composer's text as the edited field's value; blank text unsets an optional field. */
export function commitPlayerRuntimeFormField(
  session: PlayerRuntimeSession,
  draft: string,
): FormControlResult | null {
  return afterDraft(session, draft, (current) => {
    const action = activeInteraction(current.state);
    const editor = action?.form?.editor ?? null;
    if (action === null || editor === null) return null;
    return updatePlayerRuntimeForm(current, action, { kind: "commit", fieldId: editor.fieldId });
  });
}

/** Back or Escape: closes the composer's field and drops its text, keeping the field's value. */
export function dismissPlayerRuntimeFormField(
  session: PlayerRuntimeSession,
): FormControlResult | null {
  const action = activeInteraction(session.state);
  const editor = action?.form?.editor ?? null;
  if (action === null || editor === null) return null;
  return updatePlayerRuntimeForm(session, action, { kind: "dismiss", fieldId: editor.fieldId });
}

/** Clear: leaves the edited optional field without a value. */
export function clearPlayerRuntimeFormField(
  session: PlayerRuntimeSession,
): FormControlResult | null {
  const action = activeInteraction(session.state);
  const editor = action?.form?.editor ?? null;
  if (action === null || editor === null) return null;
  return updatePlayerRuntimeForm(session, action, { kind: "clear", fieldId: editor.fieldId });
}

/**
 * Keeps the form's draft equal to the composer's text, so a checkpoint or debug export holds what was typed. The text
 * belongs to one action's field: while another form or field is presented, such as one a block opened, nothing changes.
 */
export function draftPlayerRuntimeForm(
  session: PlayerRuntimeSession,
  target: { readonly actionId: number; readonly fieldId: string },
  draft: string,
): FormControlResult | null {
  const action = activeInteraction(session.state);
  const editor = action?.form?.editor ?? null;
  if (
    action === null ||
    editor === null ||
    action.actionId !== target.actionId ||
    editor.fieldId !== target.fieldId ||
    draft === editor.text
  )
    return null;
  return updatePlayerRuntimeForm(session, action, {
    kind: "draft",
    fieldId: editor.fieldId,
    text: draft,
  });
}

/** Submits the pending form with its answers, after the composer's draft, then continues the session. */
export function submitPlayerRuntimeForm(
  session: PlayerRuntimeSession,
  draft?: string,
): FormControlResult | null {
  return afterDraft(session, draft, (current) => {
    const action = activeInteraction(current.state);
    if (action?.ui.kind !== "form") return null;
    return completePlayerAction(current, action, { kind: "submit" });
  });
}

/** Cancels the whole form, dropping every edit and the text being typed; the form returns `null`. */
export function cancelPlayerRuntimeForm(session: PlayerRuntimeSession): FormControlResult | null {
  const action = activeInteraction(session.state);
  if (action?.ui.kind !== "form" || action.ui.cancel === null) return null;
  return completePlayerAction(session, action, { kind: "cancel" });
}

function updatePlayerRuntimeForm(
  session: PlayerRuntimeSession,
  action: RuntimeInteractionActionSnapshot,
  update: Record<string, unknown>,
): PlayerRuntimeControlResult<InteractionUpdateOutcome> {
  const request = {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "form",
    update,
  };
  const operation = session.engine.call(session, "updateInteraction", [request], (runtime) =>
    runtime.updateInteraction(request, traceOptions(session.debugTrace)),
  );
  return Object.freeze({
    session: applyOperation(session, operation, null),
    outcome: operation.outcome,
  });
}

/** Skips the pending `askImage` written with `allowSkip: true`, which answers `null`, and continues on success. */
export function skipPlayerRuntimeImage(
  session: PlayerRuntimeSession,
): PlayerRuntimeControlResult<ActionCompletionOutcome> | null {
  const action = activeInteraction(session.state);
  if (action?.ui.kind !== "image" || !action.ui.allowSkip) return null;
  return completePlayerAction(session, action, { kind: "skip" });
}

/** Reports that the Player opened the presented `openUrl`'s address in a new tab, which continues the script. */
export function openPlayerRuntimeUrl(
  session: PlayerRuntimeSession,
): PlayerRuntimeControlResult<ActionCompletionOutcome> | null {
  const action = activeInteraction(session.state);
  if (action?.interactionKind !== "url") return null;
  return completePlayerAction(session, action, { kind: "opened" });
}

/** Closes the presented popup, which continues the script. */
export function closePlayerRuntimePopup(
  session: PlayerRuntimeSession,
): PlayerRuntimeControlResult<ActionCompletionOutcome> | null {
  const action = activeInteraction(session.state);
  if (action?.interactionKind !== "popup") return null;
  return completePlayerAction(session, action, { kind: "activate" });
}

/** Closes the presented `exportText` dialog, which continues the script; copying and downloading leave it open. */
export function closePlayerRuntimeExport(
  session: PlayerRuntimeSession,
): PlayerRuntimeControlResult<ActionCompletionOutcome> | null {
  const action = activeInteraction(session.state);
  if (action?.interactionKind !== "export") return null;
  return completePlayerAction(session, action, { kind: "close" });
}

export function activatePlayerRuntimeButton(
  session: PlayerRuntimeSession,
): PlayerRuntimeControlResult<ActionCompletionOutcome> | null {
  const action = activeInteraction(session.state);
  if (action?.interactionKind !== "button") return null;
  return completePlayerAction(session, action, { kind: "activate" });
}

export function selectPlayerRuntimeChoice(
  session: PlayerRuntimeSession,
  optionId: string,
): PlayerRuntimeControlResult<ActionCompletionOutcome> | null {
  const action = activeInteraction(session.state);
  if (action?.interactionKind !== "choice" || action.ui.kind !== "choice") return null;
  const optionIndex = action.ui.options.findIndex(
    (_option, index) => choiceOptionId(action.actionId, index) === optionId,
  );
  if (optionIndex === -1) return null;
  return completePlayerAction(session, action, { kind: "selectedOption", optionIndex });
}

export function skipPlayerRuntimePacing(
  session: PlayerRuntimeSession,
): PlayerRuntimeControlResult<ActionCompletionOutcome> | null {
  const action = playerRuntimePacingGate(session);
  if (action === null) return null;
  return completePlayerAction(session, action, { kind: "skip" });
}

/**
 * Records the wall clock and the player's zone and presentation when a restored session continues, then runs it as
 * Start does, so a ready session resumes without waiting for an observation. The capture applies from the session's
 * observed time on; call it before the scene clock resumes.
 */
export function continuePlayerRuntimeSession(
  session: PlayerRuntimeSession,
  capture: { readonly wallClockMs: number; readonly temporalContext: TemporalContext },
): PlayerRuntimeControlResult<ContinueCaptureOutcome> {
  const operation = session.engine.call(session, "recordContinueCapture", [capture], (runtime) =>
    runtime.recordContinueCapture(capture, traceOptions(session.debugTrace)),
  );
  return Object.freeze({
    session: applyOperation(session, operation, "recorded"),
    outcome: operation.outcome,
  });
}

/**
 * Observes scene time and the playback progress of the running media the Player plays. Include a report for every
 * running media: an omitted report means no progress since its last one.
 */
export function observePlayerRuntimeTime(
  session: PlayerRuntimeSession,
  currentSessionTimeMs: number,
  mediaReports: readonly MediaProgressReport[] = [],
): PlayerRuntimeControlResult<TimeObservationOutcome> {
  const operation = session.engine.call(
    session,
    "observeTime",
    [currentSessionTimeMs, mediaReports],
    (runtime) =>
      runtime.observeTime(currentSessionTimeMs, mediaReports, traceOptions(session.debugTrace)),
  );
  // A settlement or a queued timer expiry block may make execution eligible; `run` returns at once otherwise.
  return Object.freeze({
    session: applyOperation(session, operation, "observed"),
    outcome: operation.outcome,
  });
}

/**
 * One step of a development time jump (#615) toward `targetMs`: an ordinary observation at the next timed event as
 * `nextPlayerRuntimeEventMs` finds it, or at `targetMs` when that comes first, with running loaded media playing on
 * at 1×. Returns the session itself once time reached the target, or while `playerRuntimeAwaitsHost`.
 */
export function stepPlayerRuntimeTime(
  session: PlayerRuntimeSession,
  targetMs: number,
): PlayerRuntimeSession {
  const { state } = session;
  if (state.observedSessionTimeMs >= targetMs || playerRuntimeAwaitsHost(state)) return session;
  const stepMs = Math.min(targetMs, nextPlayerRuntimeEventMs(state) ?? targetMs);
  const result = observePlayerRuntimeTime(session, stepMs, playingMediaReports(state, stepMs));
  return result.outcome.kind === "observed" ? result.session : session;
}

/**
 * Development time jump (#615): advances scene time to `targetMs` in steps of `stepPlayerRuntimeTime`. Blocks,
 * timeouts and continuations therefore run in scene-time order, and a block's change to playback or its request to
 * the host applies before later events, exactly as when the Player observes each event on time; a session with jumps
 * is a normal session. The jump stops early while `playerRuntimeAwaitsHost`; call it again once the host answered.
 */
export function advancePlayerRuntimeTime(
  session: PlayerRuntimeSession,
  targetMs: number,
): PlayerRuntimeSession {
  let current = session;
  for (let next = stepPlayerRuntimeTime(current, targetMs); next !== current;) {
    current = next;
    next = stepPlayerRuntimeTime(current, targetMs);
  }
  return current;
}

/**
 * A late observation of scene time `targetMs`, caught up in steps on a copy of a session's runner: the session itself
 * stays as it is and publishes nothing of the catch-up until it adopts the copy (`adoptPlayerRuntimeCatchUp`). Any
 * operation on the session meanwhile, such as input, drops the copy. The copy is the session's engine's.
 */
export interface PlayerRuntimeCatchUp {
  readonly targetMs: number;
  /** The copy, which only this adapter's functions operate. */
  readonly runtime: RuntimeSession;
  readonly engine: PlayerRuntimeEngine;
  /** The events of its steps, which the session shows once it adopts the copy. */
  readonly events: InterpreterEvent[];
}

/** Starts catching up `session` to scene time `targetMs` on a copy of its runner. */
export function beginPlayerRuntimeCatchUp(
  session: PlayerRuntimeSession,
  targetMs: number,
): PlayerRuntimeCatchUp {
  return Object.freeze({
    targetMs,
    runtime: session.engine.copy(session),
    engine: session.engine,
    events: [],
  });
}

/**
 * Catches up in steps: an ordinary observation without media progress at each next timed event before the target,
 * then at the target, each followed by the run it makes eligible, as `observePlayerRuntimeTime` does. After each step it
 * goes on while `more()` holds. The steps give exactly the result of one observation of the target without media
 * progress, as any observation schedule does (`docs/RUNTIME.md#timers-and-scene-time`); a media event becomes due only
 * through progress reports, so it is no step. Once a `save`, `delete`, or `takePhoto()` waits for the host, the rest is
 * that one observation at once, so the host's answer comes at the scene time it gives; a random draw that pauses ends
 * the catch-up. `"done"` when the copy is ready to adopt, `"dropped"` when it is gone, such as after an operation on the
 * session, a step that failed the script before the target, or one that threw, which the session itself then repeats.
 */
export function stepPlayerRuntimeCatchUp(
  catchUp: PlayerRuntimeCatchUp,
  more: () => boolean,
): "more" | "done" | "dropped" {
  const { engine, runtime, targetMs, events } = catchUp;
  try {
    for (;;) {
      const state = engine.copyView(runtime);
      if (state === null) return "dropped";
      if (state.observedSessionTimeMs >= targetMs || state.randomDraw !== null) return "done";
      // A failure stands where one observation of the target stands it, with all of it observed: the session repeats
      // it, so its debug recording also keeps that state.
      if (state.status === "failed") {
        engine.drop(runtime);
        return "dropped";
      }
      const nextMs = nextPlayerRuntimeCatchUpStepMs(state);
      const stepMs = nextMs !== null && nextMs < targetMs ? nextMs : targetMs;
      const observed = engine.callCopy(runtime, "observeTime", [stepMs, []], (copy) =>
        copy.observeTime(stepMs, []),
      );
      if (observed === null) return "dropped";
      for (const event of observed.events) events.push(event);
      if (observed.outcome.kind !== "observed") return "done";
      const ran = engine.callCopy(runtime, "run", [{}], (copy) => copy.run(), true);
      if (ran === null) return "dropped";
      for (const event of ran.events) events.push(event);
      const after = engine.copyView(runtime);
      if (after !== null && !playerRuntimeAwaitsHost(after) && !more()) return "more";
    }
  } catch {
    // The copy ended with the call that threw; the same observation on the session itself meets the same error.
    return "dropped";
  }
}

/**
 * The session after it adopts the copy of `catchUp` in one publication, with the events of its steps; `null` when the
 * copy was dropped, such as after an operation on the session since it was copied.
 */
export function adoptPlayerRuntimeCatchUp(
  session: PlayerRuntimeSession,
  catchUp: PlayerRuntimeCatchUp,
): PlayerRuntimeSession | null {
  if (session.engine !== catchUp.engine || !session.engine.adopt(session, catchUp.runtime))
    return null;
  return publish(appendRuntimeEvents(session, catchUp.events));
}

/** Drops the copy of `catchUp`; the session stays as it is. */
export function dropPlayerRuntimeCatchUp(catchUp: PlayerRuntimeCatchUp): void {
  catchUp.engine.drop(catchUp.runtime);
}

/** Progress of every running loaded media at scene time `atMs`, playing on at 1× from its last sample. */
function playingMediaReports(state: PlayerRuntimeState, atMs: number): MediaProgressReport[] {
  const reports: MediaProgressReport[] = [];
  for (const action of state.backgroundActions) {
    if (action.kind !== "media" || action.media.state !== "running" || !action.media.loaded)
      continue;
    const last = action.media.points.at(-1)!;
    if (atMs > last.atMs)
      reports.push({
        mediaId: action.media.mediaId,
        segment: action.media.segment,
        progressMs: last.progressMs + (atMs - last.atMs),
      });
  }
  return reports;
}

/** Reports whether the Player could load a media source, and its duration when it could. */
export function reportPlayerRuntimeMediaLoad(
  session: PlayerRuntimeSession,
  mediaId: number,
  report: MediaLoadReport,
): PlayerRuntimeControlResult<MediaReportOutcome> {
  const operation = session.engine.call(session, "reportMediaLoad", [mediaId, report], (runtime) =>
    runtime.reportMediaLoad(mediaId, report, traceOptions(session.debugTrace)),
  );
  return Object.freeze({
    session: applyOperation(session, operation, "accepted"),
    outcome: operation.outcome,
  });
}

/**
 * Applies a debugging tool's edit of one script-storage key to the session's view (`applyExternalStorageEdit`):
 * `value: null` removes the key. It runs no instruction, so nothing continues; the host persists the edit first.
 */
export function applyPlayerRuntimeStorageEdit(
  session: PlayerRuntimeSession,
  edit: { readonly key: string; readonly value: SerializableRuntimeValue },
): PlayerRuntimeControlResult<ExternalStorageEditOutcome> {
  const operation = session.engine.call(session, "applyExternalStorageEdit", [edit], (runtime) =>
    runtime.applyExternalStorageEdit(edit, traceOptions(session.debugTrace)),
  );
  return Object.freeze({
    session: applyOperation(session, operation, null),
    outcome: operation.outcome,
  });
}

/** Sets what the script's `debugMode` reads from now on; it runs nothing. */
export function setPlayerRuntimeDebugMode(
  session: PlayerRuntimeSession,
  enabled: boolean,
): PlayerRuntimeControlResult<DebugModeOutcome> {
  const operation = session.engine.call(session, "setDebugMode", [enabled], (runtime) =>
    runtime.setDebugMode(enabled, traceOptions(session.debugTrace)),
  );
  return Object.freeze({
    session: applyOperation(session, operation, null),
    outcome: operation.outcome,
  });
}

/** Clicks a permanent button, then runs the session, which starts the button's block. */
export function pressPlayerRuntimePermanentButton(
  session: PlayerRuntimeSession,
  buttonId: number,
): PlayerRuntimeControlResult<PermanentButtonPressOutcome> {
  const operation = session.engine.call(session, "pressPermanentButton", [buttonId], (runtime) =>
    runtime.pressPermanentButton(buttonId, traceOptions(session.debugTrace)),
  );
  return Object.freeze({
    session: applyOperation(session, operation, "pressed"),
    outcome: operation.outcome,
  });
}

/**
 * Changes which random draws the host decides or pauses at (`docs/RUNTIME.md#controlled-randomness`); `null` leaves
 * every draw natural. It changes no state; a draw already paused stays paused.
 */
export function setPlayerRuntimeRandomControl(
  session: PlayerRuntimeSession,
  randomControl: RandomControlOptions | null,
): void {
  session.engine.setRandomControl(session, randomControl);
}

/**
 * Resolves the random draw the session is paused at, naturally or with a chosen outcome, and finishes the engine call
 * it interrupted.
 */
export function resumePlayerRuntimeRandomDraw(
  session: PlayerRuntimeSession,
  request: RandomDrawRequest,
): PlayerRuntimeControlResult<RandomDrawResolutionOutcome> {
  const operation = session.engine.call(session, "resumeRandomDraw", [request], (runtime) =>
    runtime.resumeRandomDraw(request, traceOptions(session.debugTrace)),
  );
  // A resolved draw may leave the script runnable, as when it paused a time observation.
  return Object.freeze({
    session: applyOperation(session, operation, "resolved"),
    outcome: operation.outcome,
  });
}

function completePlayerAction(
  session: PlayerRuntimeSession,
  action: RuntimeInteractionActionSnapshot | RuntimeChatPacingGateActionSnapshot,
  payload: Record<string, unknown>,
): PlayerRuntimeControlResult<ActionCompletionOutcome> {
  const request = actionRequest(action, payload);
  const operation = session.engine.call(session, "completeAction", [request], (runtime) =>
    runtime.completeAction(request, traceOptions(session.debugTrace)),
  );
  return Object.freeze({
    session: applyOperation(session, operation, "completed"),
    outcome: operation.outcome,
  });
}

/**
 * Reports whether the host persisted a pending write, then continues execution. A failed write keeps the previous
 * value and the runtime reports warning TSW014. A report for a write that is no longer pending changes nothing.
 */
export function completePlayerRuntimeStorageWrite(
  session: PlayerRuntimeSession,
  actionId: number,
  stored: boolean,
): PlayerRuntimeControlResult<ActionCompletionOutcome> {
  const request = {
    actionId,
    actionKind: "storageWrite",
    payload: { kind: stored ? "stored" : "failed" },
  };
  const operation = session.engine.call(session, "completeAction", [request], (runtime) =>
    runtime.completeAction(request, traceOptions(session.debugTrace)),
  );
  return Object.freeze({
    session: applyOperation(session, operation, "completed"),
    outcome: operation.outcome,
  });
}

/**
 * Publishes one runtime operation; when its outcome is `continueOn`, the run that the operation makes eligible follows
 * it first.
 */
function applyOperation(
  session: PlayerRuntimeSession,
  operation: RuntimeSessionResult & { readonly outcome: { readonly kind: string } },
  continueOn: string | null,
): PlayerRuntimeSession {
  if (operation.outcome.kind !== continueOn)
    return publish(
      appendRuntimeEvents(session, operation.events),
      !REFUSALS.has(operation.outcome.kind),
    );
  // The continuation runs on the same engine-owned state before anything publishes. It returns at once when nothing is
  // runnable. The operation's events are presented only once it ran: when it throws, the session goes on from the
  // publication before the operation, which never showed them.
  const continuation = session.engine.call(
    session,
    "run",
    [{}],
    (runtime) => runtime.run(traceOptions(session.debugTrace)),
    true,
  );
  const next = appendRuntimeEvents(session, operation.events);
  return publish(appendRuntimeEvents(next, continuation.events));
}

/**
 * The outcomes of a refused operation, which changes nothing (`docs/RUNTIME.md#runtime-sessions`), so that earlier
 * publications stay usable after it; any other outcome may have changed the state.
 */
const REFUSALS: ReadonlySet<string> = new Set<
  | ActionCompletionOutcome["kind"]
  | TimeObservationOutcome["kind"]
  | InteractionUpdateOutcome["kind"]
  | ContinueCaptureOutcome["kind"]
  | MediaReportOutcome["kind"]
  | ExternalStorageEditOutcome["kind"]
  | PermanentButtonPressOutcome["kind"]
  | RandomDrawResolutionOutcome["kind"]
  | DebugModeOutcome["kind"]
>([
  "alreadySettled",
  "staleAction",
  "unknownAction",
  "suspendedAction",
  "wrongActionKind",
  "invalidPayload",
  "executionPending",
  "invalidObservation",
  "unchanged",
  "invalidCapture",
  "ignored",
  "unknownMedia",
  "invalidReport",
  "invalidEdit",
  "invalidRequest",
  "invalidState",
  "storageWritePending",
  "busy",
  "removedButton",
  "unknownButton",
  "randomDrawPending",
  "noPendingDraw",
  "staleDraw",
  "invalidOutcome",
]);

/** The next publication of the session: a new revision with what it shows now. */
function publish(session: PlayerRuntimeSession, changed = true): PlayerRuntimeSession {
  return Object.freeze({ ...session, ...session.engine.publish(session, changed) });
}

/** A session over `runtime` before its first publication, revision 0. */
function emptySession(
  plan: InstructionPlan,
  runtime: RuntimeSession,
  recorder: DebugRecorder | null,
  debugTrace: RuntimeDebugContext | null,
  liveEventSequence = 0,
): PlayerRuntimeSession {
  const engine = new PlayerRuntimeEngine(runtime, 0);
  return Object.freeze({
    plan,
    engine,
    revision: 0,
    state: engine.stateAt({ revision: 0, recorder: null }),
    liveEventSequence,
    recorder,
    debugTrace,
    events: [],
    transcriptEntries: [],
    transcriptMessageRows: new Map(),
    transcriptRemovedRows: [],
    transcriptRevision: 0,
    speakers: { ...DEFAULT_SPEAKERS },
  });
}

function appendRuntimeEvents(
  session: PlayerRuntimeSession,
  events: readonly InterpreterEvent[],
): PlayerRuntimeSession {
  if (events.length === 0) return Object.freeze(session);
  // EVIDENCE: emptySession creates an unfrozen adapter-owned speaker accumulator for every session.
  const speakers = session.speakers as Record<string, PlayerSpeakerPresentation>;
  // EVIDENCE: emptySession creates an unfrozen adapter-owned event accumulator for every session.
  const retainedEvents = session.events as InterpreterEvent[];
  // EVIDENCE: emptySession creates an unfrozen adapter-owned transcript accumulator for every session.
  const transcriptEntries = session.transcriptEntries as PlayerTranscriptEntryPresentation[];
  // EVIDENCE: emptySession creates an unfrozen adapter-owned transcript index for every session.
  const messageRows = session.transcriptMessageRows as Map<number, number>;
  // EVIDENCE: emptySession creates an unfrozen adapter-owned list of removed rows for every session.
  const removedRows = session.transcriptRemovedRows as number[];
  for (const event of events) retainedEvents.push(event);
  appendTranscript(transcriptEntries, messageRows, removedRows, speakers, events);
  return Object.freeze({
    ...session,
    events: retainedEvents,
    transcriptEntries,
    transcriptRevision: session.transcriptRevision + 1,
    speakers,
  });
}

const NO_TRACE = Object.freeze({});

/** The engine options that pass the session's value trace, or none while Debug is off. */
function traceOptions(debugTrace: RuntimeDebugContext | null): {
  readonly debugTrace?: RuntimeDebugContext;
} {
  return debugTrace === null ? NO_TRACE : { debugTrace };
}
