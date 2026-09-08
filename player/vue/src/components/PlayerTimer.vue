<script setup lang="ts">
import { computed } from "vue";
import type { PlayerTimerKind, PlayerTimerPresentation } from "../../../model.js";
import { formatTimer, timerProgressPercent } from "../../../presentation.js";

/*
  Timers are dial capsules docked to the stage rather than rings stacked in a
  side rail, so time pressure sits where the scene is and several timers stay
  affordable. The first capsule in presentation order carries the lead reading;
  presentation order never reveals whether script execution is blocked.
*/
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

function progress(timer: PlayerTimerPresentation): string {
  return props.timerKind === "mystery"
    ? "28%"
    : `${timerProgressPercent(timer.remainingSeconds, timer.totalSeconds)}%`;
}
</script>

<template>
  <div v-if="timerKind !== 'hidden'" class="stage-timers">
    <div class="timer-list">
      <div
        v-for="(item, index) in timers"
        :key="index"
        class="timer instrument"
        :aria-label="label(item, index) ?? 'Timer'"
        :data-timer-kind="timerKind"
        :style="{ '--timer-progress': progress(item) }"
      >
        <span class="timer-dial" aria-hidden="true"></span>
        <span class="timer-readout">
          <span class="timer-text">{{
            timerKind === "mystery" ? "?" : formatTimer(item.remainingSeconds)
          }}</span>
          <span v-if="label(item, index) !== null" class="timer-label">{{
            label(item, index)
          }}</span>
        </span>
      </div>
    </div>
  </div>
</template>
