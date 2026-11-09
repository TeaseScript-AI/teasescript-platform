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
import type { MediaLoadReport } from "../../src/runtime/operations/media-reports.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import type {
  PlayerCaptureAnswer,
  PlayerFileStoreAnswer,
  PlayerLockAnswer,
} from "../../player/runtime-adapter.js";

/*
 * The K/F tape driver's candidate table (the L5 gate's tape plan, design round 1's construction): one row per kind of
 * the Player's foreground presentation and of the engine's pending actions, each building a finite ordered list of typed
 * requests from what the session shows. A row proposes; it declares nothing eligible. The engine decides each request,
 * and the driver (`driver.ts`) records every attempt and its reply.
 */

/** Each candidate op's arguments, as its host op checks them (`ops/input.ts`, `ops/resources.ts`, `ops/media.ts`, `ops/session.ts`). */
interface CandidateArgs {
  readonly submitComposer: {
    readonly actionId: number;
    readonly text: string;
    readonly input: null;
  };
  readonly selectChoice: {
    readonly actionId: number;
    readonly optionId: string;
    readonly input: null;
  };
  readonly activateButton: { readonly actionId: number; readonly input: null };
  readonly stepFormField: {
    readonly actionId: number;
    readonly fieldId: string;
    readonly draft: string | null;
  };
  readonly submitForm: {
    readonly actionId: number;
    readonly draft: string | null;
    readonly input: null;
  };
  readonly cancelForm: { readonly actionId: number; readonly input: null };
  readonly skipImage: { readonly actionId: number; readonly input: null };
  readonly openUrl: { readonly actionId: number; readonly input: null };
  readonly closePopup: { readonly actionId: number; readonly input: null };
  readonly closeExport: { readonly actionId: number; readonly input: null };
  readonly pressPermanentButton: { readonly buttonId: number };
  readonly completeStorageWrite: { readonly actionId: number; readonly stored: boolean };
  readonly answerCapture: {
    readonly actionId: number;
    readonly answer: PlayerCaptureAnswer;
    readonly held: null;
  };
  readonly answerFileStore: {
    readonly actionId: number;
    readonly answer: PlayerFileStoreAnswer;
    readonly held: null;
  };
  readonly answerLock: {
    readonly actionId: number;
    readonly answer: PlayerLockAnswer;
    readonly held: null;
  };
  readonly reportMediaLoad: { readonly mediaId: number; readonly report: MediaLoadReport };
  readonly stepTime: { readonly targetMs: number };
  // Only a gate fixture's host proposes these (`hosts.ts`); no row of the table does.
  readonly skipPacing: { readonly actionId: number };
  readonly applyStorageEdit: { readonly key: string; readonly value: SerializableRuntimeValue };
}
export type CandidateOp = keyof CandidateArgs;

/** Every op a candidate can be, and so every op the tapes send besides `start` (one entry per `CandidateArgs` op). */
const OPS = {
  submitComposer: true,
  selectChoice: true,
  activateButton: true,
  stepFormField: true,
  submitForm: true,
  cancelForm: true,
  skipImage: true,
  openUrl: true,
  closePopup: true,
  closeExport: true,
  pressPermanentButton: true,
  completeStorageWrite: true,
  answerCapture: true,
  answerFileStore: true,
  answerLock: true,
  reportMediaLoad: true,
  stepTime: true,
  skipPacing: true,
  applyStorageEdit: true,
} as const satisfies Record<CandidateOp, true>;
// EVIDENCE: validation: `OPS` has exactly the keys of `CandidateArgs` (`satisfies Record<CandidateOp, true>`).
export const CANDIDATE_OPS = Object.keys(OPS) as readonly CandidateOp[];

/** Where a candidate stands in the session-wide order: active host work, a permanent button, the foreground, time. */
export type CandidateGroup = "host" | "button" | "foreground" | "time";

/** One proposed request: its op with that op's arguments, its place in the order, and the row that built it. */
export type Candidate = {
  readonly [O in CandidateOp]: {
    readonly op: O;
    readonly args: CandidateArgs[O];
    readonly group: CandidateGroup;
    /** The row and the value class that built it, for the tape's census. */
    readonly row: string;
  };
}[CandidateOp];

