// SHA-256 (FIPS 180-4) for `hashText` (V30 §13), which gives its result at once: the browser's own digest,
// `crypto.subtle.digest`, always waits. It works on 64-byte blocks in fixed arrays, so its time grows only with the
// number of bytes, and it gives the same result in every host.

/** The round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const ROUND_CONSTANTS = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The initial hash: the first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const INITIAL_HASH = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

/** The SHA-256 of bytes given in parts, in order. */
class Sha256 {
  readonly #hash = new Int32Array(INITIAL_HASH);
  readonly #schedule = new Int32Array(64);
  /** Bytes of an unfinished block, until it is full. */
  readonly #block = new Uint8Array(64);
  #buffered = 0;
  #length = 0;
  #finished = false;

  /** Adds `bytes` after the bytes added before. */
  update(bytes: Uint8Array): this {
    if (this.#finished) throw new Error("A finished SHA-256 takes no more bytes.");
    this.#length += bytes.length;
    let offset = 0;
    if (this.#buffered > 0) {
      const taken = Math.min(64 - this.#buffered, bytes.length);
      this.#block.set(bytes.subarray(0, taken), this.#buffered);
      this.#buffered += taken;
      offset = taken;
      if (this.#buffered < 64) return this;
      this.#compress(this.#block, 0);
      this.#buffered = 0;
    }
    for (; offset + 64 <= bytes.length; offset += 64) this.#compress(bytes, offset);
    this.#block.set(bytes.subarray(offset), 0);
    this.#buffered = bytes.length - offset;
    return this;
  }

  /** The hash as 64 lowercase hexadecimal digits. No bytes can be added afterwards. */
  hex(): string {
    if (!this.#finished) {
      // The padding: a one bit, zero bits up to 56 bytes into a block, and the length in bits as 64 bits.
      const bits = this.#length * 8;
      const padding = new Uint8Array((this.#buffered < 56 ? 64 : 128) - this.#buffered);
      padding[0] = 0x80;
      const view = new DataView(padding.buffer);
      view.setUint32(padding.length - 8, Math.floor(bits / 0x1_0000_0000));
      view.setUint32(padding.length - 4, bits >>> 0);
      this.update(padding);
      this.#finished = true;
    }
    let hex = "";
    for (const word of this.#hash) hex += (word >>> 0).toString(16).padStart(8, "0");
    return hex;
  }

  /** Mixes the 64-byte block of `bytes` that starts at `offset` into the hash. */
  #compress(bytes: Uint8Array, offset: number): void {
    const w = this.#schedule;
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      w[index] =
        (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
    }
    for (let index = 16; index < 64; index += 1) {
      const before15 = w[index - 15]!;
      const before2 = w[index - 2]!;
      const sigma0 =
        ((before15 >>> 7) | (before15 << 25)) ^
        ((before15 >>> 18) | (before15 << 14)) ^
        (before15 >>> 3);
      const sigma1 =
        ((before2 >>> 17) | (before2 << 15)) ^
        ((before2 >>> 19) | (before2 << 13)) ^
        (before2 >>> 10);
      w[index] = (sigma1 + w[index - 7]! + sigma0 + w[index - 16]!) | 0;
    }
    const hash = this.#hash;
    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choice = (e & f) ^ (~e & g);
      const first = (h + sum1 + choice + ROUND_CONSTANTS[index]! + w[index]!) | 0;
      const sum0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sum0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) | 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) | 0;
    }
    hash[0] = (hash[0]! + a) | 0;
    hash[1] = (hash[1]! + b) | 0;
    hash[2] = (hash[2]! + c) | 0;
    hash[3] = (hash[3]! + d) | 0;
    hash[4] = (hash[4]! + e) | 0;
    hash[5] = (hash[5]! + f) | 0;
    hash[6] = (hash[6]! + g) | 0;
    hash[7] = (hash[7]! + h) | 0;
  }
}

/** UTF-16 code units encoded at a time, so that a long text never needs all its UTF-8 at once. */
const TEXT_CHUNK = 65_536;
const utf8Encoder = new TextEncoder();

/**
 * The SHA-256 of `text` in UTF-8, as 64 lowercase hexadecimal digits. A lone surrogate counts as U+FFFD, as UTF-8
 * encoding and `toBase64` write it.
 */
export function textSha256(text: string): string {
  const hash = new Sha256();
  // Each UTF-16 code unit takes at most three bytes; a surrogate pair takes four for two.
  const buffer = new Uint8Array(Math.min(text.length, TEXT_CHUNK) * 3);
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + TEXT_CHUNK, text.length);
    // A surrogate pair stays in one part, so that it is encoded as its code point.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    const { written } = utf8Encoder.encodeInto(text.slice(start, end), buffer);
    hash.update(buffer.subarray(0, written));
    start = end;
  }
  return hash.hex();
}

/** Whether `text` is a SHA-256 as `hashText` and `hashFile` give it: 64 lowercase hexadecimal digits. */
export function isSha256Hex(text: unknown): text is string {
  return typeof text === "string" && /^[0-9a-f]{64}$/u.test(text);
}
