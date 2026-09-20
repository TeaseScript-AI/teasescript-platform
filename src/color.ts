import Color from "colorjs.io";

const NORMALIZED_NUMBER = "(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)";
const NORMALIZED_COLOR = new RegExp(
  `^oklch\\(${NORMALIZED_NUMBER} ${NORMALIZED_NUMBER} ${NORMALIZED_NUMBER} / ${NORMALIZED_NUMBER}\\)$`,
  "u",
);

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
    const [lightness, chroma, hue] = coordinates;
    return `oklch(${lightness} ${chroma} ${hue} / ${color.alpha})`;
  } catch {
    return null;
  }
}

export function isNormalizedColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = NORMALIZED_COLOR.exec(value);
  if (match === null) return false;
  const numbers = match.slice(1).map(Number);
  return numbers.every(Number.isFinite) && numbers[3]! >= 0 && numbers[3]! <= 1;
}
