<script setup lang="ts">
import { ChevronDown, ChevronUp } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import Collapsible from "@/components/ui/collapsible/Collapsible.vue";
import CollapsibleContent from "@/components/ui/collapsible/CollapsibleContent.vue";
import CollapsibleTrigger from "@/components/ui/collapsible/CollapsibleTrigger.vue";
import ScrollArea from "@/components/ui/scroll-area/ScrollArea.vue";
import Switch from "@/components/ui/switch/Switch.vue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DebugNow from "./DebugNow.vue";
import type { DebugLog } from "./useDebugLog";
import type { DevelopmentTime } from "./useDevelopmentTime";
import type { PlayerSessionHost } from "./usePlayerSession";

// The Debug panel (DEBUGGER.md "Player Debug"): its Debug switch and, while Debug is on, the time controls (#615) above
// the tabs: Now, the Debug log, newest line first, and the saved-data tools when a host supplies them. An explanation
// opens from its label, by click, tap or keyboard; any number may be open.
defineProps<{
  time: DevelopmentTime | null;
  log: DebugLog;
  player: PlayerSessionHost;
  /** Whether the camera view covers the Stage image. */
  stageCovered: boolean;
  /** Whether the development preview shows a Stage media fixture instead of the session's image. */
  stageOverridden: boolean;
}>();
const active = defineModel<boolean>("active", { required: true });
</script>

<template>
  <div class="grid gap-4 p-4 text-xs" data-debug-panel>
    <Collapsible v-slot="{ open }" class="grid gap-1">
      <div class="flex min-h-9 items-center justify-between gap-2">
        <CollapsibleTrigger as-child>
          <Button variant="ghost" size="xs" aria-label="About Debug">
            Debug
            <component :is="open ? ChevronUp : ChevronDown" aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
        <Switch v-model="active" aria-label="Debug" data-debug-active />
      </div>
      <CollapsibleContent class="text-muted-foreground">
        Countdowns and time controls for testing this script. Turn Debug off to play normally for a while; Debug menu
        in Settings removes this panel.
      </CollapsibleContent>
    </Collapsible>
    <section v-if="time" aria-labelledby="debug-time" class="grid gap-2">
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
    <Tabs default-value="now">
      <TabsList class="h-auto w-full">
        <TabsTrigger value="now" class="min-h-11">Now</TabsTrigger>
        <TabsTrigger value="log" class="min-h-11">Log</TabsTrigger>
        <TabsTrigger v-if="$slots.storage" value="storage" class="min-h-11">Storage</TabsTrigger>
      </TabsList>
      <TabsContent value="now">
        <DebugNow
          v-if="time"
          :player="player"
          :stage-covered="stageCovered"
          :stage-overridden="stageOverridden"
        />
        <p v-else class="text-muted-foreground">Debug is off.</p>
      </TabsContent>
      <!-- Kept mounted, so new lines arrive while another tab shows. -->
      <TabsContent value="log" force-mount class="data-[state=inactive]:hidden">
        <section aria-labelledby="debug-log" class="grid gap-2">
          <h3 id="debug-log" class="font-semibold">Debug log</h3>
          <div class="h-64 rounded-md border">
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
      </TabsContent>
      <!-- Reserved for the saved-data overview and editor, which a host supplies. -->
      <TabsContent v-if="$slots.storage" value="storage">
        <slot name="storage" />
      </TabsContent>
    </Tabs>
  </div>
</template>
