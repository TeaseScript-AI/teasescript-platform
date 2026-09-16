<script setup lang="ts">
import { computed } from "vue";
import type { LabTimerView } from "../clock.js";
import { arcColor, type TimerKind } from "../candidate.js";

const props = defineProps<{ view: LabTimerView; kind: TimerKind; urgency: boolean }>();

/** The level is what is left, so the vessel visibly empties. */
const level = computed(() =>
  props.kind === "mystery" ? 0.55 : 1 - Math.min(1, Math.max(0, props.view.elapsed)),
);
</script>

<template>
  <div
    class="liquid"
    aria-hidden="true"
    :data-mystery="kind === 'mystery' || undefined"
    :style="{ '--tl-arc': arcColor(view, urgency), '--level': `${level * 100}%` }"
  >
    <div class="liquid-body"></div>
    <div class="liquid-surface"></div>
  </div>
</template>

<style scoped>
.liquid {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  overflow: hidden;
  border: 1px solid color-mix(in oklab, currentColor var(--tl-mark), transparent);
}

.liquid-body {
  position: absolute;
  inset-inline: 0;
  inset-block-end: 0;
  block-size: var(--level);
  background: color-mix(in oklab, var(--tl-arc) var(--tl-fill), transparent);
}

/* A single brighter line reads as the meniscus and makes the level precise. */
.liquid-surface {
  position: absolute;
  inset-inline: 0;
  inset-block-end: var(--level);
  block-size: 1.5px;
  background: var(--tl-arc);
  opacity: 0.85;
}

.liquid[data-mystery] .liquid-body,
.liquid[data-mystery] .liquid-surface {
  animation: liquid-drift 9s ease-in-out infinite alternate;
}

@keyframes liquid-drift {
  from { translate: 0 3%; }
  to { translate: 0 -3%; }
}

@media (prefers-reduced-motion: reduce) {
  .liquid[data-mystery] .liquid-body,
  .liquid[data-mystery] .liquid-surface {
    animation-duration: 26s;
  }
}
</style>
