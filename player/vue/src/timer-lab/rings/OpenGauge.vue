<script setup lang="ts">
import { computed } from "vue";
import type { LabTimerView } from "../clock.js";
import { arcColor, RING_CIRCUMFERENCE, RING_RADIUS, type TimerKind } from "../candidate.js";

const props = defineProps<{ view: LabTimerView; kind: TimerKind; urgency: boolean }>();

/** The open gauge draws 270 degrees and leaves the bottom quarter free. */
const SPAN = RING_CIRCUMFERENCE * 0.75;

const elapsed = computed(() =>
  props.kind === "mystery" ? 0.2 : Math.min(1, Math.max(0, props.view.elapsed)),
);
</script>

<template>
  <svg
    class="gauge"
    viewBox="0 0 100 100"
    aria-hidden="true"
    :data-mystery="kind === 'mystery' || undefined"
    :style="{ '--tl-arc': arcColor(view, urgency) }"
  >
    <circle
      class="gauge-track"
      cx="50"
      cy="50"
      :r="RING_RADIUS"
      :stroke-dasharray="`${SPAN} ${RING_CIRCUMFERENCE}`"
    />
    <circle
      class="gauge-arc"
      cx="50"
      cy="50"
      :r="RING_RADIUS"
      :stroke-dasharray="`${SPAN * elapsed} ${RING_CIRCUMFERENCE}`"
    />
  </svg>
</template>

<style scoped>
.gauge {
  position: absolute;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  /* Start the drawn span at the lower left so the gap sits under the label. */
  rotate: 135deg;
  overflow: visible;
}

.gauge-track {
  fill: none;
  stroke: var(--tl-track);
  stroke-width: 2.4;
  stroke-linecap: round;
}

.gauge-arc {
  fill: none;
  stroke: var(--tl-arc);
  stroke-width: 2.4;
  stroke-linecap: round;
  transition: stroke 800ms linear;
}

.gauge[data-mystery] {
  animation: gauge-drift 11s linear infinite;
}

.gauge[data-mystery] .gauge-arc {
  stroke: var(--tl-arc-quiet);
}

@keyframes gauge-drift {
  from { rotate: 135deg; }
  to { rotate: 495deg; }
}

@media (prefers-reduced-motion: reduce) {
  .gauge[data-mystery] {
    animation-duration: 30s;
  }
}
</style>
