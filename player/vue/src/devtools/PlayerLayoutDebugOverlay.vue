<script setup lang="ts">
import { computed, toRef, type CSSProperties } from "vue";
import type { LayoutDebugOptions } from "./layoutDebug.js";
import {
  buildDiagnosticCardLines,
  formatPixels,
  type LayoutRect,
  type LayoutDebugSnapshot,
} from "./layoutDebugMeasurement.js";

const props = defineProps<{ options: LayoutDebugOptions; snapshot: LayoutDebugSnapshot | null }>();
const snapshot = toRef(props, "snapshot");
const rootRect = computed(() => snapshot.value?.regions.player);
const regionBoxes = computed(() => {
  const current = snapshot.value;
  if (current === null) return [];
  const boxes: { readonly name: string; readonly rect: LayoutRect }[] = [];
  for (const name of [
    "title",
    "tools",
    "stage",
    "transcript",
    "foreground",
    "composer",
    "right",
  ] as const) {
    const rect = current.regions[name];
    if (rect !== undefined) boxes.push({ name, rect });
  }
  return boxes;
});
const overflowBoxes = computed(() => {
  const current = snapshot.value;
  if (current === null) return [];
  return Object.entries(current.scroll)
    .filter(([, metrics]) => metrics.overflowX > 0 || metrics.overflowY > 0)
    .flatMap(([name, metrics]) => {
      const rect = current.scrollRects[name];
      return rect === undefined ? [] : [{ name, metrics, rect }];
    });
});
const cardLines = computed(() =>
  snapshot.value === null ? [] : buildDiagnosticCardLines(snapshot.value),
);
const constraintLines = computed(() => {
  const current = snapshot.value;
  if (current === null) return [];
  return [
    `stage ${formatPixels(current.regions.stage?.height ?? 0)} / ${current.constraints.mediaHeight}`,
    `conversation ${formatPixels(current.regions.transcript?.width ?? 0)} / ${current.constraints.conversationMinWidth}…${current.constraints.conversationMaxWidth}`,
    `tool column ${formatPixels(current.regions.toolColumn?.width ?? 0)} / ${current.constraints.toolColumnWidth}`,
    `right ${formatPixels(current.regions.right?.width ?? 0)} / ${current.constraints.rightRailWidth}`,
    `composer input ${formatPixels(current.regions.input?.height ?? 0)} / ${current.constraints.composerMaxLines}, ${current.constraints.composerMaxViewportHeight}`,
    `usable height ${current.constraints.usableHeight}`,
  ];
});
const viewportStyle = computed<CSSProperties | undefined>(() => {
  const current = snapshot.value;
  if (current === null) return undefined;
  return {
    left: `${current.viewport.offsetLeft - (rootRect.value?.left ?? 0)}px`,
    top: `${current.viewport.offsetTop - (rootRect.value?.top ?? 0)}px`,
    width: `${current.viewport.visualWidth}px`,
    height: `${current.viewport.visualHeight}px`,
  };
});

