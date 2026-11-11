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
import { invalidAnswerMessage } from "../../../../src/interaction-answers.js";
import Composer from "./Composer.vue";
import ConversationSurface from "./ConversationSurface.vue";
import Transcript from "../transcript/Transcript.vue";
import { usePlayerConditions } from "./usePlayerConditions";
import type {
  PlayerFormPresentation,
  PlayerTranscriptEntryPresentation,
  PlayerSpeakerPresentation,
} from "../../../presentation/model.js";
import { imagePickerAccept, type ImageFileFilters } from "../../../media/image-file.js";
import { openUrlTab } from "../../../url-tab.js";
import {
  draftInput,
  intents,
  runInput,
  type InputIntent,
  type InputSectionHost,
} from "../session/runtime-input";
import { useComposerFields } from "./useComposerFields";
import { useAnswerFlight } from "./useAnswerFlight";
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
  /** The Debug countdown line, shown under the foreground controls while Debug runs (DEBUGGER.md "Player Debug"). */
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
/**
 * The composer's latest text for each field being edited, by action and field, for this session, so a form shows it
 * again when it resumes after a block interrupted it, also before the text reached the form, and also when that block
 * opened a form of its own. A question that is not a form keeps its text under the field ID `""` in the same way.
 */
let typed: {
  readonly plan: string;
  readonly reset: number;
  readonly texts: Map<string, string>;
} | null = null;
function typedTexts(): Map<string, string> | null {
  if (!props.session) return null;
  if (typed?.plan !== props.session.planToken || typed.reset !== props.reset)
    typed = { plan: props.session.planToken, reset: props.reset, texts: new Map() };
  return typed.texts;
}
const typedKey = (actionId: number, fieldId: string) => `${actionId}:${fieldId}`;
function parseTypedKey(key: string): { readonly actionId: number; readonly fieldId: string } {
  const colon = key.indexOf(":");
  return { actionId: Number(key.slice(0, colon)), fieldId: key.slice(colon + 1) };
}
/**
 * The form field whose text the composer holds, or `null`. Only loading a field's editor sets it, and anything that
 * replaces the composer's text otherwise clears it first, so the text never becomes another action's or field's.
 */
let composerOwner: { readonly actionId: number; readonly fieldId: string } | null = null;
/** Loads a form's edited field into the composer, with the text typed for it, else the form's; `false` without one. */
function loadFormEditor(current: PlayerFormPresentation | null): boolean {
  if (!current?.editor) {
    composerOwner = null;
    return false;
  }
  composerOwner = { actionId: current.actionId, fieldId: current.editor.fieldId };
  flight.end();
  writeField(
    "input",
    typedTexts()?.get(typedKey(current.actionId, current.editor.fieldId)) ?? current.editor.text,
  );
  return true;
}
/** Whether the composer holds the text of the presented form's edited field. */
function ownsPresentedEditor(): boolean {
  return (
    composerOwner !== null &&
    form.value?.actionId === composerOwner.actionId &&
    form.value.editor?.fieldId === composerOwner.fieldId
  );
}
// Only the questions that can still be answered keep their text, so a script that asks again and again keeps no more.
watch(actionId, () => {
  const texts = typedTexts();
  if (!texts || !props.session) return;
  const pending = new Set(playerRuntimeInteractionActionIds(props.session.state));
  for (const key of texts.keys()) if (!pending.has(parseTypedKey(key).actionId)) texts.delete(key);
});
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
  void complete(intents.choice(target, "preselectedKey"));
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
const composer = ref<{ focusInput(): void; selectInput(): void; openPicker(): void } | null>(null);
// The composer's text and repeat, which this component reads with `text` and writes only with `writeField`.
const { text, writeField, interceptInput } = useComposerFields();
const feedback = ref("");
const submitting = ref(false);
let feedbackTimeout: ReturnType<typeof setTimeout> | undefined;
let restoreChoiceFocus = false;
let suppressComposerRefocus = false;
/**
 * Whether the player was typing in the composer when the last interaction gave way to none, so a lock's password field
 * that shows next takes the focus back, also on a touch device, whose keyboard would otherwise close.
 */
