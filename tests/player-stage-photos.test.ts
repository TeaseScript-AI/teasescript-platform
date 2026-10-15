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

// The page this module runs in: downloads, Cache Storage, object URLs, images that decode, a canvas whose pixels are one
// green, and a worker that answers each photo with `page.worker`; by default it cannot measure it, as for SVG, so the
// page does.
type WorkerAnswer = (swatches: PhotoSwatches | null) => void;
const cannotMeasure = (_request: unknown, answer: WorkerAnswer): void => {
  setTimeout(() => answer(null));
};
const BASE = "https://player.example/";
const absolute = (url: string) => new URL(url, BASE).href;
// A write that is still going on after its download, as a large file's can, until `until` settles.
let heldWrite: { readonly url: string; readonly until: Promise<unknown> } | null = null;
class PageCache {
  readonly files = new Map<string, Blob>();
  async match(request: string) {
    const file = this.files.get(absolute(request));
    return file && new Response(file);
  }
  async put(request: string, response: Response) {
    const file = await response.blob();
    if (heldWrite?.url === absolute(request)) await heldWrite.until;
    this.files.set(absolute(request), file);
  }
  async keys() {
    return [...this.files.keys()].map((url) => new Request(url));
  }
  async delete(request: Request | string) {
    return this.files.delete(typeof request === "string" ? absolute(request) : request.url);
  }
}
const cacheStorage = new Map<string, PageCache>();
const caches = {
  async open(name: string) {
    let cache = cacheStorage.get(name);
    if (cache === undefined) cacheStorage.set(name, (cache = new PageCache()));
    return cache;
  },
  async delete(name: string) {
    return cacheStorage.delete(name);
  },
};
const photoCache = () => cacheStorage.get("teasescript-stage-photos");
const page = {
  draws: 0,
  downloads: new Array<string>(),
  created: new Set<string>(),
  revoked: new Set<string>(),
  offline: false,
  worker: cannotMeasure,
};
const downloadsOf = (source: string) => page.downloads.filter((url) => url === source).length;
/** Waits until the preloader has had time to download and measure what it was given. */
const preloaded = () => new Promise((resolve) => setTimeout(resolve, 20));
const saved = {
  fetch: globalThis.fetch,
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
};
before(async () => {
  globalThis.fetch = async (input) => {
    if (String(input).includes("unreachable") || page.offline)
      throw new TypeError("Failed to fetch");
    page.downloads.push(String(input));
    return new Response(new Blob([new Uint8Array(16)], { type: "image/png" }));
  };
  // A file left from an earlier visit, which the Player's first use of its cache removes.
  await (
    await caches.open("teasescript-stage-photos")
  ).put("/files/earlier.jpg", new Response(new Blob([new Uint8Array(4)])));
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
    caches,
    ImageDecoder: class {},
    OffscreenCanvas: class {},
    Worker: class {
      #listener: (event: { data: unknown }) => void = () => {};
      addEventListener(kind: string, listener: (event: { data: unknown }) => void) {
        if (kind === "message") this.#listener = listener;
      }
      postMessage(request: { readonly id: number }) {
        page.worker(request, (swatches) => this.#listener({ data: { id: request.id, swatches } }));
      }
    },
    Image: class {
      src = "";
      naturalWidth = 4;
      naturalHeight = 2;
      decode = async () => undefined;
    },
    document: {
      baseURI: BASE,
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
  for (const name of ["caches", "ImageDecoder", "OffscreenCanvas", "Worker", "Image", "document"])
    Reflect.deleteProperty(globalThis, name);
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

test("a preloaded photo is downloaded once into the cache, and its file is in memory only while the Stage holds it", async () => {
  const release = preloadStagePhotos(["/files/garden.jpg"]);
  await preloaded();
  assert.equal(downloadsOf("/files/garden.jpg"), 1);
  assert.equal(photoCache()!.files.has(absolute("/files/garden.jpg")), true);
  assert.equal(
    photoCache()!.files.has(absolute("/files/earlier.jpg")),
    false,
    "the file of an earlier visit was removed",
  );
  const draws = page.draws;
  const first = prepareStagePhoto("/files/garden.jpg");
  const url = await first.shown;
  const swatches = await first.swatches;
  assert.notEqual(swatches?.Vibrant, null, "the preloader measured the photo");
  first.release();
  assert.equal(page.revoked.has(url), true, "the file is not kept once the Stage lets it go");
  const again = prepareStagePhoto("/files/garden.jpg");
  assert.equal(page.created.has(await again.shown), true);
  assert.equal(await again.swatches, swatches);
  assert.equal(page.draws, draws, "the photo is not measured again");
  assert.equal(downloadsOf("/files/garden.jpg"), 1, "the Stage reads the file from the cache");
  again.release();
  release();
});

test("a photo shown while the preloader downloads it shares that download", async () => {
  const release = preloadStagePhotos(["/files/hill.jpg"]);
  const shown = prepareStagePhoto("/files/hill.jpg");
  shown.release();
  const again = prepareStagePhoto("/files/hill.jpg");
  await again.shown;
  assert.equal(downloadsOf("/files/hill.jpg"), 1);
  again.release();
  release();
});

test("without Cache Storage, a photo the preloader measured is downloaded again when it shows", async () => {
  Reflect.deleteProperty(globalThis, "caches");
  try {
    const release = preloadStagePhotos(["/files/pond.jpg"]);
    await preloaded();
    const shown = prepareStagePhoto("/files/pond.jpg");
    assert.equal(page.created.has(await shown.shown), true);
    assert.notEqual(await shown.swatches, null);
    assert.equal(downloadsOf("/files/pond.jpg"), 2);
    shown.release();
    release();
  } finally {
    Object.assign(globalThis, { caches });
  }
});

test("a new script's preload leaves only the files of the photos it names in the cache, also one still being written", async () => {
  let written!: (value?: unknown) => void;
  heldWrite = {
    url: absolute("/files/vault.jpg"),
    until: new Promise((resolve) => (written = resolve)),
  };
  const first = preloadStagePhotos(["/files/cellar.jpg", "/files/attic.jpg", "/files/vault.jpg"]);
  await preloaded();
  const second = preloadStagePhotos(["/files/attic.jpg", "/files/tower.jpg"]);
  first();
  written();
  heldWrite = null;
  await preloaded();
  assert.deepEqual([...photoCache()!.files.keys()].sort(), [
    absolute("/files/attic.jpg"),
    absolute("/files/tower.jpg"),
  ]);
  assert.equal(
    downloadsOf("/files/attic.jpg"),
    1,
    "a photo both scripts name is not downloaded again",
  );
  second();
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

test("a photo given up while the worker tries it gets no object URL", async () => {
  let answer!: () => void;
  const asked = new Promise<void>((resolve) => {
    page.worker = (_request, reply) => {
      answer = () => reply(null);
      resolve();
    };
  });
  const created = page.created.size;
  const release = preloadStagePhotos(["/files/given-up.svg"]);
  await asked;
  release();
  answer();
  await new Promise((resolve) => setTimeout(resolve, 10));
  page.worker = cannotMeasure;
  assert.equal(page.created.size, created);
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
