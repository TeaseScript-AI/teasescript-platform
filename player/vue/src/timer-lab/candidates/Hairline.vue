<script setup lang="ts">
import { formatTimer } from "../../../../presentation.js";
import type { LabTimerView } from "../clock.js";
import { arcColor, type CandidateProps } from "../candidate.js";

const props = defineProps<CandidateProps>();

/** Compact overrides the stacked diameter; an inline value would win over CSS. */
const COMPACT_SIZE = 34;

function vars(view: LabTimerView): Record<string, string> {
  return {
    "--tl-size": `${props.layout === "compact" ? COMPACT_SIZE : props.size}px`,
    "--tl-arc": arcColor(view, props.urgency),
    "--fill": `${Math.min(1, Math.max(0, view.elapsed)) * 100}%`,
  };
}
</script>

<template>
  <div v-if="kind !== 'hidden'" class="hair-list" :data-layout="layout">
    <TransitionGroup name="tl">
      <div
        v-for="view in timers"
        :key="view.key"
        class="tl-timer hair"
        role="timer"
        :aria-label="view.label ?? 'Timer'"
        :data-mystery="kind === 'mystery' || undefined"
        :style="vars(view)"
      >
        <span v-if="view.label" class="tl-label hair-label">{{ view.label }}</span>
        <span class="tl-time hair-time">{{
          kind === "mystery" ? "?" : formatTimer(view.remainingSeconds)
        }}</span>
        <span class="hair-rule" aria-hidden="true"><span class="hair-fill"></span></span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.hair-list {
  display: flex;
  gap: 18px;
}

.hair-list[data-layout="stack"] {
  flex-direction: column;
  align-items: center;
}

.hair-list[data-layout="compact"] {
  flex-direction: row;
  align-items: center;
  overflow-x: auto;
  scrollbar-width: none;
}

.hair {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 6px 10px 8px;
  border-radius: 12px;
  /* No plate: the glyph shadow alone carries legibility over media. */
  text-shadow: var(--tl-glyph);
}

.hair-label {
  order: 0;
  font-size: calc(var(--tl-size) * 0.1);
}

.hair-time {
  order: 1;
  font-size: calc(var(--tl-size) * 0.24);
  font-weight: 550;
}

.hair-rule {
  order: 2;
  position: relative;
  inline-size: calc(var(--tl-size) * 0.78);
  block-size: 2px;
  margin-block-start: 4px;
  border-radius: 2px;
  background: var(--tl-track);
  overflow: hidden;
}

.hair-fill {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  inline-size: var(--fill);
  border-radius: 2px;
  background: var(--tl-arc);
  transition: background 800ms linear;
}

/* Mystery drifts a short segment instead of exposing any position. */
.hair[data-mystery] .hair-fill {
  inline-size: 34%;
  background: var(--tl-arc-quiet);
  animation: hair-drift 6.5s ease-in-out infinite alternate;
}

@keyframes hair-drift {
  from { translate: -10% 0; }
  to { translate: 210% 0; }
}

.hair-list[data-layout="compact"] .hair {
  flex-direction: row;
  align-items: baseline;
  gap: 7px;
  padding: 4px 12px;
  border-radius: 999px;
  background: var(--tl-surface);
  backdrop-filter: blur(12px);
}

.hair-list[data-layout="compact"] .hair-time {
  order: 0;
  font-size: 14px;
}

.hair-list[data-layout="compact"] .hair-label {
  order: 1;
  max-inline-size: 11ch;
  font-size: 8.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hair-list[data-layout="compact"] .hair-rule {
  order: 2;
  inline-size: 34px;
  align-self: center;
  margin-block-start: 0;
}

@media (prefers-reduced-motion: reduce) {
  .hair[data-mystery] .hair-fill {
    animation-duration: 16s;
  }
}
</style>
