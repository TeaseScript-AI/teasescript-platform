import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  readImageXmpKeywords,
  readXmpPacketKeywords,
  type XmpKeywordsResult,
} from "../src/index.js";
import {
  MAX_XMP_ELEMENT_DEPTH,
  MAX_XMP_KEYWORDS,
  MAX_XMP_PACKET_BYTES,
} from "../src/xmp-keywords.js";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const DC = "http://purl.org/dc/elements/1.1/";

/** The keywords that ExifTool reports for every keyword fixture (see `tests/fixtures/xmp/README.md`). */
const FIXTURE_KEYWORDS = {
  kind: "keywords",
  keywords: ["bedroom", "Tom & Jerry <3", "Café", "punishment: 4"],
};

function fixture(name: string): Buffer {
  return readFileSync(resolve(process.cwd(), "tests/fixtures/xmp", name));
}

/** A copy of a fixture with `bytes` written at the position `find` returns. */
function patched(name: string, find: (file: Buffer) => number, bytes: readonly number[]): Buffer {
  const file = Buffer.from(fixture(name));
  const at = find(file);
  assert.ok(at >= 0, name);
  file.set(bytes, at);
  return file;
}

/** A packet with `x:xmpmeta`, `rdf:RDF`, and the `dc` and `ex` prefixes around `descriptions`. */
function packet(descriptions: string): Buffer {
  return Buffer.from(
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="${RDF}" xmlns:dc="${DC}" xmlns:ex="http://example.com/ns/">
${descriptions}
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`,
  );
}

function assertFailure(
  result: XmpKeywordsResult,
  kind: "unsupported" | "invalid",
  reason: RegExp,
  label: string,
): void {
  assert.equal(result.kind, kind, label);
  assert.match("reason" in result ? result.reason : "", reason, label);
}

/** A JPEG of the given segments, ending at the end-of-image marker. */
function jpeg(...segments: readonly Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, Buffer.from([0xff, 0xd9])]);
}

function app1Segment(...parts: readonly (string | Buffer)[]): Buffer {
  const payload = Buffer.concat(
    parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part)),
  );
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/** The standard XMP segment of a JPEG whose other properties ExifTool 13.25 moved to Extended XMP, without padding. */
function standardXmpSegment(guid: string, dublinCore: string): Buffer {
  return app1Segment(
    "http://ns.adobe.com/xap/1.0/\0",
    `<?xpacket begin='\uFEFF' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/' x:xmptk='Image::ExifTool 13.25'>
<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>

 <rdf:Description rdf:about=''
  xmlns:xmpNote='http://ns.adobe.com/xmp/note/'>
  <xmpNote:HasExtendedXMP>${guid}</xmpNote:HasExtendedXMP>
 </rdf:Description>

 <rdf:Description rdf:about=''
  xmlns:dc='http://purl.org/dc/elements/1.1/'>
${dublinCore}
 </rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>`,
  );
}

/** The first Extended XMP segment of a JPEG: GUID, full length, offset 0, and the start of the extended packet. */
function extendedXmpSegment(guid: string): Buffer {
  const lengthAndOffset = Buffer.alloc(8);
  lengthAndOffset.writeUInt32BE(191_209, 0);
  return app1Segment(
    "http://ns.adobe.com/xmp/extension/\0",
    guid,
    lengthAndOffset,
    "<?xpacket begin='",
  );
}

test("reads the dc:subject keywords that ExifTool and Exiv2 wrote into each image format and a sidecar", () => {
  // keywords.jpg, exiv2-keywords.jpg, and keywords.jpg.xmp also hold `Rooms|bedroom` in lr:hierarchicalSubject.
  for (const name of [
    "keywords.jpg",
    "exiv2-keywords.jpg",
    "keywords.png",
    "keywords.webp",
    "keywords.gif",
    "keywords-little-endian.tif",
    "keywords-big-endian.tif",
  ]) {
    assert.deepEqual(readImageXmpKeywords(fixture(name)), FIXTURE_KEYWORDS, name);
  }
  assert.deepEqual(readXmpPacketKeywords(fixture("keywords.jpg.xmp")), FIXTURE_KEYWORDS);
});

test("reports none for images without XMP and for a packet without dc:subject", () => {
  for (const name of ["no-xmp.jpg", "no-xmp.png", "no-xmp.webp", "no-xmp.gif", "no-xmp.tif"]) {
    assert.deepEqual(readImageXmpKeywords(fixture(name)), { kind: "none" }, name);
  }
  const titleOnly = packet(
    `<rdf:Description><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Room</rdf:li></rdf:Alt></dc:title></rdf:Description>`,
  );
  assert.deepEqual(readXmpPacketKeywords(titleOnly), { kind: "none" });
});

test("matches dc:subject and RDF by namespace, whatever the prefixes and their scope", () => {
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <RDF xmlns="${RDF}" xmlns:dc="${DC}">
  <Description xmlns:k="${DC}">
   <k:subject><Bag><li>other prefix</li></Bag></k:subject>
  </Description>
  <Description xmlns:dc="http://example.com/not-dublin-core/">
   <dc:subject><Bag><li>other namespace</li></Bag></dc:subject>
  </Description>
  <Description>
   <dc:subject><Bag><li>outer binding restored</li></Bag></dc:subject>
  </Description>
  <Description xmlns:dc="http://example.com/not-dublin-core/">
   <dc:subject xmlns:dc="${DC}"><Bag><li>prefix rebound on the property</li></Bag></dc:subject>
  </Description>
  <r:Description xmlns:r="${RDF}" xmlns="${DC}">
   <subject><r:Seq><r:li>default namespace</r:li></r:Seq></subject>
  </r:Description>
 </RDF>
</x:xmpmeta>`;
  assert.deepEqual(readXmpPacketKeywords(Buffer.from(xmp)), {
    kind: "keywords",
    keywords: [
      "other prefix",
      "outer binding restored",
      "prefix rebound on the property",
      "default namespace",
    ],
  });
});

