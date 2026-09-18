<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { captureRect, formatPixels, formatRect, parseGridTracks, type LayoutRect } from "../devtools/layoutDebugMeasurement";

const props = defineProps<{ player: HTMLElement }>();
const enabled = ref(false);
const layers = ref({ regions: true, reserves: false, spacing: false, grid: false, centers: true, media: true });
const labels = { regions: "Region bounds", reserves: "Reserved tools space", spacing: "Spacing", grid: "Grid tracks", centers: "Center lines", media: "Actual media bounds" };
const selectors = {
  Player: ":scope", Tools: "[data-tools-surface]", Stage: ".player-stage",
  Conversation: ".player-conversation", Transcript: ".transcript-scroll",
  Composer: "[data-runtime-interaction] form", Content: ".stage-media-frame",
};
type Region = keyof typeof selectors;
type Spacing = { owner: string; kind: "padding" | "gap" | "margin"; values: string; areas: LayoutRect[] };
const snapshot = shallowRef<{
  regions: Partial<Record<Region, LayoutRect>>;
  media: LayoutRect | null;
  reserve: number;
  spacing: Spacing[];
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
  const spacing: Spacing[] = [];
  if (layers.value.spacing) {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const value = (px: number) => `${formatPixels(px)} (${Number((px / rem).toFixed(2))}rem)`;
    for (const [owner, selector] of [
      ["Conversation", ".player-conversation"],
      ["Interaction area", "[data-runtime-interaction]"],
    ] as const) {
      const element = root.querySelector<HTMLElement>(selector);
      if (!element?.getClientRects().length) continue;
      const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
      const top = parseFloat(css.paddingTop), right = parseFloat(css.paddingRight);
      const bottom = parseFloat(css.paddingBottom), left = parseFloat(css.paddingLeft);
      const areas = [
        new DOMRect(rect.left, rect.top, rect.width, top),
        new DOMRect(rect.right - right, rect.top + top, right, rect.height - top - bottom),
        new DOMRect(rect.left, rect.bottom - bottom, rect.width, bottom),
        new DOMRect(rect.left, rect.top + top, left, rect.height - top - bottom),
      ].filter(area => area.width > 0 && area.height > 0).map(captureRect);
      spacing.push({ owner, kind: "padding", values: `Top ${value(top)} · right ${value(right)} · bottom ${value(bottom)} · left ${value(left)}`, areas });
      const margin = parseFloat(css.marginBottom);
      if (margin > 0) spacing.push({ owner, kind: "margin", values: `Bottom ${value(margin)}`, areas: [captureRect(new DOMRect(rect.left, rect.bottom, rect.width, margin))] });
    }
    for (const [owner, parent, before, after] of [
      ["Player composition", ".player-composition", ".player-stage", ".player-conversation"],
      ["Conversation", ".player-conversation", ".transcript", "[data-runtime-interaction]"],
    ] as const) {
      const element = root.querySelector<HTMLElement>(parent);
      const start = element?.querySelector(before)?.getBoundingClientRect();
      const end = element?.querySelector(after)?.getBoundingClientRect();
      if (!element || !start || !end) continue;
      const gap = parseFloat(getComputedStyle(element).rowGap) || 0;
      spacing.push({ owner, kind: "gap", values: `${before === ".player-stage" ? "Stage → Conversation" : "Transcript → Interaction"}: ${value(gap)}`,
        areas: gap ? [captureRect(new DOMRect(end.left, start.bottom, end.width, gap))] : [] });
    }
  }
  const style = getComputedStyle(root);
  snapshot.value = {
    regions, media, spacing,
    reserve: root.dataset.narrow === "true" ? 0 : root.querySelector('[data-slot="sidebar-gap"]')?.getBoundingClientRect().width ?? 0,
    tracks: contentStyle ? parseGridTracks(contentStyle.gridTemplateRows, parseFloat(contentStyle.rowGap)).map(track => track.offset + track.size) : [],
    constraints: [
      `Mode: ${root.dataset.narrow === "true" ? "overlay" : "docked"}`,
      `Protected Player width: ${style.getPropertyValue("--player-reserve").trim()} (provisional)`,
      `Conversation max: ${style.getPropertyValue("--conversation-max-width").trim()}`,
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
    <section v-if="snapshot && layers.spacing" class="space-y-2 text-xs" aria-label="Layout spacing">
      <p>Green: padding inside its owner. Purple: gap between children. Orange: outer margin. Message styling is not measured.</p>
      <div v-for="item in snapshot.spacing" :key="`${item.owner}-${item.kind}`" :class="`spacing-key spacing-key-${item.kind}`">
        <p class="font-medium">{{ item.owner }} · {{ item.kind }}</p><p>{{ item.values }}</p>
      </div>
    </section>
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
      <template v-if="layers.spacing">
        <template v-for="item in snapshot.spacing" :key="`${item.owner}-${item.kind}`">
          <div v-for="(area, index) in item.areas" :key="index" :class="`debug-spacing debug-spacing-${item.kind}`" :data-spacing-owner="item.owner" :data-spacing-kind="item.kind" :style="box(area)" />
        </template>
      </template>
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
.debug-spacing-padding { background: rgb(22 163 74 / 14%); border: 1px dotted rgb(22 163 74 / 55%); }
.debug-spacing-gap { background: rgb(147 51 234 / 12%); border: 1px dotted rgb(147 51 234 / 55%); }
.debug-spacing-margin { background: rgb(217 119 6 / 12%); border: 1px dotted rgb(217 119 6 / 55%); }
.spacing-key { border-left: 3px solid; padding-left: 0.5rem; }
.spacing-key-padding { border-color: #16a34a; }
.spacing-key-gap { border-color: #9333ea; }
.spacing-key-margin { border-color: #d97706; }
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