function boxStyle(rect: LayoutRect): CSSProperties {
  const root = rootRect.value;
  return {
    left: `${rect.left - (root?.left ?? 0)}px`,
    top: `${rect.top - (root?.top ?? 0)}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

function reserveStyle(side: "title" | "left" | "right" | "bottom"): CSSProperties {
  const current = snapshot.value;
  const root = rootRect.value;
  if (current === null || root === undefined) return {};
  if (side === "title") return { inset: `0 0 auto 0`, height: `${current.reservations.title}px` };
  if (side === "left") return { inset: `0 auto 0 0`, width: `${current.reservations.left}px` };
  if (side === "right") return { inset: `0 0 0 auto`, width: `${current.reservations.right}px` };
  const bottom = current.reservations.composerBottom + current.reservations.keyboardBottom;
  return { inset: `auto 0 0 0`, height: `${bottom}px` };
}

function safeStyle(side: "top" | "right" | "bottom" | "left"): CSSProperties {
  const current = snapshot.value;
  if (current === null) return {};
  const size = current.safeAreas[side];
  if (side === "top") return { inset: "0 0 auto 0", height: `${size}px` };
  if (side === "right") return { inset: "0 0 0 auto", width: `${size}px` };
  if (side === "bottom") return { inset: "auto 0 0 0", height: `${size}px` };
  return { inset: "0 auto 0 0", width: `${size}px` };
}
</script>

<template>
  <div
    v-if="options.enabled && snapshot !== null"
    class="layout-debug-overlay"
    data-layout-debug-overlay
    aria-hidden="true"
  >
    <template v-if="options.grid">
      <div class="debug-grid-outline"></div>
      <i
        v-for="track in snapshot.columnTracks"
        :key="`column-${track.offset}`"
        class="debug-grid-line vertical"
        :style="{ left: `${track.offset + track.size}px` }"
      ></i>
      <i
        v-for="track in snapshot.rowTracks"
        :key="`row-${track.offset}`"
        class="debug-grid-line horizontal"
        :style="{ top: `${track.offset + track.size}px` }"
      ></i>
    </template>

    <template v-if="options.regions">
      <div
        v-for="box in regionBoxes"
        :key="box.name"
        class="debug-box"
        :data-debug-kind="box.name"
        :style="boxStyle(box.rect)"
      >
        <span>{{ box.name }}</span>
      </div>
    </template>

    <template v-if="options.reserves">
      <div
        v-for="side in ['title', 'left', 'right', 'bottom'] as const"
        :key="side"
        class="debug-reserve"
        :data-debug-reserve="side"
        :style="reserveStyle(side)"
      ></div>
    </template>

    <template v-if="options.safeAreas">
      <div
        v-for="side in ['top', 'right', 'bottom', 'left'] as const"
        :key="side"
        class="debug-safe"
        :data-debug-safe="side"
        :style="safeStyle(side)"
      ></div>
    </template>

    <template v-if="options.overflow">
      <div
        v-for="box in overflowBoxes"
        :key="box.name"
        class="debug-box debug-overflow"
        :style="boxStyle(box.rect)"
      >
        <span>
          {{ box.name }} +{{ formatPixels(box.metrics.overflowX) }} x / +{{
            formatPixels(box.metrics.overflowY)
          }}
          y
        </span>
      </div>
    </template>

    <div v-if="options.viewportOffsets" class="debug-viewport" :style="viewportStyle">
      <span>visual viewport</span>
    </div>

    <pre v-if="options.constraints" class="debug-constraints">{{ constraintLines.join("\n") }}</pre>
    <pre class="debug-card">{{ cardLines.join("\n") }}</pre>
  </div>
</template>

<style scoped>
.layout-debug-overlay {
  position: absolute;
  z-index: 90;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.debug-grid-outline,
.debug-viewport,
.debug-box,
.debug-reserve,
.debug-safe,
.debug-grid-line,
.debug-card,
.debug-constraints {
  position: absolute;
  box-sizing: border-box;
  pointer-events: none;
}

.debug-grid-outline {
  inset: 0;
  border: 1px solid #0098d8;
}

.debug-grid-line {
  background: #0098d8;
  opacity: 0.75;
}

.debug-grid-line.vertical {
  top: 0;
  bottom: 0;
  width: 1px;
}

.debug-grid-line.horizontal {
  right: 0;
  left: 0;
  height: 1px;
}

.debug-box {
  border: 1px dashed #2563eb;
}

.debug-box[data-debug-kind="title"] {
  border-color: #7c3aed;
}

.debug-box[data-debug-kind="tools"] {
  border-color: #9333ea;
}

.debug-box[data-debug-kind="stage"] {
  border-color: #b98900;
}

.debug-box[data-debug-kind="foreground"] {
  border-color: #db2777;
}

.debug-box[data-debug-kind="composer"] {
  border-color: #159447;
}

.debug-box[data-debug-kind="right"] {
  border-color: #ea580c;
}

.debug-box span,
.debug-viewport span {
  display: block;
  width: max-content;
  max-width: 100%;
  padding: 2px 4px;
  overflow: hidden;
  border-radius: 2px;
  background: rgb(20 20 20 / 84%);
  color: #fff;
  font:
    700 9px/1.2 ui-monospace,
    "DejaVu Sans Mono",
    Consolas,
    monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.debug-reserve {
  border: 1px solid #d97706;
  background: rgb(217 119 6 / 10%);
}

.debug-safe {
  border: 1px solid #00a58a;
  background: rgb(0 165 138 / 18%);
}

.debug-overflow {
  border-style: solid;
  border-color: #c026d3;
  box-shadow: inset 0 0 0 1px rgb(192 38 211 / 20%);
}

.debug-viewport {
  border: 1px dotted #dc2626;
}

.debug-card,
.debug-constraints {
  z-index: 2;
  max-width: min(390px, calc(100% - 16px));
  margin: 0;
  padding: 6px 7px;
  overflow: hidden;
  border: 1px solid rgb(255 255 255 / 45%);
  border-radius: 4px;
  background: rgb(20 20 20 / 88%);
  color: #fff;
  font:
    700 8px/1.3 ui-monospace,
    "DejaVu Sans Mono",
    Consolas,
    monospace;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.debug-card {
  top: 8px;
  right: 8px;
}

.debug-constraints {
  bottom: 8px;
  left: 8px;
}
</style>
