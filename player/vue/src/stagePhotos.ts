import { photoSwatches, type PhotoSwatches } from "../../theme/node-vibrant/swatches.js";
import type { StagePhotoRequest, StagePhotoResponse } from "./stagePhotoWorker";

// Stage photos (PLAYER-UI.md "Stage and media presentation"), kept per source: each is downloaded once, and that one
// download serves both the Stage, as an object URL, and the measuring of its colours. A photo is kept while the Stage
// shows it or waits for it, or while the preloader holds it to have it ready when the Stage needs it.

/** The photo is measured at this longest side: enough pixels for six swatches, few enough to stay cheap. */
const MEASURE_SIDE = 128;
/** The swatches of this many recent photos are kept, so a photo shown again is not measured again. */
const CACHE_SIZE = 32;
const measured = new Map<string, PhotoSwatches | null>();

/** A photo the Stage is about to show, held until `release`. */
export interface PreparedPhoto {
  /**
   * The URL for the Stage, once the photo is decoded and shows at once: an object URL of its download, or the source
   * itself when it is in the page's memory or could not be downloaded; the Stage then loads it and reports what it gets.
   */
  readonly shown: Promise<string>;
  /** The photo's swatches, `null` when its pixels cannot be read. */
  readonly swatches: Promise<PhotoSwatches | null>;
  /** Gives up this hold; when no hold is left, the download stops or its object URL is revoked. */
  release(): void;
}

interface Entry {
  /** The Stage's and the preloader's holds on the photo, and how many of them are the Stage's. */
  holds: number;
  shows: number;
  readonly download: AbortController;
  /** The download, `null` while the photo waits for the preloader; the bytes, `null` when they could not be fetched. */
  bytes: Promise<Blob | null> | null;
  /** Whether the download failed, so that the Stage tries it again when it shows the photo. */
  failed: boolean;
  swatches: Promise<PhotoSwatches | null> | null;
  /** The object URL of the download, once there is one. */
  url: string | null;
  /** The photo decoded for showing, while the Stage needs it, or for measuring it on the page's canvas. */
  image: { readonly element: HTMLImageElement; readonly decoded: Promise<void> } | null;
}
const entries = new Map<string, Entry>();

function hold(source: string): Entry {
  let entry = entries.get(source);
  if (entry === undefined) {
    entry = {
      holds: 0,
      shows: 0,
      download: new AbortController(),
      bytes: null,
      failed: false,
      swatches: null,
      url: null,
      image: null,
    };
    entries.set(source, entry);
  }
  entry.holds++;
  return entry;
}

function drop(source: string, entry: Entry) {
  if (--entry.holds > 0) return;
  entries.delete(source);
  entry.download.abort();
  if (entry.url !== null && entry.url !== source) URL.revokeObjectURL(entry.url);
  entry.image = null;
}

/** Starts the download of a photo and the measuring of its colours, unless they have started or succeeded. */
function load(source: string, entry: Entry, priority: RequestPriority) {
  if (entry.bytes !== null && !entry.failed) return;
  entry.failed = false;
  // A failed download, such as from another origin that does not share the image, leaves the Stage to load the source.
  const bytes = fetch(source, { signal: entry.download.signal, priority })
    .then((response) => (response.ok ? response.blob() : null))
    .catch(() => null)
    .then((blob) => {
      if (entry.download.signal.aborted) return null;
      entry.failed = blob === null;
      return blob;
    });
  entry.bytes = bytes;
  const known = measured.get(source);
  entry.swatches =
    known !== undefined
      ? Promise.resolve(known)
      : bytes.then(async (blob) => {
          if (blob === null) return null;
          let result: PhotoSwatches | null;
          try {
            result = await measureInWorker(blob);
            if (result === null) {
              const { element, decoded } = decode(source, entry, blob);
              await decoded;
              result = measure(element);
              if (entry.shows === 0) entry.image = null;
            }
          } catch {
            result = null;
          }
          measured.set(source, result);
          if (measured.size > CACHE_SIZE) measured.delete(measured.keys().next().value!);
          return result;
        });
}

