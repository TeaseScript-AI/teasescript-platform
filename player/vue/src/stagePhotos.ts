import { photoSwatches, type PhotoSwatches } from "../../theme/node-vibrant/swatches.js";
import type { StagePhotoRequest, StagePhotoResponse } from "./stagePhotoWorker";

// Stage photos (PLAYER-UI.md "Stage and media presentation"), kept per source. Each is downloaded once into the
// Player's Cache Storage, from which a later read comes without a new download; one read serves both the Stage, as an
// object URL, and the measuring of its colours. A photo's swatches are kept while the Stage or the preloader holds the
// photo; its file stays in memory only while the Stage shows it or waits for it.

/** The photo is measured at this longest side: enough pixels for six swatches, few enough to stay cheap. */
const MEASURE_SIDE = 128;
/** The swatches of this many recent photos are kept, so a photo shown again is not measured again. */
const CACHE_SIZE = 32;
const measured = new Map<string, PhotoSwatches | null>();

/** The Player's Cache Storage of Stage photo files. */
const PHOTO_CACHE = "teasescript-stage-photos";
let photoCache: Promise<Cache | null> | undefined;

/**
 * The Player's cache of Stage photo files, emptied when the page first uses it, so that a later visit downloads files
 * that changed meanwhile; `null` where the browser offers no Cache Storage, as outside a secure context, or refuses it.
 * Pages empty and open it one after another, so each page has a cache of its own: a page keeps using its cache after a
 * later page removed it by name, while two pages that opened it at the same moment would share one that either trims.
 */
function openPhotoCache(): Promise<Cache | null> | null {
  if (typeof caches === "undefined") return null;
  const reset = async () => {
    await caches.delete(PHOTO_CACHE);
    return caches.open(PHOTO_CACHE);
  };
  const resetInTurn = async () =>
    "locks" in navigator ? await navigator.locks.request(PHOTO_CACHE, reset) : reset();
  photoCache ??= resetInTurn().catch(() => null);
  return photoCache;
}

/** Whether a source is a web address that Cache Storage keeps, unlike a file in the page's memory. */
function cacheable(source: string): boolean {
  return /^https?:$/u.test(new URL(source, document.baseURI).protocol);
}

// The photos being written into the cache, so a read of one waits for it instead of downloading it again.
const writing = new Map<string, Promise<unknown>>();

/**
 * Reads a photo's file: from the Player's cache, downloading it into the cache when it is not there yet, so the file
 * read is the cache's copy on disk rather than one in memory; `null` when it cannot be fetched. Without the cache, or
 * when the cache cannot take the file, each read downloads it again.
 */
