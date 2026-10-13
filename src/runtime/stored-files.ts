// Files in the Player's file store (V30 §13 and §33): their bytes as Base64 and in data URLs, and their type, which
// their first bytes decide, never a name or a declared type. Bytes are held as binary text, one character per byte, as
// native `atob` gives them and `btoa` takes them.

/** The type of a file whose first bytes match no recognized pattern. It is never shown or played. */
export const OCTET_STREAM = "application/octet-stream";

/** What the file store keeps a file as, by the top level of its type. */
export type StoredFileKind = "image" | "audio" | "video" | "file";

/** How many first bytes decide the type: the resource header of the WHATWG MIME Sniffing standard. */
const HEADER_BYTES = 1445;
/** Enough Base64 for `HEADER_BYTES`: whole groups of three bytes. */
const HEADER_BASE64 = Math.ceil(HEADER_BYTES / 3) * 4;

/**
 * The bytes of Base64 `text`, or `undefined` when it is not Base64. Spaces and line breaks are ignored, the URL
 * alphabet (`-` and `_`) is read like the standard one, and padding may be missing, as for `fromBase64`.
 */
export function binaryFromBase64(text: string): string | undefined {
  try {
    return atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return undefined;
  }
}

/**
 * The bytes of a `data:<type>;base64,…` URL, or `undefined` when `text` is not one or its data is not Base64. The type
 * it declares is not read.
 */
export function binaryFromDataUrl(text: string): string | undefined {
  if (!isDataUrl(text)) return undefined;
  const comma = text.indexOf(",");
  if (comma === -1) return undefined;
  // As the Fetch standard reads a data URL: `;base64` ends its header, spaces before `base64` aside.
  if (!/; *base64$/iu.test(text.slice(5, comma).trim())) return undefined;
  return binaryFromBase64(text.slice(comma + 1));
}

/** Whether `text` starts like a data URL. */
export function isDataUrl(text: string): boolean {
  return text.length > 5 && text.slice(0, 5).toLowerCase() === "data:";
}

/** Bytes as standard Base64, with padding and without line breaks. */
export function base64FromBinary(binary: string): string {
  return btoa(binary);
}

/** The length of the standard Base64 of `bytes` bytes. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** Whether `text` is standard Base64 with padding and without line breaks, as `base64FromBinary` writes it. */
export function isStandardBase64(text: string): boolean {
  return text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(text);
}

/** The type of the file that standard Base64 `text` holds, from its first bytes. */
export function base64FileType(text: string): string {
  return fileType(binaryFromBase64(text.slice(0, HEADER_BASE64)) ?? "");
}

/**
 * The type of a file from its first bytes: the patterns of the WHATWG MIME Sniffing standard for JPEG, PNG, GIF, WebP,
 * MP3, Ogg, WAVE, MP4, and WebM, and an MP4 file whose major brand is `M4A ` as audio. Any other file is
 * `application/octet-stream`.
 */
export function fileType(binary: string): string {
  const header = binary.slice(0, HEADER_BYTES);
  if (header.startsWith("\xFF\xD8\xFF")) return "image/jpeg";
  if (header.startsWith("\x89PNG\r\n\x1A\n")) return "image/png";
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.startsWith("WEBPVP", 8)) return "image/webp";
  if (header.startsWith("ID3")) return "audio/mpeg";
  if (header.startsWith("OggS\0")) return "audio/ogg";
  if (header.startsWith("RIFF") && header.startsWith("WAVE", 8)) return "audio/wave";
  const brands = fileTypeBoxSize(header);
  // An M4A file is MP4 audio; its compatible brands may also name MP4.
  if (brands > 0 && header.startsWith("M4A ", 8)) return "audio/mp4";
  if (brands > 0 && hasMp4Brand(header, brands)) return "video/mp4";
  if (isWebm(header)) return "video/webm";
  if (isMp3WithoutId3(header)) return "audio/mpeg";
  return OCTET_STREAM;
}

/** What the file store keeps a file of `type` as. */
export function storedFileKind(type: string): StoredFileKind {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  return "file";
}

/** Whether a file of `type` is an image, audio, or video file of a recognized type, which `fromJson` keeps as a file. */
export function isRecognizedFileType(type: string): boolean {
  return type !== OCTET_STREAM;
}

