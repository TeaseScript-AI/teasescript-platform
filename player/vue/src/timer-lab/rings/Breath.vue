<script setup lang="ts">
import { computed } from "vue";
import type { LabTimerView } from "../clock.js";
import { arcColor, type TimerKind } from "../candidate.js";

const props = defineProps<{ view: LabTimerView; kind: TimerKind; urgency: boolean }>();

/**
 * No arc and no track. A soft field of light contracts toward the numerals as
 * the time runs out, while breathing at its own fixed, slow cadence. In a
 * product about being held in a moment, the timer can set the pace instead of
 * counting down at you.
 */
const remaining = computed(() =>
  props.kind === "mystery" ? 0.6 : 1 - Math.min(1, Math.max(0, props.view.elapsed)),
);
</script>

<template>
  <div
    class="breath"
    aria-hidden="true"
    :data-mystery="kind === 'mystery' || undefined"
    :style="{ '--tl-arc': arcColor(view, urgency), '--remaining': remaining }"
  >
    <div class="breath-extent">
      <div class="breath-glow"></div>
    </div>
  </div>
</template>

<style scoped>
.breath {
  position: absolute;
  inset: -40%;
  display: grid;
  place-items: center;
}

/* Remaining time owns the size; the breathing rhythm is layered on top. */
.breath-extent {
  inline-size: 100%;
  block-size: 100%;
  display: grid;
  place-items: center;
  scale: calc(0.34 + var(--remaining) * 0.66);
}

.breath-glow {
  inline-size: 100%;
  block-size: 100%;
  border-radius: 50%;
  background: radial-gradient(
    closest-side,
    color-mix(in oklab, var(--tl-arc) calc(var(--tl-fill) * 0.85), transparent) 0%,
    color-mix(in oklab, var(--tl-arc) calc(var(--tl-fill) * 0.5), transparent) 44%,
    color-mix(in oklab, var(--tl-arc) calc(var(--tl-fill) * 0.16), transparent) 74%,
    transparent 100%
  );
  /* Roughly four seconds in, six out: slower than resting breath, on purpose. */
  animation: breath-cycle 10s cubic-bezier(0.4, 0, 0.5, 1) infinite;
}

@keyframes breath-cycle {
  0% { scale: 0.9; opacity: 0.72; }
  40% { scale: 1.06; opacity: 1; }
  100% { scale: 0.9; opacity: 0.72; }
}

.breath[data-mystery] .breath-glow {
  animation-duration: 14s;
}

@media (prefers-reduced-motion: reduce) {
  .breath-glow {
    animation: none;
  }
}
</style>