test("decodes references and CDATA as keyword text, without comments or processing instructions", () => {
  const xmp = packet(`<rdf:Description><dc:subject><rdf:Bag>
 <rdf:li>a &#38; b &#x263A; &quot;&apos;&gt;</rdf:li>
 <rdf:li><![CDATA[<raw> & text]]></rdf:li>
 <rdf:li>tw<!-- comment -->o<?pi data?></rdf:li>
 <rdf:li xml:lang="en">  spaced  </rdf:li>
</rdf:Bag></dc:subject></rdf:Description>`);
  assert.deepEqual(readXmpPacketKeywords(xmp), {
    kind: "keywords",
    keywords: [`a & b ☺ "'>`, "<raw> & text", "two", "  spaced  "],
  });
});

test("reads dc:subject Bag and Seq arrays of every top-level description and nothing else", () => {
  const xmp = packet(`
<rdf:Description dc:subject="attribute shorthand">
 <dc:subject><rdf:Bag><rdf:li>bag</rdf:li></rdf:Bag></dc:subject>
 <lr:hierarchicalSubject xmlns:lr="http://ns.adobe.com/lightroom/1.0/">
  <rdf:Bag><rdf:li>Rooms|bedroom</rdf:li></rdf:Bag>
 </lr:hierarchicalSubject>
 <digiKam:TagsList xmlns:digiKam="http://www.digikam.org/ns/1.0/">
  <rdf:Seq><rdf:li>Rooms/bedroom</rdf:li></rdf:Seq>
 </digiKam:TagsList>
 <ex:subject><rdf:Bag><rdf:li>other namespace</rdf:li></rdf:Bag></ex:subject>
 <ex:holder rdf:parseType="Resource">
  <dc:subject><rdf:Bag><rdf:li>nested description</rdf:li></rdf:Bag></dc:subject>
 </ex:holder>
</rdf:Description>
<rdf:Description>
 <dc:subject><rdf:Seq><rdf:li>sequence</rdf:li></rdf:Seq></dc:subject>
</rdf:Description>`);
  assert.deepEqual(readXmpPacketKeywords(xmp), { kind: "keywords", keywords: ["bag", "sequence"] });

  const alternatives = packet(
    `<rdf:Description><dc:subject><rdf:Alt><rdf:li xml:lang="x-default">alternative</rdf:li></rdf:Alt></dc:subject></rdf:Description>`,
  );
  assert.deepEqual(readXmpPacketKeywords(alternatives), { kind: "none" });
  const emptyBag = packet(`<rdf:Description><dc:subject><rdf:Bag/></dc:subject></rdf:Description>`);
  assert.deepEqual(readXmpPacketKeywords(emptyBag), { kind: "keywords", keywords: [] });
});