async function read(
  source: string,
  signal: AbortSignal,
  priority: RequestPriority,
): Promise<Blob | null> {
  try {
    const cache = cacheable(source) ? await openPhotoCache() : null;
    if (cache) {
      await writing.get(source);
      const kept = await cache.match(source);
      if (kept) return await kept.blob();
      const response = await fetch(source, { signal, priority });
      if (!response.ok) return null;
      const written = cache.put(source, response).then(
        () => true,
        () => false,
      );
      writing.set(source, written);
      const stored = await written;
      if (writing.get(source) === written) writing.delete(source);
      const copy = stored ? await cache.match(source) : undefined;
      if (copy) return await copy.blob();
    }
    const response = await fetch(source, { signal, priority });
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

/** A photo the Stage is about to show, held until `release`. */
export interface PreparedPhoto {
  /**
   * The URL for the Stage, once the photo is decoded and shows at once: an object URL of its file, or the source itself
   * when it is in the page's memory or could not be downloaded; the Stage then loads it and reports what it gets.
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
  /**
   * The photo's file while it is read or the Stage holds it, `null` otherwise; it resolves to `null` when the file could
   * not be fetched.
   */
  bytes: Promise<Blob | null> | null;
  /** Whether the file is being read, so that another hold takes this read instead of downloading it again. */
  reading: boolean;
  /** Whether the read failed, so that the Stage tries it again when it shows the photo. */
  failed: boolean;
  /** The photo's swatches once measuring started; `null` before, and again after its file could not be read. */
  swatches: Promise<PhotoSwatches | null> | null;
  /** The object URL of the file, while there is one. */
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
      reading: false,
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

/** Lets the photo's decoded image and its object URL go. */
function forgetImage(source: string, entry: Entry) {
  entry.image = null;
  if (entry.url !== null && entry.url !== source) URL.revokeObjectURL(entry.url);
  entry.url = null;
}

/** Lets the photo's file go once it is read, and its decoded image; the cache keeps the file. */
function forget(source: string, entry: Entry) {
  if (!entry.reading) entry.bytes = null;
  forgetImage(source, entry);
}

function drop(source: string, entry: Entry) {
  if (--entry.holds > 0) return;
  entries.delete(source);
  entry.download.abort();
  forget(source, entry);
}

/** Starts the read of a photo's file and the measuring of its colours, unless they have started or succeeded. */
function load(source: string, entry: Entry, priority: RequestPriority) {
  if (entry.bytes === null || entry.failed) {
    entry.failed = false;
    entry.reading = true;
    // A failed download, such as from another origin that does not share the image, leaves the Stage to load the source.
    entry.bytes = read(source, entry.download.signal, priority).then((blob) => {
      entry.reading = false;
      if (entry.download.signal.aborted) return null;
      entry.failed = blob === null;
      // Only the Stage keeps the file in memory; the measuring has its own reference while it runs.
      if (entry.shows === 0) entry.bytes = null;
      return blob;
    });
  }
  entry.swatches ??= swatchesOf(source, entry, entry.bytes);
}

/** Measures the photo's swatches from its file, or takes those measured before. */
function swatchesOf(source: string, entry: Entry, bytes: Promise<Blob | null>) {
  const known = measured.get(source);
  if (known !== undefined) return Promise.resolve(known);
  const swatches: Promise<PhotoSwatches | null> = bytes.then(async (blob) => {
    if (blob === null) {
      // Measured again once the file can be read, such as when the Stage tries a failed download again.
      if (entry.swatches === swatches) entry.swatches = null;
      return null;
    }
    let result: PhotoSwatches | null;
    try {
      result = await measureInWorker(blob);
      if (result === null) {
        // A photo given up while the worker tried it is not decoded for the page's canvas any more.
        if (entry.download.signal.aborted) return null;
        const { element, decoded } = decode(source, entry, blob);
        await decoded;
        result = measure(element);
        if (entry.shows === 0) forgetImage(source, entry);
      }
    } catch {
      result = null;
    }
    measured.set(source, result);
    if (measured.size > CACHE_SIZE) measured.delete(measured.keys().next().value!);
    return result;
  });
  return swatches;
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
    if (entries.get(source) !== entry || entry.bytes !== null || entry.swatches !== null) continue;
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
      if (--entry.shows === 0) forget(source, entry);
      drop(source, entry);
    },
  };
}

/**
 * Downloads and measures these photos in the background into the Player's cache, one at a time and after any photo the
 * Stage waits for, so a later `prepareStagePhoto` of one finds its colours ready and its file without a new download.
 * The cache keeps no other files from then on. Returns a function that gives the photos up again.
 */
export function preloadStagePhotos(sources: readonly string[]): () => void {
  void keepOnly(sources).catch(() => {});
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
 * Removes the files of other photos from the Player's cache, such as those of an earlier script; one still being
 * written, whose download may have ended before the write, goes once it is written.
 */
async function keepOnly(sources: readonly string[]) {
  const cache = await openPhotoCache();
  if (!cache) return;
  const address = (source: string) => new URL(source, document.baseURI).href;
  const kept = new Set(sources.map(address));
  for (const [source, written] of writing)
    if (!kept.has(address(source))) void written.then(() => cache.delete(source));
  for (const request of await cache.keys()) if (!kept.has(request.url)) void cache.delete(request);
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

async function measureInWorker(blob: Blob): Promise<StagePhotoResponse["swatches"]> {
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
  if (worker === null) return null;
  // The worker gets the file's bytes, not the file: a file it held would stay in memory until its next garbage
  // collection, while the bytes count towards it.
  const data = await blob.arrayBuffer();
  if (worker === null) return null;
  const id = nextRequest++;
  const answer = new Promise<StagePhotoResponse["swatches"]>((resolve) =>
    requests.set(id, resolve),
  );
  worker.postMessage({ id, type: blob.type, data } satisfies StagePhotoRequest, [data]);
  return answer;
}
