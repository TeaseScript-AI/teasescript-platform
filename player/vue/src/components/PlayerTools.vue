<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { PlayerToolColumnState, PlayerToolDefinition, PlayerToolId } from "../../../model.js";
import type { LayoutDebugSnapshot } from "../devtools/layoutDebugMeasurement.js";

const props = defineProps<{
  open: boolean;
  columns: readonly PlayerToolColumnState[];
  tools: readonly PlayerToolDefinition[];
  layoutDebugSnapshot?: LayoutDebugSnapshot | null;
}>();

const emit = defineEmits<{
  add: [];
  close: [id: string];
  dismiss: [];
  select: [id: string, toolId: PlayerToolId];
}>();

const stripScroll = ref<HTMLElement | null>(null);
const overflow = ref(false);
let resizeObserver: ResizeObserver | null = null;

watch(
  () => [props.columns, props.tools] as const,
  async () => {
    await nextTick();
    observeOverflow();
  },
  { deep: true },
);

onMounted(observeOverflow);
onBeforeUnmount(() => resizeObserver?.disconnect());

function observeOverflow(): void {
  resizeObserver?.disconnect();
  const scroller = stripScroll.value;
  const strip = scroller?.querySelector<HTMLElement>(".tool-strip") ?? null;
  if (scroller === null || strip === null) {
    overflow.value = false;
    return;
  }

  resizeObserver = new ResizeObserver(syncOverflow);
  resizeObserver.observe(scroller);
  resizeObserver.observe(strip);
  syncOverflow();
}

function syncOverflow(): void {
  const scroller = stripScroll.value;
  overflow.value =
    scroller !== null &&
    scroller.clientWidth > 0 &&
    scroller.scrollWidth > scroller.clientWidth + 1;
}

function selectTool(columnId: string, event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  const tool = props.tools.find((candidate) => candidate.id === value);
  if (tool === undefined) return;
  emit("select", columnId, tool.id);
}
</script>

<template>
  <aside id="leftPanel" class="left-panel" aria-label="Player tools">
    <div ref="stripScroll" class="tool-strip-scroll" :data-overflow="String(overflow)">
      <div class="tool-strip">
        <section
          v-for="column in columns"
          :key="column.id"
          class="tool-column"
          :data-tool-column-id="column.id"
          :data-tool-id="column.toolId ?? undefined"
        >
          <header class="tool-column-header">
            <select
              class="tool-selector"
              data-tool-column-select
              aria-label="Tool shown in this column"
              :value="column.toolId ?? ''"
              @change="selectTool(column.id, $event)"
            >
              <option value="" disabled>Choose tool…</option>
              <option v-for="tool in tools" :key="tool.id" :value="tool.id">
                {{ tool.label }}
              </option>
            </select>
            <button
              class="tool-column-add"
              data-tool-column-add
              type="button"
              aria-label="Add tool column"
              title="Add tool column"
              @click="emit('add')"
            >
              +
            </button>
            <button
              class="tool-column-close"
              data-tool-column-close
              type="button"
              aria-label="Close tool column"
              title="Close tool column"
              @click="emit('close', column.id)"
            >
              ×
            </button>
          </header>
          <div class="tool-column-body" :data-tool-body="column.toolId ?? ''">
            <slot
              name="tool"
              :layout-debug-snapshot="layoutDebugSnapshot"
              :tool-id="column.toolId"
            >
              <p class="tool-placeholder">
                {{
                  column.toolId === null
                    ? "Choose a tool for this column."
                    : "No content is available for this tool."
                }}
              </p>
            </slot>
          </div>
        </section>
      </div>
    </div>
  </aside>

  <button
    v-if="open"
    class="left-scrim"
    type="button"
    aria-label="Close tools"
    @click="$emit('dismiss')"
  ></button>
</template>
