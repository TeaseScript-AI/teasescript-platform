import type { PlayerForegroundPresentation } from "../../player/model.js";
import {
  activeInteraction,
  activePlayerRuntimeCapture,
  activePlayerRuntimeFileStore,
  activePlayerRuntimeLock,
  choiceOptionId,
  nextPlayerRuntimeEventMs,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeForeground,
  playerRuntimeForm,
  playerRuntimePermanentButtons,
  type PlayerSessionView,
} from "../../player/runtime-view.js";
import type { RuntimePendingActionSnapshot } from "../../src/runtime/actions/model.js";

/*
 * The K/F tape driver's candidate table (the L5 gate's tape plan, design round 1's construction): one row per kind of
 * the Player's foreground presentation and of the engine's pending actions, each building a finite ordered list of typed
 * requests from what the session shows. A row proposes; it declares nothing eligible. The engine decides each request,
 * and the driver (`driver.ts`) records every attempt and its reply.
 */

/** Every op a candidate can be, and so every op the tapes send besides `start`. */
export const CANDIDATE_OPS = [
  "submitComposer",
  "selectChoice",
  "activateButton",
  "stepFormField",
  "submitForm",
  "cancelForm",
  "skipImage",
  "openUrl",
  "closePopup",
  "closeExport",
  "pressPermanentButton",
  "completeStorageWrite",
  "answerCapture",
  "answerFileStore",
  "answerLock",
  "reportMediaLoad",
  "stepTime",
] as const;
export type CandidateOp = (typeof CANDIDATE_OPS)[number];

/** Where a candidate stands in the session-wide order: active host work, a permanent button, the foreground, time. */
export type CandidateGroup = "host" | "button" | "foreground" | "time";

export interface Candidate {
  readonly op: CandidateOp;
  readonly args: Readonly<Record<string, unknown>>;
  readonly group: CandidateGroup;
  /** The row and the value that built it, for the tape's census. */
  readonly row: string;
}

/** The pinned moment every tape starts at (UTC), whose date and time are the date and time answers. */
export const TAPE_WALL_CLOCK_MS = Date.UTC(2026, 10, 8, 12);
const PINNED_DATE = "2026-11-08";
const PINNED_TIME = "12:00";
const TEXT_ANSWERS = ["test", "yes", "1"];
const NUMBER_ANSWERS = ["5", "1", "10", "30", "0"];
/** The permanent-button cadence: a shown button is pressed on every tenth accepted input. */
export const BUTTON_CADENCE = 10;
/** The duration a medium reports when it is loaded. */
export const MEDIA_DURATION_MS = 6000;

type ForegroundKind = PlayerForegroundPresentation["kind"];
type Foreground<K extends ForegroundKind> = PlayerForegroundPresentation extends infer P
  ? P extends { readonly kind: infer Q }
    ? K extends Q
      ? P
      : never
    : never
  : never;
type PendingKind = RuntimePendingActionSnapshot["kind"];

/** The shown session and the action the foreground answers. */
interface Shown {
  readonly session: PlayerSessionView;
  readonly actionId: number;
}

/** The ops that record how the player answered (`input`); the form's field steps do not (`ops/input.ts`). */
const NO_INPUT: ReadonlySet<CandidateOp> = new Set(["stepFormField"]);

const interaction = (
  op: CandidateOp,
  shown: Shown,
  row: string,
  extra: Record<string, unknown> = {},
): Candidate => ({
  op,
  args: { actionId: shown.actionId, ...extra, ...(NO_INPUT.has(op) ? {} : { input: null }) },
  group: "foreground",
  row,
});
const typed = (
  shown: Shown,
  row: string,
  answers: readonly string[],
  prefill: string | undefined,
) => [
  ...(prefill === undefined
    ? []
    : [interaction("submitComposer", shown, `${row}:prefill`, { text: prefill })]),
  ...answers
    .filter((text) => text !== prefill)
    .map((text) => interaction("submitComposer", shown, `${row}:answer`, { text })),
];

