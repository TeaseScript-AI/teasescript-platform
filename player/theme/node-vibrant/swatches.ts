/**
 * The six swatches of a photo, measured as node-vibrant 4.0.4 measures them, without the library.
 *
 * Derived from node-vibrant (https://github.com/Vibrant-Colors/node-vibrant), whose MIT notice is in `LICENSE` beside
 * this file. Its median cut comes from Leptonica's MMCQ and its swatch targets from Android's Palette.
 *
 * 1. `colourHistogram` counts the readable pixels in a 32 x 32 x 32 RGB grid.
 * 2. `quantize` cuts the grid's colour box at its median along its longest side, always the box with the most pixels,
 *    until there are 48 boxes or no box can be cut. Each box's average is one colour.
 * 3. `pickSwatches` scores the colours for six lightness and saturation targets and takes the best one per target,
 *    with the share of the measured pixels it stands for.
 *
 * Unlike node-vibrant, a target without a colour in its ranges stays `null` instead of being invented from another
 * swatch, so a caller can tell a measured colour from a guess.
 */

export type Rgb = readonly [red: number, green: number, blue: number];

export interface PhotoColour {
  readonly rgb: Rgb;
  /** The number of measured pixels this colour stands for. */
  readonly population: number;
}

/** A swatch: one of the photo's colours, and how much of the photo it covers. */
export interface Swatch extends PhotoColour {
  /** The share of the photo's measured pixels this colour stands for, 0..1. */
  readonly share: number;
}

export const SWATCH_NAMES = [
  "Vibrant",
  "LightVibrant",
  "DarkVibrant",
  "Muted",
  "LightMuted",
  "DarkMuted",
] as const;
export type SwatchName = (typeof SWATCH_NAMES)[number];
export type PhotoSwatches = Readonly<Record<SwatchName, Swatch | null>>;

const BITS = 5;
const SHIFT = 8 - BITS;
const SIDE = 1 << BITS;
const cellIndex = (red: number, green: number, blue: number) =>
  (red << (2 * BITS)) | (green << BITS) | blue;

/**
 * The photo's RGBA pixels counted per cell of a 32 x 32 x 32 RGB grid. Like node-vibrant, it skips mostly transparent
 * pixels and almost white ones, which most photos have too much of.
 */
export function colourHistogram(pixels: Uint8ClampedArray): Uint32Array {
  const histogram = new Uint32Array(SIDE * SIDE * SIDE);
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    const red = pixels[offset]!;
    const green = pixels[offset + 1]!;
    const blue = pixels[offset + 2]!;
    if (pixels[offset + 3]! < 125 || (red > 250 && green > 250 && blue > 250)) continue;
    histogram[cellIndex(red >> SHIFT, green >> SHIFT, blue >> SHIFT)]!++;
  }
  return histogram;
}

type Axis = 0 | 1 | 2;
type Corner = [red: number, green: number, blue: number];

/** A box of grid cells, from `low` to `high` on each axis. Like node-vibrant's, it never shrinks to its pixels. */
class Box {
  readonly histogram: Uint32Array;
  readonly low: Corner;
  readonly high: Corner;
  #count = -1;

  constructor(histogram: Uint32Array, low: Corner, high: Corner) {
    this.histogram = histogram;
    this.low = low;
    this.high = high;
  }

  /** This box, or the part of it from `start` to `end` on `axis`. */
  part(axis?: Axis, start?: number, end?: number): Box {
    const low: Corner = [...this.low];
    const high: Corner = [...this.high];
    if (axis !== undefined) {
      low[axis] = start!;
      high[axis] = end!;
    }
    return new Box(this.histogram, low, high);
  }

  forEachCell(visit: (red: number, green: number, blue: number, pixels: number) => void) {
    for (let red = this.low[0]; red <= this.high[0]; red++)
      for (let green = this.low[1]; green <= this.high[1]; green++)
        for (let blue = this.low[2]; blue <= this.high[2]; blue++) {
          const pixels = this.histogram[cellIndex(red, green, blue)]!;
          if (pixels) visit(red, green, blue, pixels);
        }
  }

  get count(): number {
    if (this.#count < 0) {
      let count = 0;
      this.forEachCell((_red, _green, _blue, pixels) => (count += pixels));
      this.#count = count;
    }
    return this.#count;
  }

