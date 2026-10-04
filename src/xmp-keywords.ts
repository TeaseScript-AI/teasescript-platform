/** The `dc:subject` keywords read from XMP metadata, or why they could not be read. */
export type XmpKeywordsResult =
  | { readonly kind: "keywords"; readonly keywords: readonly string[] } // dc:subject found; may be empty
  | { readonly kind: "none" } // no XMP packet, or a packet without dc:subject
  | { readonly kind: "unsupported"; readonly reason: string } // a valid file whose XMP this reader deliberately does not read
  | { readonly kind: "invalid"; readonly reason: string }; // malformed container or XMP

type Failure = Extract<XmpKeywordsResult, { readonly reason: string }>;

/** The XMP packet a container holds, `null` when it holds none, or why it cannot be extracted. */
type Extraction = Uint8Array | null | Failure;

/*
 * Implementation limits of this reader, not project policy, set well above typical photo-tool XMP such as Lightroom
 * sidecars of hundreds of KB. XMP beyond a limit is `unsupported`. Container walks need no limit of their own: every
 * step moves past a header within the file, and a TIFF is read from its first image directory only, never following
 * directory offsets, so cyclic offsets cannot loop.
 */
/** The most bytes of one XMP packet or sidecar file that the reader decodes and parses. */
export const MAX_XMP_PACKET_BYTES = 16 * 1024 * 1024;
/** The deepest element nesting the reader accepts, counting the root element as depth 1. */
export const MAX_XMP_ELEMENT_DEPTH = 1_000;
/** The most `dc:subject` keywords the reader returns from one packet. */
export const MAX_XMP_KEYWORDS = 10_000;

/** What a packet says about keywords: `null` keywords when it has no `dc:subject` array. */
interface Packet {
  readonly kind: "packet";
  readonly keywords: readonly string[] | null;
  /** Whether a top-level description has `xmpNote:HasExtendedXMP`: a JPEG's standard packet refers to Extended XMP. */
  readonly hasExtendedXmp: boolean;
}

/** The `dc:subject` keywords embedded in an image, detected by its signature: JPEG, PNG, WebP, GIF, or TIFF. */
export function readImageXmpKeywords(bytes: Uint8Array): XmpKeywordsResult {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return readJpegKeywords(bytes);
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return keywordsOf(pngPacket(bytes));
  }
  if (hasAscii(bytes, 0, "RIFF") && hasAscii(bytes, 8, "WEBP")) {
    return keywordsOf(webpPacket(bytes));
  }
  if (hasAscii(bytes, 0, "GIF87a") || hasAscii(bytes, 0, "GIF89a")) {
    return keywordsOf(gifPacket(bytes));
  }
  if (["II*\0", "MM\0*", "II+\0", "MM\0+"].some((signature) => hasAscii(bytes, 0, signature))) {
    return keywordsOf(tiffPacket(bytes));
  }
  return unsupported(
    "The file is not a JPEG, PNG, WebP, GIF, or TIFF image; save its tags in a sidecar file instead.",
  );
}

/** The `dc:subject` keywords of an XMP packet or a sidecar file such as `room.jpg.xmp`. */
export function readXmpPacketKeywords(bytes: Uint8Array): XmpKeywordsResult {
  const packet = readPacket(bytes);
  if (packet.kind !== "packet") return packet;
  return packet.keywords === null
    ? { kind: "none" }
    : { kind: "keywords", keywords: packet.keywords };
}

function keywordsOf(extraction: Extraction): XmpKeywordsResult {
  if (extraction === null) return { kind: "none" };
  return "kind" in extraction ? extraction : readXmpPacketKeywords(extraction);
}

function invalid(reason: string): Failure {
  return { kind: "invalid", reason };
}

function unsupported(reason: string): Failure {
  return { kind: "unsupported", reason };
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte);
}

