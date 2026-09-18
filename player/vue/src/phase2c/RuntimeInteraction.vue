<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from "vue";
import { Button } from "@/components/ui/button";
import {
  activePlayerRuntimeInteraction, activatePlayerRuntimeButton, playerRuntimeForeground,
  selectPlayerRuntimeChoice, submitPlayerRuntimeComposer,
  type PlayerRuntimeControlResult, type PlayerRuntimeSession,
} from "../../../runtime-adapter.js";

const props = defineProps<{ session: PlayerRuntimeSession | null; reset: number }>();
const emit = defineEmits<{ "update:session": [session: PlayerRuntimeSession] }>();
const foreground = computed(() => props.session ? playerRuntimeForeground(props.session) : null);
const actionId = computed(() => props.session ? activePlayerRuntimeInteraction(props.session.snapshot)?.actionId : undefined);
const root = ref<HTMLElement | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);
const draft = ref("");
const feedback = ref("");
const feedbackId = useId();
const submitting = ref(false);

function focusInput() {
  input.value?.focus({ preventScroll: true });
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

async function complete(operation: (session: PlayerRuntimeSession) => PlayerRuntimeControlResult | null) {
  if (!props.session || submitting.value) return;
  submitting.value = true;
  try {
    const result = operation(props.session);
    if (!result) {
      feedback.value = foreground.value?.kind === "show-button" ? "Activate the button above to continue." : "";
      focusInput();
      return;
    }
    emit("update:session", result.session);
    if (result.outcome.kind === "completed") {
      draft.value = "";
      feedback.value = "";
    } else {
      feedback.value = result.outcome.kind === "invalidPayload" ? result.outcome.message : "This interaction is no longer available.";
      focusInput();
    }
    // Hold the guard until the parent has published the new canonical session.
    await nextTick();
  } finally {
    submitting.value = false;
  }
}
function submit() {
  void complete(session => submitPlayerRuntimeComposer(session, draft.value));
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    submit();
  }
}
</script>

<template>
  <div ref="root" data-runtime-interaction class="min-w-0 shrink-0">
    <div v-if="foreground?.kind === 'choose' || foreground?.kind === 'show-button'"
      :key="actionId" role="group" :aria-label="foreground.accessibleName"
      class="mb-2 flex min-w-0 gap-2 overflow-x-auto pb-1">
      <template v-if="foreground.kind === 'choose'">
        <Button v-for="option in foreground.options" :key="option.id" variant="outline"
          class="h-auto min-h-9 max-w-full shrink-0 whitespace-normal break-words"
          :disabled="submitting" @click="complete(session => selectPlayerRuntimeChoice(session, option.id))">{{ option.label }}</Button>
      </template>
      <Button v-else variant="outline" class="h-auto min-h-9 max-w-full shrink-0 whitespace-normal break-words"
        :aria-label="foreground.accessibleName" :disabled="submitting"
        @click="complete(activatePlayerRuntimeButton)">{{ foreground.label }}</Button>
    </div>
    <form class="flex min-w-0 gap-2" @submit.prevent="submit">
      <textarea ref="input" v-model="draft" rows="1"
        :aria-label="foreground?.accessibleName ?? 'Response'"
        :placeholder="foreground && 'hint' in foreground ? foreground.hint : 'Type your response...'"
        :disabled="!foreground" :aria-invalid="feedback ? true : undefined"
        :aria-describedby="feedback ? feedbackId : undefined"
        class="min-w-0 flex-1 resize-none rounded border border-border bg-[var(--surface-component)] px-3 py-2 text-sm"
        @keydown="keydown" />
      <Button type="submit" variant="outline" :disabled="!foreground || submitting" class="h-auto shrink-0 px-4">Send</Button>
    </form>
    <p v-if="feedback" :id="feedbackId" role="status" class="mt-1 text-sm">{{ feedback }}</p>
  </div>
</template>
