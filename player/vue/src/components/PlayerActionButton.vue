<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUpdated, ref } from "vue";
import { Button } from "@/components/ui/button";
import { authoredColorToOklch } from "../../../theme/color.js";
import { storyChoiceVariables } from "../../../theme/story-choice.js";

const props = defineProps<{
  authoredFill?: string | undefined;
  disabled?: boolean;
  /** Looks and is announced disabled but keeps keyboard focus, for a control that becomes active again in place. */
  inactive?: boolean;
  label?: string | undefined;
}>();
const emit = defineEmits<{ widthChange: [] }>();
const labelElement = ref<HTMLElement | null>(null);
let observer: ResizeObserver | undefined;
let measureFrame = 0;

function fitWrappedLabel() {
  const text = labelElement.value;
  const button = text?.closest("button");
  if (!text || !button) return;

  const previousWidth = button.getBoundingClientRect().width;
  button.style.width = "";
  const range = document.createRange();
  range.selectNodeContents(text);
  const lines = range.getClientRects();
  if (lines.length > 1) {
    const style = getComputedStyle(button);
    const inset =
      Number.parseFloat(style.paddingLeft) +
      Number.parseFloat(style.paddingRight) +
      Number.parseFloat(style.borderLeftWidth) +
      Number.parseFloat(style.borderRightWidth);
    let widestLine = 0;
    for (const line of lines) widestLine = Math.max(widestLine, line.width);
    button.style.width = `${Math.ceil(widestLine + inset)}px`;
  }
  if (Math.abs(button.getBoundingClientRect().width - previousWidth) > 1) emit("widthChange");
}

function scheduleFit() {
  cancelAnimationFrame(measureFrame);
  measureFrame = requestAnimationFrame(fitWrappedLabel);
}

onMounted(() => {
  if (props.label === undefined) return;
  const group = labelElement.value?.closest("button")?.parentElement;
  observer = new ResizeObserver(scheduleFit);
  if (group) observer.observe(group);
  scheduleFit();
  void document.fonts.ready.then(scheduleFit);
});
onUpdated(scheduleFit);
onBeforeUnmount(() => {
  observer?.disconnect();
  cancelAnimationFrame(measureFrame);
});

const material = computed(() =>
  props.authoredFill === undefined
    ? undefined
    : storyChoiceVariables(authoredColorToOklch(props.authoredFill)),
);
</script>

<template>
  <Button
    type="button"
    variant="ghost"
    class="player-action-button"
    :style="material"
    :disabled="disabled"
    :aria-disabled="inactive ? 'true' : undefined"
  >
    <span v-if="props.label !== undefined" ref="labelElement" class="player-action-label">{{ props.label }}</span>
    <slot v-else />
  </Button>
</template>

<style scoped>
.player-action-button {
  --button-text: var(--story-choice-ink);
  height: auto;
  min-height: 44px;
  min-width: 0;
  max-width: 100%;
  flex-shrink: 1;
  padding: 8px 12px;
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: center;
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.3;
  border: 1px solid var(--story-choice-rim);
  border-radius: 9px;
  color: var(--story-choice-ink);
  background: linear-gradient(var(--story-choice-top), var(--story-choice-bottom));
  box-shadow: inset 0 1px 0 #ffffff24, 0 1px 0 var(--story-choice-depth), 0 2px 3px #00000020;
  transition: box-shadow 100ms;
}
.player-action-label {
  min-width: 0;
  max-width: 55ch;
}
/* Hover and press change only the fill and shadows: the rim keeps its colour, overriding the shared button rule's
   border, so no line appears, and nothing changes size. Only keyboard focus draws an outline. */
.player-action-button:hover:not(:disabled, [aria-disabled="true"]) {
  border-color: var(--story-choice-rim);
  background: linear-gradient(var(--story-choice-hover-top), var(--story-choice-hover-bottom));
  box-shadow: inset 0 1px 0 #ffffff35, 0 1px 0 var(--story-choice-depth), 0 3px 5px #00000024;
}
.player-action-button:active:not(:disabled, [aria-disabled="true"]) {
  border-color: var(--story-choice-rim);
  background: var(--story-choice-pressed);
  box-shadow: inset 0 1px 2px #00000022, 0 1px 0 var(--story-choice-depth);
}
/* Disabled actions use the shared theme roles, not opacity over an arbitrary background. */
.player-action-button:disabled,
.player-action-button[aria-disabled="true"] {
  opacity: 1;
  color: var(--theme-text-disabled);
  background: var(--theme-surface-disabled);
  border-color: var(--theme-border-disabled);
  box-shadow: none;
  cursor: not-allowed;
}
.player-action-button:focus-visible {
  outline: 2px solid var(--theme-accent-focus);
  outline-offset: var(--player-focus-offset);
}
@media (prefers-reduced-motion: reduce) {
  .player-action-button { transition: none; }
}
</style>