let typingBeforeField = false;

function clearFeedback() {
  if (feedbackTimeout !== undefined) clearTimeout(feedbackTimeout);
  feedbackTimeout = undefined;
  feedback.value = "";
}

function showFeedback(message: string) {
  clearFeedback();
  if (!message) return;
  feedback.value = message;
  feedbackTimeout = setTimeout(clearFeedback, 6000);
}

watch(
  () => text("input"),
  () => flight.noteChange() && clearFeedback(),
);
// Typing the repeat again clears the notice that the passwords do not match, which empties it.
watch(
  () => text("repeat"),
  (typed) => typed !== "" && clearFeedback(),
);

// The composer edits one form field at a time: it opens with the field's text selected, so typing replaces it and
// Enter keeps it; after the field closes, focus returns to the field's button.
const formEditor = computed(() => form.value?.editor ?? null);
const composerDisabled = computed(
  () =>
    (!foreground.value && !pacing.value && !lockField.value) ||
    foreground.value?.kind === "popup" ||
    foreground.value?.kind === "export-text" ||
    foreground.value?.kind === "open-url",
);
const composerShortcuts = computed(() => ({
  pacing: !foreground.value && !!pacing.value,
  preselected: preselected.value !== undefined,
  buttonsOnly:
    foreground.value?.kind === "choose" ||
    foreground.value?.kind === "show-button" ||
    (foreground.value?.kind === "form" && !formEditor.value),
}));
const composerInputType = computed(() =>
  formEditor.value
    ? formEditor.value.inputType
    : foreground.value && "isoText" in foreground.value && foreground.value.isoText
      ? "text"
      : foreground.value?.kind === "ask-date"
        ? "date"
        : foreground.value?.kind === "ask-time"
          ? "time"
          : foreground.value?.kind === "ask-datetime"
            ? "datetime-local"
            : "text",
);
// The composer's field, as `Composer.vue` shows it: the plain text field, a password field (`askPassword`'s, or a
// lock's), or a date or time control.
const composerField = computed(() =>
  foreground.value?.kind === "ask-password" || lockField.value
    ? "password"
    : composerInputType.value === "text"
      ? "text"
      : "picker",
);
// An answer in flight keeps the composer's plain text field writable, and plays what is typed and given meanwhile
// against what the answer leaves, with this component's own rules.
const flight = useAnswerFlight({
  owner: () =>
    props.session && {
      connection: props.session.connection,
      id: props.session.id,
      reset: props.reset,
    },
  text: () => text("input"),
  writeField: (typed) => writeField("input", typed),
  interceptInput,
  holds: () => !composerDisabled.value && !formEditor.value && composerField.value === "text",
  disabled: () => composerDisabled.value,
  shortcuts: () => composerShortcuts.value,
  submit: (source, typed) => submit(source, typed),
  skip: () => skipPacing(true),
  activate: activatePreselected,
  origin: () => {
    const action = actionId.value;
    return action === undefined ? undefined : { action, keeps: keepsTyped() };
  },
  pending: (action) =>
    !!props.session && playerRuntimeInteractionActionIds(props.session.state).includes(action),
  keep: (action, typed) => typedTexts()?.set(typedKey(action, ""), typed),
  clearFeedback,
});
watch(
  () => (form.value?.editor ? typedKey(form.value.actionId, form.value.editor.fieldId) : null),
  async (key, previousKey) => {
    const closed = previousKey === null ? null : parseTypedKey(previousKey);
    // A field of the presented form that closed, or that another of its fields replaced, drops its typed text; a
    // suspended form keeps it for its return, also while a block's form is presented.
    const closedHere = closed !== null && closed.actionId === form.value?.actionId;
    if (closedHere) typedTexts()?.delete(previousKey!);
    // A field that opens, also in a form that resumes, shows its text selected in the composer.
    if (key !== null) {
      loadFormEditor(form.value);
      composer.value?.selectInput();
      return;
    }
    if (!closedHere) return;
    // The controls stay disabled until the edit that closed the field is published.
    if (submitting.value)
      await new Promise<void>((resolve) => {
        const stop = watch(submitting, (busy) => {
          if (busy) return;
          stop();
          resolve();
        });
      });
    await nextTick();
    root.value
      ?.querySelector<HTMLElement>(`[data-form-field="${CSS.escape(closed.fieldId)}"]`)
      ?.focus({ preventScroll: true });
  },
);
// The form holds the text being typed, shortly after typing pauses, so a checkpoint or debug export keeps it. Only the
// composer's own field takes it, while it is presented.
let draftTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => text("input"),
  (typed) => {
    clearTimeout(draftTimer);
    // While an answer's flight owns the composer, its text is provisional: the flight's end keeps it where it belongs.
    if (!flight.owns()) keepTyped(typed);
    if (!ownsPresentedEditor() || !props.session) return;
    const target = composerOwner!;
    const { planToken: plan } = props.session;
    const reset = props.reset;
    typedTexts()?.set(typedKey(target.actionId, target.fieldId), typed);
    if (typed === formEditor.value?.text) return;
    draftTimer = setTimeout(() => {
      // A replaced session, such as one Debug's rewind restored, takes no text typed for another.
      if (props.session?.planToken !== plan || props.reset !== reset || submitting.value) return;
      if (props.holdFormDrafts || !props.inputSection) return;
      // The text reaches only its own action's field; while another is presented it stays typed for the return.
      void draftInput(props.inputSection, target, typed).then((drafted) => {
        if (drafted !== null) emit("update:session", drafted);
      });
    }, 400);
  },
);
onUnmounted(() => clearTimeout(draftTimer));
/**
 * Whether the presented question keeps the text typed for it, for its return after a block interrupted it: a question
 * that is no form. A password typed but not sent is never kept: a question that resumes after a block asks for it again.
 */
