import { computed, shallowRef } from "vue";
import { applyFormUpdate } from "../../../../src/runtime/actions/form.js";
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
import {
  NO_LONGER_AVAILABLE,
  refusalMessage,
  type SessionTerminal,
} from "./useAnswerSubmission.js";
import type { ComposerState, FormDraft } from "./useComposerState.js";

/*
 * A form's updates (PLAYER-UI "Forms"): a field's step, toggle or cycle, a typed field's commit, Back,
 * Clear and the draft timer's store. They are no answers: no pending record, nothing consumed, no undo, never greyed;
 * each goes in click order through the session's input sections, and a refusal shows the notice. A typed field's
 * commit keeps its field read-only, not greyed, until the form took it or refused it. The updates sent and not yet
 * answered are counted per form action: the form's Submit and Cancel read that count (`useAnswerSubmission`, rule 6).
 */

export function useFormUpdates(host: {
  readonly composer: ComposerState;
  /** The shown session; `null` once stopped or without one. */
  readonly session: () => PlayerSession | null;
  readonly chat: () => number;
  /** The session's activation token and the one the shown session was shown under (`usePlayerSession`). */
  readonly epoch: () => number;
  readonly inputEpoch: () => number;
  readonly terminal: () => SessionTerminal;
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
  /** As `useAnswerSubmission`'s: the session stops, or stopped or was replaced since it was shown. */
  const closed = () => host.terminal() !== null || host.epoch() !== host.inputEpoch();
  /** Form updates sent and not yet answered, per form action: its Submit then gets no local check (rule 6). */
  const unacknowledged = new Map<number, number>();
  /** A typed field's commit under way: its field stays read-only until the form took it or refused it. */
  const commitWindow = shallowRef<{
    readonly actionId: number;
    readonly fieldId: string;
    readonly opening: number;
    readonly revision: number;
  } | null>(null);

  function presentedForm(): RuntimeInteractionActionSnapshot | null {
    const session = host.session();
    const action = session ? activePlayerRuntimeInteraction(session.state) : null;
    return action?.ui.kind === "form" && action.form !== undefined ? action : null;
  }

  /** A form update, in order with the others; never greyed and no answer (rule 6 counts it). */
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
      } else if (result.kind === "unavailable") showNotice(NO_LONGER_AVAILABLE);
      else if (result.kind === "unanswered") showNotice(host.unansweredMessage());
    } finally {
      release(actionId);
    }
  }

  /** Enter in a typed form field: checked at once; its field is read-only until the form took the commit. */
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

  /** The draft the form's step, Submit or Back takes along, from the field being edited. */
  function formDraftText(): string | undefined {
    return host.composer.formDraft()?.text;
  }

  /** A form field's button; typed as its label, the chat's text is the command and comes back on a refusal. */
  function stepField(fieldId: string, typed = false): void {
    const action = presentedForm();
    if (action === null || closed()) return;
    const chat = host.chat();
    const sent = typed ? host.composer.takeChat() : null;
    void update(action.actionId, intents.formStep(fieldId, formDraftText()), (result) => {
      const taken =
        result.kind === "answered" &&
        (result.outcome.kind === "updated" || result.outcome.kind === "unchanged");
      if (!taken && sent !== null) host.composer.restoreChat(chat, sent);
    });
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
    const action = presentedForm();
    if (action === null) return;
    void update(action.actionId, intents.formDismiss);
  }
  function clearField(): void {
    const action = presentedForm();
    if (action === null) return;
    void update(action.actionId, intents.formClear);
  }

  return {
    /** The updates of form `actionId` sent and not yet answered. */
    unacknowledged: (actionId: number) => unacknowledged.get(actionId) ?? 0,
    /** The typed field whose commit is under way, read-only until the form took it. */
    commitWindow: computed(() => commitWindow.value),
    commitField,
    stepField,
    dismissField,
    clearField,
    draft,
  };
}

export type FormUpdates = ReturnType<typeof useFormUpdates>;
