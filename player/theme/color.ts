import Color from "colorjs.io";
import { normalizeOpaqueColor } from "../../src/color.js";

/** Our plain, opaque color value; dependency objects stay inside this adapter. */
export interface OklchColor {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

function colorValue(color: OklchColor): Color {
  if (
    !color ||
    !Number.isFinite(color.l) ||
    color.l < 0 ||
    color.l > 1 ||
    !Number.isFinite(color.c) ||
    color.c < 0 ||
    !Number.isFinite(color.h)
  ) {
    throw new RangeError("Expected finite OKLCH with lightness 0..1 and nonnegative chroma");
  }
  return new Color("oklch", [color.l, color.c, color.h]);
}

function plain(color: Color): OklchColor {
  const [l, c, h] = color.to("oklch").coords;
  if (l === null || c === null || !Number.isFinite(l) || !Number.isFinite(c)) {
    throw new RangeError("Color conversion did not produce finite lightness/chroma");
  }
  // Powerless hue has no meaning in a realized literal white/black/gray.
  const neutral = c < 1e-7 || l <= 0 || l >= 1;
  return {
    l: Math.max(0, Math.min(1, l)),
    c: neutral ? 0 : c,
    h: neutral || h === null || !Number.isFinite(h) ? 0 : ((h % 360) + 360) % 360,
  };
}

export function mapToSrgb(color: OklchColor): OklchColor {
  return plain(colorValue(color).toGamut({ space: "srgb", method: "css" }));
}

export function inSrgbGamut(color: OklchColor): boolean {
  return colorValue(color).inGamut("srgb");
}

export function contrastRatio(first: OklchColor, second: OklchColor): number {
  return Color.contrast(colorValue(first), colorValue(second), "WCAG21");
}

/** Choose against the realized opaque fill, not OKLCH lightness alone. */
export function blackOrWhiteInk(background: OklchColor): "#000000" | "#ffffff" {
  const fill = mapToSrgb(background);
  const black = { l: 0, c: 0, h: 0 };
  const white = { l: 1, c: 0, h: 0 };
  return contrastRatio(fill, black) >= contrastRatio(fill, white) ? "#000000" : "#ffffff";
}

export function mixColors(
  background: OklchColor,
  foreground: OklchColor,
  amount: number,
): OklchColor {
  return plain(
    colorValue(background)
      .mix(colorValue(foreground), amount, { space: "oklab" })
      .toGamut({ space: "srgb", method: "css" }),
  );
}

export function oklchCss(color: OklchColor, alpha = 1): string {
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new RangeError("Invalid alpha");
  return colorValue(color).set({ alpha }).toString({ precision: 8 });
}

/** Native picker acquisition is a realized literal color, never surface tint intent. */
export function pickerHexToOklch(hex: string): OklchColor {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new RangeError("Expected a six-digit picker color");
  return plain(new Color(hex));
}

export function oklchToPickerHex(color: OklchColor): string {
  return colorValue(color)
    .to("srgb")
    .toGamut({ method: "css" })
    .toString({ format: "hex", collapse: false });
}

export function authoredColorToOklch(value: string): OklchColor {
  const normalized = normalizeOpaqueColor(value);
  if (normalized === null) throw new RangeError("Expected an opaque authored CSS colour");
  return plain(new Color(normalized));
}
