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
    class="dial"
    viewBox="0 0 100 100"
    aria-hidden="true"
    :data-mystery="kind === 'mystery' || undefined"
    :style="{ '--tl-arc': arcColor(view, urgency) }"
  >
    <circle class="dial-groove" cx="50" cy="50" :r="RING_RADIUS" />
    <!-- Two hairlines fake the groove's lit and shaded edge. -->
    <circle class="dial-edge dial-edge-outer" cx="50" cy="50" :r="RING_RADIUS + 3" />
    <circle class="dial-edge dial-edge-inner" cx="50" cy="50" :r="RING_RADIUS - 3" />
    <circle
      class="dial-arc"
      cx="50"
      cy="50"
      :r="RING_RADIUS"
      :stroke-dasharray="RING_CIRCUMFERENCE"
      :stroke-dashoffset="dashOffset()"
    />
  </svg>
</template>

<style scoped>
.dial {
  position: absolute;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  rotate: -90deg;
  overflow: visible;
}

.dial-groove {
  fill: none;
  stroke: color-mix(in oklab, currentColor var(--tl-mark), transparent);
  stroke-width: 6;
}

.dial-edge {
  fill: none;
  stroke-width: 0.75;
}

.dial-edge-outer {
  stroke: color-mix(in oklab, currentColor 8%, transparent);
}

.dial-edge-inner {
  stroke: color-mix(in oklab, var(--tl-surface-base) 55%, transparent);
}

.dial-arc {
  fill: none;
  stroke: var(--tl-arc);
  stroke-width: 6;
  stroke-linecap: butt;
  transition: stroke 800ms linear;
}

.dial[data-mystery] {
  animation: dial-drift 11s linear infinite;
}

.dial[data-mystery] .dial-arc {
  stroke: var(--tl-arc-quiet);
  stroke-linecap: round;
}

@keyframes dial-drift {
  from { rotate: -90deg; }
  to { rotate: 270deg; }
}

@media (prefers-reduced-motion: reduce) {
  .dial[data-mystery] {
    animation-duration: 30s;
  }
}
</style>
