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
function colours(photo: PhotoSwatches, mode: Mode): PhotoColours {
  const result = photoColours(photo, mode);
  assert.ok(result, "the photo has colours");
  return result;
}

const RED: Rgb = [244, 40, 51];
const LIGHT_BLUE: Rgb = [168, 205, 251];
const DARK_GREEN: Rgb = [60, 108, 4];

test("the Player takes the colour of the photo's Vibrant-family swatch for the mode", () => {
  const photo = swatches({ Vibrant: RED, LightVibrant: LIGHT_BLUE, DarkVibrant: DARK_GREEN });
  const dark = colours(photo, "dark").surfaces;
  const light = colours(photo, "light").surfaces;
  assert.equal(dark.hue, colours(swatches({ DarkVibrant: DARK_GREEN }), "dark").surfaces.hue);
  assert.equal(light.hue, colours(swatches({ LightVibrant: LIGHT_BLUE }), "light").surfaces.hue);
  assert.ok(dark.chroma > 0 && light.chroma > 0);
  // Without that swatch, Vibrant stands in, then the Muted family, then the other mode's swatches.
  assert.equal(
    colours(swatches({ Vibrant: RED, LightVibrant: LIGHT_BLUE }), "dark").surfaces.hue,
    colours(swatches({ Vibrant: RED }), "dark").surfaces.hue,
  );
  assert.equal(
    colours(swatches({ DarkMuted: DARK_GREEN, LightVibrant: LIGHT_BLUE }), "dark").surfaces.hue,
    dark.hue,
  );
  assert.equal(colours(swatches({ DarkVibrant: DARK_GREEN }), "light").surfaces.hue, dark.hue);
});

test("the Player keeps its own lightness, whatever the photo's", () => {
  for (const mode of ["light", "dark"] as const) {
    const pale = colours(swatches({ Vibrant: [250, 200, 205] }), mode).surfaces;
    const deep = colours(swatches({ Vibrant: [90, 8, 14] }), mode).surfaces;
    assert.deepEqual(pale.tones, deep.tones, mode);
    const canvas = (surfaces: PhotoSurfaces) =>
      generatePlayerTheme(defaults[mode], surfaces).roles["surface-canvas"]!.l;
    assert.ok(Math.abs(canvas(pale) - canvas(deep)) < 0.01, `${mode}: canvas lightness`);
  }
});

test("a grey photo keeps the Player neutral, and a photo without colours keeps the theme", () => {
  const grey = swatches({
    Muted: [124, 124, 124],
    LightMuted: [188, 188, 188],
    DarkMuted: [68, 68, 68],
  });
  for (const mode of ["light", "dark"] as const) {
    const result = colours(grey, mode);
    assert.equal(result.surfaces.chroma, 0, mode);
    assert.equal(result.accent, null, `${mode}: the theme's accent stays`);
    assert.equal(photoColours(NONE, mode), null, `${mode}: no colours`);
  }
});

test("the photo accent takes the photo's Vibrant hue when the photo has enough colour", () => {
  const red = colours(swatches({ Vibrant: RED }), "light").accent;
  const green = colours(swatches({ Vibrant: [80, 170, 60] }), "light").accent;
  assert.ok(red && green);
  assert.ok(Math.abs(red.h - green.h) > 60, "a different hue per photo");
  assert.deepEqual(
    colours(swatches({ Vibrant: RED }), "dark").accent,
    red,
    "the same in both modes",
  );
  assert.deepEqual(
    colours(swatches({ DarkVibrant: RED }), "light").accent,
    red,
    "DarkVibrant stands in",
  );
  // A pale cream LightVibrant, as in a sunlit portrait, has too little colour for an accent.
  assert.equal(colours(swatches({ LightVibrant: [252, 236, 204] }), "light").accent, null);
});

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
