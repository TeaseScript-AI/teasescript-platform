<script setup lang="ts">
import ForegroundControls, {
  type ImageControl,
  type ImageControls,
} from "./ForegroundControls.vue";
import FormControls from "./FormControls.vue";
import PopupDialog from "./PopupDialog.vue";
import ExportTextDialog from "./ExportTextDialog.vue";
import LockDialog from "./LockDialog.vue";
import type {
  LockDialog as LockDialogState,
  LockDialogInput,
} from "../../../encryption/lock-service.js";
import { computed, nextTick, onUnmounted, ref, watch, type Ref } from "vue";
import { useEventListener } from "@vueuse/core";
import {
  activePlayerRuntimeInteraction,
  playerRuntimeForm,
  playerRuntimeUrlRequest,
  playerRuntimeForeground,
  playerRuntimePacingGate,
  playerRuntimeInteractionActionIds,
  type PlayerSession,
} from "../../../runtime/runtime-view.js";
import Composer from "./Composer.vue";
import ConversationSurface from "./ConversationSurface.vue";
import Transcript from "../transcript/Transcript.vue";
import { usePlayerConditions } from "./usePlayerConditions";
import type {
  PlayerTranscriptEntryPresentation,
  PlayerSpeakerPresentation,
} from "../../../presentation/model.js";
import { imagePickerAccept, type ImageFileFilters } from "../../../media/image-file.js";
import { openUrlTab } from "../../../url-tab.js";
import type { InputSectionHost } from "../session/runtime-input";
import { useComposerState, type ComposerDescriptor, type ComposerTenant } from "./useComposerState";
import { useAnswerSubmission, type SessionTerminal } from "./useAnswerSubmission";
import type { ImageCapture } from "../stage/useImageCapture";

/** How the host stores an image file the player chose for `askImage`. */
export interface PlayerImageInput {
  store(
    file: File,
    filters: ImageFileFilters,
  ): Promise<{ readonly reference: string } | { readonly message: string }>;
  discard(reference: string): void;
  /** Whether a photo from the camera can answer here. */
  readonly camera: boolean;
}

