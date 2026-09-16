<script setup lang="ts">
import type { Component } from "vue";
import { formatTimer } from "../../../presentation.js";
import type { LabTimerView } from "./clock.js";
import type { TimerKind } from "./candidate.js";

defineProps<{
  timers: LabTimerView[];
  kind: TimerKind;
  urgency: boolean;
  ring: Component;
}>();

/** Compact keeps the ring readable while fitting the overlay title height. */
const RING_SIZE = 26;
</script>

<template>
  <div v-if="kind !== 'hidden'" class="compact-row">
    <TransitionGroup name="tl">
      <div
        v-for="view in timers"
        :key="view.key"
        class="tl-timer compact"
        role="timer"
        :aria-label="view.label ?? 'Timer'"
      >
        <span class="compact-ring" :style="{ '--tl-size': `${RING_SIZE}px` }">
          <component :is="ring" :view="view" :kind="kind" :urgency="urgency" />
        </span>
        <span class="compact-text">
          <span class="tl-time compact-time">{{
            kind === "mystery" ? "?" : formatTimer(view.remainingSeconds)
          }}</span>
          <span v-if="view.label" class="tl-label compact-label">{{ view.label }}</span>
        </span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.compact-row {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
  scrollbar-width: none;
  padding: 2px;
}

.compact {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px 5px 6px;
  border-radius: 999px;
  background: var(--tl-surface);
  backdrop-filter: blur(12px);
}

.compact-ring {
  position: relative;
  flex: 0 0 auto;
  inline-size: var(--tl-size);
  block-size: var(--tl-size);
}

.compact-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-inline-size: 0;
}

.compact-time {
  font-size: 14px;
  line-height: 1.1;
}

.compact-label {
  max-inline-size: 11ch;
  font-size: 8.5px;
  text-align: start;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
