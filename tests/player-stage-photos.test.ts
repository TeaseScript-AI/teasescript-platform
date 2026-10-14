import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { compilePlayerProject, playerRuntimeStageImages } from "../player/runtime-adapter.js";
import type { PhotoSwatches } from "../player/theme/node-vibrant/swatches.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

interface PreparedPhoto {
  readonly shown: Promise<string>;
  readonly swatches: Promise<PhotoSwatches | null>;
  release(): void;
}
let prepareStagePhoto: (source: string) => PreparedPhoto;
let preloadStagePhotos: (sources: readonly string[]) => () => void;

// The page this module runs in, without an image decoder for a worker: downloads, object URLs, images that decode, and
// a canvas whose pixels are one green, so every photo is measured on the canvas.
const page = { draws: 0, created: new Set<string>(), revoked: new Set<string>(), offline: false };
const saved = {
  fetch: globalThis.fetch,
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
};
before(async () => {
  globalThis.fetch = async (input) => {
    if (String(input).includes("unreachable") || page.offline)
      throw new TypeError("Failed to fetch");
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
  // EVIDENCE: validation: the same checked module exports the preloader beside it.
  preloadStagePhotos = module.preloadStagePhotos as typeof preloadStagePhotos;
  assert.equal(typeof preloadStagePhotos, "function");
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

test("a preloaded photo is measured before it shows, and stays while the preloader holds it", async () => {
  const release = preloadStagePhotos(["/files/garden.jpg"]);
  const first = prepareStagePhoto("/files/garden.jpg");
  const url = await first.shown;
  const swatches = await first.swatches;
  first.release();
  assert.equal(page.revoked.has(url), false, "the preloader still holds the photo");
  const draws = page.draws;
  const again = prepareStagePhoto("/files/garden.jpg");
  assert.equal(await again.shown, url);
  assert.equal(await again.swatches, swatches);
  assert.equal(page.draws, draws, "the photo is not measured again");
  again.release();
  release();
  assert.equal(page.revoked.has(url), true);
});

test("a preloaded photo whose download failed is downloaded again when it shows", async () => {
  page.offline = true;
  const release = preloadStagePhotos(["/files/meadow.jpg"]);
  const missed = prepareStagePhoto("/files/meadow.jpg");
  assert.equal(await missed.shown, "/files/meadow.jpg", "the Stage loads it itself");
  assert.equal(await missed.swatches, null);
  missed.release();
  page.offline = false;
  const shown = prepareStagePhoto("/files/meadow.jpg");
  assert.equal(page.created.has(await shown.shown), true);
  assert.notEqual(await shown.swatches, null);
  shown.release();
  release();
});

test("the Stage images to load ahead are the script's image paths and its tag queries' candidates", () => {
  const { plan } = compilePlayerProject({
    files: [
      {
        path: "main.tease",
        source: [
          'showImage "images/hall.jpg"',
          'showImage tagged "bedroom", "punishment" > 3',
          'let name = "images/" + "attic.jpg"',
          "showImage name",
          'showImage "images/hall.jpg"',
          "hideImage",
          "exit",
        ].join("\n"),
      },
    ],
    images: [
      { path: "images/attic.jpg", keywords: [] },
      { path: "images/bedroom-soft.jpg", keywords: ["bedroom", "punishment: 1"] },
      { path: "images/garden.jpg", keywords: ["outdoor"] },
      { path: "images/hall.jpg", keywords: ["hall"] },
    ],
  });
  // The comparison is read when the script runs, so the soft bedroom may be the pick; the computed attic is not known.
  assert.deepEqual(playerRuntimeStageImages(plan!), ["images/hall.jpg", "images/bedroom-soft.jpg"]);
});