const props = defineProps<{
  session: PlayerSession | null;
  reset: number;
  /** The chat the session belongs to (`usePlayerSession`'s `chat`): another chat starts with an empty composer. */
  chat?: number;
  /** Where the shown session stands at its end: stopping, stopped, or its connection lost (`usePlayerSession`). */
  terminal?: SessionTerminal;
  /** The stopped session while it shows for the error dialog, whose final publication settles a posted answer. */
  stoppedSession?: PlayerSession | null;
  entries: readonly PlayerTranscriptEntryPresentation[];
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
  revision?: number;
  /** The revision through which the transcript shows directly, like history (`PlayerSessionHost.jumpedRevision`). */
  jumpedRevision?: number;
  /** The indexes of the removed messages among `entries`, in ascending order. */
  removedRows?: readonly number[];
  transcriptKey: string;
  /**
   * The section of the shown session that input runs in (`runtime-input.ts`): it observes elapsed time first, and posts
   * only while the session owns the UI. Without it, the controls answer nothing.
   */
  inputSection?: InputSectionHost;
  /**
   * Readies the session before input is evaluated, such as by adopting a state Debug's rewind restored; input goes
   * ahead when it returns or resolves to `true`.
   */
  prepareInput?: () => true | Promise<boolean>;
  /**
   * While true, text typed for a form field stays in the composer instead of reaching the form, as for a state Debug's
   * rewind restored, which takes it with the next form input once that input adopted the state.
   */
  holdFormDrafts?: boolean;
  /** Stores an image file chosen for `askImage`; without it an image request offers no file input. */
  images?: PlayerImageInput;
  /** The steps of a presented `askImage` request, whose "Use image" answers it with the preview. */
  capture?: ImageCapture;
  /** The Debug countdown line, shown under the foreground controls while Debug runs (DEBUGGER.md "Playroom Debug"). */
  debugCountdown?: string | null;
  /** Whether a popup or an exportText dialog is modal; while Debug runs it is not, so the Debug panel stays usable. */
  popupModal?: boolean;
  /** The dialog of a lock step, while one shows, and how it is answered (`usePlayerSession`'s `lock`). */
  lock?: {
    readonly dialog: Readonly<
      Ref<{ readonly dialog: LockDialogState; readonly busy: boolean } | null>
    >;
    readonly submit: (input: LockDialogInput) => void;
    readonly cancel: () => void;
  };
}>();
// A lock step waits for the Player or its dialog; the composer takes no answer meanwhile, except in the password field
// of `password: askPassword(...)`, which the composer itself shows.
const locking = computed(
  () =>
    props.session?.state.status === "waiting" &&
    props.session.state.foregroundAction?.kind === "lock",
);
const lockField = computed(() => {
  const shown = props.lock?.dialog.value;
  return shown?.dialog.kind === "password" ? { ...shown.dialog, busy: shown.busy } : null;
});
const lockDialog = computed(() => {
  const shown = props.lock?.dialog.value;
  return shown && shown.dialog.kind !== "password" ? { ...shown, dialog: shown.dialog } : null;
});
const emit = defineEmits<{ "update:session": [session: PlayerSession] }>();
const actionId = computed(() =>
  props.session ? activePlayerRuntimeInteraction(props.session.state)?.actionId : undefined,
);
// A password field that a block interrupted is presented anew, without what was typed, also after a block that returned
// at once.
const passwordResumes = computed(() =>
  props.session ? (activePlayerRuntimeInteraction(props.session.state)?.resumes ?? 0) : 0,
);
// An interaction's presentation is fixed for its lifetime. Keep one object per action so frequent time and media
// observations do not re-render, and re-measure, the controls on every update.
// Action IDs restart per session; the plan instance and the host's reset count identify which session an ID belongs to.
let presented: {
  readonly plan: string;
  readonly reset: number;
  readonly actionId: number;
  readonly value: ReturnType<typeof playerRuntimeForeground>;
} | null = null;
const foreground = computed(() => {
  const session = props.session;
  if (!session) return null;
  const id = actionId.value;
  if (
    presented?.plan === session.planToken &&
    presented.reset === props.reset &&
    presented.actionId === id
  )
    return presented.value;
  const value = playerRuntimeForeground(session);
  presented =
    id === undefined ? null : { plan: session.planToken, reset: props.reset, actionId: id, value };
  return value;
});
// A form's answers change with each edit, unlike the rest of its presentation.
const form = computed(() => (props.session ? playerRuntimeForm(props.session) : null));
const pacing = computed(() => {
  const gate = props.session ? playerRuntimePacingGate(props.session) : null;
  return gate?.skippable ? gate : null;
});
/**
 * The button that Space in the empty composer activates: a `showButton` (`null`), or the button that `prefill:`
 * preselects; `undefined` without one.
 */
const preselected = computed((): string | null | undefined => {
  const presented = foreground.value;
  if (presented?.kind === "show-button") return null;
  if (presented?.kind !== "choose") return undefined;
  return presented.options.find((option) => option.preselected)?.id;
});
/** When the presented interaction appeared: a key pressed earlier, or held down, does not answer it. */
const presentedAt = ref(0);
function activatePreselected() {
  const target = preselected.value;
  if (target === undefined) return;
  submission.activatePreselected(target);
}
// An image request accepts a file through the paperclip or a drop only while it allows files.
const imageRequest = computed(() =>
  foreground.value?.kind === "ask-image" ? foreground.value : null,
);
// A request is one action of one session; its identity is fixed while frequent observations publish new sessions.
const plan = computed(() => props.session?.planToken);
const attach = computed(() =>
  imageRequest.value?.allowFile === true &&
  props.images &&
  props.capture &&
  plan.value !== undefined &&
  actionId.value !== undefined
    ? {
        accept: imagePickerAccept(imageRequest.value),
        label: "Attach an image",
        request: { plan: plan.value, reset: props.reset, actionId: actionId.value },
      }
    : null,
);
// "Open camera" shows the viewfinder for a request that allows the camera, on the Stage or in the camera window.
const camera = computed(
  () => imageRequest.value?.allowCamera === true && props.images?.camera === true,
);
// The image request's controls stand at the first step until its capture is open, as while Debug inspects a state.
const imageControls = computed((): ImageControls | null => {
  if (!imageRequest.value) return null;
  const view = props.capture?.view.value ?? null;
  return {
    phase: view?.phase ?? "choose",
    camera: camera.value,
    file: attach.value !== null,
    ready: view?.ready ?? false,
  };
});
// Typed text answers an image request only as the exact text of its skip; the notice names the routes it offers.
const imageTextFeedback = computed(() => {
  const skip = imageRequest.value?.skip ?? null;
  const routes =
    attach.value && camera.value
      ? ["Take a photo with the camera", "attach or drop an image"]
      : attach.value
        ? ["Attach an image with the paperclip", "drop it onto the message field"]
        : camera.value
          ? ["Take a photo with the camera"]
          : [];
  if (skip !== null)
    return routes.length === 0
      ? `Choose ${skip} to answer without an image.`
      : `${routes.join(", ")}, or choose ${skip}.`;
  return routes.length === 0 ? "" : `${routes.join(", or ")}.`;
});
type ImageRequestIdentity = NonNullable<typeof attach.value>["request"];
/** Whether the image request the files are for is the one presented now. */
function presents(request: ImageRequestIdentity): boolean {
  return (
    imageRequest.value !== null &&
    props.session?.planToken === request.plan &&
    props.reset === request.reset &&
    activePlayerRuntimeInteraction(props.session.state)?.actionId === request.actionId
  );
}
const readingImage = ref(false);
const root = ref<HTMLElement | null>(null);
// The session's area, which a popup that is not modal centres on, beside the Debug panel.
const composition = computed(() => root.value?.closest<HTMLElement>(".player-composition") ?? null);
// Composer is generic over the image request it reports, so its instance type is named by what is used.
const composer = ref<{
  focusInput(): void;
  selectInput(): void;
  openPicker(): void;
  finishComposition(): void;
} | null>(null);
const formEditor = computed(() => form.value?.editor ?? null);

