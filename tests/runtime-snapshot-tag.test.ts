import assert from "node:assert/strict";
import test from "node:test";

import { sipHash24 } from "../src/runtime/snapshot-tag.js";

/*
 * A tagged snapshot (docs/RUNTIME.md#runtime-sessions) is only as sound as its SipHash-2-4. The expected values come
 * from an independent implementation, OpenSSL 3.5's SIPHASH MAC (`openssl mac -macopt hexkey:<key> -macopt size:8
 * SIPHASH`), read as little-endian 64-bit numbers; those of the key 00 to 0f are the SipHash paper's reference vectors.
 */

/** The little-endian 32-bit words of a key's 16 bytes. */
function keyWords(bytes: readonly number[]): Int32Array {
  const words = new Int32Array(4);
  for (const [index, byte] of bytes.entries()) words[index >> 2]! |= byte << ((index & 3) * 8);
  return words;
}

/** The string whose UTF-16LE bytes are `bytes`, an even number of them. */
function textOf(bytes: readonly number[]): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 2)
    text += String.fromCharCode(bytes[index]! | (bytes[index + 1]! << 8));
  return text;
}

const counting = (length: number): number[] => Array.from({ length }, (_, index) => index);

test("SipHash-2-4 gives the reference vectors for messages that end anywhere in a word", () => {
  const key = keyWords(counting(16));
  const vectors: ReadonlyArray<readonly [number, string]> = [
    [0, "726fdb47dd0e0e31"],
    [2, "0d6c8009d9a94f5a"],
    [4, "cf2794e0277187b7"],
    [6, "cbc9466e58fee3ce"],
    [8, "93f5f5799a932462"],
    [14, "f723ca908e7af2ee"],
    [16, "3f2acc7f57c29bdb"],
    [62, "e51b38608ef25f57"],
  ];
  for (const [length, expected] of vectors)
    assert.equal(sipHash24(key, textOf(counting(length))), expected, `${length} bytes`);
});

test("SipHash-2-4 hashes every UTF-16 code unit, a lone surrogate too, and the byte length past 256", () => {
  const key = keyWords([
    0x8f, 0x1e, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0x87, 0x96, 0xa5, 0xb4, 0xc3, 0xd2, 0xe1, 0xf0,
  ]);
  // 216 code units, 432 bytes: the euro sign, a surrogate pair, a lone high surrogate, and U+FFFF.
  const text = "Tag \u20ac \ud834\udd1e \ud800 \uffff end. ".repeat(12);
  assert.equal(sipHash24(key, text), "105dfd5d49849bf8");
});
