<script lang="ts">
/** A diagnostic, or another problem, that keeps a script from starting; with its file and position when known. */
export interface ScriptProblem {
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity?: "error" | "warning";
  readonly message: string;
}

export interface ScriptFailure {
  readonly title: string;
  readonly problems: readonly ScriptProblem[];
}
</script>

<script setup lang="ts">
// Shown instead of Start when the script cannot run (PLAYER-UI "Session start and user activation"), so the author
// sees what to fix rather than an empty Player.
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
      <div role="alert">
        <h2 id="script-failure-title" class="text-base font-semibold">{{ failure.title }}</h2>
      </div>
      <ol class="flex min-h-0 flex-col gap-3 overflow-y-auto wrap-anywhere">
        <li v-for="(problem, index) in failure.problems" :key="index" class="flex flex-col gap-0.5">
          <span v-if="problem.path" class="font-mono text-sm text-muted-foreground">{{ location(problem) }}</span>
          <span class="text-sm">
            <template v-if="problem.severity === 'warning'">Warning: </template>{{ problem.message }}
          </span>
        </li>
      </ol>
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