/** Whether the bytes at `at`, before `limit`, spell `text` in ASCII. */
function hasAscii(bytes: Uint8Array, at: number, text: string, limit = bytes.length): boolean {
  if (at + text.length > limit) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[at + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

const JPEG_XMP = "http://ns.adobe.com/xap/1.0/\0";
const JPEG_MALFORMED = "The JPEG has a malformed or truncated segment.";

/**
 * Walks the JPEG marker segments before the image data (SOS) and reads the standard XMP packet of the first APP1
 * segment that has one. Extended XMP is not read; when the standard packet has no `dc:subject` but refers to Extended
 * XMP, the keywords may be there.
 */
function readJpegKeywords(bytes: Uint8Array): XmpKeywordsResult {
  const data = view(bytes);
  let packet: Uint8Array | null = null;
  let at = 2;
  for (;;) {
    if (bytes[at] !== 0xff) return invalid(JPEG_MALFORMED);
    while (bytes[at] === 0xff) at += 1; // Fill bytes may precede a marker code.
    if (at >= bytes.length) return invalid(JPEG_MALFORMED);
    const marker = data.getUint8(at);
    at += 1;
    if (marker === 0xda || marker === 0xd9) break; // Start of scan or end of image.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // Markers without a segment.
    if (marker === 0x00 || marker === 0xd8 || at + 2 > bytes.length) return invalid(JPEG_MALFORMED);
    const end = at + data.getUint16(at);
    if (end < at + 2 || end > bytes.length) return invalid(JPEG_MALFORMED);
    if (marker === 0xe1 && packet === null && hasAscii(bytes, at + 2, JPEG_XMP, end)) {
      packet = bytes.subarray(at + 2 + JPEG_XMP.length, end);
    }
    at = end;
  }
  if (packet === null) return { kind: "none" };
  const xmp = readPacket(packet);
  if (xmp.kind !== "packet") return xmp;
  if (xmp.keywords !== null) return { kind: "keywords", keywords: xmp.keywords };
  if (xmp.hasExtendedXmp) {
    return unsupported(
      "The JPEG stores part of its XMP as Extended XMP, which may hold its keywords; save the tags in a sidecar file instead.",
    );
  }
  return { kind: "none" };
}

const PNG_MALFORMED = "The PNG has a malformed or truncated chunk.";

/** The text of the first `iTXt` chunk with keyword `XML:com.adobe.xmp`, walking chunks until `IEND`. */
function pngPacket(bytes: Uint8Array): Extraction {
  const data = view(bytes);
  for (let at = 8; ;) {
    if (at + 8 > bytes.length) return invalid(PNG_MALFORMED);
    const start = at + 8;
    const end = start + data.getUint32(at);
    if (end + 4 > bytes.length) return invalid(PNG_MALFORMED);
    if (hasAscii(bytes, at + 4, "iTXt") && hasAscii(bytes, start, "XML:com.adobe.xmp\0", end)) {
      return internationalText(bytes.subarray(start + 18, end));
    }
    if (hasAscii(bytes, at + 4, "IEND")) return null;
    at = end + 4; // Skips the CRC.
  }
}

/** The text of an `iTXt` chunk after its keyword: compression flag and method, language, translated keyword, text. */
function internationalText(fields: Uint8Array): Extraction {
  const language = fields.indexOf(0, 2);
  const translatedKeyword = language < 0 ? -1 : fields.indexOf(0, language + 1);
  const compressed = fields[0];
  if (translatedKeyword < 0 || (compressed !== 0 && compressed !== 1)) {
    return invalid("The PNG has a malformed XMP text chunk.");
  }
  if (compressed === 1) {
    return unsupported(
      "The PNG stores its XMP compressed; save the tags in a sidecar file instead.",
    );
  }
  return fields.subarray(translatedKeyword + 1);
}

const WEBP_MALFORMED = "The WebP has a malformed or truncated chunk.";

/** The payload of the first `XMP ` chunk of the RIFF container. */
function webpPacket(bytes: Uint8Array): Extraction {
  const data = view(bytes);
  const riffEnd = 8 + data.getUint32(4, true);
  if (riffEnd < 12 || riffEnd > bytes.length) return invalid(WEBP_MALFORMED);
  for (let at = 12; at < riffEnd;) {
    if (at + 8 > riffEnd) return invalid(WEBP_MALFORMED);
    const size = data.getUint32(at + 4, true);
    const end = at + 8 + size;
    const next = end + (size % 2); // Odd-sized chunks have a pad byte.
    if (next > riffEnd) return invalid(WEBP_MALFORMED);
    if (hasAscii(bytes, at, "XMP ")) return bytes.subarray(at + 8, end);
    at = next;
  }
  return null;
}

const GIF_MALFORMED = "The GIF has a malformed or truncated block.";
/** The bytes after raw GIF XMP: 1, 255 down to 0, and the block terminator 0. */
const GIF_XMP_TRAILER_LENGTH = 258;

/**
 * The XMP of the first `XMP DataXMP` application extension. Its packet is stored as raw bytes, not as sub-blocks: a
 * trailer makes a decoder that reads the bytes as sub-blocks land on the extension's terminator.
 */
function gifPacket(bytes: Uint8Array): Extraction {
  if (bytes.length < 13) return invalid(GIF_MALFORMED);
  const data = view(bytes);
  let at = 13 + colorTableSize(data.getUint8(10)); // Header, logical screen descriptor, global color table.
  for (;;) {
    if (at < 0 || at >= bytes.length) return invalid(GIF_MALFORMED);
    const introducer = data.getUint8(at);
    if (introducer === 0x3b) return null; // Trailer.
    if (introducer === 0x21) {
      const xmp = at + 14;
      if (
        bytes[at + 1] === 0xff &&
        bytes[at + 2] === 11 &&
        hasAscii(bytes, at + 3, "XMP DataXMP")
      ) {
        const end = skipSubBlocks(bytes, xmp);
        const trailer = end - GIF_XMP_TRAILER_LENGTH;
        if (end < 0 || trailer < xmp || !isGifXmpTrailer(bytes, trailer)) {
          return invalid("The GIF has a malformed XMP extension.");
        }
        return bytes.subarray(xmp, trailer);
      }
      at = skipSubBlocks(bytes, at + 2);
    } else if (introducer === 0x2c) {
      if (at + 10 > bytes.length) return invalid(GIF_MALFORMED);
      // Image descriptor, local color table, LZW minimum code size, image data.
      at = skipSubBlocks(bytes, at + 10 + colorTableSize(data.getUint8(at + 9)) + 1);
    } else {
      return invalid(GIF_MALFORMED);
    }
  }
}

function colorTableSize(packedFields: number): number {
  return packedFields & 0x80 ? 3 * 2 ** ((packedFields & 0x07) + 1) : 0;
}

/** The position after the terminator of the sub-blocks starting at `at`, or -1 when they run past the end. */
function skipSubBlocks(bytes: Uint8Array, at: number): number {
  for (let size = bytes[at]; size !== undefined; size = bytes[at]) {
    at += 1 + size;
    if (size === 0) return at;
  }
  return -1;
}

function isGifXmpTrailer(bytes: Uint8Array, at: number): boolean {
  if (bytes[at] !== 1 || bytes[at + GIF_XMP_TRAILER_LENGTH - 1] !== 0) return false;
  for (let index = 1; index <= 256; index += 1) {
    if (bytes[at + index] !== 256 - index) return false;
  }
  return true;
}

const TIFF_MALFORMED = "The TIFF has a malformed or truncated image directory.";

/** The value of tag 700 (XMP) in the first image directory (IFD0) of a classic TIFF. */
function tiffPacket(bytes: Uint8Array): Extraction {
  const data = view(bytes);
  const little = bytes[0] === 0x49;
  if (data.getUint16(2, little) === 43) {
    return unsupported("The image is a BigTIFF; save its tags in a sidecar file instead.");
  }
  if (bytes.length < 8) return invalid(TIFF_MALFORMED);
  const directory = data.getUint32(4, little);
  if (directory + 2 > bytes.length) return invalid(TIFF_MALFORMED);
  const entriesEnd = directory + 2 + 12 * data.getUint16(directory, little);
  if (entriesEnd + 4 > bytes.length) return invalid(TIFF_MALFORMED); // Entries, then the next directory's offset.
  for (let entry = directory + 2; entry < entriesEnd; entry += 12) {
    if (data.getUint16(entry, little) !== 700) continue;
    const type = data.getUint16(entry + 2, little);
    const length = data.getUint32(entry + 4, little); // A count of BYTE or UNDEFINED values.
    const start = length <= 4 ? entry + 8 : data.getUint32(entry + 8, little);
    if ((type !== 1 && type !== 7) || start + length > bytes.length) {
      return invalid("The TIFF has a malformed XMP tag.");
    }
    return bytes.subarray(start, start + length);
  }
  return null;
}

/** Decodes and reads a packet; a malformed one is `invalid`, and one beyond a limit is `unsupported`. */
function readPacket(bytes: Uint8Array): Packet | Failure {
  if (bytes.length > MAX_XMP_PACKET_BYTES) {
    return unsupported(
      `The XMP is larger than ${MAX_XMP_PACKET_BYTES / 1024 / 1024} MiB, the most this reader accepts; save the tags in a smaller sidecar file instead.`,
    );
  }
  const text = decodePacket(bytes);
  if (typeof text !== "string") return text;
  try {
    return new SubjectReader(text.replace(/\r\n?/gu, "\n")).read();
  } catch (error) {
    if (error instanceof PacketFailure) return error.failure;
    throw error;
  }
}

/** Decodes UTF-8, or UTF-16 with a byte order mark. */
function decodePacket(bytes: Uint8Array): string | Failure {
  const utf32 = [
    [0x00, 0x00, 0xfe, 0xff],
    [0xff, 0xfe, 0x00, 0x00],
    [0x00, 0x00, 0x00, 0x3c],
    [0x3c, 0x00, 0x00, 0x00],
  ];
  if (utf32.some((prefix) => startsWith(bytes, prefix))) {
    return unsupported("The XMP is encoded as UTF-32; save it as UTF-8 instead.");
  }
  const encoding = startsWith(bytes, [0xfe, 0xff])
    ? "utf-16be"
    : startsWith(bytes, [0xff, 0xfe])
      ? "utf-16le"
      : "utf-8";
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes); // Removes a byte order mark.
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return invalid(`The XMP is not valid ${encoding.toUpperCase()} text.`);
  }
}

