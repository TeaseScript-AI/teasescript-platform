import type { InteractionAccessibleName } from "../../src/plan/model.js";
import { IMAGE_SKIP_TEXT } from "../../src/image-input.js";
import { PLAYER } from "../../src/speaker-terms.js";
import { DEFAULT_TEMPORAL_CONTEXT, type TemporalContext } from "../../src/temporal.js";
import { captureTemporalContext } from "../../src/temporal-capture.js";
import { actionAwaitsHost } from "../../src/runtime/actions/interrupts.js";
import {
  interactionDeadlineMs,
  type RuntimeCaptureActionSnapshot,
  type RuntimeChatPacingGateActionSnapshot,
  type RuntimeFileStoreActionSnapshot,
  type RuntimeForegroundActionSnapshot,
  type RuntimeInteractionActionSnapshot,
  type RuntimeLockActionSnapshot,
  type RuntimeLockChoice,
  type RuntimeStorageWriteActionSnapshot,
} from "../../src/runtime/actions/model.js";
import { formSummaryOf, type FormSummaryLine } from "../../src/runtime/actions/form/submission.js";
import {
  mediaTerminalProgressMs,
  nextMediaEvent,
  repeatsSilently,
  type RuntimeMediaSnapshot,
} from "../../src/runtime/background/media.js";
import type {
  MediaPlaybackProjection,
  StageProjection,
} from "../../src/runtime/background/media-projection.js";
import type { InterpreterEvent } from "../../src/runtime/events.js";
import {
  runtimeTimedWork,
  type RuntimeTimedWork,
} from "../../src/runtime/operations/timed-work.js";
import type { RuntimeSessionView } from "../../src/runtime/session.js";
import { formValueText } from "../../src/interaction-answers.js";
import type {
  PlayerFormEditorPresentation,
  PlayerFormFieldPresentation,
  PlayerFormPresentation,
  PlayerForegroundPresentation,
  PlayerMessagePresentation,
  PlayerPermanentButtonPresentation,
  PlayerSpeakerPresentation,
  PlayerTimerPresentation,
  PlayerTranscriptEntryPresentation,
} from "../presentation/model.js";
import type { InstructionFact, InstructionFacts } from "../engine-bridge/instruction-facts.js";
import type { PlayerCallView, PlayerCriticalState } from "../engine-bridge/session-protocol.js";
import type { HistoryMarks } from "../debug/debug-history-marks.js";
import type {
  DiagnosticIdentity,
  ExportIncident,
} from "../engine-bridge/recording/export-observation.js";
import type { HistoryDelta } from "../engine-bridge/history/core.js";
import type { PlayerBridge } from "./player-bridge.js";

// What the Player reads from a session's published state, without the engine: the foreground, timers, deadlines,
// media, buttons and the transcript. These readers run in the main realm; the engine's operations stay in
// `runtime-adapter.ts` (`player/engine-bridge/inventory.ts` lists both).

/**
 * What a session shows, as the main realm keeps it and the engine's own session has it too: the publication's revision
 * and state, and the events, transcript and speakers it has accumulated.
 */
export interface PlayerSessionView {
  /**
   * Counts the session's publications: every operation publishes a new revision, also one that changed nothing, and also
   * when the host keeps an earlier one. A publication stays usable until an operation changes the state; from then on
   * only later ones are.
   */
  readonly revision: number;
  /** What this publication shows: the critical view, without the active calls (`PlayerCriticalState`). */
  readonly state: PlayerCriticalState;
  /**
   * The first event sequence this session's own runs emitted: a restored session came with the events before it, as
   * history. `0` for a session that started fresh.
   */
  readonly liveEventSequence: number;
  readonly events: readonly InterpreterEvent[];
  readonly transcriptEntries: readonly PlayerTranscriptEntryPresentation[];
  /** By the sequence of the event that created it, the index of each script message in `transcriptEntries`. */
  readonly transcriptMessageRows: ReadonlyMap<number, number>;
  /** The indexes of the removed messages in `transcriptEntries`, in ascending order. */
  readonly transcriptRemovedRows: readonly number[];
  readonly transcriptRevision: number;
  readonly speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
}

