/**
 * Encoding shared by the files the Player writes for players and developers to move by hand: unpadded base64url for
 * binary data inside JSON, and native gzip with a plain-JSON fallback where the browser cannot compress.
 */

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// Binary data is encoded in slices this many base64 groups long, so it streams like the rest of a document.
const GROUPS_PER_SLICE = 8192;
// Output is handed to the compressor in pieces of about this many characters.
const PIECE_LENGTH = 65_536;

/** Whether this browser can write and read gzip. */
export function gzipSupported(): boolean {
  try {
    new CompressionStream("gzip");
    new DecompressionStream("gzip");
    return true;
  } catch {
    return false;
  }
}

/** A JSON document written from `pieces`: compressed with gzip, or plain without `gzip`. */
export async function jsonFile(pieces: Iterable<string>, gzip: boolean): Promise<Blob> {
  if (!gzip) return new Blob([...batched(pieces)], { type: "application/json;charset=utf-8" });
  const compression = new CompressionStream("gzip");
  const compressed = new Response(compression.readable).blob();
  const writer = compression.writable.getWriter();
  const encoder = new TextEncoder();
  for (const piece of batched(pieces)) await writer.write(encoder.encode(piece));
  await writer.close();
  return new Blob([await compressed], { type: "application/gzip" });
}

/** Joins small pieces into ones of about `PIECE_LENGTH` characters. */
function* batched(pieces: Iterable<string>): Generator<string> {
  let pending = "";
  for (const piece of pieces) {
    pending += piece;
    if (pending.length >= PIECE_LENGTH) {
      yield pending;
      pending = "";
    }
  }
  if (pending !== "") yield pending;
}

export function encodeBase64url(bytes: Uint8Array): string {
  let text = "";
  for (const slice of base64urlSlices(bytes)) text += slice;
  return text;
}

/** Unpadded base64url of `bytes`, in slices. */
export function* base64urlSlices(bytes: Uint8Array): Generator<string> {
  const sliceBytes = GROUPS_PER_SLICE * 3;
  for (let start = 0; start < bytes.length; start += sliceBytes) {
    const end = Math.min(start + sliceBytes, bytes.length);
    let text = "";
    let index = start;
    for (; index + 3 <= end; index += 3) {
      const group = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
      text +=
        BASE64URL[group >> 18]! +
        BASE64URL[(group >> 12) & 63]! +
        BASE64URL[(group >> 6) & 63]! +
        BASE64URL[group & 63]!;
    }
    if (end - index === 1) {
      const group = bytes[index]! << 16;
      text += BASE64URL[group >> 18]! + BASE64URL[(group >> 12) & 63]!;
    } else if (end - index === 2) {
      const group = (bytes[index]! << 16) | (bytes[index + 1]! << 8);
      text +=
        BASE64URL[group >> 18]! + BASE64URL[(group >> 12) & 63]! + BASE64URL[(group >> 6) & 63]!;
    }
    yield text;
  }
}

// The value of each base64url character code below 128, or -1.
const BASE64URL_VALUES = new Int8Array(128).fill(-1);
for (let value = 0; value < BASE64URL.length; value += 1)
  BASE64URL_VALUES[BASE64URL.charCodeAt(value)] = value;

/** The bytes of canonical unpadded base64url, or `null` for anything else, such as padding or stray bits. */
export function decodeBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  const remainder = text.length % 4;
  if (remainder === 1) return null;
  const bytes = new Uint8Array(
    Math.floor(text.length / 4) * 3 + (remainder === 0 ? 0 : remainder - 1),
  );
  let byte = 0;
  for (let index = 0; index < text.length; index += 4) {
    const length = Math.min(4, text.length - index);
    let group = 0;
    for (let offset = 0; offset < 4; offset += 1) {
      const value = offset < length ? (BASE64URL_VALUES[text.charCodeAt(index + offset)] ?? -1) : 0;
      if (value < 0) return null;
      group = (group << 6) | value;
    }
    // Canonical: the bits after the last whole byte of a short final group are zero.
    if ((length === 2 && (group & 0xffff) !== 0) || (length === 3 && (group & 0xff) !== 0))
      return null;
    bytes[byte++] = group >> 16;
    if (length > 2) bytes[byte++] = (group >> 8) & 0xff;
    if (length > 3) bytes[byte++] = group & 0xff;
  }
  return bytes;
}

/** Whether `bytes` start like a gzip stream. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}
