import Color from "colorjs.io";

import { atan2Degrees, cosDegrees, cubeRoot, sinDegrees } from "./deterministic-math.js";
import { positivePower } from "./numeric-functions.js";

const NORMALIZED_NUMBER = "(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)";
const NORMALIZED_COLOR = new RegExp(
  `^oklch\\(${NORMALIZED_NUMBER} ${NORMALIZED_NUMBER} ${NORMALIZED_NUMBER}\\)$`,
  "u",
);

// Color.js also parses non-CSS separators and does not clamp input channels.
// Keep the supported CSS grammar here; colorjs.io parses, and this module converts.
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

/** A parsed authored colour as plain data: colorjs.io parses it; this module converts it. */
interface ParsedColor {
  readonly spaceId: string;
  readonly coords: [number, number, number];
  readonly alpha: number;
}

function clampInputChannels(color: ParsedColor): void {
  const clamp = (index: 0 | 1 | 2, upper: number) => {
    color.coords[index] = Math.min(upper, Math.max(0, color.coords[index]));
  };
  switch (color.spaceId) {
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
      if (color.spaceId === "lch") clamp(1, Infinity);
      break;
    case "oklab":
    case "oklch":
      clamp(0, 1);
      if (color.spaceId === "oklch") clamp(1, Infinity);
      break;
  }
}

