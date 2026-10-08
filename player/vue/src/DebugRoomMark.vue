<script setup lang="ts">
import { computed } from "vue";
import { Bug } from "@lucide/vue";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";

// The debug room's mark before the title in the title pill (DEBUGGER.md "Debug room"), named by the bar's tooltip: an
// outlined bug, filled with the theme's error red while Debug is on, which stays red whatever the accent. It takes the
// pointer for its own tooltip, so hovering it does not also open the cut-off title's.
const props = defineProps<{ on?: boolean }>();
const label = computed(() => (props.on ? "Debug session · Debug on" : "Debug session · Debug off"));
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <span
        class="debug-room-mark"
        role="img"
        :aria-label="label"
        data-debug-room-indicator
        :data-debug-on="on || undefined"
        @pointermove.stop
      >
        <Bug class="size-4" aria-hidden="true" />
      </span>
    </TooltipTrigger>
    <TooltipContent>{{ label }}</TooltipContent>
  </Tooltip>
</template>

<style scoped>
.debug-room-mark {
  display: inline-flex;
  flex-shrink: 0;
  margin-inline-end: 6px;
  pointer-events: auto;
}
.debug-room-mark[data-debug-on] svg {
  color: var(--theme-status-error, CanvasText);
  fill: currentColor;
}
</style>
