import Color from "colorjs.io";
import type { ScrimComparison } from "./scrimComparison";

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
  if (maximum < target) return { pole, opacity: 1, maximum, reachable: false };
  let insufficient = 0;
  let sufficient = 1;
  for (let step = 0; step < 12; step += 1) {
    const cover = (insufficient + sufficient) / 2;
    const candidate = paint(backdrop, `rgb(${pole} / ${cover})`);
    if (score(candidate) >= target) sufficient = cover;
    else insufficient = cover;
  }
  return { pole, opacity: sufficient, maximum, reachable: true };
}

export function scrimFor(colour: string, backdrop: string, comparison?: ScrimComparison) {
  const method = comparison?.method ?? "WCAG21";
  const target = method === "APCA" ? (comparison?.apcaTarget ?? 75) : 4.6;
  const textChannels = paint(colour);
  const backdropChannels = paint(backdrop);
  const text = luminance(textChannels);
  const score = (channels: readonly [number, number, number]) =>
    method === "APCA"
      ? Math.abs(Color.contrast(rgb(channels), rgb(textChannels), "APCA"))
      : ratio(text, luminance(channels));
  if (score(backdropChannels) >= target) return null;
  const poles =
    method === "APCA" ? ["0 0 0", "255 255 255"] : [text > 0.179 ? "0 0 0" : "255 255 255"];
  const candidates = poles.map((pole) => coverFor(backdrop, pole, target, score));
  const reachable = candidates.filter((candidate) => candidate.reachable);
  const selected =
    reachable.length > 0
      ? reachable.reduce((best, candidate) => (candidate.opacity < best.opacity ? candidate : best))
      : candidates.reduce((best, candidate) =>
          candidate.maximum > best.maximum ? candidate : best,
        );
  const opacity =
    method === "APCA" ? Math.ceil(selected.opacity * 1000) / 1000 : selected.opacity.toFixed(3);
  return `rgb(${selected.pole} / ${opacity})`;
}