// The composer's slots and the answers given, each with its own controller: the composer's text changes only by the
// player's edits and these controllers (useComposerState), and an answer is checked at once and settled by the runtime
// (useAnswerSubmission).
const composerState = useComposerState({
  draft: (draft) => submission.draft(draft),
  holdDrafts: () => !!props.holdFormDrafts || !props.inputSection,
});
const submission = useAnswerSubmission({
  composer: composerState,
  session: () => props.session,
  stoppedSession: () => props.stoppedSession ?? null,
  chat: () => props.chat ?? 0,
  terminal: () => props.terminal ?? null,
  inputSection: () => props.inputSection,
  prepareInput: () => props.prepareInput?.() ?? true,
  publish: (session) => emit("update:session", session),
  unansweredMessage: () =>
    foreground.value?.kind === "show-button"
      ? "Type the exact button text or activate it above."
      : foreground.value?.kind === "form"
        ? "Type the exact text of one button, or use the buttons above."
        : imageTextFeedback.value,
  submitLock: (password) => props.lock?.submit({ password, timeLockMs: null }),
  // A refused answer that came from the field gives it the focus back; one from a control shows its control again.
  undone: (record) => {
    if (record.origin === "chat" || record.origin === "temporal") focusInput();
  },
});
const { displayed, token: composerToken, lockPhase } = composerState;
const consumed = submission.consumed;
const feedback = computed(() => submission.notice.value);
onUnmounted(composerState.attach(() => composer.value?.finishComposition()));
onUnmounted(composerState.dispose);
watch(
  () => props.holdFormDrafts,
  (held) => {
    if (!held) composerState.resumeDrafts();
  },
);

