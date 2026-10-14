import assert from "node:assert/strict";
import test from "node:test";

import {
  colourHistogram,
  photoSwatches,
  pickSwatches,
  quantize,
  SWATCH_NAMES,
  type PhotoColour,
  type Rgb,
} from "../player/theme/node-vibrant/swatches.js";
import { referencePhotos } from "./helpers/photo-swatches-fixture.js";

const hex = (rgb: Rgb) => `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
const entry = (colour: PhotoColour) => [hex(colour.rgb), colour.population];

test("the photo colours and swatches are node-vibrant's, and a swatch it would invent stays empty", () => {
  const photos = referencePhotos();
  assert.equal(photos.length, 6);
  for (const reference of photos) {
    const colours = quantize(reference.histogram);
    assert.deepEqual(colours.map(entry), reference.colours, `${reference.photo}: colours`);
    const swatches = pickSwatches(colours);
    assert.deepEqual(
      Object.fromEntries(
        SWATCH_NAMES.map((name) => [name, swatches[name] && entry(swatches[name])]),
      ),
      reference.swatches,
      `${reference.photo}: swatches`,
    );
  }
});

test("pixels are counted per colour cell, without mostly transparent and almost white ones", () => {
  const pixels = new Uint8ClampedArray([
    // Counted: opaque enough, and not white in every channel.
    ...[200, 40, 40, 125],
    ...[207, 47, 47, 255],
    ...[250, 251, 251, 255],
    // Skipped: mostly transparent, and almost white.
    ...[200, 40, 40, 124],
    ...[251, 251, 251, 255],
  ]);
  const counts = colourHistogram(pixels);
  const cell = (red: number, green: number, blue: number) =>
    ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
  assert.equal(counts[cell(200, 40, 40)], 2);
  assert.equal(counts[cell(250, 251, 251)], 1);
  assert.equal(
    counts.reduce((total, count) => total + count, 0),
    3,
  );
});

test("a photo without readable pixels has no swatch", () => {
  const swatches = photoSwatches(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0]));
  for (const name of SWATCH_NAMES) assert.equal(swatches[name], null, name);
});
