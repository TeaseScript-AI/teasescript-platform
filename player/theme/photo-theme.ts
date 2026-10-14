import { Hct, argbFromRgb } from "@material/material-color-utilities";
import type { OklchColor } from "./color.js";
import { tonalColor } from "./material.js";
import type { PhotoSurfaces, SurfaceTones } from "./palette.js";
import type { PhotoSwatches, SwatchName } from "./node-vibrant/swatches.js";

/**
 * Photo colours, "deep Vibrant" (owner, 2026-10-13): the Stage photo decides which colour the Player takes, its hue and
 * colourfulness, and the Player's own tones per mode decide how light it is. The surfaces follow the photo's
 * Vibrant-family swatch for the mode, so the background, the message bubbles, the composer, the buttons and the tools
 * follow the photo together; the accent can follow its Vibrant swatch.
 */
export interface PhotoColours {
  readonly surfaces: PhotoSurfaces;
  /** The accent seed in the photo's colour, or `null` when the photo has too little colour for one. */
  readonly accent: OklchColor | null;
  /** How strongly the background's far edges darken (dark mode) or pale (light mode) around the photo, 0..1. */
  readonly vignette: number;
}

// The background swatch per mode, then the ones that stand in when the photo has no such colour. Only the hue and the
// colourfulness are used, so the other mode's swatches can stand in last.
const SURFACE_SWATCHES: Readonly<Record<"light" | "dark", readonly SwatchName[]>> = {
  dark: ["DarkVibrant", "Vibrant", "DarkMuted", "Muted", "LightVibrant", "LightMuted"],
  light: ["LightVibrant", "Vibrant", "LightMuted", "Muted", "DarkVibrant", "DarkMuted"],
};
const ACCENT_SWATCHES: readonly SwatchName[] = ["Vibrant", "DarkVibrant", "LightVibrant"];

interface ModeColours {
  readonly tones: SurfaceTones;
  /** The most chroma the surfaces take: a vivid photo still gives a calm Player. */
  readonly chroma: number;
  readonly vignette: number;
}

// Dark: a coloured canvas a little lighter than the theme's, with darker message bubbles on it.
const DARK: ModeColours = {
  tones: { canvas: 18, chrome: 13, raised: 11, floating: 26, control: 22 },
  chroma: 28,
  vignette: 0.6,
};
// Light: a light canvas in the photo's colour with lighter bubbles on it, and paler edges around the photo, so the
// centre around the photo reads deeper than the edges ("subtle", owner, 2026-10-13). The canvas tone stays where
// secondary text on it keeps its contrast.
const LIGHT: ModeColours = {
  tones: { canvas: 89, chrome: 94, raised: 98, floating: 99, control: 97 },
  chroma: 22,
  vignette: 0.7,
};
// Below this HCT chroma the photo counts as grey: the Player stays neutral at its photo tones instead of tinting with
// noise.
const GREY_CHROMA = 4;
// The photo accent needs this much colour, or the theme's accent stays. It takes the photo's hue at a tone where white
// labels stay readable, with at least `ACCENT_MIN_CHROMA` so it reads as an accent.
const ACCENT_PHOTO_CHROMA = 16;
const ACCENT_MIN_CHROMA = 48;
const ACCENT_TONE = 45;

function hct(swatches: PhotoSwatches, names: readonly SwatchName[]) {
  for (const name of names) {
    const colour = swatches[name];
    if (colour) return Hct.fromInt(argbFromRgb(...colour.rgb));
  }
  return null;
}

/** The Player's colours for a photo in one mode, or `null` when the photo has no measured colour at all. */
export function photoColours(swatches: PhotoSwatches, mode: "light" | "dark"): PhotoColours | null {
  const surface = hct(swatches, SURFACE_SWATCHES[mode]);
  if (!surface) return null;
  const colours = mode === "dark" ? DARK : LIGHT;
  const grey = surface.chroma < GREY_CHROMA;
  const accent = hct(swatches, ACCENT_SWATCHES);
  return {
    surfaces: {
      hue: grey ? 0 : surface.hue,
      chroma: grey ? 0 : Math.min(surface.chroma, colours.chroma),
      tones: colours.tones,
    },
    accent:
      accent && accent.chroma >= ACCENT_PHOTO_CHROMA
        ? tonalColor(accent.hue, Math.max(accent.chroma, ACCENT_MIN_CHROMA), ACCENT_TONE)
        : null,
    vignette: colours.vignette,
  };
}
