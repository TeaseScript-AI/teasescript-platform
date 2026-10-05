/**
 * Checks an image file the player chose for `askImage(...)` before it becomes session media. A file's name and the type
 * the browser reports are external data: the image type is read from the file's first bytes, and the browser must
 * decode the image, before the Player stores it. Nothing here limits the size; the media store has no such limit.
 */

/** The file filters of the request: extensions such as `.png` and image MIME types; `null` accepts any image. */
export interface ImageFileFilters {
  readonly types: readonly string[] | null;
  readonly mime: readonly string[] | null;
}

/** The image the browser decoded, or a rejection when it cannot. */
export type ImageDecoder = (
  data: Blob,
) => Promise<{ readonly width: number; readonly height: number }>;

export type CheckedImageFile =
  | {
      readonly ok: true;
      /** The file's bytes with the sniffed image type. */
      readonly data: Blob;
      readonly width: number;
      readonly height: number;
    }
  | { readonly ok: false; readonly message: string };

/** The file types the Player recognizes by their first bytes; the browser still has to decode the image. */
const IMAGE_SIGNATURES: readonly {
  readonly mime: string;
  readonly matches: (header: Uint8Array) => boolean;
}[] = [
  {
    mime: "image/png",
    matches: (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mime: "image/jpeg", matches: (h) => startsWith(h, [0xff, 0xd8, 0xff]) },
  { mime: "image/gif", matches: (h) => ascii(h, 0, "GIF87a") || ascii(h, 0, "GIF89a") },
  { mime: "image/webp", matches: (h) => ascii(h, 0, "RIFF") && ascii(h, 8, "WEBPVP") },
  { mime: "image/bmp", matches: (h) => ascii(h, 0, "BM") },
  { mime: "image/avif", matches: (h) => ascii(h, 4, "ftypavif") || ascii(h, 4, "ftypavis") },
];
const HEADER_BYTES = 16;

export const UNSUPPORTED_IMAGE_MESSAGE =
  "That image is not valid. Choose a PNG, JPEG, GIF, WebP, AVIF, or BMP image.";
export const UNREADABLE_IMAGE_MESSAGE = "That image is not valid. It could not be read.";

/** The image MIME type of a file's first bytes, or `null` when they are not a recognized image. */
export function sniffImageType(header: Uint8Array): string | null {
  return IMAGE_SIGNATURES.find((signature) => signature.matches(header))?.mime ?? null;
}

/**
 * Checks one chosen file: its first bytes name a recognized image type, that type and the file's extension pass the
 * request's filters (both, when both are given), and the browser decodes it.
 */
export async function checkImageFile(
  file: File,
  filters: ImageFileFilters,
  decode: ImageDecoder,
): Promise<CheckedImageFile> {
  let header: Uint8Array;
  try {
    header = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  } catch {
    return { ok: false, message: UNREADABLE_IMAGE_MESSAGE };
  }
  const mime = sniffImageType(header);
  if (mime === null) return { ok: false, message: UNSUPPORTED_IMAGE_MESSAGE };
  const filtered = filterProblem(file.name, mime, filters);
  if (filtered !== null) return { ok: false, message: filtered };
  const data = new Blob([file], { type: mime });
  try {
    const { width, height } = await decode(data);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
      return { ok: false, message: UNREADABLE_IMAGE_MESSAGE };
    return { ok: true, data, width, height };
  } catch {
    return { ok: false, message: UNREADABLE_IMAGE_MESSAGE };
  }
}

/** The `accept` hint of the file picker; browsers may ignore it, so every file is still checked. */
export function imagePickerAccept(filters: ImageFileFilters): string {
  const accepted = [...(filters.types ?? []), ...(filters.mime ?? [])];
  return accepted.length === 0 ? "image/*" : accepted.join(",");
}

/** Browser decoding through `createImageBitmap`, which reads the whole image. */
export const browserImageDecoder: ImageDecoder = async (data) => {
  const bitmap = await createImageBitmap(data);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
};

function filterProblem(name: string, mime: string, filters: ImageFileFilters): string | null {
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot).toLowerCase();
  const types = filters.types?.map((type) => type.toLowerCase()) ?? null;
  const mimes = filters.mime?.map((type) => type.toLowerCase()) ?? null;
  if ((types === null || types.includes(extension)) && (mimes === null || mimes.includes(mime)))
    return null;
  const accepted = [...(filters.types ?? []), ...(filters.mime ?? [])].join(", ");
  return `That image is not valid. Choose an image of these types: ${accepted}.`;
}

function startsWith(header: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => header[index] === byte);
}

function ascii(header: Uint8Array, offset: number, text: string): boolean {
  for (let index = 0; index < text.length; index++)
    if (header[offset + index] !== text.charCodeAt(index)) return false;
  return true;
}
