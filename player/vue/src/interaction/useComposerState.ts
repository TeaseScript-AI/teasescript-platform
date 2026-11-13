import { computed, ref, shallowRef, type ComputedRef } from "vue";
import type {
  PlayerFormPresentation,
  PlayerForegroundPresentation,
} from "../../../presentation/model.js";
import {
  activePlayerRuntimeInteraction,
  playerRuntimeInteractionActionIds,
  type PlayerSession,
} from "../../../runtime/runtime-view.js";

/*
 * The composer's field and who owns its text (PLAYER-UI "Composer"). The field shows one slot at a time, its tenant:
 * the chat's text, a form field being edited, a date or time answer, a password, or the lock's password. Each slot
 * keeps its own text while another is shown. Only the player's typing (`edit`) and this controller's own operations
 * change a slot; one function, `select`, changes which slot the field shows. The composer writes nothing back but the
 * player's edits, each under the token of the field it was rendered with, so an edit of a field that has given way is
 * dropped, never taken by another slot.
 */

/** Which slot the field shows. */
export type ComposerTenant =
  | { readonly kind: "chat" }
  | { readonly kind: "form"; readonly actionId: number; readonly fieldId: string }
  | { readonly kind: "temporal"; readonly actionId: number }
  | { readonly kind: "password"; readonly actionId: number; readonly resumes: number }
  | { readonly kind: "lock"; readonly dialogKey: string; readonly repeat: boolean }
  | { readonly kind: "none" };

/** What the shown session presents, which decides the tenant (`RuntimeInteraction`'s descriptor). */
export interface ComposerDescriptor {
  /** The shown session's identity, its plan instance and the host's reset count; `null` without a session. */
  readonly session: string | null;
  /** The chat the session belongs to (`usePlayerSession`'s `chat`): another chat starts an empty composer. */
  readonly chat: number;
  readonly tenant: ComposerTenant;
  /** The foreground interaction's action, or `null`. */
  readonly actionId: number | null;
  /** Whether that action's answer is under way: its form field or date control waits, kept, for the outcome. */
  readonly answered: boolean;
  /** The interactions the session can still answer, whose slots it keeps. */
  readonly liveActions: readonly number[];
  /** A text, number or ISO-text date question's prefill, the suggestion the chat may take. */
  readonly prefill: string | null;
  /** For a form field: the text the form holds for it, which a new editor opens with. */
  readonly editorText: string | null;
  /** The presented form's field whose editor is open, whichever slot the field shows (a lock's, say), or `null`. */
  readonly editorField: string | null;
  /** For a date or time control: its prefill, which its slot starts with. */
  readonly temporalPrefill: string | null;
}

const NONE: ComposerTenant = { kind: "none" };

/**
 * The slot each foreground kind gives the field, unless the lock's password, an answer under way or an open form field
 * takes it (`composerDescriptor`). A closed table over the kinds: a new kind does not compile until it is placed here.
 * The chat takes the text of a question typed, of a button or field label, and of an image's skip; a popup, an
 * `exportText` dialog and an `openUrl` button take no typing (`none`).
 */
const FIELD_OF = {
  "show-button": "chat",
  choose: "chat",
  "open-url": "none",
  popup: "none",
  "export-text": "none",
  "ask-text": "chat",
  "ask-number": "chat",
  "ask-date": "temporal",
  "ask-time": "temporal",
  "ask-datetime": "temporal",
  "ask-password": "password",
  form: "chat",
  "ask-image": "chat",
} as const satisfies Record<
  PlayerForegroundPresentation["kind"],
  "chat" | "temporal" | "password" | "none"
>;

/**
 * The descriptor of what `shown` presents (`RuntimeInteraction`'s): the lock's password while its dialog shows; else the
 * foreground interaction's own field (a password, a form field being edited, a date or time control), or the chat. An
 * answered form or date control gives the field to the chat until its answer settles; a refusal shows them again.
 */
