<script setup lang="ts">
import { computed } from "vue";
import type { LabTimerView } from "../clock.js";
import { arcColor, type TimerKind } from "../candidate.js";

const props = defineProps<{ view: LabTimerView; kind: TimerKind; urgency: boolean }>();

const sweep = computed(() =>
  props.kind === "mystery" ? 0 : Math.min(1, Math.max(0, props.view.elapsed)) * 360,
);
</script>

<template>
  <div
    class="orbit"
    aria-hidden="true"
    :data-mystery="kind === 'mystery' || undefined"
    :style="{ '--tl-arc': arcColor(view, urgency), '--sweep': `${sweep}deg` }"
  >
    <!-- No track and no arc: one travelling point is the whole timer. -->
    <div class="orbit-rotor"><span class="orbit-dot"></span></div>
  </div>
</template>

<style scoped>
.orbit {
  position: absolute;
  inset: 0;
}

.orbit-rotor {
  position: absolute;
  inset: 0;
  rotate: var(--sweep);
}

.orbit-dot {
  position: absolute;
  inset-block-start: 0;
  inset-inline-start: 50%;
  inline-size: calc(var(--tl-size) * 0.055);
  block-size: calc(var(--tl-size) * 0.055);
  translate: -50% -50%;
  border-radius: 50%;
  background: var(--tl-arc);
  box-shadow: 0 0 0 calc(var(--tl-size) * 0.028) color-mix(in oklab, var(--tl-arc) 20%, transparent);
}

.orbit[data-mystery] .orbit-rotor {
  animation: orbit-drift 11s linear infinite;
}

@keyframes orbit-drift {
  from { rotate: 0deg; }
  to { rotate: 360deg; }
}

@media (prefers-reduced-motion: reduce) {
  .orbit[data-mystery] .orbit-rotor {
    animation-duration: 30s;
  }
}
</style>
