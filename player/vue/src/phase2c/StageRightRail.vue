<template>
  <div
    v-if="$slots.timers || $slots.controls"
    class="stage-right-rail"
    :data-has-controls="$slots.controls ? '' : undefined"
  >
    <div v-if="$slots.timers" class="stage-right-rail-timers">
      <slot name="timers" />
    </div>
    <div v-if="$slots.controls" class="stage-right-rail-controls" role="group" aria-label="Background controls and status">
      <slot name="controls" />
    </div>
  </div>
</template>

<style scoped>
.stage-right-rail {
  position: absolute;
  z-index: 10;
  top: 0;
  right: 1rem;
  bottom: 0;
  display: grid;
  inline-size: 11rem;
  min-block-size: 0;
  grid-template-rows: minmax(0, 1fr);
  padding-block: 4rem 1rem;
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
  overflow-y: auto;
  overscroll-behavior: contain;
}

@container player-stage (max-width: 76rem) or (max-height: 24.5rem) {
  .stage-right-rail {
    top: 3.75rem;
    right: 0.5rem;
    left: 0.5rem;
    bottom: auto;
    display: flex;
    inline-size: auto;
    max-block-size: none;
    flex-direction: row;
    justify-content: flex-end;
    padding-block: 0;
    transform: none;
  }
  .stage-right-rail-timers { max-inline-size: 100%; }
}
</style>
