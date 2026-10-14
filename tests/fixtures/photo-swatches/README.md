# node-vibrant reference swatches

`node-vibrant.json` holds what node-vibrant 4.0.4 measures for six photos. In `tests/player-photo-swatches.test.ts` the
Player's own extraction (`player/theme/node-vibrant/swatches.ts`) must give the same colours and swatches;
`tests/player-photo-theme.test.ts` checks the contrast of their photo colours.

The photos are from Unsplash (Unsplash License), 1500 × 1000 through picsum.photos: P1 green forest valley by Jerry
Adney (`_WiFMBRT7Aw`), P2 blue sea by Isaak Dury (`YhZbnxqtooM`), P3 portrait in a yellow field by Alexander Shustov
(`AHBiSKaENwc`), P4 red cup on red by Justin Leibow (`ZJsseAxEcqM`), P5 purple petunias by Steven Spassov
(`tVIqMgGlAG0`), and P6 black-and-white city by Oleg Chursin (`IoCWq07GaG4`). Chromium drew each photo on a canvas at
128 px on its longest side, as the Player measures it, and read the RGBA pixels back on 2026-10-13.

For each photo:

- `size`: the measured width and height in pixels;
- `histogram`: node-vibrant's 32 × 32 × 32 colour histogram of those pixels after its default filter, as base64 of
  little-endian 32-bit words, one per counted cell: the cell index in the low 15 bits, its pixel count above them;
- `colours`: node-vibrant's MMCQ colours (`colorCount: 64`) in its order, as hex and population;
- `swatches`: its default generator's six swatches as hex and population, `null` where it invented the swatch from
  another one (population 0).

Made with node-vibrant 4.0.4 installed in a scratch folder, not as a repository dependency, by this script (Node 24):

```js
import { MMCQ } from "<node_modules>/@vibrant/quantizer-mmcq/dist/esm/index.js";
import { DefaultGenerator } from "<node_modules>/@vibrant/generator-default/dist/esm/index.js";
import { Histogram } from "<node_modules>/@vibrant/image/dist/esm/index.js";

const hex = (rgb) => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
function reference(photo, pixels /* Uint8ClampedArray of RGBA */) {
  // node-vibrant's default filter (node-vibrant/src/pipeline) marks skipped pixels with alpha 0.
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b, a] = pixels.subarray(i, i + 4);
    if (!(a >= 125 && !(r > 250 && g > 250 && b > 250))) pixels[i + 3] = 0;
  }
  const cells = [];
  new Histogram(pixels, { sigBits: 5 }).hist.forEach((count, index) => {
    if (count) cells.push(index + count * 2 ** 15);
  });
  const colours = MMCQ(pixels, { colorCount: 64 });
  const palette = DefaultGenerator(colours);
  const names = ["Vibrant", "LightVibrant", "DarkVibrant", "Muted", "LightMuted", "DarkMuted"];
  return {
    photo,
    histogram: Buffer.from(new Uint32Array(cells).buffer).toString("base64"),
    colours: colours.map((colour) => [hex(colour.rgb), colour.population]),
    swatches: Object.fromEntries(
      names.map((name) => {
        const swatch = palette[name];
        return [name, swatch && swatch.population > 0 ? [hex(swatch.rgb), swatch.population] : null];
      }),
    ),
  };
}
```
