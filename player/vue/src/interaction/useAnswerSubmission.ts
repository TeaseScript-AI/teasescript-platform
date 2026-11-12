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

/** How far an answer went: accepted locally, past its painted frame, handed to the session, settled. */
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
  readonly chat: number;
  readonly lineage: object;
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

export const NO_LONGER_AVAILABLE = "This interaction is no longer available.";

/** One painted frame: the answer shows before an engine on this thread takes it (the in-process backend). */
function paintedFrame(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => {
      setTimeout(resolve, 0);
    }),
  );
}

export function useAnswerSubmission(host: {
  readonly composer: ComposerState;
  /** The form updates Enter in a field or a typed field label sends, and how many of a form's are unanswered. */
  readonly forms: Pick<FormUpdates, "unacknowledged" | "commitField" | "stepField">;
  /** The shown session; `null` once stopped or without one. */
  readonly session: () => PlayerSession | null;
  /** The stopped session, while it shows for the error dialog; its last publication is final once `terminal` is `stopped`. */
  readonly stoppedSession: () => PlayerSession | null;
  readonly chat: () => number;
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
  readonly nextFrame?: () => Promise<void>;
}) {
  const nextFrame = host.nextFrame ?? paintedFrame;
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
   * Settles `record` once: `released` keeps what the runtime published, `undone` puts back what its origin took,
   * `dropped` writes nothing. Every later settlement of the same record does nothing.
   */
  function settle(record: PendingAnswer, how: "released" | "undone" | "dropped", message = "") {
    if (!advance(record, "settled")) return;
    if (pending.value === record) pending.value = null;
    if (how === "undone") {
      if (record.origin === "chat" && record.sent !== null)
        host.composer.restoreChat(record.chat, record.sent);
      if (message) showNotice(message);
      host.undone?.(record);
    }
    admitWaitingUrl();
  }

  /**
   * How the session's end settles `record` as the terminal signal goes from `before` to `after`, or `null` while it
   * waits; the one place that decides, a closed table by the record's stage, whose unnamed cells take the conservative
   * case (undone, nothing published):
   *
   * | `before` → `after`             | accepted, fenced | posted                                                    |
   * | ------------------------------ | ---------------- | --------------------------------------------------------- |
   * | any, in another chat or gone   | dropped          | dropped                                                   |
   * | `null` → `null`                | waits; undone once another session shows in the chat        |
   * | any → `freezing`               | undone           | waits for the final publication                           |
   * | any → `stopped`                | undone           | undone if the final publication still presents its action, else released |
   * | any → `lost`                   | undone           | undone: the outcome is unknown, never sent again          |
   * | `freezing` → `null`            | undone           | undone: a freeze retired without its final publication leaves the outcome unknown |
   * | any other                      | undone           | undone                                                    |
   *
   * `freezing` needs no timer of its own: it ends when the stop's halt settles, acknowledged or rejected
   * (`PlayerBridge.halt`, `stopAt`), or sooner with a loss, a later activation or an unmount.
   */
  function terminalDisposition(
    record: PendingAnswer,
    before: SessionTerminal,
    after: SessionTerminal,
  ): "released" | "undone" | "dropped" | null {
    if (disposed || record.chat !== host.chat()) return "dropped";
    if (before === null && after === null) {
      const shown = host.session();
      // A session another shows in the same chat holds no answer posted to this one. Only the Continue after a lost
      // connection shows one, and the loss settled the answer before it; this keeps that order from mattering.
      return shown !== null && shown.lineage !== record.lineage ? "undone" : null;
    }
    // A record that never reached the host is undone at any end.
    if (record.stage !== "posted") return "undone";
    if (after === "freezing") return null;
    if (after === "stopped") {
      // The final publication decides: an action it still presents was not answered.
      const frozen = host.stoppedSession();
      const live =
        frozen !== null &&
        frozen.lineage === record.lineage &&
        playerRuntimeInteractionActionIds(frozen.state).includes(record.actionId);
      return live ? "undone" : "released";
    }
    // A lost connection, a freeze retired without its final publication, or any other change: the outcome is unknown,
    // so the answer is undone and never sent again.
    return "undone";
  }

  watch(
    () => [host.terminal(), host.chat()] as const,
    ([terminal], [before]) => {
      if (terminal !== null) host.composer.eraseSecrets();
      const record = pending.value;
      if (record === null) return;
      const how = terminalDisposition(record, before, terminal);
      if (how !== null) settle(record, how);
    },
  );

  /** Begins `record`: one painted frame, the fence, then the input section; its outcome settles it. */
  async function dispatch(
    record: PendingAnswer,
    intent: InputIntent,
    onOutcome?: (result: InputResult) => void,
  ) {
    await nextFrame();
    if (record.stage === "settled") return;
    const fenced = terminalDisposition(record, host.terminal(), host.terminal());
    if (fenced !== null) return settle(record, fenced);
    advance(record, "fenced");
    let result: InputResult;
    try {
      // A record settled meanwhile, by the session's end or a later one's preparation, is never posted.
      result = await run(record.actionId, intent, () => advance(record, "posted"));
    } catch (error) {
      settle(record, "undone");
      throw error;
    }
    onOutcome?.(result);
    if (result.kind === "retired") {
      // Not run here, or run before a stop whose final publication decides; otherwise nothing took it.
      const how = terminalDisposition(record, host.terminal(), host.terminal());
      if (how !== null) settle(record, how);
      else if (host.terminal() !== "freezing") settle(record, "undone");
      return;
    }
    if (result.kind === "unanswered") return settle(record, "undone", host.unansweredMessage());
    // Only an answered result publishes; an unavailable action, or any other result, undoes the answer.
    if (result.kind !== "answered") return settle(record, "undone", NO_LONGER_AVAILABLE);
    host.publish(result.session);
    const outcome = result.outcome;
    if (outcome.kind === "completed" || outcome.kind === "updated" || outcome.kind === "unchanged")
      return settle(record, "released");
    settle(record, "undone", refusalMessage(outcome));
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
    if (disposed || session === null || pending.value !== null || host.terminal() !== null)
      return null;
    clearNotice();
    const record: PendingAnswer = {
      chat: host.chat(),
      lineage: session.lineage,
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
    if (action === null || pending.value !== null) return;
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
    if (pending.value !== null || host.session() === null || host.terminal() !== null) return;
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
    if (pending.value !== null || host.terminal() !== null) return;
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
    if (disposed || session === null || action === null) return;
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
    if (pending.value !== null) return;
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
    if (action === null || pending.value !== null) return;
    if (host.forms.unacknowledged(action.actionId) > 0)
      return begin(action, typed ? "chat" : "formCancel", null, typed, intents.formCancel(input));
    answerWith("formCancel", { kind: "cancel" }, intents.formCancel(input), "form", typed);
  }

  /** The pacing gate's skip: no answer, no pending record. */
  async function skipPacing(actionId?: number): Promise<void> {
    const session = host.session();
    if (session === null || host.terminal() !== null) return;
    const gate = actionId ?? playerRuntimePacingGate(session)?.actionId;
    const result = await run(gate, intents.pacing, undefined, "pacing");
    if (result.kind === "answered") host.publish(result.session);
  }

  onScopeDispose(() => {
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

/** The notice of a refused answer or edit. */
export function refusalMessage(outcome: {
  readonly kind: string;
  readonly message?: string;
}): string {
  return outcome.kind === "invalidPayload" && outcome.message !== undefined
    ? outcome.message
    : outcome.kind === "executionPending"
      ? "The script moved on; try again."
      : NO_LONGER_AVAILABLE;
}

export type AnswerSubmission = ReturnType<typeof useAnswerSubmission>;
