import {
  captureTemporalContext,
  compileProject,
  completeAction,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  DEFAULT_TEMPORAL_CONTEXT,
  deserializeCheckpoint,
  interactionDeadlineMs,
  MAIN_FILE_PATH,
  mediaPlaybackProjection,
  observeTime,
  permanentButtonProjection,
  pressPermanentButton,
  recordContinueCapture,
  reportMediaLoad,
  stageProjection,
  run,
  serializeCheckpoint,
  type ActionCompletionOutcome,
  type ContinueCaptureOutcome,
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
  type ProjectImageFile,
  type ProjectSourceFile,
  type RuntimeInteractionActionSnapshot,
  type CapturedMediaAdmission,
  type CaptureUnavailableReason,
  type RuntimeCaptureActionSnapshot,
  type RuntimeScriptStorageEntrySnapshot,
  type RuntimeSnapshot,
  type RuntimeStorageWriteActionSnapshot,
  type TemporalContext,
  type TimeObservationOutcome,
} from "../src/index.js";
import type { RuntimeChatPacingGateActionSnapshot } from "../src/runtime/actions/model.js";
import { runValidatedState } from "../src/runtime/engine.js";
import {
  mediaTerminalProgressMs,
  nextMediaEvent,
  repeatsSilently,
  type RuntimeMediaSnapshot,
} from "../src/runtime/media.js";
import type { RuntimeTimerSnapshot } from "../src/runtime/timers.js";
import type {
  PlayerForegroundPresentation,
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

export interface PlayerRuntimeSession {
  readonly plan: InstructionPlan;
  readonly snapshot: RuntimeSnapshot;
  readonly events: readonly InterpreterEvent[];
  readonly transcriptEntries: readonly PlayerTranscriptEntryPresentation[];
  readonly transcriptRevision: number;
  readonly speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
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

export interface PlayerRuntimeControlResult<T = ActionCompletionOutcome | TimeObservationOutcome> {
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
  const snapshot = createFreshRuntimeSnapshot(plan, {
    ...(options.scriptStorage === undefined ? {} : { scriptStorage: options.scriptStorage }),
    persistentScriptStorage: options.persistentScriptStorage ?? false,
    ...(options.temporalContext === undefined ? {} : { temporalContext: options.temporalContext }),
    ...(options.wallClockMs === undefined ? {} : { wallClockMs: options.wallClockMs }),
  });
  const operation = run(plan, snapshot);
  return applyOperation(emptySession(plan, snapshot), operation.snapshot, operation.events, false);
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
    checkpointJson: serializeCheckpoint(createCheckpoint(session.plan, session.snapshot)),
    events: Object.freeze([...session.events]),
  });
}

export function restorePlayerRuntimeSession(
  restorePoint: PlayerRuntimeRestorePoint,
): PlayerRuntimeSession {
  const checkpoint = deserializeCheckpoint(restorePoint.checkpointJson);
  return appendRuntimeEvents(
    emptySession(checkpoint.plan, checkpoint.snapshot),
    restorePoint.events,
  );
}

export function playerRuntimeForeground(
  session: PlayerRuntimeSession,
): PlayerForegroundPresentation | null {
  const action = activeInteraction(session.snapshot);
  if (action === null) return null;
  const accessibleName = interactionAccessibleName(action.ui.accessibleName);
  switch (action.ui.kind) {
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
        types: action.ui.types,
        mime: action.ui.mime,
      });
    case "choice":
      return Object.freeze({
        kind: "choose",
        accessibleName,
        options: Object.freeze(
          action.ui.options.map((option, index) =>
            Object.freeze({
              id: choiceOptionId(action.actionId, index),
              label: option.text,
              ...(option.background === undefined ? {} : { authoredFill: option.background }),
            }),
          ),
        ),
      });
  }
}

/**
 * Visible and mystery timers at the Player's session-time estimate, in creation order: a blocking timer (also while
 * an expiry block interrupts it) and every running or paused async timer. Hidden timers and `wait` produce no entry,
 * and a settled timer disappears with its action. A paused timer shows its frozen remaining time.
 */