const temporalKinds = new Set(["ask-date", "ask-time", "ask-datetime"]);
/** What the shown session presents to the composer, which decides the slot its field shows. */
const descriptor = computed((): ComposerDescriptor => {
  const session = props.session;
  const id = actionId.value ?? null;
  const shown = foreground.value;
  const field = lockField.value;
  const editor = formEditor.value;
  const isoText = shown !== null && "isoText" in shown && shown.isoText === true;
  let tenant: ComposerTenant;
  if (field) tenant = { kind: "lock", dialogKey: field.key, repeat: field.repeat };
  else if (id !== null && shown?.kind === "ask-password")
    tenant = { kind: "password", actionId: id, resumes: passwordResumes.value };
  // An answered form or date control gives the field back to the chat until the answer settles; a refusal shows
  // them again with their text.
  else if (id !== null && consumed.value === id) tenant = { kind: "chat" };
  else if (id !== null && editor && form.value?.actionId === id)
    tenant = { kind: "form", actionId: id, fieldId: editor.fieldId };
  else if (id !== null && shown && temporalKinds.has(shown.kind) && !isoText)
    tenant = { kind: "temporal", actionId: id };
  else tenant = { kind: "chat" };
  const prefill = shown && "prefill" in shown ? (shown.prefill ?? null) : null;
  return {
    session: session ? `${session.planToken}:${props.reset}` : null,
    chat: props.chat ?? 0,
    tenant,
    actionId: id,
    answered: id !== null && consumed.value === id,
    liveActions: session ? playerRuntimeInteractionActionIds(session.state) : [],
    prefill: tenant.kind === "chat" ? prefill : null,
    editorText: editor?.text ?? null,
    temporalPrefill: tenant.kind === "temporal" ? prefill : null,
  };
});
const composerKey = computed(() => {
  const next = descriptor.value;
  return JSON.stringify([
    next.session,
    next.chat,
    next.tenant,
    next.actionId,
    next.answered,
    next.liveActions,
    next.prefill,
  ]);
});
// Before the field renders the new slot, so an edit still under way reaches the slot it was typed in.
watch(composerKey, () => composerState.select(descriptor.value), { immediate: true, flush: "pre" });
/** The field takes no typing for now: a password just sent, a form field's commit, an image read, the lock at work. */
const composerReadonly = computed(() => {
  const tenant = composerState.tenant.value;
  const window = submission.commitWindow.value;
  return (
    readingImage.value ||
    !!lockField.value?.busy ||
    (tenant.kind === "password" && submission.pending.value?.origin === "password") ||
    (tenant.kind === "form" &&
      window !== null &&
      window.actionId === tenant.actionId &&
      window.fieldId === tenant.fieldId)
  );
});
let restoreChoiceFocus = false;
let suppressComposerRefocus = false;
/**
 * Whether the player was typing in the composer when the last interaction gave way to none, so a lock's password field
 * that shows next takes the focus back, also on a touch device, whose keyboard would otherwise close.
 */
let typingBeforeField = false;

function clearFeedback() {
  submission.clearNotice();
}

// The composer edits one form field at a time: it opens with the field's text selected, so typing replaces it and
// Enter keeps it; after the field closes, focus returns to the field's button.
watch(
  () =>
    form.value?.editor
      ? { actionId: form.value.actionId, fieldId: form.value.editor.fieldId }
      : null,
  async (key, closed) => {
    if (key?.actionId === closed?.actionId && key?.fieldId === closed?.fieldId) return;
    const closedHere = closed !== null && closed.actionId === form.value?.actionId;
    // A field that opens, also in a form that resumes, shows its text selected in the composer.
    if (key !== null) {
      composer.value?.selectInput();
      return;
    }
    if (!closedHere) return;
    // Focus returns to the closed field's button, unless the player went on elsewhere meanwhile.
    const descriptorAtClose = composerKey.value;
    await nextTick();
    if (composerKey.value !== descriptorAtClose) return;
    const active = document.activeElement;
    if (active && active !== document.body && !active.matches("[data-composer-input]")) return;
    root.value
      ?.querySelector<HTMLElement>(`[data-form-field="${CSS.escape(closed.fieldId)}"]`)
      ?.focus({ preventScroll: true });
  },
);
useEventListener(
  document,
  "pointerdown",
  (event) => {
    if (!feedback.value || !(event.target instanceof Node)) return;
    const notice = root.value?.querySelector(".composer-notice");
    const arrow = root.value?.querySelector(".composer-notice-arrow");
    if (notice?.contains(event.target) || arrow?.contains(event.target)) return;
    clearFeedback();
  },
  { capture: true },
);

/**
 * `openUrl` (V30 §33): when this session's own run requested it and the player's recent click lets the browser open a
 * tab, the Player opens the address at once and settles the request, so its button never shows. Each request is tried
 * once, when its runtime session first presents it: one that a block interrupted, or that Debug's Return or turning
 * Debug off reinstates with its session, is not tried again. A request a restore, rewind, or reload brought back is
 * never opened by itself, and neither is one written with `alwaysButton: true` or one whose tab the browser did not
 * open: its button opens it.
 */
