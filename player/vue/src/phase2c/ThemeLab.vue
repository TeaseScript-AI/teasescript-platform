<script setup lang="ts">
import { computed, reactive, ref, watchEffect } from "vue";
import { oklchCss, oklchToPickerHex, pickerHexToOklch, type OklchColor } from "../../../theme/color.js";
import { generatePlayerTheme, themeCssVariables, type PlayerThemeIntent } from "../../../theme/palette.js";

const emit = defineEmits<{
  themeChange: [update: {
    enabled: boolean;
    mode: PlayerThemeIntent["mode"];
    variables: Record<string, string>;
  }];
}>();
const enabled = ref(false);
const intent = reactive<{
  mode: PlayerThemeIntent["mode"];
  contrast: PlayerThemeIntent["contrast"];
  surfaceSeed: { l: number; c: number; h: number };
  accentSeed: { l: number; c: number; h: number };
}>({
  mode: "light", contrast: "standard",
  surfaceSeed: { l: 0.95839, c: 0.01306, h: 71.33 },
  accentSeed: { l: 0.59208, c: 0.19138, h: 11.08 },
});
const theme = computed(() => generatePlayerTheme(intent));
watchEffect(() => emit("themeChange", {
  enabled: enabled.value,
  mode: intent.mode,
  variables: enabled.value ? themeCssVariables(theme.value) : {},
}));
const seeds = ["surfaceSeed", "accentSeed"] as const;
const channels = [
  { key: "l", label: "Lightness", max: 1, step: 0.001 },
  { key: "c", label: "Chroma", max: 0.4, step: 0.001 },
  { key: "h", label: "Hue", max: 360, step: 1 },
] as const;
function pickSeed(seed: typeof seeds[number], event: Event) {
  if (event.target instanceof HTMLInputElement) Object.assign(intent[seed], pickerHexToOklch(event.target.value));
}
function displayColor(color: OklchColor) {
  return `oklch(${(color.l * 100).toFixed(2)}% ${color.c.toFixed(4)} ${color.h.toFixed(2)})`;
}
</script>

<template>
  <section class="theme-lab grid gap-3" aria-label="Experimental Theme Lab">
    <h2 class="font-semibold">Theme Lab · experimental</h2>
    <p>Applies live to this Phase 2C Player. Palette values and contrast targets are provisional, not an accessibility certification.</p>
    <label class="flex items-center gap-2"><input v-model="enabled" type="checkbox" /> Generated dynamic theme</label>
    <label class="grid gap-1">Theme mode
      <select v-model="intent.mode" aria-label="Theme mode"><option value="light">Light</option><option value="dark">Dark</option></select>
    </label>
    <label class="grid gap-1">Theme contrast
      <select v-model="intent.contrast" aria-label="Theme contrast"><option value="standard">Standard</option><option value="high">High</option></select>
    </label>
    <p>Pickers show an sRGB approximation. Sliders retain OKLCH intent; resolved colors may reduce chroma to fit sRGB.</p>
    <fieldset v-for="seed in seeds" :key="seed" class="grid min-w-0 gap-2">
      <legend>{{ seed === 'accentSeed' ? 'Accent seed' : 'Surface seed' }}</legend>
      <label class="flex items-center gap-2">Color picker<input type="color" :aria-label="`${seed} color picker`" :value="oklchToPickerHex(intent[seed])" @input="pickSeed(seed, $event)" /></label>
      <label v-for="channel in channels" :key="channel.key" class="grid gap-1">
        {{ channel.label }}
        <input v-model.number="intent[seed][channel.key]" :aria-label="`${seed} ${channel.label}`" type="range" min="0" :max="channel.max" :step="channel.step" />
      </label>
      <output class="font-mono text-xs">{{ displayColor(intent[seed]) }}</output>
    </fieldset>
    <p>{{ enabled ? 'Generated palette is active on the Player.' : 'The Player is using its current baseline palette.' }}</p>
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
.theme-lab select { min-width: 0; border: 1px solid var(--border); border-radius: .375rem; padding: .4rem; background: var(--surface-component); }
.theme-lab output, .theme-lab code { overflow-wrap: anywhere; }
.theme-lab input[type=range] { width: 100%; }
.swatch { display: inline-block; width: 1.5rem; height: 1.5rem; flex-shrink: 0; border: 1px solid var(--border); }
</style>
