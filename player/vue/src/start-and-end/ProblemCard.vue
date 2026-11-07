<script lang="ts">
/** A diagnostic, or another problem, under Technical details; with its file and position, or its path, when known. */
export interface Problem {
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
  /** The diagnostic's code, such as `TSC011`. */
  readonly code?: string;
  readonly message: string;
}
</script>

<script setup lang="ts">
import { useId } from "vue";
import Collapsible from "@/components/ui/collapsible/Collapsible.vue";
import CollapsibleContent from "@/components/ui/collapsible/CollapsibleContent.vue";
import CollapsibleDisclosure from "@/components/ui/collapsible/CollapsibleDisclosure.vue";

// What keeps a Tease from starting or a session from continuing, on the start page (PLAYER-UI "Session start and user
// activation"): a heading and a sentence for the player, and the problems collapsed below, as in the error dialog. The
// card is at most as tall as a bounded place, where the problems scroll.
defineProps<{ title: string; summary: string; problems: readonly Problem[] }>();
const titleId = useId();

function location(problem: Problem): string {
  if (problem.line === undefined) return problem.path ?? "";
  return `${problem.path}, line ${problem.line}, column ${problem.column}`;
}
</script>

<template>
  <section
    :aria-labelledby="titleId"
    class="flex max-h-full w-full max-w-xl flex-col gap-3 rounded-xl border bg-card p-5 text-foreground shadow-lg"
  >
    <div role="alert" class="flex flex-col gap-1">
      <h2 :id="titleId" class="text-base font-semibold">{{ title }}</h2>
      <p class="text-sm" data-problem-summary>{{ summary }}</p>
    </div>
    <Collapsible v-if="problems.length > 0" class="flex min-h-0 flex-col gap-2">
      <CollapsibleDisclosure data-problem-technical-toggle>Technical details</CollapsibleDisclosure>
      <CollapsibleContent class="min-h-0 overflow-y-auto">
        <ol class="flex flex-col gap-2 text-xs wrap-anywhere" data-problem-technical>
          <li v-for="(problem, index) in problems" :key="index" class="flex flex-col gap-0.5">
            <span v-if="problem.path" class="font-mono text-muted-foreground">{{ location(problem) }}</span>
            <span
              ><template v-if="problem.code"><code class="font-mono">{{ problem.code }}</code>: </template
              >{{ problem.message }}</span
            >
          </li>
        </ol>
      </CollapsibleContent>
    </Collapsible>
  </section>
</template>
