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
.conversation-surface { position: relative; display: flex; min-height: 0; padding-inline: var(--conversation-inline-inset); }
.conversation-overlay {
  position: absolute; inset: auto var(--conversation-inline-inset) 0; z-index: 2; pointer-events: none;
  max-inline-size: calc(var(--conversation-content-max-width) - 64px); margin-inline: auto;
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

<!-- Selectors are rooted at this component; slotted controls keep the same material. -->
<style>
/* ConversationSurface owns one Composer material. The small enabled Send action
   uses the primary family; the textarea and disabled controls stay transparent. */
:root[data-phase2c-theme] [data-runtime-composer] > :is(textarea, button) {
  color: var(--theme-text-primary);
  background: transparent;
  border-color: transparent;
}
:root[data-phase2c-theme] [data-runtime-composer] > button:enabled {
  background: var(--theme-accent-solid);
  color: var(--theme-text-on-accent);
}
:root[data-phase2c-theme] [data-runtime-composer] > :disabled {
  color: var(--theme-text-disabled);
  background: transparent;
  border-color: transparent;
}
@media (any-hover: hover) {
  :root[data-phase2c-theme] [data-runtime-composer] > button:enabled:hover {
    background: var(--theme-accent-hover);
  }
}
:root[data-phase2c-theme] [data-runtime-composer] > button:enabled:active {
  background: var(--theme-accent-pressed);
  transition-duration: 0s;
}
</style>
