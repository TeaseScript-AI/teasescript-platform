/** Canonical opaque OKLCH: lightness 0..1, nonnegative chroma, hue in degrees. */
export interface OklchColor {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

export function normalizeColor(color: OklchColor): OklchColor {
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
  const hue = color.h % 360;
  return { l: color.l, c: color.c, h: hue < 0 ? hue + 360 : hue };
}

/** CSS Color 4 OKLab -> linear sRGB matrices. No channel clipping here. */
export function linearSrgb(color: OklchColor): readonly [number, number, number] {
  const { l, c, h } = normalizeColor(color);
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const ll = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const ss = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
    -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
    -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss,
  ];
}

export function inSrgbGamut(color: OklchColor): boolean {
  return linearSrgb(color).every((channel) => channel >= -1e-7 && channel <= 1 + 1e-7);
}

/** Preserve lightness/hue; reduce chroma. sRGB fits inside OKLCH chroma 1. */
export function mapToSrgb(color: OklchColor): OklchColor {
  const normalized = normalizeColor(color);
  if (normalized.l === 0 || normalized.l === 1) return { ...normalized, c: 0 };
  if (inSrgbGamut(normalized)) return normalized;
  let low = 0;
  let high = Math.min(normalized.c, 1);
  for (let iteration = 0; iteration < 28; iteration++) {
    const c = (low + high) / 2;
    if (inSrgbGamut({ ...normalized, c })) low = c;
    else high = c;
  }
  return { ...normalized, c: low };
}

/** WCAG relative luminance ratio for opaque, gamut-mapped colors. Not a compliance verdict. */
export function contrastRatio(first: OklchColor, second: OklchColor): number {
  function luminance(color: OklchColor): number {
    const [r, g, b] = linearSrgb(mapToSrgb(color));
    return Math.max(0, Math.min(1, 0.2126 * r + 0.7152 * g + 0.0722 * b));
  }
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function oklchCss(color: OklchColor, alpha = 1): string {
  const { l, c, h } = normalizeColor(color);
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new RangeError("Invalid alpha");
  return `oklch(${l} ${c} ${h} / ${alpha})`;
}

/** Native picker input adapter only; callers retain OKLCH, not hex, as intent. */
export function pickerHexToOklch(hex: string): OklchColor {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new RangeError("Expected a six-digit picker color");
  const decode = (offset: number) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const r = decode(1),
    g = decode(3),
    b = decode(5);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.hypot(a, bb);
  return mapToSrgb({
    l: Math.max(0, Math.min(1, 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s)),
    c: chroma < 1e-7 ? 0 : chroma,
    h: chroma < 1e-7 ? 0 : (Math.atan2(bb, a) * 180) / Math.PI,
  });
}

export function oklchToPickerHex(color: OklchColor): string {
  return (
    "#" +
    linearSrgb(mapToSrgb(color))
      .map((channel) => {
        const encoded =
          channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
        return Math.round(Math.max(0, Math.min(1, encoded)) * 255)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}