export function composerDescriptor(shown: {
  readonly session: PlayerSession | null;
  /** The host's reset count, which with the plan instance names the session. */
  readonly reset: number;
  readonly chat: number;
  /** What the session's foreground presents (`playerRuntimeForeground`), and its form (`playerRuntimeForm`). */
  readonly foreground: PlayerForegroundPresentation | null;
  readonly form: PlayerFormPresentation | null;
  /** The lock's password dialog while it shows (`usePlayerSession`'s `lock`). */
  readonly lock: { readonly key: string; readonly repeat: boolean } | null;
  /** The action an answer under way took (`useAnswerSubmission`'s `consumed`). */
  readonly consumed: number | null;
}): ComposerDescriptor {
  const { session, foreground, form, lock, consumed } = shown;
  const action = session ? activePlayerRuntimeInteraction(session.state) : null;
  const id = action?.actionId ?? null;
  const editor = form?.editor ?? null;
  const editorField =
    id !== null && editor !== null && form?.actionId === id ? editor.fieldId : null;
  let tenant: ComposerTenant;
  if (lock) tenant = { kind: "lock", dialogKey: lock.key, repeat: lock.repeat };
  else if (id !== null && foreground && FIELD_OF[foreground.kind] === "password")
    tenant = { kind: "password", actionId: id, resumes: action?.resumes ?? 0 };
  else if (id !== null && consumed === id) tenant = { kind: "chat" };
  else if (id !== null && editorField !== null)
    tenant = { kind: "form", actionId: id, fieldId: editorField };
  // A year-0000 prefill shows as editable ISO text (`isoText`): still the date's own slot, not the chat's.
  else if (id !== null && foreground && FIELD_OF[foreground.kind] === "temporal")
    tenant = { kind: "temporal", actionId: id };
  // Nothing asked, a skippable pacing gate included: the chat takes typing.
  else if (foreground === null || FIELD_OF[foreground.kind] === "chat") tenant = { kind: "chat" };
  else tenant = NONE;
  // An answered question offers nothing: while its answer is under way the chat stands in for it, and its prefill, of
  // whatever kind, is not the chat's.
  const answered = id !== null && consumed === id;
  const prefill =
    !answered && foreground && "prefill" in foreground ? (foreground.prefill ?? null) : null;
  return {
    session: session ? `${session.planToken}:${shown.reset}` : null,
    chat: shown.chat,
    tenant,
    actionId: id,
    answered,
    liveActions: session ? playerRuntimeInteractionActionIds(session.state) : [],
    prefill: tenant.kind === "chat" ? prefill : null,
    editorText: editor?.text ?? null,
    editorField,
    temporalPrefill: tenant.kind === "temporal" ? prefill : null,
  };
}

/** The identity of a descriptor: the composer selects again whenever it changes. */
export function descriptorKey(next: ComposerDescriptor): string {
  return JSON.stringify([
    next.session,
    next.chat,
    next.tenant,
    next.actionId,
    next.answered,
    next.liveActions,
    next.prefill,
    next.editorField,
  ]);
}

/**
 * A prefill's fate in the chat, where it is the question's suggestion (PLAYER-UI "Composer and foreground
 * interactions"): not yet shown, shown untouched, or the player's own text now.
 */
type PrefillState = "unshown" | "offered" | "taken";

interface FormSlot {
  readonly actionId: number;
  readonly fieldId: string;
  /** Each opening of the field's editor is its own; an acknowledgment of another opening changes nothing. */
  readonly opening: number;
  draft: string;
  revision: number;
  ackRevision: number;
}

/** The lock's password, asked twice on one line when the lock repeats it. */
interface LockSlot {
  readonly key: string;
  readonly repeat: boolean;
  phase: "first" | "repeat";
  first: string;
  text: string;
}

/** The outcome of Enter in the lock's password. */
export type LockEntry =
  | { readonly kind: "empty" }
  | { readonly kind: "repeat" }
  | { readonly kind: "match"; readonly password: string }
  | { readonly kind: "mismatch" };

/** A form draft to store, addressed to its slot's opening and revision. */
export interface FormDraft {
  readonly actionId: number;
  readonly fieldId: string;
  readonly text: string;
  readonly opening: number;
  readonly revision: number;
}

function tenantKey(tenant: ComposerTenant): string {
  switch (tenant.kind) {
    case "form":
      return `form:${tenant.actionId}:${tenant.fieldId}`;
    case "temporal":
      return `temporal:${tenant.actionId}`;
    case "password":
      return `password:${tenant.actionId}:${tenant.resumes}`;
    case "lock":
      return `lock:${tenant.dialogKey}`;
    default:
      return tenant.kind;
  }
}

/**
 * The composer's controller. `draft` stores a dirty form draft after the player paused (the host's draft op); its
 * promise says whether the form took it (`updated` or `unchanged`).
 */
