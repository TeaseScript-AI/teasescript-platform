<script setup lang="ts">
import ForegroundControls from "./ForegroundControls.vue";
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import {
  activePlayerRuntimeInteraction,
  activatePlayerRuntimeButton,
  playerRuntimeForeground,
  playerRuntimePacingGate,
  selectPlayerRuntimeChoice,
  skipPlayerRuntimePacing,
  submitPlayerRuntimeComposer,
  type PlayerRuntimeControlResult,
  type PlayerRuntimeSession,
} from "../../../runtime-adapter.js";
import Composer from "./Composer.vue";
import ConversationSurface from "./ConversationSurface.vue";
import Transcript from "./Transcript.vue";
import { usePlayerConditions } from "./usePlayerConditions";
import type {
  PlayerTranscriptEntryPresentation,
  PlayerSpeakerPresentation,
} from "../../../model.js";

const props = defineProps<{
  session: PlayerRuntimeSession | null;
  reset: number;
  preview?: boolean;
  entries: readonly PlayerTranscriptEntryPresentation[];
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
  revision?: number;
  transcriptKey: string;
}>();
const emit = defineEmits<{
  "update:session": [session: PlayerRuntimeSession];
  "preview-submit": [text: string];
}>();
const foreground = computed(() => (props.session ? playerRuntimeForeground(props.session) : null));
const actionId = computed(() =>
  props.session ? activePlayerRuntimeInteraction(props.session.snapshot)?.actionId : undefined,
);
const pacing = computed(() => {
  const gate = props.session ? playerRuntimePacingGate(props.session) : null;
  return gate?.skippable ? gate : null;
});
const root = ref<HTMLElement | null>(null);
const transcript = ref<InstanceType<typeof Transcript> | null>(null);
const composer = ref<InstanceType<typeof Composer> | null>(null);
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
    const active = document.activeElement;
    const ownedFocus = !!active && !!root.value?.contains(active);
    // Default composer focus when nothing else owns it; touch-only devices would raise a keyboard.
    const unownedFocus = (!active || active === document.body) && hoverAvailable.value;
    const wasEditing = active instanceof HTMLTextAreaElement && !suppressComposerRefocus;
    suppressComposerRefocus = false;
    const returnToChoice = restoreChoiceFocus;
    restoreChoiceFocus = false;
    const keyboardNavigation = document.documentElement.dataset.playerKeyboardFocus === "true";
    draft.value = "";
    clearFeedback();
    await nextTick();
    // Completion releases the disabled guard after publishing the session.
    await nextTick();
    // Progression may restore composer focus, but must not steal it from Tools/dialogs.
    if ((ownedFocus || returnToChoice || unownedFocus) && foreground.value) {
      if (wasEditing) focusInput();
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
) {
  if (!props.session || submitting.value) return;
  suppressComposerRefocus = !refocusInput;
  restoreChoiceFocus =
    document.documentElement.dataset.playerKeyboardFocus === "true" &&
    !!document.activeElement?.closest("[data-foreground-controls]");
  submitting.value = true;
  try {
    const result = operation(props.session);
    if (!result) {
      showFeedback(
        foreground.value?.kind === "show-button"
          ? "Type the exact button text or activate it above."
          : "",
      );
      if (refocusInput) focusInput();
      return;
    }
    emit("update:session", result.session);
    if (result.outcome.kind === "completed") {
      draft.value = "";
      clearFeedback();
    } else {
      showFeedback(
        result.outcome.kind === "invalidPayload"
          ? result.outcome.message
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
function skipPacing(refocusInput: boolean) {
  if (!pacing.value || textSelected()) return;
  void complete(skipPlayerRuntimePacing, refocusInput);
}
let pacingGesture: { pointerId: number; x: number; y: number; target: Element } | null = null;
useEventListener(document, "pointerdown", (event: PointerEvent) => {
  const composition = root.value?.closest(".player-composition");
  pacingGesture =
    pacing.value &&
    event.button === 0 &&
    event.isPrimary &&
    event.target instanceof Element &&
    composition?.contains(event.target) &&
    !event.target.closest(pacingSkipExclusions)
      ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY, target: event.target }
      : null;
});
useEventListener(document, "pointermove", (event: PointerEvent) => {
  if (
    pacingGesture?.pointerId === event.pointerId &&
    Math.hypot(event.clientX - pacingGesture.x, event.clientY - pacingGesture.y) > 4
  )
    pacingGesture = null;
});
useEventListener(document, "pointercancel", () => (pacingGesture = null));
useEventListener(document, "pointerup", (event: PointerEvent) => {
  const gesture = pacingGesture;
  pacingGesture = null;
  if (gesture?.pointerId === event.pointerId && gesture.target.isConnected) skipPacing(false);
});

function submit(source: "input" | "button") {
  const refocusInput = source === "input";
  if (!props.session && props.preview) {
    if (!draft.value.trim()) {
      showFeedback("Enter a response before sending.");
      if (refocusInput) focusInput();
      return;
    }
    emit("preview-submit", draft.value);
    draft.value = "";
    clearFeedback();
    if (refocusInput) focusInput();
    return;
  }
  void complete((session) => submitPlayerRuntimeComposer(session, draft.value), refocusInput);
}
</script>

<template>
  <div ref="root" data-runtime-interaction class="contents">
    <ConversationSurface @margin-wheel="transcript?.scrollFromMargin($event)">
      <template #default="{ bottomInset }">
        <Transcript
          ref="transcript"
          :key="transcriptKey"
          :entries="entries"
          :speakers="speakers"
          :revision="revision ?? 0"
          :bottom-inset="bottomInset"
        >
          <template #foreground>
            <ForegroundControls
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
          </template>
        </Transcript>
      </template>
      <template #interaction>
        <Composer
          ref="composer"
          v-model="draft"
          :disabled="!foreground && !pacing && !(preview && !session)"
          :pacing="!foreground && !!pacing"
          :submitting="submitting"
          :placeholder="
            foreground && 'hint' in foreground ? foreground.hint : 'Type your response…'
          "
          :accessible-name="foreground?.accessibleName ?? 'Response'"
          :input-mode="foreground?.kind === 'ask-number' ? 'decimal' : 'text'"
          :feedback="feedback"
          @submit="submit"
          @skip="skipPacing(true)"
        />
      </template>
    </ConversationSurface>
  </div>
</template>
