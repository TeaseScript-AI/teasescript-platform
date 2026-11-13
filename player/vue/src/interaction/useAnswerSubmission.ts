import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import {
  resolveAnswer,
  routeComposerText,
  type ComposerRoute,
} from "../../../../src/interaction-completion.js";
import { invalidAnswerMessage } from "../../../../src/interaction-answers.js";
import { IMAGE_ANSWER_TRANSCRIPT_TEXT } from "../../../../src/image-input.js";
import {
  applyFormUpdate,
  formSummaryOf,
  type FormSummaryLine,
} from "../../../../src/runtime/actions/form.js";
import type { PlayerTranscriptEntryPresentation } from "../../../presentation/model.js";
import type { RuntimeInteractionActionSnapshot } from "../../../../src/runtime/actions/model.js";
import {
  activePlayerRuntimeInteraction,
  answerRenderKey,
  playerRuntimeUrlRequest,
  choiceOptionId,
  playerRuntimeInteractionActionIds,
  playerRuntimePacingGate,
  type PlayerSession,
} from "../../../runtime/runtime-view.js";
import {
  intents,
  runInput,
  type InputIntent,
  type InputResult,
  type InputSectionHost,
} from "../session/runtime-input.js";
import type { ComposerState } from "./useComposerState.js";
import type { FormUpdates } from "./useFormUpdates.js";

/*
 * The answers the player gives (PLAYER-UI "Composer and foreground interactions"; decisions of 2026-11-11/12): each is
 * checked at once with the runtime's own rule (`src/interaction-completion.ts`). A locally invalid answer never leaves
 * the composer and shows the notice at once. A valid one is the one pending answer: its controls go at once, and the
 * runtime, which stays the authority, settles it. A refusal undoes it by its origin; the session's end settles it once
 * by its stage. Form edits are no answers: they go in order, never greyed, and a field's commit keeps its field
 * read-only, not greyed, until the form took it.
 */

/** What an answer was given with, which decides what a refusal puts back. */
export type AnswerOrigin =
  | "chat"
  | "temporal"
  | "formSubmit"
  | "formCancel"
  | "choice"
  | "button"
  | "image"
  | "password"
  | "popup"
  | "export"
  | "url";

/** How far an answer went: accepted locally, past its wait before the post (`beforePost`), handed to the session, settled. */
export type AnswerStage = "accepted" | "fenced" | "posted" | "settled";

/** The answer's line in the chat as the shared rule predicts it, until the runtime's own replaces it. */
export interface PredictedAnswer {
  readonly text: string;
  readonly responseKind?: "choice" | "button" | "form";
  /** A submitted form's lines, as the runtime's summary of the same answers shows them. */
  readonly formSummary?: readonly FormSummaryLine[];
}

/** The one answer under way: what it answered, how, and how far it went. */
export interface PendingAnswer {
  /** Its token, taken at `accept`: the chat and the session's `epoch`. Once either moved, they decide its settlement. */
  readonly chat: number;
  readonly epoch: number;
  readonly actionId: number;
  readonly origin: AnswerOrigin;
  /** The chat text it sent, which a refusal puts back; only for the `chat` origin. */
  readonly sent: string | null;
  readonly row: PredictedAnswer | null;
  /**
   * The line the transcript shows for it until the runtime's own takes its row over: the predicted text in the style the
   * player's answer had when it was given, under the answer's row key (`answerRenderKey`).
   */
  readonly entry: PlayerTranscriptEntryPresentation | null;
  /** Moves forward only, through `advance`. */
  readonly stage: AnswerStage;
}

const STAGES: readonly AnswerStage[] = ["accepted", "fenced", "posted", "settled"];

/** Moves `record` forward to `stage`, the one writer of a stage: never back, and nothing after `settled`. */
function advance(record: PendingAnswer, stage: AnswerStage): boolean {
  if (STAGES.indexOf(stage) <= STAGES.indexOf(record.stage)) return false;
  // EVIDENCE: invariant: every record is this module's own object literal; `stage` is read-only to every other reader.
  (record as { stage: AnswerStage }).stage = stage;
  return true;
}

/** Where the session stands for input: stopping until its final publication shows, stopped, or its connection lost. */
export type SessionTerminal = "freezing" | "stopped" | "lost" | null;