/**
 * A session as the main realm holds it: what it shows, and how to reach it in the engine's host, with no plan, engine,
 * recorder or trace. A new object for every publication.
 */
export interface PlayerSession extends PlayerSessionView {
  /** The bridge session, unique within its connection. */
  readonly id: string;
  /** The bridge connection the session belongs to; session IDs restart per connection. */
  readonly connection: PlayerBridge;
  /** The plan instance the session runs, as the host's token for it. */
  readonly planToken: string;
  /** Where in the script each instruction this publication's view names is, by instruction index. */
  readonly instructions: InstructionFacts;
  /** The active calls while the session's calls are viewed (`demandCallView`), else `null`. */
  readonly callView: PlayerCallView | null;
  /** The session's marks for a debug export, as the host holds them with this publication. */
  readonly marks: HistoryMarks;
  /**
   * The publication's diagnostic identity for a debug export: the session's run, and the Player error stop that froze it
   * (`SessionStore.freeze`), else no stop.
   */
  readonly diagnostic: DiagnosticIdentity;
  /** The run's committed Player error incident as the host holds it with this publication, or `null`. */
  readonly incident: ExportIncident | null;
  /** The changes of Debug's rewind history this publication made, oldest first. */
  readonly history: readonly HistoryDelta[];
  /** The key Debug's rewind history names this session's event log by. */
  readonly historyKey: string;
  /**
   * What all publications of the session share (its store): while any of them is reachable, the host keeps the
   * session; once none is, the bridge releases it there.
   */
  readonly lineage: object;
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

/**
 * The presented question's line, shown again with its controls once the conversation moved on after it was asked, as a
 * block's messages and answers do while it waits. A closed rule over the runtime's own entries, with Player-made ones
 * and removed messages left out: its line is the latest entry created before the interaction was requested, only when
 * that entry is a script message, and it shows again only when an entry was created after the request. `null` in every
 * other case, and for a popup or an `exportText` dialog, which shows again itself.
 */
export function playerRuntimeQuestionAgain(
  session: Pick<PlayerSessionView, "state" | "transcriptEntries">,
): PlayerMessagePresentation | null {
  const action = activeInteraction(session.state);
  if (action === null || !asksInChat(action.ui.kind)) return null;
  let moved = false;
  const entries = session.transcriptEntries;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    const created = playerRuntimeTranscriptEventSequence(entry.id);
    if (entry.kind !== "message" || entry.removed || created === null) continue;
    if (created > action.requestEventSequence) {
      moved = true;
      continue;
    }
    // A script message has its content event; an answer has none.
    return moved && entry.contentSequence !== undefined
      ? { ...entry, id: `asked-again-${action.actionId}` }
      : null;
  }
  return null;
}

/** Whether an interaction of `kind` asks in the conversation, so its line can show again; a dialog shows itself. */
function asksInChat(kind: RuntimeInteractionActionSnapshot["ui"]["kind"]): boolean {
  switch (kind) {
    case "text":
    case "number":
    case "temporal":
    case "password":
    case "choice":
    case "button":
    case "url":
    case "image":
    case "form":
      return true;
    case "popup":
    case "export":
      return false;
    default:
      return kind satisfies never;
  }
}

