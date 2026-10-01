<script setup lang="ts">
import { computed, ref } from "vue";
import { useResizeObserver } from "@vueuse/core";
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";

// Owner decision (#418): the background-control group targets the Player viewport centre.
// The rail spans the full Player height while it stays clear of the reading column; otherwise
// it falls back to the Stage, with controls directly below the timers.
const rail = ref<HTMLElement | null>(null);
const pane = ref<InstanceType<typeof ScrollArea> | null>(null);
const group = ref<HTMLElement | null>(null);
const fullHeight = ref(true);
const groupOffset = ref(0);

const player = computed(() => (rail.value?.offsetParent as HTMLElement | null) ?? undefined);
const column = computed(
  () => player.value?.querySelector<HTMLElement>("[data-conversation-overlay]") ?? undefined,
);

function layout() {
  const railElement = rail.value;
  const playerElement = player.value;
  if (!railElement || !playerElement) return;
  // The reading column includes its scrollbar gutter, which equals the conversation inset.
  const columnRight = column.value
    ? column.value.getBoundingClientRect().right +
      (Number.parseFloat(getComputedStyle(column.value).getPropertyValue("--conversation-inline-inset")) || 0)
    : -Infinity;
  fullHeight.value = columnRight <= railElement.getBoundingClientRect().left;
  const paneElement = pane.value?.$el as HTMLElement | undefined;
  if (!paneElement || !group.value) return;
  if (!fullHeight.value) {
    groupOffset.value = 0;
    return;
  }
  // Centre on the viewport, then shift only as far as needed to stay below the timers and
  // inside the Player. A group taller than the pane starts at its top and scrolls.
  const playerBox = playerElement.getBoundingClientRect();
  const paneBox = paneElement.getBoundingClientRect();
  const height = group.value.offsetHeight;
  const centred = playerBox.top + playerBox.height / 2 - height / 2 - paneBox.top;
  groupOffset.value = Math.max(0, Math.min(centred, paneBox.height - height));
}

useResizeObserver(
  () => [player.value, column.value, rail.value, pane.value?.$el as HTMLElement | undefined, group.value],
  layout,
);
</script>

<template>
  <div
    v-if="$slots.timers || $slots.controls"
    ref="rail"
    class="stage-right-rail"
    :data-has-controls="$slots.controls ? '' : undefined"
    :data-rail-extent="fullHeight ? 'player' : 'stage'"
  >
    <div v-if="$slots.timers" class="stage-right-rail-timers">
      <slot name="timers" />
    </div>
    <ScrollArea
      v-if="$slots.controls"
      ref="pane"
      class="stage-right-rail-controls"
      viewport-class="overscroll-y-contain"
      role="group"
      aria-label="Background controls and status"
    >
      <div ref="group" class="stage-right-rail-group" :style="{ marginBlockStart: `${groupOffset}px` }">
        <slot name="controls" />
      </div>
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
  inline-size: var(--player-timer-rail-width);
  min-block-size: 0;
  grid-template-rows: minmax(0, 1fr);
  padding-block: var(--player-following-control-top) var(--player-edge-space);
  /* Over the conversation margin, only the timers and controls take pointer input. */
  pointer-events: none;
}

.stage-right-rail[data-rail-extent="stage"] {
  bottom: auto;
  block-size: var(--stage-height);
  /* Like the Stage itself, the fallback never spills over the conversation. */
  overflow: clip;
}

.stage-right-rail[data-has-controls] {
  /* Timers use their natural height until both panes would contend, then leave
     at least half of the rail to background controls. */
  grid-template-rows: fit-content(50%) minmax(0, 1fr);
}

/* A single timer stays complete; the controls own the remaining scrollable space. */
.stage-right-rail[data-has-controls]:has(.timer-display:only-child) {
  grid-template-rows: max-content minmax(0, 1fr);
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
  pointer-events: auto;
}

.stage-right-rail-controls {
  grid-row: 2;
}

.stage-right-rail-group,
.stage-right-rail-controls :deep([data-slot="scroll-area-scrollbar"]) {
  pointer-events: auto;
}
</style>
