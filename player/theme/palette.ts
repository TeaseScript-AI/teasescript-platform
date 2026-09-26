import { contrastRatio, mapToSrgb, mixColors, oklchCss, type OklchColor } from "./color.js";
import { accentTone, tonalColor } from "./material.js";

/** Local experiment intent; no persistence or authored-theme registration schema. */
export interface PlayerThemeIntent {
  readonly mode: "light" | "dark";
  readonly surfaceHue: number;
  readonly surfaceTint: number;
  readonly surfaceMaxChroma: 5 | 8.5 | 12;
  readonly monochrome: boolean;
  readonly accentSeed: OklchColor;
  readonly contrast: "standard" | "high";
}

export interface ContrastDiagnostic {
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number;
  readonly target: number | null;
  readonly passes: boolean | null;
}

export function generatePlayerTheme(intent: PlayerThemeIntent) {
  if (
    !intent ||
    !["light", "dark"].includes(intent.mode) ||
    !["standard", "high"].includes(intent.contrast) ||
    ![5, 8.5, 12].includes(intent.surfaceMaxChroma) ||
    typeof intent.monochrome !== "boolean" ||
    !Number.isFinite(intent.surfaceHue) ||
    !Number.isFinite(intent.surfaceTint) ||
    intent.surfaceTint < 0 ||
    intent.surfaceTint > 1
  ) {
    throw new RangeError("Invalid theme intent");
  }
  const dark = intent.mode === "dark";
  const high = intent.contrast === "high";
  const textTarget = high ? 7 : 4.5;
  // Material-oriented surface hierarchy; tuning remains provisional.
  const tones = {
    light: { canvas: 98, chrome: 95, raised: 92, floating: 99, control: 96 },
    dark: { canvas: 8, chrome: 12, raised: 18, floating: 26, control: 22 },
  }[intent.mode];
  const hue = ((intent.surfaceHue % 360) + 360) % 360;
  const chroma = intent.monochrome ? 0 : intent.surfaceTint * intent.surfaceMaxChroma;
  // Tint lives principally in the canvas. Less chroma in nested surfaces keeps the
  // high end of light tint usable without turning every layer into the same wash.
  const surface = (tone: number, tint = 1) =>
    tonalColor(chroma === 0 ? 0 : hue, chroma * tint, tone);
  // Keep the established translucent wash strength as the canvas tone changes.
  const ambientChroma = Math.min(24, chroma * 4);
  const ambientTone = dark ? tones.canvas + 11 : tones.canvas - 9;
  const neutral = (tone: number) => tonalColor(0, 0, tone);
  const black = neutral(0);
  const white = neutral(100);
  const accent = mapToSrgb(intent.accentSeed);
  // Prefer the established white primary label when it meets the experimental
  // normal-text target; lighter literal accents use black instead.
  const onAccent = contrastRatio(white, accent) >= 4.5 ? white : black;
  // Move enabled accent states away from their label, preserving readable text.
  const accentStateTarget = onAccent === white ? black : white;
  // Ghost controls live on both chrome and raised panels. Their states must clear
  // both backdrops; floating menus have a separate, lighter dark-mode backdrop.
  const panelTone = dark
    ? Math.max(tones.chrome, tones.raised)
    : Math.min(tones.chrome, tones.raised);
  const stateTone = (rest: number, lightOffset: number, darkOffset: number) =>
    surface(rest + (dark ? darkOffset : -lightOffset), 0.6);
  // Media chrome follows the Player polarity while retaining enough translucency
  // for the underlying image to remain part of the composition.
  const mediaSurface = surface(dark ? 24 : 94);
  const mediaText = neutral(dark ? 100 : 15);
  const base = {
    "surface-canvas": surface(tones.canvas),
    "surface-chrome": surface(tones.chrome, dark ? 0.85 : 0.75),
    "surface-raised": surface(tones.raised, dark ? 0.75 : 0.45),
    "surface-floating": surface(tones.floating, dark ? 0.6 : 0.2),
    "surface-control": surface(tones.control, dark ? 0.7 : 0.6),
    "surface-selected": stateTone(panelTone, 11, 12),
    "ambient-wash": tonalColor(ambientChroma === 0 ? 0 : hue, ambientChroma, ambientTone),
    "border-subtle": neutral(dark ? (high ? 60 : 38) : high ? 50 : 80),
    "border-floating": neutral(dark ? (high ? 72 : 48) : high ? 45 : 72),
    "border-default": neutral(dark ? (high ? 75 : 52) : high ? 35 : 65),
    "border-strong": neutral(dark ? (high ? 90 : 70) : high ? 20 : 45),
    "text-primary": neutral(dark ? (high ? 100 : 96) : high ? 0 : 18),
    "text-secondary": neutral(dark ? (high ? 96 : 80) : high ? 18 : 40),
    "text-on-accent": onAccent,
    "accent-solid": accent,
    "accent-soft": accentTone(accent, dark ? 25 : 92),
    "accent-focus": accentTone(accent, dark ? (high ? 90 : 80) : high ? 25 : 40),
    "overlay-surface": black,
    "overlay-text": white,
    "media-text": mediaText,
    "media-text-disabled": mixColors(mediaSurface, mediaText, 0.55),
  };
  const roles = {
    ...base,
    "surface-hover": stateTone(panelTone, 7, 8),
    "surface-pressed": stateTone(panelTone, 15, 17),
    "control-hover": stateTone(tones.control, 7, 7),
    "control-pressed": stateTone(tones.control, 13, 13),
    "floating-hover": stateTone(tones.floating, 8, 9),
    "floating-pressed": stateTone(tones.floating, 14, 15),
    "surface-disabled": mixColors(base["surface-control"], base["surface-raised"], 0.5),
    "border-disabled": mixColors(base["surface-raised"], base["border-default"], 0.38),
    "text-disabled": mixColors(base["surface-raised"], base["text-primary"], 0.38),
    "accent-hover": mixColors(accent, accentStateTarget, 0.08),
    "accent-pressed": mixColors(accent, accentStateTarget, 0.16),
  };
  const diagnostics: ContrastDiagnostic[] = [];
  const inspect = (
    foreground: keyof typeof roles,
    background: keyof typeof roles,
    target: number | null,
  ) => {
    const ratio = contrastRatio(roles[foreground], roles[background]);
    diagnostics.push({
      foreground,
      background,
      ratio,
      target,
      passes: target === null ? null : ratio >= target,
    });
  };
  for (const background of [
    "surface-canvas",
    "surface-chrome",
    "surface-raised",
    "surface-floating",
    "surface-control",
    "surface-hover",
    "surface-pressed",
    "surface-selected",
    "control-hover",
    "control-pressed",
    "floating-hover",
    "floating-pressed",
    "accent-soft",
  ] as const) {
    inspect("text-primary", background, textTarget);
    inspect("text-secondary", background, textTarget);
    inspect("accent-focus", background, high ? 4.5 : 3);
    inspect("border-strong", background, high ? 4.5 : 3);
  }
  for (const background of ["accent-solid", "accent-hover", "accent-pressed"] as const) {
    inspect("text-on-accent", background, textTarget);
    inspect(background, "surface-raised", 3);
  }
  inspect("text-disabled", "surface-disabled", null);
  const effects = {
    "overlay-shadow": { color: black, alpha: 0.65 },
    "overlay-track": { color: white, alpha: 0.82 },
    // Opposite-polarity media remains possible, so each material retains enough
    // coverage for its glyphs while leaving the image visibly present.
    "media-surface": { color: mediaSurface, alpha: dark ? 0.62 : 0.58 },
    "media-hover": { color: surface(dark ? 34 : 86), alpha: dark ? 0.72 : 0.68 },
    "media-pressed": { color: surface(dark ? 42 : 78), alpha: dark ? 0.82 : 0.78 },
    "media-border": { color: mediaText, alpha: dark ? 0.3 : 0.22 },
    "media-shadow": { color: black, alpha: 0.22 },
    "floating-shadow": { color: black, alpha: dark ? 0.55 : 0.18 },
    "structural-shadow": { color: black, alpha: dark ? 0.35 : 0.08 },
    "structural-scrim": { color: black, alpha: dark ? 0.55 : 0.18 },
  };
  return { roles, effects, diagnostics };
}

export type ResolvedPlayerTheme = ReturnType<typeof generatePlayerTheme>;

/** Variables belong on the consumer scope, never implicitly on document/root. */
export function themeCssVariables(theme: ResolvedPlayerTheme): Record<string, string> {
  return Object.fromEntries([
    ...Object.entries(theme.roles).map(([name, color]) => [`--theme-${name}`, oklchCss(color)]),
    ...Object.entries(theme.effects).map(([name, effect]) => [
      `--theme-${name}`,
      oklchCss(effect.color, effect.alpha),
    ]),
  ]);
}
