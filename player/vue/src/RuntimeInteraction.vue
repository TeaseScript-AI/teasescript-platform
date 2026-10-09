<script setup lang="ts">
import ForegroundControls from "./ForegroundControls.vue";
import FormControls from "./FormControls.vue";
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import {
  activePlayerRuntimeInteraction,
  activatePlayerRuntimeButton,
  answerPlayerRuntimeImage,
  playerRuntimeForeground,
  playerRuntimeForm,
  playerRuntimePacingGate,
  selectPlayerRuntimeChoice,
  skipPlayerRuntimePacing,
  cancelPlayerRuntimeForm,
  clearPlayerRuntimeFormField,
  dismissPlayerRuntimeFormField,
  draftPlayerRuntimeForm,
  playerRuntimeFormActionIds,
  stepPlayerRuntimeFormField,
  submitPlayerRuntimeComposer,
  submitPlayerRuntimeForm,
  type PlayerRuntimeControlResult,
  type PlayerRuntimeSession,
} from "../../runtime-adapter.js";
import Composer from "./Composer.vue";
import ConversationSurface from "./ConversationSurface.vue";
import Transcript from "./Transcript.vue";
import { usePlayerConditions } from "./usePlayerConditions";
import type {
  PlayerFormPresentation,
  PlayerTranscriptEntryPresentation,
  PlayerSpeakerPresentation,
} from "../../model.js";
import { imagePickerAccept, type ImageFileFilters } from "../../image-file.js";
import type { CapturedMediaAdmission } from "../../../src/index.js";

/** How the host stores an image file the player chose for `askImage`, and vouches for it. */
export interface PlayerImageInput {
  store(
    file: File,
    filters: ImageFileFilters,
  ): Promise<{ readonly reference: string } | { readonly message: string }>;
  readonly admission: CapturedMediaAdmission;
  discard(reference: string): void;
  /** Whether a photo from the camera can answer here. */
  readonly camera: boolean;
}

const props = defineProps<{
  session: PlayerRuntimeSession | null;
  reset: number;
  entries: readonly PlayerTranscriptEntryPresentation[];
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
  revision?: number;
  /** The revision through which the transcript shows directly, like history (`PlayerSessionHost.jumpedRevision`). */
  jumpedRevision?: number;
  transcriptKey: string;
  /** Brings scene time up to date before input and returns the published session. */
  observeTime?: () => PlayerRuntimeSession | null;
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
  /** Answers `askImage` with a chosen file; without it an image request offers no file input. */
  images?: PlayerImageInput;
  /** The Debug countdown line, shown under the foreground controls while Debug runs (DEBUGGER.md "Player Debug"). */
  debugCountdown?: string | null;
}>();
const emit = defineEmits<{ "update:session": [session: PlayerRuntimeSession] }>();
const actionId = computed(() =>
  props.session ? activePlayerRuntimeInteraction(props.session.state)?.actionId : undefined,
);
// An interaction's presentation is fixed for its lifetime. Keep one object per action so frequent time and media
// observations do not re-render, and re-measure, the controls on every update.
// Action IDs restart per session; the plan and the host's reset count identify which session an ID belongs to.
let presented: {
  readonly plan: PlayerRuntimeSession["plan"];
  readonly reset: number;
  readonly actionId: number;
  readonly value: ReturnType<typeof playerRuntimeForeground>;
} | null = null;
const foreground = computed(() => {
  const session = props.session;
  if (!session) return null;
  const id = actionId.value;
  if (
    presented?.plan === session.plan &&
    presented.reset === props.reset &&
    presented.actionId === id
  )
    return presented.value;
  const value = playerRuntimeForeground(session);
  presented =
    id === undefined ? null : { plan: session.plan, reset: props.reset, actionId: id, value };
  return value;
});
// A form's answers change with each edit, unlike the rest of its presentation.
const form = computed(() => (props.session ? playerRuntimeForm(props.session) : null));
/**
 * The composer's latest text for each field being edited, by action and field, for this session, so a form shows it
 * again when it resumes after a block interrupted it, also before the text reached the form, and also when that block
 * opened a form of its own.
 */