/** The answers a form's value field gets, in order, each with its row: by its editor's input, a number field's bounds last. */
function fieldAnswers(
  session: PlayerSessionView,
  fieldId: string,
  inputType: string,
  inputMode: string,
): { readonly text: string; readonly row: string }[] {
  const answers = (texts: readonly string[]) => texts.map((text) => ({ text, row: "form:answer" }));
  if (inputType === "date") return answers([PINNED_DATE]);
  if (inputType === "time") return answers([PINNED_TIME]);
  if (inputType === "datetime-local") return answers([`${PINNED_DATE}T${PINNED_TIME}`]);
  if (inputMode === "text") return answers(TEXT_ANSWERS);
  const ui = activeInteraction(session.state)?.ui;
  const field =
    ui?.kind === "form" ? ui.fields.find((candidate) => candidate.id === fieldId) : undefined;
  const bounds =
    field !== undefined && "min" in field
      ? [field.min, field.max].filter((bound) => bound !== null)
      : [];
  const bounded = bounds.map(String).filter((text) => !NUMBER_ANSWERS.includes(text));
  return [
    ...answers(NUMBER_ANSWERS),
    ...[...new Set(bounded)].map((text) => ({ text, row: "form:bound" })),
  ];
}

/** The foreground rows: one per kind of `PlayerForegroundPresentation`; a new kind fails `tsc` here. */
export const FOREGROUND_ROWS: {
  readonly [K in ForegroundKind]: (
    shown: Shown,
    presented: Foreground<K>,
    accepted: number,
  ) => Candidate[];
} = {
  choose: (shown, presented, accepted) => {
    const count = presented.options.length;
    return presented.options.map((_, index) => {
      const option = (accepted + index) % count;
      return interaction("selectChoice", shown, "choose", {
        optionId: choiceOptionId(shown.actionId, option),
      });
    });
  },
  "ask-text": (shown, presented) => typed(shown, "ask-text", TEXT_ANSWERS, presented.prefill),
  "ask-number": (shown, presented) => typed(shown, "ask-number", NUMBER_ANSWERS, presented.prefill),
  "ask-date": (shown, presented) => typed(shown, "ask-date", [PINNED_DATE], presented.prefill),
  "ask-time": (shown, presented) => typed(shown, "ask-time", [PINNED_TIME], presented.prefill),
  "ask-datetime": (shown, presented) =>
    typed(shown, "ask-datetime", [`${PINNED_DATE}T${PINNED_TIME}`], presented.prefill),
  "ask-password": (shown) => typed(shown, "ask-password", ["gate"], undefined),
  "show-button": (shown) => [interaction("activateButton", shown, "show-button")],
  "open-url": (shown) => [interaction("openUrl", shown, "open-url")],
  popup: (shown) => [interaction("closePopup", shown, "popup")],
  "export-text": (shown) => [interaction("closeExport", shown, "export-text")],
  form: (shown) => {
    const form = playerRuntimeForm(shown.session);
    const candidates = [interaction("submitForm", shown, "form:as drafted", { draft: null })];
    const editor = form?.editor ?? null;
    // A required value field without a value is opened in the editor first, where its answers are drafted.
    for (const field of form?.fields ?? [])
      if (
        field.kind === "value" &&
        !field.optional &&
        field.state === null &&
        editor?.fieldId !== field.id
      )
        candidates.push(
          interaction("stepFormField", shown, "form:open field", {
            fieldId: field.id,
            draft: null,
          }),
        );
    // Whatever the editor holds: a refused draft stays in it (and is published), and the next answers still follow.
    if (editor !== null && !editor.optional)
      for (const answer of fieldAnswers(
        shown.session,
        editor.fieldId,
        editor.inputType,
        editor.inputMode,
      ))
        candidates.push(interaction("submitForm", shown, answer.row, { draft: answer.text }));
    if (form?.cancel) candidates.push(interaction("cancelForm", shown, "form:cancel"));
    return candidates;
  },
  // This policy represents no image answer: a mandatory image has no candidate (unsupported by this policy).
  "ask-image": (shown, presented) =>
    presented.skip === null ? [] : [interaction("skipImage", shown, "ask-image:skip")],
};

const resource = (
  op: CandidateOp,
  actionId: number,
  row: string,
  answer: Record<string, unknown>,
): Candidate => ({ op, args: { actionId, answer, held: null }, group: "host", row });

/**
 * The pending rows: one per kind of `RuntimePendingActionSnapshot`; a new kind fails `tsc` here. A row gives the host
 * requests that action asks for now; an interaction is the foreground's, and timed work only waits for time.
 */
