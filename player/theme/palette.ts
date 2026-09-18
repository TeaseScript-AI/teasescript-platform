import { contrastRatio, mapToSrgb, mixColors, oklchCss, type OklchColor } from "./color.js";
import { accentTone, tonalColor } from "./material.js";

/** Local experiment intent; no persistence or authored-theme registration schema. */
export interface PlayerThemeIntent {
  readonly mode: "light" | "dark";
  readonly surfaceHue: number;
  readonly surfaceTint: number;
  readonly surfaceMaxChroma: 5 | 8.5 | 12;
  readonly surfaceLadder: "material" | "teasescript";
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
    !["material", "teasescript"].includes(intent.surfaceLadder) ||
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
  // Temporary role-tone comparisons, not accepted theme policy. The Material-oriented
  // reference preserves the previous hierarchy without accent-dependent scheme tones.
  // TeaseScript's light candidate rises toward white; dark starts above near-black.
  const ladders = {
    material: { light: [98, 96, 94, 92, 90], dark: [4, 6, 9, 12, 15] },
    teasescript: {
      light: high ? [92, 97, 100, 100, 86] : [95, 97, 99, 100, 91],
      dark: high ? [8, 15, 23, 28, 32] : [14, 18, 23, 28, 32],
    },
  } as const;
  const tones = ladders[intent.surfaceLadder][intent.mode];
  const hue = ((intent.surfaceHue % 360) + 360) % 360;
  const chroma = intent.monochrome ? 0 : intent.surfaceTint * intent.surfaceMaxChroma;
  // The ambient wash is translucent, so it needs a wider but still bounded tint range
  // to remain perceptible after compositing over the canvas.
  const ambientChroma = Math.min(24, chroma * 4);
  const ambientTone = dark ? Math.min(tones[4], tones[0] + 11) : 86;
  const surface = (tone: number) => tonalColor(chroma === 0 ? 0 : hue, chroma, tone);
  const neutral = (tone: number) => tonalColor(0, 0, tone);
  const black = neutral(0);
  const white = neutral(100);
  const accent = mapToSrgb(intent.accentSeed);
  const onAccent = contrastRatio(white, accent) >= contrastRatio(black, accent) ? white : black;
  // Move enabled accent states away from their label, preserving readable text.
  const accentStateTarget = onAccent === white ? black : white;
  const base = {
    "surface-canvas": surface(tones[0]),
    "surface-chrome": surface(tones[1]),
    "surface-raised": surface(tones[2]),
    "surface-floating": surface(tones[3]),
    "surface-selected": surface(tones[4]),
    "ambient-wash": tonalColor(ambientChroma === 0 ? 0 : hue, ambientChroma, ambientTone),
    "border-subtle": neutral(dark ? (high ? 60 : 38) : high ? 50 : 80),
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
  };
  const state = (amount: number) => mixColors(base["surface-raised"], base["text-primary"], amount);
  const roles = {
    ...base,
    "surface-hover": state(0.08),
    "surface-pressed": state(0.16),
    "surface-disabled": state(0.12),
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
    "surface-hover",
    "surface-pressed",
    "surface-selected",
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
    "overlay-shadow": { color: black, alpha: 0.48 },
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
