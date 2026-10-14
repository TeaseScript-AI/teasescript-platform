// A keyholder's public key as a lock takes it (V30 §13): an age X25519 recipient, `age1…` in Bech32, or an OpenSSH
// Ed25519 key, `ssh-ed25519 AAAA… comment`. Pure and synchronous, so the compiler checks a written key and the engine a
// key the script computes; the Player reads the same bytes to lock with them.

/** A public key a lock accepts, with the bytes the age stanza for it needs. */
export type PublicKey =
  | { readonly kind: "x25519"; readonly key: Uint8Array }
  | {
      readonly kind: "ssh-ed25519";
      /** The key's SSH wire encoding, whose SHA-256 tags the stanza. */
      readonly wire: Uint8Array;
      /** The Ed25519 public key. */
      readonly key: Uint8Array;
    };

/** The public key `text` holds, or `null` when it is neither an `age1…` recipient nor an `ssh-ed25519` key. */
export function parsePublicKey(text: string): PublicKey | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("ssh-ed25519 ")) {
    const encoded = trimmed.slice("ssh-ed25519 ".length).trim().split(/\s+/u)[0] ?? "";
    const wire = standardBase64Bytes(encoded);
    if (wire === null || wire.length !== 51) return null;
    // string "ssh-ed25519", then string of the 32-byte key, each with a 4-byte big-endian length.
    const name = [0, 0, 0, 11, ...new TextEncoder().encode("ssh-ed25519"), 0, 0, 0, 32];
    if (name.some((byte, index) => wire[index] !== byte)) return null;
    return { kind: "ssh-ed25519", wire, key: wire.slice(19) };
  }
  const decoded = bech32(trimmed);
  if (decoded === null || decoded.prefix !== "age" || decoded.data.length !== 32) return null;
  return { kind: "x25519", key: decoded.data };
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
