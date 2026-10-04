// Writes a 1×1 8-bit grayscale big-endian (MM) TIFF without metadata: node make-big-endian-tiff.mjs <output>
import { writeFileSync } from "node:fs";

const SHORT = 3;
const LONG = 4;
const PIXEL_OFFSET = 110; // After the 8-byte header and an image directory of 8 entries.
const entries = [
  [256, SHORT, 1], // ImageWidth
  [257, SHORT, 1], // ImageLength
  [258, SHORT, 8], // BitsPerSample
  [259, SHORT, 1], // Compression: none
  [262, SHORT, 1], // PhotometricInterpretation: black is zero
  [273, LONG, PIXEL_OFFSET], // StripOffsets
  [278, SHORT, 1], // RowsPerStrip
  [279, LONG, 1], // StripByteCounts
];
const file = Buffer.alloc(PIXEL_OFFSET + 1);
file.write("MM", 0, "latin1");
file.writeUInt16BE(42, 2);
file.writeUInt32BE(8, 4);
file.writeUInt16BE(entries.length, 8);
entries.forEach(([tag, type, value], index) => {
  const at = 10 + index * 12;
  file.writeUInt16BE(tag, at);
  file.writeUInt16BE(type, at + 2);
  file.writeUInt32BE(1, at + 4);
  if (type === SHORT) file.writeUInt16BE(value, at + 8);
  else file.writeUInt32BE(value, at + 8);
});
file[PIXEL_OFFSET] = 0x80;
writeFileSync(process.argv[2], file);
