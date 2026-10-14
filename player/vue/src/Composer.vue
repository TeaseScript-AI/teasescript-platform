<script setup lang="ts" generic="Request">
import { computed, nextTick, ref, useId, watch } from "vue";
import { useTextareaAutosize } from "@vueuse/core";
import { Eye, EyeOff, Paperclip } from "@lucide/vue";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { usePlayerConditions } from "./usePlayerConditions";
import { playerKeys } from "./playerKeys";

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
    /**
     * `askPassword` (V30 §20): a masked field with an eye button that shows the text while the person typing chooses to,
     * and a warning while Caps Lock is on. Each new interaction starts masked.
     */
    password?: boolean;
    /**
     * With `password`, a "Repeat password" field under it, which `repeated` holds: Enter in the password field moves to
     * it, and Enter there submits.
     */
    repeat?: boolean;
    repeated?: string;
    feedback?: string;
    /** A skippable pacing gate is waiting; Space in the empty input settles it. */
    pacing?: boolean;
    /** A preselected button waits; Space in the empty input activates it. */
    preselected?: boolean;
    /** Only buttons wait, no field: Space in the empty input types nothing, and activates only a preselected button. */
    buttonsOnly?: boolean;
    /**
     * When the waiting interaction appeared, as a `performance.now()` time: a key pressed earlier, or held down, does
     * not submit it or activate its button.
     */
    freshAfter?: number;
    /**
     * While an image request accepts a file: a paperclip opens the browser's file picker with this `accept` hint, as
     * `openPicker` does, and a file can be dropped onto the composer. Without it there is neither. `request` identifies
     * the request the files are for.
     */
    attach?: { readonly accept: string; readonly label: string; readonly request: Request } | null;
  }>(),
  {
    disabled: false,
    submitting: false,
    placeholder: "Type your response…",
    accessibleName: "Response",
    inputMode: "text",
    inputType: "text",
    password: false,
    repeat: false,
    repeated: "",
    feedback: "",
    pacing: false,
    preselected: false,
    buttonsOnly: false,
    freshAfter: 0,
    attach: null,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "update:repeated": [value: string];
  submit: [source: "input" | "button"];
  skip: [];
  /** Space in the empty input while a preselected button waits. */
  activate: [];
  /** Escape in the input, which closes an edited form field. */
  escape: [];
  /** Files the player chose or dropped, with the `attach.request` offered when the picker opened or at the drop. */
  files: [files: readonly File[], request: Request];
}>();

const textarea = ref<InstanceType<typeof Textarea> | null>(null);
const picker = ref<HTMLInputElement | null>(null);
const repeatInput = ref<HTMLInputElement | null>(null);
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
const capsLockId = useId();
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
  // A press that began before the interaction appeared, or a held key repeating, belongs to what came before, such as
  // the message the same Space skipped.
  const fresh = !event.repeat && event.timeStamp >= props.freshAfter;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!fresh) return;
    if (props.password && props.repeat && event.currentTarget === picker.value)
      repeatInput.value?.focus({ preventScroll: true });
    else emit("submit", "input");
    return;
  }
  if (event.key === "Escape") {
    emit("escape");
    return;
  }
  const element = input.value;
  const empty = props.modelValue === "" && element?.selectionStart === element?.selectionEnd;
  if (event.key === playerKeys.skipPacing.key && props.pacing && empty) {
    event.preventDefault();
    emit("skip");
  } else if (
    event.key === playerKeys.preselectedButton.key &&
    (props.preselected || props.buttonsOnly) &&
    empty
  ) {
    event.preventDefault();
    if (props.preselected && fresh) emit("activate");
  }
}

/** Send keeps the fresh-press rule of Enter in the input: a held Enter or an earlier press does not submit again. */
function guardSendKey(event: KeyboardEvent): void {
  if (event.key === "Enter" && (event.repeat || event.timeStamp < props.freshAfter))
    event.preventDefault();
}

function updateFromPicker(event: Event): void {
  if (event.target instanceof HTMLInputElement) value.value = event.target.value;
}
function updateRepeated(event: Event): void {
  if (event.target instanceof HTMLInputElement) emit("update:repeated", event.target.value);
}

/** Whether one of the composer's fields has focus. */
function editing(): boolean {
  return document.activeElement === input.value || document.activeElement === repeatInput.value;
}

function preserveEditingFocus(event: PointerEvent): void {
  if (!editing() || event.pointerType === "mouse") return;
  // Android may leave the textarea focused after its software keyboard closes.
  if (!conditions.keyboardRaised.value) {
    suppressSoftwareKeyboard.value = true;
    if (input.value) input.value.inputMode = "none";
  }
  event.preventDefault();
}

// Mouse focus moves on mousedown, which pointerdown cancellation does not prevent.
function keepMouseEditingFocus(event: MouseEvent): void {
  if (editing()) event.preventDefault();
}

// A date or time control, the password field, and the text field replace each other; the field removed while focused
// blurs, and its keyboard state carries over to the replacement instead of being released.
let replacingField = false;
watch(
  () => (props.password ? "password" : props.inputType === "text" ? "text" : "picker"),
  () => {
    replacingField = true;
    void nextTick(() => (replacingField = false));
  },
  { flush: "pre" },
);

function releaseOnBlur(): void {
  capsLock.value = false;
  if (!replacingField) allowSoftwareKeyboard();
}

