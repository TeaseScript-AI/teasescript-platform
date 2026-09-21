<script setup lang="ts">
import { computed } from "vue";
import { Button } from "@/components/ui/button";
import { pickerHexToOklch } from "../../../theme/color.js";
import { storyChoiceVariables } from "../../../theme/story-choice.js";

const props = defineProps<{ authoredFill?: string | undefined; disabled?: boolean }>();
const material = computed(() =>
  props.authoredFill === undefined
    ? undefined
    : storyChoiceVariables(pickerHexToOklch(props.authoredFill)),
);
</script>

<template>
  <Button
    type="button"
    variant="ghost"
    class="story-choice"
    :style="material"
    :disabled="disabled"
  ><slot /></Button>
</template>

<style scoped>
.story-choice {
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
  background: linear-gradient(var(--story-choice-top), var(--story-choice-bottom));
  box-shadow: inset 0 1px 0 #ffffff24, 0 1px 0 var(--story-choice-depth), 0 2px 3px #00000020;
  transition: box-shadow 100ms;
}
.story-choice:hover:not(:disabled) {
  background: linear-gradient(var(--story-choice-hover-top), var(--story-choice-hover-bottom));
  box-shadow: inset 0 1px 0 #ffffff35, 0 1px 0 var(--story-choice-depth), 0 3px 5px #00000024;
}
.story-choice:active:not(:disabled) {
  background: var(--story-choice-pressed);
  box-shadow: inset 0 1px 2px #00000022;
}
.story-choice:focus-visible {
  outline: 2px solid var(--theme-accent-focus);
  outline-offset: 3px;
}
@media (prefers-reduced-motion: reduce) {
  .story-choice { transition: none; }
}
</style>
