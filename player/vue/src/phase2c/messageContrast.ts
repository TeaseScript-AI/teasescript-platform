import Color from "colorjs.io";
import type { ScrimComparison } from "./scrimComparison";

export const WCAG_SCRIM_TARGET = 4.5;
// Canvas readback and CSS alpha compositing can round a painted channel differently.
const WCAG_SEARCH_TARGET = WCAG_SCRIM_TARGET + 0.05;

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

export function resolveColour(element: Element, value: string, fallback: string) {
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.color = value;
  element.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved === "" ? fallback : resolved;
}

export function backdropBehind(element: Element | null) {
  const layers: string[] = [];
  for (let node = element; node !== null; node = node.parentElement) {
    const colour = getComputedStyle(node).backgroundColor;
    if (colour === "" || colour === "transparent" || colour === "rgba(0, 0, 0, 0)") continue;
    layers.unshift(colour);
    if (!colour.startsWith("rgba(")) break; // Opaque: nothing below it can show through.
  }
  const [red, green, blue] = paint("#ffffff", ...layers);
  return `rgb(${red} ${green} ${blue})`;
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

function rgb(channels: readonly [number, number, number]) {
  return `rgb(${channels[0]} ${channels[1]} ${channels[2]})`;
}

function coverFor(
  backdrop: string,
  pole: string,
  target: number,
  score: (channels: readonly [number, number, number]) => number,
) {
  const maximum = score(paint(`rgb(${pole})`));
  if (maximum < target) return { pole, opacity: 1, reachable: false };
  let insufficient = 0;
  let sufficient = 1;
  for (let step = 0; step < 12; step += 1) {
    const cover = (insufficient + sufficient) / 2;
    const candidate = paint(backdrop, `rgb(${pole} / ${cover})`);
    if (score(candidate) >= target) sufficient = cover;
    else insufficient = cover;
  }
  return { pole, opacity: sufficient, reachable: true };
}

export function scrimFor(
  colour: string,
  backdrop: string,
  comparison?: ScrimComparison,
): string | null {
  const textChannels = paint(colour);
  const backdropChannels = paint(backdrop);
  if (
    comparison?.mode === "APCA_FILTER" &&
    Math.abs(Color.contrast(rgb(backdropChannels), rgb(textChannels), "APCA")) >=
      comparison.apcaCutoff
  )
    return null;
  const text = luminance(textChannels);
  const score = (channels: readonly [number, number, number]) => ratio(text, luminance(channels));
  if (score(backdropChannels) >= WCAG_SCRIM_TARGET) return null;
  const black = coverFor(backdrop, "0 0 0", WCAG_SEARCH_TARGET, score);
  const white = coverFor(backdrop, "255 255 255", WCAG_SEARCH_TARGET, score);
  const selected =
    !black.reachable || (white.reachable && white.opacity < black.opacity) ? white : black;
  if (!selected.reachable) throw new Error("No readable scrim exists for this text colour");
  return `rgb(${selected.pole} / ${Math.ceil(selected.opacity * 1000) / 1000})`;
}
