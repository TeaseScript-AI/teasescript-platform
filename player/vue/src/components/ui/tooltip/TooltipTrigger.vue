<script setup lang="ts">
import { definedProps } from "@/lib/definedProps";
import type { TooltipTriggerProps } from "reka-ui"
import { TooltipTrigger } from "reka-ui"
import { playerPointerModality } from "@/usePlayerKeyboardFocus"

const props = defineProps<TooltipTriggerProps>()

// Focus opens a tooltip only during keyboard navigation. After keyboard use, Chromium can keep
// :focus-visible for script focus that follows a mouse click, and Reka's ignoreNonKeyboardFocus
// relies on it, so the Player's own input modality decides.
function ignorePointerFocus(event: FocusEvent) {
  if (playerPointerModality()) event.stopImmediatePropagation()
}
</script>

<template>
  <TooltipTrigger
    data-slot="tooltip-trigger"
    v-bind="definedProps(props)"
    @focus.capture="ignorePointerFocus"
  >
    <slot />
  </TooltipTrigger>
</template>
