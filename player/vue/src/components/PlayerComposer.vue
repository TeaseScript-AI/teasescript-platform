<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { PlayerForegroundPresentation } from "../../../model.js";

const props = defineProps<{
  feedback: string;
  foreground: PlayerForegroundPresentation | null;
  modelValue: string;
}>();

const emit = defineEmits<{
  "input-blur": [];
  "touch-input": [];
  "update:modelValue": [value: string];
  submit: [];
}>();

const input = ref<HTMLTextAreaElement | null>(null);
const placeholder = computed(() =>
  props.foreground?.kind === "ask-text" || props.foreground?.kind === "ask-number"
    ? props.foreground.hint
    : "Type your response…",
);
const accessibleName = computed(() => props.foreground?.accessibleName ?? "User input");
const inputMode = computed(() => (props.foreground?.kind === "ask-number" ? "decimal" : "text"));

watch(() => props.modelValue, resizeInput);
onMounted(resizeInput);

function resizeInput(): void {
  void nextTick(() => {
    const element = input.value;
    if (element === null) return;
    element.style.blockSize = "auto";
    const borderSize = element.offsetHeight - element.clientHeight;
    element.style.blockSize = `${element.scrollHeight + borderSize}px`;
  });
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    emit("submit");
  }
}

function handlePointerDown(event: PointerEvent): void {
  if (event.pointerType !== "mouse") emit("touch-input");
}
</script>

<template>
  <footer class="composer">
    <form @submit.prevent="$emit('submit')">
      <textarea
        ref="input"
        rows="1"
        autofocus
        :aria-label="accessibleName"
        :inputmode="inputMode"
        :placeholder="placeholder"
        :value="modelValue"
        @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        @blur="$emit('input-blur')"
        @keydown="handleKeydown"
        @pointerdown="handlePointerDown"
      ></textarea>

      <button class="send-button" type="submit">Send</button>
    </form>

    <div v-if="feedback.length > 0" class="composer-feedback" role="status" aria-live="polite">
      {{ feedback }}
    </div>
  </footer>
</template>
