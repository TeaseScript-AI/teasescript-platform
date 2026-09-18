<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { Button } from "@/components/ui/button";
import { oklchCss, oklchToPickerHex, pickerHexToOklch, type OklchColor } from "../../../theme/color.js";
import { generatePlayerTheme, themeCssVariables, type PlayerThemeIntent } from "../../../theme/palette.js";

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
const previewStyle = computed(() => enabled.value ? themeCssVariables(theme.value) : {});
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
const selected = ref(false);
// This exact authored scene is deliberately outside palette intent; no theme conversion.
const scene = ref("oklch(0.8769778 0.062244 57.33796)");
</script>

<template>
  <section class="theme-lab grid gap-3" aria-label="Experimental Theme Lab">
    <h2 class="font-semibold">Theme Lab · experimental</h2>
    <p>Local preview only. Palette values and contrast targets are provisional, not an accessibility certification.</p>
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
    <label class="grid gap-1">Exact scene color (independent)
      <select v-model="scene" aria-label="Exact scene color (independent)"><option value="oklch(0.8769778 0.062244 57.33796)">Warm scene</option><option value="oklch(0.35 0.09 250)">Blue scene</option></select>
    </label>
    <p>{{ enabled ? 'Generated palette' : 'Current light baseline aliases' }} · only the preview below changes.</p>
    <div class="theme-preview grid gap-3 rounded-md p-3" :style="previewStyle" :data-generated-theme="enabled" :data-theme-mode="intent.mode">
      <header class="preview-chrome rounded p-2">Chrome <span class="secondary">secondary text</span></header>
      <div class="scene rounded p-3" :style="{ background: scene }" aria-label="Exact scene sample"><span class="scene-caption">Exact authored scene</span></div>
      <div class="preview-raised grid gap-2 rounded p-3">
        <strong>Raised controls</strong>
        <Button class="theme-action">Accent action</Button>
        <div class="state-row"><Button class="theme-action forced-hover">Hover</Button><Button class="theme-action forced-pressed">Pressed</Button></div>
        <Button class="theme-neutral" :aria-pressed="selected" @click="selected = !selected">{{ selected ? 'Selected' : 'Select option' }}</Button>
        <div class="state-row"><Button class="theme-neutral neutral-hover">Hover</Button><Button class="theme-neutral neutral-pressed">Pressed</Button></div>
        <label class="grid gap-1">Text input<input class="theme-input" placeholder="Focus to inspect ring" /></label>
        <Button class="theme-disabled" disabled>Disabled action</Button>
        <p class="accent-soft rounded p-2">Soft accent with primary text</p>
      </div>
      <aside class="preview-floating rounded p-3">Floating surface · structural shadow</aside>
      <div class="scrim-sample rounded p-3"><span class="scene-caption">Structural scrim</span></div>
    </div>
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
.theme-preview {
  /* Baseline aliases use the existing light theme. New experimental roles share their nearest baseline role. */
  --theme-surface-canvas: var(--background);
  --theme-surface-chrome: var(--sidebar);
  --theme-surface-raised: var(--surface-component);
  --theme-surface-floating: var(--surface-component);
  --theme-surface-hover: var(--component-hover);
  --theme-surface-pressed: var(--component-pressed);
  --theme-surface-selected: var(--component-pressed);
  --theme-border-subtle: var(--border);
  --theme-border-default: var(--border-hover);
  --theme-border-strong: var(--border-strong);
  --theme-text-primary: var(--foreground);
  --theme-text-secondary: var(--text-muted);
  --theme-text-disabled: oklch(58.486% 0.02603 41.30);
  --theme-text-on-accent: oklch(1 0 0);
  --theme-accent-solid: var(--package-accent);
  --theme-accent-hover: oklch(56.375% 0.18326 11.66);
  --theme-accent-pressed: oklch(52.588% 0.17301 12.20);
  --theme-accent-soft: var(--component-hover);
  --theme-accent-focus: oklch(64.182% 0.19236 10.29);
  --theme-surface-disabled: oklch(93.009% 0.01361 60.56);
  --theme-border-disabled: oklch(86.370% 0.02252 58.74);
  --theme-structural-shadow: oklch(30.838% 0.01712 35.72 / 8%);
  --theme-structural-scrim: oklch(30.838% 0.01712 35.72 / 18%);
  color: var(--theme-text-primary); background: var(--theme-surface-canvas);
  border: 1px solid var(--theme-border-subtle);
}
.preview-chrome { background: var(--theme-surface-chrome); }
.secondary { color: var(--theme-text-secondary); }
.preview-raised, .scene-caption { background: var(--theme-surface-raised); }
.scene-caption { padding: .2rem; }
.preview-floating { background: var(--theme-surface-floating); box-shadow: 0 4px 12px var(--theme-structural-shadow); }
.scrim-sample { background: linear-gradient(var(--theme-structural-scrim), var(--theme-structural-scrim)), var(--theme-surface-canvas); }
.state-row { display: flex; flex-wrap: wrap; gap: .5rem; }
.theme-action { background: var(--theme-accent-solid); color: var(--theme-text-on-accent); }
.theme-action:hover, .theme-action.forced-hover { background: var(--theme-accent-hover); }
.theme-action:active, .theme-action.forced-pressed { background: var(--theme-accent-pressed); }
.theme-neutral, .theme-input { background: var(--theme-surface-raised); color: var(--theme-text-primary); border: 1px solid var(--theme-border-default); }
.theme-neutral:hover, .neutral-hover { background: var(--theme-surface-hover); }
.theme-neutral:active, .neutral-pressed { background: var(--theme-surface-pressed); }
.theme-neutral[aria-pressed=true] { background: var(--theme-surface-selected); border-color: var(--theme-border-strong); }
.theme-input { min-width: 0; padding: .5rem; border-radius: .375rem; }
.theme-preview :is(button, input):focus-visible { outline: 2px solid var(--theme-accent-focus); outline-offset: 2px; box-shadow: none; }
.theme-input::placeholder { color: var(--theme-text-secondary); opacity: 1; }
.theme-disabled:disabled { opacity: 1; background: var(--theme-surface-disabled); color: var(--theme-text-disabled); border: 1px solid var(--theme-border-disabled); }
.accent-soft { background: var(--theme-accent-soft); }
.swatch { display: inline-block; width: 1.5rem; height: 1.5rem; flex-shrink: 0; border: 1px solid var(--border); }
</style>
