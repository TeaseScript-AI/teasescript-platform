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
interface PhotoColourChoice {
  readonly family: "vibrant" | "muted" | "large-vibrant";
  readonly minShare: number;
}
let photoColours: (
  swatches: PhotoSwatches,
  mode: Mode,
  choice: PhotoColourChoice,
) => PhotoColours | null;
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

// Swatches of the given colours, each covering the given share of the photo, 10 % unless given.
function swatches(
  colours: Partial<Record<SwatchName, Rgb>>,
  shares: Partial<Record<SwatchName, number>> = {},
): PhotoSwatches {
  const swatch = (name: SwatchName) => {
    const rgb = colours[name];
    return rgb ? { rgb, population: 1, share: shares[name] ?? 0.1 } : null;
  };
  return {
    Vibrant: swatch("Vibrant"),
    LightVibrant: swatch("LightVibrant"),
    DarkVibrant: swatch("DarkVibrant"),
    Muted: swatch("Muted"),
    LightMuted: swatch("LightMuted"),
    DarkMuted: swatch("DarkMuted"),
  };
}
const VIBRANT: PhotoColourChoice = { family: "vibrant", minShare: 0.02 };
const MUTED: PhotoColourChoice = { family: "muted", minShare: 0.02 };
const LARGE_VIBRANT: PhotoColourChoice = { family: "large-vibrant", minShare: 0.02 };
// The surface hue the Player takes from a photo.
function hue(photo: PhotoSwatches, mode: Mode, choice: PhotoColourChoice): number {
  const result = photoColours(photo, mode, choice);
  assert.ok(result, "the photo has colours");
  return result.surfaces.hue;
}

const RED: Rgb = [244, 40, 51];
const LIGHT_BLUE: Rgb = [168, 205, 251];
const BROWN: Rgb = [126, 60, 17];
const GREEN: Rgb = [50, 72, 61];
const PINK_GREY: Rgb = [205, 170, 180];
const YELLOW: Rgb = [245, 195, 82];

test("the Muted family takes the photo's Muted swatch for the mode", () => {
  const photo = swatches({
    DarkVibrant: RED,
    LightVibrant: LIGHT_BLUE,
    DarkMuted: GREEN,
    LightMuted: PINK_GREY,
  });
  assert.equal(hue(photo, "dark", MUTED), hue(swatches({ DarkMuted: GREEN }), "dark", VIBRANT));
  assert.equal(
    hue(photo, "light", MUTED),
    hue(swatches({ LightMuted: PINK_GREY }), "light", VIBRANT),
  );
  // Without it, Muted stands in, then the mode's Vibrant family.
  assert.equal(
    hue(swatches({ Muted: GREEN, DarkVibrant: RED }), "dark", MUTED),
    hue(swatches({ DarkMuted: GREEN }), "dark", VIBRANT),
  );
  assert.equal(
    hue(swatches({ DarkVibrant: RED, LightMuted: PINK_GREY }), "dark", MUTED),
    hue(swatches({ DarkVibrant: RED }), "dark", VIBRANT),
  );
});

test("Vibrant when large enough takes a Vibrant swatch only when it covers the share, else the Muted one", () => {
  // A green landscape whose DarkVibrant is a small brown hut (owner's photo, 2026-10-14).
  const landscape = (hut: number) =>
    swatches(
      { DarkVibrant: BROWN, Vibrant: BROWN, DarkMuted: GREEN },
      { DarkVibrant: hut, Vibrant: hut / 2, DarkMuted: 0.08 },
    );
  const brown = hue(swatches({ DarkVibrant: BROWN }), "dark", VIBRANT);
  const green = hue(swatches({ DarkMuted: GREEN }), "dark", VIBRANT);
  assert.equal(hue(landscape(0.0006), "dark", VIBRANT), brown, "Vibrant takes the hut");
  assert.equal(hue(landscape(0.0006), "dark", LARGE_VIBRANT), green, "the hut is too small");
  assert.equal(hue(landscape(0.02), "dark", LARGE_VIBRANT), brown, "exactly the share counts");
  assert.equal(
    hue(landscape(0.0006), "dark", { family: "large-vibrant", minShare: 0.0005 }),
    brown,
    "the share is adjustable",
  );
  // The mode's Vibrant swatch is too small, the mid one covers enough.
  assert.equal(
    hue(
      swatches({ DarkVibrant: BROWN, Vibrant: RED, DarkMuted: GREEN }, { DarkVibrant: 0.001 }),
      "dark",
      LARGE_VIBRANT,
    ),
    hue(swatches({ Vibrant: RED }), "dark", VIBRANT),
  );
  // Light and dark stay tied to the mode: a large LightVibrant does not count in dark mode.
  assert.equal(
    hue(swatches({ LightVibrant: RED, DarkMuted: GREEN }), "dark", LARGE_VIBRANT),
    green,
  );
  // A photo without a Muted swatch keeps its small Vibrant one.
  assert.equal(
    hue(swatches({ DarkVibrant: BROWN }, { DarkVibrant: 0.0006 }), "dark", LARGE_VIBRANT),
    brown,
  );
});

test("a Vibrant swatch standing in for a missing Muted one is the larger one", () => {
  // A red neon sign: no Muted colour, a tiny yellow highlight as LightVibrant, red as Vibrant.
  const neon = swatches(
    { LightVibrant: YELLOW, Vibrant: RED },
    { LightVibrant: 0.002, Vibrant: 0.046 },
  );
  const red = hue(swatches({ Vibrant: RED }), "light", VIBRANT);
  assert.equal(hue(neon, "light", MUTED), red);
  assert.equal(hue(neon, "light", { family: "large-vibrant", minShare: 0.05 }), red);
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
      for (const photo of all)
        for (const choice of [VIBRANT, MUTED, LARGE_VIBRANT]) {
          const result = photoColours(photo.swatches, mode, choice);
          if (!result) continue;
          const theme = generatePlayerTheme(
            result.accent ? { ...intent, accentSeed: result.accent } : intent,
            result.surfaces,
          );
          const failures = theme.diagnostics
            .filter((item) => item.passes === false && passing.has(key(item)))
            .map((item) => `${key(item)} ${item.ratio.toFixed(3)} < ${item.target}`);
          assert.deepEqual(failures, [], `${photo.name}, ${mode}, ${contrast}, ${choice.family}`);
        }
    }
});
