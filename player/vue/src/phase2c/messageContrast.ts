import Color from "colorjs.io";
import type { ScrimComparison } from "./scrimComparison";

export const WCAG_SCRIM_TARGET = 4.5;
const ADAPTIVE_WCAG_TARGET = 3.5;
// Canvas readback and CSS alpha compositing can round a painted channel differently.
const SEARCH_MARGIN = 0.05;
const ENHANCED_WCAG_TARGET = 7;
// Standard is a visually tuned treatment, not an APCA or WCAG conformance claim.
const STANDARD_APCA_TARGET = 55;
const MINIMUM_APCA_WITH_WCAG = 40;
const SUBTLE_COVER_LIMIT = 0.08;
const MAX_IDENTITY_COVER = 0.35;

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

function chromaOf(channels: readonly [number, number, number]) {
  return new Color(rgb(channels)).to("oklch").coords[1]!;
}

function byte(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value))
    throw new Error("Cannot resolve adjusted text colour");
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function minimalAmount(score: (amount: number) => number, target: number): number | null {
  if (score(1) < target) return null;
  let insufficient = 0;
  let sufficient = 1;
  for (let step = 0; step < 12; step += 1) {
    const candidate = (insufficient + sufficient) / 2;
    if (score(candidate) >= target) sufficient = candidate;
    else insufficient = candidate;
  }
  return Math.ceil(sufficient * 1000) / 1000;
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

function scrimFor(colour: string, backdrop: string, comparison?: ScrimComparison): string | null {
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
  const black = coverFor(backdrop, "0 0 0", WCAG_SCRIM_TARGET + SEARCH_MARGIN, score);
  const white = coverFor(backdrop, "255 255 255", WCAG_SCRIM_TARGET + SEARCH_MARGIN, score);
  const selected =
    !black.reachable || (white.reachable && white.opacity < black.opacity) ? white : black;
  if (!selected.reachable) throw new Error("No readable scrim exists for this text colour");
  return `rgb(${selected.pole} / ${Math.ceil(selected.opacity * 1000) / 1000})`;
}

export function readabilityFor(
  colour: string,
  backdrop: string,
  comparison?: ScrimComparison,
): { ink: string; cover: string | null } {
  if (comparison !== undefined && comparison.mode !== "ADAPTIVE_INK")
    return { ink: colour, cover: scrimFor(colour, backdrop, comparison) };

  const ink = paint(colour);
  const background = paint(backdrop);
  const inkLuminance = luminance(ink);
  const backgroundLuminance = luminance(background);
  const enhanced = comparison?.enhanced ?? false;
  const originalApca = Color.contrast(rgb(background), rgb(ink), "APCA");
  const lighterInk = originalApca === 0 ? inkLuminance >= backgroundLuminance : originalApca < 0;
  const inkPole = lighterInk ? 255 : 0;
  const backgroundPole = lighterInk ? 0 : 255;
  const authoredInk = new Color(rgb(ink)).to("oklch");
  const [lightness, chroma, hue] = authoredInk.coords;
  const adjustInk = (amount: number): [number, number, number] => {
    const adjusted = new Color("oklch", [
      Math.max(0, Math.min(1, lightness!)) * (1 - amount) + (inkPole / 255) * amount,
      chroma!,
      Number.isFinite(hue) ? hue! : 0,
    ])
      .toGamut({ space: "srgb", method: "css" })
      .to("srgb");
    return [byte(adjusted.coords[0]), byte(adjusted.coords[1]), byte(adjusted.coords[2])];
  };
  const score = (
    adjustedInk: readonly [number, number, number],
    adjustedBackground: readonly [number, number, number],
  ) => {
    const apca = Math.abs(Color.contrast(rgb(adjustedBackground), rgb(adjustedInk), "APCA"));
    const wcag = ratio(luminance(adjustedInk), luminance(adjustedBackground));
    // A WCAG pass must not override very weak APCA on a chromatic pair.
    return enhanced
      ? Math.min(wcag / ENHANCED_WCAG_TARGET, apca / (STANDARD_APCA_TARGET + 0.5))
      : Math.max(
          apca / (STANDARD_APCA_TARGET + 0.5),
          Math.min(
            wcag / (ADAPTIVE_WCAG_TARGET + SEARCH_MARGIN),
            apca / (MINIMUM_APCA_WITH_WCAG + 0.5),
          ),
        );
  };
  const originalWcag = ratio(inkLuminance, backgroundLuminance);
  if (
    enhanced
      ? originalWcag >= ENHANCED_WCAG_TARGET && Math.abs(originalApca) >= STANDARD_APCA_TARGET
      : Math.abs(originalApca) >= STANDARD_APCA_TARGET ||
        (originalWcag >= ADAPTIVE_WCAG_TARGET && Math.abs(originalApca) >= MINIMUM_APCA_WITH_WCAG)
  )
    return { ink: colour, cover: null };
  const target = enhanced ? 1 + SEARCH_MARGIN / ENHANCED_WCAG_TARGET : 1;

  const cover = minimalAmount(
    (amount) =>
      score(
        ink,
        paint(backdrop, `rgb(${backgroundPole} ${backgroundPole} ${backgroundPole} / ${amount})`),
      ),
    target,
  );
  const inkAmount = minimalAmount((amount) => score(adjustInk(amount), background), target);
  if (cover !== null && cover <= SUBTLE_COVER_LIMIT) {
    const coveredBackground = paint(
      backdrop,
      `rgb(${backgroundPole} ${backgroundPole} ${backgroundPole} / ${cover})`,
    );
    const backingChange = Color.deltaE(rgb(background), rgb(coveredBackground), "OK");
    const inkChange =
      inkAmount === null ? Infinity : Color.deltaE(rgb(ink), rgb(adjustInk(inkAmount)), "OK");
    if (backingChange < inkChange)
      return {
        ink: colour,
        cover: `rgb(${backgroundPole} ${backgroundPole} ${backgroundPole} / ${cover})`,
      };
  }
  if (inkAmount !== null) {
    const adjustedInk = adjustInk(inkAmount);
    const adjustedChroma = chromaOf(adjustedInk);
    if (chroma! > 0.15 && adjustedChroma < chroma! / 3) {
      // Gamut mapping can wash a saturated authored colour almost to grey.
      let preserved = 0;
      let faded = inkAmount;
      for (let step = 0; step < 12; step += 1) {
        const candidate = (preserved + faded) / 2;
        if (chromaOf(adjustInk(candidate)) >= chroma! / 2) preserved = candidate;
        else faded = candidate;
      }
      const protectedInk = adjustInk(preserved);
      const protectedCover = minimalAmount(
        (amount) =>
          score(
            protectedInk,
            paint(
              backdrop,
              `rgb(${backgroundPole} ${backgroundPole} ${backgroundPole} / ${amount})`,
            ),
          ),
        target,
      );
      if (protectedCover !== null && protectedCover <= MAX_IDENTITY_COVER)
        return {
          ink: rgb(protectedInk),
          cover: `rgb(${backgroundPole} ${backgroundPole} ${backgroundPole} / ${protectedCover})`,
        };
    }
    return { ink: rgb(adjustedInk), cover: null };
  }

  const amount = minimalAmount(
    (value) =>
      score(
        adjustInk(value),
        paint(backdrop, `rgb(${backgroundPole} ${backgroundPole} ${backgroundPole} / ${value})`),
      ),
    target,
  );
  if (amount === null) throw new Error("No readable treatment exists for this colour pair");
  return {
    ink: rgb(adjustInk(amount)),
    cover: `rgb(${backgroundPole} ${backgroundPole} ${backgroundPole} / ${amount})`,
  };
}
