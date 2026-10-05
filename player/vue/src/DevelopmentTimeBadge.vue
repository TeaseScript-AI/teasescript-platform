<script setup lang="ts">
import { computed } from "vue";
import { FastForward } from "@lucide/vue";
import type { DevelopmentTime } from "./useDevelopmentTime";

// Keeps active development time controls visible over the Stage while their panel is closed, and announces each jump.
const props = defineProps<{ time: DevelopmentTime }>();
const latest = computed(() => props.time.jumps.value[0]?.text ?? "");
</script>

<template>
  <div v-if="time.enabled.value" class="development-time-badge" data-development-time-badge>
    <span class="development-time-badge-label">
      <FastForward aria-hidden="true" class="size-3.5" />
      {{ time.autoSkip.value ? "Time controls · auto-skip" : "Time controls" }}
    </span>
    <span role="status" data-development-time-marker>{{ latest }}</span>
  </div>
</template>

<style scoped>
/* Below the top bar's controls and clear of the right rail; status only, so it never takes a click from the Stage. */
.development-time-badge {
  position: absolute;
  z-index: 20;
  inset-block-start: calc(var(--player-edge-space) * 2 + var(--player-top-control-size));
  inset-inline-start: var(--player-edge-space);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  row-gap: 0.25rem;
  max-inline-size: calc(100% - var(--player-timer-rail-width) - 3 * var(--player-edge-space));
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--media-border);
  border-radius: 9999px;
  background: var(--media-surface);
  color: var(--media-text);
  box-shadow: 0 1px 3px var(--media-shadow);
  backdrop-filter: blur(3px);
  font-size: 0.75rem;
  pointer-events: none;
}
.development-time-badge-label {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-weight: 600;
}
.development-time-badge [role="status"]:not(:empty) { margin-inline-start: 0.5rem; }
</style>
