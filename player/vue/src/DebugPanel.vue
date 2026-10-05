<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import Collapsible from "@/components/ui/collapsible/Collapsible.vue";
import CollapsibleContent from "@/components/ui/collapsible/CollapsibleContent.vue";
import CollapsibleTrigger from "@/components/ui/collapsible/CollapsibleTrigger.vue";
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
import type { DebugLog } from "./useDebugLog";
import type { DevelopmentTime } from "./useDevelopmentTime";

// The Debug tool of the Player with `?dev`: development time controls (#615) and the Debug log, newest line first.
// An explanation opens from its label, by click, tap or keyboard; any number may be open.
defineProps<{ time: DevelopmentTime; log: DebugLog }>();
</script>

<template>
  <div class="grid gap-4 p-4 text-xs" data-debug-panel>
    <section aria-labelledby="debug-time" class="grid gap-2">
      <h3 id="debug-time" class="font-semibold">Time</h3>
      <Collapsible class="grid gap-1">
        <div class="flex items-center justify-between gap-2">
          <CollapsibleTrigger class="debug-explanation-trigger" aria-label="About auto-skip">
            <span id="debug-auto-skip">Auto-skip</span>
            <ChevronDown aria-hidden="true" class="size-3.5" />
          </CollapsibleTrigger>
          <input
            v-model="time.autoSkip.value"
            type="checkbox"
            role="switch"
            aria-labelledby="debug-auto-skip"
          />
        </div>
        <CollapsibleContent class="text-muted-foreground">
          Waits, timers and pacing pauses complete at once; while the script waits for your input, time runs normally.
        </CollapsibleContent>
      </Collapsible>
      <Collapsible class="grid gap-1">
        <CollapsibleTrigger class="debug-explanation-trigger" aria-label="About time jumps">
          <span>Jumps</span>
          <ChevronDown aria-hidden="true" class="size-3.5" />
        </CollapsibleTrigger>
        <CollapsibleContent class="text-muted-foreground">
          Skip event jumps to the next wait, timer, pacing pause, or audio cue or end. +10 s and +1 min advance time while
          the script waits for your input.
        </CollapsibleContent>
      </Collapsible>
      <div class="grid grid-cols-3 gap-2">
        <Button
          class="min-w-0"
          variant="outline"
          size="sm"
          data-development-time-action="skip"
          :disabled="!time.canSkip.value"
          @click="time.skip()"
        >
          Skip event
        </Button>
        <Button
          class="min-w-0"
          variant="outline"
          size="sm"
          data-development-time-action="advance-10s"
          :disabled="!time.canAdvance.value"
          @click="time.advanceBy(10_000)"
        >
          +10 s
        </Button>
        <Button
          class="min-w-0"
          variant="outline"
          size="sm"
          data-development-time-action="advance-1min"
          :disabled="!time.canAdvance.value"
          @click="time.advanceBy(60_000)"
        >
          +1 min
        </Button>
      </div>
    </section>
    <section aria-labelledby="debug-log" class="grid gap-2">
      <h3 id="debug-log" class="font-semibold">Debug log</h3>
      <ScrollArea
        class="h-32 rounded-md border"
        :viewport-attrs="{ tabindex: 0, role: 'region', 'aria-labelledby': 'debug-log' }"
      >
        <ol class="grid gap-0.5 p-2 font-mono text-muted-foreground" data-debug-log>
          <li v-for="line in log.lines.value" :key="line.id">{{ line.text }}</li>
          <li v-if="!log.lines.value.length">No entries yet.</li>
        </ol>
      </ScrollArea>
    </section>
  </div>
</template>

<style scoped>
.debug-explanation-trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  justify-self: start;
  border-radius: 0.25rem;
  font-weight: 500;
}
.debug-explanation-trigger > svg { transition: rotate 150ms ease; }
.debug-explanation-trigger[data-state="open"] > svg { rotate: 180deg; }
@media (prefers-reduced-motion: reduce) {
  .debug-explanation-trigger > svg { transition: none; }
}
</style>
