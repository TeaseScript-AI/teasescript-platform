<script setup lang="ts">
import { TrianglesCenterlineDashedVertical } from "@lucide/vue";

// Switches the viewfinder between a mirror (selfie) view and the camera's own view. Photos are never mirrored.
const mirrored = defineModel<boolean>({ required: true });
</script>

<template>
  <button
    type="button"
    class="viewfinder-mirror"
    aria-label="Mirror camera preview"
    :aria-pressed="mirrored"
    title="Mirror the preview; photos are never mirrored"
    data-viewfinder-mirror
    @pointerdown.stop
    @click="mirrored = !mirrored"
  >
    <TrianglesCenterlineDashedVertical aria-hidden="true" class="size-3.5" />
  </button>
</template>

<style scoped>
.viewfinder-mirror {
  display: grid;
  place-items: center;
  width: 26px;
  height: 22px;
  border: 1px solid transparent;
  border-radius: 9999px;
  color: var(--media-text);
  opacity: 0.6;
}
.viewfinder-mirror:hover { opacity: 1; }
.viewfinder-mirror[aria-pressed="true"] {
  opacity: 1;
  border-color: var(--media-border);
  background: var(--media-surface);
}
.viewfinder-mirror:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
</style>
