// The public key opener's age file (https://age-encryption.org/v1): a standard age v1 file whose content is the lock's
// content key, which the keyholder opens with the `age` tool and their own identity. X25519, HKDF-SHA-256, HMAC-SHA-256,
// and randomness are the browser's WebCrypto; ChaCha20-Poly1305, which only some browsers have, and the conversion of an
// Ed25519 key to X25519 for an `ssh-ed25519` recipient come from Noble. The Player loads this module only when a lock has
// a public key opener.

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { PublicKey } from "../../src/public-keys.js";

const text = new TextEncoder();
const X25519_LABEL = text.encode("age-encryption.org/v1/X25519");
const SSH_LABEL = text.encode("age-encryption.org/v1/ssh-ed25519");

/** An age file holding `content` for each of `recipients`: any one of their identities opens it. */
export async function ageFile(
  content: Uint8Array,
  recipients: readonly PublicKey[],
): Promise<Uint8Array<ArrayBuffer>> {
  if (recipients.length === 0) throw new Error("An age file needs a recipient.");
  const fileKey = crypto.getRandomValues(new Uint8Array(16));
  const stanzas: string[] = [];
  for (const recipient of recipients) stanzas.push(await stanza(recipient, fileKey));
  const headerWithoutMac = text.encode(`age-encryption.org/v1\n${stanzas.join("")}---`);
  const mac = await hmac(
    await hkdf(fileKey, new Uint8Array(), text.encode("header")),
    headerWithoutMac,
  );
  const header = concat(headerWithoutMac, text.encode(` ${base64NoPadding(mac)}\n`));
  // The payload: a nonce, then STREAM over ChaCha20-Poly1305 in one final chunk (content of at most 64 KiB).
  if (content.length > 65_536) throw new Error("This age file holds a key, not a long payload.");
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const payloadKey = await hkdf(fileKey, nonce, text.encode("payload"));
  const chunkNonce = new Uint8Array(12);
  chunkNonce[11] = 1;
  return concat(header, nonce, chacha20poly1305(payloadKey, chunkNonce).encrypt(content));
}

/** A recipient stanza: its line and its body, which wraps the file key. */
async function stanza(recipient: PublicKey, fileKey: Uint8Array): Promise<string> {
  const ephemeral = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  // X25519 makes a key pair; the browser's types also allow a single key.
  if (!("privateKey" in ephemeral)) throw new Error("X25519 gave no key pair.");
  const ephemeralPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  if (recipient.kind === "x25519") {
    const shared = await x25519(ephemeral.privateKey, recipient.key);
    const wrapKey = await hkdf(shared, concat(ephemeralPublic, recipient.key), X25519_LABEL);
    return `-> X25519 ${base64NoPadding(ephemeralPublic)}\n${body(wrapKey, fileKey)}`;
  }
  // age's SSH Ed25519 recipient: the key as X25519, and the shared secret tweaked with a key the wire encoding gives.
  const peer = ed25519.utils.toMontgomery(recipient.key);
  const shared = await x25519(ephemeral.privateKey, peer);
  const tweak = await hkdf(new Uint8Array(), recipient.wire, SSH_LABEL);
  const tweaked = await x25519(await privateX25519(tweak), shared);
  const wrapKey = await hkdf(tweaked, concat(ephemeralPublic, peer), SSH_LABEL);
  const tag = new Uint8Array(await crypto.subtle.digest("SHA-256", copy(recipient.wire))).slice(
    0,
    4,
  );
  return `-> ssh-ed25519 ${base64NoPadding(tag)} ${base64NoPadding(ephemeralPublic)}\n${body(wrapKey, fileKey)}`;
}

/** A stanza body: the file key sealed with a zero nonce, in unpadded Base64 lines of 64 columns, the last shorter. */
function body(wrapKey: Uint8Array, fileKey: Uint8Array): string {
  const encoded = base64NoPadding(chacha20poly1305(wrapKey, new Uint8Array(12)).encrypt(fileKey));
  const lines: string[] = encoded.match(/.{1,64}/gu) ?? [];
  // A body whose last line is a whole 64 columns ends with an empty line.
  if (lines.length === 0 || lines.at(-1)!.length === 64) lines.push("");
  return `${lines.join("\n")}\n`;
}

async function x25519(
  privateKey: CryptoKey,
  publicKey: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const peer = await crypto.subtle.importKey("raw", copy(publicKey), { name: "X25519" }, false, []);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "X25519", public: peer }, privateKey, 256),
  );
}

/** A raw 32-byte X25519 scalar as a private key, through its PKCS #8 encoding. */
function privateX25519(scalar: Uint8Array): Promise<CryptoKey> {
  const prefix = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
  ];
  return crypto.subtle.importKey(
    "pkcs8",
    concat(Uint8Array.from(prefix), scalar),
    { name: "X25519" },
    false,
    ["deriveBits"],
  );
}

async function hkdf(
  secret: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", copy(secret), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: copy(salt), info: copy(info) },
      key,
      256,
    ),
  );
}

async function hmac(secret: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    copy(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, copy(data)));
}

function base64NoPadding(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/u, "");
}

function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}
