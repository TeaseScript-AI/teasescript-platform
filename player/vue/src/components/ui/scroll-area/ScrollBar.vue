<script setup lang="ts">
import { ScrollAreaScrollbar, ScrollAreaThumb } from "reka-ui";
import { ref } from "vue";

const trackHovered = ref(false);

withDefaults(defineProps<{ orientation?: "vertical" | "horizontal"; revealOnHover?: boolean }>(), {
  orientation: "vertical",
});
</script>

<template>
  <ScrollAreaScrollbar :orientation="orientation" data-slot="scroll-area-scrollbar"
    class="scroll-bar" :force-mount="revealOnHover"
    :data-track-hovered="trackHovered ? '' : undefined"
    @pointerenter="trackHovered = $event.pointerType === 'mouse'"
    @pointerleave="trackHovered = false"
    :data-reveal-on-hover="revealOnHover ? '' : undefined"
    :style="orientation === 'vertical' ? { bottom: 'var(--scroll-area-bottom-inset, var(--reka-scroll-area-corner-height))' } : undefined">
    <ScrollAreaThumb data-slot="scroll-area-thumb" class="scroll-thumb" />
  </ScrollAreaScrollbar>
</template>

<style scoped>
.scroll-bar { display: flex; touch-action: none; user-select: none; padding: 2px; }
.scroll-bar[data-orientation="vertical"] { width: 9px; }
.scroll-bar[data-orientation="horizontal"] { height: 9px; flex-direction: column; }
.scroll-thumb {
  position: relative; flex: 1; border-radius: 999px;
  background: var(--border-strong);
}
.scroll-bar:hover .scroll-thumb { background: var(--text-muted); }
/* Keep only the narrow track hit-testable while scroll visibility is idle.
   Reka retains ownership of thumb measurement, dragging and pointer capture. */
.scroll-bar[data-reveal-on-hover][data-state="hidden"] { opacity: 0; }
.scroll-bar[data-reveal-on-hover][data-state="hidden"][data-track-hovered] { opacity: 1; }
.scroll-bar[data-reveal-on-hover][data-state="hidden"]:active { opacity: 1; }
</style>
