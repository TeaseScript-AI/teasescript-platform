<script setup lang="ts">
import { computed, ref } from "vue";
import type { CSSProperties } from "vue";
import type { PlayerPresentation, PlayerToolDefinition } from "../../model.js";
import PlayerComposer from "./components/PlayerComposer.vue";
import PlayerForeground from "./components/PlayerForeground.vue";
import PlayerMedia from "./components/PlayerMedia.vue";
import PlayerRightRail from "./components/PlayerRightRail.vue";
import PlayerTitleBar from "./components/PlayerTitleBar.vue";
import PlayerTools from "./components/PlayerTools.vue";
import PlayerTranscript from "./components/PlayerTranscript.vue";
import { usePlayerLayout } from "./composables/usePlayerLayout.js";
import { createPlayerCoreState, reducePlayerCoreState, type PlayerCoreAction } from "./state.js";

const props = defineProps<{
  presentation: PlayerPresentation;
  tools?: readonly PlayerToolDefinition[];
  toolLabel?: string;
}>();

const player = ref<HTMLElement | null>(null);
const toolDefinitions = computed<readonly PlayerToolDefinition[]>(() => {
  if (props.tools !== undefined) return props.tools;
  return props.toolLabel === undefined ? [] : [{ id: "scene", label: props.toolLabel }];
});
const state = ref(
  createPlayerCoreState(
    props.presentation,
    toolDefinitions.value.map((tool) => tool.id),
  ),
);
const layout = usePlayerLayout({ player });
const toolsAvailable = computed(() => toolDefinitions.value.length > 0);
const effectiveLeftMode = computed(() => (toolsAvailable.value ? layout.leftMode.value : "closed"));

const playerStyle = computed(
  () =>
    ({
      "--media-fit": props.presentation.media.fit,
      "--package-accent": props.presentation.package.accentColor,
      "--scene-ambient": props.presentation.media.ambientColor,
    }) as CSSProperties,
);

function dispatch(action: PlayerCoreAction): void {
  state.value = reducePlayerCoreState(state.value, action);
}

function closeToolColumn(id: string): void {
  const collapsesPanel = state.value.toolColumns.length === 1;
  dispatch({ type: "close-tool-column", id });
  if (collapsesPanel) layout.closeLeft();
}
</script>

<template>
  <main
    ref="player"
    class="player fx-ambient"
    :data-chrome="layout.chrome.value"
    :data-compact-timers="String(layout.compactTimers.value)"
    :data-keyboard="layout.keyboard.value"
    :data-keyboard-geometry="layout.keyboardGeometry.value"
    :data-left="effectiveLeftMode"
    :data-media-fit="presentation.media.fit"
    :data-right="layout.rightMode.value"
    :data-right-backing="layout.rightBacking.value"
    :data-right-layout="layout.rightLayout.value"
    data-timer-kind="visible"
    :style="playerStyle"
  >
    <PlayerTitleBar
      :compact-timers="layout.compactTimers.value"
      :fullscreen-active="layout.fullscreenActive.value"
      :left-open="toolsAvailable && layout.leftOpen.value"
      :right-docked="layout.rightDocked.value"
      :timer="presentation.timer"
      :tools-available="toolsAvailable"
      @toggle-fullscreen="layout.toggleFullscreen"
      @toggle-left="layout.toggleLeft"
      @toggle-right="layout.toggleRight"
    />

    <PlayerTools
      v-if="toolsAvailable"
      :columns="state.toolColumns"
      :open="layout.leftOpen.value"
      :tools="toolDefinitions"
      @add="dispatch({ type: 'add-tool-column' })"
      @close="closeToolColumn"
      @dismiss="layout.closeLeft"
      @select="(id, toolId) => dispatch({ type: 'select-tool-column', id, toolId })"
    >
      <template #tool="{ toolId }">
        <p v-if="toolId === null" class="tool-placeholder">Choose a tool for this column.</p>
        <slot v-else name="tool" :tool-id="toolId">
          <p class="tool-placeholder">No content is available for this tool.</p>
        </slot>
      </template>
    </PlayerTools>

    <PlayerMedia :media="presentation.media" />

    <PlayerTranscript :entries="state.transcriptEntries" :speakers="presentation.speakers" />

    <PlayerForeground
      :foreground="state.foreground"
      @activate="dispatch({ type: 'activate-foreground', label: $event })"
    />

    <PlayerComposer
      :feedback="state.composerFeedback"
      :foreground="state.foreground"
      :model-value="state.composerValue"
      @activate="dispatch({ type: 'activate-foreground', label: $event })"
      @input-blur="layout.markInputBlurred"
      @submit="dispatch({ type: 'submit-composer' })"
      @touch-input="layout.markTouchInputExpected"
      @update:model-value="dispatch({ type: 'set-composer', value: $event })"
    />

    <PlayerRightRail
      :compact-timers="layout.compactTimers.value"
      :controls="state.rightControls"
      :timer="presentation.timer"
      @action="dispatch({ type: 'activate-right-action', controlId: $event })"
      @select="(controlId, value) => dispatch({ type: 'change-right-select', controlId, value })"
      @toggle="
        (controlId, checked) => dispatch({ type: 'change-right-toggle', controlId, checked })
      "
    />
  </main>
</template>
