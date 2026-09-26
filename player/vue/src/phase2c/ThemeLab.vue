<script setup lang="ts">
import { Button } from "@/components/ui/button";
import { computed } from "vue";
import { oklchCss, oklchToPickerHex, pickerHexToOklch, type OklchColor } from "../../../theme/color.js";
import { generatePlayerTheme, type PlayerThemeIntent } from "../../../theme/palette.js";

const props = defineProps<{ intent: PlayerThemeIntent }>();
const emit = defineEmits<{
  "update:intent": [intent: PlayerThemeIntent];
}>();
const theme = computed(() => generatePlayerTheme(props.intent));
const intent = computed(() => props.intent);
function patchIntent(patch: Partial<PlayerThemeIntent>) {
  emit("update:intent", { ...props.intent, ...patch });
}
function selectValue(event: Event) {
  return event.target instanceof HTMLSelectElement ? event.target.value : "";
}
function inputValue(event: Event) {
  return event.target instanceof HTMLInputElement ? event.target.value : "";
}
function setContrast(event: Event) {
  const contrast = selectValue(event);
  if (contrast === "standard" || contrast === "high") patchIntent({ contrast });
}
function setSurfaceMaxChroma(event: Event) {
  const surfaceMaxChroma = Number(selectValue(event));
  if (surfaceMaxChroma === 5 || surfaceMaxChroma === 8.5 || surfaceMaxChroma === 12) patchIntent({ surfaceMaxChroma });
}
function setMonochrome(event: Event) {
  if (event.target instanceof HTMLInputElement) patchIntent({ monochrome: event.target.checked });
}
function setSurfaceHue(event: Event) {
  patchIntent({ surfaceHue: Number(inputValue(event)) });
}
function setSurfaceTint(event: Event) {
  patchIntent({ surfaceTint: Number(inputValue(event)) });
}
function pickAccent(event: Event) {
  if (event.target instanceof HTMLInputElement) patchIntent({ accentSeed: pickerHexToOklch(event.target.value) });
}
function comparePair(pair: "warm" | "cool") {
  patchIntent({
    surfaceHue: pair === "warm" ? 70 : 240,
    surfaceTint: 0.5,
    surfaceMaxChroma: 8.5,
    monochrome: false,
    accentSeed: pickerHexToOklch(pair === "warm" ? "#d63b61" : "#2255ee"),
  });
}
function displayColor(color: OklchColor) {
  return `oklch(${(color.l * 100).toFixed(2)}% ${color.c.toFixed(4)} ${color.h.toFixed(2)})`;
}
</script>

<template>
  <section class="theme-lab grid gap-3" aria-label="Experimental Theme Lab">
    <h2 class="font-semibold">Theme Lab · experimental</h2>
    <p>Applies live to this Phase 2C Player. Palette values and contrast targets are provisional, not an accessibility certification.</p>
    <p>Material palette · light and dark</p>
    <fieldset class="grid gap-1">
      <legend>Development colour pairs</legend>
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" @click="comparePair('warm')">Warm · rose</Button>
        <Button variant="outline" size="sm" @click="comparePair('cool')">Cool · blue</Button>
      </div>
    </fieldset>
    <label class="grid gap-1">Theme contrast
      <select :value="intent.contrast" aria-label="Theme contrast" @change="setContrast"><option value="standard">Standard</option><option value="high">High</option></select>
    </label>
    <fieldset class="grid gap-2">
      <legend>Surface tint intent</legend>
      <label class="grid gap-1">Maximum surface chroma
        <select :value="intent.surfaceMaxChroma" aria-label="Maximum surface chroma" @change="setSurfaceMaxChroma"><option :value="5">5 · quiet</option><option :value="8.5">8.5</option><option :value="12">12 · stronger</option></select>
      </label>
      <label class="flex items-center gap-2"><input :checked="intent.monochrome" type="checkbox" @change="setMonochrome" /> Monochrome surfaces</label>
      <label class="grid gap-1">Surface hue · {{ intent.surfaceHue }}°
        <input :value="intent.surfaceHue" :disabled="intent.monochrome" aria-label="Surface hue" type="range" min="0" max="360" step="1" @input="setSurfaceHue" />
      </label>
      <label class="grid gap-1">Tint intensity · {{ Math.round(intent.surfaceTint * 100) }}%
        <input :value="intent.surfaceTint" :disabled="intent.monochrome" aria-label="Tint intensity" type="range" min="0" max="1" step="0.01" @input="setSurfaceTint" />
      </label>
      <p>{{ intent.monochrome || intent.surfaceTint === 0 ? 'Achromatic surfaces. Hue is inactive until tint is added.' : 'Explicit surface tint; independent of accent and light/dark mode.' }}</p>
    </fieldset>
    <label class="flex items-center gap-2">Accent color
      <input type="color" aria-label="Accent color" :value="oklchToPickerHex(intent.accentSeed)" @input="pickAccent" />
    </label>
    <output class="font-mono text-xs">{{ displayColor(intent.accentSeed) }}</output>
    <p>The picker acquires a literal accent color, retained as accent-solid. Surface hue/intensity are separate intent; they are not hidden inside a white color swatch.</p>
    <p>The palette applies live to the Player.</p>
    <details>
      <summary>Generated semantic roles ({{ Object.keys(theme.roles).length }})</summary>
      <ul class="grid gap-2 py-2">
        <li v-for="(color, role) in theme.roles" :key="role" class="grid gap-1 text-xs">
          <span class="flex items-center gap-2"><span class="swatch" :style="{ background: oklchCss(color) }" />{{ role }}</span>
          <code>{{ displayColor(color) }}</code>
        </li>
        <li v-for="(effect, role) in theme.effects" :key="role" class="grid gap-1 text-xs">
          <span>{{ role }}</span><code>{{ oklchCss(effect.color, effect.alpha) }}</code>
        </li>
      </ul>
    </details>
    <details>
      <summary>Generated contrast diagnostics · {{ theme.diagnostics.filter(item => item.passes === false).length }} below target</summary>
      <p>Opaque sRGB luminance ratios; disabled text is informational. Accent boundary failures remain visible. Targets are experimental.</p>
      <ul class="grid gap-2 py-2 text-xs">
        <li v-for="item in theme.diagnostics" :key="`${item.foreground}/${item.background}`">
          {{ item.foreground }} / {{ item.background }}: {{ item.ratio.toFixed(2) }}
          · {{ item.target === null ? 'informational' : `target ${item.target} — ${item.passes ? 'meets' : 'BELOW'}` }}
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.theme-lab select { min-width: 0; border: 1px solid var(--border); border-radius: .375rem; padding: .4rem; background: var(--control-surface, var(--surface-component)); }
.theme-lab output, .theme-lab code { overflow-wrap: anywhere; }
.theme-lab input[type=range] { width: 100%; }
.swatch { display: inline-block; width: 1.5rem; height: 1.5rem; flex-shrink: 0; border: 1px solid var(--border); }
</style>
