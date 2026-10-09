import {
  CHECKPOINT_FORMAT,
  CHECKPOINT_VERSION,
  captureTemporalContext,
  compileProject,
  completeAction,
  createFreshRuntimeSession,
  createRuntimeSession,
  DEFAULT_TEMPORAL_CONTEXT,
  deserializeCheckpoint,
  interactionDeadlineMs,
  MAIN_FILE_PATH,
  restoreCheckpoint,
  serializeCheckpoint,
  type ActionCompletionOutcome,
  type ContinueCaptureOutcome,
  type DebugModeOutcome,
  type ExternalStorageEditOutcome,
  type InstructionPlan,
  type InteractionAccessibleName,
  type InterpreterEvent,
  type MediaLoadReport,
  type MediaPlaybackProjection,
  type MediaProgressReport,
  type MediaReportOutcome,
  type StageProjection,
  type PendingActionOperationResult,
  type PermanentButtonPressOutcome,
  type PermanentButtonProjection,
  type PresentationSettings,
  type ProjectImageFile,
  type ProjectSourceFile,
  type RuntimeInteractionActionSnapshot,
  type CapturedMediaAdmission,
  type CaptureUnavailableReason,
  type RuntimeCaptureActionSnapshot,
  type RuntimeScriptStorageEntrySnapshot,
  type RuntimeSession,
  type RuntimeSessionCall,
  type RuntimeSessionResult,
  type RuntimeSessionVariablePreviews,
  type RuntimeSessionView,
  type RuntimeSnapshot,
  type RuntimeStorageWriteActionSnapshot,
  type SerializableRuntimeValue,
  type TemporalContext,
  type TimeObservationOutcome,
  type InteractionUpdateOutcome,
  type RandomControlOptions,
  type RandomDrawRequest,
  type RandomDrawResolutionOutcome,
} from "../src/index.js";
import type { RuntimeChatPacingGateActionSnapshot } from "../src/runtime/actions/model.js";
import { formValueText } from "../src/interaction-answers.js";
import { formSummaryOf, type FormSummaryLine } from "../src/runtime/actions/form.js";
import { instructionSourcePath } from "../src/plan/model.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/checkpoint.js";
import {
  mediaTerminalProgressMs,
  nextMediaEvent,
  repeatsSilently,
  type RuntimeMediaSnapshot,
} from "../src/runtime/media.js";
import type { RuntimeTimerSnapshot } from "../src/runtime/timers.js";
import type { DebugRecorder } from "./debug-recorder.js";
import type { RuntimeDebugContext } from "../src/runtime/debug-trace.js";
import type {
  PlayerFormEditorPresentation,
  PlayerFormFieldPresentation,
  PlayerFormPresentation,
  PlayerForegroundPresentation,
  PlayerMessagePresentation,
  PlayerPermanentButtonPresentation,
  PlayerTimerPresentation,
  PlayerSpeakerPresentation,
  PlayerTranscriptEntryPresentation,
} from "./model.js";

const DEFAULT_SPEAKERS: Readonly<Record<string, PlayerSpeakerPresentation>> = Object.freeze({
  narrator: Object.freeze({
    name: "Narrator",
    accent: "#9a867d",
    avatar: "N",
    fontFamily: "inherit",
  }),
  user: Object.freeze({ name: "You", accent: "#8fa3ab", avatar: "Y", fontFamily: "inherit" }),
});

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
}

export interface PlayerRuntimeSession {
  readonly plan: InstructionPlan;
  /** The engine-owned runner of the session; only this adapter's functions operate it. */
  readonly engine: PlayerRuntimeEngine;
  /**
   * Counts the session's publications: every operation publishes a new revision, also one that changed nothing, and also
   * when the host keeps an earlier one. A publication stays usable until an operation changes the state; from then on
   * only later ones are.
   */
  readonly revision: number;
  /** What this publication shows; see `PlayerRuntimeState`. */
  readonly state: PlayerRuntimeState;
  readonly events: readonly InterpreterEvent[];
  readonly transcriptEntries: readonly PlayerTranscriptEntryPresentation[];
  /** By the sequence of the event that created it, the index of each script message in `transcriptEntries`. */
  readonly transcriptMessageRows: ReadonlyMap<number, number>;
  readonly transcriptRevision: number;
  readonly speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
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
 * original error is thrown again.
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

