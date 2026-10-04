// Copies a PNG and zlib-compresses the text of its XMP iTXt chunk (compression flag 1, method 0):
// node compress-png-xmp.mjs <input> <output>
import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const [input, output] = process.argv.slice(2);
const source = readFileSync(input);
const parts = [source.subarray(0, 8)];
for (let at = 8; at < source.length;) {
  const length = source.readUInt32BE(at);
  const chunk = source.subarray(at, at + 12 + length);
  at += 12 + length;
  const data = chunk.subarray(8, 8 + length);
  const keywordEnd = data.indexOf(0);
  const isXmp =
    chunk.toString("latin1", 4, 8) === "iTXt" &&
    data.toString("latin1", 0, keywordEnd) === "XML:com.adobe.xmp";
  if (!isXmp) {
    parts.push(chunk);
    continue;
  }
  // Keyword, NUL, compression flag, compression method, language tag, NUL, translated keyword, NUL, text.
  const textStart = data.indexOf(0, data.indexOf(0, keywordEnd + 3) + 1) + 1;
  const fields = Buffer.from(data.subarray(0, textStart));
  fields[keywordEnd + 1] = 1;
  const body = Buffer.concat([
    Buffer.from("iTXt", "latin1"),
    fields,
    deflateSync(data.subarray(textStart)),
  ]);
  const length32 = Buffer.alloc(4);
  length32.writeUInt32BE(body.length - 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  parts.push(length32, body, crc);
}
writeFileSync(output, Buffer.concat(parts));