export function useComposerState(host: {
  readonly draft: (draft: FormDraft) => Promise<boolean>;
  /** While true, form drafts stay local, as for a state Debug's rewind restored. */
  readonly holdDrafts: () => boolean;
  /** The draft timer's pause, in milliseconds. */
  readonly draftDelayMs?: number;
  /**
   * The player edited the field, or it shows another slot, chat or session: the composer's notice is then cleared
   * (`useAnswerSubmission`). An answered action's field giving way to the chat, and coming back on a refusal, is
   * neither.
   */
  readonly fieldChanged?: () => void;
}) {
  const draftDelayMs = host.draftDelayMs ?? 400;
  let chatId: number | null = null;
  let session: string | null = null;
  const chat = ref("");
  const forms = new Map<string, FormSlot>();
  let openings = 0;
  const temporals = new Map<number, string>();
  const prefills = new Map<number, PrefillState>();
  /** The interaction whose untouched prefill the chat holds now; its text is then exactly that prefill. */
  let offer: number | null = null;
  let password: { readonly key: string; text: string } | null = null;
  let lock: LockSlot | null = null;
  const tenant = shallowRef<ComposerTenant>(NONE);
  /** The token of the field the composer shows; an edit under another is dropped. */
  const token = ref(0);
  /** Bumps whenever a slot the field may show changes, so `displayed` follows. */
  const revision = ref(0);
  /** The action whose answer was under way at the last selection, whose field the chat stands in for. */
  let answering: number | null = null;
  /** The form field the field showed when its editor closed at the last selection, or `null`. */
  let closedShown: { readonly actionId: number; readonly fieldId: string } | null = null;
  let finish: () => void = () => {};
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const formKey = (actionId: number, fieldId: string) => `${actionId}:${fieldId}`;
  const touch = () => revision.value++;

  const displayed: ComputedRef<string> = computed(() => {
    void revision.value;
    const shown = tenant.value;
    switch (shown.kind) {
      case "form":
        return forms.get(formKey(shown.actionId, shown.fieldId))?.draft ?? "";
      case "temporal":
        return temporals.get(shown.actionId) ?? "";
      case "password":
        return password?.text ?? "";
      case "lock":
        return lock?.text ?? "";
      default:
        return chat.value;
    }
  });

  /**
   * Drops what belongs to another session or to interactions that ended. A prefill's provenance is the chat's (decisions
   * 1 and 3): what the player deleted stays deleted also after a lost connection, whose stop shows no session, and the
   * recovery's Continue in the same chat; only another chat (`select`) or the question's end drops it.
   */
  function prune(next: ComposerDescriptor) {
    if (next.session !== session) {
      session = next.session;
      forms.clear();
      temporals.clear();
      withdrawOffer();
      return;
    }
    const live = new Set(next.liveActions);
    // A Map's iteration visits each remaining key once while its entries are deleted.
    for (const [key, slot] of forms) if (!live.has(slot.actionId)) forms.delete(key);
    for (const id of temporals.keys()) if (!live.has(id)) temporals.delete(id);
    if (next.session !== null)
      for (const id of prefills.keys()) if (!live.has(id)) prefills.delete(id);
  }

  /** An untouched prefill leaves with its question; the chat is empty again. */
  function withdrawOffer() {
    if (offer === null) return;
    chat.value = "";
    offer = null;
  }

  function offerPrefill(actionId: number, text: string) {
    chat.value = text;
    prefills.set(actionId, "offered");
    offer = actionId;
  }

  /**
   * Shows the slot `next` names. The composition under way ends first, so its last edit reaches the slot it was typed
   * in; then the old field's token retires, a secret slot is erased, and the new slot is shown (an untouched prefill
   * leaving or returning, a new editor opening with the form's text, a date control with its prefill).
   */
  function select(next: ComposerDescriptor) {
    if (disposed) return;
    const previous = tenant.value;
    // Another slot, chat or session ends the field's composition and retires its token; the same slot keeps both, so a
    // question that comes while the player types in the chat does not interrupt the typing.
    const switching =
      tenantKey(next.tenant) !== tenantKey(previous) ||
      next.chat !== chatId ||
      next.session !== session;
    if (switching) finish();
    const answerSwitch =
      next.actionId !== null &&
      (next.answered || answering === next.actionId) &&
      next.chat === chatId;
    answering = next.answered ? next.actionId : null;
    if (next.chat !== chatId) {
      chatId = next.chat;
      chat.value = "";
      offer = null;
      prefills.clear();
    }
    // A field whose editor closed while its form is still presented ends its opening, whichever slot the field showed
    // meanwhile; a suspended or answered form keeps it.
    closedShown = null;
    if (!next.answered && next.actionId !== null && next.session === session)
      for (const [key, slot] of forms)
        if (slot.actionId === next.actionId && slot.fieldId !== next.editorField) {
          forms.delete(key);
          if (previous.kind === "form" && formKey(previous.actionId, previous.fieldId) === key)
            closedShown = { actionId: slot.actionId, fieldId: slot.fieldId };
        }
    if (previous.kind === "password" && tenantKey(previous) !== tenantKey(next.tenant))
      password = null;
    if (next.tenant.kind !== "lock" || lock?.key !== next.tenant.dialogKey) lock = null;
    prune(next);
    if (offer !== null && offer !== next.actionId) withdrawOffer();
    const shown = next.tenant;
    if (shown.kind === "chat" && next.actionId !== null && next.prefill !== null) {
      const state = prefills.get(next.actionId);
      if (state === undefined) {
        if (chat.value === "") offerPrefill(next.actionId, next.prefill);
        else prefills.set(next.actionId, "unshown");
      } else if (state !== "taken" && offer !== next.actionId && chat.value === "")
        offerPrefill(next.actionId, next.prefill);
    } else if (shown.kind === "form") {
      const key = formKey(shown.actionId, shown.fieldId);
      if (!forms.has(key))
        forms.set(key, {
          actionId: shown.actionId,
          fieldId: shown.fieldId,
          opening: ++openings,
          draft: next.editorText ?? "",
          revision: 0,
          ackRevision: 0,
        });
    } else if (shown.kind === "temporal") {
      if (!temporals.has(shown.actionId)) temporals.set(shown.actionId, next.temporalPrefill ?? "");
    } else if (shown.kind === "password") {
      if (password?.key !== tenantKey(shown)) password = { key: tenantKey(shown), text: "" };
    } else if (shown.kind === "lock" && lock === null)
      lock = { key: shown.dialogKey, repeat: shown.repeat, phase: "first", first: "", text: "" };
    tenant.value = shown;
    if (switching) {
      if (!answerSwitch) host.fieldChanged?.();
      clearTimeout(draftTimer);
      token.value++;
      if (shown.kind === "form") armDraft();
    }
    touch();
  }

  /** The player's edit of the field rendered with `editToken`; dropped once that field gave way. */
  function edit(editToken: number, text: string) {
    if (disposed || editToken !== token.value) return;
    const shown = tenant.value;
    switch (shown.kind) {
      case "form": {
        const slot = forms.get(formKey(shown.actionId, shown.fieldId));
        if (!slot || slot.draft === text) return;
        slot.draft = text;
        slot.revision++;
        armDraft();
        break;
      }
      case "temporal":
        temporals.set(shown.actionId, text);
        break;
      case "password":
        if (password) password.text = text;
        break;
      case "lock":
        if (lock) lock.text = text;
        break;
      case "none":
        return;
      case "chat":
        if (chat.value === text) return;
        if (offer !== null) {
          prefills.set(offer, "taken");
          offer = null;
        }
        chat.value = text;
    }
    host.fieldChanged?.();
    touch();
  }

  /** The form slot the field shows, or `null`. */
  function shownForm(): { readonly key: string; readonly slot: FormSlot } | null {
    const shown = tenant.value;
    if (shown.kind !== "form") return null;
    const key = formKey(shown.actionId, shown.fieldId);
    const slot = forms.get(key);
    return slot ? { key, slot } : null;
  }

  // A dirty draft is stored once the player paused, while its field is shown and drafts are not held.
  function armDraft() {
    clearTimeout(draftTimer);
    const shown = tenant.value;
    const form = shownForm();
    if (shown.kind !== "form" || !form || form.slot.revision <= form.slot.ackRevision) return;
    draftTimer = setTimeout(() => {
      if (disposed || host.holdDrafts()) return;
      const current = shownForm();
      if (current?.slot !== form.slot) return;
      const draft: FormDraft = {
        actionId: shown.actionId,
        fieldId: shown.fieldId,
        text: form.slot.draft,
        opening: form.slot.opening,
        revision: form.slot.revision,
      };
      void host.draft(draft).then((taken) => {
        if (taken) acknowledge(draft);
      });
    }, draftDelayMs);
  }

  /**
   * The form took `draft`, or a commit of it: its slot is clean up to that revision, only for the same opening; an
   * older acknowledgment never cleans a newer edit.
   */
  function acknowledge(draft: Pick<FormDraft, "actionId" | "fieldId" | "opening" | "revision">) {
    const slot = forms.get(formKey(draft.actionId, draft.fieldId));
    if (!slot || slot.opening !== draft.opening) return;
    slot.ackRevision = Math.max(slot.ackRevision, draft.revision);
  }

  /** The shown form field's draft, addressed to its opening and revision, for a commit or a step. */
  function formDraft(): FormDraft | null {
    const shown = tenant.value;
    const form = shownForm();
    if (shown.kind !== "form" || !form) return null;
    return {
      actionId: shown.actionId,
      fieldId: shown.fieldId,
      text: form.slot.draft,
      opening: form.slot.opening,
      revision: form.slot.revision,
    };
  }

  /** Re-arms a dirty draft whose storing was held, as when Debug's held drafts are released. */
  function resumeDrafts() {
    if (tenant.value.kind === "form") armDraft();
  }

  /**
   * Takes the chat's text for a send: the composition ends first, so the sent text is the whole text shown; the chat
   * is then empty. An untouched prefill sent is the player's answer now.
   */
  function takeChat(): string {
    finish();
    const text = chat.value;
    if (offer !== null) {
      prefills.set(offer, "taken");
      offer = null;
    }
    chat.value = "";
    touch();
    return text;
  }

  /** The text of the slot the field shows, after the composition ends, without taking it. */
  function current(): string {
    finish();
    return displayed.value;
  }

  /**
   * Empties the password slot after a send. The keys typed while the password's answer is on its way go nowhere because
   * the field is read-only then (`RuntimeInteraction`'s `composerReadonly`), not because of this.
   */
  function erasePassword() {
    if (password) password.text = "";
    touch();
  }

  /**
   * Puts a refused answer's text back before what the chat holds now, in its own chat only. An untouched prefill there
   * leaves first, and is offered again only on its question's return.
   */
  function restoreChat(chat_: number, sent: string) {
    if (disposed || chat_ !== chatId) return;
    finish();
    if (offer !== null) {
      prefills.set(offer, "unshown");
      chat.value = "";
      offer = null;
    }
    chat.value = sent + chat.value;
    touch();
  }

  /** Enter or Send in the lock's password: the first entry is asked again; the second matches it or starts over. */
  function lockEnter(): LockEntry {
    finish();
    if (!lock || lock.text === "") return { kind: "empty" };
    if (!lock.repeat) {
      const entered = lock.text;
      lock.text = "";
      touch();
      return { kind: "match", password: entered };
    }
    if (lock.phase === "first") {
      lock.first = lock.text;
      lock.text = "";
      lock.phase = "repeat";
      token.value++;
      touch();
      return { kind: "repeat" };
    }
    const result: LockEntry =
      lock.text === lock.first ? { kind: "match", password: lock.text } : { kind: "mismatch" };
    restartLock();
    return result;
  }

  /** Back or Escape in the repeat, and a mismatch: both entries go, and the password is asked again. */
  function restartLock() {
    finish();
    if (!lock) return;
    lock.first = "";
    lock.text = "";
    lock.phase = "first";
    token.value++;
    touch();
  }

  /** Erases every secret, as on a stop or a lost connection. */
  function eraseSecrets() {
    finish();
    password = null;
    lock = null;
    touch();
  }

  /** Registers the field's composition ending (`Composer.vue`); the returned function detaches it. */
  function attach(end: () => void): () => void {
    finish = end;
    return () => {
      if (finish === end) finish = () => {};
    };
  }

  function dispose() {
    disposed = true;
    clearTimeout(draftTimer);
    password = null;
    lock = null;
  }

  return {
    tenant: computed(() => tenant.value),
    token: computed(() => token.value),
    displayed,
    /** The lock's phase, for its field's name and eye: `first` or `repeat`; `null` without the lock's password. */
    lockPhase: computed(() => {
      void revision.value;
      return tenant.value.kind === "lock" ? (lock?.phase ?? "first") : null;
    }),
    /**
     * The form field the last selection closed while the field showed it, so focus may return to its button; `null`
     * when it closed under another slot, such as the lock's password.
     */
    closedField: () => closedShown,
    /** The chat's text, wherever the field is. */
    chatText: computed(() => chat.value),
    select,
    edit,
    formDraft,
    acknowledge,
    resumeDrafts,
    takeChat,
    current,
    erasePassword,
    restoreChat,
    lockEnter,
    restartLock,
    eraseSecrets,
    attach,
    dispose,
  };
}

export type ComposerState = ReturnType<typeof useComposerState>;