/** Ends reading a packet with `failure`; `readPacket` returns it. */
class PacketFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.reason);
  }
}

function malformed(reason: string): never {
  throw new PacketFailure(invalid(reason));
}

function beyondLimit(reason: string): never {
  throw new PacketFailure(unsupported(reason));
}

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const DUBLIN_CORE = "http://purl.org/dc/elements/1.1/";
const ADOBE_META = "adobe:ns:meta/";
const XMP_NOTE = "http://ns.adobe.com/xmp/note/";
const XML = "http://www.w3.org/XML/1998/namespace";
const XMLNS = "http://www.w3.org/2000/xmlns/";

const NOT_XML_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u;
const PREDEFINED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

/**
 * Where an element sits on the path to keywords: `x:xmpmeta` (optional) → `rdf:RDF` → `rdf:Description` →
 * `dc:subject` → `rdf:Bag`/`rdf:Seq` → `rdf:li`, whose text is a keyword. A qualified `rdf:li` holds its keyword in
 * `rdf:value`, directly (`rdf:parseType="Resource"`) or in a nested `rdf:Description`. Everything else is `other`.
 */
type Role =
  | "meta"
  | "rdf"
  | "description"
  | "subject"
  | "array"
  | "item"
  | "itemDescription"
  | "value"
  | "other";

