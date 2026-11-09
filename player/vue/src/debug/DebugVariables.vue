<script setup lang="ts">
import { computed, nextTick, reactive, ref, shallowRef, watch } from "vue";
import { ChevronDown, ChevronUp } from "@lucide/vue";
import Collapsible from "@/components/ui/collapsible/Collapsible.vue";
import CollapsibleContent from "@/components/ui/collapsible/CollapsibleContent.vue";
import CollapsibleTrigger from "@/components/ui/collapsible/CollapsibleTrigger.vue";
import { Input } from "@/components/ui/input";
import { debugVariableTree, PLAYER_DEBUG_TRACE_PAGE } from "../../../debug-variables.js";
import type { DebugTreeState } from "../../../debug-view.js";
import { playerRuntimeTranscriptMessage } from "../../../runtime-view.js";
import { useDebugView } from "./useDebugView";
import DebugTraceRows from "./DebugTraceRows.vue";
import type { PlayerDebugExplained } from "./usePlayerDebug";
import type { PlayerSessionHost } from "../session/usePlayerSession";

// Debug's Variables view (DEBUGGER.md "Player Debug"): why values have their values, from the session's value trace.
// A message chosen with Explain values comes first and stays until another is chosen; then recent chat messages, newest
// first, each with the values it shows and their immediate causes; every live variable is under the collapsed
// background section. Nothing here is computed while the tab is not shown.
const props = defineProps<{
  player: PlayerSessionHost;
  /** Whether the tab is shown; while hidden it keeps its state and computes nothing. */
  active: boolean;
  /** The message Explain values selected, or `null`. */
  explained: PlayerDebugExplained | null;
}>();

// The session the view shows: the published one while the tab is shown, else the last one shown.
const session = shallowRef(props.player.session.value);
watch(
  () => (props.active ? props.player.session.value : session.value),
  (shown) => (session.value = shown),
);

const outputPages = ref(1);
// The newest message stays open by default until the player opens or closes one.
const chose = ref(false);
// The selected message, while its trace and epoch last; "Back to recent chat" dismisses it.
const dismissed = ref(0);
const background = ref(false);
const filter = ref("");
const groupPages = reactive(new Map<string, number>());
// Each derivation tree's state, by its key (`recent`, `selected`, `debugVariableTree`): the player's open rows and pages.
const trees = reactive(new Map<string, DebugTreeState>());
const NO_STATE: DebugTreeState = Object.freeze({ choices: {}, pages: {} });
const stateOf = (key: string) => trees.get(key) ?? NO_STATE;
const setState = (key: string, state: DebugTreeState) => trees.set(key, state);

// The message Explain values selected, found by the entry's identity: the content it shows now, and its text when the
// trace has no record of that.
const explaining = computed(() => {
  const explained = props.explained;
  if (explained === null || explained.traceId !== props.player.traceId.value) return null;
  if (explained.request === dismissed.value) return null;
  const entry =
    session.value === null
      ? null
      : playerRuntimeTranscriptMessage(session.value, explained.entryId);
  return {
    request: explained.request,
    sequence: entry?.contentSequence ?? explained.sequence,
    epoch: explained.epoch,
    text: entry?.text ?? null,
  };
});
// A newly selected message opens with its own tree.
watch(
  () => explaining.value?.request,
  () => trees.delete("selected"),
);

// What the tab shows, made by the host from the session and its trace (`debugView`), from the view's state; nothing
// is asked while the tab is not shown, which keeps its last view.
const view = useDebugView(props.player, () =>
  !props.active
    ? null
    : {
        messages: { limit: PLAYER_DEBUG_TRACE_PAGE * outputPages.value, openNewest: !chose.value },
        selected:
          explaining.value === null
            ? null
            : { sequence: explaining.value.sequence, epoch: explaining.value.epoch },
        variables: background.value
          ? { filter: filter.value, pages: Object.fromEntries(groupPages) }
          : null,
        image: false,
        trees: Object.fromEntries(trees),
      },
);
const outputs = computed(() => view.value?.messages ?? null);
// The newest message, open by default: the first root of recent chat.
const newest = computed(() => {
  const first = chose.value ? undefined : outputs.value?.rows.find((row) => row.depth === 0);
  return first !== undefined && "id" in first ? first.id : null;
});
const selected = computed(() => {
  const asked = explaining.value;
  const shown = view.value?.selected ?? null;
  return asked === null || shown === null
    ? null
    : { ...shown, request: asked.request, text: asked.text };
});
const selectedSection = ref<HTMLElement | null>(null);
watch(
  () => selected.value?.request,
  async (request) => {
    if (request === undefined) return;
    await nextTick();
    selectedSection.value?.scrollIntoView({ block: "nearest" });
    selectedSection.value?.focus({ preventScroll: true });
  },
  { immediate: true, flush: "post" },
);

