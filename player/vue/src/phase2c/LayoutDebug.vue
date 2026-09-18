<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { captureRect, formatPixels, formatRect, parseGridTracks, type LayoutRect } from "../devtools/layoutDebugMeasurement";

const props = defineProps<{ player: HTMLElement }>();
const enabled = ref(false);
const layers = ref({ regions: true, reserves: true, grid: false, centers: true, media: true });
const labels = { regions: "Region bounds", reserves: "Reserved tools space", grid: "Grid tracks", centers: "Center lines", media: "Actual media bounds" };
const selectors = {
  Player: ":scope", Tools: "[data-tools-surface]", Stage: ".player-stage",
  Conversation: ".player-conversation", Transcript: ".transcript-scroll",
  Composer: "[data-runtime-interaction] form", Content: ".player-composition",
};
type Region = keyof typeof selectors;
const snapshot = shallowRef<{
  regions: Partial<Record<Region, LayoutRect>>;
  media: LayoutRect | null;
  reserve: number;
  tracks: number[];
  constraints: string[];
} | null>(null);
let frame = 0;

function measure() {
  const root = props.player;
  const regions: Partial<Record<Region, LayoutRect>> = {};
  for (const [name, selector] of Object.entries(selectors)) {
    const element = name === "Player" ? root : root.querySelector<HTMLElement>(selector);
    if (element && element.getClientRects().length && element.clientWidth)
      regions[name as Region] = captureRect(element.getBoundingClientRect());
  }
  const content = root.querySelector<HTMLElement>(".player-composition");
  const contentStyle = content ? getComputedStyle(content) : null;
  const image = root.querySelector<HTMLImageElement>(".stage-media");
  let media: LayoutRect | null = null;
  // Stage uses centered object-fit: contain. Measure the painted image, not its element box.
  if (image?.naturalWidth && image.naturalHeight) {
    const box = image.getBoundingClientRect();
    const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    media = captureRect(new DOMRect(box.left + (box.width - width) / 2, box.top + (box.height - height) / 2, width, height));
  }
  const style = getComputedStyle(root);
  const conversation = root.querySelector<HTMLElement>(".player-conversation");
  snapshot.value = {
    regions, media,
    reserve: root.dataset.narrow === "true" ? 0 : root.querySelector('[data-slot="sidebar-gap"]')?.getBoundingClientRect().width ?? 0,
    tracks: contentStyle ? parseGridTracks(contentStyle.gridTemplateRows, parseFloat(contentStyle.rowGap)).map(track => track.offset + track.size) : [],
    constraints: [
      `Mode: ${root.dataset.narrow === "true" ? "overlay" : "docked"}`,
      `Protected Player width: ${style.getPropertyValue("--player-reserve").trim()} (provisional)`,
      `Conversation max: ${conversation ? getComputedStyle(conversation).maxWidth : "—"}`,
      `Stage / conversation tracks: ${contentStyle?.gridTemplateRows ?? "—"}`,
      `Usable viewport: ${style.getPropertyValue("--usable-width").trim()} × ${style.getPropertyValue("--usable-height").trim()}`,
    ],
  };
  // Diagnostic-only sampling follows CSS transitions too. No work runs while disabled.
  frame = requestAnimationFrame(measure);
}
watch(enabled, value => {
  cancelAnimationFrame(frame);
  if (value) measure();
  else snapshot.value = null;
});
onBeforeUnmount(() => cancelAnimationFrame(frame));
function box(rect: LayoutRect | undefined) {
  if (!rect) return {};
  const root = snapshot.value?.regions.Player;
  return { left: `${rect.left - (root?.left ?? 0)}px`, top: `${rect.top - (root?.top ?? 0)}px`, width: `${rect.width}px`, height: `${rect.height}px` };
}
function center(rect: LayoutRect) {
  return `${rect.left + rect.width / 2 - (snapshot.value?.regions.Player?.left ?? 0)}px`;
}
</script>

