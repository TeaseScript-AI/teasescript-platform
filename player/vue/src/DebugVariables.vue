<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from "vue";
import { ChevronDown, ChevronUp } from "@lucide/vue";
import Collapsible from "@/components/ui/collapsible/Collapsible.vue";
import CollapsibleContent from "@/components/ui/collapsible/CollapsibleContent.vue";
import CollapsibleTrigger from "@/components/ui/collapsible/CollapsibleTrigger.vue";
import { Input } from "@/components/ui/input";
import {
  PLAYER_DEBUG_TRACE_PAGE,
  playerDebugLiveValue,
  playerDebugVariables,
} from "../../debug-variables.js";
import DebugTraceRows from "./DebugTraceRows.vue";
import type { PlayerSessionHost } from "./usePlayerSession";

// Debug's Variables view (DEBUGGER.md "Player Debug"): why values have their values, from the session's value trace.
// Recent chat messages come first, newest first, each with the values it shows and their immediate causes; every live
// variable is under the collapsed background section. Nothing here is computed while the tab is not shown.
const props = defineProps<{
  player: PlayerSessionHost;
  /** Whether the tab is shown; while hidden it keeps its state and computes nothing. */
  active: boolean;
}>();

const trace = computed(() => props.player.debugTrace.value);
// The session the view shows: the published one while the tab is shown, else the last one shown.
const session = shallowRef(props.player.session.value);
watch(
  () => (props.active ? props.player.session.value : session.value),
  (shown) => (session.value = shown),
);
const live = computed(() =>
  session.value === null ? null : playerDebugLiveValue(session.value.snapshot),
);

const outputPages = ref(1);
const outputs = computed(() => {
  void session.value;
  return trace.value?.outputs(PLAYER_DEBUG_TRACE_PAGE * outputPages.value) ?? [];
});
// The newest message stays open by default until the player opens or closes one.
const chose = ref(false);
const defaultOpen = computed(() => (chose.value ? null : (outputs.value[0] ?? null)));

const status = computed(() => {
  void session.value;
  return trace.value?.status() ?? null;
});
const origins = {
  start: "Recording since Start",
  restore: "Recording since Continue",
  attach: "Recording since Debug was turned on",
} as const;

const background = ref(false);
const filter = ref("");
const groupPages = reactive(new Map<string, number>());
const groups = computed(() => {
  if (!background.value || session.value === null) return [];
  return playerDebugVariables(
    session.value.plan,
    session.value.snapshot,
    trace.value,
    filter.value,
  );
});
const shown = (key: string) => PLAYER_DEBUG_TRACE_PAGE * (groupPages.get(key) ?? 1);
</script>

<template>
  <div class="grid gap-3" data-debug-variables>
    <p v-if="!trace || !status" class="text-muted-foreground">Debug is off.</p>
    <template v-else>
      <div class="flex min-w-0 flex-wrap items-center gap-2" data-debug-trace-status>
        <span class="text-muted-foreground">{{ origins[status.origin] }}</span>
        <!-- Tags and actions are plain elements that wrap in the narrowest panel. -->
        <span v-if="status.truncated" class="inline-block max-w-full rounded-md border px-1.5 py-0.5 text-xs font-medium wrap-anywhere" data-debug-trace-truncated>
          Earlier history unavailable
        </span>
        <span v-if="!status.recording" class="inline-block max-w-full rounded-md border px-1.5 py-0.5 text-xs font-medium wrap-anywhere text-destructive">Recording stopped</span>
        <span v-if="!status.recording" class="min-w-0 text-muted-foreground wrap-anywhere">{{
          status.failure
        }}</span>
      </div>

      <section aria-labelledby="debug-variables-chat" class="grid gap-1">
        <h3 id="debug-variables-chat" class="font-semibold">Recent chat</h3>
        <p v-if="!outputs.length" class="text-muted-foreground">No messages recorded yet.</p>
        <DebugTraceRows
          v-else
          :trace="trace"
          :roots="outputs"
          :revision="session"
          :live="live"
          :default-open="defaultOpen"
          label="Recent chat messages and their values"
          @chose="chose = true"
        />
        <button
          v-if="outputs.length === PLAYER_DEBUG_TRACE_PAGE * outputPages"
          type="button"
          class="min-h-11 max-w-full justify-self-start rounded-md px-2 text-start text-sm font-medium wrap-anywhere hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-debug-more-messages
          @click="outputPages++"
        >
          Show {{ PLAYER_DEBUG_TRACE_PAGE }} older messages
        </button>
      </section>

      <Collapsible v-model:open="background" v-slot="{ open }" class="grid gap-2">
        <!-- A full-row trigger whose label wraps in the narrowest dock. -->
        <CollapsibleTrigger
          class="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2 text-start text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-debug-background-toggle
        >
          <span class="min-w-0 wrap-anywhere">Background / all live variables</span>
          <component :is="open ? ChevronUp : ChevronDown" class="size-4 shrink-0" aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent class="grid gap-3">
          <Input
            v-model="filter"
            class="min-h-11"
            type="search"
            placeholder="Filter by name"
            aria-label="Filter variables by name"
            data-debug-variable-filter
          />
          <p v-if="!groups.length" class="text-muted-foreground">
            {{ filter ? "No variable has that name." : "No variables yet." }}
          </p>
          <section
            v-for="group in groups"
            :key="group.key"
            class="grid gap-1"
            :aria-label="group.label"
            data-debug-variable-group
          >
            <h4 class="break-all font-semibold">{{ group.label }}</h4>
            <ul class="grid gap-1">
              <li
                v-for="variable in group.variables.slice(0, shown(group.key))"
                :key="`${variable.scope}:${variable.name}`"
                class="min-w-0"
                data-debug-variable
              >
                <DebugTraceRows
                  v-if="variable.record !== null"
                  :trace="trace"
                  :roots="[variable.record]"
                  :revision="session"
                  :live="live"
                  :label="`Origin of ${variable.name}`"
                />
                <div v-else class="flex min-w-0 flex-wrap items-baseline gap-2 py-2 ps-12">
                  <span class="min-w-0 font-medium wrap-anywhere">{{ variable.name }}</span>
                  <code class="min-w-0 break-all"
                    >{{ variable.value }}{{ variable.truncated ? "…" : "" }}</code
                  >
                  <span
                    class="inline-block max-w-full rounded-md border px-1.5 py-0.5 text-xs font-medium wrap-anywhere"
                    >No recorded origin</span
                  >
                </div>
              </li>
            </ul>
            <button
              v-if="group.variables.length > shown(group.key)"
              type="button"
              class="min-h-11 max-w-full justify-self-start rounded-md px-2 text-start text-sm font-medium wrap-anywhere hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              @click="groupPages.set(group.key, (groupPages.get(group.key) ?? 1) + 1)"
            >
              Show
              {{
                Math.min(group.variables.length - shown(group.key), PLAYER_DEBUG_TRACE_PAGE)
              }}
              more
            </button>
          </section>
        </CollapsibleContent>
      </Collapsible>
    </template>
  </div>
</template>
