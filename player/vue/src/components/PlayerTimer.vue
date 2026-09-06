<script setup lang="ts">
import { computed } from "vue";
import type { PlayerTimerPresentation } from "../../../model.js";
import { formatTimer, timerProgressPercent } from "../../../presentation.js";

const props = defineProps<{
  timer: PlayerTimerPresentation;
}>();

const progress = computed(() => timerProgressPercent(
  props.timer.remainingSeconds,
  props.timer.totalSeconds,
));
</script>

<template>
  <div class="timer-wrap">
    <div class="timer-list">
      <div
        class="timer"
        aria-label="Timer 1"
        data-label-placement="below"
        data-timer-kind="visible"
        :style="{ '--timer-progress': `${progress}%` }"
      >
        <span class="timer-text">{{ formatTimer(timer.remainingSeconds) }}</span>
        <span class="timer-label">Timer 1</span>
      </div>
    </div>
  </div>
</template>