/** The notice of an answer or edit that arrived after its question was gone. */
export const QUESTION_GONE = "The question was gone before your answer arrived.";
/** `QUESTION_GONE`, saying so where the answer's typed text came back to the composer. */
export const questionGone = (textBack: boolean) =>
  textBack ? `${QUESTION_GONE} Your text is back in the field.` : QUESTION_GONE;

/** Whether undoing `record` puts typed text back in the composer: only the chat's own text comes back. */
const returnsText = (record: PendingAnswer): record is PendingAnswer & { readonly sent: string } =>
  record.origin === "chat" && record.sent !== null;

export function useAnswerSubmission(host: {
  readonly composer: ComposerState;
  /** The form updates Enter in a field or a typed field label sends, and how many of a form's are unanswered. */
  readonly forms: Pick<FormUpdates, "unacknowledged" | "commitField" | "stepField">;
  /** The shown session; `null` once stopped or without one. */
  readonly session: () => PlayerSession | null;
  /** The stopped session, while it shows for the error dialog; its last publication is final once `terminal` is `stopped`. */
  readonly stoppedSession: () => PlayerSession | null;
  readonly chat: () => number;
  /** The session's activation token (`usePlayerSession`'s `epoch`), read when an answer is admitted. */
  readonly epoch: () => number;
  /** The `epoch` the shown session was shown under (`usePlayerSession`'s `inputEpoch`). */
  readonly inputEpoch: () => number;
  /** Registers work run as `epoch` moves (`usePlayerSession`'s `onEpoch`); the returned function removes it. */
  readonly onEpoch: (work: () => void) => () => void;
  readonly terminal: () => SessionTerminal;
  readonly inputSection: () => InputSectionHost | undefined;
  readonly prepareInput: () => true | Promise<boolean>;
  readonly publish: (session: PlayerSession) => void;
  /** The notice for typed text that answers nothing here (`RuntimeInteraction`'s presentation of the request). */
  readonly unansweredMessage: () => string;
  /** Submits the lock's password (`LockService.submit`). */
  readonly submitLock: (password: string) => void;
  /** After a refusal or the session's end put an answer back (`RuntimeInteraction`'s focus). */
  readonly undone?: (record: PendingAnswer) => void;
  /**
   * Awaited between an answer's admission and its post, where a test holds it; by default a microtask. The engine runs in
   * its Worker, so the answer shows in the next frame whatever the post costs.
   */
  readonly beforePost?: () => Promise<void>;
}) {
  const beforePost = host.beforePost ?? (() => Promise.resolve());
  const pending = shallowRef<PendingAnswer | null>(null);
  const notice = ref("");
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  /** Whether an `openUrl` request waits for the pending answer to settle, and those already tried, by session lineage. */
  let urlWaiting = false;
  const urlTried = new WeakMap<object, Set<number>>();

  function showNotice(message: string) {
    clearNotice();
    if (!message) return;
    notice.value = message;
    noticeTimer = setTimeout(clearNotice, 6000);
  }
  function clearNotice() {
    clearTimeout(noticeTimer);
    noticeTimer = undefined;
    notice.value = "";
  }

  const presentedAction = (session: PlayerSession | null) =>
    session ? activePlayerRuntimeInteraction(session.state) : null;

  /**
   * Whether input is closed: the session stops, or it stopped or was replaced since it was shown, also once its level went
   * back (`inputEpoch`). Closed input shows nothing, sends nothing and leaves the composer's text as it is.
   */
  const closed = () => host.terminal() !== null || host.epoch() !== host.inputEpoch();

  // As the token moves (a stop, a lost connection, a replacement), at once: the secrets go, and the notice goes with its
  // timer. The chat's text stays: a stop never changes what was typed. A form draft waiting to be stored is refused when
  // its timer asks (`closed`).
  const offEpoch = host.onEpoch(() => {
    host.composer.eraseSecrets();
    clearNotice();
  });

  /**
   * Settles `record` once: `released` keeps what the runtime published, `undone` puts back what its origin took,
   * `dropped` writes nothing. Every later settlement of the same record does nothing.
   */
  function settle(record: PendingAnswer, how: "released" | "undone" | "dropped", message = "") {
    if (!advance(record, "settled")) return;
    if (pending.value === record) pending.value = null;
    if (how === "undone") {
      if (returnsText(record)) host.composer.restoreChat(record.chat, record.sent);
      if (message) showNotice(message);
      host.undone?.(record);
    }
    admitWaitingUrl();
  }

  /** Whether `record`'s token still holds: its chat shows and no stop or replacement has taken a new epoch since. */
  function current(record: PendingAnswer): boolean {
    return record.chat === host.chat() && record.epoch === host.epoch();
  }

  /**
   * How `record` settles now, or `null` while it waits; the one place that decides, a closed table over its token, the
   * terminal level and its stage, whose unnamed cells take the conservative case (undone, nothing published). Every
   * change of the level but `freezing` → `stopped` comes with a new epoch, so a level that left and came back still
   * shows in the token:
   *
   * | now                                       | accepted, fenced | posted                                               |
   * | ----------------------------------------- | ---------------- | ---------------------------------------------------- |
   * | another chat, or unmounted                | dropped          | dropped                                              |
   * | its token holds, the session runs         | waits: its outcome decides                              |
   * | `freezing`                                | undone           | waits for the final publication                      |
   * | `stopped`                                 | undone           | undone if the final publication still presents its action, else released |
   * | anything else: lost, or another epoch     | undone           | undone: the outcome is unknown, never sent again     |
   *
   * `freezing` needs no timer of its own: it ends when the stop's halt settles, acknowledged or rejected
   * (`PlayerBridge.halt`, `stopAt`), or sooner with a loss, a later activation or an unmount.
   */
  function disposition(record: PendingAnswer): "released" | "undone" | "dropped" | null {
    if (disposed || record.chat !== host.chat()) return "dropped";
    const terminal = host.terminal();
    if (current(record) && terminal === null) return null;
    // A record that never reached the host is undone at any end.
    if (record.stage !== "posted") return "undone";
    if (terminal === "freezing") return null;
    if (terminal === "stopped") {
      // The final publication decides: an action it still presents was not answered. Its session is the record's: the
      // chat is, and the only other session a chat shows is the recovery's Continue, after a loss that undid it.
      const frozen = host.stoppedSession();
      const live =
        frozen !== null &&
        playerRuntimeInteractionActionIds(frozen.state).includes(record.actionId);
      return live ? "undone" : "released";
    }
    // A lost connection, a freeze retired without its final publication, a replacement: the outcome is unknown, so the
    // answer is undone and never sent again.
    return "undone";
  }

  // One getter returning a new array: once a read of either value dirtied it, the callback runs even when both read as
  // before, so a record whose level went to `freezing` and back between two flushes still settles by its token.
  watch(
    () => [host.terminal(), host.chat()] as const,
    () => {
      const record = pending.value;
      if (record === null) return;
      const how = disposition(record);
      if (how !== null) settle(record, how);
    },
  );

  /** Begins `record`: after `beforePost`, the input section, which posts it only while its token holds. */
  async function dispatch(
    record: PendingAnswer,
    intent: InputIntent,
    onOutcome?: (result: InputResult) => void,
  ) {
    await beforePost();
    if (record.stage === "settled") return;
    advance(record, "fenced");
    let result: InputResult;
    try {
      // A record settled meanwhile, or whose session stopped or was replaced, is never posted.
      result = await run(
        record.actionId,
        intent,
        () => current(record) && advance(record, "posted"),
      );
    } catch (error) {
      settle(record, "undone");
      throw error;
    }
    onOutcome?.(result);
    // After a stop or a replacement the token decides, not the outcome; a posted answer waits for a freeze to end.
    const how = disposition(record);
    if (how !== null) return settle(record, how);
    if (!current(record) || host.terminal() !== null) return;
    if (result.kind === "retired") return settle(record, "undone");
    if (result.kind === "unanswered") return settle(record, "undone", host.unansweredMessage());
    // Only an answered result publishes; an unavailable action, or any other result, undoes the answer.
    if (result.kind !== "answered")
      return settle(record, "undone", questionGone(returnsText(record)));
    host.publish(result.session);
    const outcome = result.outcome;
    if (outcome.kind === "completed" || outcome.kind === "updated" || outcome.kind === "unchanged")
      return settle(record, "released");
    settle(record, "undone", refusalMessage(outcome, returnsText(record)));
  }

  /** The input section's run for the presented action, readying an inspected state first. */
  async function run(
    actionId: number | undefined,
    intent: InputIntent,
    admit?: () => boolean,
    target: "interaction" | "pacing" = "interaction",
  ): Promise<InputResult> {
    const ready = host.prepareInput();
    if (ready !== true && !(await ready)) return { kind: "retired" };
    const section = host.inputSection();
    if (!section) return { kind: "retired" };
    const targetId = (current: PlayerSession) =>
      target === "pacing"
        ? playerRuntimePacingGate(current)?.actionId
        : activePlayerRuntimeInteraction(current.state)?.actionId;
    return runInput(section, actionId, targetId, intent, admit);
  }

  /** Accepts an answer to the presented action: it is pending, its controls are gone, its text has left. */
  function accept(
    action: RuntimeInteractionActionSnapshot,
    origin: AnswerOrigin,
    row: PredictedAnswer | null,
    sent: string | null = null,
  ): PendingAnswer | null {
    const session = host.session();
    if (disposed || session === null || pending.value !== null || closed()) return null;
    clearNotice();
    const record: PendingAnswer = {
      chat: host.chat(),
      epoch: host.epoch(),
      actionId: action.actionId,
      origin,
      sent,
      row,
      entry:
        row === null
          ? null
          : Object.freeze({
              kind: "message",
              id: `predicted-${answerRenderKey(action.actionId)}`,
              renderKey: answerRenderKey(action.actionId),
              speakerId: "user",
              text: row.text,
              presentation: session.state.answerPresentation,
              ...(row.responseKind ? { responseKind: row.responseKind } : {}),
              ...(row.formSummary ? { formSummary: row.formSummary } : {}),
            }),
      stage: "accepted",
    };
    pending.value = record;
    return record;
  }

  /** The runtime's check of `payload` for `action`, with the shown session's presentation. */
  function check(action: RuntimeInteractionActionSnapshot, payload: Record<string, unknown>) {
    const session = host.session()!;
    return resolveAnswer(
      action,
      payload,
      { presentation: session.state.temporalPresentation },
      undefined,
    );
  }

  /**
   * Answers the presented action with `payload` through `intent`, after the shared check. With `typed`, the answer is
   * the chat's text, which then leaves the composer and comes back on a refusal.
   */
  function answerWith(
    origin: AnswerOrigin,
    payload: Record<string, unknown>,
    intent: InputIntent,
    responseKind?: PredictedAnswer["responseKind"],
    typed = false,
  ): void {
    const action = presentedAction(host.session());
    if (action === null || pending.value !== null || closed()) return;
    const resolved = check(action, payload);
    if (!resolved.ok) return showNotice(resolved.message);
    const row =
      resolved.transcriptText === null
        ? null
        : { text: resolved.transcriptText, ...(responseKind ? { responseKind } : {}) };
    begin(action, typed ? "chat" : origin, row, typed, intent);
  }

  /** Accepts and dispatches; a typed answer takes the chat's text along. */
  function begin(
    action: RuntimeInteractionActionSnapshot,
    origin: AnswerOrigin,
    row: PredictedAnswer | null,
    typed: boolean,
    intent: InputIntent,
  ) {
    if (pending.value !== null || host.session() === null || closed()) return;
    const sent = typed ? host.composer.takeChat() : null;
    const record = accept(action, origin, row, sent);
    if (record !== null) void dispatch(record, intent);
  }

  /** Enter or Send in the composer, for the slot it shows (decision 6: nothing while an answer is pending). */
  function send(source: "input" | "button"): void {
    const composer = host.composer;
    const tenant = composer.tenant.value;
    if (tenant.kind === "lock") {
      const entry = composer.lockEnter();
      if (entry.kind === "mismatch") showNotice(invalidAnswerMessage("passwordMismatch"));
      else if (entry.kind === "match") host.submitLock(entry.password);
      else if (entry.kind === "repeat") clearNotice();
      return;
    }
    if (pending.value !== null || closed()) return;
    const action = presentedAction(host.session());
    if (action === null) return;
    const input = source === "input" ? "enter" : "send";
    if (tenant.kind === "form") return host.forms.commitField(action, input);
    const text = composer.current();
    const route = routeComposerText(action, text);
    if (route === null) return showNotice(host.unansweredMessage());
    sendRoute(action, route, text, input, tenant.kind === "temporal" ? "temporal" : "chat");
  }

  function sendRoute(
    action: RuntimeInteractionActionSnapshot,
    route: ComposerRoute,
    text: string,
    input: "enter" | "send",
    origin: "chat" | "temporal",
  ) {
    const intent = intents.composer(text, input);
    const typed = origin === "chat";
    switch (route.kind) {
      case "password": {
        const record = accept(action, "password", null);
        if (record === null) return;
        host.composer.erasePassword();
        void dispatch(record, intent);
        return;
      }
      case "imageSkip":
        return answerWith("image", { kind: "skip" }, intent, undefined, typed);
      case "formSubmit":
        return submitForm(input, typed);
      case "formCancel":
        return cancelForm(input, typed);
      case "formStep":
        return host.forms.stepField(route.fieldId, typed);
      case "formCommit":
        return;
      case "complete":
        return answerWith(
          origin,
          { ...route.payload },
          intent,
          action.interactionKind === "choice"
            ? "choice"
            : action.interactionKind === "button"
              ? "button"
              : undefined,
          typed,
        );
    }
  }

  /** A choice's button, or `showButton`'s for `null`: clicked, or the preselected one by Space (`preselectedKey`). */
  function choose(optionId: string | null, input: "button" | "preselectedKey" = "button"): void {
    const action = presentedAction(host.session());
    if (action === null) return;
    if (optionId === null) {
      answerWith("button", { kind: "activate" }, intents.choice(null, input), "button");
      return;
    }
    if (action.ui.kind !== "choice") return;
    const optionIndex = action.ui.options.findIndex(
      (_option, index) => choiceOptionId(action.actionId, index) === optionId,
    );
    if (optionIndex === -1) return;
    answerWith(
      "choice",
      { kind: "selectedOption", optionIndex },
      intents.choice(optionId, input),
      "choice",
    );
  }

  function closePopup(): void {
    answerWith("popup", { kind: "activate" }, intents.popupClose("button"));
  }
  function closeExport(): void {
    answerWith("export", { kind: "close" }, intents.exportClose("button"));
  }
  function skipImage(): void {
    answerWith("image", { kind: "skip" }, intents.imageSkip("button"));
  }

  /**
   * "Use image": answers with the preview, which the page's own store holds (the capture offers "Use image" only with
   * one), so its line is the image answer's.
   */
  function useImage(intent: InputIntent): void {
    const action = presentedAction(host.session());
    if (action === null || action.ui.kind !== "image") return;
    begin(action, "image", { text: IMAGE_ANSWER_TRANSCRIPT_TEXT }, false, intent);
  }

  /**
   * The `openUrl` button, or the request the Player opens at once (`auto`), only one its session's own run requested
   * (`atOnce`): that one waits while another answer is pending, and is tried once per request, counted when it is
   * admitted as the pending answer.
   */
  function openUrl(open: (session: PlayerSession) => boolean, auto: boolean): void {
    const session = host.session();
    const action = presentedAction(session);
    if (disposed || session === null || action === null || closed()) return;
    const tried = urlTried.get(session.lineage) ?? new Set<number>();
    if (auto) {
      if (
        tried.has(action.actionId) ||
        playerRuntimeUrlRequest(session)?.atOnce !== true ||
        host.inputSection() === undefined
      )
        return;
      if (pending.value !== null) {
        urlWaiting = true;
        return;
      }
    }
    const record = accept(action, "url", null);
    if (record === null) return;
    if (auto) urlTried.set(session.lineage, tried.add(action.actionId));
    void dispatch(record, intents.url(open, auto ? null : "button"));
  }
  let openAtOnce: ((session: PlayerSession) => boolean) | null = null;
  /** Registers how an `openUrl` request opens its tab, for the request admitted after a pending answer settles. */
  function urlOpener(open: (session: PlayerSession) => boolean) {
    openAtOnce = open;
  }
  /**
   * Once the pending answer settled, asks again for an automatic request that waited: `openUrl` checks everything on
   * what is presented now, so only a request the shown session still presents, asks to open at once and never tried
   * is admitted, whichever chat or session asked first.
   */
  function admitWaitingUrl() {
    const waiting = urlWaiting;
    urlWaiting = false;
    if (waiting && openAtOnce !== null) openUrl(openAtOnce, true);
  }

  function presentedForm(): RuntimeInteractionActionSnapshot | null {
    const action = presentedAction(host.session());
    return action?.ui.kind === "form" && action.form !== undefined ? action : null;
  }

  /** The draft the form's step, Submit or Back takes along, from the field being edited. */
  function formDraftText(): string | undefined {
    return host.composer.formDraft()?.text;
  }

  /**
   * Submit: checked with the form as shown, the field being edited committed first. While an update of this form is
   * not yet answered, it goes unchecked and without a predicted line: the runtime's outcome shows either (rule 6).
   */
  function submitForm(input: "enter" | "send" | "button" = "button", typed = false): void {
    const action = presentedForm();
    if (action === null || action.ui.kind !== "form" || action.form === undefined) return;
    if (pending.value !== null || closed()) return;
    const draft = formDraftText();
    const intent = intents.formSubmit(draft, input);
    if (host.forms.unacknowledged(action.actionId) > 0)
      return begin(action, typed ? "chat" : "formSubmit", null, typed, intent);
    let state = action.form;
    if (state.editor !== null && draft !== undefined) {
      for (const step of [
        ...(state.editor.text === draft
          ? []
          : [{ kind: "draft", fieldId: state.editor.fieldId, text: draft }]),
        { kind: "commit", fieldId: state.editor.fieldId },
      ]) {
        const next = applyFormUpdate(action.ui, state, step);
        if (!next.ok) return showNotice(next.message);
        state = next.state;
      }
    }
    const resolved = resolveAnswer(
      { ...action, form: state },
      { kind: "submit" },
      { presentation: host.session()!.state.temporalPresentation },
      undefined,
    );
    if (!resolved.ok) return showNotice(resolved.message);
    const summary = resolved.temporalPresentation
      ? formSummaryOf(
          action.ui,
          resolved.result,
          resolved.shownOptions,
          resolved.temporalPresentation,
        )
      : null;
    begin(
      action,
      typed ? "chat" : "formSubmit",
      {
        text: resolved.transcriptText ?? "",
        responseKind: "form",
        ...(summary === null ? {} : { formSummary: summary }),
      },
      typed,
      intent,
    );
  }

  function cancelForm(input: "enter" | "send" | "button" = "button", typed = false): void {
    const action = presentedForm();
    if (action === null || pending.value !== null || closed()) return;
    if (host.forms.unacknowledged(action.actionId) > 0)
      return begin(action, typed ? "chat" : "formCancel", null, typed, intents.formCancel(input));
    answerWith("formCancel", { kind: "cancel" }, intents.formCancel(input), "form", typed);
  }

  /** The pacing gate's skip: no answer, no pending record. */
  async function skipPacing(actionId?: number): Promise<void> {
    const session = host.session();
    if (session === null || closed()) return;
    const gate = actionId ?? playerRuntimePacingGate(session)?.actionId;
    const result = await run(gate, intents.pacing, undefined, "pacing");
    if (result.kind === "answered") host.publish(result.session);
  }

  onScopeDispose(() => {
    offEpoch();
    disposed = true;
    urlWaiting = false;
    clearNotice();
    const record = pending.value;
    if (record) settle(record, "dropped");
  });

  return {
    pending: computed(() => pending.value),
    /** The answer's line the transcript shows while the answer is pending, or `null`. */
    predicted: computed(() => pending.value?.entry ?? null),
    /** The action whose controls an answer took; they are not shown, and no input reaches it. */
    consumed: computed(() => pending.value?.actionId ?? null),
    notice: computed(() => notice.value),
    clearNotice,
    showNotice,
    send,
    choose,
    closePopup,
    closeExport,
    skipImage,
    useImage,
    openUrl,
    urlOpener,
    submitForm,
    cancelForm,
    skipPacing,
    run,
  };
}

/** The notice of a refused answer or edit; `textBack` when its typed text came back to the composer. */
export function refusalMessage(
  outcome: { readonly kind: string; readonly message?: string },
  textBack = false,
): string {
  return outcome.kind === "invalidPayload" && outcome.message !== undefined
    ? outcome.message
    : outcome.kind === "executionPending"
      ? "The script moved on; try again."
      : questionGone(textBack);
}

export type AnswerSubmission = ReturnType<typeof useAnswerSubmission>;
