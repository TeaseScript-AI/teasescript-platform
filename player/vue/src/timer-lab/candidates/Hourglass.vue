<script setup lang="ts">
import { formatTimer } from "../../../../presentation.js";
import type { LabTimerView } from "../clock.js";
import { arcColor, type CandidateProps } from "../candidate.js";

const props = defineProps<CandidateProps>();

/** Compact overrides the stacked diameter; an inline value would win over CSS. */
const COMPACT_SIZE = 34;

/**
 * The one silhouette that has always meant "you are being kept waiting". Mass
 * leaves the upper chamber and gathers in the lower one; nothing rotates and
 * nothing counts around a circle.
 */
function vars(view: LabTimerView): Record<string, string> {
  const elapsed = props.kind === "mystery" ? 0.5 : Math.min(1, Math.max(0, view.elapsed));
  return {
    "--tl-size": `${props.layout === "compact" ? COMPACT_SIZE : props.size}px`,
    "--tl-arc": arcColor(view, props.urgency),
    "--top": `${(1 - elapsed) * 100}%`,
    "--bottom": `${elapsed * 100}%`,
  };
}
</script>

<template>
  <div v-if="kind !== 'hidden'" class="glass-list" :data-layout="layout">
    <TransitionGroup name="tl">
      <div
        v-for="view in timers"
        :key="view.key"
        class="tl-timer glass"
        role="timer"
        :aria-label="view.label ?? 'Timer'"
        :data-mystery="kind === 'mystery' || undefined"
        :style="vars(view)"
      >
        <span class="glass-body" aria-hidden="true">
          <span class="glass-chamber glass-chamber-top"><span class="glass-sand"></span></span>
          <span class="glass-waist"></span>
          <span class="glass-chamber glass-chamber-bottom"><span class="glass-sand"></span></span>
        </span>
        <span class="glass-text">
          <span class="tl-time glass-time">{{
            kind === "mystery" ? "?" : formatTimer(view.remainingSeconds)
          }}</span>
          <span v-if="view.label" class="tl-label glass-label">{{ view.label }}</span>
        </span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.glass-list {
  display: flex;
  gap: 20px;
}

.glass-list[data-layout="stack"] {
  flex-direction: column;
  align-items: center;
}

.glass-list[data-layout="compact"] {
  flex-direction: row;
  align-items: center;
  overflow-x: auto;
  scrollbar-width: none;
}

.glass {
  display: flex;
  align-items: center;
  gap: calc(var(--tl-size) * 0.14);
}

.glass-body {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  inline-size: calc(var(--tl-size) * 0.42);
  block-size: var(--tl-size);
}

.glass-chamber {
  position: relative;
  inline-size: 100%;
  block-size: calc(50% - 1px);
  display: flex;
  overflow: hidden;
  background: color-mix(in oklab, currentColor calc(var(--tl-mark) * 0.9), transparent);
}

.glass-chamber-top {
  clip-path: polygon(0 0, 100% 0, 54% 100%, 46% 100%);
  align-items: flex-end;
}

.glass-chamber-bottom {
  clip-path: polygon(46% 0, 54% 0, 100% 100%, 0 100%);
  align-items: flex-end;
}

.glass-sand {
  inline-size: 100%;
  background: var(--tl-arc);
}

.glass-chamber-top .glass-sand {
  block-size: var(--top);
}

.glass-chamber-bottom .glass-sand {
  block-size: var(--bottom);
}

/* A single falling grain keeps the object alive without animating the mass. */
.glass-waist {
  position: absolute;
  inset-block: 42% 42%;
  inline-size: 1.5px;
  background: var(--tl-arc);
  opacity: 0.8;
}

.glass[data-mystery] .glass-waist {
  animation: glass-fall 2.6s linear infinite;
}

@keyframes glass-fall {
  from { opacity: 0.15; }
  50% { opacity: 0.85; }
  to { opacity: 0.15; }
}

.glass-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
}

.glass-time {
  font-size: calc(var(--tl-size) * 0.23);
}

.glass-label {
  text-align: start;
  font-size: calc(var(--tl-size) * 0.1);
}

.glass-list[data-layout="compact"] .glass {
  gap: 8px;
  padding: 4px 12px 4px 8px;
  border-radius: 999px;
  background: var(--tl-surface);
  backdrop-filter: blur(12px);
}

.glass-list[data-layout="compact"] .glass-time {
  font-size: 14px;
}

.glass-list[data-layout="compact"] .glass-label {
  font-size: 8.5px;
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .glass[data-mystery] .glass-waist {
    animation: none;
  }
}
</style>