let typed: {
  readonly plan: PlayerRuntimeSession["plan"];
  readonly reset: number;
  readonly texts: Map<string, string>;
} | null = null;
function typedTexts(): Map<string, string> | null {
  if (!props.session) return null;
  if (typed?.plan !== props.session.plan || typed.reset !== props.reset)
    typed = { plan: props.session.plan, reset: props.reset, texts: new Map() };
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
  draft.value =
    typedTexts()?.get(typedKey(current.actionId, current.editor.fieldId)) ?? current.editor.text;
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
// Only the forms that can still be answered keep their text, so a script that asks again and again keeps no more.
watch(
  () => form.value?.actionId,
  () => {
    const texts = typedTexts();
    if (!texts || !props.session) return;
    const pending = new Set(playerRuntimeFormActionIds(props.session.state));
    for (const key of texts.keys())
      if (!pending.has(parseTypedKey(key).actionId)) texts.delete(key);
  },
);
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
  void complete((session) =>
    target === null
      ? activatePlayerRuntimeButton(session)
      : selectPlayerRuntimeChoice(session, target),
  );
}
// An image request accepts a file through the paperclip or a drop only while it allows files.
const imageRequest = computed(() =>
  foreground.value?.kind === "ask-image" ? foreground.value : null,
);
// A request is one action of one session; its identity is fixed while frequent observations publish new sessions.
const plan = computed(() => props.session?.plan);
const attach = computed(() =>
  imageRequest.value?.allowFile === true &&
  props.images &&
  plan.value !== undefined &&
  actionId.value !== undefined
    ? {
        accept: imagePickerAccept(imageRequest.value),
        label: "Attach an image",
        request: { plan: plan.value, reset: props.reset, actionId: actionId.value },
      }
    : null,
);
// The camera opens by itself for a request that allows it, on the Stage or in the camera window.
const camera = computed(
  () => imageRequest.value?.allowCamera === true && props.images?.camera === true,
);
// Typed text never answers an image request; the notice names the routes it offers.
const imageTextFeedback = computed(() =>
  attach.value && camera.value
    ? "Take a photo with the camera, or attach or drop an image."
    : attach.value
      ? "Attach an image with the paperclip, or drop it onto the message field."
      : camera.value
        ? "Take a photo with the camera."
        : "",
);
type ImageRequestIdentity = NonNullable<typeof attach.value>["request"];
/** Whether the image request the files are for is the one presented now. */
function presents(request: ImageRequestIdentity): boolean {
  return (
    imageRequest.value !== null &&
    props.session?.plan === request.plan &&
    props.reset === request.reset &&
    activePlayerRuntimeInteraction(props.session.state)?.actionId === request.actionId
  );
}
const readingImage = ref(false);
const root = ref<HTMLElement | null>(null);
// Composer is generic over the image request it reports, so its instance type is named by what is used.
const composer = ref<{ focusInput(): void; selectInput(): void } | null>(null);
const draft = ref("");
const feedback = ref("");
const submitting = ref(false);
let feedbackTimeout: ReturnType<typeof setTimeout> | undefined;
let restoreChoiceFocus = false;
let suppressComposerRefocus = false;

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

watch(draft, clearFeedback);

