<script setup lang="ts">
import { computed } from "vue";
import { Bug } from "@lucide/vue";
import Tooltip from "@/components/ui/tooltip/Tooltip.vue";
import TooltipContent from "@/components/ui/tooltip/TooltipContent.vue";
import TooltipTrigger from "@/components/ui/tooltip/TooltipTrigger.vue";

// The debug room's mark before the title in the title pill (DEBUGGER.md "Debug room"), named by the bar's tooltip: an
// outlined bug, whose body and head are filled with the theme's debug mark, one red in light and dark whatever the
// accent, while Debug is on; its lines keep the text colour. It takes the pointer for its own tooltip, so hovering it
// does not also open the cut-off title's.
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
        <!-- The fill lies under the outline, so the bug's lines, its middle line too, stay on top of it. -->
        <Bug v-if="on" class="debug-room-fill size-4" aria-hidden="true" data-debug-room-fill />
        <Bug class="debug-room-outline size-4" aria-hidden="true" />
      </span>
    </TooltipTrigger>
    <TooltipContent>{{ label }}</TooltipContent>
  </Tooltip>
</template>

<style scoped>
.debug-room-mark {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  margin-inline-end: 6px;
  pointer-events: auto;
}
/* Both are positioned, so the outline, which comes later, paints over the fill. */
.debug-room-outline {
  position: relative;
}
.debug-room-fill {
  position: absolute;
  inset: 0;
  stroke: none;
}
.debug-room-fill :deep(path) {
  fill: none;
}
/* Lucide's bug draws its body second and its head last. */
.debug-room-fill :deep(path:nth-child(2)),
.debug-room-fill :deep(path:nth-child(11)) {
  fill: var(--theme-debug-mark, CanvasText);
}
</style>
