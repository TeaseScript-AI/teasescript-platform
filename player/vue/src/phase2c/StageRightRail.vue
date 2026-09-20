<script setup lang="ts">
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
</script>

<template>
  <div
    v-if="$slots.timers || $slots.controls"
    class="stage-right-rail"
    :data-has-controls="$slots.controls ? '' : undefined"
  >
    <div v-if="$slots.timers" class="stage-right-rail-timers">
      <slot name="timers" />
    </div>
    <ScrollArea v-if="$slots.controls" class="stage-right-rail-controls" viewport-class="overscroll-y-contain" role="group" aria-label="Background controls and status">
      <slot name="controls" />
    </ScrollArea>
  </div>
</template>

<style scoped>
.stage-right-rail {
  position: absolute;
  z-index: 10;
  top: 0;
  right: var(--player-edge-space);
  bottom: 0;
  display: grid;
  inline-size: calc(var(--player-timer-size) + 2 * var(--player-timer-halo-space));
  min-block-size: 0;
  grid-template-rows: minmax(0, 1fr);
  padding-block: calc(var(--player-header-size) + 2 * var(--player-edge-space)) var(--player-edge-space);
}

.stage-right-rail[data-has-controls] {
  /* Timers use their natural height until both panes would contend, then leave
     at least half of the rail to background controls. */
  grid-template-rows: fit-content(50%) minmax(0, 1fr);
}

.stage-right-rail-timers,
.stage-right-rail-controls {
  min-inline-size: 0;
  min-block-size: 0;
}

.stage-right-rail-timers {
  display: flex;
  justify-content: center;
  grid-row: 1;
  overflow: hidden;
}

.stage-right-rail-controls {
  grid-row: 2;
}

</style>
