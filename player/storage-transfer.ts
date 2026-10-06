import {
  validateScriptStorageEntries,
  type RuntimeScriptStorageEntrySnapshot,
  type SerializableRuntimeValue,
} from "../src/index.js";
import { isWellFormedCapturedMediaReference, type CapturedMediaStore } from "./captured-media.js";
import { capturedMediaReferences } from "./captured-media-persistence.js";
import { checkImageFile, type ImageDecoder } from "./image-file.js";
import type { ScriptStorageProvider } from "./script-storage.js";

/**
 * Saved script data moved by hand between browsers: the values of one storage scope and the bytes of the saved photos
 * they reference, in one versioned JSON document. It is not a session checkpoint. A file holds the document compressed
 * with gzip, or the plain JSON where the browser cannot compress; text is `TSST1.gzip.` plus the gzip bytes in unpadded
 * base64url, or the plain JSON. Values keep their stored tagged representation, so they stay editable by hand; gzip's
 * checksum, strict decoding, each photo's byte length, and the importer's image check detect damage, not edits.
 */
export interface StorageTransfer {
  /** The trusted host's storage scope the data belongs to; an import into another scope is refused. */
  readonly scope: string;
  readonly entries: readonly RuntimeScriptStorageEntrySnapshot[];
  /** The original bytes of each saved photo a value references, once per reference. */
  readonly images: readonly StorageTransferImage[];
}

export interface StorageTransferImage {
  readonly reference: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** Why exported data cannot be read; the message is written for the player. */
export class StorageTransferError extends Error {
  override readonly name = "StorageTransferError";
}

const FORMAT = "teasescript-script-storage";
const VERSION = 1;
const TEXT_PREFIX = "TSST1.gzip.";
const GZIP_MAGIC = [0x1f, 0x8b] as const;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// Photo data is encoded in slices this many base64 groups long, so it streams like the rest of the document.
const GROUPS_PER_SLICE = 8192;
// Output is handed to the compressor in pieces of about this many characters.
const PIECE_LENGTH = 65_536;

/**
 * What the provider holds now, read fresh, with the saved photos its values reference; a session's own view and its
 * unsaved photos are not part of it. `missingPhotos` counts captured-media references that resolve to no stored photo;
 * they stay ordinary text in the values.
 */
export async function collectStorageTransfer(
  provider: ScriptStorageProvider,
  media: CapturedMediaStore,
): Promise<{ readonly transfer: StorageTransfer; readonly missingPhotos: number }> {
  const entries = await provider.load();
  const images: StorageTransferImage[] = [];
  const seen = new Set<string>();
  let missingPhotos = 0;
  for (const entry of entries)
    for (const reference of capturedMediaReferences(entry.value)) {
      if (seen.has(reference)) continue;
      seen.add(reference);
      const record = await media.readDurable(reference);
      if (record?.kind === "image")
        images.push({ reference, bytes: new Uint8Array(await record.data.arrayBuffer()) });
      else missingPhotos += 1;
    }
  return { transfer: { scope: provider.scope, entries, images }, missingPhotos };
}

/** Whether this browser can write and read gzip, which compressed files and text need. */
export function gzipSupported(): boolean {
  try {
    new CompressionStream("gzip");
    new DecompressionStream("gzip");
    return true;
  } catch {
    return false;
  }
}

/** The exported file: gzip, or plain JSON without `gzip`. */
export async function storageTransferFile(
  transfer: StorageTransfer,
  gzip = gzipSupported(),
): Promise<Blob> {
  if (!gzip) return new Blob([...pieces(transfer)], { type: "application/json;charset=utf-8" });
  const compression = new CompressionStream("gzip");
  const compressed = new Response(compression.readable).blob();
  const writer = compression.writable.getWriter();
  const encoder = new TextEncoder();
  for (const piece of pieces(transfer)) await writer.write(encoder.encode(piece));
  await writer.close();
  return new Blob([await compressed], { type: "application/gzip" });
}

/** The exported text: `TSST1.gzip.` plus base64url, or plain JSON without `gzip`. */
export async function storageTransferText(
  transfer: StorageTransfer,
  gzip = gzipSupported(),
): Promise<string> {
  if (!gzip) return [...pieces(transfer)].join("");
  const file = await storageTransferFile(transfer, true);
  return TEXT_PREFIX + encodeBase64url(new Uint8Array(await file.arrayBuffer()));
}

/** The file name for an export of the named script: the name kept to safe characters. */
export function storageTransferFileName(name: string, gzip = gzipSupported()): string {
  const safe = name
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 80);
  return `${safe || "script"}-saved-data.teasestorage.json${gzip ? ".gz" : ""}`;
}

