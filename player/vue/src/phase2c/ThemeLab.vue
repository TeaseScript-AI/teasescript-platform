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
  surfaceHue: number;
  surfaceTint: number;
  accentSeed: { l: number; c: number; h: number };
}>({
  mode: "light", contrast: "standard",
  surfaceHue: 70, surfaceTint: 0,
  accentSeed: { l: 0.59208, c: 0.19138, h: 11.08 },
});
const theme = computed(() => generatePlayerTheme(intent));
watchEffect(() => emit("themeChange", {
  enabled: enabled.value,
  mode: intent.mode,
  variables: enabled.value ? themeCssVariables(theme.value) : {},
}));
function pickAccent(event: Event) {
  if (event.target instanceof HTMLInputElement) Object.assign(intent.accentSeed, pickerHexToOklch(event.target.value));
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
    <fieldset class="grid gap-2">
      <legend>Surface tint intent</legend>
      <label class="grid gap-1">Surface hue · {{ intent.surfaceHue }}°
        <input v-model.number="intent.surfaceHue" aria-label="Surface hue" type="range" min="0" max="360" step="1" />
      </label>
      <label class="grid gap-1">Tint intensity · {{ Math.round(intent.surfaceTint * 100) }}%
        <input v-model.number="intent.surfaceTint" aria-label="Tint intensity" type="range" min="0" max="1" step="0.01" />
      </label>
      <p>{{ intent.surfaceTint === 0 ? 'Achromatic surfaces. Hue is inactive until tint is added.' : 'Explicit surface tint; independent of accent and light/dark mode.' }}</p>
    </fieldset>
    <label class="flex items-center gap-2">Accent seed
      <input type="color" aria-label="Accent seed" :value="oklchToPickerHex(intent.accentSeed)" @input="pickAccent" />
    </label>
    <output class="font-mono text-xs">{{ displayColor(intent.accentSeed) }}</output>
    <p>The picker acquires a literal accent seed. Surface hue/intensity are separate intent; they are not hidden inside a white color swatch.</p>
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
