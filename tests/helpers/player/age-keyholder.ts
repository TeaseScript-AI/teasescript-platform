import assert from "node:assert/strict";

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";

// A keyholder for tests of the public key opener: identities, and a small age v1 reader after the age specification
// (https://age-encryption.org/v1), which opens an age file with an X25519 identity or an OpenSSH Ed25519 key.

const text = new TextEncoder();

/** A keyholder's identity: an age X25519 identity or an OpenSSH Ed25519 key, and the public key a lock takes. */
export type Identity =
  | { readonly kind: "x25519"; readonly secret: Uint8Array; readonly recipient: string }
  | { readonly kind: "ssh"; readonly seed: Uint8Array; readonly recipient: string };

export function x25519Identity(): Identity {
  const secret = x25519.utils.randomSecretKey();
  return { kind: "x25519", secret, recipient: bech32("age", x25519.getPublicKey(secret)) };
}

export function sshIdentity(): Identity {
  const seed = ed25519.utils.randomSecretKey();
  return {
    kind: "ssh",
    seed,
    recipient: `ssh-ed25519 ${base64(sshWire(ed25519.getPublicKey(seed)))} keyholder`,
  };
}

function sshWire(key: Uint8Array): Uint8Array {
  return Uint8Array.from([0, 0, 0, 11, ...text.encode("ssh-ed25519"), 0, 0, 0, 32, ...key]);
}

/**
 * What an age file holds for `identity`, read after age v1: the stanza for the identity unwraps the file key, the header
 * MAC is checked, and the payload is one final ChaCha20-Poly1305 chunk; `null` when no stanza is for the identity.
 */
export function openAge(file: Uint8Array, identity: Identity): Uint8Array | null {
  const headerEnd = file.indexOf(0x0a, findBytes(file, text.encode("\n--- ")) + 1);
  const header = new TextDecoder().decode(file.subarray(0, headerEnd));
  const lines = header.split("\n");
  assert.equal(lines[0], "age-encryption.org/v1");
  const macLine = lines.at(-1)!;
  let fileKey: Uint8Array | null = null;
  for (let at = 1; at < lines.length - 1;) {
    const args = lines[at]!.split(" ").slice(1);
    const body: string[] = [];
    at += 1;
    while (true) {
      const line = lines[at]!;
      body.push(line);
      at += 1;
      if (line.length < 64) break;
    }
    const wrapped = fromBase64(body.join(""));
    const key = unwrap(args, wrapped, identity);
    if (key !== null) fileKey = key;
  }
  if (fileKey === null) return null;
  const macKey = hkdf(sha256, fileKey, new Uint8Array(), text.encode("header"), 32);
  const mac = hmac(
    sha256,
    macKey,
    text.encode(header.slice(0, header.length - macLine.length + 3)),
  );
  assert.equal(macLine, `--- ${base64(mac).replace(/=+$/u, "")}`);
  const nonce = file.subarray(headerEnd + 1, headerEnd + 17);
  const payloadKey = hkdf(sha256, fileKey, nonce, text.encode("payload"), 32);
  const chunkNonce = new Uint8Array(12);
  chunkNonce[11] = 1;
  return chacha20poly1305(payloadKey, chunkNonce).decrypt(file.subarray(headerEnd + 17));
}

function unwrap(
  args: readonly string[],
  wrapped: Uint8Array,
  identity: Identity,
): Uint8Array | null {
  try {
    if (args[0] === "X25519" && identity.kind === "x25519") {
      const ephemeral = fromBase64(args[1]!);
      const shared = x25519.getSharedSecret(identity.secret, ephemeral);
      const salt = Uint8Array.from([...ephemeral, ...x25519.getPublicKey(identity.secret)]);
      const wrapKey = hkdf(sha256, shared, salt, text.encode("age-encryption.org/v1/X25519"), 32);
      return chacha20poly1305(wrapKey, new Uint8Array(12)).decrypt(wrapped);
    }
    if (args[0] === "ssh-ed25519" && identity.kind === "ssh") {
      const wire = sshWire(ed25519.getPublicKey(identity.seed));
      if (args[1] !== base64(sha256(wire).subarray(0, 4)).replace(/=+$/u, "")) return null;
      const ephemeral = fromBase64(args[2]!);
      const scalar = sha512(identity.seed).subarray(0, 32);
      const shared = x25519.getSharedSecret(scalar, ephemeral);
      const tweak = hkdf(
        sha256,
        new Uint8Array(),
        wire,
        text.encode("age-encryption.org/v1/ssh-ed25519"),
        32,
      );
      const tweaked = x25519.getSharedSecret(tweak, shared);
      const salt = Uint8Array.from([
        ...ephemeral,
        ...ed25519.utils.toMontgomery(ed25519.getPublicKey(identity.seed)),
      ]);
      const wrapKey = hkdf(
        sha256,
        tweaked,
        salt,
        text.encode("age-encryption.org/v1/ssh-ed25519"),
        32,
      );
      return chacha20poly1305(wrapKey, new Uint8Array(12)).decrypt(wrapped);
    }
  } catch {
    return null;
  }
  return null;
}

/** Bech32 (BIP 173) of 8-bit data, as age writes recipients and identities. */
export function bech32(prefix: string, data: Uint8Array): string {
  const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const values: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of data) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      values.push((accumulator >> bits) & 31);
    }
  }
  if (bits > 0) values.push((accumulator << (5 - bits)) & 31);
  const expanded = [
    ...[...prefix].map((character) => character.charCodeAt(0) >> 5),
    0,
    ...[...prefix].map((character) => character.charCodeAt(0) & 31),
  ];
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of [...expanded, ...values, 0, 0, 0, 0, 0, 0]) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit += 1) if ((top >> bit) & 1) checksum ^= generators[bit]!;
  }
  checksum ^= 1;
  const sum = Array.from({ length: 6 }, (_, index) => (checksum >> (5 * (5 - index))) & 31);
  return `${prefix}1${[...values, ...sum].map((value) => charset[value]).join("")}`;
}

export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromBase64(encoded: string): Uint8Array {
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  return Buffer.from(haystack).indexOf(Buffer.from(needle));
}
