<script setup lang="ts">
import { computed } from "vue";
import type { PlayerTimerKind, PlayerTimerPresentation } from "../../../model.js";
import { formatTimer, timerProgressRatio } from "../../../presentation.js";

const props = defineProps<{
  timer: PlayerTimerPresentation;
  kind: Exclude<PlayerTimerKind, "hidden">;
  label: string | null;
}>();

const RING_RADIUS = 45;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const elapsed = computed(() =>
  props.kind === "mystery"
    ? 0.22
    : timerProgressRatio(props.timer.remainingSeconds, props.timer.totalSeconds),
);
const dasharray = computed(() => `${RING_CIRCUMFERENCE * elapsed.value} ${RING_CIRCUMFERENCE}`);
const displayedTime = computed(() =>
  props.kind === "mystery" ? "?" : formatTimer(props.timer.remainingSeconds),
);
const accessibleName = computed(() => {
  const subject = props.label ?? "Timer";
  return props.kind === "mystery"
    ? `${subject}, remaining time hidden`
    : `${subject}, ${displayedTime.value} remaining`;
});
</script>

<template>
  <div
    class="timer-display"
    :data-kind="kind"
    :data-long-time="(kind === 'visible' && timer.remainingSeconds >= 3600) || undefined"
    role="timer"
    :aria-label="accessibleName"
  >
    <span class="timer-ring" aria-hidden="true">
      <svg class="timer-ring-svg" viewBox="0 0 100 100">
        <circle class="timer-track" cx="50" cy="50" :r="RING_RADIUS" />
        <g class="timer-rotor">
          <circle
            class="timer-arc"
            cx="50"
            cy="50"
            :r="RING_RADIUS"
            :stroke-dasharray="dasharray"
          />
        </g>
      </svg>
    </span>
    <span class="timer-copy">
      <span class="timer-time">{{ displayedTime }}</span>
      <span v-if="label" class="timer-label">{{ label }}</span>
    </span>
  </div>
</template>

<style scoped>
.timer-display {
  --timer-size: 132px;
  --timer-foreground: var(--theme-overlay-text, oklch(100% 0 0));
  --timer-surface: var(--theme-overlay-surface, oklch(16.52% 0 0));
  --timer-accent: var(--theme-accent-solid, var(--package-accent));
  position: relative;
  display: grid;
  flex: 0 0 auto;
  inline-size: var(--timer-size);
  block-size: var(--timer-size);
  place-items: center;
  color: var(--timer-foreground);
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}

.timer-display::before {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: radial-gradient(
    closest-side,
    color-mix(in oklab, var(--timer-surface) 40%, transparent) 0%,
    color-mix(in oklab, var(--timer-surface) 26%, transparent) 52%,
    color-mix(in oklab, var(--timer-surface) 12%, transparent) 100%
  );
  box-shadow: 0 0 12px color-mix(in oklab, var(--timer-surface) 12%, transparent);
  backdrop-filter: blur(6px);
  filter: blur(0.75px);
  content: "";
}

.timer-ring {
  position: absolute;
  inset: 3px;
}

.timer-ring-svg {
  display: block;
  inline-size: 100%;
  block-size: 100%;
  rotate: -90deg;
  overflow: visible;
}

.timer-track,
.timer-arc {
  fill: none;
  stroke-width: 2.4;
}

.timer-track {
  stroke: var(--theme-overlay-track, color-mix(in oklab, var(--timer-foreground) 56%, transparent));
}

.timer-arc {
  stroke: var(--timer-accent);
  transition: stroke-dasharray 1s linear;
}

.timer-rotor {
  transform-origin: 50px 50px;
}

.timer-display[data-kind="mystery"] .timer-rotor {
  animation: timer-mystery-drift 14s linear infinite;
}

.timer-copy {
  position: relative;
  display: flex;
  min-inline-size: 0;
  flex-direction: column;
  align-items: center;
  gap: calc(var(--timer-size) * 0.045);
  padding-inline: calc(var(--timer-size) * 0.14);
}

.timer-time {
  color: var(--theme-overlay-text, color-mix(in oklab, var(--timer-foreground) 72%, var(--timer-accent)));
  font-size: calc(var(--timer-size) * 0.32);
  font-weight: 350;
  line-height: 1;
  letter-spacing: -0.025em;
  text-shadow: 0 1px 2px var(--theme-overlay-shadow, oklch(0% 0 0 / 48%));
}

.timer-display[data-long-time] .timer-time {
  font-size: calc(var(--timer-size) * 0.23);
}

.timer-label {
  max-inline-size: calc(var(--timer-size) * 0.74);
  color: var(--timer-foreground);
  overflow-wrap: anywhere;
  font-size: calc(var(--timer-size) * 0.1);
  font-weight: 500;
  line-height: 1.2;
  letter-spacing: 0.02em;
  text-align: center;
  text-shadow: 0 1px 2px var(--theme-overlay-shadow, oklch(0% 0 0 / 48%));
}

@keyframes timer-mystery-drift {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .timer-arc { transition: none; }
  .timer-display[data-kind="mystery"] .timer-rotor { animation: none; }
}
</style>
