import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** One photo of `tests/fixtures/photo-swatches/node-vibrant.json`: node-vibrant 4.0.4's results (see its README). */
export interface ReferencePhoto {
  readonly photo: string;
  /** The photo's colour histogram, one pixel count per 32 x 32 x 32 RGB cell. */
  readonly histogram: Uint32Array;
  readonly colours: readonly (readonly [hex: string, population: number])[];
  readonly swatches: Readonly<Record<string, readonly [hex: string, population: number] | null>>;
}

export function referencePhotos(): readonly ReferencePhoto[] {
  const fixture: { photos: (Omit<ReferencePhoto, "histogram"> & { histogram: string })[] } =
    JSON.parse(
      readFileSync(
        resolve(process.cwd(), "tests/fixtures/photo-swatches/node-vibrant.json"),
        "utf8",
      ),
    );
  return fixture.photos.map((photo) => {
    // Little-endian words: the cell index in the low 15 bits, its pixel count above them.
    const bytes = Buffer.from(photo.histogram, "base64");
    const histogram = new Uint32Array(1 << 15);
    for (let offset = 0; offset < bytes.length; offset += 4) {
      const word = bytes.readUInt32LE(offset);
      histogram[word % 2 ** 15] = Math.floor(word / 2 ** 15);
    }
    return { ...photo, histogram };
  });
}
