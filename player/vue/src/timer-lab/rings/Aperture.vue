<script setup lang="ts">
import { computed } from "vue";
import type { LabTimerView } from "../clock.js";
import { arcColor, type TimerKind } from "../candidate.js";

const props = defineProps<{ view: LabTimerView; kind: TimerKind; urgency: boolean }>();

/** A fixed comet length reads as "running" without exposing duration. */
const MYSTERY_SWEEP_DEGREES = 78;

const sweep = computed(() =>
  props.kind === "mystery"
    ? MYSTERY_SWEEP_DEGREES
    : Math.min(1, Math.max(0, props.view.elapsed)) * 360,
);
</script>

<template>
  <div
    class="aperture"
    aria-hidden="true"
    :data-mystery="kind === 'mystery' || undefined"
    :style="{ '--tl-arc': arcColor(view, urgency), '--sweep': `${sweep}deg` }"
  >
    <div class="ap-track"></div>
    <div class="ap-rotor">
      <div class="ap-sweep"></div>
      <div class="ap-tip-wrap"><span class="ap-tip"></span></div>
    </div>
  </div>
</template>

<style scoped>
.aperture {
  position: absolute;
  inset: 0;
}

.ap-track,
.ap-sweep {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  /* One shared band geometry keeps the track and the sweep perfectly aligned. */
  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.3px));
}

.ap-track {
  background: var(--tl-track);
}

.ap-rotor {
  position: absolute;
  inset: 0;
}

.ap-sweep {
  background: conic-gradient(
    from -90deg,
    transparent 0deg,
    color-mix(in oklab, var(--tl-arc) 30%, transparent) calc(var(--sweep) * 0.55),
    var(--tl-arc) var(--sweep),
    transparent var(--sweep)
  );
}

/* Rotating the full-size wrapper keeps the tip exactly on the band centre. */
.ap-tip-wrap {
  position: absolute;
  inset: 0;
  rotate: var(--sweep);
}

.ap-tip {
  position: absolute;
  inset-block-start: 1.65px;
  inset-inline-start: 50%;
  inline-size: 4.4px;
  block-size: 4.4px;
  margin: -2.2px 0 0 -2.2px;
  border-radius: 50%;
  background: var(--tl-arc);
  transition: background 800ms linear;
}

.aperture[data-mystery] .ap-rotor {
  animation: ap-drift 11s linear infinite;
}

@keyframes ap-drift {
  from { rotate: 0deg; }
  to { rotate: 360deg; }
}

@media (prefers-reduced-motion: reduce) {
  .aperture[data-mystery] .ap-rotor {
    animation-duration: 30s;
  }
}
</style>