function keepsTyped() {
  return form.value === null && foreground.value?.kind !== "ask-password";
}
/** Keeps a text typed for the presented question. */
function keepTyped(typed: string) {
  if (actionId.value !== undefined && keepsTyped())
    typedTexts()?.set(typedKey(actionId.value, ""), typed);
}
/** The composer's text, which the edited form field takes before any other edit of its form. */
function formDraft(): string | undefined {
  return ownsPresentedEditor() ? text("input") : undefined;
}
onUnmounted(clearFeedback);
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
    // request is settled only once its tab opened.
    const atOnce = (current: PlayerSession) => {
      const request = playerRuntimeUrlRequest(current);
      return request?.atOnce ? request.actionId : undefined;
    };
    void runInput(props.inputSection, id, atOnce, intents.url(openRequestedUrl, null)).then(
      (result) => {
        if (result.kind === "answered") emit("update:session", result.session);
      },
    );
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
    // Text typed for another action, or for a replaced session, reaches the form only when it shows that field again.
    clearTimeout(draftTimer);
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
    // A prefill starts in the composer; the player submits it unchanged or edits it first.
    const presentedInput = foreground.value;
    // A form field being edited, and a question, also one that resumes after an interruption, keeps the text typed
    // for it.
    const typedHere =
      actionId.value !== undefined && form.value === null
        ? typedTexts()?.get(typedKey(actionId.value, ""))
        : undefined;
    if (!loadFormEditor(form.value))
      writeField(
        "input",
        typedHere ??
          (presentedInput !== null && "prefill" in presentedInput
            ? (presentedInput.prefill ?? "")
            : ""),
      );
    clearFeedback();
    await nextTick();
    // Completion releases the disabled guard after publishing the session.
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

