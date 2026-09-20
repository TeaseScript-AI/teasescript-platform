import Color from "colorjs.io";

/** Concrete CSS colours only; no host variables, relative colours or executable CSS. */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const source = value.trim();
  if (
    !/^(?:#[\da-f]{3,8}|[a-z]+|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\))$/iu.test(source)
  )
    return null;
  if (/\b(?:from|none|calc|var|currentcolor)\b/iu.test(source)) return null;
  try {
    const color = new Color(source).to("oklch");
    const coordinates = color.coords.map((coordinate) => coordinate ?? 0);
    if (![...coordinates, color.alpha].every(Number.isFinite)) return null;
    const [lightness, chroma, hue] = coordinates.map((coordinate) =>
      Number(coordinate.toFixed(12)),
    );
    return `oklch(${lightness} ${chroma} ${hue} / ${Number(color.alpha.toFixed(12))})`;
  } catch {
    return null;
  }
}

export function isNormalizedColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^oklch\((-?[\d.]+) (-?[\d.]+) (-?[\d.]+) \/ ([\d.]+)\)$/u.exec(value);
  if (match === null) return false;
  const numbers = match.slice(1).map(Number);
  return numbers.every(Number.isFinite) && numbers[3]! >= 0 && numbers[3]! <= 1;
}
