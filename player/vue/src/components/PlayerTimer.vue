<script setup lang="ts">
import { computed } from "vue";
import type { PlayerTimerKind, PlayerTimerPresentation } from "../../../model.js";
import { formatTimer, timerProgressPercent } from "../../../presentation.js";

const props = defineProps<{
  timer: PlayerTimerPresentation;
  timerCount: number;
  timerKind: PlayerTimerKind;
}>();

const timers = computed(() =>
  Array.from({ length: props.timerCount }, (_, index): PlayerTimerPresentation => ({
    ...(index === 0 && props.timer.name !== undefined ? { name: props.timer.name } : {}),
    remainingSeconds: props.timer.remainingSeconds + index * 37,
    totalSeconds: props.timer.totalSeconds + index * 60,
  })),
);

function label(timer: PlayerTimerPresentation, index: number): string | null {
  if (timer.name !== undefined && timer.name.length > 0) return timer.name;
  return timers.value.length > 1 ? `Timer ${index + 1}` : null;
}
</script>

<template>
  <div v-if="timerKind !== 'hidden'" class="timer-wrap">
    <div class="timer-list">
      <div
        v-for="(item, index) in timers"
        :key="index"
        class="timer"
        :aria-label="label(item, index) ?? 'Timer'"
        data-label-placement="below"
        :data-timer-kind="timerKind"
        :style="{
          '--timer-progress': `${
            timerKind === 'mystery'
              ? 28
              : timerProgressPercent(item.remainingSeconds, item.totalSeconds)
          }%`,
        }"
      >
        <span class="timer-text">{{
          timerKind === "mystery" ? "?" : formatTimer(item.remainingSeconds)
        }}</span>
        <span v-if="label(item, index) !== null" class="timer-label">{{ label(item, index) }}</span>
      </div>
    </div>
  </div>
</template>
