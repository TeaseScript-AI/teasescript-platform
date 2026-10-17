// A public key as a lock takes it (V30 §13): an age X25519 recipient, `age1…` in Bech32, or an OpenSSH
// Ed25519 key, `ssh-ed25519 AAAA… comment`. Pure and synchronous, so the compiler checks a written key and the engine a
// key the script computes; the Player reads the same bytes to lock with them.

/**
 * The most public keys a lock holds: their age file is one opener, whose body has at most 65,535 bytes, and each
 * recipient's stanza takes at most 110 of them besides the file's own 147 (docs/ENCRYPTION.md).
 */
export const MAX_LOCK_PUBLIC_KEYS = 594;

/** A public key a lock accepts, with the bytes the age stanza for it needs. */
export type PublicKey =
  | { readonly kind: "x25519"; readonly key: Uint8Array }
  | {
      readonly kind: "ssh-ed25519";
      /** The key's SSH wire encoding, whose SHA-256 tags the stanza. */
      readonly wire: Uint8Array;
      /** The Ed25519 public key. */
      readonly key: Uint8Array;
      /** The key as an X25519 public key, the Montgomery form of its point, which its stanza is made for. */
      readonly montgomery: Uint8Array;
    };

/**
 * Keys read before, by their text, as checking an Ed25519 point takes a while and a waiting lock's keys are checked again
 * with each state: a cache outside any state, emptied when it is full.
 */
const read = new Map<string, PublicKey | null>();
const MAX_READ_KEYS = 4096;

/** The public key `text` holds, or `null` when it is neither an `age1…` recipient nor an `ssh-ed25519` key. */
export function parsePublicKey(text: string): PublicKey | null {
  const known = read.get(text);
  if (known !== undefined) return known;
  if (read.size >= MAX_READ_KEYS) read.clear();
  const key = readPublicKey(text);
  read.set(text, key);
  return key;
}

function readPublicKey(text: string): PublicKey | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("ssh-ed25519 ")) {
    const encoded = trimmed.slice("ssh-ed25519 ".length).trim().split(/\s+/u)[0] ?? "";
    const wire = standardBase64Bytes(encoded);
    if (wire === null || wire.length !== 51) return null;
    // string "ssh-ed25519", then string of the 32-byte key, each with a 4-byte big-endian length.
    const name = [0, 0, 0, 11, ...new TextEncoder().encode("ssh-ed25519"), 0, 0, 0, 32];
    if (name.some((byte, index) => wire[index] !== byte)) return null;
    const key = wire.slice(19);
    const montgomery = montgomeryForm(key);
    return montgomery === null ? null : { kind: "ssh-ed25519", wire, key, montgomery };
  }
  const decoded = bech32(trimmed);
  if (decoded === null || decoded.prefix !== "age" || decoded.data.length !== 32) return null;
  return { kind: "x25519", key: decoded.data };
}

/** The prime of Curve25519's field, 2^255 - 19. */
const P = (1n << 255n) - 19n;
/** Edwards25519's d, -121665/121666. */
const D = mod(-121665n * inverse(121666n));
/** A square root of -1. */
const SQRT_M1 = power(2n, (P - 1n) / 4n);

/**
 * The Montgomery u of an Ed25519 public key, `(1 + y) / (1 - y)` (RFC 7748, section 4.1), as 32 little-endian bytes, or
 * `null` when the bytes are not a point of Edwards25519 (RFC 8032, section 5.1.3), so that no key is taken that nobody
 * holds.
 */
function montgomeryForm(key: Uint8Array): Uint8Array | null {
  let y = 0n;
  for (let index = 31; index >= 0; index -= 1) y = (y << 8n) | BigInt(key[index]!);
  const sign = y >> 255n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return null;
  // x² = (y² - 1) / (d y² + 1) must have a root, and x = 0 has no negative.
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  let x = mod(u * power(v, 3n) * power(u * power(v, 7n), (P - 5n) / 8n));
  if (mod(v * x * x) !== u) {
    if (mod(v * x * x) !== mod(-u)) return null;
    x = mod(x * SQRT_M1);
  }
  if (x === 0n && sign === 1n) return null;
  if (y === 1n) return null;
  let montgomery = mod((1n + y) * inverse(mod(1n - y)));
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number(montgomery & 0xffn);
    montgomery >>= 8n;
  }
  return bytes;
}

function mod(value: bigint): bigint {
  const result = value % P;
  return result < 0n ? result + P : result;
}

function power(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let square = mod(base);
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    if (rest & 1n) result = (result * square) % P;
    square = (square * square) % P;
  }
  return result;
}

function inverse(value: bigint): bigint {
  return power(value, P - 2n);
}

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** Decodes Bech32 (BIP 173, not Bech32m) as age writes its recipients: one case, and 8-bit data. */
function bech32(text: string): { readonly prefix: string; readonly data: Uint8Array } | null {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return null;
  const lower = text.toLowerCase();
  const separator = lower.lastIndexOf("1");
  if (separator < 1 || separator + 7 > lower.length) return null;
  const prefix = lower.slice(0, separator);
  const values: number[] = [];
  for (const character of lower.slice(separator + 1)) {
    const value = BECH32_CHARSET.indexOf(character);
    if (value === -1) return null;
    values.push(value);
  }
  if (polymod([...expandPrefix(prefix), ...values]) !== 1) return null;
  // The 5-bit groups without the six of the checksum, regrouped into bytes without padding left over.
  const data: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const value of values.slice(0, -6)) {
    accumulator = (accumulator << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      data.push((accumulator >> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((accumulator << (8 - bits)) & 0xff) !== 0) return null;
  return { prefix, data: Uint8Array.from(data) };
}

function expandPrefix(prefix: string): number[] {
  const codes = [...prefix].map((character) => character.charCodeAt(0));
  return [...codes.map((code) => code >> 5), 0, ...codes.map((code) => code & 31)];
}

function polymod(values: readonly number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit += 1) if ((top >> bit) & 1) checksum ^= generators[bit]!;
  }
  return checksum;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The bytes of standard Base64 with its padding, as OpenSSH writes keys, or `null` for anything else. */
function standardBase64Bytes(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) return null;
  const bytes: number[] = [];
  for (let at = 0; at < text.length; at += 4) {
    const group = text.slice(at, at + 4);
    const values = [...group].map((character) =>
      character === "=" ? 0 : BASE64_ALPHABET.indexOf(character),
    );
    const joined = (values[0]! << 18) | (values[1]! << 12) | (values[2]! << 6) | values[3]!;
    bytes.push((joined >> 16) & 0xff);
    if (group[2] !== "=") bytes.push((joined >> 8) & 0xff);
    if (group[3] !== "=") bytes.push(joined & 0xff);
  }
  return Uint8Array.from(bytes);
}