interface OpenElement {
  readonly name: string;
  readonly role: Role;
  /** The length of `shadowed` before this element's namespace declarations. */
  readonly scope: number;
}

interface Namespace {
  readonly uri: string;
  readonly id: number;
}

interface Attribute {
  readonly namespace: string;
  readonly localName: string;
  readonly value: string;
}

/** The `rdf:li` being read: its direct text, and its `rdf:value` when it is qualified. */
interface Item {
  readonly text: string[];
  hasElements: boolean;
  readonly resource: boolean;
  value: string | null;
}

/**
 * A streaming, namespace-aware reader of an XMP packet's well-formed XML that collects `dc:subject` keywords. It reads
 * each character a bounded number of times and keeps open elements on an explicit stack.
 */
class SubjectReader {
  private at = 0;
  private readonly open: OpenElement[] = [];
  /** A number for each namespace URI, so that equal URIs compare without comparing their text again. */
  private readonly namespaceIds = new Map<string, number>([[XML, 0]]);
  private readonly namespaces = new Map<string, Namespace>([["xml", { uri: XML, id: 0 }]]);
  /** The bindings that open elements' declarations replaced, restored when those elements close. */
  private readonly shadowed: [prefix: string, namespace: Namespace | undefined][] = [];
  private hasRoot = false;
  private keywords: string[] | null = null;
  private hasExtendedXmp = false;
  private item: Item | null = null;
  /** The text of the open `rdf:value`, or `null` when it is not plain text. */
  private valueText: string[] | null = null;

