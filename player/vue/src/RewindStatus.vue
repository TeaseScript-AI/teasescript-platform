<script setup lang="ts">
import { Loader2 } from "@lucide/vue";

// Debug's rewind switches over the Player's lifetime (DEBUGGER.md "Rewind"), so also with Debug off: a polite live
// region names the switch under way, and a small loading animation shows once it has lasted (`indicator`). The
// animation is an overlay that takes no layout space, so nothing moves when it comes or goes: beside the Debug bar,
// the default slot, where there is room, at the end of the bar's first line where there is not (the bar keeps it
// free), and on the composer's top edge without the bar.
defineProps<{
  busy: boolean;
  announcement: string;
  indicator: boolean;
  /** Whether the default slot holds the Debug bar. */
  bar: boolean;
}>();
</script>

<template>
  <div class="rewind-status" :aria-busy="busy" data-rewind-status>
    <span role="status" class="sr-only" data-rewind-announcement>{{ announcement }}</span>
    <div class="rewind-status-anchor" :class="{ 'rewind-status-bar': bar }">
      <slot />
      <span
        v-if="indicator"
        class="rewind-switch-indicator rounded-full border bg-background p-0.5 text-muted-foreground shadow-sm"
        aria-hidden="true"
        data-rewind-switch-indicator
      >
        <Loader2 class="size-4 animate-spin" />
      </span>
    </div>
  </div>
</template>

<style scoped>
.rewind-status {
  container-type: inline-size;
  display: grid;
  justify-items: center;
}
.rewind-status-anchor {
  position: relative;
  max-width: 100%;
}
/* Without the bar: centred on the composer's top edge, clear of the last controls above it and the text in it. */
.rewind-switch-indicator {
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translate(-50%, 50%);
}
/* Beside the bar, centred on it (the bar keeps 8px below itself). */
.rewind-status-bar .rewind-switch-indicator {
  bottom: auto;
  top: calc(50% - 4px);
  left: calc(100% + 8px);
  transform: translateY(-50%);
}
/* Without room beside the bar (36rem at most, plus the animation and its gap on either side): at the end of its first
   line, inside its 8px padding. */
@container (width < 41rem) {
  .rewind-status-bar .rewind-switch-indicator {
    top: 10px;
    left: auto;
    right: 10px;
    transform: none;
  }
}
</style>