const urlTried = new Map<string, Set<number>>();
submission.urlOpener(openRequestedUrl);
watch(
  [actionId, () => props.reset],
  () => {
    const session = props.session;
    const id = actionId.value;
    if (!session || id === undefined || foreground.value?.kind !== "open-url") return;
    const tried = urlTried.get(session.id) ?? new Set<number>();
    urlTried.set(session.id, tried);
    if (tried.has(id)) return;
    tried.add(id);
    // Typically an answer the player just gave presents it, within the activation of that answer's click.
    if (!playerRuntimeUrlRequest(session)?.atOnce || !props.inputSection) return;
    // Host input happens at the observed time; the tab opens only for the request still presented there, and the
    // request is settled only once its tab opened. While an answer is pending, the request waits for it to settle.
    submission.openUrl(openRequestedUrl, true);
  },
  { immediate: true },
);
/** Opens the address of the `openUrl` request `session` presents in a new tab; whether one opened. */
function openRequestedUrl(session: PlayerSession) {
  const request = playerRuntimeUrlRequest(session);
  return request !== null && openUrlTab(request.url);
}
function focusInput() {
  composer.value?.focusInput();
}

const { hoverAvailable } = usePlayerConditions();
watch(
  [actionId, () => props.reset, passwordResumes],
  async () => {
    presentedAt.value = performance.now();
    const active = document.activeElement;
    const ownedFocus = !!active && !!root.value?.contains(active);
    // Default composer focus when nothing else owns it; touch-only devices would raise a keyboard.
    const unownedFocus = (!active || active === document.body) && hoverAvailable.value;
    const composerFocused =
      active instanceof HTMLElement && active.matches("[data-composer-input]");
    const wasEditing =
      (active instanceof HTMLTextAreaElement || composerFocused) && !suppressComposerRefocus;
    typingBeforeField = wasEditing && actionId.value === undefined;
    suppressComposerRefocus = false;
    const returnToChoice = restoreChoiceFocus;
    restoreChoiceFocus = false;
    const keyboardNavigation = document.documentElement.dataset.playerKeyboardFocus === "true";
    clearFeedback();
    await nextTick();
    // The answer's publication goes first.
    await nextTick();
    // A control outside the interaction that this update removed, such as Start, leaves focus unowned as well.
    const releasedFocus =
      !ownedFocus &&
      active instanceof HTMLElement &&
      !active.isConnected &&
      (document.activeElement === null || document.activeElement === document.body) &&
      hoverAvailable.value;
    // Progression may restore composer focus, but must not steal it from Tools/dialogs. A popup and an exportText
    // dialog focus their own button.
    if (
      (ownedFocus || returnToChoice || unownedFocus || releasedFocus) &&
      (foreground.value || pacing.value) &&
      foreground.value?.kind !== "popup" &&
      foreground.value?.kind !== "export-text"
    ) {
      // An `openUrl`'s button stands in for the composer, which takes no answer meanwhile.
      if (foreground.value?.kind === "open-url") {
        if (!keyboardNavigation) document.documentElement.dataset.playerKeyboardFocus = "false";
        root.value?.querySelector<HTMLElement>("[data-open-url]")?.focus({ preventScroll: true });
      } else if (wasEditing) focusInput();
      // A date or time control and the text field replace each other; the editing focus Send kept moves to the new one.
      else if (composerFocused && !root.value?.contains(document.activeElement)) focusInput();
      else if (unownedFocus || releasedFocus) {
        // Default focus is not keyboard navigation, so it must not reveal a navigation outline.
        document.documentElement.dataset.playerKeyboardFocus = "false";
        focusInput();
      } else if (keyboardNavigation)
        root.value
          ?.querySelector<HTMLButtonElement>("[data-foreground-controls] button")
          ?.focus({ preventScroll: true });
    }
  },
  { immediate: true },
);

/**
 * Records where focus belongs once an answer from a control is settled: a choice pressed from the keyboard keeps its
 * place in the next controls.
 */