  constructor(private readonly text: string) {}

  read(): Packet {
    const text = this.text;
    if (NOT_XML_CHARACTER.test(text)) {
      malformed("The XMP contains a character that XML does not allow.");
    }
    while (this.at < text.length) {
      const markup = text.indexOf("<", this.at);
      const textEnd = markup < 0 ? text.length : markup;
      if (textEnd > this.at) this.characters(text.slice(this.at, textEnd), false);
      if (markup < 0) break;
      if (text.startsWith("<!--", markup)) {
        const close = text.indexOf("--", markup + 4); // A comment cannot contain --.
        if (close < 0) malformed("The XMP is missing a closing -->.");
        if (text[close + 2] !== ">") malformed("The XMP has -- inside a comment.");
        this.at = close + 3;
      } else if (text.startsWith("<![CDATA[", markup)) {
        this.at = this.endOf("]]>", markup + 9);
        this.characters(text.slice(markup + 9, this.at - 3), true);
      } else if (text.startsWith("<!", markup)) {
        malformed(
          "The XMP contains a DOCTYPE or another markup declaration, which XMP does not allow.",
        );
      } else if (text.startsWith("<?", markup)) {
        this.at = markup + 2;
        this.processingInstruction(markup);
      } else if (text.startsWith("</", markup)) {
        this.at = markup + 2;
        this.endTag();
      } else {
        this.at = markup + 1;
        this.startTag();
      }
    }
    const unclosed = this.open.at(-1);
    if (unclosed !== undefined) malformed(`The XMP never closes <${unclosed.name}>.`);
    if (!this.hasRoot) malformed("The XMP has no root element.");
    return { kind: "packet", keywords: this.keywords, hasExtendedXmp: this.hasExtendedXmp };
  }

  /** The position after the next `delimiter` at or after `from`. */
  private endOf(delimiter: string, from: number): number {
    const at = this.text.indexOf(delimiter, from);
    if (at < 0) malformed(`The XMP is missing a closing ${delimiter}.`);
    return at + delimiter.length;
  }

  /** Reads an XML 1.0 `Name`, which may contain colons. */
  private name(): string {
    const start = this.at;
    for (;;) {
      const code = this.text.codePointAt(this.at);
      const isNameCharacter =
        code !== undefined &&
        (code === 0x3a || (this.at === start ? isNameStart(code) : isNamePart(code)));
      if (!isNameCharacter) break;
      this.at += code > 0xffff ? 2 : 1;
    }
    if (this.at === start) malformed("The XMP has a malformed tag or name.");
    return this.text.slice(start, this.at);
  }

  /** Skips whitespace and returns whether there was any. */
  private skipSpace(): boolean {
    const start = this.at;
    while (isSpace(this.text.charCodeAt(this.at))) this.at += 1;
    return this.at > start;
  }

  /** Reads a processing instruction such as `<?xpacket begin="" ?>`, or the XML declaration at the start. */
  private processingInstruction(markup: number): void {
    const target = this.name();
    const end = this.endOf("?>", this.at);
    const content = this.text.slice(this.at, end - 2);
    this.at = end;
    if ((content !== "" && !isSpace(content.charCodeAt(0))) || target.includes(":")) {
      malformed(`The XMP has a malformed <?${target}?> processing instruction.`);
    }
    const isDeclaration = target.toLowerCase() === "xml";
    if (isDeclaration && (target !== "xml" || markup !== 0 || !isXmlDeclaration(content))) {
      malformed("The XMP has a malformed XML declaration, or one that is not at its start.");
    }
  }

  private characters(raw: string, cdata: boolean): void {
    const role = this.open.at(-1)?.role;
    if (role === undefined) {
      if (!cdata && isBlank(raw)) return;
      malformed("The XMP has text outside its root element.");
    }
    if (!cdata && raw.includes("]]>")) malformed("The XMP has ]]> outside a CDATA section.");
    const text = cdata ? raw : decodeReferences(raw);
    if (role === "item") this.item?.text.push(text);
    else if (role === "value") this.valueText?.push(text);
  }