/** The photo's image of its URL, decoding: a source in the page's memory, such as a captured photo, as it is. */
function decode(source: string, entry: Entry, blob: Blob) {
  entry.url ??= /^(blob|data):/u.test(source) ? source : URL.createObjectURL(blob);
  if (entry.image === null) {
    const element = new Image();
    element.src = entry.url;
    // Decoded now, so the Stage's image of this URL shows at once; one that does not decode is the Stage's to report.
    entry.image = { element, decoded: element.decode().catch(() => undefined) };
  }
  return entry.image;
}

// The preloader's photos that wait for their download, in order, and whether one is downloaded or measured now. It waits
// while the Stage waits for a photo.
const queue: { readonly source: string; readonly entry: Entry }[] = [];
let preloading = false;
let waiting = 0;

function preloadNext() {
  while (!preloading && waiting === 0 && queue.length > 0) {
    const { source, entry } = queue.shift()!;
    if (entries.get(source) !== entry || entry.bytes !== null) continue;
    load(source, entry, "low");
    preloading = true;
    void Promise.all([entry.bytes, entry.swatches]).then(() => {
      preloading = false;
      preloadNext();
    });
  }
}

/** Prepares the photo of `source` for the Stage, or holds it once more while it is prepared or shown. */
export function prepareStagePhoto(source: string): PreparedPhoto {
  const entry = hold(source);
  entry.shows++;
  load(source, entry, "high");
  let held = true;
  let waited = true;
  waiting++;
  const done = () => {
    if (!waited) return;
    waited = false;
    waiting--;
    preloadNext();
  };
  void Promise.all([entry.bytes, entry.swatches]).then(done);
  return {
    shown: entry.bytes!.then(async (blob) => {
      if (blob === null || !held) return source;
      const { decoded } = decode(source, entry, blob);
      await decoded;
      return entry.url ?? source;
    }),
    swatches: entry.swatches!,
    release() {
      if (!held) return;
      held = false;
      done();
      if (--entry.shows === 0) entry.image = null;
      drop(source, entry);
    },
  };
}

/**
 * Downloads and measures these photos in the background, one at a time and after any photo the Stage waits for, so a
 * later `prepareStagePhoto` of one finds it ready. Returns a function that gives the photos up again.
 */
export function preloadStagePhotos(sources: readonly string[]): () => void {
  const held = sources.map((source) => ({ source, entry: hold(source) }));
  queue.push(...held);
  preloadNext();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const { source, entry } of held) drop(source, entry);
  };
}

/**
 * The swatches of a decoded photo, measured on a canvas of the page, where the worker's image decoder cannot measure it:
 * for SVG, in older browsers, and for a file the image decoder does not take as its type says.
 */
function measure(image: HTMLImageElement): PhotoSwatches | null {
  if (image.naturalWidth === 0 || image.naturalHeight === 0) return null;
  const scale = Math.min(1, MEASURE_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return photoSwatches(context.getImageData(0, 0, canvas.width, canvas.height).data);
}

// One worker measures every photo, started with the first; `null` once it cannot run.
let worker: Worker | null | undefined;
let nextRequest = 0;
const requests = new Map<number, (swatches: StagePhotoResponse["swatches"]) => void>();

function measureInWorker(blob: Blob) {
  if (
    worker === undefined &&
    (typeof ImageDecoder === "undefined" || typeof OffscreenCanvas === "undefined")
  )
    worker = null;
  if (worker === undefined) {
    try {
      worker = new Worker(new URL("./stagePhotoWorker.ts", import.meta.url), { type: "module" });
      worker.addEventListener("message", ({ data }: MessageEvent<StagePhotoResponse>) => {
        requests.get(data.id)?.(data.swatches);
        requests.delete(data.id);
      });
      // A worker that cannot start or run leaves every photo to the page's canvas.
      worker.addEventListener("error", () => {
        worker?.terminate();
        worker = null;
        for (const resolve of requests.values()) resolve(null);
        requests.clear();
      });
    } catch {
      worker = null;
    }
  }
  if (worker === null) return Promise.resolve(null);
  const id = nextRequest++;
  worker.postMessage({ id, blob } satisfies StagePhotoRequest);
  return new Promise<StagePhotoResponse["swatches"]>((resolve) => requests.set(id, resolve));
}
