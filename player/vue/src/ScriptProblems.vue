<script lang="ts">
import type { Problem } from "./ProblemCard.vue";

export interface ScriptFailure {
  readonly title: string;
  /** What the player reads. */
  readonly summary: string;
  /** For the creator, under Technical details: the diagnostics, or other problems, that keep the script from starting. */
  readonly problems: readonly Problem[];
}
</script>

<script setup lang="ts">
import ProblemCard from "./ProblemCard.vue";

// Shown instead of Start when the script cannot run (PLAYER-UI "Session start and user activation"): a sentence for the
// player, and what the creator needs to fix collapsed below it, rather than an empty Player.
defineProps<{ failure: ScriptFailure }>();
</script>

<template>
  <div class="script-failure" data-script-failure>
    <ProblemCard :title="failure.title" :summary="failure.summary" :problems="failure.problems" />
  </div>
</template>

<style scoped>
/* Over the composition like Start; the top bar stays reachable above it. The one track has the space left, so a
   long list scrolls inside the card. */
.script-failure {
  position: absolute;
  z-index: 30;
  inset: 0;
  display: grid;
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  place-items: center;
  padding: var(--player-header-size) var(--player-edge-space);
  pointer-events: none;
}
.script-failure > * { pointer-events: auto; }
</style>
