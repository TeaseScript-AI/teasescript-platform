<script setup lang="ts">
import { ref } from "vue";
import { useResizeObserver } from "@vueuse/core";

const overlay = ref<HTMLElement | null>(null);
const bottomInset = ref(0);
// Measure the complete overlay, including its safe-area spacing and foreground controls.
useResizeObserver(overlay, () => {
  bottomInset.value = overlay.value?.getBoundingClientRect().height ?? 0;
});
</script>

<template>
  <section class="player-conversation conversation-surface">
    <slot :bottom-inset="bottomInset" />
    <div ref="overlay" class="conversation-overlay" data-conversation-overlay>
      <div class="conversation-glass"><slot name="interaction" /></div>
    </div>
  </section>
</template>

<style scoped>
.conversation-surface { position: relative; display: flex; min-height: 0; padding-inline: 1rem; }
.conversation-overlay {
  position: absolute; inset: auto 1rem 0; z-index: 2; pointer-events: none;
  padding-top: 0.5rem; padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0px));
}
.conversation-glass {
  pointer-events: auto; border-radius: 0.75rem; padding: 0.5rem;
  background: var(--surface-component);
}
@supports (backdrop-filter: blur(1px)) {
  .conversation-glass {
    background: color-mix(in srgb, var(--surface-component) 45%, transparent);
    backdrop-filter: blur(4px);
  }
}
</style>