  private startTag(): void {
    const name = this.name();
    const rawAttributes = new Map<string, string>();
    let empty = false;
    for (;;) {
      const spaced = this.skipSpace();
      if (this.text.startsWith("/>", this.at)) {
        empty = true;
        this.at += 2;
        break;
      }
      if (this.text.startsWith(">", this.at)) {
        this.at += 1;
        break;
      }
      if (!spaced) malformed(`The XMP has a malformed <${name}> tag.`);
      const attribute = this.name();
      this.skipSpace();
      if (this.text[this.at] !== "=") malformed(`The XMP has a malformed <${name}> tag.`);
      this.at += 1;
      this.skipSpace();
      const quote = this.text[this.at];
      if (quote !== '"' && quote !== "'") {
        malformed(`The XMP has an unquoted attribute value in <${name}>.`);
      }
      const close = this.endOf(quote, this.at + 1) - 1;
      const value = this.text.slice(this.at + 1, close);
      if (value.includes("<")) malformed(`The XMP has a < in an attribute value of <${name}>.`);
      if (rawAttributes.has(attribute)) {
        malformed(`The XMP repeats the attribute ${attribute} in <${name}>.`);
      }
      rawAttributes.set(attribute, decodeReferences(value.replace(/[\t\n\r]/gu, " ")));
      this.at = close + 1;
    }

    const scope = this.shadowed.length;
    for (const [attribute, value] of rawAttributes) {
      const [prefix, localName] = splitName(attribute);
      if (prefix === "" && localName === "xmlns") this.bind("", value);
      if (prefix !== "xmlns") continue;
      if (value === "") malformed(`The XMP undeclares the namespace prefix ${localName}.`);
      this.bind(localName, value);
    }
    const attributes: Attribute[] = [];
    const expandedNames = new Set<string>();
    for (const [attribute, value] of rawAttributes) {
      const [prefix, localName] = splitName(attribute);
      if (prefix === "xmlns" || attribute === "xmlns") continue;
      const namespace = prefix === "" ? undefined : this.namespaceOf(prefix);
      const expandedName = `${namespace?.id ?? -1} ${localName}`;
      if (expandedNames.has(expandedName)) {
        malformed(`The XMP repeats the attribute ${attribute} under another prefix in <${name}>.`);
      }
      expandedNames.add(expandedName);
      attributes.push({ namespace: namespace?.uri ?? "", localName, value });
    }
    const [prefix, localName] = splitName(name);
    const namespace = this.namespaceOf(prefix)?.uri ?? "";

    if (this.open.length >= MAX_XMP_ELEMENT_DEPTH) {
      beyondLimit(
        `The XMP nests elements more than ${MAX_XMP_ELEMENT_DEPTH} levels deep, the most this reader accepts.`,
      );
    }
    const parent = this.open.at(-1);
    if (parent === undefined) {
      if (this.hasRoot) malformed("The XMP has more than one root element.");
      this.hasRoot = true;
    }
    const element = {
      name,
      role: this.enter(parent?.role, namespace, localName, attributes),
      scope,
    };
    if (empty) this.exit(element);
    else this.open.push(element);
  }

  private endTag(): void {
    const name = this.name();
    this.skipSpace();
    if (this.text[this.at] !== ">") malformed(`The XMP has a malformed </${name}> tag.`);
    this.at += 1;
    const element = this.open.pop();
    if (element?.name !== name) {
      malformed(
        element === undefined
          ? `The XMP closes </${name}> that it never opened.`
          : `The XMP closes </${name}> where it expects </${element.name}>.`,
      );
    }
    this.exit(element);
  }

  private bind(prefix: string, uri: string): void {
    if (prefix === "xmlns" || uri === XMLNS || (prefix === "xml") !== (uri === XML)) {
      malformed("The XMP binds the reserved xml or xmlns prefix or namespace.");
    }
    let id = this.namespaceIds.get(uri);
    if (id === undefined) {
      id = this.namespaceIds.size;
      this.namespaceIds.set(uri, id);
    }
    this.shadowed.push([prefix, this.namespaces.get(prefix)]);
    this.namespaces.set(prefix, { uri, id });
  }

  /** The namespace bound to `prefix`; the empty prefix is the default namespace, if any. */
  private namespaceOf(prefix: string): Namespace | undefined {
    const namespace = this.namespaces.get(prefix);
    if (namespace === undefined && prefix !== "") {
      malformed(`The XMP uses the undeclared namespace prefix ${prefix}.`);
    }
    return namespace;
  }

