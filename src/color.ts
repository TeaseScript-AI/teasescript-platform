import Color from "colorjs.io";

const NORMALIZED_NUMBER = "(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)";
const NORMALIZED_COLOR = new RegExp(
  `^oklch\\(${NORMALIZED_NUMBER} ${NORMALIZED_NUMBER} ${NORMALIZED_NUMBER}\\)$`,
  "u",
);

// Color.js also parses non-CSS separators and does not clamp input channels.
// Keep the supported CSS grammar here; conversion remains with the library.
const CSS_NUMBER = "[+-]?(?:\\d*\\.\\d+|\\d+)(?:e[+-]?\\d+)?";
const CSS_PERCENTAGE = `${CSS_NUMBER}%`;
const CSS_COMPONENT = `${CSS_NUMBER}%?`;
const CSS_HUE = `${CSS_NUMBER}(?:deg|grad|rad|turn)?`;

function modern(first: string, second: string, third: string): string {
  return `${first}\\s+${second}\\s+${third}(?:\\s*/\\s*${CSS_COMPONENT})?`;
}

function legacy(first: string, second: string, third: string): string {
  return `${first}\\s*,\\s*${second}\\s*,\\s*${third}(?:\\s*,\\s*${CSS_COMPONENT})?`;
}

const RGB_CHANNELS = new RegExp(
  `^\\s*(?:${modern(CSS_COMPONENT, CSS_COMPONENT, CSS_COMPONENT)}|${legacy(CSS_NUMBER, CSS_NUMBER, CSS_NUMBER)}|${legacy(CSS_PERCENTAGE, CSS_PERCENTAGE, CSS_PERCENTAGE)})\\s*$`,
  "u",
);
const HSL_CHANNELS = new RegExp(
  `^\\s*(?:${modern(CSS_HUE, CSS_COMPONENT, CSS_COMPONENT)}|${legacy(CSS_HUE, CSS_PERCENTAGE, CSS_PERCENTAGE)})\\s*$`,
  "u",
);
const HWB_CHANNELS = new RegExp(`^\\s*${modern(CSS_HUE, CSS_COMPONENT, CSS_COMPONENT)}\\s*$`, "u");
const LAB_CHANNELS = new RegExp(
  `^\\s*${modern(CSS_COMPONENT, CSS_COMPONENT, CSS_COMPONENT)}\\s*$`,
  "u",
);
const LCH_CHANNELS = new RegExp(`^\\s*${modern(CSS_COMPONENT, CSS_COMPONENT, CSS_HUE)}\\s*$`, "u");

function validFunction(name: string, channels: string): boolean {
  switch (name) {
    case "rgb":
    case "rgba":
      return RGB_CHANNELS.test(channels);
    case "hsl":
    case "hsla":
      return HSL_CHANNELS.test(channels);
    case "hwb":
      return HWB_CHANNELS.test(channels);
    case "lab":
    case "oklab":
      return LAB_CHANNELS.test(channels);
    case "lch":
    case "oklch":
      return LCH_CHANNELS.test(channels);
    default:
      return false;
  }
}

function clampInputChannels(color: Color): void {
  const clamp = (index: 0 | 1 | 2, upper: number) => {
    color.coords[index] = Math.min(upper, Math.max(0, color.coords[index] ?? 0));
  };
  switch (color.space.id) {
    case "srgb":
      clamp(0, 1);
      clamp(1, 1);
      clamp(2, 1);
      break;
    case "hsl":
    case "hwb":
      clamp(1, 100);
      clamp(2, 100);
      break;
    case "lab":
    case "lch":
      clamp(0, 100);
      if (color.space.id === "lch") clamp(1, Infinity);
      break;
    case "oklab":
    case "oklch":
      clamp(0, 1);
      if (color.space.id === "oklch") clamp(1, Infinity);
      break;
  }
}

/**
 * Concrete opaque CSS colours only; no host variables, relative colours or executable CSS.
 *
 * A colour that lets what is behind it through is not a colour a story can hand over: the
 * surface beneath it belongs to the Player and changes with the reader's theme, so the
 * result would be something nobody chose. Every colour arriving from a story passes here,
 * which is why the rule lives here and needs no exception anywhere downstream. The
 * Player's own interface is not bound by it.
 */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const source = value.trim().toLowerCase();
  const functional = /^([a-z]+)\(([^()]*)\)$/u.exec(source);
  if (functional !== null) {
    if (!validFunction(functional[1]!, functional[2]!)) return null;
  } else if (!/^(?:#[\da-f]{3,8}|[a-z]+)$/u.test(source)) return null;
  try {
    const parsed = new Color(source);
    if (
      ![...parsed.coords, parsed.alpha].every(
        (coordinate) => coordinate === null || Number.isFinite(coordinate),
      )
    )
      return null;
    if (parsed.alpha !== 1) return null;
    clampInputChannels(parsed);
    const color = parsed.to("oklch");
    const coordinates = color.coords.map((coordinate) => coordinate ?? 0);
    if (!coordinates.every(Number.isFinite)) return null;
    const [lightness, chroma, hue] = coordinates;
    return `oklch(${lightness} ${chroma} ${hue})`;
  } catch {
    return null;
  }
}

export function isNormalizedColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = NORMALIZED_COLOR.exec(value);
  return match !== null && match.slice(1).map(Number).every(Number.isFinite);
}

/** Opaque authored surfaces share the CSS parser without accepting theme-dependent transparency. */
export function normalizeOpaqueColor(value: unknown): string | null {
  const color = normalizeColor(value);
  return color !== null && new Color(color).alpha === 1 ? color : null;
}

export function isNormalizedOpaqueColor(value: unknown): value is string {
  return isNormalizedColor(value) && new Color(value).alpha === 1;
}
