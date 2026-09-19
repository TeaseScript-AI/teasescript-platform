<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useIntervalFn } from "@vueuse/core";
import type { PlayerTimerKind, PlayerTimerPresentation } from "../../../model.js";
import TimerRegion from "./TimerRegion.vue";

const props = defineProps<{
  kind: PlayerTimerKind;
  count: number;
  reset: number;
  paused: boolean;
}>();

const seeds = [
  { id: "warm-up", name: "Warm-up", remainingSeconds: 95, totalSeconds: 180 },
  { id: "hold-position", remainingSeconds: 3664, totalSeconds: 4000 },
  { id: "recovery", remainingSeconds: 58, totalSeconds: 90 },
] as const;
const elapsedSeconds = ref(0);
let lastObservation = performance.now();

function observe() {
  const now = performance.now();
  elapsedSeconds.value += Math.max(0, (now - lastObservation) / 1000);
  lastObservation = now;
}

// Only the development fixture can pause; runtime timer ownership is unchanged.
useIntervalFn(() => {
  if (!props.paused) observe();
}, 1000);
watch(() => props.paused, (paused) => {
  if (paused) observe();
  else lastObservation = performance.now();
});
watch(() => props.reset, () => {
  elapsedSeconds.value = 0;
  lastObservation = performance.now();
});

const timers = computed<readonly PlayerTimerPresentation[]>(() => {
  const elapsed = elapsedSeconds.value;
  return seeds.slice(0, props.count).map((timer) => ({
    id: timer.id,
    ...("name" in timer ? { name: timer.name } : {}),
    remainingSeconds: Math.max(0, timer.remainingSeconds - elapsed),
    totalSeconds: timer.totalSeconds,
  }));
});
</script>

<template>
  <TimerRegion :timers="timers" :kind="kind" />
</template>