export const PENDING_ROWS: {
  readonly [K in PendingKind]: (
    session: PlayerSessionView,
    action: Extract<RuntimePendingActionSnapshot, { kind: K }>,
  ) => Candidate[];
} = {
  interaction: () => [],
  delay: () => [],
  chatPacingGate: () => [],
  timer: () => [],
  permanentButton: () => [],
  mediaPlayback: () => [],
  media: (_, action) =>
    action.media.loaded
      ? []
      : [
          {
            op: "reportMediaLoad",
            args: {
              mediaId: action.media.mediaId,
              report: { kind: "loaded", durationMs: MEDIA_DURATION_MS },
            },
            group: "host",
            row: "media:load",
          },
        ],
  storageWrite: (session, action) =>
    pendingPlayerRuntimeStorageWrite(session.state)?.actionId === action.actionId
      ? [
          {
            op: "completeStorageWrite",
            args: { actionId: action.actionId, stored: true },
            group: "host",
            row: "storageWrite",
          },
        ]
      : [],
  capture: (session, action) =>
    activePlayerRuntimeCapture(session.state)?.actionId === action.actionId
      ? [
          resource("answerCapture", action.actionId, "capture:unavailable", {
            kind: "unavailable",
            reason: "unconfigured",
          }),
        ]
      : [],
  fileStore: (session, action) =>
    activePlayerRuntimeFileStore(session.state)?.actionId === action.actionId
      ? [resource("answerFileStore", action.actionId, "fileStore:failed", { kind: "failed" })]
      : [],
  lock: (session, action) => {
    if (activePlayerRuntimeLock(session.state)?.actionId !== action.actionId) return [];
    return action.phase === "work"
      ? [
          resource("answerLock", action.actionId, "lock:work failed", {
            kind: "failed",
            reason: "unavailable",
          }),
        ]
      : [
          resource("answerLock", action.actionId, "lock:ask submitted", { kind: "submitted" }),
          resource("answerLock", action.actionId, "lock:ask cancelled", { kind: "cancelled" }),
        ];
  },
};

/** The pending actions of `session`: its foreground action, then its background ones, in the session's order. */
function pendingActions(session: PlayerSessionView): readonly RuntimePendingActionSnapshot[] {
  const foreground = session.state.foregroundAction;
  return [...(foreground === null ? [] : [foreground]), ...session.state.backgroundActions];
}

function pendingRow(session: PlayerSessionView, action: RuntimePendingActionSnapshot): Candidate[] {
  // EVIDENCE: validation: the row is the one of `action.kind`, so `action` is that row's action.
  const row = PENDING_ROWS[action.kind] as (
    view: PlayerSessionView,
    pending: RuntimePendingActionSnapshot,
  ) => Candidate[];
  return row(session, action);
}

/**
 * The candidates of the next decision, in the session-wide order: active host work, a permanent button on the cadence
 * (`accepted` counts the tape's accepted inputs), the foreground's row, then time at the next deadline.
 */
export function candidatesFor(session: PlayerSessionView, accepted: number): readonly Candidate[] {
  const candidates: Candidate[] = [];
  for (const action of pendingActions(session)) candidates.push(...pendingRow(session, action));
  if (accepted > 0 && accepted % BUTTON_CADENCE === 0)
    for (const button of playerRuntimePermanentButtons(session.state))
      candidates.push({
        op: "pressPermanentButton",
        args: { buttonId: button.buttonId },
        group: "button",
        row: "permanentButton",
      });
  const presented = playerRuntimeForeground(session);
  const action = activeInteraction(session.state);
  if (presented !== null && action !== null) {
    // EVIDENCE: validation: the row is the one of `presented.kind`, so `presented` is that row's presentation.
    const row = FOREGROUND_ROWS[presented.kind] as (
      shown: Shown,
      view: PlayerForegroundPresentation,
      count: number,
    ) => Candidate[];
    candidates.push(...row({ session, actionId: action.actionId }, presented, accepted));
  }
  const next = nextPlayerRuntimeEventMs(session.state);
  if (next !== null)
    candidates.push({ op: "stepTime", args: { targetMs: next }, group: "time", row: "time" });
  return candidates;
}
