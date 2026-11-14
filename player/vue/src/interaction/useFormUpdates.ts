import { computed, shallowRef } from "vue";
import { applyFormUpdate } from "../../../../src/runtime/actions/form/editing.js";
import type { RuntimeInteractionActionSnapshot } from "../../../../src/runtime/actions/model.js";
import {
  activePlayerRuntimeInteraction,
  type PlayerSession,
} from "../../../runtime/runtime-view.js";
import {
  draftInput,
  intents,
  type InputIntent,
  type InputResult,
  type InputSectionHost,
} from "../session/runtime-input.js";
import { refusalMessage } from "./answerNotices.js";
import type { ComposerState, FormDraft } from "./useComposerState.js";

/*
 * A form's updates (PLAYER-UI "Forms"): a field's step, toggle or cycle, a typed field's commit, Back,
 * Clear and the draft timer's store. They are no answers: no pending record, nothing consumed, never greyed, and a
 * refusal undoes nothing but a field's label typed in the chat, whose text comes back; each goes in click order through
 * the session's input sections; a gone question settles silently. A typed field's commit keeps its field read-only, not
 * greyed, until the form answered it (took or refused it) or input closed. The updates sent and not yet
 * answered are counted per form action: the form's Submit and Cancel read that count (`useAnswerSubmission`'s
 * `submitForm`) and skip their local check while it is above zero.
 */

/** The form `session` presents, with its answers so far; `null` for any other interaction or none. */
export function presentedForm(
  session: PlayerSession | null,
): RuntimeInteractionActionSnapshot | null {
  const action = session ? activePlayerRuntimeInteraction(session.state) : null;
  return action?.ui.kind === "form" && action.form !== undefined ? action : null;
}