  /** The role of an element opened inside `parent`, starting the state its role collects. */
  private enter(
    parent: Role | undefined,
    namespace: string,
    localName: string,
    attributes: readonly Attribute[],
  ): Role {
    const isRdf = (name: string): boolean => namespace === RDF && localName === name;
    const rdfAttribute = (name: string): string | undefined =>
      attributes.find((attribute) => attribute.namespace === RDF && attribute.localName === name)
        ?.value;
    switch (parent) {
      case undefined:
        if (isRdf("RDF")) return "rdf";
        return namespace === ADOBE_META && (localName === "xmpmeta" || localName === "xapmeta")
          ? "meta"
          : "other";
      case "meta":
        return isRdf("RDF") ? "rdf" : "other";
      case "rdf": {
        if (!isRdf("Description")) return "other";
        if (
          attributes.some((attribute) =>
            isExtendedXmpNote(attribute.namespace, attribute.localName),
          )
        ) {
          this.hasExtendedXmp = true;
        }
        return "description";
      }
      case "description":
        if (namespace === DUBLIN_CORE && localName === "subject") return "subject";
        if (isExtendedXmpNote(namespace, localName)) this.hasExtendedXmp = true;
        return "other";
      case "subject":
        if (!isRdf("Bag") && !isRdf("Seq")) return "other";
        this.keywords ??= [];
        return "array";
      case "array":
        if (!isRdf("li")) return "other";
        this.item = {
          text: [],
          hasElements: false,
          resource: rdfAttribute("parseType") === "Resource",
          value: rdfAttribute("value") ?? null,
        };
        return "item";
      case "item":
        if (this.item === null) return "other";
        this.item.hasElements = true;
        if (isRdf("Description") && !this.item.resource) {
          this.item.value ??= rdfAttribute("value") ?? null;
          return "itemDescription";
        }
        return isRdf("value") && this.item.resource ? this.startValue() : "other";
      case "itemDescription":
        return isRdf("value") ? this.startValue() : "other";
      case "value":
        this.valueText = null; // A value with elements is not text.
        return "other";
      default:
        return "other";
    }
  }

  private startValue(): Role {
    this.valueText = [];
    return "value";
  }

  /** Completes what the element's role collected and ends its namespace declarations. */
  private exit(element: OpenElement): void {
    if (element.role === "item") {
      const item = this.item;
      this.item = null;
      if (item !== null) {
        const keyword =
          item.value ?? (item.hasElements || item.resource ? null : item.text.join(""));
        if (keyword !== null && this.keywords !== null) {
          if (this.keywords.length >= MAX_XMP_KEYWORDS) {
            beyondLimit(
              `The XMP has more than ${MAX_XMP_KEYWORDS} keywords, the most this reader accepts.`,
            );
          }
          this.keywords.push(keyword);
        }
      }
    } else if (element.role === "value") {
      if (this.item !== null && this.valueText !== null) {
        this.item.value ??= this.valueText.join("");
      }
      this.valueText = null;
    }
    for (const [prefix, namespace] of this.shadowed.splice(element.scope).reverse()) {
      if (namespace === undefined) this.namespaces.delete(prefix);
      else this.namespaces.set(prefix, namespace);
    }
  }
}

function isExtendedXmpNote(namespace: string, localName: string): boolean {
  return namespace === XMP_NOTE && localName === "HasExtendedXMP";
}

// Character tests use loops rather than regular expressions with repetition, which can exhaust V8's regular expression
// stack on runs of millions of characters.

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isBlank(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (!isSpace(text.charCodeAt(index))) return false;
  }
  return true;
}

/** Whether `code` may start an XML name, other than `:`; this also starts a namespace `NCName`. */
function isNameStart(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    code === 0x5f ||
    (code >= 0xc0 && code <= 0xd6) ||
    (code >= 0xd8 && code <= 0xf6) ||
    (code >= 0xf8 && code <= 0x2ff) ||
    (code >= 0x370 && code <= 0x37d) ||
    (code >= 0x37f && code <= 0x1fff) ||
    code === 0x200c ||
    code === 0x200d ||
    (code >= 0x2070 && code <= 0x218f) ||
    (code >= 0x2c00 && code <= 0x2fef) ||
    (code >= 0x3001 && code <= 0xd7ff) ||
    (code >= 0xf900 && code <= 0xfdcf) ||
    (code >= 0xfdf0 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0xeffff)
  );
}

