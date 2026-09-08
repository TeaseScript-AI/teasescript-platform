<script setup lang="ts">
import { computed } from "vue";
import {
  LAYOUT_DEBUG_OPTION_LABELS,
  setLayoutDebugOption,
  type LayoutDebugOption,
  type LayoutDebugOptions,
} from "./layoutDebug.js";
import {
  formatPixels,
  formatRect,
  formatScroll,
  type LayoutDebugSnapshot,
} from "./layoutDebugMeasurement.js";

const props = defineProps<{ options: LayoutDebugOptions; snapshot?: LayoutDebugSnapshot | null }>();

const emit = defineEmits<{ "update:options": [options: LayoutDebugOptions] }>();

const layerOptions = Object.entries(LAYOUT_DEBUG_OPTION_LABELS) as [
  Exclude<LayoutDebugOption, "enabled">,
  string,
][];
const viewportReadout = computed(() => {
  const viewport = props.snapshot?.viewport;
  return viewport === undefined
    ? "Waiting for Player…"
    : `${formatPixels(viewport.visualWidth)} × ${formatPixels(viewport.visualHeight)} @ ${formatPixels(viewport.offsetLeft)}, ${formatPixels(viewport.offsetTop)} (${String(viewport.scale)}×)`;
});

function update(option: LayoutDebugOption, event: Event): void {
  const checked = (event.currentTarget as HTMLInputElement).checked;
  emit("update:options", setLayoutDebugOption(props.options, option, checked));
}
</script>

<template>
  <section class="layout-debug-tool" aria-label="Layout Debug controls">
    <label class="layout-debug-master">
      <span>Layout Debug</span>
      <input
        type="checkbox"
        :checked="options.enabled"
        data-layout-debug-master
        @change="update('enabled', $event)"
      />
    </label>

    <fieldset>
      <legend>Layers and readouts</legend>
      <label v-for="[option, label] in layerOptions" :key="option">
        <span>{{ label }}</span>
        <input
          type="checkbox"
          :checked="options[option]"
          :data-layout-debug-option="option"
          @change="update(option, $event)"
        />
      </label>
    </fieldset>

    <dl class="layout-debug-readout">
      <dt>Visual viewport</dt>
      <dd>{{ viewportReadout }}</dd>
      <dt>Composition</dt>
      <dd>
        {{ snapshot?.composition.chrome ?? "unset" }} ·
        {{ snapshot?.composition.conversation ?? "unset" }} ·
        {{ snapshot?.composition.tools ?? "unset" }} ·
        {{ snapshot?.composition.rightLayout ?? "unset" }} ·
        {{ snapshot?.composition.keyboard ?? "unset" }}
      </dd>
      <dt>Player</dt>
      <dd>{{ formatRect(snapshot?.regions.player) }}</dd>
      <dt>Stage</dt>
      <dd>{{ formatRect(snapshot?.regions.stage) }}</dd>
      <dt>Transcript scroll</dt>
      <dd>{{ formatScroll(snapshot?.scroll.transcript) }}</dd>
      <dt>Tools scroll</dt>
      <dd>{{ formatScroll(snapshot?.scroll["tool-strip"]) }}</dd>
    </dl>
  </section>
</template>

<style scoped>
.layout-debug-tool {
  display: grid;
  gap: 10px;
  padding: 10px;
  color: var(--color-text-primary);
  font-size: 11px;
}

.layout-debug-master,
fieldset label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.layout-debug-master {
  font-weight: 700;
}

fieldset {
  display: grid;
  gap: 6px;
  min-width: 0;
  margin: 0;
  padding: 8px;
  border: 1px solid var(--color-border-default);
}

legend {
  padding-inline: 4px;
  color: var(--color-text-muted);
  font-size: 9px;
  font-weight: 700;
}

.layout-debug-readout {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 4px 8px;
  margin: 0;
  font-size: 9px;
}

.layout-debug-readout dt {
  color: var(--color-text-muted);
}

.layout-debug-readout dd {
  min-width: 0;
  margin: 0;
  font-family: ui-monospace, "DejaVu Sans Mono", Consolas, monospace;
  overflow-wrap: anywhere;
}
</style>
