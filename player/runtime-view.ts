import type { InteractionAccessibleName } from "../src/plan/model.js";
import { IMAGE_SKIP_TEXT } from "../src/image-input.js";
import { PLAYER } from "../src/speaker-terms.js";
import { DEFAULT_TEMPORAL_CONTEXT, type TemporalContext } from "../src/temporal.js";
import { captureTemporalContext } from "../src/temporal-capture.js";
import { actionAwaitsHost } from "../src/runtime/actions/interrupts.js";
import type {
  RuntimeCaptureActionSnapshot,
  RuntimeChatPacingGateActionSnapshot,
  RuntimeFileStoreActionSnapshot,
  RuntimeInteractionActionSnapshot,
  RuntimeLockActionSnapshot,
  RuntimeStorageWriteActionSnapshot,
} from "../src/runtime/actions/model.js";
import { formSummaryOf, type FormSummaryLine } from "../src/runtime/actions/form.js";
import {
  mediaTerminalProgressMs,
  nextMediaEvent,
  repeatsSilently,
  type RuntimeMediaSnapshot,
} from "../src/runtime/background/media.js";
import type {
  MediaPlaybackProjection,
  StageProjection,
} from "../src/runtime/background/media-projection.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { runtimeTimedWork, type RuntimeTimedWork } from "../src/runtime/operations/timed-work.js";
import type { RuntimeSessionView } from "../src/runtime/session.js";
import type {
  PlayerForegroundPresentation,
  PlayerMessagePresentation,
  PlayerPermanentButtonPresentation,
  PlayerSpeakerPresentation,
  PlayerTimerPresentation,
  PlayerTranscriptEntryPresentation,
} from "./model.js";
import type { PlayerRuntimeSession, PlayerRuntimeState } from "./runtime-adapter.js";

// What the Player reads from a session's published state, without the engine: the foreground, timers, deadlines,
// media, buttons and the transcript. These readers run in the main realm; the engine's operations stay in
// `runtime-adapter.ts` (`player/engine-bridge/inventory.ts` lists both).

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
  state: PlayerRuntimeState,
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
export function playerRuntimeDeadlines(state: PlayerRuntimeState): readonly number[] {
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
  session: PlayerRuntimeSession,
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
  state: PlayerRuntimeState,
): RuntimeCaptureActionSnapshot | null {
  const action = state.status === "waiting" ? state.foregroundAction : null;
  return action?.kind === "capture" ? action : null;
}

/** The file store the session waits for, or `null`. */
export function activePlayerRuntimeFileStore(
  state: PlayerRuntimeState,
): RuntimeFileStoreActionSnapshot | null {
  const action = state.status === "waiting" ? state.foregroundAction : null;
  return action?.kind === "fileStore" ? action : null;
}

/** The lock step the session waits for, or `null`; while an expiry block runs, its dialog is not one. */
export function activePlayerRuntimeLock(
  state: PlayerRuntimeState,
): RuntimeLockActionSnapshot | null {
  const action = state.status === "waiting" ? state.foregroundAction : null;
  return action?.kind === "lock" ? action : null;
}

/** The questions that can still be answered: the presented one and one that a running block suspended. */
export function playerRuntimeInteractionActionIds(state: PlayerRuntimeState): readonly number[] {
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
  session: PlayerRuntimeSession,
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
export function nextPlayerRuntimeEventMs(state: PlayerRuntimeState): number | null {
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
  state: PlayerRuntimeState,
): readonly PlayerPermanentButtonPresentation[] {
  if (state.status !== "running" && state.status !== "waiting") return Object.freeze([]);
  return Object.freeze(
    state.permanentButtons.map((button) =>
      Object.freeze({ buttonId: button.buttonId, label: button.text, busy: button.busy }),
    ),
  );
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

/** The `save`/`delete` waiting for the host to persist it, if any. */
export function pendingPlayerRuntimeStorageWrite(
  state: PlayerRuntimeState,
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
  session: PlayerRuntimeSession,
  entryId: string,
): PlayerMessagePresentation | null {
  const sequence = playerRuntimeTranscriptEventSequence(entryId);
  const index = sequence === null ? undefined : session.transcriptMessageRows.get(sequence);
  const entry = index === undefined ? undefined : session.transcriptEntries[index];
  return entry?.kind === "message" ? entry : null;
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
