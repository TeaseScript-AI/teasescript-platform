import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import type { PhotoSwatches } from "../player/theme/node-vibrant/swatches.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

interface PreparedPhoto {
  readonly shown: Promise<string>;
  readonly swatches: Promise<PhotoSwatches | null>;
  release(): void;
}
let prepareStagePhoto: (source: string) => PreparedPhoto;

// The page this module runs in, without an image decoder for a worker: downloads, object URLs, images that decode, and
// a canvas whose pixels are one green, so every photo is measured on the canvas.
const page = { draws: 0, created: new Set<string>(), revoked: new Set<string>() };
const saved = {
  fetch: globalThis.fetch,
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
};
before(async () => {
  globalThis.fetch = async (input) => {
    if (String(input).includes("unreachable")) throw new TypeError("Failed to fetch");
    return new Response(new Blob([new Uint8Array(16)], { type: "image/png" }));
  };
  URL.createObjectURL = (blob) => {
    const url = saved.createObjectURL(blob);
    page.created.add(url);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    page.revoked.add(url);
    saved.revokeObjectURL(url);
  };
  Object.assign(globalThis, {
    Image: class {
      src = "";
      naturalWidth = 4;
      naturalHeight = 2;
      decode = async () => undefined;
    },
    document: {
      createElement: () => ({
        getContext: () => ({
          drawImage: () => page.draws++,
          getImageData: (_x: number, _y: number, width: number, height: number) => ({
            data: new Uint8ClampedArray(width * height * 4).map(
              (_, i) => [40, 160, 60, 255][i % 4]!,
            ),
          }),
        }),
      }),
    },
  });
  const module = await loadPlayerModule("player/vue/src/stagePhotos.ts");
  assert.equal(typeof module.prepareStagePhoto, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export was checked callable just above.
  prepareStagePhoto = module.prepareStagePhoto as typeof prepareStagePhoto;
});
after(() => {
  globalThis.fetch = saved.fetch;
  Reflect.deleteProperty(globalThis, "Image");
  Reflect.deleteProperty(globalThis, "document");
  URL.createObjectURL = saved.createObjectURL;
  URL.revokeObjectURL = saved.revokeObjectURL;
});

test("a photo shows by an object URL of its download, which goes when the last hold on it goes", async () => {
  const shown = prepareStagePhoto("/files/forest.jpg");
  const again = prepareStagePhoto("/files/forest.jpg");
  const url = await shown.shown;
  assert.equal(await again.shown, url, "both holds share the photo");
  assert.equal(page.created.has(url), true);
  assert.notEqual((await shown.swatches)?.Vibrant, null, "the photo is measured");
  shown.release();
  assert.equal(page.revoked.has(url), false, "the photo is still held");
  again.release();
  assert.equal(page.revoked.has(url), true);
});

test("a photo shown again is not measured again, and a photo in the page's memory shows as it is", async () => {
  const first = prepareStagePhoto("data:image/png;base64,AAAA");
  assert.equal(await first.shown, "data:image/png;base64,AAAA");
  const swatches = await first.swatches;
  first.release();
  const draws = page.draws;
  const again = prepareStagePhoto("data:image/png;base64,AAAA");
  assert.equal(await again.swatches, swatches);
  await again.shown;
  assert.equal(page.draws, draws);
  again.release();
});

test("a photo that cannot be downloaded shows from its source for the Stage to load, without a colour", async () => {
  const photo = prepareStagePhoto("https://unreachable.example/sea.jpg");
  assert.equal(await photo.shown, "https://unreachable.example/sea.jpg");
  assert.equal(await photo.swatches, null);
  photo.release();
});