/** The pinned moment every tape starts at (UTC), whose date and time are the date and time answers. */
export const TAPE_WALL_CLOCK_MS = Date.UTC(2026, 10, 8, 12);
const PINNED_DATE = "2026-11-08";
const PINNED_TIME = "12:00";
const TEXT_ANSWERS = ["test", "yes", "1"];
const NUMBER_ANSWERS = ["5", "1", "10", "30", "0"];
/** The permanent-button cadence: a shown button is pressed on every tenth accepted input. */
const BUTTON_CADENCE = 10;
/** The duration a medium reports when it is loaded. */
const MEDIA_DURATION_MS = 6000;

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

/** The foreground ops, which answer the presented action. */
type InteractionOp = {
  readonly [O in CandidateOp]: CandidateArgs[O] extends {
    readonly actionId: number;
    readonly input: null;
  }
    ? O
    : never;
}[CandidateOp];

const interaction = <O extends InteractionOp>(
  op: O,
  shown: Shown,
  row: string,
  extra: Omit<CandidateArgs[O], "actionId" | "input">,
): Candidate =>
  // EVIDENCE: validation: `args` is `CandidateArgs[O]` (the action ID, `extra`, and no `input`), the op's own arguments.
  ({
    op,
    args: { actionId: shown.actionId, ...extra, input: null },
    group: "foreground",
    row,
  }) as Candidate;
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
const FOREGROUND_ROWS: {
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
  "show-button": (shown) => [interaction("activateButton", shown, "show-button", {})],
  "open-url": (shown) => [interaction("openUrl", shown, "open-url", {})],
  popup: (shown) => [interaction("closePopup", shown, "popup", {})],
  "export-text": (shown) => [interaction("closeExport", shown, "export-text", {})],
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
        candidates.push({
          op: "stepFormField",
          args: { actionId: shown.actionId, fieldId: field.id, draft: null },
          group: "foreground",
          row: "form:open field",
        });
    // Whatever the editor holds: a refused draft stays in it (and is published), and the next answers still follow.
    if (editor !== null && !editor.optional)
      for (const answer of fieldAnswers(
        shown.session,
        editor.fieldId,
        editor.inputType,
        editor.inputMode,
      ))
        candidates.push(interaction("submitForm", shown, answer.row, { draft: answer.text }));
    if (form?.cancel) candidates.push(interaction("cancelForm", shown, "form:cancel", {}));
    return candidates;
  },
  // This policy represents no image answer: a mandatory image has no candidate (unsupported by this policy).
  "ask-image": (shown, presented) =>
    presented.skip === null ? [] : [interaction("skipImage", shown, "ask-image:skip", {})],
};

const capture = (actionId: number, row: string, answer: PlayerCaptureAnswer): Candidate => ({
  op: "answerCapture",
  args: { actionId, answer, held: null },
  group: "host",
  row,
});
const fileStore = (actionId: number, row: string, answer: PlayerFileStoreAnswer): Candidate => ({
  op: "answerFileStore",
  args: { actionId, answer, held: null },
  group: "host",
  row,
});
const lock = (actionId: number, row: string, answer: PlayerLockAnswer): Candidate => ({
  op: "answerLock",
  args: { actionId, answer, held: null },
  group: "host",
  row,
});

/**
 * The pending rows: one per kind of `RuntimePendingActionSnapshot`; a new kind fails `tsc` here. A row gives the host
 * requests that action asks for now; an interaction is the foreground's, and timed work only waits for time.
 */
const PENDING_ROWS: {
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
          capture(action.actionId, "capture:unavailable", {
            kind: "unavailable",
            reason: "unconfigured",
          }),
        ]
      : [],
  fileStore: (session, action) =>
    activePlayerRuntimeFileStore(session.state)?.actionId === action.actionId
      ? [fileStore(action.actionId, "fileStore:failed", { kind: "failed" })]
      : [],
  lock: (session, action) => {
    if (activePlayerRuntimeLock(session.state)?.actionId !== action.actionId) return [];
    return action.phase === "work"
      ? [lock(action.actionId, "lock:work failed", { kind: "failed", reason: "unavailable" })]
      : [
          lock(action.actionId, "lock:ask submitted", { kind: "submitted" }),
          lock(action.actionId, "lock:ask cancelled", { kind: "cancelled" }),
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
