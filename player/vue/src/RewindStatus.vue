<script setup lang="ts">
import { Loader2 } from "@lucide/vue";

// Debug's rewind switches over the Player's lifetime (DEBUGGER.md "Rewind"), so also with Debug off: a polite live
// region names the switch under way, and a small loading animation shows once it has lasted (`indicator`). The
// animation takes no layout space, so nothing moves when it comes or goes: the Debug bar, the default slot, shows it at
// the end of its first line; without the bar it shows here, on the composer's top edge.
defineProps<{
  busy: boolean;
  announcement: string;
  indicator: boolean;
  /** Whether the default slot holds the Debug bar, which shows the animation itself. */
  bar: boolean;
}>();
</script>

<template>
  <div class="rewind-status" :aria-busy="busy" data-rewind-status>
    <span role="status" class="sr-only" data-rewind-announcement>{{ announcement }}</span>
    <div class="rewind-status-anchor">
      <slot />
      <span
        v-if="indicator && !bar"
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
  display: grid;
  justify-items: center;
}
.rewind-status-anchor {
  position: relative;
  max-width: 100%;
}
/* Centred on the composer's top edge, clear of the last controls above it and the text in it. */
.rewind-switch-indicator {
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translate(-50%, 50%);
}
</style>
