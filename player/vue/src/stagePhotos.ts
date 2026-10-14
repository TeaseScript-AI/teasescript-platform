import { photoSwatches, type PhotoSwatches } from "../../theme/node-vibrant/swatches.js";
import type { StagePhotoRequest, StagePhotoResponse } from "./stagePhotoWorker";

// Stage photos prepared for showing (PLAYER-UI.md "Stage and media presentation"): each source is downloaded once, and
// that one download serves both the Stage, as an object URL, and the measuring of its colours. Kept per source while
// the Stage shows the photo or waits for it.

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
  holds: number;
  readonly download: AbortController;
  /** The object URL of the download, and the decoded image, once there are; the image keeps its decoding ready. */
  url: string | null;
  image: HTMLImageElement | null;
  readonly shown: Promise<string>;
  readonly swatches: Promise<PhotoSwatches | null>;
}
const entries = new Map<string, Entry>();

/** Prepares the photo of `source`, or holds it once more while it is prepared or shown. */
export function prepareStagePhoto(source: string): PreparedPhoto {
  const entry = entries.get(source) ?? start(source);
  entry.holds++;
  let held = true;
  return {
    shown: entry.shown,
    swatches: entry.swatches,
    release() {
      if (!held) return;
      held = false;
      if (--entry.holds > 0) return;
      entries.delete(source);
      entry.download.abort();
      if (entry.url !== null) URL.revokeObjectURL(entry.url);
      entry.image = null;
    },
  };
}

function start(source: string): Entry {
  const download = new AbortController();
  const known = measured.get(source);
  // A failed download, such as from another origin that does not share the image, leaves the Stage to load the source.
  const prepared = fetch(source, { signal: download.signal })
    .then((response) => (response.ok ? response.blob() : null))
    .catch(() => null)
    .then((blob) => {
      if (blob === null || download.signal.aborted) return null;
      // The worker measures while the page decodes the photo for the Stage.
      const measuring = known === undefined ? measureInWorker(blob) : null;
      // A source in the page's memory, such as a captured photo, shows as it is; a download by an object URL of it.
      const url = /^(blob|data):/u.test(source) ? source : URL.createObjectURL(blob);
      if (url !== source) entry.url = url;
      const image = new Image();
      image.src = url;
      entry.image = image;
      // Decoded now, so the Stage's image of this URL shows at once; one that does not decode is the Stage's to report.
      const decoded = image.decode().catch(() => undefined);
      return { url, image, decoded, measuring };
    });
  const entry: Entry = {
    holds: 0,
    download,
    url: null,
    image: null,
    shown: prepared.then(async (photo) => {
      if (photo === null) return source;
      await photo.decoded;
      return photo.url;
    }),
    swatches:
      known !== undefined
        ? Promise.resolve(known)
        : prepared.then(async (photo) => {
            if (photo === null) return null;
            let result: PhotoSwatches | null | "unsupported";
            try {
              result = await photo.measuring!;
              if (result === "unsupported") {
                await photo.decoded;
                result = measure(photo.image);
              }
            } catch {
              result = null;
            }
            measured.set(source, result);
            if (measured.size > CACHE_SIZE) measured.delete(measured.keys().next().value!);
            return result;
          }),
  };
  entries.set(source, entry);
  return entry;
}

/**
 * The swatches of a decoded photo, measured on a canvas of the page, where the worker's image decoder cannot measure it:
 * for SVG, and in older browsers.
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
const waiting = new Map<number, (swatches: StagePhotoResponse["swatches"]) => void>();

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
        waiting.get(data.id)?.(data.swatches);
        waiting.delete(data.id);
      });
      // A worker that cannot start or run leaves every photo to the page's canvas.
      worker.addEventListener("error", () => {
        worker?.terminate();
        worker = null;
        for (const resolve of waiting.values()) resolve("unsupported");
        waiting.clear();
      });
    } catch {
      worker = null;
    }
  }
  if (worker === null) return Promise.resolve("unsupported" as const);
  const id = nextRequest++;
  worker.postMessage({ id, blob } satisfies StagePhotoRequest);
  return new Promise<StagePhotoResponse["swatches"]>((resolve) => waiting.set(id, resolve));
}
