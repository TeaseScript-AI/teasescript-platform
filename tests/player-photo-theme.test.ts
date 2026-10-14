import assert from "node:assert/strict";
import test, { before } from "node:test";

import {
  pickSwatches,
  quantize,
  type PhotoSwatches,
  type Rgb,
  type SwatchName,
} from "../player/theme/node-vibrant/swatches.js";
import type { OklchColor } from "../player/theme/color.js";
import type {
  ContrastDiagnostic,
  PhotoSurfaces,
  PlayerThemeIntent,
} from "../player/theme/palette.js";
import { loadPlayerModule } from "./helpers/player-modules.js";
import { referencePhotos } from "./helpers/photo-swatches-fixture.js";

interface PhotoColours {
  readonly surfaces: PhotoSurfaces;
  readonly accent: OklchColor | null;
  readonly vignette: number;
}
type Mode = "light" | "dark";
let photoColours: (swatches: PhotoSwatches, mode: Mode) => PhotoColours | null;
let generatePlayerTheme: (
  intent: PlayerThemeIntent,
  photo?: PhotoSurfaces | null,
) => { roles: Record<string, OklchColor>; diagnostics: readonly ContrastDiagnostic[] };
let defaults: Readonly<Record<Mode, PlayerThemeIntent>>;

// The theme modules use MCU, which loads through the Player test bundle.
before(async () => {
  const theme = await loadPlayerModule("player/theme/photo-theme.ts");
  const palette = await loadPlayerModule("player/theme/palette.ts");
  const player = await loadPlayerModule("player/vue/src/usePlayerTheme.ts");
  assert.equal(typeof theme.photoColours, "function");
  assert.equal(typeof palette.generatePlayerTheme, "function");
  assert.equal(typeof player.defaultPlayerThemeIntents, "object");
  // EVIDENCE: validation: Vite loaded the real source modules and the exports were checked just above.
  photoColours = theme.photoColours as typeof photoColours;
  // EVIDENCE: validation: the generator export was checked callable just above, from the same real source build.
  generatePlayerTheme = palette.generatePlayerTheme as typeof generatePlayerTheme;
  // EVIDENCE: validation: the default intents are the Player's own, checked present just above.
  defaults = player.defaultPlayerThemeIntents as typeof defaults;
});

const NONE: PhotoSwatches = {
  Vibrant: null,
  LightVibrant: null,
  DarkVibrant: null,
  Muted: null,
  LightMuted: null,
  DarkMuted: null,
};
function swatches(colours: Partial<Record<SwatchName, Rgb>>): PhotoSwatches {
  return {
    ...NONE,
    ...Object.fromEntries(
      Object.entries(colours).map(([name, rgb]) => [name, { rgb, population: 1 }]),
    ),
  };
}
// The six photos of the node-vibrant fixture, and a sweep of photo colours around the hue circle.
function photos(): { readonly name: string; readonly swatches: PhotoSwatches }[] {
  const measured = referencePhotos().map(({ photo, histogram }) => ({
    name: photo,
    swatches: pickSwatches(quantize(histogram)),
  }));
  const swept = [];
  for (let hue = 0; hue < 360; hue += 10)
    for (const [saturation, lightness] of [
      [1, 0.25],
      [1, 0.5],
      [0.45, 0.5],
      [1, 0.75],
    ] as const) {
      const rgb = hslRgb(hue, saturation, lightness);
      swept.push({
        name: `hsl(${hue} ${saturation} ${lightness})`,
        swatches: swatches({ Vibrant: rgb, LightVibrant: rgb, DarkVibrant: rgb }),
      });
    }
  return [...measured, ...swept];
}
function hslRgb(hue: number, saturation: number, lightness: number): Rgb {
  const chroma = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (lightness - chroma * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}

test("photo colours fail no contrast check that the theme passes, in either mode and contrast", () => {
  const all = photos();
  for (const mode of ["light", "dark"] as const)
    for (const contrast of ["standard", "high"] as const) {
      const intent = { ...defaults[mode], contrast };
      const key = (item: ContrastDiagnostic) => `${item.foreground} on ${item.background}`;
      const passing = new Set(
        generatePlayerTheme(intent)
          .diagnostics.filter((item) => item.passes)
          .map(key),
      );
      for (const photo of all) {
        const result = photoColours(photo.swatches, mode);
        if (!result) continue;
        const theme = generatePlayerTheme(
          result.accent ? { ...intent, accentSeed: result.accent } : intent,
          result.surfaces,
        );
        const failures = theme.diagnostics
          .filter((item) => item.passes === false && passing.has(key(item)))
          .map((item) => `${key(item)} ${item.ratio.toFixed(3)} < ${item.target}`);
        assert.deepEqual(failures, [], `${photo.name}, ${mode}, ${contrast}`);
      }
    }
});