/** A concrete CSS colour, also one that is not opaque; no host variables, relative colours or executable CSS. */
function parseColor(value: unknown): ParsedColor | null {
  if (typeof value !== "string") return null;
  const source = value.trim().toLowerCase();
  const functional = /^([a-z]+)\(([^()]*)\)$/u.exec(source);
  if (functional !== null) {
    if (!validFunction(functional[1]!, functional[2]!)) return null;
  } else if (!/^(?:#[\da-f]{3,8}|[a-z]+)$/u.test(source)) return null;
  try {
    const parsed = new Color(source);
    // A channel colorjs.io leaves without a value (`none`) is 0, as its conversions take it.
    const color: ParsedColor = {
      spaceId: parsed.space.id,
      coords: [parsed.coords[0] ?? 0, parsed.coords[1] ?? 0, parsed.coords[2] ?? 0],
      alpha: parsed.alpha,
    };
    return [...color.coords, color.alpha].every((coordinate) => Number.isFinite(coordinate))
      ? color
      : null;
  } catch {
    return null;
  }
}

/** Whether `value` is a CSS colour that `normalizeColor` rejects because it is not opaque, as `transparent` is. */
export function isSeeThroughColor(value: unknown): boolean {
  const parsed = parseColor(value);
  return parsed !== null && parsed.alpha !== 1;
}

/**
 * Concrete opaque CSS colours only; no host variables, relative colours or executable CSS. The text is the same in
 * every JavaScript engine for an authored colour whose numbers have at most 20 significant digits (ECMAScript lets an
 * engine read a longer number either way): the conversion uses only operations ECMAScript specifies exactly
 * (`+ - * /`, `Math.sqrt`, the engine-independent functions of `deterministic-math.ts` and `positivePower`), and
 * `formatNumber` prints it.
 * The formulas are colorjs.io 0.7.1's, in its order of operations.
 */
export function normalizeColor(value: unknown): string | null {
  const parsed = parseColor(value);
  if (parsed === null || parsed.alpha !== 1) return null;
  clampInputChannels(parsed);
  const coordinates = toOklch(parsed.spaceId, parsed.coords);
  if (coordinates === null || !coordinates.every((coordinate) => Number.isFinite(coordinate)))
    return null;
  const [lightness, chroma, hue] = coordinates;
  return `oklch(${formatNumber(lightness)} ${formatNumber(chroma)} ${formatNumber(hue)})`;
}

type Coordinates = readonly [number, number, number];
type Matrix = readonly [Coordinates, Coordinates, Coordinates];

// colorjs.io 0.7.1's matrices (`spaces/srgb-linear.js`, `adapt.js`, `spaces/oklab.js`) and white point (`adapt.js`).
const LINEAR_SRGB_TO_XYZ: Matrix = [
  [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
];
const D50_TO_D65: Matrix = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];
const XYZ_TO_LMS: Matrix = [
  [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
  [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
  [0.0481771893596242, 0.2642395317527308, 0.6335478284694309],
];
const LMS_TO_OKLAB: Matrix = [
  [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
  [1.9779985324311684, -2.42859224204858, 0.450593709617411],
  [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];
const D50_WHITE: Coordinates = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
const LAB_EPSILON_CUBE_ROOT = 24 / 116;
const LAB_KAPPA = 24389 / 27;
/** colorjs.io's achromatic bound for OKLCH: a 100,000th of OKLab's `a` reference range. */
const ACHROMATIC = (0.4 - -0.4) / 100000;

/** The OKLCH coordinates of a parsed colour, or null for a space this module does not convert. */
function toOklch(spaceId: string, coords: Coordinates): Coordinates | null {
  switch (spaceId) {
    case "oklch":
      return coords;
    case "oklab":
      return oklabToOklch(coords);
    case "srgb":
      return xyzToOklch(srgbToXyz(coords));
    case "hsl":
      return xyzToOklch(srgbToXyz(hslToSrgb(coords)));
    case "hwb":
      return xyzToOklch(srgbToXyz(hsvToSrgb(hwbToHsv(coords))));
    case "lab":
      return xyzToOklch(labToXyz(coords));
    case "lch": {
      const lab = lchToLab(coords);
      return lab === null ? null : xyzToOklch(labToXyz(lab));
    }
    default:
      return null;
  }
}

function multiply(vector: Coordinates, matrix: Matrix): Coordinates {
  const dot = (row: Coordinates) => vector[0] * row[0] + vector[1] * row[1] + vector[2] * row[2];
  return [dot(matrix[0]), dot(matrix[1]), dot(matrix[2])];
}

/** `base` (positive) to the power `exponent` (not 0); infinite when too large, as Math.pow gives. */
function power(base: number, exponent: number): number {
  return base === 1 ? 1 : (positivePower(base, exponent) ?? Infinity);
}

function srgbToXyz(rgb: Coordinates): Coordinates {
  const linear = (value: number) => {
    const sign = value < 0 ? -1 : 1;
    const magnitude = value * sign;
    return magnitude <= 0.04045 ? value / 12.92 : sign * power((magnitude + 0.055) / 1.055, 2.4);
  };
  return multiply([linear(rgb[0]), linear(rgb[1]), linear(rgb[2])], LINEAR_SRGB_TO_XYZ);
}

function hslToSrgb([hue, saturation, lightness]: Coordinates): Coordinates {
  let h = hue % 360;
  if (h < 0) h += 360;
  const s = saturation / 100;
  const l = lightness / 100;
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

function hwbToHsv([hue, whiteness, blackness]: Coordinates): Coordinates {
  const w = whiteness / 100;
  const b = blackness / 100;
  const sum = w + b;
  if (sum >= 1) return [hue, 0, (w / sum) * 100];
  const v = 1 - b;
  const s = v === 0 ? 0 : 1 - w / v;
  return [hue, s * 100, v * 100];
}

function hsvToSrgb([hue, saturation, value]: Coordinates): Coordinates {
  let h = hue % 360;
  if (h < 0) h += 360;
  const s = saturation / 100;
  const v = value / 100;
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [channel(5), channel(3), channel(1)];
}

function labToXyz([lightness, a, b]: Coordinates): Coordinates {
  const f1 = (lightness + 16) / 116;
  const f0 = a / 500 + f1;
  const f2 = f1 - b / 200;
  const xyz: Coordinates = [
    f0 > LAB_EPSILON_CUBE_ROOT ? power(f0, 3) : (116 * f0 - 16) / LAB_KAPPA,
    lightness > 8 ? power((lightness + 16) / 116, 3) : lightness / LAB_KAPPA,
    f2 > LAB_EPSILON_CUBE_ROOT ? power(f2, 3) : (116 * f2 - 16) / LAB_KAPPA,
  ];
  return multiply(
    [xyz[0] * D50_WHITE[0], xyz[1] * D50_WHITE[1], xyz[2] * D50_WHITE[2]],
    D50_TO_D65,
  );
}

/**
 * LCH to Lab in degrees, or null where colorjs.io's conversion overflows: it turns the hue into radians first, and a
 * hue whose radians are not finite gave no colour, which stays so.
 */
function lchToLab([lightness, chroma, hue]: Coordinates): Coordinates | null {
  if (!Number.isFinite((hue * Math.PI) / 180)) return null;
  const c = chroma < 0 ? 0 : chroma;
  return [lightness, c * cosDegrees(hue), c * sinDegrees(hue)];
}

function xyzToOklch(xyz: Coordinates): Coordinates {
  const lms = multiply(xyz, XYZ_TO_LMS);
  return oklabToOklch(
    multiply([cubeRoot(lms[0]), cubeRoot(lms[1]), cubeRoot(lms[2])], LMS_TO_OKLAB),
  );
}

function oklabToOklch([lightness, a, b]: Coordinates): Coordinates {
  if (Math.abs(a) < ACHROMATIC && Math.abs(b) < ACHROMATIC) return [lightness, 0, 0];
  const degrees = atan2Degrees(b, a);
  return [lightness, Math.sqrt(a * a + b * b), ((degrees % 360) + 360) % 360];
}

/**
 * Finite `x` as Number::toString writes it, with the choice ECMAScript only recommends made exact. Number::toString
 * fixes the number of digits, the fewest that read back as `x`, but not which of several such decimals it writes; this
 * takes that count from `String(x)` and writes the decimal of that many digits nearest to `x` (compared exactly), a
 * tie going to the even one. Every engine gives the same text; the engines measured give `String(x)`'s.
 */
function formatNumber(x: number): string {
  if (x === 0) return "0";
  if (x < 0) return `-${formatNumber(-x)}`;
  // The digit count is the part of String(x) that ECMAScript specifies: the fewest that read back.
  const precision = significantDigits(String(x));
  const [mantissa, exponent] = x.toExponential(precision - 1).split("e");
  const nearest = BigInt(mantissa!.replace(".", ""));
  const scale = BigInt(Number(exponent)) - BigInt(precision - 1);
  const candidates: { readonly digits: bigint; readonly scale: bigint }[] = [];
  for (const offset of [-1n, 0n, 1n]) {
    let digits = nearest + offset;
    let candidateScale = scale;
    // Keep `precision` digits: 10^p becomes 10^(p-1) one place up, 10^(p-1) - 1 gains a digit one place down.
    if (digits === 10n ** BigInt(precision)) {
      digits /= 10n;
      candidateScale += 1n;
    } else if (precision > 1 && digits === 10n ** BigInt(precision - 1) - 1n) {
      digits = digits * 10n + 9n;
      candidateScale -= 1n;
    }
    if (digits > 0n && Number(`${digits}e${candidateScale}`) === x)
      candidates.push({ digits, scale: candidateScale });
  }
  if (candidates.length === 0)
    throw new Error("formatNumber: no decimal of the shortest length reads back");
  if (candidates.length === 1) return layout(candidates[0]!.digits, candidates[0]!.scale);
  const exact = binaryParts(x);
  let best = candidates[0]!;
  let bestDistance = decimalDistance(best.digits, best.scale, exact);
  for (const candidate of candidates.slice(1)) {
    const distance = decimalDistance(candidate.digits, candidate.scale, exact);
    if (distance < bestDistance || (distance === bestDistance && candidate.digits % 2n === 0n)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return layout(best.digits, best.scale);
}

/** The number of significant digits of a Number::toString text: its digits without leading and trailing zeros. */
function significantDigits(text: string): number {
  const digits = text.split("e")[0]!.replace(".", "").replace(/^0+/u, "").replace(/0+$/u, "");
  return Math.max(1, digits.length);
}

/** Positive finite `x` as an exact `mantissa × 2^exponent`. */
function binaryParts(x: number): { readonly mantissa: bigint; readonly exponent: bigint } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const field = bits >> 52n;
  const fraction = bits & ((1n << 52n) - 1n);
  return field === 0n
    ? { mantissa: fraction, exponent: -1074n }
    : { mantissa: fraction + (1n << 52n), exponent: field - 1075n };
}

/** |digits × 10^scale − mantissa × 2^exponent|, scaled by a positive factor that depends only on `x` and `scale`. */
function decimalDistance(
  digits: bigint,
  scale: bigint,
  exact: { readonly mantissa: bigint; readonly exponent: bigint },
): bigint {
  const twos = exact.exponent < 0n ? -exact.exponent : 0n;
  const tens = scale < 0n ? -scale : 0n;
  const decimal = digits * 10n ** (scale + tens) * 2n ** twos;
  const binary = exact.mantissa * 2n ** (exact.exponent + twos) * 10n ** tens;
  return decimal > binary ? decimal - binary : binary - decimal;
}

/** `digits × 10^scale` laid out as Number::toString lays out its digits (ECMA-262, steps 6 to 10). */
function layout(digits: bigint, scale: bigint): string {
  let text = `${digits}`;
  let exponent = scale;
  while (text.length > 1 && text.endsWith("0")) {
    text = text.slice(0, -1);
    exponent += 1n;
  }
  const k = BigInt(text.length);
  const n = exponent + k;
  if (k <= n && n <= 21n) return text + "0".repeat(Number(n - k));
  if (0n < n && n <= 21n) return `${text.slice(0, Number(n))}.${text.slice(Number(n))}`;
  if (-6n < n && n <= 0n) return `0.${"0".repeat(Number(-n))}${text}`;
  const e = n - 1n;
  const sign = e < 0n ? "-" : "+";
  const magnitude = e < 0n ? -e : e;
  return text.length === 1
    ? `${text}e${sign}${magnitude}`
    : `${text.slice(0, 1)}.${text.slice(1)}e${sign}${magnitude}`;
}

export function isNormalizedColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = NORMALIZED_COLOR.exec(value);
  return match !== null && match.slice(1).every((text) => Number.isFinite(Number(text)));
}

/** Opaque authored surfaces share the CSS parser without accepting theme-dependent transparency. */
export function normalizeOpaqueColor(value: unknown): string | null {
  const color = normalizeColor(value);
  return color !== null && new Color(color).alpha === 1 ? color : null;
}

export function isNormalizedOpaqueColor(value: unknown): value is string {
  return isNormalizedColor(value) && new Color(value).alpha === 1;
}
