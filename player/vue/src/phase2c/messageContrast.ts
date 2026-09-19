import { oklchCss, pickerHexToOklch } from "../../../theme/color.js";

/**
 * Contrast work for an authored colour meeting a bubble the author never saw.
 *
 * Compositing is not linear in luminance and a bubble is rarely a neutral grey, so
 * nothing here models the blend: the same engine that will paint the page is asked
 * what a candidate actually produces.
 */
let context: CanvasRenderingContext2D | null = null;

function paint(...layers: readonly string[]) {
  context ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("A 2D canvas context is required to resolve colours");
  context.clearRect(0, 0, 1, 1);
  for (const layer of layers) {
    context.fillStyle = layer;
    context.fillRect(0, 0, 1, 1);
  }
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return [red!, green!, blue!] as const;
}

function luminance(channels: readonly [number, number, number]) {
  const [red, green, blue] = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function ratio(first: number, second: number) {
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function hexOf(colour: string) {
  return `#${paint(colour).map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** An authored colour names a hue; this is the bubble a given tone realizes from it. */
export function realizeBubble(colour: string, tone: number) {
  return oklchCss({ ...pickerHexToOklch(hexOf(colour)), l: tone });
}

/**
 * The least cover an authored colour needs to stay readable on this backdrop, or null
 * when it needs none. Cover runs toward whichever pole the colour is furthest from, so
 * more of it always helps and the smallest sufficient amount can be narrowed down.
 */
export function scrimFor(colour: string, backdrop: string, target = 4.6) {
  const text = luminance(paint(colour));
  const behind = luminance(paint(backdrop));
  if (ratio(text, behind) >= target) return null;
  const pole = text > 0.179 ? "0 0 0" : "255 255 255";
  let insufficient = 0;
  let sufficient = 1;
  for (let step = 0; step < 12; step += 1) {
    const cover = (insufficient + sufficient) / 2;
    const candidate = luminance(paint(backdrop, `rgb(${pole} / ${cover})`));
    if (ratio(text, candidate) >= target) sufficient = cover;
    else insufficient = cover;
  }
  return `rgb(${pole} / ${sufficient.toFixed(3)})`;
}
