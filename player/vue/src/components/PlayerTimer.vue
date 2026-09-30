<script setup lang="ts">
import type { PlayerTimerPresentation } from "../../../model.js";
import { formatTimer, timerProgressPercent } from "../../../presentation.js";

const props = defineProps<{ timers: readonly PlayerTimerPresentation[] }>();

function label(timer: PlayerTimerPresentation, index: number): string | null {
  if (timer.name !== undefined && timer.name.length > 0) return timer.name;
  return props.timers.length > 1 ? `Timer ${index + 1}` : null;
}
</script>

<template>
  <div v-if="timers.length > 0" class="timer-wrap">
    <div class="timer-list">
      <div
        v-for="(item, index) in timers"
        :key="item.id"
        class="timer"
        :aria-label="label(item, index) ?? 'Timer'"
        data-label-placement="below"
        :data-timer-kind="item.kind"
        :style="{
          '--timer-progress': `${
            item.kind === 'mystery'
              ? 28
              : timerProgressPercent(item.remainingSeconds, item.totalSeconds)
          }%`,
        }"
      >
        <span class="timer-text">{{
          item.kind === "mystery" ? "?" : formatTimer(Math.ceil(item.remainingSeconds))
        }}</span>
        <span v-if="label(item, index) !== null" class="timer-label">{{ label(item, index) }}</span>
      </div>
    </div>
  </div>
</template>