/** Whether `code` may follow the first character of an XML name, other than `:`. */
function isNamePart(code: number): boolean {
  return (
    isNameStart(code) ||
    code === 0x2d ||
    code === 0x2e ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0xb7 ||
    (code >= 0x300 && code <= 0x36f) ||
    code === 0x203f ||
    code === 0x2040
  );
}

/** Whether `text` is one or more digits in base 10 or 16. */
function isNumeral(text: string, radix: 10 | 16): boolean {
  if (text === "") return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const isDigit =
      (code >= 0x30 && code <= 0x39) ||
      (radix === 16 && ((code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66)));
    if (!isDigit) return false;
  }
  return true;
}

/**
 * Whether the content of `<?xml …?>` is an XML 1.0 declaration: `version`, then optionally `encoding` and then
 * `standalone`, each after whitespace, with optional whitespace at the end.
 */
function isXmlDeclaration(content: string): boolean {
  const names = ["version", "encoding", "standalone"];
  let next = 0; // The index in `names` of the first name that may follow.
  let at = 0;
  const skipSpace = (): boolean => {
    const start = at;
    while (isSpace(content.charCodeAt(at))) at += 1;
    return at > start;
  };
  for (;;) {
    const spaced = skipSpace();
    if (at === content.length) return next > 0;
    const name = names.slice(next).find((candidate) => content.startsWith(candidate, at));
    if (!spaced || name === undefined || (next === 0 && name !== "version")) return false;
    at += name.length;
    skipSpace();
    if (content[at] !== "=") return false;
    at += 1;
    skipSpace();
    const quote = content[at];
    const close = quote === '"' || quote === "'" ? content.indexOf(quote, at + 1) : -1;
    if (close < 0 || !isDeclarationValue(name, content.slice(at + 1, close))) return false;
    at = close + 1;
    next = names.indexOf(name) + 1;
  }
}

function isDeclarationValue(name: string, value: string): boolean {
  if (name === "version") return value.startsWith("1.") && isNumeral(value.slice(2), 10);
  if (name === "standalone") return value === "yes" || value === "no";
  // An encoding name: a Latin letter, then Latin letters, digits, `.`, `_`, or `-`.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isLetter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    const isOther = "0123456789._-".includes(value[index] ?? "");
    if (!isLetter && (index === 0 || !isOther)) return false;
  }
  return value !== "";
}

/** The prefix (empty when there is none) and local part of a namespace-qualified name. */
function splitName(name: string): [prefix: string, localName: string] {
  const colon = name.indexOf(":");
  if (colon < 0) return ["", name];
  const localName = name.slice(colon + 1);
  if (colon === 0 || localName.includes(":") || !isNameStart(localName.codePointAt(0) ?? -1)) {
    malformed(`The XMP has a malformed name ${name}.`);
  }
  return [name.slice(0, colon), localName];
}

/** Replaces entity and character references. */
function decodeReferences(raw: string): string {
  let ampersand = raw.indexOf("&");
  if (ampersand < 0) return raw;
  let decoded = "";
  let from = 0;
  while (ampersand >= 0) {
    const semicolon = raw.indexOf(";", ampersand + 1);
    const reference = semicolon < 0 ? "" : raw.slice(ampersand + 1, semicolon);
    decoded += raw.slice(from, ampersand) + referencedText(reference);
    from = semicolon + 1;
    ampersand = raw.indexOf("&", from);
  }
  return decoded + raw.slice(from);
}

function referencedText(reference: string): string {
  const entity = PREDEFINED_ENTITIES.get(reference);
  if (entity !== undefined) return entity;
  const hexadecimal = reference.startsWith("#x");
  const digits = reference.slice(hexadecimal ? 2 : 1);
  const radix = hexadecimal ? 16 : 10;
  const code =
    reference.startsWith("#") && isNumeral(digits, radix) ? parseInt(digits, radix) : NaN;
  const isXmlCharacter =
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff);
  if (!isXmlCharacter) {
    malformed("The XMP has an unknown entity or an invalid character reference.");
  }
  return String.fromCodePoint(code);
}
