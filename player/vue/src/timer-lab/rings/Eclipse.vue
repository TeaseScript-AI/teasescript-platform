<script setup lang="ts">
import { computed } from "vue";
import type { LabTimerView } from "../clock.js";
import { arcColor, type TimerKind } from "../candidate.js";

const props = defineProps<{ view: LabTimerView; kind: TimerKind; urgency: boolean }>();

/** A shadow disc of equal size slides across, exactly like a lunar phase. */
const phase = computed(() =>
  props.kind === "mystery" ? 0.5 : Math.min(1, Math.max(0, props.view.elapsed)),
);
</script>

<template>
  <div
    class="eclipse"
    aria-hidden="true"
    :data-mystery="kind === 'mystery' || undefined"
    :style="{ '--tl-arc': arcColor(view, urgency), '--phase': phase }"
  >
    <div class="eclipse-light"></div>
  </div>
</template>

<style scoped>
/* A custom property has to be registered before keyframes can interpolate it. */
@property --phase {
  syntax: "<number>";
  inherits: false;
  initial-value: 0;
}

.eclipse {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: color-mix(in oklab, currentColor var(--tl-mark), transparent);
}

.eclipse-light {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  /* Kept below full strength so the numerals stay readable across it. */
  background: color-mix(in oklab, var(--tl-arc) var(--tl-fill), transparent);
  /* Full disc minus the travelling shadow disc leaves the lit crescent. */
  mask-image:
    radial-gradient(circle at 50% 50%, #000 0 calc(var(--tl-size) / 2), transparent 0),
    radial-gradient(
      circle at calc(var(--phase) * 100% - 50%) 50%,
      #000 0 calc(var(--tl-size) / 2),
      transparent 0
    );
  mask-composite: subtract;
}

.eclipse[data-mystery] .eclipse-light {
  animation: eclipse-drift 14s ease-in-out infinite alternate;
}

@keyframes eclipse-drift {
  from { --phase: 0.3; }
  to { --phase: 0.72; }
}

@media (prefers-reduced-motion: reduce) {
  .eclipse[data-mystery] .eclipse-light {
    animation-duration: 34s;
  }
}
</style>
