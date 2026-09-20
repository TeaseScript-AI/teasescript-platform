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

const props = defineProps<{
  session: PlayerRuntimeSession | null;
  reset: number;
  preview?: boolean;
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
const composer = ref<InstanceType<typeof Composer> | null>(null);
const draft = ref("");
const feedback = ref("");
const submitting = ref(false);

function focusInput() {
  composer.value?.focusInput();
}

watch([actionId, () => props.reset], async () => {
  const active = document.activeElement;
  const ownedFocus = active === document.body || !!(active && root.value?.contains(active));
  draft.value = "";
  feedback.value = "";
  await nextTick();
  // Progression may restore composer focus, but must not steal it from Tools/dialogs.
  if (ownedFocus && foreground.value) focusInput();
});

async function complete(
  operation: (session: PlayerRuntimeSession) => PlayerRuntimeControlResult | null,
) {
  if (!props.session || submitting.value) return;
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
  <div ref="root" data-runtime-interaction class="min-w-0 shrink-0">
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
  </div>
</template>
