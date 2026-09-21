<script setup lang="ts">
import ForegroundControls from "./ForegroundControls.vue";
import { computed, nextTick, ref, watch } from "vue";
import {
  activePlayerRuntimeInteraction,
  activatePlayerRuntimeButton,
  playerRuntimeForeground,
  selectPlayerRuntimeChoice,
  submitPlayerRuntimeComposer,
  type PlayerRuntimeControlResult,
  type PlayerRuntimeSession,
} from "../../../runtime-adapter.js";
import Composer from "./Composer.vue";
import ConversationSurface from "./ConversationSurface.vue";
import Transcript from "./Transcript.vue";
import type { PlayerTranscriptEntryPresentation, PlayerSpeakerPresentation } from "../../../model.js";

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
const root = ref<HTMLElement | null>(null);
const transcript = ref<InstanceType<typeof Transcript> | null>(null);
const composer = ref<InstanceType<typeof Composer> | null>(null);
const draft = ref("");
const feedback = ref("");
const submitting = ref(false);
let restoreChoiceFocus = false;

function focusInput() {
  composer.value?.focusInput();
}

watch([actionId, () => props.reset], async () => {
  const active = document.activeElement;
  const ownedFocus = !!active && !!root.value?.contains(active);
  const wasEditing = active instanceof HTMLTextAreaElement;
  const returnToChoice = restoreChoiceFocus;
  restoreChoiceFocus = false;
  const keyboardNavigation = document.documentElement.dataset.playerKeyboardFocus === "true";
  draft.value = "";
  feedback.value = "";
  await nextTick();
  // Completion releases the disabled guard after publishing the session.
  await nextTick();
  // Progression may restore composer focus, but must not steal it from Tools/dialogs.
  if ((ownedFocus || returnToChoice) && foreground.value) {
    if (wasEditing) focusInput();
    else if (keyboardNavigation) root.value?.querySelector<HTMLButtonElement>("[data-foreground-controls] button")?.focus({ preventScroll: true });
  }
});

async function complete(
  operation: (session: PlayerRuntimeSession) => PlayerRuntimeControlResult | null,
) {
  if (!props.session || submitting.value) return;
  restoreChoiceFocus = document.documentElement.dataset.playerKeyboardFocus === "true" &&
    !!document.activeElement?.closest("[data-foreground-controls]");
  submitting.value = true;
  try {
    const result = operation(props.session);
    if (!result) {
      feedback.value =
        foreground.value?.kind === "show-button" ? "Activate the button above to continue." : "";
      focusInput();
      return;
    }
    emit("update:session", result.session);
    if (result.outcome.kind === "completed") {
      draft.value = "";
      feedback.value = "";
    } else {
      feedback.value =
        result.outcome.kind === "invalidPayload"
          ? result.outcome.message
          : "This interaction is no longer available.";
      focusInput();
    }
    // Hold the guard until the parent has published the new canonical session.
    await nextTick();
  } finally {
    submitting.value = false;
  }
}
function submit() {
  if (!props.session && props.preview) {
    if (!draft.value.trim()) {
      feedback.value = "Enter a response before sending.";
      focusInput();
      return;
    }
    emit("preview-submit", draft.value);
    draft.value = "";
    feedback.value = "";
    focusInput();
    return;
  }
  void complete((session) => submitPlayerRuntimeComposer(session, draft.value));
}
</script>

<template>
  <div ref="root" data-runtime-interaction class="contents">
    <ConversationSurface @margin-wheel="transcript?.scrollFromMargin($event)">
      <template #default="{ bottomInset }">
        <Transcript ref="transcript" :key="transcriptKey" :entries="entries" :speakers="speakers" :revision="revision ?? 0" :bottom-inset="bottomInset">
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
          :disabled="!foreground && !(preview && !session)"
          :submitting="submitting"
          :placeholder="foreground && 'hint' in foreground ? foreground.hint : 'Type your response…'"
          :accessible-name="foreground?.accessibleName ?? 'Response'"
          :input-mode="foreground?.kind === 'ask-number' ? 'decimal' : 'text'"
          :feedback="feedback"
          @submit="submit"
        />
      </template>
    </ConversationSurface>
  </div>
</template>
