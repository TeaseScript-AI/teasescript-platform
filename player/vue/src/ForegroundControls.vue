<script setup lang="ts">
import { useResizeObserver } from "@vueuse/core";
import { computed, nextTick, ref, useId, watch } from "vue";
import PlayerActionButton from "./components/PlayerActionButton.vue";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";
import type { PlayerForegroundPresentation } from "../../model.js";
import type { ImageCapturePhase } from "./useImageCapture";

/** The controls of an `askImage` request as its steps stand (`useImageCapture.ts`). */
export interface ImageControls {
  readonly phase: ImageCapturePhase;
  /** Whether the first step offers "Open camera" and "Upload file". */
  readonly camera: boolean;
  readonly file: boolean;
  /** Whether a preview waits, so "Use image" answers. */
  readonly ready: boolean;
}
/** A control of an `askImage` request other than its skip. */
export type ImageControl = "camera" | "file" | "use" | "photo" | "timer" | "back" | "retry";

const props = defineProps<{
  foreground: PlayerForegroundPresentation | null;
  disabled: boolean;
  image?: ImageControls | null;
}>();
const emit = defineEmits<{
  activate: [optionId: string | null];
  skip: [];
  image: [control: ImageControl];
}>();
const group = ref<HTMLElement | null>(null);
const balanceLastRow = ref(false);
const choiceRows = computed(() => {
  const options = props.foreground?.kind === "choose" ? props.foreground.options : [];
  return balanceLastRow.value && options.length >= 3
    ? [options.slice(0, -2), options.slice(-2)]
    : [options];
});

function syncChoiceRows() {
  const element = group.value;
  const options = props.foreground?.kind === "choose" ? props.foreground.options : [];
  if (!element || options.length < 3) {
    balanceLastRow.value = false;
    return;
  }
  const buttons = [...element.querySelectorAll<HTMLButtonElement>("button")];
  if (buttons.length !== options.length) return;
  const available = element.clientWidth;
  const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
  const widths = buttons.map((button) => button.getBoundingClientRect().width);
  const rowCounts: number[] = [];
  let rowWidth = 0;
  let rowCount = 0;
  for (const width of widths) {
    if (rowCount && rowWidth + gap + width > available + 1) {
      rowCounts.push(rowCount);
      rowWidth = 0;
      rowCount = 0;
    }
    rowWidth += (rowCount ? gap : 0) + width;
    rowCount++;
  }
  rowCounts.push(rowCount);
  // Keep authored order, but avoid leaving the final choice alone when a pair fits.
  balanceLastRow.value =
    rowCounts.length > 1 &&
    rowCounts.at(-1) === 1 &&
    (rowCounts.at(-2) ?? 0) >= 2 &&
    (widths.at(-2) ?? 0) + gap + (widths.at(-1) ?? 0) <= available + 1;
}

useResizeObserver(group, syncChoiceRows);
watch(() => props.foreground, async () => {
  balanceLastRow.value = false;
  await nextTick();
  syncChoiceRows();
}, { immediate: true });

