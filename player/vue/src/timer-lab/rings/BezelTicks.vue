<script setup lang="ts">
import { computed } from "vue";
import type { LabTimerView } from "../clock.js";
import { arcColor, type TimerKind } from "../candidate.js";

const props = defineProps<{ view: LabTimerView; kind: TimerKind; urgency: boolean }>();

const elapsed = computed(() =>
  props.kind === "mystery" ? 0.18 : Math.min(1, Math.max(0, props.view.elapsed)),
);
</script>

<template>
  <div
    class="bezel"
    aria-hidden="true"
    :data-mystery="kind === 'mystery' || undefined"
    :style="{ '--tl-arc': arcColor(view, urgency), '--sweep': `${elapsed * 360}deg` }"
  >
    <div class="bezel-ticks bezel-ticks-dim"></div>
    <div class="bezel-rotor"><div class="bezel-ticks bezel-ticks-lit"></div></div>
  </div>
</template>

<style scoped>
.bezel {
  position: absolute;
  inset: 0;
}

/*
 * One repeating conic gradient draws all 48 marks; the lit layer reuses it and
 * is clipped by the elapsed sweep, so nothing is rebuilt per tick.
 */
.bezel-ticks {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: repeating-conic-gradient(
    from -90deg,
    currentColor 0deg 1.1deg,
    transparent 1.1deg 7.5deg
  );
  mask: radial-gradient(farthest-side, transparent calc(100% - 7px), #000 calc(100% - 6.2px));
}

.bezel-ticks-dim {
  opacity: 0.22;
}

.bezel-rotor {
  position: absolute;
  inset: 0;
  /* Clip the lit marks to the elapsed wedge. */
  mask-image: conic-gradient(from -90deg, #000 0 var(--sweep), transparent var(--sweep));
}

.bezel-ticks-lit {
  color: var(--tl-arc);
  background: repeating-conic-gradient(
    from -90deg,
    var(--tl-arc) 0deg 1.1deg,
    transparent 1.1deg 7.5deg
  );
}

.bezel[data-mystery] .bezel-rotor {
  animation: bezel-drift 13s linear infinite;
}

@keyframes bezel-drift {
  from { rotate: 0deg; }
  to { rotate: 360deg; }
}

@media (prefers-reduced-motion: reduce) {
  .bezel[data-mystery] .bezel-rotor {
    animation-duration: 34s;
  }
}
</style>
