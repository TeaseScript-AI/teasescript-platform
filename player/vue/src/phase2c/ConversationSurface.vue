<script setup lang="ts">
import { ref } from "vue";
import { useResizeObserver } from "@vueuse/core";

const overlay = ref<HTMLElement | null>(null);
const bottomInset = ref(0);
const glass = ref<HTMLElement | null>(null);
const composerEdges = ref({ top: 0, bottom: 0 });
// Measure the complete overlay, including its safe-area spacing and foreground controls.
useResizeObserver(overlay, () => {
  const bounds = overlay.value?.getBoundingClientRect();
  const surface = glass.value?.getBoundingClientRect();
  bottomInset.value = bounds?.height ?? 0;
  if (bounds && surface) composerEdges.value = {
    top: bounds.bottom - surface.top,
    bottom: bounds.bottom - surface.bottom,
  };
});
</script>

<template>
  <section class="player-conversation conversation-surface"
    :style="{ '--composer-top-from-bottom': `${composerEdges.top}px`, '--composer-bottom-from-bottom': `${composerEdges.bottom}px` }">
    <slot :bottom-inset="bottomInset" />
    <div ref="overlay" class="conversation-overlay" data-conversation-overlay>
      <div ref="glass" class="conversation-glass"><slot name="interaction" /></div>
    </div>
  </section>
</template>

<style scoped>
.conversation-surface { position: relative; display: flex; min-height: 0; padding-inline: 1rem; }
.conversation-overlay {
  position: absolute; inset: auto 1rem 0; z-index: 2; pointer-events: none;
  padding-top: 0.5rem; padding-bottom: max(1rem, env(safe-area-inset-bottom, 0px));
}
.conversation-glass {
  pointer-events: auto; border-radius: 1.5rem; padding: 0.5rem;
  background: var(--surface-component);
}
@supports (backdrop-filter: blur(1px)) {
  .conversation-glass {
    background: color-mix(in srgb, var(--surface-component) 96%, transparent);
    backdrop-filter: blur(4px);
  }
}
</style>
