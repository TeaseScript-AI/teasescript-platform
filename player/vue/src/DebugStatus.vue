<script setup lang="ts">
import { computed } from "vue";
import { FastForward } from "@lucide/vue";
import type { DebugLog } from "./useDebugLog";
import type { DevelopmentTime } from "./useDevelopmentTime";

// Over the Stage of the Player with `?dev`: a badge while auto-skip changes how time runs, and an invisible live region
// that announces each new Debug log line, also while the Debug panel is closed. The line number makes equal lines
// announce again.
const props = defineProps<{ time: DevelopmentTime; log: DebugLog }>();
const latest = computed(() => props.log.lines.value[0] ?? null);
</script>

<template>
  <div v-if="time.autoSkip.value" class="development-time-badge" data-development-time-badge>
    <FastForward aria-hidden="true" class="size-3.5" />
    Auto-skip
  </div>
  <span role="status" class="sr-only" data-debug-announcement>
    <template v-if="latest">Debug log {{ latest.id }}: {{ latest.text }}</template>
  </span>
</template>

<style scoped>
/* Below the top bar's controls and clear of the right rail; status only, so it never takes a click from the Stage. */
.development-time-badge {
  position: absolute;
  z-index: 20;
  inset-block-start: calc(var(--player-edge-space) * 2 + var(--player-top-control-size));
  inset-inline-start: var(--player-edge-space);
  display: flex;
  align-items: center;
  gap: 0.25rem;
  max-inline-size: calc(100% - var(--player-timer-rail-width) - 3 * var(--player-edge-space));
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--media-border);
  border-radius: 9999px;
  background: var(--media-surface);
  color: var(--media-text);
  box-shadow: 0 1px 3px var(--media-shadow);
  backdrop-filter: blur(3px);
  font-size: 0.75rem;
  font-weight: 600;
  pointer-events: none;
}
</style>
