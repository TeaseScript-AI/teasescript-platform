<script setup lang="ts">
import { computed } from "vue";
import type { LabTimerView } from "../clock.js";
import { urgency as urgencyRatio, type TimerKind } from "../candidate.js";

const props = defineProps<{ view: LabTimerView; kind: TimerKind; urgency: boolean }>();

/**
 * Light instead of geometry. The ember cools and shrinks over the run and
 * gathers heat at the end, so the timer belongs to the scene's lighting rather
 * than sitting on top of it as chrome.
 */
const heat = computed(() => {
  if (props.kind === "mystery") return 0.45;
  const elapsed = Math.min(1, Math.max(0, props.view.elapsed));
  return Math.max(1 - elapsed, urgencyRatio(props.view, props.urgency));
});
</script>

<template>
  <div
    class="ember"
    aria-hidden="true"
    :data-mystery="kind === 'mystery' || undefined"
    :style="{ '--heat': heat }"
  >
    <div class="ember-core"></div>
  </div>
</template>

<style scoped>
.ember {
  position: absolute;
  inset: 14%;
  display: grid;
  place-items: center;
}

.ember-core {
  inline-size: 100%;
  block-size: 100%;
  border-radius: 50%;
  background: radial-gradient(
    closest-side,
    oklch(from var(--tl-accent) calc(l + 0.3) calc(c * 0.3) h / calc(0.5 + var(--heat) * 0.5)) 0%,
    oklch(from var(--tl-accent) calc(l + 0.06) calc(c * (0.5 + var(--heat) * 0.5)) h / calc(0.45 + var(--heat) * 0.45))
      26%,
    oklch(from var(--tl-accent) calc(l - 0.06) c h / calc(0.12 + var(--heat) * 0.3)) 58%,
    transparent 100%
  );
  scale: calc(0.62 + var(--heat) * 0.38);
  transition: scale 900ms linear;
}

.ember[data-mystery] .ember-core {
  animation: ember-flicker 8s ease-in-out infinite alternate;
}

@keyframes ember-flicker {
  from { opacity: 0.68; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .ember[data-mystery] .ember-core {
    animation: none;
  }
}
</style>