/** Reads an exported file; its contents decide whether it is gzip or plain JSON, not its name or type. */
export async function readStorageTransferFile(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<StorageTransfer> {
  const json = isGzip(bytes) ? await gunzip(bytes) : utf8(bytes);
  return parseStorageTransfer(json);
}

/**
 * Reads exported text: `TSST1.gzip.` plus base64url, which may be wrapped across lines, or the plain JSON, for example
 * after editing it by hand.
 */
export async function readStorageTransferText(text: string): Promise<StorageTransfer> {
  const trimmed = text.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, "");
  if (trimmed.startsWith("{")) return parseStorageTransfer(trimmed);
  if (!trimmed.startsWith(TEXT_PREFIX))
    throw new StorageTransferError("This text is not exported saved data.");
  const bytes = decodeBase64url(trimmed.slice(TEXT_PREFIX.length).replace(/[\t\n\f\r ]+/gu, ""));
  if (bytes === null || !isGzip(bytes))
    throw new StorageTransferError("This text is damaged or incomplete; copy all of it again.");
  return parseStorageTransfer(await gunzip(bytes));
}

/** Validates the whole document, every value and every photo's bytes, before anything uses it. */
export function parseStorageTransfer(json: string): StorageTransfer {
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch {
    throw new StorageTransferError("This is not exported saved data: it is not valid JSON.");
  }
  if (!isRecord(document) || document["format"] !== FORMAT)
    throw new StorageTransferError("This is not exported saved data.");
  if (document["version"] !== VERSION)
    throw new StorageTransferError(
      "This saved data uses a format version this Player cannot read.",
    );
  if (!hasExactly(document, ["format", "version", "scope", "entries", "images"]))
    throw new StorageTransferError(
      "This saved data has fields other than format, version, scope, entries, and images.",
    );
  const { scope, entries, images } = document;
  if (typeof scope !== "string") throw new StorageTransferError("The saved data names no script.");
  const failure = validateScriptStorageEntries(entries, "entries");
  if (failure !== null) throw new StorageTransferError(`A saved value is invalid: ${failure}`);
  // EVIDENCE: validation: validateScriptStorageEntries accepted entries as storable script-storage entries.
  const valid = entries as readonly RuntimeScriptStorageEntrySnapshot[];
  if (!Array.isArray(images)) throw new StorageTransferError("The saved photos are not a list.");
  const referenced = new Set<string>();
  for (const entry of valid)
    for (const reference of capturedMediaReferences(entry.value)) referenced.add(reference);
  const decoded: StorageTransferImage[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < images.length; index += 1) {
    decoded.push(parseImage(images[index], `Saved photo ${index + 1}`, referenced, seen));
  }
  return { scope, entries: valid, images: decoded };
}

/** A photo of an import, checked like a chosen image: its type read from its bytes, and decoded by the browser. */
export interface CheckedTransferImage {
  readonly reference: string;
  readonly data: Blob;
  readonly width: number;
  readonly height: number;
}

/** Checks every photo of an import, one at a time; rejects with the first that is not a usable image. */
export async function checkStorageTransferImages(
  transfer: StorageTransfer,
  decode: ImageDecoder,
): Promise<readonly CheckedTransferImage[]> {
  const checked: CheckedTransferImage[] = [];
  for (const [index, image] of transfer.images.entries()) {
    const result = await checkImageFile(
      new File([image.bytes], "imported-image"),
      { types: null, mime: null },
      decode,
    );
    if (!result.ok)
      throw new StorageTransferError(`Saved photo ${index + 1} is damaged: ${result.message}`);
    checked.push({
      reference: image.reference,
      data: result.data,
      width: result.width,
      height: result.height,
    });
  }
  return checked;
}

/**
 * The value with each captured-media reference `references` maps replaced by its new reference, wherever a reference
 * can be held: as text, a list or set item, an object property name or value, or a dict key or value. Other text, such
 * as a script path, is kept. Iterative, so a deeply nested value cannot exhaust the stack.
 */