  get volume(): number {
    return (
      (this.high[0] - this.low[0] + 1) *
      (this.high[1] - this.low[1] + 1) *
      (this.high[2] - this.low[2] + 1)
    );
  }

  /** The pixel-weighted average of the cell centres, truncated like node-vibrant's. */
  average(): Rgb {
    const step = 1 << SHIFT;
    let total = 0;
    let red = 0;
    let green = 0;
    let blue = 0;
    this.forEachCell((r, g, b, pixels) => {
      total += pixels;
      red += pixels * (r + 0.5) * step;
      green += pixels * (g + 0.5) * step;
      blue += pixels * (b + 0.5) * step;
    });
    if (total === 0) {
      const middle = (axis: Axis) =>
        Math.trunc((step * (this.low[axis] + this.high[axis] + 1)) / 2);
      return [middle(0), middle(1), middle(2)];
    }
    return [Math.trunc(red / total), Math.trunc(green / total), Math.trunc(blue / total)];
  }

  /**
   * Two boxes, cut across the longest side (red, then green, then blue on a tie) near the median pixel, a little
   * towards the larger half. A box of one pixel stays whole, and the second box may be empty, as in node-vibrant.
   */
  split(): Box[] {
    const count = this.count;
    if (count === 0) return [];
    if (count === 1) return [this.part()];
    const width = (side: Axis) => this.high[side] - this.low[side] + 1;
    const widest = Math.max(width(0), width(1), width(2));
    const axis: Axis = width(0) === widest ? 0 : width(1) === widest ? 1 : 2;
    const start = this.low[axis];
    const end = this.high[axis];
    // The pixels in the slices up to each position on the axis, and above it; zero below the box and where none are.
    const below = new Uint32Array(end + 1);
    const above = new Uint32Array(end + 1);
    let total = 0;
    for (let position = start; position <= end; position++) {
      total += this.part(axis, position, position).count;
      below[position] = total;
    }
    let median = -1;
    for (let position = start; position <= end; position++) {
      if (!below[position]) continue;
      if (median < 0 && below[position]! > total / 2) median = position;
      above[position] = total - below[position]!;
    }
    const left = median - start;
    const right = end - median;
    let cut =
      left <= right
        ? Math.max(0, Math.min(end - 1, Math.trunc(median + right / 2)))
        : Math.min(end, Math.max(start, Math.trunc(median - 1 - left / 2)));
    while (!below[cut]) cut++;
    while (!above[cut] && below[cut - 1]) cut--;
    return [this.part(axis, start, cut), this.part(axis, cut + 1, end)];
  }
}

/** Cuts the largest box by `order` (a stable sort, like node-vibrant's queue) until there are `target` boxes. */
function splitBoxes(boxes: Box[], target: number, order: (a: Box, b: Box) => number) {
  let size = boxes.length;
  while (boxes.length < target) {
    boxes.sort(order);
    const box = boxes.pop();
    if (!box || box.count === 0) break;
    const [first, second] = box.split();
    if (!first) break;
    boxes.push(first);
    if (second && second.count > 0) boxes.push(second);
    // A cut that left one box empty ends the cutting.
    if (boxes.length === size) break;
    size = boxes.length;
  }
}

const byCount = (a: Box, b: Box) => a.count - b.count;
const byCountAndVolume = (a: Box, b: Box) => a.count * a.volume - b.count * b.volume;

/**
 * The colours of a histogram by median cut (MMCQ), most important first; none when it counts no pixel.
 *
 * node-vibrant first cuts by pixel count to three quarters of its 64 colours, then means to cut by count times volume up
 * to 64, but its second phase compares the number of boxes with 64 minus the boxes it already has: after 48 boxes it
 * does nothing, and it only cuts when the first phase stopped below 32. This does the same, so both give the same
 * colours.
 */
export function quantize(histogram: Uint32Array): PhotoColour[] {
  const low: Corner = [SIDE, SIDE, SIDE];
  const high: Corner = [0, 0, 0];
  for (let index = 0; index < histogram.length; index++) {
    if (!histogram[index]) continue;
    const corner: Corner = [index >> (2 * BITS), (index >> BITS) & (SIDE - 1), index & (SIDE - 1)];
    for (const axis of [0, 1, 2] as const) {
      low[axis] = Math.min(low[axis], corner[axis]);
      high[axis] = Math.max(high[axis], corner[axis]);
    }
  }
  if (low[0] === SIDE) return [];
  const colourCount = 64;
  const boxes = [new Box(histogram, low, high)];
  splitBoxes(boxes, 0.75 * colourCount, byCount);
  splitBoxes(boxes, colourCount - boxes.length, byCountAndVolume);
  return boxes
    .sort(byCountAndVolume)
    .reverse()
    .map((box) => ({ rgb: box.average(), population: box.count }));
}

