<script lang="ts">
/** A diagnostic, or another problem, that keeps a script from starting; with its file and position when known. */
export interface ScriptProblem {
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
  readonly message: string;
}

export interface ScriptFailure {
  readonly title: string;
  /** What the player reads. */
  readonly summary: string;
  /** For the creator, under Technical details. */
  readonly problems: readonly ScriptProblem[];
}
</script>

<script setup lang="ts">
import Collapsible from "@/components/ui/collapsible/Collapsible.vue";
import CollapsibleContent from "@/components/ui/collapsible/CollapsibleContent.vue";
import CollapsibleDisclosure from "@/components/ui/collapsible/CollapsibleDisclosure.vue";

// Shown instead of Start when the script cannot run (PLAYER-UI "Session start and user activation"): a sentence for the
// player, and what the creator needs to fix collapsed below it, as in the error dialog, rather than an empty Player.
defineProps<{ failure: ScriptFailure }>();

function location(problem: ScriptProblem): string {
  if (problem.line === undefined) return problem.path ?? "";
  return `${problem.path}, line ${problem.line}, column ${problem.column}`;
}
</script>

<template>
  <div class="script-failure" data-script-failure>
    <section
      aria-labelledby="script-failure-title"
      class="flex max-h-full w-full max-w-xl flex-col gap-3 rounded-xl border bg-card p-5 text-foreground shadow-lg"
    >
      <div role="alert" class="flex flex-col gap-1">
        <h2 id="script-failure-title" class="text-base font-semibold">{{ failure.title }}</h2>
        <p class="text-sm" data-script-failure-summary>{{ failure.summary }}</p>
      </div>
      <Collapsible v-if="failure.problems.length > 0" class="flex min-h-0 flex-col gap-2">
        <CollapsibleDisclosure data-script-failure-technical-toggle>Technical details</CollapsibleDisclosure>
        <CollapsibleContent class="min-h-0 overflow-y-auto rounded-md bg-muted p-3">
          <ol class="flex flex-col gap-3 wrap-anywhere" data-script-failure-technical>
            <li v-for="(problem, index) in failure.problems" :key="index" class="flex flex-col gap-0.5">
              <span v-if="problem.path" class="font-mono text-sm text-muted-foreground">{{ location(problem) }}</span>
              <span class="text-sm">{{ problem.message }}</span>
            </li>
          </ol>
        </CollapsibleContent>
      </Collapsible>
    </section>
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