const status = computed(() => view.value?.status ?? null);
const origins = {
  start: "Recording since Start",
  restore: "Recording since Continue",
  attach: "Recording since Debug was turned on",
} as const;

const groups = computed(() => (background.value ? (view.value?.variables ?? []) : []));
const shown = (key: string) => PLAYER_DEBUG_TRACE_PAGE * (groupPages.get(key) ?? 1);
</script>

<template>
  <div class="grid gap-3" data-debug-variables>
    <p v-if="!player.debugTracing.value" class="text-muted-foreground">Debug is off.</p>
    <!-- Until the host's first view arrives, one reply after the tab shows, it shows nothing. -->
    <template v-else-if="status">
      <div class="flex min-w-0 flex-wrap items-center gap-2" data-debug-trace-status>
        <span class="text-muted-foreground">{{ origins[status.origin] }}</span>
        <!-- Tags and actions are plain elements that wrap in the narrowest panel. -->
        <span
          v-if="status.truncated"
          class="inline-block max-w-full rounded-md border px-1.5 py-0.5 text-xs font-medium wrap-anywhere"
          data-debug-trace-truncated
        >
          Earlier history unavailable
        </span>
        <span
          v-if="!status.recording"
          class="inline-block max-w-full rounded-md border px-1.5 py-0.5 text-xs font-medium wrap-anywhere text-destructive"
          >Recording stopped</span
        >
        <span v-if="!status.recording" class="min-w-0 text-muted-foreground wrap-anywhere">{{
          status.failure
        }}</span>
      </div>

      <section
        v-if="selected"
        ref="selectedSection"
        tabindex="-1"
        aria-labelledby="debug-variables-selected"
        class="grid gap-1 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        data-debug-selected-message
      >
        <div class="flex min-w-0 flex-wrap items-center justify-between gap-x-2">
          <h3 id="debug-variables-selected" class="font-semibold">Selected message</h3>
          <button
            type="button"
            class="min-h-11 max-w-full rounded-md px-2 text-start text-sm font-medium wrap-anywhere hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            data-debug-selected-dismiss
            @click="dismissed = selected.request"
          >
            Back to recent chat
          </button>
        </div>
        <DebugTraceRows
          v-if="selected.origin.kind === 'record' && selected.rows"
          :key="selected.request"
          :rows="selected.rows"
          :state="stateOf('selected')"
          :default-open="selected.origin.id"
          label="The selected message and its values"
          @update:state="setState('selected', $event)"
        />
        <div
          v-else-if="selected.origin.kind === 'unavailable'"
          class="flex min-w-0 flex-wrap items-baseline gap-2 py-2 ps-12"
          data-debug-selected-unavailable
        >
          <span class="min-w-0 font-medium wrap-anywhere">Message</span>
          <code v-if="selected.text !== null" class="min-w-0 break-all">{{ selected.text }}</code>
          <span
            class="inline-block max-w-full rounded-md border px-1.5 py-0.5 text-xs font-medium wrap-anywhere"
            >Unavailable</span
          >
          <span class="min-w-0 text-muted-foreground wrap-anywhere">{{
            selected.origin.reason
          }}</span>
        </div>
      </section>

      <section aria-labelledby="debug-variables-chat" class="grid gap-1">
        <h3 id="debug-variables-chat" class="font-semibold">Recent chat</h3>
        <p v-if="!outputs?.count" class="text-muted-foreground">No messages recorded yet.</p>
        <DebugTraceRows
          v-else
          :rows="outputs.rows"
          :state="stateOf('recent')"
          :default-open="newest"
          label="Recent chat messages and their values"
          @chose="chose = true"
          @update:state="setState('recent', $event)"
        />
        <button
          v-if="outputs?.count === PLAYER_DEBUG_TRACE_PAGE * outputPages"
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
          <component
            :is="open ? ChevronUp : ChevronDown"
            class="size-4 shrink-0"
            aria-hidden="true"
          />
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
                v-for="variable in group.variables"
                :key="`${variable.scope}:${variable.name}`"
                class="min-w-0"
                data-debug-variable
              >
                <DebugTraceRows
                  v-if="variable.rows !== null"
                  :rows="variable.rows"
                  :state="stateOf(debugVariableTree(variable))"
                  :label="`Origin of ${variable.name}`"
                  @update:state="setState(debugVariableTree(variable), $event)"
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
              v-if="group.total > shown(group.key)"
              type="button"
              class="min-h-11 max-w-full justify-self-start rounded-md px-2 text-start text-sm font-medium wrap-anywhere hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              @click="groupPages.set(group.key, (groupPages.get(group.key) ?? 1) + 1)"
            >
              Show
              {{ Math.min(group.total - shown(group.key), PLAYER_DEBUG_TRACE_PAGE) }}
              more
            </button>
          </section>
        </CollapsibleContent>
      </Collapsible>
    </template>
  </div>
</template>