export function useFormUpdates(host: {
  readonly composer: ComposerState;
  /** The shown session; `null` once stopped or without one. */
  readonly session: () => PlayerSession | null;
  readonly chat: () => number;
  /** The session's activation token (`usePlayerSession`'s `epoch`): an outcome after it moved belongs to no shown session. */
  readonly epoch: () => number;
  /** Whether input is closed (`useAnswerSubmission`'s `closed`): an update then sends nothing. */
  readonly closed: () => boolean;
  readonly inputSection: () => InputSectionHost | undefined;
  /** The input section's run for the presented action (`useAnswerSubmission`'s `run`). */
  readonly run: (actionId: number, intent: InputIntent) => Promise<InputResult>;
  readonly publish: (session: PlayerSession) => void;
  /** The composer's notice (`useAnswerSubmission`'s). */
  readonly showNotice: (message: string) => void;
  readonly clearNotice: () => void;
  readonly unansweredMessage: () => string;
}) {
  const showNotice = host.showNotice;
  const clearNotice = host.clearNotice;
  const run = host.run;
  const closed = host.closed;
  /** Form updates sent and not yet answered, per form action: its Submit then gets no local check. */
  const unacknowledged = new Map<number, number>();
  /** A typed field's commit under way: its field stays read-only until the form answered it or input closed. */
  const commitWindow = shallowRef<{
    readonly actionId: number;
    readonly fieldId: string;
    readonly opening: number;
    readonly revision: number;
  } | null>(null);

  /** A form update, in order with the others; never greyed, no answer, counted in `unacknowledged`. */
  async function update(
    actionId: number,
    intent: InputIntent,
    after?: (result: InputResult) => void,
  ): Promise<void> {
    if (closed()) return;
    const epoch = host.epoch();
    unacknowledged.set(actionId, (unacknowledged.get(actionId) ?? 0) + 1);
    try {
      const sent = await run(actionId, intent);
      // An outcome after a stop or a replacement belongs to no shown session: this controller publishes nothing more and
      // shows no notice; for `after`, nothing took it. What the section published on its own before stays.
      const moved = host.epoch() !== epoch;
      const result: InputResult = moved ? { kind: "retired" } : sent;
      after?.(result);
      if (moved) return;
      if (result.kind === "answered") {
        host.publish(result.session);
        const outcome = result.outcome;
        if (outcome.kind !== "updated" && outcome.kind !== "unchanged")
          showNotice(refusalMessage(outcome));
      } else if (result.kind === "unanswered") showNotice(host.unansweredMessage());
    } finally {
      release(actionId);
    }
  }

  /** Enter in a typed form field: checked at once; its field is read-only until the form answered the commit. */
  function commitField(action: RuntimeInteractionActionSnapshot, input: "enter" | "send") {
    const draft = host.composer.formDraft();
    if (draft === null || action.ui.kind !== "form" || action.form === undefined) return;
    if (commitWindow.value !== null || closed()) return;
    let state = action.form;
    if (state.editor?.text !== draft.text) {
      const drafted = applyFormUpdate(action.ui, state, {
        kind: "draft",
        fieldId: draft.fieldId,
        text: draft.text,
      });
      if (!drafted.ok) return showNotice(drafted.message);
      state = drafted.state;
    }
    const committed = applyFormUpdate(action.ui, state, { kind: "commit", fieldId: draft.fieldId });
    if (!committed.ok) return showNotice(committed.message);
    clearNotice();
    const window = {
      actionId: draft.actionId,
      fieldId: draft.fieldId,
      opening: draft.opening,
      revision: draft.revision,
    };
    commitWindow.value = window;
    void update(action.actionId, intents.composer(draft.text, input), (result) => {
      if (
        result.kind === "answered" &&
        (result.outcome.kind === "updated" || result.outcome.kind === "unchanged")
      )
        host.composer.acknowledge(window);
    }).finally(() => {
      if (commitWindow.value === window) commitWindow.value = null;
    });
  }

  /** A form field's button; typed as its label, the chat's text is the command and comes back on a refusal. */
  function stepField(fieldId: string, typed = false): void {
    const action = presentedForm(host.session());
    if (action === null || closed()) return;
    const chat = host.chat();
    const sent = typed ? host.composer.takeChat() : null;
    void update(
      action.actionId,
      intents.formStep(fieldId, host.composer.formDraft()?.text),
      (result) => {
        const taken =
          result.kind === "answered" &&
          (result.outcome.kind === "updated" || result.outcome.kind === "unchanged");
        if (!taken && sent !== null) host.composer.restoreChat(chat, sent);
      },
    );
  }

  /** Stores the field's draft (`useComposerState`'s timer), counted as an update of its form; whether it took it. */
  async function draft(draft: FormDraft): Promise<boolean> {
    const section = host.inputSection();
    if (!section || closed()) return false;
    const epoch = host.epoch();
    unacknowledged.set(draft.actionId, (unacknowledged.get(draft.actionId) ?? 0) + 1);
    try {
      const drafted = await draftInput(
        section,
        { actionId: draft.actionId, fieldId: draft.fieldId },
        draft.text,
      );
      if (host.epoch() !== epoch) return false;
      if (drafted.session !== null) host.publish(drafted.session);
      return drafted.taken;
    } finally {
      release(draft.actionId);
    }
  }

  function release(actionId: number) {
    const left = (unacknowledged.get(actionId) ?? 1) - 1;
    if (left > 0) unacknowledged.set(actionId, left);
    else unacknowledged.delete(actionId);
  }

  function dismissField(): void {
    const action = presentedForm(host.session());
    if (action === null) return;
    void update(action.actionId, intents.formDismiss);
  }
  function clearField(): void {
    const action = presentedForm(host.session());
    if (action === null) return;
    void update(action.actionId, intents.formClear);
  }

  return {
    /** The updates of form `actionId` sent and not yet answered. */
    unacknowledged: (actionId: number) => unacknowledged.get(actionId) ?? 0,
    /** The typed field whose commit is under way, read-only until the form answered it or input closed. */
    commitWindow: computed(() => commitWindow.value),
    commitField,
    stepField,
    dismissField,
    clearField,
    draft,
  };
}

export type FormUpdates = ReturnType<typeof useFormUpdates>;