function fromControls(answer: () => void) {
  restoreChoiceFocus =
    document.documentElement.dataset.playerKeyboardFocus === "true" &&
    !!document.activeElement?.closest("[data-foreground-controls]");
  answer();
  if (submission.pending.value === null) restoreChoiceFocus = false;
}
// The focus watch of the next action reads the flags first; a settled answer clears them after it.
watch(submission.pending, (record) => {
  if (record === null)
    void nextTick(() => {
      restoreChoiceFocus = false;
    });
});
// The Player's controls and fields, which keep their own clicks and keys.
const playerControls = [
  "button, a, input, textarea, select, label, summary, [contenteditable]",
  "[role=button], [role=link], [role=menuitem], [role=separator], [role=slider], [role=tab]",
].join(", ");
// The skippable pacing gate settles from Space in the empty composer or a stationary primary click/tap on Player space
// that is no control, such as a message, its avatar or unused space. Controls, the composer, the scrollbar and
// selections keep their own behavior.
const pacingSkipExclusions = `${playerControls}, .composer-container, [data-slot=scroll-area-scrollbar]`;
function textSelected() {
  const selection = document.getSelection();
  return !!selection && !selection.isCollapsed;
}
function skipPacing(refocusInput: boolean, actionId?: number) {
  if (!pacing.value || textSelected()) return;
  suppressComposerRefocus = !refocusInput;
  void submission.skipPacing(actionId).finally(() =>
    nextTick(() => {
      suppressComposerRefocus = false;
    }),
  );
}
// A press skips the message whose pacing was presented when it began; a gate that elapses while the button is held
// is not replaced by the next message's gate.
let pacingGesture: {
  pointerId: number;
  x: number;
  y: number;
  target: Element;
  actionId: number;
} | null = null;
useEventListener(document, "pointerdown", (event: PointerEvent) => {
  const composition = root.value?.closest(".player-composition");
  pacingGesture =
    pacing.value &&
    event.button === 0 &&
    event.isPrimary &&
    event.target instanceof Element &&
    composition?.contains(event.target) &&
    !event.target.closest(pacingSkipExclusions)
      ? {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          target: event.target,
          actionId: pacing.value.actionId,
        }
      : null;
});
useEventListener(document, "pointermove", (event: PointerEvent) => {
  if (
    pacingGesture?.pointerId === event.pointerId &&
    Math.hypot(event.clientX - pacingGesture.x, event.clientY - pacingGesture.y) > 4
  )
    pacingGesture = null;
});
// Scrolling while the button is held is reading, not a skip.
for (const type of ["pointercancel", "wheel", "scroll"] as const)
  useEventListener(document, type, () => (pacingGesture = null), { capture: true, passive: true });
useEventListener(document, "pointerup", (event: PointerEvent) => {
  const gesture = pacingGesture;
  pacingGesture = null;
  if (gesture?.pointerId === event.pointerId && gesture.target.isConnected)
    skipPacing(false, gesture.actionId);
});

// Typing focus stays in the composer (PLAYER-UI.md "Input growth, focus, and keyboard behavior"), except on touch-only
// devices: a click on Player content that is no control, which moves focus to the conversation or the page, gives it
// back. A click that selected text keeps it, as focusing the composer would clear the selection.
useEventListener(document, "click", (event: MouseEvent) => {
  const target = event.target;
  if (
    event.button === 0 &&
    hoverAvailable.value &&
    !textSelected() &&
    target instanceof Element &&
    composition.value?.contains(target) &&
    !target.closest(playerControls)
  )
    focusInput();
});
// So does a click on a control that stays in place and would keep it: a permanent button, the theme and fullscreen
// controls, or a button of the camera view, also in its floating window outside the composition. One pressed from the
// keyboard, whose click has no click count, keeps it. Its focus goes before the press runs, which may remove a
// permanent button or let focus move to the next one. While the composer has nothing to answer, such as while a
// permanent button's block runs, it takes no focus; focus that belongs to nothing returns to it with the next
// interaction or message pacing.
const inPlaceControls =
  "[data-permanent-button], [data-theme-mode-control], [data-fullscreen-control], [data-viewfinder-controls] button";
useEventListener(
  document,
  "click",
  (event: MouseEvent) => {
    const button =
      event.target instanceof Element ? event.target.closest<HTMLElement>(inPlaceControls) : null;
    if (
      button &&
      event.detail > 0 &&
      event.button === 0 &&
      hoverAvailable.value &&
      !textSelected() &&
      (composition.value?.contains(button) || button.closest("[data-floating-viewfinder]") !== null)
    ) {
      button.blur();
      focusInput();
    }
  },
  { capture: true },
);
// A message's pacing gives the composer its default focus when focus belongs to nothing, as an interaction does, such
// as after a button pressed with the mouse left with its interaction.
watch(
  () => pacing.value?.actionId,
  async (gate) => {
    if (gate === undefined) return;
    await nextTick();
    const active = document.activeElement;
    if ((!active || active === document.body) && hoverAvailable.value) {
      document.documentElement.dataset.playerKeyboardFocus = "false";
      focusInput();
    }
  },
);

