<script setup lang="ts">
import { ChevronDown, ChevronUp } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import Collapsible from "@/components/ui/collapsible/Collapsible.vue";
import CollapsibleContent from "@/components/ui/collapsible/CollapsibleContent.vue";
import CollapsibleTrigger from "@/components/ui/collapsible/CollapsibleTrigger.vue";
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
import Switch from "@/components/ui/switch/Switch.vue";
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
      <Collapsible v-slot="{ open }" class="grid gap-1">
        <div class="flex items-center justify-between gap-2">
          <CollapsibleTrigger as-child>
            <Button variant="ghost" size="xs" aria-label="About auto-skip">
              Auto-skip
              <component :is="open ? ChevronUp : ChevronDown" aria-hidden="true" />
            </Button>
          </CollapsibleTrigger>
          <Switch v-model="time.autoSkip.value" aria-label="Auto-skip" />
        </div>
        <CollapsibleContent class="text-muted-foreground">
          Waits, timers and pacing pauses complete at once; while the script waits for your input, time runs normally.
        </CollapsibleContent>
      </Collapsible>
      <Collapsible v-slot="{ open }" class="grid gap-1">
        <CollapsibleTrigger as-child>
          <Button variant="ghost" size="xs" class="justify-self-start" aria-label="About time jumps">
            Jumps
            <component :is="open ? ChevronUp : ChevronDown" aria-hidden="true" />
          </Button>
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
      <div class="h-32 rounded-md border">
        <ScrollArea
          class="size-full"
          :viewport-attrs="{ tabindex: 0, role: 'region', 'aria-labelledby': 'debug-log' }"
        >
          <ol class="grid gap-0.5 p-2 font-mono text-muted-foreground" data-debug-log>
            <li v-for="line in log.lines.value" :key="line.id">{{ line.text }}</li>
            <li v-if="!log.lines.value.length">No entries yet.</li>
          </ol>
        </ScrollArea>
      </div>
    </section>
  </div>
</template>