/** The size of the ISO file type box that starts the header, as the standard's signature for MP4 reads it, else 0. */
function fileTypeBoxSize(header: string): number {
  if (header.length < 12 || !header.startsWith("ftyp", 4)) return 0;
  const size =
    header.charCodeAt(0) * 0x1000000 +
    (header.charCodeAt(1) << 16) +
    (header.charCodeAt(2) << 8) +
    header.charCodeAt(3);
  return header.length < size || size % 4 !== 0 ? 0 : size;
}

/** Whether the major brand or a compatible brand of a file type box of `size` starts with `mp4`. */
function hasMp4Brand(header: string, size: number): boolean {
  if (header.startsWith("mp4", 8)) return true;
  // The four bytes after the major brand are its version.
  for (let read = 16; read < size; read += 4) if (header.startsWith("mp4", read)) return true;
  return false;
}

/** An EBML header whose document type is `webm`, as the standard's signature for WebM finds it. */
function isWebm(header: string): boolean {
  if (!header.startsWith("\x1A\x45\xDF\xA3")) return false;
  for (let at = 4; at < header.length && at < 38; at += 1) {
    if (!header.startsWith("\x42\x82", at)) continue;
    // The document type element: its size, a variable-length number, then its text, perhaps after zero bytes.
    let data = at + 2;
    if (data >= header.length) return false;
    data += vintLength(header.charCodeAt(data));
    while (data < header.length && header.charCodeAt(data) === 0) data += 1;
    return header.startsWith("webm", data);
  }
  return false;
}

/** How many bytes a variable-length number of EBML takes that starts with `first`: one more than its leading zero bits. */
function vintLength(first: number): number {
  let length = 1;
  for (let mask = 0x80; length < 8 && (first & mask) === 0; mask >>= 1) length += 1;
  return length;
}

/** MPEG-1 Layer III bit rates and those of MPEG-2 and 2.5, by bit rate index. */
const MPEG1_RATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_RATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES = [44_100, 48_000, 32_000];

/**
 * An MP3 frame header at the start, followed by another where that frame ends: the standard's signature for MP3 without
 * ID3, as it intends, for MPEG Layer III.
 */
function isMp3WithoutId3(header: string): boolean {
  const size = mp3FrameSize(header, 0);
  return size !== undefined && size >= 4 && mp3FrameSize(header, size) !== undefined;
}

/** The length of the MP3 frame whose header is at `at`, or `undefined` when no Layer III frame header is there. */
function mp3FrameSize(header: string, at: number): number | undefined {
  if (at + 4 > header.length) return undefined;
  const second = header.charCodeAt(at + 1);
  const third = header.charCodeAt(at + 2);
  if (header.charCodeAt(at) !== 0xff || (second & 0xe0) !== 0xe0) return undefined;
  // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5, 1: reserved.
  const version = (second >> 3) & 0x03;
  const rateIndex = third >> 4;
  const sampleIndex = (third >> 2) & 0x03;
  if (version === 1 || ((second >> 1) & 0x03) !== 1 || rateIndex === 15 || sampleIndex === 3)
    return undefined;
  const kilobits = (version === 3 ? MPEG1_RATES : MPEG2_RATES)[rateIndex]!;
  const sampleRate = SAMPLE_RATES[sampleIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const padding = (third >> 1) & 0x01;
  return Math.floor(((version === 3 ? 144 : 72) * kilobits * 1000) / sampleRate) + padding;
}

/** Whether `references`, in ascending order, holds `text`. */
export function holdsStoredFile(references: readonly string[], text: string): boolean {
  return references[storedFileIndex(references, text)] === text;
}

/** Adds `reference` to `references`, which stay in ascending order without repeats. */
export function addStoredFile(references: string[], reference: string): void {
  const index = storedFileIndex(references, reference);
  if (references[index] !== reference) references.splice(index, 0, reference);
}

/** Where `text` is or would go in `references`, in ascending order. */
function storedFileIndex(references: readonly string[], text: string): number {
  let low = 0;
  let high = references.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (references[middle]! < text) low = middle + 1;
    else high = middle;
  }
  return low;
}
