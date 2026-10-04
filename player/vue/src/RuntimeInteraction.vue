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
} from "../../runtime-adapter.js";
import PlayerActionButton from "@/components/PlayerActionButton.vue";
import Composer from "./Composer.vue";
import ConversationSurface from "./ConversationSurface.vue";
import Transcript from "./Transcript.vue";
import { usePlayerConditions } from "./usePlayerConditions";
import type {
  PlayerTranscriptEntryPresentation,
  PlayerSpeakerPresentation,
} from "../../model.js";

const props = defineProps<{
  session: PlayerRuntimeSession | null;
  reset: number;
  entries: readonly PlayerTranscriptEntryPresentation[];
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
  revision?: number;
  transcriptKey: string;
  /** Brings scene time up to date before input and returns the published session. */
  observeTime?: () => PlayerRuntimeSession | null;
  /** The browser refused audible playback; offer a deliberate retry above the composer. */
  audioBlocked?: boolean;
}>();
const emit = defineEmits<{
  "update:session": [session: PlayerRuntimeSession];
  retryAudio: [];
}>();
const actionId = computed(() =>
  props.session ? activePlayerRuntimeInteraction(props.session.snapshot)?.actionId : undefined,
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
  if (presented?.plan === session.plan && presented.reset === props.reset && presented.actionId === id)
    return presented.value;
  const value = playerRuntimeForeground(session);
  presented = id === undefined ? null : { plan: session.plan, reset: props.reset, actionId: id, value };
  return value;
});
const pacing = computed(() => {
  const gate = props.session ? playerRuntimePacingGate(props.session) : null;
  return gate?.skippable ? gate : null;
});
const root = ref<HTMLElement | null>(null);
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
    // A default answer starts in the composer; the player submits it unchanged or edits it first.
    const presentedInput = foreground.value;
    draft.value =
      presentedInput?.kind === "ask-text" || presentedInput?.kind === "ask-number"
        ? (presentedInput.prefill ?? "")
        : "";
    clearFeedback();
    await nextTick();
    // Completion releases the disabled guard after publishing the session.
    await nextTick();
    // Progression may restore composer focus, but must not steal it from Tools/dialogs.
    if ((ownedFocus || returnToChoice || unownedFocus) && (foreground.value || pacing.value)) {
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
        : activePlayerRuntimeInteraction(current.snapshot)?.actionId;
    const presented = expectedActionId ?? targetId(props.session);
    const session = props.observeTime?.() ?? props.session;
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

function submit(source: "input" | "button") {
  void complete(
    (session) => submitPlayerRuntimeComposer(session, draft.value),
    source === "input",
  );
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
        <p v-if="audioBlocked" class="audio-retry" role="status">
          <span>The browser blocked audio.</span>
          <PlayerActionButton data-audio-retry @click="emit('retryAudio')">Enable audio</PlayerActionButton>
        </p>
        <Composer
          ref="composer"
          v-model="draft"
          :disabled="!foreground && !pacing"
          :pacing="!foreground && !!pacing"
          :submitting="submitting"
          :placeholder="
            foreground && 'hint' in foreground ? foreground.hint : 'Type your response…'
          "
          :accessible-name="foreground?.accessibleName ?? 'Response'"
          :input-mode="
            foreground?.kind !== 'ask-number' ? 'text' : foreground.integer ? 'numeric' : 'decimal'
          "
          :feedback="feedback"
          @submit="submit"
          @skip="skipPacing(true)"
        />
      </template>
    </ConversationSurface>
  </div>
</template>

<style scoped>
.audio-retry {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: center;
  margin: 0 0 8px;
  pointer-events: auto;
}
</style>
