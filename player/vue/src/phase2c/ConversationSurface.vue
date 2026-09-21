<script setup lang="ts">
import { ref } from "vue";
import { useResizeObserver } from "@vueuse/core";

const emit = defineEmits<{ "margin-wheel": [event: WheelEvent] }>();
function scrollMargin(event: WheelEvent) {
  // Only empty margins belong here; nested controls keep their native scrolling.
  if (event.target === event.currentTarget) emit("margin-wheel", event);
}
const overlay = ref<HTMLElement | null>(null);
const bottomInset = ref(0);
const container = ref<HTMLElement | null>(null);
const availableHeight = ref(0);
useResizeObserver(container, ([entry]) => { availableHeight.value = entry?.contentRect.height ?? 0; });
const composerEdges = ref({ top: 0, bottom: 0 });
// Measure the complete overlay, including its safe-area spacing.
useResizeObserver(overlay, () => {
  const bounds = overlay.value?.getBoundingClientRect();
  const surface = overlay.value?.querySelector("[data-composer-shell]")?.getBoundingClientRect();
  bottomInset.value = bounds?.height ?? 0;
  if (bounds && surface) composerEdges.value = {
    top: bounds.bottom - surface.top,
    bottom: bounds.bottom - surface.bottom,
  };
});
</script>

<template>
  <div class="conversation-region" @wheel="scrollMargin">
  <section ref="container" class="player-conversation conversation-surface"
    :style="{ '--composer-input-limit': `${Math.max(40, availableHeight * 0.45)}px`, '--composer-top-from-bottom': `${composerEdges.top}px`, '--composer-bottom-from-bottom': `${composerEdges.bottom}px` }">
    <slot :bottom-inset="bottomInset" />
    <div ref="overlay" class="conversation-overlay" data-conversation-overlay>
      <slot name="interaction" />
    </div>
  </section>
  </div>
</template>

<style scoped>
.conversation-region { flex: 1; display: flex; min-width: 0; min-height: 0; }
.conversation-surface { position: relative; display: flex; min-height: 0; padding-inline: var(--conversation-inline-inset); }
.conversation-overlay {
  position: absolute; inset: auto var(--conversation-inline-inset) 0; z-index: 2; pointer-events: none;
  max-inline-size: calc(var(--conversation-content-max-width) - 64px); margin-inline: auto;
  padding-top: 0.5rem; padding-bottom: max(1rem, env(safe-area-inset-bottom, 0px));
}
</style>
