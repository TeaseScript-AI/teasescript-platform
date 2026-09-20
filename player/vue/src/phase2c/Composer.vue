<script setup lang="ts">
import { computed, nextTick, ref, useId } from "vue";
import { useTextareaAutosize } from "@vueuse/core";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    disabled?: boolean;
    submitting?: boolean;
    placeholder?: string;
    accessibleName?: string;
    inputMode?: "text" | "decimal";
    feedback?: string;
  }>(),
  {
    disabled: false,
    submitting: false,
    placeholder: "Type your response…",
    accessibleName: "Response",
    inputMode: "text",
    feedback: "",
  },
);

const emit = defineEmits<{ "update:modelValue": [value: string]; submit: [] }>();

const textarea = ref<InstanceType<typeof Textarea> | null>(null);
const input = computed(() => {
  const element = textarea.value?.$el;
  return element instanceof HTMLTextAreaElement ? element : undefined;
});
const value = computed({
  get: () => props.modelValue,
  set: (text: string) => emit("update:modelValue", text),
});
const feedbackId = useId();
useTextareaAutosize({ element: input, input: value });

function focusInput(): void {
  void nextTick(() => input.value?.focus({ preventScroll: true }));
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    emit("submit");
    return;
  }
}

defineExpose({ focusInput });
</script>

<template>
  <div class="conversation-glass" data-composer-shell>
    <form
      class="composer-form"
      data-composer-form
      data-runtime-composer
      @submit.prevent="emit('submit')"
    >
      <Textarea
        ref="textarea"
        data-composer-input
        rows="1"
        :model-value="modelValue"
        :aria-label="accessibleName"
        :aria-invalid="feedback ? true : undefined"
        :aria-describedby="feedback ? feedbackId : undefined"
        :placeholder="placeholder"
        :inputmode="inputMode"
        :disabled="disabled"
        class="composer-input min-h-0 rounded-none border-0 shadow-none focus-visible:ring-0"
        @update:model-value="value = String($event)"
        @keydown="handleKeydown"
      />
      <Button
        type="submit"
        variant="default"
        class="composer-send"
        :disabled="disabled || submitting"
      >
        Send
      </Button>
    </form>
    <p v-if="feedback" :id="feedbackId" class="composer-feedback" role="status" aria-live="polite">
      {{ feedback }}
    </p>
  </div>
</template>

<style scoped>
.conversation-glass {
  pointer-events: auto;
  border: 1px solid var(--border);
  border-radius: 24px;
  padding: 8px;
  background: var(--surface-component);
}
.conversation-glass:has(textarea:focus-visible) {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
@supports (backdrop-filter: blur(1px)) {
  .conversation-glass {
    background: color-mix(in srgb, var(--surface-component) 96%, transparent);
    backdrop-filter: blur(4px);
  }
}
.composer-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 8px;
}
.composer-form .composer-input {
  min-block-size: calc(1.5rem + 16px);
  max-block-size: min(10lh, var(--composer-input-limit, 30dvh));
  overflow-y: auto;
  resize: none;
  padding: 8px 12px;
  border: 0;
  background: transparent;
  color: var(--foreground);
  font: inherit;
  line-height: 1.5;
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong) transparent;
}
.composer-form .composer-input:focus-visible {
  outline: none;
  box-shadow: none;
}
:global(:root[data-phase2c-theme] [data-composer-input]:disabled) {
  background: transparent;
  color: var(--theme-text-disabled);
}
.composer-send {
  min-inline-size: calc(3rem + 24px);
  min-block-size: calc(1.5rem + 16px);
  border-radius: 16px;
  padding-inline: 16px;
  font-size: 0.875rem;
  font-weight: 700;
}

.composer-feedback {
  margin: 0.25rem 0 0;
  color: var(--theme-text-secondary, var(--text-muted));
  font-size: 0.875rem;
}
</style>
