<script setup lang="ts">
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
import { computed } from "vue";
import type { PlayerTimerKind, PlayerTimerPresentation } from "../../../model.js";
import TimerDisplay from "./TimerDisplay.vue";

const props = defineProps<{
  timers: readonly PlayerTimerPresentation[];
  kind: PlayerTimerKind;
}>();

const activeTimers = computed(() =>
  props.kind === "hidden"
    ? []
    : props.timers.filter((timer) => timer.remainingSeconds > 0),
);
const renderedKind = computed<Exclude<PlayerTimerKind, "hidden">>(() =>
  props.kind === "mystery" ? "mystery" : "visible",
);

function timerLabel(timer: PlayerTimerPresentation, index: number): string | null {
  if (timer.name?.trim()) return timer.name;
  return activeTimers.value.length > 1 ? `Timer ${index + 1}` : null;
}
</script>

<template>
  <ScrollArea v-if="activeTimers.length" class="max-h-full w-full" viewport-class="overscroll-y-contain">
    <TransitionGroup name="stage-timer" tag="div" class="timer-region">
      <TimerDisplay
        v-for="(timer, index) in activeTimers"
        :key="timer.id"
        :timer="timer"
        :kind="renderedKind"
        :label="timerLabel(timer, index)"
      />
    </TransitionGroup>
  </ScrollArea>
</template>

<style scoped>
.timer-region {
  display: flex;
  max-block-size: 100%;
  min-block-size: 0;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  padding: var(--player-timer-halo-space);
}


.stage-timer-enter-active,
.stage-timer-leave-active {
  transition: opacity 260ms ease, scale 260ms ease;
}

.stage-timer-enter-from,
.stage-timer-leave-to {
  opacity: 0;
  scale: 0.96;
}

@media (prefers-reduced-motion: reduce) {
  .stage-timer-enter-active,
  .stage-timer-leave-active { transition: opacity 160ms linear; }
  .stage-timer-enter-from,
  .stage-timer-leave-to { scale: 1; }
}
</style>
