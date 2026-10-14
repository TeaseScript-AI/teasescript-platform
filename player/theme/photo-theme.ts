import { Hct, argbFromRgb } from "@material/material-color-utilities";
import type { OklchColor } from "./color.js";
import { tonalColor } from "./material.js";
import type { PhotoSurfaces, SurfaceTones } from "./palette.js";
import type { PhotoSwatches, SwatchName } from "./node-vibrant/swatches.js";

/**
 * Photo colours, "deep Vibrant" (owner, 2026-10-13): the Stage photo decides which colour the Player takes, its hue and
 * colourfulness, and the Player's own tones per mode decide how light it is. The surfaces follow one swatch of the
 * photo for the mode, of the family the "Photo colour family" A/B test chooses (owner, 2026-10-14), so the background,
 * the message bubbles, the composer, the buttons and the tools follow the photo together; the accent can follow its
 * Vibrant swatch.
 */
export interface PhotoColours {
  readonly surfaces: PhotoSurfaces;
  /** The accent seed in the photo's colour, or `null` when the photo has too little colour for one. */
  readonly accent: OklchColor | null;
  /** How strongly the background's far edges darken (dark mode) or pale (light mode) around the photo, 0..1. */
  readonly vignette: number;
}

export const PHOTO_FAMILIES = ["vibrant", "muted", "large-vibrant"] as const;
/**
 * The swatch family the surfaces take: the Vibrant family, the Muted family, or the Vibrant family only where its
 * swatch covers at least a share of the photo, else the Muted family, again only a swatch that covers the share. Light
 * and dark stay tied to the Player's mode: "Muted" is LightMuted in light mode and DarkMuted in dark mode.
 */
export type PhotoFamily = (typeof PHOTO_FAMILIES)[number];
export interface PhotoColourChoice {
  readonly family: PhotoFamily;
  /** The least share of the photo's measured pixels, 0..1, a swatch covers to count as large enough. */
  readonly minShare: number;
}

type Mode = "light" | "dark";
// Each family's swatch for the mode, then the family's mid swatch.
const FAMILIES: Readonly<
  Record<Mode, Readonly<Record<"vibrant" | "muted", readonly [mode: SwatchName, mid: SwatchName]>>>
> = {
  dark: { vibrant: ["DarkVibrant", "Vibrant"], muted: ["DarkMuted", "Muted"] },
  light: { vibrant: ["LightVibrant", "Vibrant"], muted: ["LightMuted", "Muted"] },
};

/**
 * The background swatches in order, the chosen family's first, then the ones that stand in when the photo has no such
 * colour. "Vibrant when large enough" takes a swatch of either family only when it covers the share, so a tiny detail
 * does not colour the Player, and otherwise the largest. A Vibrant swatch that stands in for a missing Muted one is the
 * larger one. Only the hue and the colourfulness are used, so the other mode's swatches can stand in last.
 */
function surfaceSwatches(swatches: PhotoSwatches, mode: Mode, choice: PhotoColourChoice) {
  const { vibrant, muted } = FAMILIES[mode];
  const other = FAMILIES[mode === "dark" ? "light" : "dark"];
  const share = (name: SwatchName) => swatches[name]?.share ?? 0;
  const large = (names: readonly SwatchName[]) =>
    names.filter((name) => share(name) >= choice.minShare);
  const bySize = (names: readonly SwatchName[]) =>
    [...names].sort((first, second) => share(second) - share(first));
  switch (choice.family) {
    case "vibrant":
      return [...vibrant, ...muted, other.vibrant[0], other.muted[0]];
    case "muted":
      return [...muted, ...bySize(vibrant), other.muted[0], other.vibrant[0]];
    case "large-vibrant":
      return [
        ...large(vibrant),
        ...large(muted),
        ...bySize([...vibrant, ...muted]),
        other.vibrant[0],
        other.muted[0],
      ];
  }
}

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
export function photoColours(
  swatches: PhotoSwatches,
  mode: Mode,
  choice: PhotoColourChoice,
): PhotoColours | null {
  const surface = hct(swatches, surfaceSwatches(swatches, mode, choice));
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
