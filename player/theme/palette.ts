import { contrastRatio, mapToSrgb, normalizeColor, oklchCss, type OklchColor } from "./color.js";

/** Experimental platform palette intent, not an authored-theme registration API. */
export interface PlayerThemeIntent {
  readonly mode: "light" | "dark";
  readonly surfaceSeed: OklchColor;
  readonly accentSeed: OklchColor;
  readonly contrast: "standard" | "high";
}

export interface ContrastDiagnostic {
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number;
  /** Provisional evaluation target; null means informational (e.g. disabled text). */
  readonly target: number | null;
  readonly passes: boolean | null;
}

/** Move only lightness toward a polarity endpoint until all backgrounds meet the target. */
function readable(
  seed: OklchColor,
  backgrounds: readonly OklchColor[],
  target: number,
  endpoint: 0 | 1,
): OklchColor {
  for (let step = 0; step <= 100; step++) {
    const candidate = mapToSrgb({ ...seed, l: seed.l + ((endpoint - seed.l) * step) / 100 });
    if (backgrounds.every((background) => contrastRatio(candidate, background) >= target))
      return candidate;
  }
  // Any unsatisfied pair remains visible in diagnostics rather than being silently certified.
  return mapToSrgb({ ...seed, l: endpoint });
}

export function generatePlayerTheme(intent: PlayerThemeIntent) {
  if (
    !intent ||
    (intent.mode !== "light" && intent.mode !== "dark") ||
    (intent.contrast !== "standard" && intent.contrast !== "high")
  ) {
    throw new RangeError("Invalid theme mode or contrast preference");
  }
  const surface = normalizeColor(intent.surfaceSeed);
  const accent = normalizeColor(intent.accentSeed);
  const dark = intent.mode === "dark";
  const high = intent.contrast === "high";
  const textTarget = high ? 7 : 4.5;
  const neutral = (l: number) => mapToSrgb({ l, c: Math.min(surface.c, 0.035), h: surface.h });
  // Separate polarity hierarchies. Seed lightness tunes within each hierarchy; it is not a scene fill.
  const base = dark ? 0.13 + surface.l * 0.05 : 0.93 + surface.l * 0.04;
  const surfaces = {
    "surface-canvas": neutral(base),
    "surface-chrome": neutral(dark ? base + 0.03 : base + 0.015),
    "surface-raised": neutral(dark ? base + 0.07 : Math.min(0.995, base + 0.035)),
    "surface-floating": neutral(dark ? base + 0.11 : 0.998),
    "surface-hover": neutral(dark ? base + 0.14 : base - 0.035),
    "surface-pressed": neutral(dark ? base + 0.18 : base - 0.07),
    "surface-selected": neutral(dark ? base + 0.16 : base - 0.055),
  };
  const accentSoft = mapToSrgb({
    ...accent,
    l: dark ? base + 0.12 : base - 0.02,
    c: Math.min(accent.c, 0.045),
  });
  const backgrounds = [...Object.values(surfaces), accentSoft];
  const textEndpoint = dark ? 1 : 0;
  const onAccent = neutral(dark ? 0 : 1);
  const solid = readable(
    { ...accent, l: dark ? 0.65 + accent.l * 0.15 : 0.45 + accent.l * 0.25 },
    [onAccent],
    textTarget,
    dark ? 1 : 0,
  );
  const roles = {
    ...surfaces,
    "border-subtle": neutral(dark ? base + 0.2 : base - 0.14),
    "border-default": neutral(dark ? base + 0.3 : base - 0.22),
    "border-strong": readable(
      neutral(dark ? 0.65 : 0.48),
      backgrounds,
      high ? 4.5 : 3,
      textEndpoint,
    ),
    "text-primary": readable(neutral(dark ? 0.94 : 0.25), backgrounds, textTarget, textEndpoint),
    "text-secondary": readable(neutral(dark ? 0.74 : 0.48), backgrounds, textTarget, textEndpoint),
    "text-disabled": neutral(dark ? 0.55 : 0.6),
    "text-on-accent": onAccent,
    "accent-solid": solid,
    "accent-hover": mapToSrgb({
      ...solid,
      l: dark ? solid.l + (1 - solid.l) * 0.1 : solid.l * 0.94,
    }),
    "accent-pressed": mapToSrgb({
      ...solid,
      l: dark ? solid.l + (1 - solid.l) * 0.2 : solid.l * 0.87,
    }),
    "accent-soft": accentSoft,
    "accent-focus": readable(
      { ...accent, l: dark ? 0.8 : 0.45 },
      backgrounds,
      high ? 4.5 : 3,
      textEndpoint,
    ),
    "surface-disabled": neutral(dark ? base + 0.06 : base - 0.04),
    "border-disabled": neutral(dark ? base + 0.13 : base - 0.12),
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
  const shadowColor = neutral(dark ? 0 : 0.25);
  const effects = {
    "structural-shadow": { color: shadowColor, alpha: dark ? 0.35 : 0.08 },
    "structural-scrim": { color: shadowColor, alpha: dark ? 0.55 : 0.18 },
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