export function playerRuntimeTimers(
  snapshot: RuntimeSnapshot,
  currentSessionTimeMs: number,
): readonly PlayerTimerPresentation[] {
  const now = Math.max(snapshot.observedSessionTimeMs, currentSessionTimeMs);
  const timers: Array<PlayerTimerPresentation & { readonly actionId: number }> = [];
  const delays = [
    snapshot.foregroundAction,
    ...snapshot.callFrames.map((frame) =>
      frame.kind === "function" ? (frame.timerInterruption?.suspendedAction ?? null) : null,
    ),
  ];
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
  for (const action of snapshot.backgroundActions) {
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
export function playerRuntimeDeadlines(snapshot: RuntimeSnapshot): readonly number[] {
  return timedDeadlines(snapshot, () => true);
}

function timedDeadlines(
  snapshot: RuntimeSnapshot,
  timerCounts: (timer: RuntimeTimerSnapshot) => boolean,
): number[] {
  const deadlines: number[] = [];
  if (snapshot.status === "failed") return deadlines;
  for (const action of [
    snapshot.foregroundAction,
    ...snapshot.backgroundActions,
    ...snapshot.callFrames.map((frame) =>
      frame.kind === "function" ? (frame.timerInterruption?.suspendedAction ?? null) : null,
    ),
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
  const button = activePlayerRuntimeInteraction(snapshot);
  const buttonDeadlineMs = button === null ? null : interactionDeadlineMs(button);
  if (buttonDeadlineMs !== null) deadlines.push(buttonDeadlineMs);
  return deadlines;
}

export function playerRuntimePacingGate(
  session: PlayerRuntimeSession,
): RuntimeChatPacingGateActionSnapshot | null {
  return activePlayerRuntimePacingGate(session.snapshot);
}

export function activePlayerRuntimeInteraction(
  snapshot: RuntimeSnapshot,
): RuntimeInteractionActionSnapshot | null {
  return snapshot.foregroundAction?.kind === "interaction" ? snapshot.foregroundAction : null;
}

export function activePlayerRuntimePacingGate(
  snapshot: RuntimeSnapshot,
): RuntimeChatPacingGateActionSnapshot | null {
  if (snapshot.status === "failed") return null;
  const foreground = snapshot.foregroundAction;
  if (foreground?.kind === "chatPacingGate") return foreground;
  return snapshot.backgroundActions.find((action) => action.kind === "chatPacingGate") ?? null;
}

/** How the Player answers a pending `takePhoto()`. */
export type PlayerCaptureAnswer =
  | { readonly kind: "captured"; readonly reference: string }
  | { readonly kind: "unavailable"; readonly reason: CaptureUnavailableReason };

/** The pending `takePhoto()` the Player must answer, if any. */
export function activePlayerRuntimeCapture(
  snapshot: RuntimeSnapshot,
): RuntimeCaptureActionSnapshot | null {
  const action = snapshot.status === "waiting" ? snapshot.foregroundAction : null;
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
  const operation = completeAction(
    session.plan,
    session.snapshot,
    { actionId, actionKind: "capture", payload },
    capturedMedia === undefined ? {} : { capturedMedia },
  );
  return Object.freeze({
    session: applyOperation(
      session,
      operation.snapshot,
      operation.events,
      operation.outcome.kind === "completed",
    ),
    outcome: operation.outcome,
  });
}

export function completePlayerRuntimeAction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  action: RuntimeInteractionActionSnapshot | RuntimeChatPacingGateActionSnapshot,
  payload: Record<string, unknown>,
): PendingActionOperationResult<ActionCompletionOutcome> {
  return completeAction(plan, snapshot, {
    actionId: action.actionId,
    actionKind: action.kind,
    ...(action.kind === "interaction" ? { interactionKind: action.interactionKind } : {}),
    payload,
  });
}

export function submitPlayerRuntimeComposer(
  session: PlayerRuntimeSession,
  submittedText: string,
): PlayerRuntimeControlResult<ActionCompletionOutcome> | null {
  const action = activeInteraction(session.snapshot);
  if (action?.ui.kind === "button") {
    return submittedText !== "" && submittedText === action.ui.buttonLabel
      ? completePlayerAction(session, action, { kind: "activate" })
      : null;
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
  const action = activeInteraction(session.snapshot);
  if (action?.ui.kind !== "image") return null;
  const operation = completeAction(
    session.plan,
    session.snapshot,
    {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: "image",
      payload: { kind: "image", reference },
    },
    { capturedMedia },
  );
  return Object.freeze({
    session: applyOperation(
      session,
      operation.snapshot,
      operation.events,
      operation.outcome.kind === "completed",
    ),
    outcome: operation.outcome,
  });
}

export function activatePlayerRuntimeButton(
  session: PlayerRuntimeSession,
): PlayerRuntimeControlResult<ActionCompletionOutcome> | null {
  const action = activeInteraction(session.snapshot);
  if (action?.interactionKind !== "button") return null;
  return completePlayerAction(session, action, { kind: "activate" });
}

export function selectPlayerRuntimeChoice(
  session: PlayerRuntimeSession,
  optionId: string,
): PlayerRuntimeControlResult<ActionCompletionOutcome> | null {
  const action = activeInteraction(session.snapshot);
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
  const operation = recordContinueCapture(session.plan, session.snapshot, capture);
  return Object.freeze({
    session: applyOperation(
      session,
      operation.snapshot,
      operation.events,
      operation.outcome.kind === "recorded",
    ),
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
  const operation = observeTime(session.plan, session.snapshot, currentSessionTimeMs, mediaReports);
  // A settlement or a queued timer expiry block may make execution eligible; `run` returns at once otherwise.
  return Object.freeze({
    session: applyOperation(
      session,
      operation.snapshot,
      operation.events,
      operation.outcome.kind === "observed",
    ),
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
export function nextPlayerRuntimeEventMs(snapshot: RuntimeSnapshot): number | null {
  const times = timedDeadlines(
    snapshot,
    (timer) => !timer.repeat || timer.handlerFunctionId !== null,
  );
  if (snapshot.status !== "failed") {
    for (const action of snapshot.backgroundActions) {
      const atMs = action.kind === "media" ? nextMediaEventMs(action.media) : null;
      if (atMs !== null) times.push(atMs);
    }
  }
  if (times.length === 0) return null;
  const nextMs = Math.min(...times);
  const observedMs = snapshot.observedSessionTimeMs;
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
 * Whether time cannot advance before the host answers: catch-up holds for a queued block behind a pending write, or a
 * `save`, `delete` or `takePhoto()` waits for the host.
 */
export function playerRuntimeAwaitsHost(snapshot: RuntimeSnapshot): boolean {
  const pending = snapshot.foregroundAction?.kind;
  return (
    snapshot.currentSessionTimeMs < snapshot.observedSessionTimeMs ||
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
  const { snapshot } = session;
  if (snapshot.observedSessionTimeMs >= targetMs || playerRuntimeAwaitsHost(snapshot))
    return session;
  const stepMs = Math.min(targetMs, nextPlayerRuntimeEventMs(snapshot) ?? targetMs);
  const result = observePlayerRuntimeTime(session, stepMs, playingMediaReports(snapshot, stepMs));
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
function playingMediaReports(snapshot: RuntimeSnapshot, atMs: number): MediaProgressReport[] {
  const reports: MediaProgressReport[] = [];
  for (const action of snapshot.backgroundActions) {
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
  const operation = reportMediaLoad(session.plan, session.snapshot, mediaId, report);
  return Object.freeze({
    session: applyOperation(
      session,
      operation.snapshot,
      operation.events,
      operation.outcome.kind === "accepted",
    ),
    outcome: operation.outcome,
  });
}

/** The permanent buttons the session shows, in creation order; a session that has ended or failed shows none. */
export function playerRuntimePermanentButtons(
  snapshot: RuntimeSnapshot,
): readonly PlayerPermanentButtonPresentation[] {
  if (snapshot.status !== "running" && snapshot.status !== "waiting") return Object.freeze([]);
  return Object.freeze(
    permanentButtonProjection(snapshot).map((button) =>
      Object.freeze({ buttonId: button.buttonId, label: button.text, busy: button.busy }),
    ),
  );
}

/** Clicks a permanent button, then runs the session, which starts the button's block. */
export function pressPlayerRuntimePermanentButton(
  session: PlayerRuntimeSession,
  buttonId: number,
): PlayerRuntimeControlResult<PermanentButtonPressOutcome> {
  const operation = pressPermanentButton(session.plan, session.snapshot, buttonId);
  return Object.freeze({
    session: applyOperation(
      session,
      operation.snapshot,
      operation.events,
      operation.outcome.kind === "pressed",
    ),
    outcome: operation.outcome,
  });
}

/** Where the script shows the camera view now: in the floating window, over the Stage, or not at all (`null`). */
export function playerRuntimeCameraView(snapshot: RuntimeSnapshot): "window" | "stage" | null {
  return snapshot.cameraView?.shown === true ? snapshot.cameraView.placement : null;
}

/** The Stage image and active media the Player presents and plays; see `MediaPlaybackProjection`. */
export function playerRuntimeMedia(snapshot: RuntimeSnapshot): {
  readonly stage: StageProjection;
  readonly media: readonly MediaPlaybackProjection[];
} {
  return Object.freeze({
    stage: stageProjection(snapshot),
    media: mediaPlaybackProjection(snapshot),
  });
}

function completePlayerAction(
  session: PlayerRuntimeSession,
  action: RuntimeInteractionActionSnapshot | RuntimeChatPacingGateActionSnapshot,
  payload: Record<string, unknown>,
): PlayerRuntimeControlResult<ActionCompletionOutcome> {
  const operation = completePlayerRuntimeAction(session.plan, session.snapshot, action, payload);
  return Object.freeze({
    session: applyOperation(
      session,
      operation.snapshot,
      operation.events,
      operation.outcome.kind === "completed",
    ),
    outcome: operation.outcome,
  });
}

/** The `save`/`delete` waiting for the host to persist it, if any. */
export function pendingPlayerRuntimeStorageWrite(
  snapshot: RuntimeSnapshot,
): RuntimeStorageWriteActionSnapshot | null {
  const foreground = snapshot.foregroundAction;
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
  const operation = completeAction(session.plan, session.snapshot, {
    actionId,
    actionKind: "storageWrite",
    payload: { kind: stored ? "stored" : "failed" },
  });
  return Object.freeze({
    session: applyOperation(
      session,
      operation.snapshot,
      operation.events,
      operation.outcome.kind === "completed",
    ),
    outcome: operation.outcome,
  });
}

/** Publishes one runtime operation, optionally followed by the run it makes eligible. */
function applyOperation(
  session: PlayerRuntimeSession,
  snapshot: RuntimeSnapshot,
  events: readonly InterpreterEvent[],
  continueRun: boolean,
): PlayerRuntimeSession {
  const next = appendRuntimeEvents({ ...session, snapshot }, events);
  if (!continueRun) return Object.freeze(next);
  // The operation just captured and validated this snapshot against the session's plan, and nothing has published it,
  // so the continuation runs on it without a second capture. It returns at once when nothing is runnable.
  const continuation = runValidatedState(next.plan, next.snapshot);
  return appendRuntimeEvents({ ...next, snapshot: continuation.snapshot }, continuation.events);
}

function emptySession(plan: InstructionPlan, snapshot: RuntimeSnapshot): PlayerRuntimeSession {
  return Object.freeze({
    plan,
    snapshot,
    events: [],
    transcriptEntries: [],
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
  for (const event of events) retainedEvents.push(event);
  const responseKinds = new Map<number, "choice" | "button">();
  for (const event of events) {
    if (
      event.kind === "actionCompleted" &&
      event.settlement.actionKind === "interaction" &&
      event.settlement.transcriptEventSequence !== null &&
      (event.settlement.interactionKind === "choice" ||
        event.settlement.interactionKind === "button")
    ) {
      responseKinds.set(event.settlement.transcriptEventSequence, event.settlement.interactionKind);
    }
  }
  for (const event of events) {
    if (event.kind === "say") {
      const speakerId = event.speaker === null ? "narrator" : speakerKey(event.speaker);
      if (event.speaker !== null) speakers[speakerId] = speakerPresentation(event.speaker);
      transcriptEntries.push(
        Object.freeze({
          kind: "message",
          id: `runtime-event-${event.sequence}`,
          speakerId,
          text: event.text,
          content: event.content,
          presentation: event.presentation,
        }),
      );
    } else if (event.kind === "playerTranscript") {
      transcriptEntries.push(
        Object.freeze({
          kind: "message",
          id: `runtime-event-${event.sequence}`,
          speakerId: "user",
          text: event.text,
          ...(responseKinds.has(event.sequence)
            ? { responseKind: responseKinds.get(event.sequence)! }
            : {}),
        }),
      );
    }
  }
  return Object.freeze({
    ...session,
    events: retainedEvents,
    transcriptEntries,
    transcriptRevision: session.transcriptRevision + 1,
    speakers,
  });
}

function activeInteraction(snapshot: RuntimeSnapshot): RuntimeInteractionActionSnapshot | null {
  return activePlayerRuntimeInteraction(snapshot);
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