async function complete(
  intent: InputIntent,
  refocusInput = true,
  target: "interaction" | "pacing" = "interaction",
  // The action the user acted on, when the input began earlier than this call (a held press).
  expectedActionId?: number,
) {
  // While a chosen image is checked, it is the answer under way; a typed skip waits too.
  if (!props.session || submitting.value || readingImage.value) return;
  suppressComposerRefocus = !refocusInput;
  restoreChoiceFocus =
    document.documentElement.dataset.playerKeyboardFocus === "true" &&
    !!document.activeElement?.closest("[data-foreground-controls]");
  // From the click until the answer settles, the composer and the form's controls are read-only (`submitting`): the
  // answer is the text of the click, and nothing typed meanwhile is lost to the next interaction's text. The composer ends
  // a composition under way as it turns read-only. The plain text field stays writable instead, while the flight holds
  // it (`useAnswerFlight`).
  submitting.value = true;
  flight.begin();
  let settled: "completed" | "refused" | null = null;
  try {
    const targetId = (current: PlayerSession) =>
      target === "pacing"
        ? playerRuntimePacingGate(current)?.actionId
        : activePlayerRuntimeInteraction(current.state)?.actionId;
    const presented = expectedActionId ?? targetId(props.session);
    // Ordinary input is evaluated at once; a session that must be readied first is evaluated once it is.
    const ready = props.prepareInput?.() ?? true;
    // An answer that is not taken settles as a refusal without a notice; like every settlement, after a flush.
    if ((ready !== true && !(await ready)) || !props.inputSection) {
      settled = "refused";
      await nextTick();
      return;
    }
    // The interaction the composer serves now; its answer's publication may present the next one before the chain
    // returns, whose own watch then sets the composer.
    const before = actionId.value;
    const result = await runInput(props.inputSection, presented, targetId, intent);
    // A session that no longer owns the UI, replaced, stopped or unmounted meanwhile, gets no result and no feedback.
    if (result.kind === "retired") {
      flight.release();
      return;
    }
    settled = "refused";
    // Elapsed time may have ended or replaced the presented action; input never targets another action.
    if (result.kind === "unavailable") {
      // A skipped message that already finished needs no feedback.
      if (target === "interaction") showFeedback("This interaction is no longer available.");
      await nextTick();
      return;
    }
    if (result.kind === "unanswered") {
      showFeedback(
        foreground.value?.kind === "show-button"
          ? "Type the exact button text or activate it above."
          : foreground.value?.kind === "form"
            ? "Type the exact text of one button, or use the buttons above."
            : imageTextFeedback.value,
      );
      if (refocusInput) focusInput();
      await nextTick();
      return;
    }
    emit("update:session", result.session);
    clearTimeout(draftTimer);
    // A form edit, also an unchanged one, succeeds without completing the form; the composer then shows the text of
    // the field it edits, if any.
    // The composer gives up its field before its text changes, so the change is never typed text of another one.
    if (result.outcome.kind === "updated" || result.outcome.kind === "unchanged") {
      settled = "completed";
      if (!loadFormEditor(playerRuntimeForm(result.session))) writeField("input", "");
      clearFeedback();
    } else if (result.outcome.kind === "completed") {
      settled = "completed";
      // The answered text goes, unless the next interaction already shows: its prefill or typed text stays.
      if (actionId.value === before) {
        composerOwner = null;
        writeField("input", "");
      }
      clearFeedback();
    } else {
      showFeedback(
        result.outcome.kind === "invalidPayload"
          ? result.outcome.message
          : result.outcome.kind === "executionPending"
            ? "The script moved on; try again."
            : "This interaction is no longer available.",
      );
      if (refocusInput) focusInput();
    }
    // Hold the guard until the parent has published the new canonical session.
    await nextTick();
  } catch (error) {
    flight.fail();
    throw error;
  } finally {
    submitting.value = false;
    suppressComposerRefocus = false;
    // What was typed and given in the flight plays against what the answer left, at once.
    if (settled !== null) flight.settle(settled);
  }
}
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
  void complete(intents.pacing, refocusInput, "pacing", actionId);
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
  if (!request || !images || !capture || submitting.value || readingImage.value) return;
  if (!presents(target)) {
    showFeedback("This interaction is no longer available.");
    return;
  }
  if (files.length !== 1) {
    showFeedback("Choose one image.");
    return;
  }
  readingImage.value = true;
  try {
    const stored = await images.store(files[0]!, request);
    if ("message" in stored) {
      if (presents(target)) showFeedback(stored.message);
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
  if (!capture || !props.session || submitting.value || readingImage.value) return;
  if (control === "file") return composer.value?.openPicker();
  if (control === "use") return complete(capture.answer("button"));
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
    writeField("repeat", "");
    // A question or form that came back meanwhile already holds the composer; its text stays.
    if (key !== undefined) flight.end();
    if (key !== undefined || actionId.value === undefined) {
      writeField("input", "");
      clearFeedback();
    }
    if (key === undefined) return;
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

/** Submits the composer's text, or `typed`, a text given while an earlier answer was in flight. */
function submit(source: "input" | "button", typed = text("input")) {
  if (flight.submit(source)) return;
  const field = lockField.value;
  if (field) {
    // As for askPassword, an empty field answers nothing.
    if (field.busy || text("input") === "") return focusInput();
    // After a mismatch both are typed again: the repeat is emptied, and the password selected, so typing replaces it.
    if (field.repeat && text("repeat") !== text("input")) {
      writeField("repeat", "");
      showFeedback(invalidAnswerMessage("passwordMismatch"));
      composer.value?.selectInput();
      return;
    }
    // The fields keep what was typed, read-only, while the Player locks or opens with it; they empty once it is done.
    props.lock?.submit({ password: text("input"), timeLockMs: null });
    return;
  }
  void complete(intents.composer(typed, source === "input" ? "enter" : "send"), source === "input");
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
            <FormControls
              v-if="form && foreground?.kind === 'form'"
              :key="actionId ?? 0"
              :form="form"
              :accessible-name="foreground.accessibleName"
              :disabled="submitting"
              @step="(fieldId) => complete(intents.formStep(fieldId, formDraft()), false)"
              @submit="complete(intents.formSubmit(formDraft(), 'button'))"
              @cancel="complete(intents.formCancel('button'))"
              @dismiss="complete(intents.formDismiss, false)"
              @clear="complete(intents.formClear, false)"
            />
            <ForegroundControls
              v-else
              :key="actionId ?? 0"
              :foreground="foreground"
              :disabled="submitting || readingImage"
              :image="imageControls"
              @activate="(optionId) => complete(intents.choice(optionId, 'button'))"
              @skip="complete(intents.imageSkip('button'))"
              @open="complete(intents.url(openRequestedUrl, 'button'))"
              @image="imageControl"
            />
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
          v-if="foreground?.kind === 'popup'"
          :key="actionId ?? 0"
          :message="foreground.message"
          :button-text="foreground.buttonText"
          :modal="popupModal ?? true"
          :busy="submitting"
          :area="composition"
          @close="complete(intents.popupClose('button'))"
        />
        <ExportTextDialog
          v-if="foreground?.kind === 'export-text'"
          :key="actionId ?? 0"
          :title="foreground.title"
          :text="foreground.text"
          :file-name="foreground.fileName"
          :modal="popupModal ?? true"
          :busy="submitting"
          :area="composition"
          @close="complete(intents.exportClose('button'))"
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
          :disabled="composerDisabled"
          :pacing="composerShortcuts.pacing"
          :preselected="composerShortcuts.preselected"
          :buttons-only="composerShortcuts.buttonsOnly"
          :fresh-after="presentedAt"
          :submitting="submitting || readingImage || !!lockField?.busy"
          :holding="flight.holding.value"
          :placeholder="
            lockField
              ? (lockField.hint ?? 'Type your response…')
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
          :password="composerField === 'password'"
          :repeat="lockField?.repeat ?? false"
          :accessible-name="
            lockField ? 'Password' : (formEditor?.label ?? foreground?.accessibleName ?? 'Response')
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
          :input-type="composerInputType"
          :feedback="feedback"
          @submit="submit"
          @skip="skipPacing(true)"
          @activate="activatePreselected"
          @escape="formEditor && complete(intents.formDismiss, false)"
          @held="flight.hold"
          @files="submitImage"
        />
      </template>
    </ConversationSurface>
  </div>
</template>