export function remapCapturedMediaReferences(
  value: SerializableRuntimeValue,
  references: ReadonlyMap<string, string>,
): SerializableRuntimeValue {
  const swap = (text: string) => references.get(text) ?? text;
  const pending: SerializableRuntimeValue[] = [];
  // A copy of a list, set, object, or dict whose direct text is remapped; its nested containers are copied later.
  const copy = (item: SerializableRuntimeValue): SerializableRuntimeValue => {
    if (typeof item === "string") return swap(item);
    if (item === null || typeof item !== "object") return item;
    let copied: SerializableRuntimeValue;
    if (item.kind === "list" || item.kind === "set")
      copied = { kind: item.kind, items: item.items.slice() };
    else if (item.kind === "object")
      copied = {
        kind: "object",
        properties: item.properties.map((property) => ({
          name: swap(property.name),
          value: property.value,
        })),
      };
    else if (item.kind === "dict")
      copied = {
        kind: "dict",
        entries: item.entries.map((entry) => ({ key: swap(entry.key), value: entry.value })),
      };
    else return item;
    pending.push(copied);
    return copied;
  };
  const root = copy(value);
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (current === null || typeof current !== "object") continue;
    if (current.kind === "list" || current.kind === "set")
      for (let index = 0; index < current.items.length; index += 1)
        current.items[index] = copy(current.items[index]!);
    else if (current.kind === "object")
      for (const property of current.properties) property.value = copy(property.value);
    else if (current.kind === "dict")
      for (const entry of current.entries) entry.value = copy(entry.value);
  }
  return root;
}

function parseImage(
  image: unknown,
  label: string,
  referenced: ReadonlySet<string>,
  seen: Set<string>,
): StorageTransferImage {
  if (!isRecord(image) || !hasExactly(image, ["reference", "byteLength", "data"]))
    throw new StorageTransferError(`${label} must have exactly reference, byteLength, and data.`);
  const { reference, byteLength, data } = image;
  if (typeof reference !== "string" || !isWellFormedCapturedMediaReference(reference))
    throw new StorageTransferError(`${label} has no valid photo reference.`);
  if (seen.has(reference)) throw new StorageTransferError(`${label} is listed twice.`);
  seen.add(reference);
  if (!referenced.has(reference))
    throw new StorageTransferError(`${label} is not used by any saved value.`);
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 1)
    throw new StorageTransferError(`${label} has no valid byteLength.`);
  const bytes = typeof data === "string" ? decodeBase64url(data) : null;
  if (bytes === null)
    throw new StorageTransferError(`${label} is damaged: its data is not base64url.`);
  if (bytes.length !== byteLength)
    throw new StorageTransferError(
      `${label} is damaged or incomplete: it has ${bytes.length} bytes instead of ${byteLength}.`,
    );
  return { reference, bytes };
}

/** The document in pieces, with one saved value per line; photo data is encoded slice by slice. */
function* pieces(transfer: StorageTransfer): Generator<string> {
  let pending = `{"format":${JSON.stringify(FORMAT)},"version":${VERSION},"scope":${JSON.stringify(transfer.scope)},\n"entries":[`;
  const emit = function* (text: string): Generator<string> {
    pending += text;
    if (pending.length >= PIECE_LENGTH) {
      yield pending;
      pending = "";
    }
  };
  for (const [index, entry] of transfer.entries.entries())
    yield* emit(
      `${index === 0 ? "\n" : ",\n"}${JSON.stringify({ key: entry.key, value: entry.value })}`,
    );
  yield* emit(`\n],\n"images":[`);
  for (const [index, image] of transfer.images.entries()) {
    yield* emit(
      `${index === 0 ? "\n" : ",\n"}{"reference":${JSON.stringify(image.reference)},"byteLength":${image.bytes.length},"data":"`,
    );
    for (const slice of base64urlSlices(image.bytes)) yield* emit(slice);
    yield* emit(`"}`);
  }
  pending += "\n]}\n";
  yield pending;
}

function encodeBase64url(bytes: Uint8Array): string {
  let text = "";
  for (const slice of base64urlSlices(bytes)) text += slice;
  return text;
}

/** Unpadded base64url of `bytes`, in slices. */
function* base64urlSlices(bytes: Uint8Array): Generator<string> {
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
function decodeBase64url(text: string): Uint8Array<ArrayBuffer> | null {
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

function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (!gzipSupported())
    throw new StorageTransferError(
      "This browser cannot unpack compressed saved data; update it or use another browser.",
    );
  let decompressed: Uint8Array;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    decompressed = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new StorageTransferError("This saved data is damaged or incomplete.");
  }
  return utf8(decompressed);
}

function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StorageTransferError("This is not exported saved data: it is not UTF-8 text.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactly(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}