/** HSL saturation and lightness, both 0..1, as node-vibrant measures them. */
function saturationAndLightness([red, green, blue]: Rgb): readonly [number, number] {
  const max = Math.max(red, green, blue) / 255;
  const min = Math.min(red, green, blue) / 255;
  const lightness = (max + min) / 2;
  if (max === min) return [0, lightness];
  const spread = max - min;
  return [lightness > 0.5 ? spread / (2 - max - min) : spread / (max + min), lightness];
}

interface Target {
  readonly lightness: readonly [min: number, target: number, max: number];
  readonly saturation: readonly [min: number, target: number, max: number];
}

// Android Palette's targets as node-vibrant sets them; its "luma" is HSL lightness.
const NORMAL = [0.3, 0.5, 0.7] as const;
const LIGHT = [0.55, 0.74, 1] as const;
const DARK = [0, 0.26, 0.45] as const;
const VIBRANT = [0.35, 1, 1] as const;
const MUTED = [0, 0.3, 0.4] as const;
// In the order of `SWATCH_NAMES`, which matters: a colour an earlier target takes is not offered to a later one.
const TARGETS: Readonly<Record<SwatchName, Target>> = {
  Vibrant: { lightness: NORMAL, saturation: VIBRANT },
  LightVibrant: { lightness: LIGHT, saturation: VIBRANT },
  DarkVibrant: { lightness: DARK, saturation: VIBRANT },
  Muted: { lightness: NORMAL, saturation: MUTED },
  LightMuted: { lightness: LIGHT, saturation: MUTED },
  DarkMuted: { lightness: DARK, saturation: MUTED },
};
const WEIGHTS = { saturation: 3, lightness: 6.5, population: 0.5 };

/**
 * The best colour per target: within its ranges, closest to its saturation and lightness, and common in the photo. A
 * target without a colour in its ranges stays `null`.
 */
export function pickSwatches(colours: readonly PhotoColour[]): PhotoSwatches {
  const maxPopulation = Math.max(0, ...colours.map((colour) => colour.population));
  const measured = colours.reduce((total, colour) => total + colour.population, 0);
  const taken = new Set<PhotoColour>();
  const swatches: Record<SwatchName, Swatch | null> = {
    Vibrant: null,
    LightVibrant: null,
    DarkVibrant: null,
    Muted: null,
    LightMuted: null,
    DarkMuted: null,
  };
  for (const name of SWATCH_NAMES) {
    const { lightness: l, saturation: s } = TARGETS[name];
    let best: PhotoColour | null = null;
    let bestScore = 0;
    for (const colour of colours) {
      const [saturation, lightness] = saturationAndLightness(colour.rgb);
      if (taken.has(colour) || saturation < s[0] || saturation > s[2]) continue;
      if (lightness < l[0] || lightness > l[2]) continue;
      // A weighted mean that, like node-vibrant's, leaves out a term whose value is exactly 0.
      const terms: readonly (readonly [value: number, weight: number])[] = [
        [1 - Math.abs(saturation - s[1]), WEIGHTS.saturation],
        [1 - Math.abs(lightness - l[1]), WEIGHTS.lightness],
        [colour.population / maxPopulation, WEIGHTS.population],
      ];
      let sum = 0;
      let weights = 0;
      for (const [value, weight] of terms) {
        if (value === 0) continue;
        sum += value * weight;
        weights += weight;
      }
      const score = sum / weights;
      if (best === null || score > bestScore) {
        best = colour;
        bestScore = score;
      }
    }
    if (best) taken.add(best);
    swatches[name] = best && { ...best, share: best.population / measured };
  }
  return swatches;
}

/** The six swatches of a photo's RGBA pixels. */
export function photoSwatches(pixels: Uint8ClampedArray): PhotoSwatches {
  return pickSwatches(quantize(colourHistogram(pixels)));
}
