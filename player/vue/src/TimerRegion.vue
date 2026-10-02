<script setup lang="ts">
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
import type { PlayerTimerPresentation } from "../../model.js";
import TimerDisplay from "./TimerDisplay.vue";

// Every entry is presented; hidden timers have no entry, and each timer carries its own kind.
const props = defineProps<{ timers: readonly PlayerTimerPresentation[] }>();

function timerLabel(timer: PlayerTimerPresentation, index: number): string | null {
  if (timer.name?.trim()) return timer.name;
  return props.timers.length > 1 ? `Timer ${index + 1}` : null;
}
</script>

<template>
  <ScrollArea
    v-if="timers.length"
    class="timer-pane max-h-full"
    viewport-class="overscroll-y-contain"
  >
    <TransitionGroup name="stage-timer" tag="div" class="timer-region">
      <TimerDisplay
        v-for="(timer, index) in timers"
        :key="timer.id"
        :timer="timer"
        :kind="timer.kind"
        :label="timerLabel(timer, index)"
      />
    </TransitionGroup>
  </ScrollArea>
</template>

<style scoped>
.timer-pane {
  inline-size: var(--player-timer-size);
  margin-inline: auto;
}

.timer-region {
  display: flex;
  max-block-size: 100%;
  min-block-size: 0;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
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
