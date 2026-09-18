<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useIntervalFn } from "@vueuse/core";
import type { PlayerTimerKind, PlayerTimerPresentation } from "../../../model.js";
import TimerRegion from "./TimerRegion.vue";

const props = defineProps<{
  kind: PlayerTimerKind;
  count: number;
  reset: number;
}>();

const seeds = [
  { id: "warm-up", name: "Warm-up", remainingSeconds: 95, totalSeconds: 180 },
  { id: "hold-position", remainingSeconds: 3664, totalSeconds: 4000 },
  { id: "recovery", remainingSeconds: 58, totalSeconds: 90 },
] as const;
const startedAt = ref(performance.now());
const now = ref(startedAt.value);

// Match the future presentation boundary: publish one authoritative observation
// per second and let CSS interpolate the determinate ring between observations.
useIntervalFn(() => {
  if (props.kind !== "hidden") now.value = performance.now();
}, 1000);
watch(() => props.kind, (kind) => {
  if (kind !== "hidden") now.value = performance.now();
});
watch(() => props.reset, () => {
  startedAt.value = performance.now();
  now.value = startedAt.value;
});

const timers = computed<readonly PlayerTimerPresentation[]>(() => {
  const elapsed = Math.max(0, (now.value - startedAt.value) / 1000);
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