  public constructor(runtime: RuntimeSession, revision: number) {
    this.#runtime = runtime;
    this.#revision = revision;
    this.#current = revision;
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
    const runtime = this.runtimeAt(at);
    try {
      if (at.recorder === null) return invoke(runtime, (store) => store);
      return at.recorder.call(
        this,
        kind,
        () => runtime.exportSnapshot(),
        args,
        (admission) => {
          const result = invoke(runtime, admission);
          const view = runtime.view();
          return { ...result, status: view.status, pausedAt: view.randomDraw?.drawId ?? null };
        },
        continuation,
      );
    } catch (error) {
      if (ended(runtime)) this.#thrown = { error };
      throw error;
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

  /** A self-contained checkpoint of publication `at`, freshly exported and validated. */
  exportCheckpoint(at: PlayerRuntimePublication) {
    return this.runtimeAt(at).exportCheckpoint();
  }

  /** The date and time presentation in force at publication `at`. */
  temporalPresentation(at: PlayerRuntimePublication): PresentationSettings {
    return this.runtimeAt(at).temporalPresentation();
  }

  /** Publication `at`'s variables with bounded previews, for Debug. */
  variablePreviews(at: PlayerRuntimePublication): RuntimeSessionVariablePreviews {
    return this.runtimeAt(at).variablePreviews();
  }

  /** Changes which random draws the host decides or pauses at, for publication `at`'s runner and any rebuilt later. */
  setRandomControl(at: PlayerRuntimePublication, randomControl: RandomControlOptions | null): void {
    this.runtimeAt(at).setRandomControl(randomControl);
    this.#randomControl = randomControl;
  }

  /** Starts `recorder`'s recording at publication `at`, whose state is the latest publication's. */
  beginRecording(
    at: PlayerRuntimePublication,
    plan: InstructionPlan,
    recorder: DebugRecorder,
  ): void {
    recorder.begin(
      plan,
      this.exportSnapshot(at),
      () => this.#runtime.exportSnapshot(),
      this,
      this.#revision,
    );
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
}

/**
 * Captures the player's time zone and date and time presentation for a new session: the account settings when the host
 * has them, else the browser's. A setting this browser cannot use falls back to the browser's own, and then to UTC and
 * locale-neutral text.
 */
export function playerTemporalContext(
  account: { readonly timeZone?: string; readonly locale?: string } = {},
): TemporalContext {
  const browser = Intl.DateTimeFormat().resolvedOptions();
  const locale = globalThis.navigator?.language ?? browser.locale;
  for (const [timeZone, language] of [
    [account.timeZone ?? browser.timeZone, account.locale ?? locale],
    [browser.timeZone, locale],
  ] as const) {
    try {
      return captureTemporalContext(timeZone, language);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return DEFAULT_TEMPORAL_CONTEXT;
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

/** The `.tease` files of a package and its images; a session starts at the top of `main.tease` (ADR 0022). */
export interface PlayerProject {
  readonly files: readonly ProjectSourceFile[];
  /** The package images that tag queries search; none by default. */
  readonly images?: readonly ProjectImageFile[];
}

/** A diagnostic as the Player lists it: the file or image it belongs to, its one-based line and column, its message. */
export interface PlayerScriptDiagnostic {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
}

/** The plan of a script, or `null` when it does not compile; with every diagnostic of its files and images. */
export interface PlayerCompilation {
  readonly plan: InstructionPlan | null;
  readonly diagnostics: readonly PlayerScriptDiagnostic[];
}

/** Compiles a project, or a single source as the `main.tease` of a one-file project, without running it. */
export function compilePlayerProject(script: string | PlayerProject): PlayerCompilation {
  const project =
    typeof script === "string" ? { files: [{ path: MAIN_FILE_PATH, source: script }] } : script;
  const compilation = compileProject(
    project.files,
    project.images === undefined ? {} : { images: project.images },
  );
  return Object.freeze({
    plan: compilation.plan,
    diagnostics: Object.freeze(
      compilation.diagnostics.map((diagnostic) =>
        Object.freeze({
          path: diagnostic.path,
          line: diagnostic.span.start.line + 1,
          column: diagnostic.span.start.column + 1,
          severity: diagnostic.severity,
          code: diagnostic.code,
          message: diagnostic.message,
        }),
      ),
    ),
  });
}

/**
 * Starts a session of a script: a project, a single source as the `main.tease` of a one-file project, or the plan
 * `compilePlayerProject` made of one. A script that does not compile throws with its first error.
 */
export function createPlayerRuntimeSession(
  script: string | PlayerProject | InstructionPlan,
  options: PlayerRuntimeSessionOptions = {},
): PlayerRuntimeSession {
  const plan = isInstructionPlan(script) ? script : compiledPlan(script);
  const runtime = createFreshRuntimeSession(plan, {
    ...(options.scriptStorage === undefined ? {} : { scriptStorage: options.scriptStorage }),
    persistentScriptStorage: options.persistentScriptStorage ?? false,
    ...(options.temporalContext === undefined ? {} : { temporalContext: options.temporalContext }),
    ...(options.wallClockMs === undefined ? {} : { wallClockMs: options.wallClockMs }),
    ...(options.debugMode === undefined ? {} : { debugMode: options.debugMode }),
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

function isInstructionPlan(
  script: string | PlayerProject | InstructionPlan,
): script is InstructionPlan {
  return typeof script !== "string" && "instructions" in script;
}

function compiledPlan(script: string | PlayerProject): InstructionPlan {
  const compilation = compilePlayerProject(script);
  if (compilation.plan !== null) return compilation.plan;
  const error = compilation.diagnostics.find((diagnostic) => diagnostic.severity === "error");
  throw new Error(
    error === undefined
      ? "The script did not compile."
      : `${error.path}:${error.line}:${error.column}: ${error.message}`,
  );
}

export function createPlayerRuntimeRestorePoint(
  session: PlayerRuntimeSession,
): PlayerRuntimeRestorePoint {
  return Object.freeze({
    checkpointJson: serializeCheckpoint(session.engine.exportCheckpoint(session)),
    events: Object.freeze([...session.events]),
  });
}

export function restorePlayerRuntimeSession(
  restorePoint: PlayerRuntimeRestorePoint,
  recorder: DebugRecorder | null = null,
  debugTrace: RuntimeDebugContext | null = null,
): PlayerRuntimeSession {
  const checkpoint = deserializeCheckpoint(restorePoint.checkpointJson);
  return restoredSession(
    checkpoint.plan,
    checkpoint.snapshot,
    restorePoint.events,
    recorder,
    debugTrace,
  );
}

/**
 * The session's complete state, freshly exported and validated: a snapshot a debug export, rewind position, or storage
 * adoption keeps. It costs work in proportion to the whole state, so ordinary presentation reads `state` instead.
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

/** The session's state as JSON, validated first, for Debug's rewind history to keep. */
export function playerRuntimeSnapshotJson(session: PlayerRuntimeSession): string {
  return serializeValidatedRuntimeJson(playerRuntimeSnapshot(session));
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
 * Restores Debug's rewind history position: the state `snapshotJson` holds, validated against `plan`, with the
 * transcript rebuilt from the `events` that led to it. Nothing runs; the recorder and the value trace begin anew there.
 */
export function restorePlayerRuntimeSessionAt(
  plan: InstructionPlan,
  snapshotJson: string,
  events: readonly InterpreterEvent[],
  recorder: DebugRecorder | null = null,
  debugTrace: RuntimeDebugContext | null = null,
): PlayerRuntimeSession {
  const checkpoint = restoreCheckpoint({
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    plan,
    snapshot: JSON.parse(snapshotJson),
  });
  return restoredSession(checkpoint.plan, checkpoint.snapshot, events, recorder, debugTrace);
}

/** A session continuing a validated `snapshot`, whose recording and value trace begin anew there; nothing runs. */
function restoredSession(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  events: readonly InterpreterEvent[],
  recorder: DebugRecorder | null,
  debugTrace: RuntimeDebugContext | null,
): PlayerRuntimeSession {
  const runtime = createRuntimeSession(plan, snapshot);
  const session = emptySession(runtime.plan, runtime, recorder, debugTrace);
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

export function playerRuntimeForeground(
  session: PlayerRuntimeSession,
): PlayerForegroundPresentation | null {
  const action = activeInteraction(session.state);
  if (action === null) return null;
  const accessibleName = interactionAccessibleName(action.ui.accessibleName);
  switch (action.ui.kind) {
    // The fields change with each edit; `playerRuntimeForm` presents them.
    case "form":
      return Object.freeze({
        kind: "form",
        accessibleName,
        hint: action.ui.hint ?? "Type your response…",
      });
    case "button":
      return Object.freeze({
        kind: "show-button",
        accessibleName,
        label: action.ui.buttonLabel,
        ...(action.ui.background === undefined ? {} : { authoredFill: action.ui.background }),
      });
    case "text":
      return Object.freeze({
        kind: "ask-text",
        accessibleName,
        hint: action.ui.hint ?? "Type your response…",
        ...(action.ui.prefill === undefined ? {} : { prefill: action.ui.prefill }),
      });
    case "number":
      return Object.freeze({
        kind: "ask-number",
        accessibleName,
        hint: action.ui.hint ?? "Type your response…",
        ...(action.ui.prefill === undefined ? {} : { prefill: action.ui.prefill }),
        ...(action.ui.integer === true ? { integer: true as const } : {}),
      });
    case "temporal":
      return Object.freeze({
        kind: `ask-${action.ui.temporalKind}` as const,
        accessibleName,
        hint: action.ui.hint ?? "",
        ...(action.ui.prefill === undefined ? {} : { prefill: action.ui.prefill }),
        // A native date control has no year 0000, so such a default is shown and edited as ISO text.
        ...(action.ui.prefill?.startsWith("0000") === true ? { isoText: true as const } : {}),
      });
    case "image":
      return Object.freeze({
        kind: "ask-image",
        accessibleName,
        hint: action.ui.hint ?? "",
        allowFile: action.ui.allowFile,
        allowCamera: action.ui.allowCamera,
        types: action.ui.types,
        mime: action.ui.mime,
      });
    case "choice": {
      const preselected = action.ui.preselected;
      return Object.freeze({
        kind: "choose",
        accessibleName,
        options: Object.freeze(
          action.ui.options.map((option, index) =>
            Object.freeze({
              id: choiceOptionId(action.actionId, index),
              label: option.text,
              ...(option.background === undefined ? {} : { authoredFill: option.background }),
              ...(index === preselected ? { preselected: true as const } : {}),
            }),
          ),
        ),
      });
    }
  }
}

/**
 * Visible and mystery timers at the Player's session-time estimate, in creation order: a blocking timer (also while
 * an expiry block interrupts it) and every running or paused async timer. Hidden timers and `wait` produce no entry,
 * and a settled timer disappears with its action. A paused timer shows its frozen remaining time.
 */
export function playerRuntimeTimers(
  state: PlayerRuntimeState,
  currentSessionTimeMs: number,
): readonly PlayerTimerPresentation[] {
  const now = Math.max(state.observedSessionTimeMs, currentSessionTimeMs);
  const timers: Array<PlayerTimerPresentation & { readonly actionId: number }> = [];
  const delays = [state.foregroundAction, state.suspendedAction];
  for (const action of delays) {
    if (action?.kind !== "delay" || action.display === "hidden") continue;
    timers.push({
      actionId: action.actionId,
      id: `runtime-timer-${action.actionId}`,
      kind: action.display,
      ...(action.label === null ? {} : { name: action.label }),
      remainingSeconds: Math.max(0, action.deadlineMs - now) / 1000,
      totalSeconds: (action.deadlineMs - action.createdAtMs) / 1000,
    });
  }
  for (const action of state.backgroundActions) {
    if (action.kind !== "timer") continue;
    const timer = action.timer;
    const display = timer.display;
    if (display === "hidden") continue;
    const remainingMs =
      timer.deadlineMs === null ? (timer.remainingMs ?? 0) : Math.max(0, timer.deadlineMs - now);
    timers.push({
      actionId: action.actionId,
      id: `runtime-timer-${action.actionId}`,
      kind: display,
      ...(timer.label === null ? {} : { name: timer.label }),
      remainingSeconds: remainingMs / 1000,
      totalSeconds: timer.roundDurationMs / 1000,
    });
  }
  return Object.freeze(
    timers
      .sort((left, right) => left.actionId - right.actionId)
      .map(({ actionId: _actionId, ...timer }) => Object.freeze(timer)),
  );
}

/** Session-time deadlines at which the Player must observe time again. A failed session settles nothing further. */
export function playerRuntimeDeadlines(state: PlayerRuntimeState): readonly number[] {
  return timedDeadlines(state, () => true);
}

function timedDeadlines(
  state: PlayerRuntimeState,
  timerCounts: (timer: RuntimeTimerSnapshot) => boolean,
): number[] {
  const deadlines: number[] = [];
  if (state.status === "failed") return deadlines;
  for (const action of [
    state.foregroundAction,
    ...state.backgroundActions,
    state.suspendedAction,
  ]) {
    if (action?.kind === "delay" || action?.kind === "chatPacingGate") {
      deadlines.push(action.deadlineMs);
    } else if (
      action?.kind === "timer" &&
      action.timer.deadlineMs !== null &&
      timerCounts(action.timer)
    ) {
      deadlines.push(action.timer.deadlineMs);
    }
  }
  // A button with a timeout times out only while it is presented; a suspended one waits for its block to return.
  const button = activePlayerRuntimeInteraction(state);
  const buttonDeadlineMs = button === null ? null : interactionDeadlineMs(button);
  if (buttonDeadlineMs !== null) deadlines.push(buttonDeadlineMs);
  return deadlines;
}

export function playerRuntimePacingGate(
  session: PlayerRuntimeSession,
): RuntimeChatPacingGateActionSnapshot | null {
  return activePlayerRuntimePacingGate(session.state);
}

export function activePlayerRuntimeInteraction(
  state: Pick<RuntimeSessionView, "foregroundAction">,
): RuntimeInteractionActionSnapshot | null {
  return state.foregroundAction?.kind === "interaction" ? state.foregroundAction : null;
}

export function activePlayerRuntimePacingGate(
  state: Pick<RuntimeSessionView, "status" | "foregroundAction" | "backgroundActions">,
): RuntimeChatPacingGateActionSnapshot | null {
  if (state.status === "failed") return null;
  const foreground = state.foregroundAction;
  if (foreground?.kind === "chatPacingGate") return foreground;
  return state.backgroundActions.find((action) => action.kind === "chatPacingGate") ?? null;
}

/** What a Debug countdown counts down to: a `wait`, a `showButton` timeout, or chat pacing. */
export interface PlayerRuntimeDebugCountdown {
  readonly kind: "wait" | "button" | "pacing";
  readonly deadlineMs: number;
}

/**
 * The deadline of the current foreground wait for Player Debug countdowns, from canonical state only: an authored
 * `wait` (not a blocking `timer`, which lowers to the same delay), a presented `showButton` with a timeout, or chat
 * pacing while no other foreground action owns progress or input. Suspended actions behind a running block never
 * count; that block's own foreground work does. A countdown ends only when its action settles or loses the foreground.
 */
export function playerRuntimeDebugCountdown(
  session: Pick<PlayerRuntimeSession, "plan" | "state">,
): PlayerRuntimeDebugCountdown | null {
  const { state: snapshot } = session;
  if (snapshot.status !== "running" && snapshot.status !== "waiting") return null;
  const foreground = snapshot.foregroundAction;
  let countdown: PlayerRuntimeDebugCountdown | null = null;
  if (foreground === null) {
    const gate = activePlayerRuntimePacingGate(snapshot);
    if (gate !== null) countdown = { kind: "pacing", deadlineMs: gate.deadlineMs };
  } else if (foreground.kind === "interaction") {
    const deadlineMs = interactionDeadlineMs(foreground);
    if (deadlineMs !== null) countdown = { kind: "button", deadlineMs };
  } else if (foreground.kind === "delay") {
    const owner = session.plan.instructions[foreground.owningInstruction];
    if (owner?.kind === "wait" && owner.command === "wait")
      countdown = { kind: "wait", deadlineMs: foreground.deadlineMs };
  } else if (foreground.kind === "chatPacingGate") {
    countdown = { kind: "pacing", deadlineMs: foreground.deadlineMs };
  }
  return countdown === null ? null : Object.freeze(countdown);
}

/** A script position as Player Debug shows it: the file's package path and its one-based line. */
export interface PlayerDebugSourceLocation {
  readonly path: string;
  readonly line: number;
}

/** What the foreground action waits for, as Player Debug names it. */
export type PlayerDebugWaitKind =
  | "wait"
  | "timer"
  | "button"
  | "choice"
  | "input"
  | "image"
  | "pacing"
  | "media"
  | "save"
  | "photo";

/** One active call, innermost first: a function, a called file, or a timer, media cue or permanent-button block. */
export interface PlayerDebugCall {
  readonly kind: "function" | "file" | "timer" | "media" | "button";
  /** The function or block name, or the called file's path. */
  readonly name: string;
  /** Where it was called, or for a block, the position it interrupted. */
  readonly from: PlayerDebugSourceLocation;
}

/** One timer of the session, hidden ones included. */
export interface PlayerDebugTimer {
  readonly actionId: number;
  /** A blocking `timer` runs in the foreground; an async timer in the background. */
  readonly blocking: boolean;
  readonly display: "hidden" | "visible" | "mystery";
  readonly label: string | null;
  readonly repeat: boolean;
  /** `suspended`: a blocking timer whose time runs on while a block interrupts it. */
  readonly state: "running" | "paused" | "suspended";
  readonly remainingMs: number;
  readonly startedAt: PlayerDebugSourceLocation;
}

/** One active audio or video instance, with the statement that started it. */
export interface PlayerDebugMedia {
  readonly mediaId: number;
  readonly media: "audio" | "video";
  readonly source: string;
  /** `false` until the Player reported its load. */
  readonly loaded: boolean;
  readonly state: "running" | "paused";
  readonly playheadMs: number;
  readonly startedAt: PlayerDebugSourceLocation;
}

/** Player Debug's view of where the session is, derived on demand from canonical state; see `playerRuntimeDebugNow`. */
export interface PlayerRuntimeDebugNow {
  /** Where execution continues, or `null` once the session ended or failed. */
  readonly next: PlayerDebugSourceLocation | null;
  /** The foreground action the script waits for and the statement that requested it. */
  readonly waitingAt: {
    readonly kind: PlayerDebugWaitKind;
    readonly at: PlayerDebugSourceLocation;
  } | null;
  readonly calls: readonly PlayerDebugCall[];
  readonly timers: readonly PlayerDebugTimer[];
  readonly media: readonly PlayerDebugMedia[];
}

function debugLocation(
  plan: InstructionPlan,
  instruction: number,
  line = plan.instructions[instruction]!.span.sl + 1,
): PlayerDebugSourceLocation {
  return Object.freeze({ path: instructionSourcePath(plan, instruction), line });
}

function debugWaitKind(
  plan: InstructionPlan,
  action: RuntimeSnapshot["foregroundAction"] & object,
) {
  switch (action.kind) {
    case "delay": {
      const owner = plan.instructions[action.owningInstruction];
      return owner?.kind === "wait" && owner.command === "wait" ? "wait" : "timer";
    }
    case "interaction":
      return action.interactionKind === "button" ||
        action.interactionKind === "choice" ||
        action.interactionKind === "image"
        ? action.interactionKind
        : "input";
    case "chatPacingGate":
      return "pacing";
    case "mediaPlayback":
      return "media";
    case "storageWrite":
      return "save";
    case "capture":
      return "photo";
  }
}

/**
 * The active calls, innermost first, also of a failed session, where they are the calls the error happened in. Work is
 * proportional to the call depth.
 */
export function playerRuntimeCalls(
  session: Pick<PlayerRuntimeSession, "plan" | "state">,
): readonly PlayerDebugCall[] {
  const { plan, state: snapshot } = session;
  // Each frame runs in the file that the next inner frame was called from, the innermost in the next statement's file.
  const calls: PlayerDebugCall[] = [];
  let runningIn = instructionSourcePath(plan, snapshot.nextInstruction);
  for (const call of [...snapshot.calls].reverse()) {
    const from =
      call.interruption === null
        ? debugLocation(plan, call.returnInstruction, call.callSiteSpan.start.line + 1)
        : debugLocation(plan, call.returnInstruction);
    calls.push(
      Object.freeze({
        kind: call.kind === "file" ? "file" : (call.interruption ?? "function"),
        name: call.kind === "file" ? runningIn : call.functionName,
        from,
      }),
    );
    runningIn = from.path;
  }
  return Object.freeze(calls);
}

/**
 * Where the session is, for Player Debug's Now view at display scene time `nowMs`: the next statement, the statement
 * whose foreground action it waits for, the active calls, every timer, hidden ones included, and the active media. Paths are package
 * paths, relative to the folder of the entry script. Read-only and derived on demand; it adds nothing to the session.
 */
export function playerRuntimeDebugNow(
  session: Pick<PlayerRuntimeSession, "plan" | "state">,
  nowMs: number,
): PlayerRuntimeDebugNow {
  const { plan, state: snapshot } = session;
  const now = Math.max(snapshot.observedSessionTimeMs, nowMs);
  const active = snapshot.status === "running" || snapshot.status === "waiting";
  const foreground = snapshot.foregroundAction;

  const timers: PlayerDebugTimer[] = [];
  const delays = [
    ...(foreground === null ? [] : [{ action: foreground, suspended: false }]),
    ...(snapshot.suspendedAction === null
      ? []
      : [{ action: snapshot.suspendedAction, suspended: true }]),
  ];
  for (const { action, suspended } of delays) {
    if (action.kind !== "delay" || debugWaitKind(plan, action) !== "timer") continue;
    timers.push({
      actionId: action.actionId,
      blocking: true,
      display: action.display,
      label: action.label,
      repeat: false,
      state: suspended ? "suspended" : "running",
      remainingMs: Math.max(0, action.deadlineMs - now),
      startedAt: debugLocation(plan, action.owningInstruction),
    });
  }
  for (const action of snapshot.backgroundActions) {
    if (action.kind !== "timer") continue;
    const timer = action.timer;
    timers.push({
      actionId: action.actionId,
      blocking: false,
      display: timer.display,
      label: timer.label,
      repeat: timer.repeat,
      state: timer.deadlineMs === null ? "paused" : "running",
      remainingMs:
        timer.deadlineMs === null ? (timer.remainingMs ?? 0) : Math.max(0, timer.deadlineMs - now),
      startedAt: debugLocation(plan, action.owningInstruction),
    });
  }

  const mediaOwners = new Map<number, number>();
  for (const action of snapshot.backgroundActions)
    if (action.kind === "media") mediaOwners.set(action.media.mediaId, action.owningInstruction);
  const media = snapshot.media.map((projection) =>
    Object.freeze({
      mediaId: projection.mediaId,
      media: projection.media,
      source: projection.source,
      loaded: projection.loaded,
      state: projection.state,
      playheadMs: projection.playheadMs,
      startedAt: debugLocation(plan, mediaOwners.get(projection.mediaId)!),
    }),
  );

  return Object.freeze({
    next: active ? debugLocation(plan, snapshot.nextInstruction) : null,
    waitingAt:
      active && foreground !== null
        ? Object.freeze({
            kind: debugWaitKind(plan, foreground),
            at: debugLocation(plan, foreground.owningInstruction),
          })
        : null,
    calls: active ? playerRuntimeCalls(session) : Object.freeze([]),
    timers: Object.freeze(
      active
        ? timers.sort((left, right) => left.actionId - right.actionId).map((t) => Object.freeze(t))
        : [],
    ),
    media: Object.freeze(active ? media : []),
  });
}

/** How the Player answers a pending `takePhoto()`. */
export type PlayerCaptureAnswer =
  | { readonly kind: "captured"; readonly reference: string }
  | { readonly kind: "unavailable"; readonly reason: CaptureUnavailableReason };

/** The pending `takePhoto()` the Player must answer, if any. */
export function activePlayerRuntimeCapture(
  state: PlayerRuntimeState,
): RuntimeCaptureActionSnapshot | null {
  const action = state.status === "waiting" ? state.foregroundAction : null;
  return action?.kind === "capture" ? action : null;
}

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

export function completePlayerRuntimeAction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  action: RuntimeInteractionActionSnapshot | RuntimeChatPacingGateActionSnapshot,
  payload: Record<string, unknown>,
): PendingActionOperationResult<ActionCompletionOutcome> {
  return completeAction(plan, snapshot, actionRequest(action, payload));
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
  if (action?.ui.kind === "button") {
    return submittedText !== "" && submittedText === action.ui.buttonLabel
      ? completePlayerAction(session, action, { kind: "activate" })
      : null;
  }
  // While a form field is edited, the composer's text is its answer. Otherwise the composer takes the exact text of
  // one visible button: a field's label steps it, the submit label submits.
  if (action?.ui.kind === "form") {
    if (action.form?.editor != null) return commitPlayerRuntimeFormField(session, submittedText);
    const fields = action.ui.fields.filter((field) => field.text === submittedText);
    const submits = action.ui.submit.text === submittedText ? 1 : 0;
    const cancels = action.ui.cancel?.text === submittedText ? 1 : 0;
    if (submittedText === "" || fields.length + submits + cancels !== 1) return null;
    return submits === 1
      ? submitPlayerRuntimeForm(session)
      : cancels === 1
        ? cancelPlayerRuntimeForm(session)
        : stepPlayerRuntimeFormField(session, fields[0]!.id);
  }
  if (
    action === null ||
    (action.interactionKind !== "text" &&
      action.interactionKind !== "number" &&
      action.interactionKind !== "temporal" &&
      action.interactionKind !== "choice")
  ) {
    return null;
  }
  return completePlayerAction(session, action, { kind: "submittedText", submittedText });
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

/**
 * The latest form presentation of each session, by its form state: an edit changes the state, and nothing else
 * re-renders the form, although every publication carries its own copy of the state.
 */
const formPresentations = new WeakMap<
  PlayerRuntimeEngine,
  { readonly key: string; readonly presentation: PlayerFormPresentation }
>();

/** The controls of the pending form as its answers stand, or `null` without a pending form. */
export function playerRuntimeForm(session: PlayerRuntimeSession): PlayerFormPresentation | null {
  const action = activeInteraction(session.state);
  if (action?.ui.kind !== "form" || action.form === undefined) return null;
  const presentation = session.state.temporalPresentation;
  const key = JSON.stringify([action.actionId, action.form, presentation]);
  const cached = formPresentations.get(session.engine);
  if (cached?.key === key) return cached.presentation;
  const { ui, form } = action;
  const fields = ui.fields.map((field, index): PlayerFormFieldPresentation => {
    const value = form.values[index] ?? null;
    const editing = form.editor?.fieldId === field.id;
    if (field.kind !== "boolean" && field.kind !== "cycle")
      return Object.freeze({
        id: field.id,
        label: field.text,
        kind: "value",
        pressed: false,
        state: value === null ? null : formValueText(value, presentation),
        optional: field.optional,
        editing,
        ...(field.background === undefined ? {} : { authoredFill: field.background }),
      });
    const option =
      field.kind === "cycle"
        ? typeof value === "number"
          ? field.options[value]
          : undefined
        : field.options?.find((candidate) => candidate.value === value);
    const authoredFill = option?.background ?? field.background;
    return Object.freeze({
      id: field.id,
      label: field.text,
      kind: field.kind === "boolean" ? "toggle" : "cycle",
      pressed: value === true,
      state: option?.text ?? null,
      optional: false,
      editing: false,
      ...(authoredFill === undefined ? {} : { authoredFill }),
    });
  });
  const edited = ui.fields.find((field) => field.id === form.editor?.fieldId);
  const result = Object.freeze({
    actionId: action.actionId,
    fields: Object.freeze(fields),
    submit: Object.freeze({
      label: ui.submit.text,
      ...(ui.submit.background === undefined ? {} : { authoredFill: ui.submit.background }),
    }),
    cancel:
      ui.cancel === null
        ? null
        : Object.freeze({
            label: ui.cancel.text,
            ...(ui.cancel.background === undefined ? {} : { authoredFill: ui.cancel.background }),
          }),
    editor:
      edited === undefined ||
      form.editor === null ||
      edited.kind === "boolean" ||
      edited.kind === "cycle"
        ? null
        : Object.freeze({
            fieldId: edited.id,
            label: edited.text,
            // A date or time control shows its hint beside it, so it has none by default.
            hint:
              edited.hint ??
              (edited.kind === "date" || edited.kind === "time" || edited.kind === "datetime"
                ? ""
                : `${edited.text}…`),
            optional: edited.optional,
            text: form.editor.text,
            inputMode:
              edited.kind === "integer" ? "numeric" : edited.kind === "number" ? "decimal" : "text",
            // A native date control has no year 0000, so such a value is edited as ISO text.
            inputType:
              edited.kind === "date" || edited.kind === "time" || edited.kind === "datetime"
                ? form.editor.text.startsWith("0000")
                  ? "text"
                  : edited.kind === "datetime"
                    ? "datetime-local"
                    : edited.kind
                : "text",
          } satisfies PlayerFormEditorPresentation),
  });
  formPresentations.set(session.engine, { key, presentation: result });
  return result;
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

/** The forms that can still be answered: the presented one and one that a running block suspended. */
export function playerRuntimeFormActionIds(state: PlayerRuntimeState): readonly number[] {
  return [state.foregroundAction, state.suspendedAction].flatMap((action) =>
    action?.kind === "interaction" && action.ui.kind === "form" ? [action.actionId] : [],
  );
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
 * The scene time of the session's next timed event: the earliest of `playerRuntimeDeadlines` and the next timeline
 * event of running loaded media, which play on at 1× from their last reported sample. Rounds of a repeating timer
 * without an expiry block and passes of repeating media without cues run nothing, so they are no event; an observation
 * past many of them gives the same result as observing each, and such media count only with their end. An event that
 * is already due, such as one of media that stalled, gives the next whole millisecond, so time moves on. `null` when
 * nothing is scheduled, for example while only player input, loading media, or paused timers remain.
 */
export function nextPlayerRuntimeEventMs(state: PlayerRuntimeState): number | null {
  const times = timedDeadlines(state, (timer) => !timer.repeat || timer.handlerFunctionId !== null);
  if (state.status !== "failed") {
    for (const action of state.backgroundActions) {
      const atMs = action.kind === "media" ? nextMediaEventMs(action.media) : null;
      if (atMs !== null) times.push(atMs);
    }
  }
  if (times.length === 0) return null;
  const nextMs = Math.min(...times);
  const observedMs = state.observedSessionTimeMs;
  return nextMs > observedMs ? nextMs : Math.floor(observedMs) + 1;
}

/** When the next event of media playing at 1× is due; a departure needs progress after the sample it leaves. */
function nextMediaEventMs(media: RuntimeMediaSnapshot): number | null {
  const event = nextMediaEvent(media);
  if (event === null || event.dueAtMs !== null) return event?.dueAtMs ?? null;
  const last = media.points.at(-1)!;
  if (event.kind === "departure") return Math.floor(last.atMs) + 1;
  const progressMs = repeatsSilently(media) ? mediaTerminalProgressMs(media) : event.progressMs;
  return progressMs === null ? null : Math.ceil(last.atMs + progressMs - last.progressMs);
}

/**
 * Whether time cannot advance before the host answers: catch-up holds for a queued block behind a pending write, a
 * `save`, `delete` or `takePhoto()` waits for the host, or the session is paused at a random draw.
 */
export function playerRuntimeAwaitsHost(state: PlayerRuntimeState): boolean {
  const pending = state.foregroundAction?.kind;
  return (
    state.randomDraw !== null ||
    state.currentSessionTimeMs < state.observedSessionTimeMs ||
    pending === "storageWrite" ||
    pending === "capture"
  );
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

/** The permanent buttons the session shows, in creation order; a session that has ended or failed shows none. */
export function playerRuntimePermanentButtons(
  state: PlayerRuntimeState,
): readonly PlayerPermanentButtonPresentation[] {
  if (state.status !== "running" && state.status !== "waiting") return Object.freeze([]);
  return Object.freeze(
    state.permanentButtons.map((button) =>
      Object.freeze({ buttonId: button.buttonId, label: button.text, busy: button.busy }),
    ),
  );
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

/** Where the script shows the camera view now: in the floating window, over the Stage, or not at all (`null`). */
export function playerRuntimeCameraView(state: PlayerRuntimeState): "window" | "stage" | null {
  return state.cameraView?.shown === true ? state.cameraView.placement : null;
}

/** The Stage image and active media the Player presents and plays; see `MediaPlaybackProjection`. */
export function playerRuntimeMedia(state: PlayerRuntimeState): {
  readonly stage: StageProjection;
  readonly media: readonly MediaPlaybackProjection[];
} {
  return Object.freeze({ stage: state.stage, media: state.media });
}

/**
 * The authored source of an active media instance and the script file and line of the `playMedia` that started it, or
 * `null` when no such media is active.
 */
export function playerRuntimeMediaOrigin(
  session: PlayerRuntimeSession,
  mediaId: number,
): {
  readonly media: "audio" | "video";
  readonly source: string;
  readonly location: { readonly path: string; readonly line: number };
} | null {
  for (const action of session.state.backgroundActions) {
    if (action.kind !== "media" || action.media.mediaId !== mediaId) continue;
    const instruction = session.plan.instructions[action.owningInstruction]!;
    return Object.freeze({
      media: action.media.media,
      source: action.media.source,
      location: Object.freeze({
        path: instructionSourcePath(session.plan, action.owningInstruction),
        line: instruction.span.sl + 1,
      }),
    });
  }
  return null;
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

/** The `save`/`delete` waiting for the host to persist it, if any. */
export function pendingPlayerRuntimeStorageWrite(
  state: PlayerRuntimeState,
): RuntimeStorageWriteActionSnapshot | null {
  const foreground = state.foregroundAction;
  return foreground?.kind === "storageWrite" ? foreground : null;
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
  // The operation's events are presented as they stood before the continuation, but only once it ran: when it throws,
  // the session goes on from the publication before the operation, which never showed them.
  const presentation =
    operation.events.length === 0 ? null : session.engine.temporalPresentation(session);
  // The continuation runs on the same engine-owned state before anything publishes. It returns at once when nothing is
  // runnable.
  const continuation = session.engine.call(
    session,
    "run",
    [{}],
    (runtime) => runtime.run(traceOptions(session.debugTrace)),
    true,
  );
  const next = appendRuntimeEvents(session, operation.events, presentation);
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
): PlayerRuntimeSession {
  const engine = new PlayerRuntimeEngine(runtime, 0);
  return Object.freeze({
    plan,
    engine,
    revision: 0,
    state: engine.stateAt({ revision: 0, recorder: null }),
    recorder,
    debugTrace,
    events: [],
    transcriptEntries: [],
    transcriptMessageRows: new Map(),
    transcriptRevision: 0,
    speakers: { ...DEFAULT_SPEAKERS },
  });
}

/** The prefix of a transcript entry ID the adapter derives from its runtime event. */
const TRANSCRIPT_EVENT_ID = "runtime-event-";

/** The runtime event sequence of a transcript entry this adapter appended, or `null` for any other entry ID. */
export function playerRuntimeTranscriptEventSequence(entryId: string): number | null {
  if (!entryId.startsWith(TRANSCRIPT_EVENT_ID)) return null;
  const digits = entryId.slice(TRANSCRIPT_EVENT_ID.length);
  return /^[1-9]\d*$/u.test(digits) && Number.isSafeInteger(Number(digits)) ? Number(digits) : null;
}

/**
 * The transcript that `events` present, from the start of a session: its entries and the speakers they name. Debug's
 * rewind shows with it the messages of a state the shown one has not reached yet.
 */
export function playerRuntimeTranscript(events: readonly InterpreterEvent[]): {
  readonly entries: readonly PlayerTranscriptEntryPresentation[];
  readonly speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
} {
  const entries: PlayerTranscriptEntryPresentation[] = [];
  const speakers: Record<string, PlayerSpeakerPresentation> = { ...DEFAULT_SPEAKERS };
  appendTranscript(entries, new Map(), speakers, events, DEFAULT_TEMPORAL_CONTEXT.presentation);
  return { entries, speakers };
}

/** The script message `entryId` names in the session's transcript, as it shows now, or `null` for any other entry. */
export function playerRuntimeTranscriptMessage(
  session: PlayerRuntimeSession,
  entryId: string,
): PlayerMessagePresentation | null {
  const sequence = playerRuntimeTranscriptEventSequence(entryId);
  const index = sequence === null ? undefined : session.transcriptMessageRows.get(sequence);
  const entry = index === undefined ? undefined : session.transcriptEntries[index];
  return entry?.kind === "message" ? entry : null;
}

// Folds `events` into the transcript, in order: each message or answer appends its entry, keyed by the event that
// created it, and the speakers they name; a message update replaces its message's entry with one showing the new text.
// `rows` indexes the script messages. A choice, button, or form answer is marked by its settlement, which the same
// operation emits.
function appendTranscript(
  transcriptEntries: PlayerTranscriptEntryPresentation[],
  rows: Map<number, number>,
  speakers: Record<string, PlayerSpeakerPresentation>,
  events: readonly InterpreterEvent[],
  presentation: TemporalContext["presentation"],
) {
  const responseKinds = new Map<number, "choice" | "button" | "form">();
  // A submitted form's answer shows every field with its state, one per line (V30 askForm).
  const formSummaries = new Map<number, readonly FormSummaryLine[]>();
  for (const event of events) {
    if (
      event.kind === "actionCompleted" &&
      event.settlement.actionKind === "interaction" &&
      event.settlement.transcriptEventSequence !== null &&
      (event.settlement.interactionKind === "choice" ||
        event.settlement.interactionKind === "button" ||
        event.settlement.interactionKind === "form")
    ) {
      responseKinds.set(event.settlement.transcriptEventSequence, event.settlement.interactionKind);
      const { ui, result } = event.settlement;
      const summary = ui.kind === "form" ? formSummaryOf(ui, result, presentation) : null;
      if (summary !== null) formSummaries.set(event.settlement.transcriptEventSequence, summary);
    }
  }
  for (const event of events) {
    if (event.kind === "say") {
      const speakerId = event.speaker === null ? "narrator" : speakerKey(event.speaker);
      if (event.speaker !== null) speakers[speakerId] = speakerPresentation(event.speaker);
      rows.set(event.sequence, transcriptEntries.length);
      transcriptEntries.push(
        Object.freeze({
          kind: "message",
          id: `${TRANSCRIPT_EVENT_ID}${event.sequence}`,
          speakerId,
          text: event.text,
          content: event.content,
          contentSequence: event.sequence,
          presentation: event.presentation,
        }),
      );
    } else if (event.kind === "messageUpdated") {
      // The message keeps its place, speaker, and presentation; a message these events did not show stays absent.
      const index = rows.get(event.messageId);
      const entry = index === undefined ? undefined : transcriptEntries[index];
      if (entry?.kind === "message")
        transcriptEntries[index!] = Object.freeze({
          ...entry,
          text: event.text,
          content: event.content,
          contentSequence: event.sequence,
        });
    } else if (event.kind === "playerTranscript") {
      transcriptEntries.push(
        Object.freeze({
          kind: "message",
          id: `${TRANSCRIPT_EVENT_ID}${event.sequence}`,
          speakerId: "user",
          text: event.text,
          ...(responseKinds.has(event.sequence)
            ? { responseKind: responseKinds.get(event.sequence)! }
            : {}),
          ...(formSummaries.has(event.sequence)
            ? { formSummary: formSummaries.get(event.sequence)! }
            : {}),
        }),
      );
    }
  }
}

function appendRuntimeEvents(
  session: PlayerRuntimeSession,
  events: readonly InterpreterEvent[],
  presentation: PresentationSettings | null = null,
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
  for (const event of events) retainedEvents.push(event);
  appendTranscript(
    transcriptEntries,
    messageRows,
    speakers,
    events,
    presentation ?? session.engine.temporalPresentation(session),
  );
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

function activeInteraction(
  state: Pick<RuntimeSessionView, "foregroundAction">,
): RuntimeInteractionActionSnapshot | null {
  return activePlayerRuntimeInteraction(state);
}

function choiceOptionId(actionId: number, optionIndex: number): string {
  return `runtime-choice-${actionId}-${optionIndex}`;
}

function interactionAccessibleName(value: InteractionAccessibleName): string {
  if (value.kind === "text") return value.text;
  return {
    answer: "Answer",
    number: "Number",
    chooseOption: "Choose an option",
    continue: "Continue",
  }[value.key];
}

// Include presentation state so later speaker changes do not restyle earlier messages.
function speakerKey(speaker: {
  readonly identifier: string;
  readonly displayName: string;
  readonly color: string | null;
  readonly font: string | null;
  readonly avatar: string | null;
}): string {
  const shape = [
    speaker.identifier,
    speaker.displayName,
    speaker.color,
    speaker.font,
    speaker.avatar,
  ];
  return `runtime-speaker-${JSON.stringify(shape)}`;
}

function speakerPresentation(speaker: {
  readonly identifier: string;
  readonly displayName: string;
  readonly color: string | null;
  readonly font: string | null;
  readonly avatar: string | null;
}): PlayerSpeakerPresentation {
  return Object.freeze({
    identityId: speaker.identifier,
    name: speaker.displayName,
    accent: speaker.color ?? "inherit",
    avatar: speaker.displayName.trim().charAt(0).toUpperCase() || "?",
    ...(speaker.avatar === null ? {} : { avatarImage: speaker.avatar }),
    fontFamily: speaker.font ?? "inherit",
  });
}