export function playerRuntimeForeground(
  session: PlayerSessionView,
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
    case "popup":
      return Object.freeze({
        kind: "popup",
        accessibleName,
        message: action.ui.message,
        buttonText: action.ui.buttonText,
      });
    case "url":
      return Object.freeze({
        kind: "open-url",
        accessibleName,
        url: action.ui.url,
        buttonText: action.ui.buttonText,
      });
    case "export":
      return Object.freeze({
        kind: "export-text",
        accessibleName,
        title: action.ui.title,
        text: action.ui.text,
        fileName: action.ui.fileName,
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
    case "password":
      return Object.freeze({
        kind: "ask-password",
        accessibleName,
        hint: action.ui.hint ?? "Type your response…",
      });
    case "image":
      return Object.freeze({
        kind: "ask-image",
        accessibleName,
        hint: action.ui.hint ?? "Add an image…",
        allowFile: action.ui.allowFile,
        allowCamera: action.ui.allowCamera,
        skip: action.ui.allowSkip ? IMAGE_SKIP_TEXT : null,
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
 * and a settled timer disappears with its action. A paused timer, and a blocking timer while a block interrupts it,
 * show their frozen remaining time.
 */
export function playerRuntimeTimers(
  state: PlayerCriticalState,
  currentSessionTimeMs: number,
): readonly PlayerTimerPresentation[] {
  const now = Math.max(state.observedSessionTimeMs, currentSessionTimeMs);
  const timers: Array<PlayerTimerPresentation & { readonly actionId: number }> = [];
  const delays = [
    { action: state.foregroundAction, at: now },
    { action: state.suspendedAction, at: state.suspendedAtMs ?? now },
  ];
  for (const { action, at } of delays) {
    if (action?.kind !== "delay" || action.display === "hidden") continue;
    timers.push({
      actionId: action.actionId,
      id: `runtime-timer-${action.actionId}`,
      kind: action.display,
      ...(action.label === null ? {} : { name: action.label }),
      remainingSeconds: Math.max(0, action.deadlineMs - at) / 1000,
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

/** Session-time deadlines at which the Player must observe time again: those of the session's timed work. */
export function playerRuntimeDeadlines(state: PlayerCriticalState): readonly number[] {
  return timedDeadlines(state, () => true);
}

/**
 * The deadlines of the session's timed work that `counts`. Media events are not among them: they come due only through
 * reported progress, which the Player's media device measures and asks an observation for.
 */
function timedDeadlines(
  state: RuntimeSessionView,
  counts: (work: RuntimeTimedWork) => boolean,
): number[] {
  const deadlines: number[] = [];
  for (const work of runtimeTimedWork(state))
    if (work.kind !== "media" && counts(work)) deadlines.push(work.deadlineMs);
  return deadlines;
}

export function playerRuntimePacingGate(
  session: PlayerSessionView,
): RuntimeChatPacingGateActionSnapshot | null {
  return activePlayerRuntimePacingGate(session.state);
}

export function activePlayerRuntimeInteraction(
  state: Pick<RuntimeSessionView, "foregroundAction">,
): RuntimeInteractionActionSnapshot | null {
  return state.foregroundAction?.kind === "interaction" ? state.foregroundAction : null;
}

/** The reading time the script waits for, if any. */
export function activePlayerRuntimePacingGate(
  state: Pick<RuntimeSessionView, "status" | "foregroundAction">,
): RuntimeChatPacingGateActionSnapshot | null {
  if (state.status === "failed") return null;
  const foreground = state.foregroundAction;
  return foreground?.kind === "chatPacingGate" ? foreground : null;
}

/** The pending `takePhoto()` the Player must answer, if any. */
export function activePlayerRuntimeCapture(
  state: PlayerCriticalState,
): RuntimeCaptureActionSnapshot | null {
  const action = state.status === "waiting" ? state.foregroundAction : null;
  return action?.kind === "capture" ? action : null;
}

/** The file store the session waits for, or `null`. */
export function activePlayerRuntimeFileStore(
  state: PlayerCriticalState,
): RuntimeFileStoreActionSnapshot | null {
  const action = state.status === "waiting" ? state.foregroundAction : null;
  return action?.kind === "fileStore" ? action : null;
}

/** The lock step the session waits for, or `null`; while an expiry block runs, its dialog is not one. */
export function activePlayerRuntimeLock(
  state: PlayerCriticalState,
): RuntimeLockActionSnapshot | null {
  const action = state.status === "waiting" ? state.foregroundAction : null;
  return action?.kind === "lock" ? action : null;
}

/** The questions that can still be answered: the presented one and one that a running block suspended. */
export function playerRuntimeInteractionActionIds(state: PlayerCriticalState): readonly number[] {
  return [state.foregroundAction, state.suspendedAction].flatMap((action) =>
    action?.kind === "interaction" ? [action.actionId] : [],
  );
}

/**
 * The `openUrl` the Player can settle now, or `null`: the presented request, while nothing else can run and scene time
 * has caught up, so that settling it cannot be refused once the tab is open. `atOnce` says whether the Player may open
 * it without the click on its button: this session's own run requested it, written without `alwaysButton: true`. A
 * request that a restore, a rewind, or a reload brought back is not live, and the Player never opens it by itself.
 */
export function playerRuntimeUrlRequest(
  session: PlayerSessionView,
): { readonly actionId: number; readonly url: string; readonly atOnce: boolean } | null {
  const { state } = session;
  const action = activeInteraction(state);
  if (
    action?.ui.kind !== "url" ||
    state.status !== "waiting" ||
    state.runnable ||
    state.randomDraw !== null ||
    state.currentSessionTimeMs < state.observedSessionTimeMs
  )
    return null;
  return Object.freeze({
    actionId: action.actionId,
    url: action.ui.url,
    atOnce: !action.ui.alwaysButton && action.requestEventSequence >= session.liveEventSequence,
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
export function nextPlayerRuntimeEventMs(state: PlayerCriticalState): number | null {
  const times = timedDeadlines(state, (work) => !work.silent);
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
 * Whether time cannot advance before the host answers: catch-up holds for a queued block behind a host step, the
 * foreground action waits for the host alone (`actionAwaitsHost`), or the session is paused at a random draw.
 */
export function playerRuntimeAwaitsHost(state: RuntimeSessionView): boolean {
  const pending = state.foregroundAction;
  return (
    state.randomDraw !== null ||
    state.currentSessionTimeMs < state.observedSessionTimeMs ||
    (pending !== null && actionAwaitsHost(pending))
  );
}

/**
 * Where a catch-up of `state` would step first: the next timed event after its observed time, or `null` when nothing
 * is due to step to or time waits for the host. A silent round of a repeating timer counts only when it draws its
 * successor's length from a range: catch-up settles such rounds one by one, not in one arithmetic skip.
 */
export function nextPlayerRuntimeCatchUpStepMs(state: RuntimeSessionView): number | null {
  if (playerRuntimeAwaitsHost(state)) return null;
  let nextMs: number | null = null;
  for (const atMs of timedDeadlines(state, (work) => !work.silent || work.drawsNextRound)) {
    if (atMs > state.observedSessionTimeMs && (nextMs === null || atMs < nextMs)) nextMs = atMs;
  }
  return nextMs;
}

/** The permanent buttons the session shows, in creation order; a session that has ended or failed shows none. */
export function playerRuntimePermanentButtons(
  state: PlayerCriticalState,
): readonly PlayerPermanentButtonPresentation[] {
  if (state.status !== "running" && state.status !== "waiting") return Object.freeze([]);
  return Object.freeze(
    state.permanentButtons.map((button) =>
      Object.freeze({ buttonId: button.buttonId, label: button.text, busy: button.busy }),
    ),
  );
}

/** Where the script shows the camera view now: in the floating window, over the Stage, or not at all (`null`). */
export function playerRuntimeCameraView(state: PlayerCriticalState): "window" | "stage" | null {
  return state.cameraView?.shown === true ? state.cameraView.placement : null;
}

/** The Stage image and active media the Player presents and plays; see `MediaPlaybackProjection`. */
export function playerRuntimeMedia(state: PlayerCriticalState): {
  readonly stage: StageProjection;
  readonly media: readonly MediaPlaybackProjection[];
} {
  return Object.freeze({ stage: state.stage, media: state.media });
}

/** The `save`/`delete` waiting for the host to persist it, if any. */
export function pendingPlayerRuntimeStorageWrite(
  state: PlayerCriticalState,
): RuntimeStorageWriteActionSnapshot | null {
  const foreground = state.foregroundAction;
  return foreground?.kind === "storageWrite" ? foreground : null;
}

/** The runtime event sequence of a transcript entry this adapter appended, or `null` for any other entry ID. */
export function playerRuntimeTranscriptEventSequence(entryId: string): number | null {
  if (!entryId.startsWith(TRANSCRIPT_EVENT_ID)) return null;
  const digits = entryId.slice(TRANSCRIPT_EVENT_ID.length);
  return /^[1-9]\d*$/u.test(digits) && Number.isSafeInteger(Number(digits)) ? Number(digits) : null;
}

/**
 * The transcript that `events` present, from the start of a session: its entries and the speakers they name, as a
 * session restored with these events shows them. Debug's rewind shows with it the messages of a state the shown one has
 * not reached yet.
 */
export function playerRuntimeTranscript(events: readonly InterpreterEvent[]): {
  readonly entries: readonly PlayerTranscriptEntryPresentation[];
  readonly speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
} {
  const entries: PlayerTranscriptEntryPresentation[] = [];
  const speakers: Record<string, PlayerSpeakerPresentation> = { ...DEFAULT_SPEAKERS };
  appendTranscript(entries, new Map(), [], speakers, events);
  return { entries, speakers };
}

/** The script message `entryId` names in the session's transcript, as it shows now, or `null` for any other entry. */
export function playerRuntimeTranscriptMessage(
  session: PlayerSessionView,
  entryId: string,
): PlayerMessagePresentation | null {
  const sequence = playerRuntimeTranscriptEventSequence(entryId);
  const index = sequence === null ? undefined : session.transcriptMessageRows.get(sequence);
  const entry = index === undefined ? undefined : session.transcriptEntries[index];
  return entry?.kind === "message" ? entry : null;
}

/** The row key of the answer to interaction `actionId`, which its predicted row and its entry share. */
export function answerRenderKey(actionId: number): string {
  return `answer-${actionId}`;
}

// Folds `events` into the transcript, in order: each message or answer appends its entry, keyed by the event that
// created it, and the speakers they name; a message update replaces its message's entry with one showing the new text,
// and a removal with one marked removed, which keeps its place. `rows` indexes the script messages, and `removedRows`
// lists the removed ones in ascending order. A choice, button, or form answer is marked by its settlement, which the same
// operation emits.

export function appendTranscript(
  transcriptEntries: PlayerTranscriptEntryPresentation[],
  rows: Map<number, number>,
  removedRows: number[],
  speakers: Record<string, PlayerSpeakerPresentation>,
  events: readonly InterpreterEvent[],
) {
  const responseKinds = new Map<number, "choice" | "button" | "form">();
  // The rows these events remove, sorted and merged into `removedRows` once, whatever order they come in.
  const removedNow: number[] = [];
  // A submitted form's answer shows every field with its state, one per line (V30 askForm), in the presentation its
  // answers were sent in.
  const formSummaries = new Map<number, readonly FormSummaryLine[]>();
  // Each answer's row key, from the interaction its settlement names.
  const answerKeys = new Map<number, string>();
  for (const event of events) {
    if (
      event.kind === "actionCompleted" &&
      event.settlement.actionKind === "interaction" &&
      event.settlement.transcriptEventSequence !== null
    )
      answerKeys.set(
        event.settlement.transcriptEventSequence,
        answerRenderKey(event.settlement.actionId),
      );
    if (
      event.kind === "actionCompleted" &&
      event.settlement.actionKind === "interaction" &&
      event.settlement.transcriptEventSequence !== null &&
      (event.settlement.interactionKind === "choice" ||
        event.settlement.interactionKind === "button" ||
        event.settlement.interactionKind === "form")
    ) {
      responseKinds.set(event.settlement.transcriptEventSequence, event.settlement.interactionKind);
      const { ui, result, shownOptions, temporalPresentation } = event.settlement;
      const summary =
        ui.kind === "form" && temporalPresentation
          ? formSummaryOf(ui, result, shownOptions, temporalPresentation)
          : null;
      if (summary !== null) formSummaries.set(event.settlement.transcriptEventSequence, summary);
    }
  }
  for (const event of events) {
    if (event.kind === "say") {
      // A message of `player` is the player's own, as an answer is (V30 §37).
      const speakerId =
        event.speaker === null
          ? "narrator"
          : event.speaker.identifier === PLAYER
            ? "user"
            : speakerKey(event.speaker);
      if (event.speaker !== null && speakerId !== "user")
        speakers[speakerId] = speakerPresentation(event.speaker);
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
    } else if (event.kind === "messageRemoved") {
      // Its removal explains the message from then on; the runtime removes a message once.
      const index = rows.get(event.messageId);
      const entry = index === undefined ? undefined : transcriptEntries[index];
      if (entry?.kind === "message" && entry.removed !== true) {
        transcriptEntries[index!] = Object.freeze({
          ...entry,
          contentSequence: event.sequence,
          removed: true,
        });
        removedNow.push(index!);
      }
    } else if (event.kind === "playerTranscript") {
      transcriptEntries.push(
        Object.freeze({
          kind: "message",
          id: `${TRANSCRIPT_EVENT_ID}${event.sequence}`,
          speakerId: "user",
          text: event.text,
          presentation: event.presentation,
          ...(answerKeys.has(event.sequence) ? { renderKey: answerKeys.get(event.sequence)! } : {}),
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
  if (removedNow.length > 0) mergeSortedRows(removedRows, removedNow);
}

/** Merges the distinct `added` rows, in any order, into the ascending `rows`, in place. */
function mergeSortedRows(rows: number[], added: number[]): void {
  added.sort((left, right) => left - right);
  if (rows.length === 0 || added[0]! > rows.at(-1)!) {
    for (const row of added) rows.push(row);
    return;
  }
  const merged: number[] = [];
  let next = 0;
  for (const row of rows) {
    while (next < added.length && added[next]! < row) merged.push(added[next++]!);
    merged.push(row);
  }
  while (next < added.length) merged.push(added[next++]!);
  rows.length = 0;
  for (const row of merged) rows.push(row);
}

export function activeInteraction(
  state: Pick<RuntimeSessionView, "foregroundAction">,
): RuntimeInteractionActionSnapshot | null {
  return activePlayerRuntimeInteraction(state);
}

export function choiceOptionId(actionId: number, optionIndex: number): string {
  return `runtime-choice-${actionId}-${optionIndex}`;
}

function interactionAccessibleName(value: InteractionAccessibleName): string {
  if (value.kind === "text") return value.text;
  return {
    answer: "Answer",
    number: "Number",
    chooseOption: "Choose an option",
    continue: "Continue",
    password: "Password",
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

export const DEFAULT_SPEAKERS: Readonly<Record<string, PlayerSpeakerPresentation>> = Object.freeze({
  narrator: Object.freeze({
    name: "Narrator",
    accent: "#9a867d",
    avatar: "N",
    fontFamily: "inherit",
  }),
  user: Object.freeze({ name: "You", accent: "#8fa3ab", avatar: "Y", fontFamily: "inherit" }),
});

/** The prefix of a transcript entry ID the adapter derives from its runtime event. */
const TRANSCRIPT_EVENT_ID = "runtime-event-";

/**
 * The latest form presentation of each session, by its form state: an edit changes the state, and nothing else
 * re-renders the form, although every publication carries its own copy of the state. A session is known by its event
 * accumulator, which all its publications share.
 */
const formPresentations = new WeakMap<
  object,
  { readonly key: string; readonly presentation: PlayerFormPresentation }
>();

/** The controls of the pending form as its answers stand, or `null` without a pending form. */
export function playerRuntimeForm(session: PlayerSessionView): PlayerFormPresentation | null {
  const action = activeInteraction(session.state);
  if (action?.ui.kind !== "form" || action.form === undefined) return null;
  const presentation = session.state.temporalPresentation;
  const key = JSON.stringify([action.actionId, action.form, presentation]);
  const cached = formPresentations.get(session.events);
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
        states: Object.freeze([]),
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
      states: Object.freeze(field.options?.map((candidate) => candidate.text) ?? []),
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
  formPresentations.set(session.events, { key, presentation: result });
  return result;
}

/**
 * The authored source of an active media instance and the script file and line of the `playMedia` that started it, or
 * `null` when no such media is active.
 */
export function playerRuntimeMediaOrigin(
  session: Pick<PlayerSession, "state" | "instructions">,
  mediaId: number,
): {
  readonly media: "audio" | "video";
  readonly source: string;
  readonly location: { readonly path: string; readonly line: number };
} | null {
  for (const action of session.state.backgroundActions) {
    if (action.kind !== "media" || action.media.mediaId !== mediaId) continue;
    const fact = session.instructions[action.owningInstruction];
    if (fact === undefined) return null;
    return Object.freeze({
      media: action.media.media,
      source: action.media.source,
      location: Object.freeze({ path: fact.path, line: fact.line }),
    });
  }
  return null;
}

/** What a Debug countdown counts down to: a `wait`, a `showButton` timeout, or chat pacing. */
export interface PlayerRuntimeDebugCountdown {
  readonly kind: "wait" | "button" | "pacing";
  readonly deadlineMs: number;
}

/** The fact of instruction `index`, which the view names (`instructionFacts`); a view that lacks it is a fault. */
function factAt(instructions: InstructionFacts, index: number): InstructionFact {
  const fact = instructions[index];
  if (fact === undefined) throw new Error(`The view names no instruction ${index}.`);
  return fact;
}

/**
 * The deadline of the current foreground wait for Player Debug countdowns, from the critical view only: an authored
 * `wait` (not a blocking `timer`, which lowers to the same delay), a presented `showButton` with a timeout, or a
 * message's reading time. Suspended actions behind a running block never count; that block's own foreground work
 * does. A countdown ends only when its action settles or loses the foreground.
 */
export function playerRuntimeDebugCountdown(
  session: Pick<PlayerSession, "state" | "instructions">,
): PlayerRuntimeDebugCountdown | null {
  const { state: snapshot } = session;
  if (snapshot.status !== "running" && snapshot.status !== "waiting") return null;
  const foreground = snapshot.foregroundAction;
  let countdown: PlayerRuntimeDebugCountdown | null = null;
  if (foreground?.kind === "interaction") {
    const deadlineMs = interactionDeadlineMs(foreground);
    if (deadlineMs !== null) countdown = { kind: "button", deadlineMs };
  } else if (foreground?.kind === "delay") {
    if (factAt(session.instructions, foreground.owningInstruction).kind === "wait")
      countdown = { kind: "wait", deadlineMs: foreground.deadlineMs };
  } else if (foreground?.kind === "chatPacingGate") {
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
  | "popup"
  | "url"
  | "export"
  | "pacing"
  | "media"
  | "save"
  | "photo"
  | "file"
  | "lock"
  | "unlock";

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
  /** `suspended`: a blocking timer that stands still while a block interrupts it. */
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

/** Player Debug's view of where the session is, derived from a published view; see `playerRuntimeDebugNow`. */
export interface PlayerRuntimeDebugNow {
  /** Where execution continues, or `null` once the session ended or failed. */
  readonly next: PlayerDebugSourceLocation | null;
  /** The foreground action the script waits for and the statement that requested it. */
  readonly waitingAt: {
    readonly kind: PlayerDebugWaitKind;
    readonly at: PlayerDebugSourceLocation;
    /**
     * A lock step's openers, never its text, password, or key: whether its dialog asks the player, whether a password
     * was written or its password field asks for one, how many public keys an encrypt call has, whether a decrypt call
     * has a key, its time lock's moment in epoch milliseconds, or `null`, which the lock dialog suggests for a chosen
     * time lock, and the openers the player chooses in the lock dialog.
     */
    readonly lock?: {
      readonly dialog: boolean;
      readonly password: boolean;
      readonly publicKeys: number;
      readonly key: boolean;
      readonly timeLockMs: number | null;
      readonly choices: readonly RuntimeLockChoice[];
    };
  } | null;
  readonly calls: readonly PlayerDebugCall[];
  readonly timers: readonly PlayerDebugTimer[];
  readonly media: readonly PlayerDebugMedia[];
}

function debugLocation(fact: InstructionFact, line = fact.line): PlayerDebugSourceLocation {
  return Object.freeze({ path: fact.path, line });
}

function debugWaitKind(
  instructions: InstructionFacts,
  action: RuntimeForegroundActionSnapshot,
): PlayerDebugWaitKind {
  switch (action.kind) {
    case "delay":
      return factAt(instructions, action.owningInstruction).kind === "wait" ? "wait" : "timer";
    case "interaction":
      return action.interactionKind === "button" ||
        action.interactionKind === "choice" ||
        action.interactionKind === "image" ||
        action.interactionKind === "popup" ||
        action.interactionKind === "url" ||
        action.interactionKind === "export"
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
    case "fileStore":
      return "file";
    case "lock":
      return action.call === "encryptText" || action.call === "encryptFile" ? "lock" : "unlock";
  }
}

/**
 * The active calls, innermost first, also of a failed session, where they are the calls the error happened in, or
 * `null` while the view has no call view (`callView`). Work is proportional to the call depth.
 */
export function playerRuntimeCalls(
  session: Pick<PlayerSession, "state" | "instructions" | "callView">,
): readonly PlayerDebugCall[] | null {
  const { instructions, state: snapshot, callView } = session;
  if (callView === null) return null;
  // Each frame runs in the file that the next inner frame was called from, the innermost in the next statement's file.
  const calls: PlayerDebugCall[] = [];
  let runningIn = factAt(instructions, snapshot.nextInstruction).path;
  for (const call of [...callView.calls].reverse()) {
    const returnFact = factAt(instructions, call.returnInstruction);
    const from =
      call.interruption === null
        ? debugLocation(returnFact, call.callSiteSpan.start.line + 1)
        : debugLocation(returnFact);
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
 * whose foreground action it waits for, the active calls, every timer, hidden ones included, and the active media, or
 * `null` while the view has no call view (`callView`). Paths are package paths, relative to the folder of the entry
 * script. Read-only, from the published view alone; its result shares nothing with the view.
 */
export function playerRuntimeDebugNow(
  session: Pick<PlayerSession, "state" | "instructions" | "callView">,
  nowMs: number,
): PlayerRuntimeDebugNow | null {
  const { instructions, state: snapshot } = session;
  const calls = playerRuntimeCalls(session);
  if (calls === null) return null;
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
    if (action.kind !== "delay" || debugWaitKind(instructions, action) !== "timer") continue;
    timers.push({
      actionId: action.actionId,
      blocking: true,
      display: action.display,
      label: action.label,
      repeat: false,
      state: suspended ? "suspended" : "running",
      remainingMs: Math.max(
        0,
        action.deadlineMs - (suspended ? (snapshot.suspendedAtMs ?? now) : now),
      ),
      startedAt: debugLocation(factAt(instructions, action.owningInstruction)),
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
      startedAt: debugLocation(factAt(instructions, action.owningInstruction)),
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
      startedAt: debugLocation(factAt(instructions, mediaOwners.get(projection.mediaId)!)),
    }),
  );

  return Object.freeze({
    next: active ? debugLocation(factAt(instructions, snapshot.nextInstruction)) : null,
    waitingAt:
      active && foreground !== null
        ? Object.freeze({
            kind: debugWaitKind(instructions, foreground),
            at: debugLocation(factAt(instructions, foreground.owningInstruction)),
            ...(foreground.kind === "lock"
              ? {
                  // The password field of `password: askPassword(...)` is a password opener, not the dialog.
                  lock: Object.freeze({
                    dialog:
                      foreground.phase === "ask" &&
                      (foreground.passwordField === null || foreground.choices.length > 0),
                    password: foreground.password !== null || foreground.passwordField !== null,
                    publicKeys: foreground.publicKeys.length,
                    key: foreground.key !== null,
                    timeLockMs: foreground.timeLockMs,
                    // A copy: the result shares nothing with the view.
                    choices: Object.freeze([...foreground.choices]),
                  }),
                }
              : {}),
          })
        : null,
    calls: active ? calls : Object.freeze([]),
    timers: Object.freeze(
      active
        ? timers.sort((left, right) => left.actionId - right.actionId).map((t) => Object.freeze(t))
        : [],
    ),
    media: Object.freeze(active ? media : []),
  });
}
