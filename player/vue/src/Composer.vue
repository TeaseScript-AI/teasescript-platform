<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from "vue";
import { useTextareaAutosize } from "@vueuse/core";
import { Paperclip } from "@lucide/vue";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { usePlayerConditions } from "./usePlayerConditions";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    disabled?: boolean;
    submitting?: boolean;
    placeholder?: string;
    accessibleName?: string;
    inputMode?: "text" | "decimal" | "numeric";
    /** A date or time answer uses the browser's own control, whose value is ISO text. */
    inputType?: "text" | "date" | "time" | "datetime-local";
    feedback?: string;
    /** A skippable pacing gate is waiting; Space in the empty input settles it. */
    pacing?: boolean;
    /**
     * While an image request accepts a file: a paperclip opens the browser's file picker with this `accept` hint, and a
     * file dropped onto the composer answers too. Without it there is neither.
     */
    attach?: { readonly accept: string; readonly label: string } | null;
  }>(),
  {
    disabled: false,
    submitting: false,
    placeholder: "Type your response…",
    accessibleName: "Response",
    inputMode: "text",
    inputType: "text",
    feedback: "",
    pacing: false,
    attach: null,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  submit: [source: "input" | "button"];
  skip: [];
  /** Files the player chose or dropped while `attach` was offered. */
  files: [files: readonly File[]];
}>();

const textarea = ref<InstanceType<typeof Textarea> | null>(null);
const picker = ref<HTMLInputElement | null>(null);
const textareaElement = computed(() => {
  const element = textarea.value?.$el;
  return element instanceof HTMLTextAreaElement ? element : undefined;
});
const input = computed(() => picker.value ?? textareaElement.value);
const value = computed({
  get: () => props.modelValue,
  set: (text: string) => emit("update:modelValue", text),
});
const feedbackId = useId();
useTextareaAutosize({ element: textareaElement, input: value });
const conditions = usePlayerConditions();
const suppressSoftwareKeyboard = ref(false);
const effectiveInputMode = computed(() =>
  suppressSoftwareKeyboard.value ? "none" : props.inputMode,
);
function focusInput(): void {
  void nextTick(() => input.value?.focus({ preventScroll: true }));
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    emit("submit", "input");
    return;
  }
  const element = input.value;
  if (
    event.key === " " &&
    props.pacing &&
    props.modelValue === "" &&
    element?.selectionStart === element?.selectionEnd
  ) {
    event.preventDefault();
    emit("skip");
  }
}

function updateFromPicker(event: Event): void {
  if (event.target instanceof HTMLInputElement) value.value = event.target.value;
}

function preserveEditingFocus(event: PointerEvent): void {
  if (document.activeElement !== input.value || event.pointerType === "mouse") return;
  // Android may leave the textarea focused after its software keyboard closes.
  if (!conditions.keyboardRaised.value) {
    suppressSoftwareKeyboard.value = true;
    if (input.value) input.value.inputMode = "none";
  }
  event.preventDefault();
}

// Mouse focus moves on mousedown, which pointerdown cancellation does not prevent.
function keepMouseEditingFocus(event: MouseEvent): void {
  if (document.activeElement === input.value) event.preventDefault();
}

// A date or time control and the text field replace each other; the field removed while focused blurs, and its
// keyboard state carries over to the replacement instead of being released.
let replacingField = false;
watch(
  () => props.inputType === "text",
  () => {
    replacingField = true;
    void nextTick(() => (replacingField = false));
  },
  { flush: "pre" },
);

function releaseOnBlur(): void {
  if (!replacingField) allowSoftwareKeyboard();
}

function allowSoftwareKeyboard(): void {
  if (!suppressSoftwareKeyboard.value) return;
  suppressSoftwareKeyboard.value = false;
  if (input.value) input.value.inputMode = props.inputMode;
}

