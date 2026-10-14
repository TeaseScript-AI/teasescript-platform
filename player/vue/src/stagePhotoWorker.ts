import { photoSwatches } from "../../theme/node-vibrant/swatches.js";

// Measures a Stage photo's swatches off the page's thread (`stagePhotos.ts`): the browser's image decoder decodes the
// downloaded bytes here, and the photo is drawn at the measuring size on a canvas of this worker.

/** The photo is measured at this longest side, as on the Stage canvas (`stagePhotos.ts`). */
const MEASURE_SIDE = 128;

/** A photo to measure, by its downloaded bytes and their media type. */
export interface StagePhotoRequest {
  readonly id: number;
  readonly type: string;
  readonly data: ArrayBuffer;
}

/**
 * The photo's swatches, or `null` when this browser's image decoder does not decode it here, as for SVG; the page then
 * measures the photo itself.
 */
export interface StagePhotoResponse {
  readonly id: number;
  readonly swatches: ReturnType<typeof photoSwatches> | null;
}

/** The size a JPEG's frame header declares, or `null` without one. */
function jpegSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  // Each segment after the start: 0xff, its marker, and a length that counts itself; a frame header (SOF0 to SOF15, but
  // not 0xc4, 0xc8, or 0xcc) then holds the precision, the height, and the width.
  for (let at = 2; at + 8 < bytes.length; at += 2 + ((bytes[at + 2]! << 8) | bytes[at + 3]!)) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return {
        height: (bytes[at + 5]! << 8) | bytes[at + 6]!,
        width: (bytes[at + 7]! << 8) | bytes[at + 8]!,
      };
  }
  return null;
}

async function measure({ type, data }: StagePhotoRequest) {
  if (typeof ImageDecoder === "undefined" || typeof OffscreenCanvas === "undefined") return null;
  if (!(await ImageDecoder.isTypeSupported(type).catch(() => false))) return null;
  // A JPEG decodes at a reduced size where asked, at least the measuring size but no less than an eighth of each side:
  // Chromium rejects a smaller size.
  let reduced = {};
  const size = type === "image/jpeg" ? jpegSize(new Uint8Array(data)) : null;
  if (size !== null && size.width > 0 && size.height > 0) {
    const scale = Math.min(1, MEASURE_SIDE / Math.max(size.width, size.height));
    reduced = {
      desiredWidth: Math.max(Math.round(size.width * scale), Math.ceil(size.width / 8)),
      desiredHeight: Math.max(Math.round(size.height * scale), Math.ceil(size.height / 8)),
    };
  }
  const decoder = new ImageDecoder({ data, type, ...reduced });
  try {
    const { image } = await decoder.decode();
    try {
      const drawn = Math.min(1, MEASURE_SIDE / Math.max(image.displayWidth, image.displayHeight));
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(image.displayWidth * drawn)),
        Math.max(1, Math.round(image.displayHeight * drawn)),
      );
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return null;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return photoSwatches(context.getImageData(0, 0, canvas.width, canvas.height).data);
    } finally {
      image.close();
    }
  } finally {
    decoder.close();
  }
}

self.addEventListener("message", (event: MessageEvent<StagePhotoRequest>) => {
  const request = event.data;
  void measure(request).then(
    (swatches) => postMessage({ id: request.id, swatches } satisfies StagePhotoResponse),
    () => postMessage({ id: request.id, swatches: null } satisfies StagePhotoResponse),
  );
});
