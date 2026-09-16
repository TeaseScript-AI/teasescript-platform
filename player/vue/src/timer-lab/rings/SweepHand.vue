<script setup lang="ts">
import { computed } from "vue";
import type { LabTimerView } from "../clock.js";
import { arcColor, type TimerKind } from "../candidate.js";

const props = defineProps<{ view: LabTimerView; kind: TimerKind; urgency: boolean }>();

/** One hand, no dial. The oldest instrument for showing time passing. */
const sweep = computed(() =>
  props.kind === "mystery" ? 0 : Math.min(1, Math.max(0, props.view.elapsed)) * 360,
);
</script>

<template>
  <div
    class="sweep"
    aria-hidden="true"
    :data-mystery="kind === 'mystery' || undefined"
    :style="{ '--tl-arc': arcColor(view, urgency), '--sweep': `${sweep}deg` }"
  >
    <div class="sweep-rotor"><span class="sweep-hand"></span></div>
    <span class="sweep-pivot"></span>
  </div>
</template>

<style scoped>
.sweep {
  position: absolute;
  inset: 0;
}

.sweep-rotor {
  position: absolute;
  inset: 0;
  rotate: var(--sweep);
}

/*
 * The hand is a tapered sliver: wide where it leaves the rim, vanishing before
 * it reaches the numerals, so it never crosses the text.
 */
.sweep-hand {
  position: absolute;
  inset-block-start: 0;
  inset-inline-start: 50%;
  inline-size: calc(var(--tl-size) * 0.028);
  block-size: 34%;
  translate: -50% 0;
  border-radius: 2px;
  background: linear-gradient(
    to bottom,
    var(--tl-arc) 0%,
    var(--tl-arc) 34%,
    color-mix(in oklab, var(--tl-arc) 35%, transparent) 84%,
    transparent 100%
  );
}

.sweep-pivot {
  position: absolute;
  inset-block-start: 50%;
  inset-inline-start: 50%;
  inline-size: calc(var(--tl-size) * 0.04);
  block-size: calc(var(--tl-size) * 0.04);
  translate: -50% -50%;
  border-radius: 50%;
  background: color-mix(in oklab, var(--tl-arc) 70%, transparent);
}

.sweep[data-mystery] .sweep-rotor {
  animation: sweep-drift 11s linear infinite;
}

@keyframes sweep-drift {
  from { rotate: 0deg; }
  to { rotate: 360deg; }
}

@media (prefers-reduced-motion: reduce) {
  .sweep[data-mystery] .sweep-rotor {
    animation-duration: 30s;
  }
}
</style>
