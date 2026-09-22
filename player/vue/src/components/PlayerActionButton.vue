<script setup lang="ts">
import { computed } from "vue";
import { Button } from "@/components/ui/button";
import { authoredColorToOklch } from "../../../theme/color.js";
import { storyChoiceVariables } from "../../../theme/story-choice.js";

const props = defineProps<{ authoredFill?: string | undefined; disabled?: boolean; surface?: "rail" }>();
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
    :data-surface="surface"
    :style="material"
    :disabled="disabled"
  ><slot /></Button>
</template>

<style scoped>
.player-action-button {
  --action-fill-opacity: 100%;
  height: auto;
  min-height: 43px;
  min-width: 0;
  max-width: 100%;
  flex-shrink: 1;
  padding: 10px 17px;
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: center;
  font-weight: 600;
  line-height: 1.45;
  border: 1px solid var(--story-choice-rim);
  border-radius: 9px;
  color: var(--story-choice-ink);
  background: linear-gradient(color-mix(in oklab, var(--story-choice-top) var(--action-fill-opacity), transparent), color-mix(in oklab, var(--story-choice-bottom) var(--action-fill-opacity), transparent));
  box-shadow: inset 0 1px 0 #ffffff24, 0 1px 0 var(--story-choice-depth), 0 2px 3px #00000020;
  transition: box-shadow 100ms;
}
.player-action-button[data-surface="rail"] { --action-fill-opacity: 60%; }
.player-action-button:hover:not(:disabled) {
  background: linear-gradient(color-mix(in oklab, var(--story-choice-hover-top) var(--action-fill-opacity), transparent), color-mix(in oklab, var(--story-choice-hover-bottom) var(--action-fill-opacity), transparent));
  box-shadow: inset 0 1px 0 #ffffff35, 0 1px 0 var(--story-choice-depth), 0 3px 5px #00000024;
}
.player-action-button:active:not(:disabled) {
  background: color-mix(in oklab, var(--story-choice-pressed) var(--action-fill-opacity), transparent);
  box-shadow: inset 0 1px 2px #00000022;
}
/* Disabled actions use the shared theme roles, not opacity over an arbitrary background. */
.player-action-button:disabled {
  opacity: 1;
  color: var(--theme-text-disabled);
  background: var(--theme-surface-disabled);
  border-color: var(--theme-border-disabled);
  box-shadow: none;
  cursor: not-allowed;
}
.player-action-button:focus-visible {
  outline: 2px solid var(--theme-accent-focus);
  outline-offset: 3px;
}
@media (prefers-reduced-motion: reduce) {
  .player-action-button { transition: none; }
}
</style>