/**
 * Makes one chosen or dropped file the preview of the image request the files are for, which "Use image" then answers
 * with. Files for a request that is no longer presented, such as one a timer's request replaced while the picker was
 * open, change nothing. The file is checked and stored first; when the request ended or the session was replaced
 * meanwhile, the stored image is dropped. An inspected state Debug's rewind restored is adopted first, as for an answer.
 */
async function submitImage(files: readonly File[], target: ImageRequestIdentity) {
  const request = imageRequest.value;
  const { images, capture } = props;
  if (!request || !images || !capture || submission.pending.value || readingImage.value) return;
  if (!presents(target)) {
    submission.showNotice("This interaction is no longer available.");
    return;
  }
  if (files.length !== 1) {
    submission.showNotice("Choose one image.");
    return;
  }
  readingImage.value = true;
  try {
    const stored = await images.store(files[0]!, request);
    if ("message" in stored) {
      if (presents(target)) submission.showNotice(stored.message);
      return;
    }
    const ready = presents(target) && (await (props.prepareInput?.() ?? true));
    if (!ready || !presents(target) || !capture.choose(stored.reference))
      images.discard(stored.reference);
  } finally {
    readingImage.value = false;
  }
}

/**
 * Moves the image request's steps at the player's control. "Upload file" opens the picker at once, within the press;
 * the other controls first adopt an inspected state Debug's rewind restored, as an answer does.
 */
async function imageControl(control: ImageControl) {
  const capture = props.capture;
  if (!capture || !props.session || submission.pending.value || readingImage.value) return;
  if (control === "file") return composer.value?.openPicker();
  if (control === "use") return fromControls(() => submission.useImage(capture.answer("button")));
  const ready = props.prepareInput?.() ?? true;
  if (ready !== true && !(await ready)) return;
  if (control === "camera") capture.openCamera();
  else if (control === "photo") void capture.takePhoto();
  else if (control === "timer") void capture.selfTimer();
  else if (control === "back") capture.back();
  else capture.retry();
}

// The password field of `password: askPassword(...)` starts empty each time it shows, also after a block interrupted it,
// and takes focus as an ask's field does.
watch(
  () => lockField.value?.key,
  async (key) => {
    if (key === undefined) return;
    clearFeedback();
    presentedAt.value = performance.now();
    const active = document.activeElement;
    const unowned = (!active || active === document.body) && hoverAvailable.value;
    const owned = !!active && !!root.value?.contains(active);
    const typing = typingBeforeField;
    typingBeforeField = false;
    await nextTick();
    if (unowned || owned || typing) focusInput();
  },
);

/** Back, or Escape, in the lock's repeated password: both entries go, and the password is asked again. */
function askPasswordAgain() {
  composerState.restartLock();
  clearFeedback();
  focusInput();
}
/** Escape: in the lock's repeated password it asks the password again; in a form field it closes the field. */
function escape() {
  if (lockPhase.value === "repeat") askPasswordAgain();
  else if (formEditor.value) submission.dismissField();
}
</script>