// The password field's eye button and Caps Lock warning. Only a key event says whether Caps Lock is on; a field that has
// seen none shows no warning.
const shown = ref(false);
const capsLock = ref(false);
function readCapsLock(event: KeyboardEvent): void {
  capsLock.value = event.getModifierState("CapsLock");
}
watch(
  () => [props.password, props.freshAfter],
  () => (shown.value = false),
);

function allowSoftwareKeyboard(): void {
  if (!suppressSoftwareKeyboard.value) return;
  suppressSoftwareKeyboard.value = false;
  if (input.value) input.value.inputMode = props.inputMode;
}

// The picker stays open while the script goes on, so its files are for the request it was opened for. Its input
// stays mounted while requests come and go, so a choice made after a change still arrives.
const filePicker = ref<HTMLInputElement | null>(null);
let pickerOpenedFor: { readonly request: Request } | null = null;
function openPicker(): void {
  if (!props.attach) return;
  pickerOpenedFor = { request: props.attach.request };
  filePicker.value?.click();
}
function chooseFiles(event: Event): void {
  const input = event.currentTarget;
  const opened = pickerOpenedFor;
  pickerOpenedFor = null;
  if (!(input instanceof HTMLInputElement) || !input.files) return;
  const files = [...input.files];
  // The same file may be chosen again after a refused attempt.
  input.value = "";
  if (files.length > 0 && opened) emit("files", files, opened.request);
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
  if (!props.attach || !carriesFiles(event)) return;
  event.preventDefault();
  emit("files", [...(event.dataTransfer?.files ?? [])], props.attach.request);
}
watch(
  () => props.attach,
  (attach) => {
    if (attach === null) dropDepth.value = 0;
  },
);

/** Focuses the input with its text selected, so typing replaces a prefilled value and Enter keeps it. */
function selectInput(): void {
  void nextTick(() => {
    const element = input.value;
    element?.focus({ preventScroll: true });
    if (element instanceof HTMLTextAreaElement) element.select();
  });
}

defineExpose({ focusInput, selectInput, openPicker });
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
            data-composer-attach
            :aria-label="attach.label"
            :title="attach.label"
            :disabled="disabled || submitting"
            @click="openPicker"
          >
            <Paperclip aria-hidden="true" />
          </Button>
        </template>
        <input
          ref="filePicker"
          data-composer-file
          type="file"
          hidden
          :accept="attach?.accept"
          @change="chooseFiles"
        />
        <div v-if="password" class="composer-password-field" data-composer-password>
          <!-- No saved or suggested passwords: a password typed on the player's device must not stay in its browser. -->
          <input
            ref="picker"
            data-composer-input
            :type="shown ? 'text' : 'password'"
            :value="modelValue"
            :placeholder="placeholder"
            :aria-label="accessibleName"
            :aria-invalid="feedback ? true : undefined"
            :aria-describedby="feedback ? `${feedbackId} ${capsLockId}` : capsLockId"
            :inputmode="effectiveInputMode"
            :disabled="disabled"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            class="composer-input composer-picker composer-password-input"
            @input="updateFromPicker"
            @keydown="
              readCapsLock($event);
              handleKeydown($event);
            "
            @keyup="readCapsLock"
            @pointerdown="allowSoftwareKeyboard"
            @blur="releaseOnBlur"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            :aria-label="shown ? 'Hide password' : 'Show password'"
            :title="shown ? 'Hide password' : 'Show password'"
            :disabled="disabled"
            data-composer-password-toggle
            @click="shown = !shown"
            @pointerdown="preserveEditingFocus"
            @mousedown="keepMouseEditingFocus"
          >
            <EyeOff v-if="shown" aria-hidden="true" />
            <Eye v-else aria-hidden="true" />
          </Button>
          <input
            v-if="repeat"
            ref="repeatInput"
            data-composer-repeat
            :type="shown ? 'text' : 'password'"
            :value="repeated"
            placeholder="Repeat password"
            aria-label="Repeat password"
            :aria-invalid="feedback ? true : undefined"
            :aria-describedby="feedback ? `${feedbackId} ${capsLockId}` : capsLockId"
            :inputmode="effectiveInputMode"
            :disabled="disabled"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            class="composer-input composer-picker composer-password-repeat"
            @input="updateRepeated"
            @keydown="
              readCapsLock($event);
              handleKeydown($event);
            "
            @keyup="readCapsLock"
            @pointerdown="allowSoftwareKeyboard"
            @blur="releaseOnBlur"
          />
          <span :id="capsLockId" role="status" class="composer-caps-lock" data-composer-caps-lock>{{
            capsLock ? "Caps Lock is on" : ""
          }}</span>
        </div>
        <div v-else-if="inputType !== 'text'" class="composer-picker-field">
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
          @keydown="guardSendKey"
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
.composer-password-field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 4px;
  min-inline-size: 0;
}
/* The eye button stays beside the password, which takes the rest of the line, and the repeat takes a line of its own. */
.composer-form .composer-picker.composer-password-input {
  flex-basis: 0;
}
.composer-form .composer-picker.composer-password-repeat {
  flex-basis: 100%;
}
.composer-caps-lock {
  flex-basis: 100%;
  padding-inline-start: 12px;
  color: var(--text-muted);
  font-size: 0.875rem;
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
