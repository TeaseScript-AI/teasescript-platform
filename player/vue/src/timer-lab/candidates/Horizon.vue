<script setup lang="ts">
import { formatTimer } from "../../../../presentation.js";
import type { LabTimerView } from "../clock.js";
import { arcColor, type CandidateProps } from "../candidate.js";

const props = defineProps<CandidateProps>();

/** Compact overrides the stacked diameter; an inline value would win over CSS. */
const COMPACT_SIZE = 34;

/**
 * Not an object in the rail but a line in the architecture: the remaining time
 * is the length of a hairline, and the numerals ride at its leading edge.
 */
function vars(view: LabTimerView): Record<string, string> {
  return {
    "--tl-size": `${props.layout === "compact" ? COMPACT_SIZE : props.size}px`,
    "--tl-arc": arcColor(view, props.urgency),
    "--left": `${(1 - Math.min(1, Math.max(0, view.elapsed))) * 100}%`,
  };
}
</script>

<template>
  <div v-if="kind !== 'hidden'" class="horizon-list" :data-layout="layout">
    <TransitionGroup name="tl">
      <div
        v-for="view in timers"
        :key="view.key"
        class="tl-timer horizon"
        role="timer"
        :aria-label="view.label ?? 'Timer'"
        :data-mystery="kind === 'mystery' || undefined"
        :style="vars(view)"
      >
        <span class="horizon-rail" aria-hidden="true">
          <span class="horizon-left"></span>
        </span>
        <span class="horizon-text">
          <span class="horizon-time">{{
            kind === "mystery" ? "?" : formatTimer(view.remainingSeconds)
          }}</span>
          <span v-if="view.label" class="horizon-label">{{ view.label }}</span>
        </span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.horizon-list {
  display: flex;
  flex-direction: column;
  gap: 26px;
  inline-size: 100%;
}

.horizon {
  inline-size: 100%;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-block: 4px;
}

.horizon-rail {
  position: relative;
  display: block;
  block-size: 1.5px;
  background: color-mix(in oklab, currentColor var(--tl-mark), transparent);
}

.horizon-left {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  inline-size: var(--left);
  background: var(--tl-arc);
}

/* The dot marks where the remaining line ends, so the eye lands on the edge. */
.horizon-left::after {
  content: "";
  position: absolute;
  inset-inline-end: 0;
  inset-block-start: 50%;
  inline-size: 4px;
  block-size: 4px;
  margin: -2px -2px 0 0;
  border-radius: 50%;
  background: var(--tl-arc);
}

.horizon-text {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.horizon-time {
  text-shadow: var(--tl-glyph);
  font-size: calc(var(--tl-size) * 0.2);
  font-weight: 550;
  line-height: 1;
}

.horizon-label {
  text-shadow: var(--tl-glyph);
  color: var(--tl-fg-muted);
  font-size: calc(var(--tl-size) * 0.11);
  font-weight: 500;
}

.horizon[data-mystery] .horizon-left {
  inline-size: 30%;
  background: var(--tl-arc-quiet);
  animation: horizon-drift 8s ease-in-out infinite alternate;
}

@keyframes horizon-drift {
  from { translate: 0 0; }
  to { translate: 233% 0; }
}

.horizon-list[data-layout="compact"] .horizon {
  flex-direction: row-reverse;
  align-items: center;
  gap: 10px;
}

.horizon-list[data-layout="compact"] .horizon-rail {
  flex: 1;
  min-inline-size: 60px;
}

.horizon-list[data-layout="compact"] .horizon-time {
  font-size: 14px;
}

.horizon-list[data-layout="compact"] .horizon-label {
  font-size: 9px;
}

@media (prefers-reduced-motion: reduce) {
  .horizon[data-mystery] .horizon-left {
    animation-duration: 22s;
  }
}
</style>