const filePicker = ref<HTMLInputElement | null>(null);
function chooseFiles(): void {
  const input = filePicker.value;
  if (!input?.files) return;
  const files = [...input.files];
  // The same file may be chosen again after a refused attempt.
  input.value = "";
  if (files.length > 0) emit("files", files);
}

// A file dragged over the composer is a drop target only while `attach` is offered; dragged text and links are not.
// Entering and leaving child elements is counted, so the highlight stays while the file is over the composer.
const dropDepth = ref(0);
const dropActive = computed(() => dropDepth.value > 0);
function carriesFiles(event: DragEvent): boolean {
  return props.attach !== null && event.dataTransfer?.types.includes("Files") === true;
}
function dragEnter(event: DragEvent): void {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dropDepth.value++;
}
function dragOver(event: DragEvent): void {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}
function dragLeave(): void {
  if (dropDepth.value > 0) dropDepth.value--;
}
function drop(event: DragEvent): void {
  dropDepth.value = 0;
  if (!carriesFiles(event)) return;
  event.preventDefault();
  emit("files", [...(event.dataTransfer?.files ?? [])]);
}
watch(
  () => props.attach,
  (attach) => {
    if (attach === null) dropDepth.value = 0;
  },
);

defineExpose({ focusInput });
</script>

<template>
  <div class="composer-container">
    <p v-if="feedback" :id="feedbackId" class="composer-notice" role="status" aria-live="polite">
      {{ feedback }}
    </p>
    <span v-if="feedback" class="composer-notice-arrow" aria-hidden="true" />
    <div
      class="conversation-glass"
      data-composer-shell
      :data-drop-active="dropActive ? true : undefined"
      @dragenter="dragEnter"
      @dragover="dragOver"
      @dragleave="dragLeave"
      @drop="drop"
    >
      <span v-if="dropActive" class="composer-drop-hint" aria-hidden="true">
        Drop the image here
      </span>
      <form
        class="composer-form"
        data-composer-form
        data-runtime-composer
        @submit.prevent="emit('submit', 'button')"
      >
        <template v-if="attach">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            class="composer-attach"
            data-composer-attach
            :aria-label="attach.label"
            :title="attach.label"
            :disabled="disabled || submitting"
            @click="filePicker?.click()"
          >
            <Paperclip aria-hidden="true" />
          </Button>
          <input
            ref="filePicker"
            data-composer-file
            type="file"
            hidden
            :accept="attach.accept"
            @change="chooseFiles"
          />
        </template>
        <div v-if="inputType !== 'text'" class="composer-picker-field">
          <span v-if="placeholder" class="composer-hint" aria-hidden="true">{{ placeholder }}</span>
          <input
            ref="picker"
            data-composer-input
            :type="inputType"
            :step="inputType === 'date' ? undefined : 1"
            :value="modelValue"
            :aria-label="placeholder ? `${accessibleName}: ${placeholder}` : accessibleName"
            :aria-invalid="feedback ? true : undefined"
            :aria-describedby="feedback ? feedbackId : undefined"
            :inputmode="effectiveInputMode"
            :disabled="disabled"
            class="composer-input composer-picker"
            @input="updateFromPicker"
            @keydown="handleKeydown"
            @pointerdown="allowSoftwareKeyboard"
            @blur="releaseOnBlur"
          />
        </div>
        <Textarea
          v-else
          ref="textarea"
          data-composer-input
          rows="1"
          :model-value="modelValue"
          :aria-label="accessibleName"
          :aria-invalid="feedback ? true : undefined"
          :aria-describedby="feedback ? feedbackId : undefined"
          :placeholder="placeholder"
          :inputmode="effectiveInputMode"
          :disabled="disabled"
          variant="embedded"
          class="composer-input"
          @update:model-value="value = String($event)"
          @keydown="handleKeydown"
          @pointerdown="allowSoftwareKeyboard"
          @blur="releaseOnBlur"
        />
        <Button
          type="submit"
          variant="default"
          class="composer-send"
          :disabled="disabled || submitting"
          @pointerdown="preserveEditingFocus"
          @mousedown="keepMouseEditingFocus"
        >
          Send
        </Button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.composer-container {
  position: relative;
  pointer-events: auto;
  --composer-notice-surface: #fff0ef;
  --composer-notice-border: #c75452;
  --composer-notice-text: #762421;
}
:global(:root[data-player-theme="dark"] .composer-container) {
  --composer-notice-surface: #3a2323;
  --composer-notice-border: #e98780;
  --composer-notice-text: #ffd4d1;
}
.conversation-glass {
  position: relative;
  pointer-events: auto;
  border: 1px solid var(--border);
  border-radius: 24px;
  padding-block: 2px;
  padding-inline: 8px 4px;
  background: var(--surface-component);
}
:global(
  :root[data-player-keyboard-focus="true"] [data-composer-shell]:has([data-composer-input]:focus)
) {
  outline: 2px solid var(--focus-ring);
  outline-offset: var(--player-focus-offset);
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
  font-size: var(--player-reading-font-size, 1rem);
}
.composer-form:has(> [data-composer-attach]) {
  grid-template-columns: auto minmax(0, 1fr) auto;
}
.composer-attach {
  align-self: center;
  border-radius: 999px;
}
.conversation-glass[data-drop-active] {
  outline: 2px dashed var(--focus-ring);
  outline-offset: var(--player-focus-offset);
}
.composer-drop-hint {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  place-items: center;
  border-radius: inherit;
  background: var(--surface-component);
  color: var(--foreground);
  font-size: 0.875rem;
  font-weight: 700;
  pointer-events: none;
}
.composer-form .composer-input {
  min-block-size: calc(1em + var(--player-reading-line-gap, 8px) + 12px);
  max-block-size: min(10lh, var(--composer-input-limit, 30dvh));
  overflow-y: auto;
  resize: none;
  padding: 6px 12px;
  border: 0;
  background: transparent;
  color: var(--foreground);
  font: inherit;
  line-height: calc(1em + var(--player-reading-line-gap, 8px));
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong) transparent;
}
.composer-picker-field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-inline-size: 0;
}
.composer-hint {
  padding-inline-start: 12px;
  color: var(--text-muted);
}
.composer-form .composer-picker {
  flex: 1 1 auto;
  min-inline-size: 0;
  overflow: visible;
  color-scheme: light;
}
:global(:root[data-player-theme="dark"] .composer-picker) {
  color-scheme: dark;
}
.composer-form .composer-input:focus-visible {
  outline: none;
  box-shadow: none;
}
:global(:root[data-player-theme] [data-composer-input]:disabled) {
  background: transparent;
  color: var(--theme-text-disabled);
}
.composer-send {
  min-inline-size: calc(3rem + 24px);
  min-block-size: calc(1.5rem + 12px);
  border-block: 2px solid transparent;
  background-clip: padding-box;
  border-radius: 16px;
  padding: 0 16px;
  font-size: 0.875rem;
  font-weight: 700;
}

.composer-notice {
  position: absolute;
  inset-inline-start: 12px;
  bottom: calc(100% + 8px);
  z-index: 1;
  inline-size: fit-content;
  max-inline-size: 100%;
  max-block-size: min(12rem, 35dvh);
  overflow-y: auto;
  margin: 0;
  padding: 8px 12px;
  border: 1px solid var(--composer-notice-border);
  border-radius: 12px;
  background: var(--composer-notice-surface);
  color: var(--composer-notice-text);
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.14);
  font-size: 0.875rem;
}
.composer-notice-arrow {
  position: absolute;
  bottom: calc(100% + 2px);
  z-index: 2;
  inset-inline-start: 40px;
  inline-size: 12px;
  block-size: 12px;
  transform: rotate(45deg);
  background: var(--composer-notice-surface);
  border-right: 1px solid var(--composer-notice-border);
  border-bottom: 1px solid var(--composer-notice-border);
}
</style>
