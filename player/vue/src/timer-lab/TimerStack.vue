<script setup lang="ts">
import type { Component } from "vue";
import { formatTimer } from "../../../presentation.js";
import type { LabTimerView } from "./clock.js";
import type { TimerKind } from "./candidate.js";

withDefaults(
  defineProps<{
    timers: LabTimerView[];
    kind: TimerKind;
    size: number;
    urgency: boolean;
    ring: Component;
    /**
     * `disc` is a hard-edged translucent plate, `scrim` fades out instead, and
     * `none` leaves the candidate's own graphic to carry legibility.
     */
    surface?: "disc" | "scrim" | "none";
  }>(),
  { surface: "disc" },
);
</script>

<template>
  <div v-if="kind !== 'hidden'" class="stack-list">
    <TransitionGroup name="tl">
      <div
        v-for="view in timers"
        :key="view.key"
        class="tl-timer stack"
        role="timer"
        :aria-label="view.label ?? 'Timer'"
        :data-surface="surface"
        :style="{ '--tl-size': `${size}px` }"
      >
        <component :is="ring" :view="view" :kind="kind" :urgency="urgency" />
        <div class="stack-body">
          <span class="tl-time">{{ kind === "mystery" ? "?" : formatTimer(view.remainingSeconds) }}</span>
          <span v-if="view.label" class="tl-label">{{ view.label }}</span>
        </div>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.stack-list {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.stack {
  inline-size: var(--tl-size);
  block-size: var(--tl-size);
  display: grid;
  place-items: center;
}

.stack:not([data-surface="none"])::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  backdrop-filter: blur(12px);
}

.stack[data-surface="disc"]::before {
  background: var(--tl-surface);
}

/* A scrim keeps the open gauge from reading as a plate with a chip out of it. */
.stack[data-surface="scrim"]::before {
  background: radial-gradient(
    closest-side,
    var(--tl-surface) 58%,
    color-mix(in oklab, var(--tl-surface) 35%, transparent) 84%,
    transparent 100%
  );
  mask: radial-gradient(closest-side, #000 60%, transparent 100%);
}

.stack-body {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: calc(var(--tl-size) * 0.045);
  padding-inline: calc(var(--tl-size) * 0.14);
}
</style>