<template>
  <div ref="root" data-runtime-interaction class="contents">
    <ConversationSurface>
      <template #default="{ bottomInset }">
        <Transcript
          :key="transcriptKey"
          :entries="entries"
          :speakers="speakers"
          :revision="revision ?? 0"
          :jumped-revision="jumpedRevision ?? -1"
          :removed-rows="removedRows ?? []"
          :bottom-inset="bottomInset"
        >
          <template #foreground>
            <!-- An answered interaction's controls go at once; a refusal shows them again. -->
            <template v-if="consumed === null || consumed !== actionId">
              <FormControls
                v-if="form && foreground?.kind === 'form'"
                :key="actionId ?? 0"
                :form="form"
                :accessible-name="foreground.accessibleName"
                @step="(fieldId) => submission.stepField(fieldId)"
                @submit="fromControls(() => submission.submitForm())"
                @cancel="fromControls(() => submission.cancelForm())"
                @dismiss="submission.dismissField()"
                @clear="submission.clearField()"
              />
              <ForegroundControls
                v-else
                :key="actionId ?? 0"
                :foreground="foreground"
                :disabled="readingImage"
                :image="imageControls"
                @activate="(optionId) => fromControls(() => submission.choose(optionId))"
                @skip="fromControls(() => submission.skipImage())"
                @open="fromControls(() => submission.openUrl(openRequestedUrl, false))"
                @image="imageControl"
              />
            </template>
            <!-- Status text only: it is not announced each second and takes no input. -->
            <p
              v-if="debugCountdown"
              class="flex justify-center pt-2 text-xs text-muted-foreground"
              data-debug-countdown
            >
              {{ debugCountdown }}
            </p>
          </template>
        </Transcript>
      </template>
      <template #interaction>
        <!-- Above the composer, so the transcript's inset makes room for it. -->
        <slot name="end" />
        <!-- Outside the chat; while it waits, the composer takes no answer. -->
        <PopupDialog
          v-if="foreground?.kind === 'popup' && consumed !== actionId"
          :key="actionId ?? 0"
          :message="foreground.message"
          :button-text="foreground.buttonText"
          :modal="popupModal ?? true"
          :area="composition"
          @close="submission.closePopup()"
        />
        <ExportTextDialog
          v-if="foreground?.kind === 'export-text' && consumed !== actionId"
          :key="actionId ?? 0"
          :title="foreground.title"
          :text="foreground.text"
          :file-name="foreground.fileName"
          :modal="popupModal ?? true"
          :area="composition"
          @close="submission.closeExport()"
        />
        <LockDialog
          v-if="lock && lockDialog"
          :key="lockDialog.dialog.key"
          :dialog="lockDialog.dialog"
          :busy="lockDialog.busy"
          :modal="popupModal ?? true"
          :area="composition"
          @submit="lock.submit"
          @cancel="lock.cancel"
        />
        <Composer
          ref="composer"
          :disabled="
            !session ||
            session.state.status === 'halted' ||
            session.state.status === 'failed' ||
            (locking && !lockField) ||
            foreground?.kind === 'popup' ||
            foreground?.kind === 'export-text' ||
            foreground?.kind === 'open-url'
          "
          :pacing="!foreground && !!pacing"
          :preselected="preselected !== undefined"
          :buttons-only="
            foreground?.kind === 'choose' ||
            foreground?.kind === 'show-button' ||
            (foreground?.kind === 'form' && !formEditor)
          "
          :fresh-after="presentedAt"
          :value="displayed"
          :token="composerToken"
          :readonly="composerReadonly"
          :placeholder="
            lockField
              ? lockPhase === 'repeat'
                ? 'Repeat it'
                : (lockField.hint ?? 'Password')
              : locking ||
                  foreground?.kind === 'popup' ||
                  foreground?.kind === 'export-text' ||
                  foreground?.kind === 'open-url'
                ? ''
                : formEditor
                  ? formEditor.hint
                  : foreground && 'hint' in foreground
                    ? foreground.hint
                    : 'Type your response…'
          "
          :attach="attach"
          :password="foreground?.kind === 'ask-password' || lockField !== null"
          :repeated="lockPhase === 'repeat'"
          :accessible-name="
            lockField
              ? lockPhase === 'repeat'
                ? 'Repeat password'
                : 'Password'
              : (formEditor?.label ?? foreground?.accessibleName ?? 'Response')
          "
          :input-mode="
            formEditor
              ? formEditor.inputMode
              : foreground?.kind !== 'ask-number'
                ? 'text'
                : foreground.integer
                  ? 'numeric'
                  : 'decimal'
          "
          :input-type="
            formEditor
              ? formEditor.inputType
              : foreground && 'isoText' in foreground && foreground.isoText
                ? 'text'
                : foreground?.kind === 'ask-date'
                  ? 'date'
                  : foreground?.kind === 'ask-time'
                    ? 'time'
                    : foreground?.kind === 'ask-datetime'
                      ? 'datetime-local'
                      : 'text'
          "
          :feedback="feedback"
          @edit="composerState.edit"
          @submit="(source) => submission.send(source)"
          @skip="skipPacing(true)"
          @activate="activatePreselected"
          @escape="escape"
          @back="askPasswordAgain"
          @files="submitImage"
        />
      </template>
    </ConversationSurface>
  </div>
</template>
