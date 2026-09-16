<script setup lang="ts">
import { formatTimer } from "../../../../presentation.js";
import type { LabTimerView } from "../clock.js";
import { arcColor, type CandidateProps } from "../candidate.js";

const props = defineProps<CandidateProps>();

/** Compact overrides the stacked diameter; an inline value would win over CSS. */
const COMPACT_SIZE = 34;

/**
 * The rail is a tall narrow strip, so the timer takes that shape instead of
 * fighting it: a column that drains from the top and costs almost no width.
 */
function vars(view: LabTimerView): Record<string, string> {
  const elapsed = props.kind === "mystery" ? 0.45 : Math.min(1, Math.max(0, view.elapsed));
  return {
    "--tl-size": `${props.layout === "compact" ? COMPACT_SIZE : props.size}px`,
    "--tl-arc": arcColor(view, props.urgency),
    "--left": `${(1 - elapsed) * 100}%`,
  };
}
</script>

<template>
  <div v-if="kind !== 'hidden'" class="column-list" :data-layout="layout">
    <TransitionGroup name="tl">
      <div
        v-for="view in timers"
        :key="view.key"
        class="tl-timer column"
        role="timer"
        :aria-label="view.label ?? 'Timer'"
        :data-mystery="kind === 'mystery' || undefined"
        :style="vars(view)"
      >
        <span class="column-text">
          <span class="tl-time column-time">{{
            kind === "mystery" ? "?" : formatTimer(view.remainingSeconds)
          }}</span>
          <span v-if="view.label" class="tl-label column-label">{{ view.label }}</span>
        </span>
        <span class="column-shaft" aria-hidden="true"><span class="column-fill"></span></span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.column-list {
  display: flex;
  gap: 22px;
}

.column-list[data-layout="stack"] {
  flex-direction: row;
  align-items: stretch;
  justify-content: center;
}

.column-list[data-layout="compact"] {
  flex-direction: row;
  align-items: center;
  overflow-x: auto;
  scrollbar-width: none;
}

.column {
  display: flex;
  align-items: flex-start;
  gap: calc(var(--tl-size) * 0.12);
}

.column-text {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  padding-block-start: 1px;
}

.column-time {
  font-size: calc(var(--tl-size) * 0.23);
}

.column-label {
  max-inline-size: 12ch;
  text-align: end;
  font-size: calc(var(--tl-size) * 0.1);
}

.column-shaft {
  position: relative;
  inline-size: calc(var(--tl-size) * 0.055);
  block-size: calc(var(--tl-size) * 1.25);
  border-radius: 999px;
  background: color-mix(in oklab, currentColor var(--tl-mark), transparent);
  overflow: hidden;
}

/* Draining from the top leaves what remains resting at the bottom. */
.column-fill {
  position: absolute;
  inset-inline: 0;
  inset-block-end: 0;
  block-size: var(--left);
  border-radius: 999px;
  background: var(--tl-arc);
}

.column[data-mystery] .column-fill {
  block-size: 32%;
  animation: column-drift 7.5s ease-in-out infinite alternate;
}

@keyframes column-drift {
  from { translate: 0 0; }
  to { translate: 0 -212%; }
}

.column-list[data-layout="compact"] .column {
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 12px;
  border-radius: 999px;
  background: var(--tl-surface);
  backdrop-filter: blur(12px);
}

.column-list[data-layout="compact"] .column-time {
  font-size: 14px;
}

.column-list[data-layout="compact"] .column-label {
  font-size: 8.5px;
  white-space: nowrap;
}

.column-list[data-layout="compact"] .column-shaft {
  block-size: 26px;
  inline-size: 3px;
}

@media (prefers-reduced-motion: reduce) {
  .column[data-mystery] .column-fill {
    animation-duration: 20s;
  }
}
</style>