const steps = computed(
  (): ImageControls =>
    props.image ?? { phase: "choose", camera: false, file: false, ready: false },
);
// "Use image" stays focusable while there is no image yet: pointing at it, focusing it from the keyboard, or pressing it
// shows why it does not answer, and its description tells a screen reader.
const useHintId = useId();
const useHintOpen = ref(false);
function useImage() {
  if (steps.value.ready) emit("image", "use");
  else useHintOpen.value = true;
}
watch(
  () => steps.value.ready,
  (ready) => {
    if (ready) useHintOpen.value = false;
  },
);
// After the player's step, focus moves to the next step's main control, so the request can be answered from the
// keyboard. A control that disappears with its step keeps the focus "inside" until the next step's control takes it.
const focusInside = ref(false);
const mainImageControl = computed(() => {
  const image = steps.value;
  if (props.foreground?.kind !== "ask-image") return null;
  if (image.phase === "choose")
    return image.ready ? "use" : image.camera ? "camera" : image.file ? "file" : null;
  if (image.phase === "opening" || image.phase === "live") return "photo";
  return image.phase === "unavailable" ? "retry" : null;
});
watch(mainImageControl, async (control) => {
  if (control === null || !focusInside.value) return;
  await nextTick();
  group.value
    ?.querySelector<HTMLElement>(`[data-image-control="${control}"]`)
    ?.focus({ preventScroll: true });
});
function focusOut(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !group.value?.contains(event.relatedTarget))
    focusInside.value = false;
}
</script>
<template>
  <div
    ref="group"
    data-foreground-controls
    v-if="
      foreground?.kind === 'choose' ||
      foreground?.kind === 'show-button' ||
      foreground?.kind === 'ask-image'
    "
    role="group"
    :aria-label="foreground.accessibleName"
    class="flex min-w-0 flex-col items-center"
    @focusin="focusInside = true"
    @focusout="focusOut"
  >
    <template v-if="foreground.kind === 'choose'">
      <div v-for="(row, index) in choiceRows" :key="index" class="flex w-full min-w-0 flex-wrap justify-center gap-2">
        <PlayerActionButton
          v-for="option in row"
          :key="option.id"
          :authored-fill="option.authoredFill"
          :disabled="disabled"
          :label="option.label"
          :preselected="option.preselected"
          @width-change="syncChoiceRows"
          @click="emit('activate', option.id)"
        />
      </div>
    </template>
    <!--
      An image request's first step offers the routes it allows, its skip, and "Use image", which alone answers with the
      preview. The camera step takes the photo at once or after the self-timer, or goes back. None is preselected:
      Space never answers or skips.
    -->
    <div
      v-else-if="foreground.kind === 'ask-image'"
      class="flex w-full min-w-0 flex-wrap justify-center gap-2"
      data-image-controls
      :data-image-step="steps.phase === 'choose' ? 'choose' : 'camera'"
    >
      <template v-if="steps.phase === 'choose'">
        <PlayerActionButton
          v-if="steps.camera"
          :disabled="disabled"
          label="Open camera"
          data-image-control="camera"
          @click="emit('image', 'camera')"
        />
        <PlayerActionButton
          v-if="steps.file"
          :disabled="disabled"
          label="Upload file"
          data-image-control="file"
          @click="emit('image', 'file')"
        />
        <PlayerActionButton
          v-if="foreground.skip !== null"
          :disabled="disabled"
          :label="foreground.skip"
          data-image-skip
          @click="emit('skip')"
        />
        <Tooltip v-model:open="useHintOpen" disable-closing-trigger :disabled="steps.ready">
          <TooltipTrigger as-child>
            <PlayerActionButton
              :disabled="disabled"
              :inactive="!steps.ready"
              :accent="steps.ready"
              :aria-describedby="steps.ready ? undefined : useHintId"
              label="Use image"
              data-image-control="use"
              @click="useImage"
            />
          </TooltipTrigger>
          <TooltipContent data-image-use-hint>Take or choose an image first</TooltipContent>
        </Tooltip>
        <span v-if="!steps.ready" :id="useHintId" hidden>Take or choose an image first</span>
      </template>
      <template v-else>
        <PlayerActionButton
          v-if="steps.phase === 'unavailable'"
          :disabled="disabled"
          label="Try again"
          data-image-control="retry"
          @click="emit('image', 'retry')"
        />
        <template v-else>
          <PlayerActionButton
            :disabled="disabled"
            :inactive="steps.phase !== 'live'"
            label="Take photo"
            data-image-control="photo"
            @click="steps.phase === 'live' && emit('image', 'photo')"
          />
          <PlayerActionButton
            :disabled="disabled"
            :inactive="steps.phase !== 'live'"
            label="Self-timer (5 s)"
            data-image-control="timer"
            @click="steps.phase === 'live' && emit('image', 'timer')"
          />
        </template>
        <PlayerActionButton
          :disabled="disabled"
          label="Back"
          data-image-control="back"
          @click="emit('image', 'back')"
        />
      </template>
    </div>
    <!-- The visible label names the button; the localized default only stands in for a blank label. -->
    <PlayerActionButton
      v-else
      :authored-fill="foreground.authoredFill"
      :aria-label="foreground.label.trim() === '' ? foreground.accessibleName : undefined"
      :disabled="disabled"
      :label="foreground.label"
      preselected
      @click="emit('activate', null)"
    />
  </div>
</template>
<style scoped>
[data-foreground-controls] {
  gap: 8px;
  padding-block-start: var(--player-entry-gap);
}
</style>
