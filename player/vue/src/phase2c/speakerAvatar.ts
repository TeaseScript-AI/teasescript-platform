import { normalizeOpaqueColor } from "../../../../src/color.js";
import { authoredColorToOklch, contrastRatio, mixColors, oklchCss } from "../../../theme/color.js";

// Distinct, readable letter/fill pairs; the same identities work in both Player themes.
const defaultColors = [
  { background: "#075b43", color: "#37e6a2" },
  { background: "#3e3a75", color: "#c1b9ff" },
  { background: "#154a73", color: "#8bd0ff" },
  { background: "#783d26", color: "#ffc49d" },
  { background: "#6b3159", color: "#ffaddf" },
  { background: "#5b501b", color: "#f4d973" },
] as const;

export function speakerAvatarColors(accent: string | undefined, ordinal: number) {
  const authored = normalizeOpaqueColor(accent);
  if (authored === null) return defaultColors[Math.max(ordinal, 0) % defaultColors.length]!;

  // Keep the author's exact colour on the letter; choose a tinted fill behind it.
  const ink = authoredColorToOklch(authored);
  const dark = mixColors(ink, { l: 0, c: 0, h: 0 }, 0.86);
  const light = mixColors(ink, { l: 1, c: 0, h: 0 }, 0.86);
  const background = contrastRatio(ink, dark) >= contrastRatio(ink, light) ? dark : light;
  const extreme =
    contrastRatio(ink, dark) >= contrastRatio(ink, light)
      ? { l: 0, c: 0, h: 0 }
      : { l: 1, c: 0, h: 0 };
  return {
    background: oklchCss(contrastRatio(ink, background) >= 4.5 ? background : extreme),
    color: authored,
  };
}
