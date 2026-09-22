import {
  authoredColorToOklch,
  blackOrWhiteInk,
  contrastRatio,
  mapToSrgb,
  oklchCss,
  type OklchColor,
} from "./color.js";

/** Opaque story-button material, shared by theme defaults and literal authored fills. */
export function storyChoiceVariables(input: OklchColor): Record<string, string> {
  const base = mapToSrgb(input);
  const ink = authoredColorToOklch(blackOrWhiteInk(base));
  const shift = (amount: number) =>
    mapToSrgb({ ...base, l: Math.max(0, Math.min(1, base.l + amount)) });
  let fills: Record<string, OklchColor> = {};
  // Reduce relief near the contrast boundary instead of changing the author's base colour.
  for (let attempt = 0; attempt <= 12; attempt++) {
    const strength = attempt === 12 ? 0 : 0.75 ** attempt;
    fills = {
      top: shift(0.035 * strength),
      bottom: shift(-0.025 * strength),
      "hover-top": shift(0.055 * strength),
      "hover-bottom": shift(-0.005 * strength),
      pressed: shift(-0.025 * strength),
    };
    if (Object.values(fills).every((fill) => contrastRatio(ink, fill) >= 4.5)) break;
  }
  return Object.fromEntries(
    Object.entries({ ...fills, ink, depth: shift(-0.13), rim: shift(-0.075) }).map(
      ([name, color]) => [`--story-choice-${name}`, oklchCss(color)],
    ),
  );
}
