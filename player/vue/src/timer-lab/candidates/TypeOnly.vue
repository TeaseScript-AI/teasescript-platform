<script setup lang="ts">
import { formatTimer } from "../../../../presentation.js";
import type { LabTimerView } from "../clock.js";
import { arcColor, urgency as urgencyRatio, type CandidateProps } from "../candidate.js";

const props = defineProps<CandidateProps>();

/** Compact overrides the stacked diameter; an inline value would win over CSS. */
const COMPACT_SIZE = 34;

/**
 * The type itself is the timer. It sits at low presence for most of the run and
 * gains weight and opacity as the end approaches, so attention is spent only
 * when there is something to pay attention to.
 */
function vars(view: LabTimerView): Record<string, string> {
  const close = urgencyRatio(view, props.urgency);
  return {
    "--tl-size": `${props.layout === "compact" ? COMPACT_SIZE : props.size}px`,
    "--tl-arc": arcColor(view, props.urgency),
    "--presence": `${0.62 + close * 0.38}`,
    "--weight": `${240 + close * 260}`,
  };
}
</script>

<template>
  <div v-if="kind !== 'hidden'" class="type-list" :data-layout="layout">
    <TransitionGroup name="tl">
      <div
        v-for="view in timers"
        :key="view.key"
        class="tl-timer type"
        role="timer"
        :aria-label="view.label ?? 'Timer'"
        :data-mystery="kind === 'mystery' || undefined"
        :style="vars(view)"
      >
        <span v-if="view.label" class="type-label">{{ view.label }}</span>
        <span class="type-time">{{
          kind === "mystery" ? "?" : formatTimer(view.remainingSeconds)
        }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.type-list {
  display: flex;
  gap: 22px;
}

.type-list[data-layout="stack"] {
  flex-direction: column;
  align-items: center;
}

.type-list[data-layout="compact"] {
  flex-direction: row;
  align-items: baseline;
  overflow-x: auto;
  scrollbar-width: none;
}

.type {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
}

.type-label {
  color: var(--tl-fg-muted);
  font-size: calc(var(--tl-size) * 0.11);
  font-weight: 500;
  letter-spacing: 0.04em;
  opacity: calc(var(--presence) * 0.9);
}

.type-time {
  color: var(--tl-arc);
  text-shadow: var(--tl-glyph);
  font-size: calc(var(--tl-size) * 0.46);
  font-variation-settings: "wght" var(--weight);
  font-weight: 300;
  line-height: 0.95;
  letter-spacing: -0.03em;
  opacity: var(--presence);
  transition: opacity 900ms linear;
}

.type[data-mystery] .type-time {
  animation: type-breathe 7s ease-in-out infinite alternate;
}

@keyframes type-breathe {
  from { opacity: 0.4; }
  to { opacity: 0.85; }
}

.type-list[data-layout="compact"] .type {
  flex-direction: row;
  align-items: baseline;
  gap: 8px;
}

.type-list[data-layout="compact"] .type-time {
  order: 0;
  font-size: 18px;
}

.type-list[data-layout="compact"] .type-label {
  order: 1;
  font-size: 10px;
}

@media (prefers-reduced-motion: reduce) {
  .type[data-mystery] .type-time {
    animation: none;
    opacity: 0.62;
  }
}
</style>
