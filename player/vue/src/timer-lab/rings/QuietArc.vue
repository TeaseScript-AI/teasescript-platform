<script setup lang="ts">
import type { LabTimerView } from "../clock.js";
import { arcColor, RING_CIRCUMFERENCE, RING_RADIUS, type TimerKind } from "../candidate.js";

const props = defineProps<{ view: LabTimerView; kind: TimerKind; urgency: boolean }>();

function dashOffset(): number {
  const elapsed = props.kind === "mystery" ? 0.2 : Math.min(1, Math.max(0, props.view.elapsed));
  return RING_CIRCUMFERENCE * (1 - elapsed);
}
</script>

<template>
  <svg
    class="quiet"
    viewBox="0 0 100 100"
    aria-hidden="true"
    :data-mystery="kind === 'mystery' || undefined"
    :style="{ '--tl-arc': arcColor(view, urgency) }"
  >
    <circle class="quiet-track" cx="50" cy="50" :r="RING_RADIUS" />
    <circle
      class="quiet-arc"
      cx="50"
      cy="50"
      :r="RING_RADIUS"
      :stroke-dasharray="RING_CIRCUMFERENCE"
      :stroke-dashoffset="dashOffset()"
    />
  </svg>
</template>

<style scoped>
.quiet {
  position: absolute;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  rotate: -90deg;
  overflow: visible;
}

.quiet-track {
  fill: none;
  stroke: var(--tl-track);
  stroke-width: 2.4;
}

.quiet-arc {
  fill: none;
  stroke: var(--tl-arc);
  stroke-width: 2.4;
  stroke-linecap: round;
  transition: stroke 800ms linear;
}

/* One slow revolution: present, but too slow to pull the eye away. */
.quiet[data-mystery] {
  animation: quiet-drift 11s linear infinite;
}

.quiet[data-mystery] .quiet-arc {
  stroke: var(--tl-arc-quiet);
}

@keyframes quiet-drift {
  from { rotate: -90deg; }
  to { rotate: 270deg; }
}

@media (prefers-reduced-motion: reduce) {
  .quiet[data-mystery] {
    animation-duration: 30s;
  }
}
</style>