<template>
  <section class="debug-controls space-y-4 p-4 text-sm" aria-label="Layout Debug controls">
    <label class="flex items-center justify-between gap-2 font-medium"><span>Layout Debug</span><input v-model="enabled" type="checkbox" /></label>
    <fieldset class="grid gap-2">
      <legend class="mb-2">Overlay layers</legend>
      <label v-for="(label, key) in labels" :key="key" class="flex items-center justify-between gap-2"><span>{{ label }}</span><input v-model="layers[key]" type="checkbox" /></label>
    </fieldset>
    <template v-if="snapshot">
      <dl class="grid gap-1 text-xs">
        <template v-for="(rect, name) in snapshot.regions" :key="name"><dt class="font-medium">{{ name }}</dt><dd>{{ formatRect(rect) }}</dd></template>
        <dt class="font-medium">Actual media</dt><dd>{{ snapshot.media ? formatRect(snapshot.media) : 'No media' }}</dd>
        <dt class="font-medium">Tools reservation</dt><dd>{{ formatPixels(snapshot.reserve) }}</dd>
      </dl>
      <div class="space-y-1 text-xs"><p v-for="line in snapshot.constraints" :key="line">{{ line }}</p></div>
    </template>
    <p v-else class="text-xs">Enable to show measured bounds. The overlay does not change the layout.</p>
  </section>
  <Teleport :to="player">
    <!-- Paint-only overlay: never a grid/flex item or pointer target. Based on the main Player debug overlay. -->
    <div v-if="enabled && snapshot" class="layout-debug-overlay" data-layout-debug-overlay aria-hidden="true">
      <div v-if="layers.reserves && snapshot.reserve" class="debug-reserve" :style="{ width: `${snapshot.reserve}px` }"><span>Tools reservation</span></div>
      <template v-if="layers.regions">
        <div v-for="(rect, name) in snapshot.regions" :key="name" class="debug-box" :data-region="name" :style="box(rect)"><span>{{ name }}</span></div>
      </template>
      <div v-if="layers.media && snapshot.media" class="debug-box debug-media" :style="box(snapshot.media)"><span>Actual media</span></div>
      <template v-if="layers.centers">
        <div v-if="snapshot.regions.Player" class="debug-center player-center" :style="{ left: center(snapshot.regions.Player) }"><span>Player center</span></div>
        <div v-if="snapshot.regions.Content" class="debug-center debug-content-center" :style="{ left: center(snapshot.regions.Content) }"><span>Content center</span></div>
      </template>
      <template v-if="layers.grid && snapshot.regions.Content && snapshot.regions.Player">
        <div v-for="track in snapshot.tracks" :key="track" class="debug-track" :style="{ left: `${snapshot.regions.Content.left - snapshot.regions.Player.left}px`, width: `${snapshot.regions.Content.width}px`, top: `${snapshot.regions.Content.top - snapshot.regions.Player.top + track}px` }" />
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.debug-controls dd { margin: 0 0 0.5rem; font-family: monospace; overflow-wrap: anywhere; }
.layout-debug-overlay { position: absolute; inset: 0; z-index: 90; overflow: hidden; pointer-events: none; }
.layout-debug-overlay > div { position: absolute; pointer-events: none; box-sizing: border-box; }
.debug-box { border: 1px dashed #2563eb; }
.debug-box[data-region="Tools"] > span { margin-top: 16px; }
.debug-box[data-region="Stage"] > span { margin-top: 16px; }
.debug-box[data-region="Content"] > span { margin-top: 32px; }
.debug-box[data-region="Transcript"] > span { margin-top: 16px; }
.debug-media { border: 2px solid #b98900; }
.debug-reserve { inset: 0 auto 0 0; border: 1px solid #d97706; background: rgb(217 119 6 / 10%); }
.debug-center { top: 0; bottom: 0; border-left: 1px dashed #9333ea; }
.debug-content-center { border-color: #159447; padding-top: 24px; }
.debug-track { height: 1px; background: #0098d8; }
.layout-debug-overlay span { display: block; width: max-content; max-width: 100%; padding: 2px 4px; background: rgb(20 20 20 / 84%); color: white; font: 700 10px/1.2 monospace; white-space: nowrap; }
</style>
