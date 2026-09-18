import { contrastRatio, mixColors, oklchCss, type OklchColor } from "./color.js";
import { materialRoles } from "./material.js";

/** Local experiment intent; no persistence or authored-theme registration schema. */
export interface PlayerThemeIntent {
  readonly mode: "light" | "dark";
  readonly surfaceHue: number;
  readonly surfaceTint: number;
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
  const { shadow, scrim, ...base } = materialRoles(
    intent.accentSeed,
    dark,
    high,
    ((intent.surfaceHue % 360) + 360) % 360,
    intent.surfaceTint,
  );
  // Local semantic state mapping, not a replacement for Material role-tone logic.
  const state = (amount: number) => mixColors(base["surface-raised"], base["text-primary"], amount);
  const roles = {
    ...base,
    "surface-hover": state(0.08),
    "surface-pressed": state(0.12),
    "surface-disabled": state(0.12),
    "border-disabled": mixColors(base["surface-raised"], base["border-default"], 0.38),
    "text-disabled": mixColors(base["surface-raised"], base["text-primary"], 0.38),
    "accent-hover": mixColors(base["accent-solid"], base["text-on-accent"], 0.08),
    "accent-pressed": mixColors(base["accent-solid"], base["text-on-accent"], 0.12),
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
    "structural-shadow": { color: shadow, alpha: dark ? 0.35 : 0.08 },
    "structural-scrim": { color: scrim, alpha: dark ? 0.55 : 0.18 },
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
