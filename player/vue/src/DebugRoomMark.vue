<script setup lang="ts">
import { Bug } from "@lucide/vue";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";

// The debug room's mark before the title in the title pill (DEBUGGER.md "Debug room"), named by the bar's tooltip. It
// takes the pointer for its own tooltip, so hovering it does not also open the cut-off title's.
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <span class="debug-room-mark" role="img" aria-label="Debug session" data-debug-room-indicator @pointermove.stop>
        <Bug class="size-4" aria-hidden="true" />
      </span>
    </TooltipTrigger>
    <TooltipContent>Debug session</TooltipContent>
  </Tooltip>
</template>

<style scoped>
.debug-room-mark {
  display: inline-flex;
  flex-shrink: 0;
  margin-inline-end: 6px;
  pointer-events: auto;
}
</style>
