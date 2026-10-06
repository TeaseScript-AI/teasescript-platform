<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { ArrowUp, ChevronDown, ChevronRight } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RuntimeDebugContext } from "../../../src/index.js";
import {
  playerDebugTraceRows,
  type PlayerDebugLiveValue,
  type PlayerDebugTraceRow,
} from "../../debug-variables.js";

// Rows of Debug's derivation trees (DEBUGGER.md "Player Debug"): each root with its immediate causes, and further levels
// as the player opens them, one row at a time. A record shown again in the same tree is a link to its first row.
const props = defineProps<{
  trace: RuntimeDebugContext;
  roots: readonly number[];
  /** Changes whenever the trace may have new records: the published session. */
  revision: unknown;
  live: PlayerDebugLiveValue | null;
  /** The root open by default until the player opens or closes a root, or `null`. */
  defaultOpen?: number | null;
  /** A label for the list, for assistive technology. */
  label: string;
}>();
const emit = defineEmits<{ chose: [] }>();

const choices = reactive(new Map<string, boolean>());
const pages = reactive(new Map<string, number>());
const fullValues = reactive(new Set<string>());
const list = ref<HTMLElement | null>(null);

const rows = computed(() => {
  void props.revision;
  return playerDebugTraceRows(
    props.trace,
    props.roots,
    {
      // Messages show their values; a value's own causes open on request.
      expanded: (key, record, depth) =>
        choices.get(key) ??
        (depth === 0 ? record.id === props.defaultOpen : record.kind === "interpolation"),
      pages: (key) => pages.get(key) ?? 1,
    },
    props.live,
  );
});

function toggle(row: Extract<PlayerDebugTraceRow, { kind: "record" }>) {
  // The first choice keeps the default-open root open, so opening another message does not close it.
  if (props.defaultOpen !== null && props.defaultOpen !== undefined) {
    const key = String(props.defaultOpen);
    if (!choices.has(key)) choices.set(key, true);
  }
  choices.set(row.key, !row.expanded);
  if (row.depth === 0) emit("chose");
}

function showMore(row: Extract<PlayerDebugTraceRow, { kind: "more" }>) {
  pages.set(row.parent, (pages.get(row.parent) ?? 1) + 1);
}

/** Moves focus to the row a reference names. */
function reveal(target: string) {
  const row = list.value?.querySelector<HTMLElement>(`[data-trace-row="${CSS.escape(target)}"]`);
  row?.scrollIntoView({ block: "nearest" });
  row?.focus();
}

const LONG_VALUE = 120;
const indent = (depth: number) => ({ paddingInlineStart: `${Math.min(depth, 6) * 0.75}rem` });
</script>

<template>
  <ul ref="list" class="grid gap-0.5" :aria-label="label" data-debug-trace>
    <li
      v-for="row in rows"
      :key="row.key"
      :style="indent(row.depth)"
      :data-trace-depth="row.depth"
      class="min-w-0"
    >
      <template v-if="row.kind === 'record' || row.kind === 'reference'">
        <div
          :data-trace-row="row.key"
          :data-trace-kind="row.kind"
          tabindex="-1"
          class="flex min-w-0 items-start gap-1 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Button
            v-if="row.kind === 'record' && row.expandable"
            variant="ghost"
            size="icon"
            class="size-11 shrink-0"
            :aria-expanded="row.expanded"
            :aria-label="`${row.expanded ? 'Hide' : 'Show'} causes of ${row.text.title}`"
            data-trace-toggle
            @click="toggle(row)"
          >
            <component :is="row.expanded ? ChevronDown : ChevronRight" aria-hidden="true" />
          </Button>
          <Button
            v-else-if="row.kind === 'reference'"
            variant="ghost"
            size="icon"
            class="size-11 shrink-0"
            :aria-label="`Go to the first ${row.text.title}`"
            data-trace-reference
            @click="reveal(row.target)"
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <span v-else class="size-11 shrink-0" aria-hidden="true" />
          <div class="grid min-w-0 flex-1 gap-0.5 py-2">
            <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <!-- Every part wraps anywhere: names, statements and notes may be one long word. -->
              <span class="min-w-0 font-medium wrap-anywhere">{{ row.text.title }}</span>
              <Badge v-if="row.text.unknown" variant="outline" data-trace-unknown>Unknown origin</Badge>
              <span v-if="row.text.note" class="min-w-0 text-muted-foreground wrap-anywhere">{{
                row.text.note
              }}</span>
              <span
                v-if="row.text.location"
                class="min-w-0 font-mono text-muted-foreground wrap-anywhere"
              >
                {{ row.text.location }}
              </span>
            </div>
            <template v-if="row.text.value !== null">
              <code
                class="block min-w-0 break-all whitespace-pre-wrap"
                :class="fullValues.has(row.key) ? '' : 'line-clamp-3'"
                data-trace-value
                >{{ row.text.value }}{{ row.text.truncated ? "…" : "" }}</code
              >
              <Button
                v-if="row.text.value.length > LONG_VALUE"
                variant="ghost"
                size="sm"
                class="min-h-11 justify-self-start"
                :aria-expanded="fullValues.has(row.key)"
                @click="
                  fullValues.has(row.key) ? fullValues.delete(row.key) : fullValues.add(row.key)
                "
              >
                {{ fullValues.has(row.key) ? "Show less" : "Show all" }}
              </Button>
            </template>
            <span
              v-if="row.text.shownAs !== null"
              class="break-all text-muted-foreground"
              data-trace-shown
            >
              Shown as <code>{{ row.text.shownAs }}</code>
            </span>
            <span
              v-if="row.text.now !== null"
              class="break-all text-muted-foreground"
              data-trace-now
            >
              Now: <code>{{ row.text.now }}</code>
            </span>
            <span v-if="row.kind === 'reference'" class="text-muted-foreground wrap-anywhere">
              Same as above
            </span>
          </div>
        </div>
      </template>
      <div
        v-else-if="row.kind === 'expired'"
        class="flex min-h-11 items-center gap-2 ps-12"
        data-trace-expired
      >
        <Badge variant="outline">Expired</Badge>
        <span class="min-w-0 text-muted-foreground wrap-anywhere">Older history was dropped</span>
      </div>
      <p
        v-else-if="row.kind === 'omitted'"
        class="flex min-h-11 items-center ps-12 text-muted-foreground wrap-anywhere"
      >
        {{ row.count }} more {{ row.count === 1 ? "cause was" : "causes were" }} not kept
      </p>
      <Button
        v-else
        variant="ghost"
        size="sm"
        class="ms-12 min-h-11"
        data-trace-more
        @click="showMore(row)"
      >
        Show {{ Math.min(row.remaining, 20) }} more
      </Button>
    </li>
  </ul>
</template>
