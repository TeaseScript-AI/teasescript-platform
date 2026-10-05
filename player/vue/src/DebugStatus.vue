<script setup lang="ts">
import { computed } from "vue";
import { FastForward } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import type { DebugLog } from "./useDebugLog";
import type { DevelopmentTime } from "./useDevelopmentTime";

// Over the Stage of the Player with `?dev`: a badge while auto-skip changes how time runs, and an invisible live region
// that announces each new Debug log line, also while the Debug panel is closed. The line number makes equal lines
// announce again.
const props = defineProps<{ time: DevelopmentTime; log: DebugLog }>();
const latest = computed(() => props.log.lines.value[0] ?? null);
</script>

<template>
  <!-- Below the top bar's controls and clear of the right rail; status only, so it never takes a click from the Stage. -->
  <div v-if="time.autoSkip.value" class="debug-status-placement" data-development-time-badge>
    <Badge>
      <FastForward aria-hidden="true" />
      Auto-skip
    </Badge>
  </div>
  <span role="status" class="sr-only" data-debug-announcement>
    <template v-if="latest">Debug log {{ latest.id }}: {{ latest.text }}</template>
  </span>
</template>

<style scoped>
.debug-status-placement {
  position: absolute;
  z-index: 20;
  inset-block-start: calc(var(--player-edge-space) * 2 + var(--player-top-control-size));
  inset-inline-start: var(--player-edge-space);
  pointer-events: none;
}
</style>