// The composer edits one form field at a time: it opens with the field's text selected, so typing replaces it and
// Enter keeps it; after the field closes, focus returns to the field's button.
const formEditor = computed(() => form.value?.editor ?? null);
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
watch(draft, (text) => {
  clearTimeout(draftTimer);
  if (!ownsPresentedEditor() || !props.session) return;
  const target = composerOwner!;
  const { plan } = props.session;
  const reset = props.reset;
  typedTexts()?.set(typedKey(target.actionId, target.fieldId), text);
  if (text === formEditor.value?.text) return;
  draftTimer = setTimeout(() => {
    // A replaced session, such as one Debug's rewind restored, takes no text typed for another.
    if (props.session?.plan !== plan || props.reset !== reset || submitting.value) return;
    if (props.holdFormDrafts) return;
    // The text reaches only its own action's field; while another is presented it stays typed for the return.
    const result = draftPlayerRuntimeForm(props.session, target, text);
    if (result?.outcome.kind === "updated") emit("update:session", result.session);
  }, 400);
});
onUnmounted(() => clearTimeout(draftTimer));
/** The composer's text, which the edited form field takes before any other edit of its form. */
function formDraft(): string | undefined {
  return ownsPresentedEditor() ? draft.value : undefined;
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

function focusInput() {
  composer.value?.focusInput();
}

const { hoverAvailable } = usePlayerConditions();
watch(
  [actionId, () => props.reset],
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
    suppressComposerRefocus = false;
    const returnToChoice = restoreChoiceFocus;
    restoreChoiceFocus = false;
    const keyboardNavigation = document.documentElement.dataset.playerKeyboardFocus === "true";
    // A prefill starts in the composer; the player submits it unchanged or edits it first.
    const presentedInput = foreground.value;
    // A form field being edited, also one that resumes after an interruption, keeps the text typed for it.
    if (!loadFormEditor(form.value))
      draft.value =
        presentedInput !== null && "prefill" in presentedInput
          ? (presentedInput.prefill ?? "")
          : "";
    clearFeedback();
    await nextTick();
    // Completion releases the disabled guard after publishing the session.
    await nextTick();
    // Progression may restore composer focus, but must not steal it from Tools/dialogs.
    if ((ownedFocus || returnToChoice || unownedFocus) && (foreground.value || pacing.value)) {
      if (wasEditing) focusInput();
      // A date or time control and the text field replace each other; the editing focus Send kept moves to the new one.
      else if (composerFocused && !root.value?.contains(document.activeElement)) focusInput();
      else if (unownedFocus) {
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
  operation: (session: PlayerRuntimeSession) => PlayerRuntimeControlResult | null,
  refocusInput = true,
  target: "interaction" | "pacing" = "interaction",
  // The action the user acted on, when the input began earlier than this call (a held press).
  expectedActionId?: number,
) {
  if (!props.session || submitting.value) return;
  suppressComposerRefocus = !refocusInput;
  restoreChoiceFocus =
    document.documentElement.dataset.playerKeyboardFocus === "true" &&
    !!document.activeElement?.closest("[data-foreground-controls]");
  submitting.value = true;
  try {
    const targetId = (current: PlayerRuntimeSession) =>
      target === "pacing"
        ? playerRuntimePacingGate(current)?.actionId
        : activePlayerRuntimeInteraction(current.state)?.actionId;
    const presented = expectedActionId ?? targetId(props.session);
    // Ordinary input is evaluated at once; a session that must be readied first is evaluated once it is.
    const ready = props.prepareInput?.() ?? true;
    if (ready !== true && !(await ready)) return;
    const session = props.observeTime?.() ?? props.session;
    if (!session) return;
    // Elapsed time may have ended or replaced the presented action; input never targets another action.
    if (targetId(session) !== presented) {
      // A skipped message that already finished needs no feedback.
      if (target === "interaction") showFeedback("This interaction is no longer available.");
      return;
    }
    const result = operation(session);
    if (!result) {
      showFeedback(
        foreground.value?.kind === "show-button"
          ? "Type the exact button text or activate it above."
          : foreground.value?.kind === "form"
            ? "Type the exact text of one button, or use the buttons above."
            : imageTextFeedback.value,
      );
      if (refocusInput) focusInput();
      return;
    }
    emit("update:session", result.session);
    clearTimeout(draftTimer);
    // A form edit, also an unchanged one, succeeds without completing the form; the composer then shows the text of
    // the field it edits, if any.
    // The composer gives up its field before its text changes, so the change is never typed text of another one.
    if (result.outcome.kind === "updated" || result.outcome.kind === "unchanged") {
      if (!loadFormEditor(playerRuntimeForm(result.session))) draft.value = "";
      clearFeedback();
    } else if (result.outcome.kind === "completed") {
      composerOwner = null;
      draft.value = "";
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
  } finally {
    submitting.value = false;
    suppressComposerRefocus = false;
  }
}
// The skippable pacing gate settles from Space in the empty composer or a stationary primary
// click/tap on unused Player space. Controls, message text and selections keep their own behavior.
const pacingSkipExclusions = [
  "button, a, input, textarea, select, label, summary, [contenteditable]",
  "[role=button], [role=link], [role=menuitem], [role=separator], [role=slider], [role=tab]",
  "[data-slot=bubble], .prose, .session-event, [data-slot=scroll-area-scrollbar]",
].join(", ");
function textSelected() {
  const selection = document.getSelection();
  return !!selection && !selection.isCollapsed;
}
function skipPacing(refocusInput: boolean, actionId?: number) {
  if (!pacing.value || textSelected()) return;
  void complete(skipPlayerRuntimePacing, refocusInput, "pacing", actionId);
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

/**
 * Answers the image request the files are for with one chosen or dropped file. Files for a request that is no longer
 * presented, such as one a timer's request replaced while the picker was open, answer nothing. The file is checked and
 * stored first; when the request ended or the session was replaced meanwhile, or the runtime did not take the image,
 * the stored image is dropped.
 */
async function submitImage(files: readonly File[], target: ImageRequestIdentity) {
  const request = imageRequest.value;
  const images = props.images;
  if (!request || !images || submitting.value || readingImage.value) return;
  if (!presents(target)) {
    showFeedback("This interaction is no longer available.");
    return;
  }
  if (files.length !== 1) {
    showFeedback("Choose one image.");
    return;
  }
  readingImage.value = true;
  let stored: Awaited<ReturnType<PlayerImageInput["store"]>>;
  try {
    stored = await images.store(files[0]!, request);
  } finally {
    readingImage.value = false;
  }
  const same = presents(target);
  if ("message" in stored) {
    if (same) showFeedback(stored.message);
    return;
  }
  if (!same) {
    images.discard(stored.reference);
    return;
  }
  let accepted = false;
  await complete(
    (latest) => {
      const result = answerPlayerRuntimeImage(latest, stored.reference, images.admission);
      accepted = result?.outcome.kind === "completed";
      return result;
    },
    false,
    "interaction",
    target.actionId,
  );
  if (!accepted) images.discard(stored.reference);
}

function submit(source: "input" | "button") {
  void complete((session) => submitPlayerRuntimeComposer(session, draft.value), source === "input");
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
          :bottom-inset="bottomInset"
        >
          <template #foreground>
            <FormControls
              v-if="form && foreground?.kind === 'form'"
              :key="actionId ?? 0"
              :form="form"
              :accessible-name="foreground.accessibleName"
              :disabled="submitting"
              @step="
                (fieldId) =>
                  complete(
                    (session) => stepPlayerRuntimeFormField(session, fieldId, formDraft()),
                    false,
                  )
              "
              @submit="complete((session) => submitPlayerRuntimeForm(session, formDraft()))"
              @cancel="complete(cancelPlayerRuntimeForm)"
              @dismiss="complete(dismissPlayerRuntimeFormField, false)"
              @clear="complete(clearPlayerRuntimeFormField, false)"
            />
            <ForegroundControls
              v-else
              :key="actionId ?? 0"
              :foreground="foreground"
              :disabled="submitting"
              @activate="
                (optionId) =>
                  complete((session) =>
                    optionId === null
                      ? activatePlayerRuntimeButton(session)
                      : selectPlayerRuntimeChoice(session, optionId),
                  )
              "
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
        <Composer
          ref="composer"
          v-model="draft"
          :disabled="!foreground && !pacing"
          :pacing="!foreground && !!pacing"
          :preselected="preselected !== undefined"
          :buttons-only="
            foreground?.kind === 'choose' ||
            foreground?.kind === 'show-button' ||
            (foreground?.kind === 'form' && !formEditor)
          "
          :fresh-after="presentedAt"
          :submitting="submitting || readingImage"
          :placeholder="
            formEditor
              ? formEditor.hint
              : imageRequest
                ? imageRequest.hint || 'Add an image…'
                : foreground && 'hint' in foreground
                  ? foreground.hint
                  : 'Type your response…'
          "
          :attach="attach"
          :accessible-name="formEditor?.label ?? foreground?.accessibleName ?? 'Response'"
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
          @submit="submit"
          @skip="skipPacing(true)"
          @activate="activatePreselected"
          @escape="formEditor && complete(dismissPlayerRuntimeFormField, false)"
          @files="submitImage"
        />
      </template>
    </ConversationSurface>
  </div>
</template>