test("reads the rdf:value of qualified keywords, not their qualifiers", () => {
  const xmp = packet(`<rdf:Description><dc:subject><rdf:Bag>
 <rdf:li rdf:parseType="Resource"><ex:source>first qualifier</ex:source><rdf:value>resource</rdf:value></rdf:li>
 <rdf:li><rdf:Description><rdf:value>description</rdf:value><ex:source>second qualifier</ex:source></rdf:Description></rdf:li>
 <rdf:li rdf:value="attribute" ex:source="third qualifier"/>
 <rdf:li><rdf:Description><ex:source>no value</ex:source></rdf:Description></rdf:li>
 <rdf:li>plain</rdf:li>
</rdf:Bag></dc:subject></rdf:Description>`);
  assert.deepEqual(readXmpPacketKeywords(xmp), {
    kind: "keywords",
    keywords: ["resource", "description", "attribute", "plain"],
  });
});

test("decodes UTF-8 and UTF-16 packets by their byte order mark and rejects UTF-32", () => {
  const sidecar = fixture("keywords.jpg.xmp");
  const utf16le = Buffer.from(`\uFEFF${sidecar.toString("utf8")}`, "utf16le");
  const encodings: [string, Buffer][] = [
    ["UTF-8 with a byte order mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), sidecar])],
    [
      "UTF-8 with an XML declaration",
      Buffer.concat([
        Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`),
        sidecar,
      ]),
    ],
    ["UTF-16LE", utf16le],
    ["UTF-16BE", Buffer.from(utf16le).swap16()],
  ];
  for (const [label, bytes] of encodings) {
    assert.deepEqual(readXmpPacketKeywords(bytes), FIXTURE_KEYWORDS, label);
  }

  const text = `\uFEFF${sidecar.toString("utf8")}`;
  const utf32be = Buffer.alloc(4 * text.length);
  for (let index = 0; index < text.length; index += 1) {
    utf32be.writeUInt32BE(text.charCodeAt(index), 4 * index);
  }
  const utf32le = Buffer.from(utf32be).swap32();
  for (const [label, bytes] of [
    ["UTF-32BE", utf32be],
    ["UTF-32LE", utf32le],
  ] as const) {
    assertFailure(readXmpPacketKeywords(bytes), "unsupported", /UTF-32/, label);
  }
  const notUtf8 = Buffer.concat([
    sidecar.subarray(0, 300),
    Buffer.from([0xff]),
    sidecar.subarray(300),
  ]);
  assertFailure(readXmpPacketKeywords(notUtf8), "invalid", /UTF-8/, "invalid UTF-8");
});

test("reports a JPEG whose standard XMP leaves dc:subject to Extended XMP as unsupported", () => {
  const title = `  <dc:title><rdf:Alt><rdf:li xml:lang='x-default'>Room</rdf:li></rdf:Alt></dc:title>`;
  const withoutSubject = "61589518805B37704D8317411B4037AC";
  const extended = jpeg(
    standardXmpSegment(withoutSubject, title),
    extendedXmpSegment(withoutSubject),
  );
  assertFailure(
    readImageXmpKeywords(extended),
    "unsupported",
    /Extended XMP.*sidecar/,
    "subject in Extended XMP",
  );
  // Without its Extended XMP segments the file may have lost the keywords; it still holds no readable ones.
  assertFailure(
    readImageXmpKeywords(jpeg(standardXmpSegment(withoutSubject, title))),
    "unsupported",
    /Extended XMP/,
    "missing Extended XMP",
  );

  const subject = `  <dc:subject><rdf:Bag><rdf:li>bedroom</rdf:li></rdf:Bag></dc:subject>`;
  const withSubject = "67928C1750FEC1660268C408B2468C58";
  assert.deepEqual(
    readImageXmpKeywords(
      jpeg(standardXmpSegment(withSubject, subject), extendedXmpSegment(withSubject)),
    ),
    { kind: "keywords", keywords: ["bedroom"] },
  );
});

test("reports compressed PNG XMP, BigTIFF, and other formats as unsupported", () => {
  assertFailure(
    readImageXmpKeywords(fixture("compressed-xmp.png")),
    "unsupported",
    /compressed.*sidecar/,
    "PNG",
  );
  const bigTiff = Buffer.from([
    0x49, 0x49, 0x2b, 0x00, 0x08, 0x00, 0x00, 0x00, 0x10, 0, 0, 0, 0, 0, 0, 0,
  ]);
  assertFailure(readImageXmpKeywords(bigTiff), "unsupported", /BigTIFF.*sidecar/, "BigTIFF");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"/>`);
  assertFailure(readImageXmpKeywords(svg), "unsupported", /sidecar/, "SVG");
});

test("reports truncated and malformed image containers as invalid", () => {
  const truncated = (name: string): Buffer => {
    const file = fixture(name);
    return file.subarray(0, file.indexOf("<rdf:Bag>"));
  };
  const xpacketEnd = (file: Buffer): number =>
    file.indexOf("?>", file.indexOf("<?xpacket end")) + 2;
  const gif = fixture("keywords.gif");
  const tiffXmpEntry = (file: Buffer): number =>
    file.indexOf(Buffer.from([0xbc, 0x02, 0x01, 0x00])); // Tag 700, type BYTE, little-endian.
  const tiffDirectory = fixture("keywords-little-endian.tif").readUInt32LE(4);
  const huge = [0xff, 0xff, 0xff, 0xff];
  const webp = fixture("keywords.webp"); // Its last chunk is XMP of odd size, followed by a pad byte.
  const unpaddedWebp = Buffer.from(webp.subarray(0, webp.length - 1));
  unpaddedWebp.writeUInt32LE(webp.readUInt32LE(4) - 1, 4);
  const cases: [string, Buffer, RegExp][] = [
    ["truncated JPEG", truncated("keywords.jpg"), /JPEG/],
    ["truncated PNG", truncated("keywords.png"), /PNG/],
    ["truncated WebP", truncated("keywords.webp"), /WebP/],
    ["truncated GIF", truncated("keywords.gif"), /GIF/],
    ["truncated TIFF", truncated("keywords-little-endian.tif"), /TIFF/],
    [
      "JPEG with data where the marker after its first segment belongs",
      patched("keywords.jpg", (file) => 4 + file.readUInt16BE(4), [0x00]),
      /JPEG/,
    ],
    [
      "PNG XMP with an unknown compression flag",
      patched("keywords.png", (file) => file.indexOf("XML:com.adobe.xmp\0") + 18, [2]),
      /PNG/,
    ],
    [
      "WebP XMP chunk longer than the file",
      patched("keywords.webp", (file) => file.indexOf("XMP ") + 4, [0xff, 0xff, 0xff, 0x7f]),
      /WebP/,
    ],
    [
      "GIF XMP with a damaged trailer",
      patched("keywords.gif", (file) => xpacketEnd(file) + 10, [0]),
      /GIF/,
    ],
    [
      "TIFF directory past the end",
      patched("keywords-little-endian.tif", () => 4, [0xff, 0xff]),
      /TIFF/,
    ],
    ["WebP odd chunk without its pad byte", unpaddedWebp, /WebP/],
    ["GIF XMP without its trailer", gif.subarray(0, xpacketEnd(gif)), /GIF/],
    [
      "PNG chunk declaring 4 GiB",
      patched("keywords.png", (file) => file.indexOf("iTXt") - 4, huge),
      /PNG/,
    ],
    ["WebP declaring 4 GiB", patched("keywords.webp", () => 4, huge), /WebP/],
    [
      "TIFF directory inside the header",
      patched("keywords-little-endian.tif", () => 4, [0, 0, 0, 0]),
      /TIFF/,
    ],
    [
      "TIFF XMP tag declaring 4 GiB",
      patched("keywords-little-endian.tif", (file) => tiffXmpEntry(file) + 4, huge),
      /TIFF/,
    ],
    [
      "TIFF XMP tag pointing at its own directory",
      patched("keywords-little-endian.tif", (file) => tiffXmpEntry(file) + 8, [
        tiffDirectory & 0xff,
        tiffDirectory >> 8,
        0,
        0,
      ]),
      /XMP/,
    ],
    [
      "TIFF XMP tag of type SHORT",
      patched("keywords-little-endian.tif", (file) => tiffXmpEntry(file) + 2, [3]),
      /TIFF/,
    ],
  ];
  for (const [label, bytes, reason] of cases) {
    assertFailure(readImageXmpKeywords(bytes), "invalid", reason, label);
  }
});

test("reads only the first TIFF directory, so a directory chain that loops back still ends", () => {
  const tiff = Buffer.from(fixture("keywords-little-endian.tif"));
  const directory = tiff.readUInt32LE(4);
  tiff.writeUInt32LE(directory, directory + 2 + 12 * tiff.readUInt16LE(directory));
  assert.deepEqual(readImageXmpKeywords(tiff), FIXTURE_KEYWORDS);
});

test("reports XMP that is not well-formed XML, or has a DOCTYPE, as invalid", () => {
  const subject = (items: string): string =>
    `<rdf:Description><dc:subject><rdf:Bag>${items}</rdf:Bag></dc:subject></rdf:Description>`;
  const valid = packet(subject("<rdf:li>bedroom</rdf:li>")).toString();
  const cases: [string, string, RegExp][] = [
    [
      "a DOCTYPE that defines an entity",
      `<!DOCTYPE x:xmpmeta [<!ENTITY room "bedroom">]>${packet(subject("<rdf:li>&room;</rdf:li>")).toString()}`,
      /DOCTYPE/,
    ],
    [
      "an entity declaration without a DOCTYPE",
      packet(subject(`<!ENTITY room "bedroom"><rdf:li>&room;</rdf:li>`)).toString(),
      /markup declaration/,
    ],
    ["a mismatched end tag", packet(subject("<rdf:li>bedroom</rdf:Bag>")).toString(), /closes/],
    ["an unclosed element", valid.replace("</x:xmpmeta>", ""), /never closes/],
    [
      "a prefix used after the element that declares it closes",
      packet(
        `<rdf:Description xmlns:lr="http://ns.adobe.com/lightroom/1.0/"/><rdf:Description><lr:hierarchicalSubject/></rdf:Description>`,
      ).toString(),
      /undeclared/,
    ],
    ["an unknown entity", packet(subject("<rdf:li>&room;</rdf:li>")).toString(), /entity/],
    [
      "a reference to a character XML does not allow",
      packet(subject("<rdf:li>&#0;</rdf:li>")).toString(),
      /reference/,
    ],
    ["a control character", packet(subject("<rdf:li>\u0001</rdf:li>")).toString(), /character/],
    ["text outside the root element", `${valid}bedroom`, /outside/],
    [
      "a second root element",
      `${valid}<x:xmpmeta xmlns:x="adobe:ns:meta/"/>`,
      /more than one root/,
    ],
    [
      "a repeated attribute",
      packet(subject(`<rdf:li xml:lang="en" xml:lang="de">bedroom</rdf:li>`)).toString(),
      /repeats/,
    ],
    [
      "an unquoted attribute value",
      packet(subject(`<rdf:li xml:lang=en>bedroom</rdf:li>`)).toString(),
      /unquoted/,
    ],
    [
      "an unterminated comment",
      valid.replace("<rdf:li>", "<!-- <rdf:li>"),
      /missing a closing -->/,
    ],
    [
      "an unterminated CDATA section",
      valid.replace("bedroom", "<![CDATA[bedroom"),
      /missing a closing \]\]>/,
    ],
    ["an unterminated tag", valid.slice(0, valid.indexOf("<rdf:li>") + 6), /malformed/],
    [
      "an unterminated attribute value",
      valid.slice(0, valid.indexOf('xmlns:x="adobe') + 14),
      /missing a closing "/,
    ],
    ["no root element", `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>`, /no root/],
    [
      "an XML declaration with unknown content",
      `<?xml version="1.0" encoding="UTF-8" garbage?>${valid}`,
      /XML declaration/,
    ],
    [
      "a processing instruction target with a colon",
      valid.replace("<rdf:li>", "<?bad:pi data?><rdf:li>"),
      /processing instruction/,
    ],
    ["-- inside a comment", valid.replace("<rdf:li>", "<!-- a -- b --><rdf:li>"), /-- inside/],
    [
      "a processing instruction target run into its data",
      valid.replace("<rdf:li>", "<?pi=data?><rdf:li>"),
      /processing instruction/,
    ],
    [
      "an XML declaration after the start",
      valid.replace("<rdf:li>", '<?xml version="1.0"?><rdf:li>'),
      /XML declaration/,
    ],
    [
      "]]> outside a CDATA section",
      packet(subject("<rdf:li>room]]></rdf:li>")).toString(),
      /CDATA/,
    ],
    [
      "the xml prefix bound to another namespace",
      packet(`<rdf:Description xmlns:xml="${DC}"><xml:subject/></rdf:Description>`).toString(),
      /reserved/,
    ],
    [
      "one attribute under two prefixes",
      packet(subject(`<rdf:li rdf:value="first" r:value="second" xmlns:r="${RDF}"/>`)).toString(),
      /repeats/,
    ],
    [
      "a local name starting with a digit",
      packet(subject("<rdf:li>bedroom</rdf:li><ex:1st/>")).toString(),
      /malformed name/,
    ],
  ];
  for (const [label, xmp, reason] of cases) {
    assertFailure(readXmpPacketKeywords(Buffer.from(xmp)), "invalid", reason, label);
  }
});

test("reads XMP up to the reader's size, nesting, and keyword limits and reports XMP beyond them as unsupported", () => {
  const sidecar = fixture("keywords.jpg.xmp");
  const padded = (bytes: number): Buffer =>
    Buffer.concat([sidecar, Buffer.alloc(bytes - sidecar.length, " ")]); // Whitespace may follow the root.
  assert.deepEqual(readXmpPacketKeywords(padded(MAX_XMP_PACKET_BYTES)), FIXTURE_KEYWORDS);
  assertFailure(
    readXmpPacketKeywords(padded(MAX_XMP_PACKET_BYTES + 1)),
    "unsupported",
    /larger than/,
    "size",
  );

  // x:xmpmeta, rdf:RDF, rdf:Description, and ex:holder are the first four levels.
  const nested = (depth: number): Buffer =>
    packet(
      `<rdf:Description><dc:subject><rdf:Bag><rdf:li>deep</rdf:li></rdf:Bag></dc:subject><ex:holder>${"<ex:level>".repeat(depth - 4)}${"</ex:level>".repeat(depth - 4)}</ex:holder></rdf:Description>`,
    );
  assert.deepEqual(readXmpPacketKeywords(nested(MAX_XMP_ELEMENT_DEPTH)), {
    kind: "keywords",
    keywords: ["deep"],
  });
  assertFailure(
    readXmpPacketKeywords(nested(MAX_XMP_ELEMENT_DEPTH + 1)),
    "unsupported",
    /levels deep/,
    "depth",
  );

  const subject = (count: number): Buffer =>
    packet(
      `<rdf:Description><dc:subject><rdf:Bag>${"<rdf:li>keyword</rdf:li>".repeat(count)}</rdf:Bag></dc:subject></rdf:Description>`,
    );
  const atLimit = readXmpPacketKeywords(subject(MAX_XMP_KEYWORDS));
  assert.equal(
    atLimit.kind === "keywords" ? atLimit.keywords.length : atLimit.kind,
    MAX_XMP_KEYWORDS,
  );
  assertFailure(
    readXmpPacketKeywords(subject(MAX_XMP_KEYWORDS + 1)),
    "unsupported",
    /keywords/,
    "keywords",
  );
});

test("reads names and character references of millions of characters in non-ASCII text", () => {
  // Regular expressions with repetition exhausted V8's stack on such runs in two-byte strings, from about 10 million.
  const run = "0".repeat(12_000_000);
  const keywords = (items: string, other = ""): Buffer =>
    packet(
      `<rdf:Description><dc:subject><rdf:Bag><rdf:li>Café</rdf:li>${items}</rdf:Bag></dc:subject>${other}</rdf:Description>`,
    );
  const longReference = keywords(`<rdf:li>&#${run}65;</rdf:li>`);
  assert.deepEqual(readXmpPacketKeywords(longReference), {
    kind: "keywords",
    keywords: ["Café", "A"],
  });
  const longName = keywords("", `<ex:a${run}/>`);
  assert.deepEqual(readXmpPacketKeywords(longName), { kind: "keywords", keywords: ["Café"] });
});
