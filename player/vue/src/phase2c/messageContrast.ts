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

/**
 * What a colour is worth once every layer under it has had its say. A colour may be
 * partly see-through, and then the visible result is not the colour but the stack, so
 * both the words and the surface they sit on are read off the same painted stack.
 */
function contrast(backdrop: readonly string[], colour: string) {
  return ratio(luminance(paint(...backdrop, colour)), luminance(paint(...backdrop)));
}

/**
 * The ink a realized bubble can carry. A tone near the crossover reads as light to one
 * hue and dark to another, so the pair is measured rather than classified.
 */
export function inkFor(...backdrop: readonly string[]) {
  const behind = luminance(paint(...backdrop));
  return 1.05 / (behind + 0.05) >= (behind + 0.05) / 0.05 ? "#ffffff" : "#000000";
}

/**
 * The least cover an authored colour needs to stay readable on the layers beneath it, or
 * null when it needs none. Which way to cover is measured rather than reasoned about:
 * words that are themselves partly see-through move along with whatever is put behind
 * them, so both poles are tried and the one that gains ground is the one narrowed down.
 * When even full cover falls short this returns it anyway, because the alternative is to
 * leave the words as they were.
 */
export function scrimFor(colour: string, backdrop: readonly string[], target = 4.6) {
  if (contrast(backdrop, colour) >= target) return null;
  const poles = ["0 0 0", "255 255 255"] as const;
  const pole = contrast([...backdrop, `rgb(${poles[0]})`], colour) >=
    contrast([...backdrop, `rgb(${poles[1]})`], colour) ? poles[0] : poles[1];
  let insufficient = 0;
  let sufficient = 1;
  for (let step = 0; step < 12; step += 1) {
    const cover = (insufficient + sufficient) / 2;
    if (contrast([...backdrop, `rgb(${pole} / ${cover})`], colour) >= target) sufficient = cover;
    else insufficient = cover;
  }
  return `rgb(${pole} / ${sufficient.toFixed(3)})`;
}
