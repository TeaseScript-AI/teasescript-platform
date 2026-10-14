// Locks and their openers (V30 §13, docs/ENCRYPTION.md). The content is encrypted once with a fresh random 256-bit
// content key K, and each opener holds its own copy of K; any one opener opens. Locks use the browser's own WebCrypto
// for AES-GCM, PBKDF2, and randomness; the time lock's pairing cryptography is loaded only when a lock has one.
//
// Format, version 1:
//   "TSLK" | version 1 | opener count (1..255)
//   per opener: kind (1 byte) | body length (uint16 BE) | body
//   nonce (12) | AES-256-GCM(K, nonce, content), with every byte before the nonce as additional data
// Opener bodies:
//   1, password: PBKDF2 iterations (uint32 BE) | salt (16) | AES-256-GCM(KEK, zero nonce, K) (48), where the KEK is
//      PBKDF2-HMAC-SHA-256 of "teasescript-lock-password:" and the password's UTF-8
//   2, time:     round (uint64 BE) | drand tlock IBE ciphertext of K for quicknet (160)

import {
  fetchBeacon,
  QUICKNET_PUBLIC_KEY,
  roundAt,
  roundAtOrAfter,
  roundTimeMs,
  type BeaconAnswer,
} from "./drand.js";

const MAGIC = [0x54, 0x53, 0x4c, 0x4b];
const VERSION = 1;
const PASSWORD_OPENER = 1;
const TIME_OPENER = 2;

/** OWASP's current work factor for PBKDF2-HMAC-SHA-256 (Password Storage Cheat Sheet). */
export const PASSWORD_ITERATIONS = 600_000;
/** The most iterations a lock may ask for, so that a made-up lock cannot keep the Player busy for long. */
const MAX_PASSWORD_ITERATIONS = 10_000_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_KEY_BYTES = KEY_BYTES + TAG_BYTES;
const TIME_CIPHERTEXT_BYTES = 160;

/** The time lock's pairing cryptography, loaded on demand. */
export type TlockModule = typeof import("./tlock.js");

export function loadTlock(): Promise<TlockModule> {
  return import("./tlock.js");
}

/** What locking and opening use besides WebCrypto: the time lock's code, the relays, and the device clock. */
export interface LockServices {
  readonly tlock: () => Promise<TlockModule>;
  readonly fetch: typeof fetch;
  /** The device clock, in epoch milliseconds. */
  readonly nowMs: () => number;
}

/** The openers of a lock to make: a password, and a moment the time lock opens at. */
export interface LockOpeners {
  readonly password: string | null;
  readonly timeLockMs: number | null;
}

/** A lock as made: its bytes and the moment its time lock opens, after a correction of a clock that is behind. */
export interface MadeLock {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly timeLockMs: number | null;
}

/** How long locking waits for drand's latest round to check the device clock; offline it locks without the check. */
const CLOCK_CHECK_MS = 4_000;

/**
 * Locks `content` with the openers. A time lock opens at the first quicknet round at or after its moment. When the
 * Player can reach drand, a device clock that is behind drand's latest round moves the moment later by as much, so a
 * clock set back does not make a lock open early.
 */
export async function lock(
  content: Uint8Array,
  openers: LockOpeners,
  services: LockServices,
): Promise<MadeLock> {
  if (openers.password === null && openers.timeLockMs === null)
    throw new Error("A lock needs an opener.");
  const key = randomBytes(KEY_BYTES);
  const parts: Uint8Array[] = [];
  if (openers.password !== null) parts.push(await passwordOpener(openers.password, key));
  let timeLockMs = openers.timeLockMs;
  if (timeLockMs !== null) {
    const tlock = await services.tlock();
    const latest = await fetchBeacon(
      "latest",
      (round, signature) => tlock.verifyRoundSignature(QUICKNET_PUBLIC_KEY, round, signature),
      services.fetch,
      AbortSignal.timeout(CLOCK_CHECK_MS),
    );
    if (latest.kind === "signature") {
      const behind = roundTimeMs(latest.round) - services.nowMs();
      if (behind > 0) timeLockMs += behind;
    }
    const round = roundAtOrAfter(timeLockMs);
    parts.push(
      opener(TIME_OPENER, uint64(round), tlock.sealToRound(QUICKNET_PUBLIC_KEY, round, key)),
    );
  }
  if (parts.length > 255) throw new Error("A lock holds at most 255 openers.");
  const header = concat(new Uint8Array(MAGIC), new Uint8Array([VERSION, parts.length]), ...parts);
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: header },
    await aesKey(key),
    copy(content),
  );
  return {
    bytes: concat(header, nonce, new Uint8Array(sealed)),
    timeLockMs: timeLockMs === null ? null : roundTimeMs(roundAtOrAfter(timeLockMs)),
  };
}

/** A lock as read: its openers, and its header, nonce, and sealed content, which every opener's key opens. */
export interface ReadLock {
  readonly passwords: readonly PasswordOpener[];
  readonly times: readonly TimeOpener[];
  readonly header: Uint8Array<ArrayBuffer>;
  readonly nonce: Uint8Array<ArrayBuffer>;
  readonly sealed: Uint8Array<ArrayBuffer>;
}

interface PasswordOpener {
  readonly iterations: number;
  readonly salt: Uint8Array<ArrayBuffer>;
  readonly wrapped: Uint8Array<ArrayBuffer>;
}

interface TimeOpener {
  readonly round: number;
  readonly ciphertext: Uint8Array;
}

/**
 * Reads a lock, or gives `null` for bytes that are not a lock of a version this Player knows. A lock holds at most one
 * opener of each kind, as one is made, so a made-up lock cannot ask for repeated work.
 */
export function readLock(bytes: Uint8Array): ReadLock | null {
  if (
    bytes.length < 6 ||
    MAGIC.some((byte, index) => bytes[index] !== byte) ||
    bytes[4] !== VERSION
  )
    return null;
  const count = bytes[5]!;
  const passwords: PasswordOpener[] = [];
  const times: TimeOpener[] = [];
  let at = 6;
  for (let index = 0; index < count; index += 1) {
    if (at + 3 > bytes.length) return null;
    const kind = bytes[at]!;
    const length = (bytes[at + 1]! << 8) | bytes[at + 2]!;
    const body = bytes.slice(at + 3, at + 3 + length);
    at += 3 + length;
    if (body.length !== length) return null;
    const view = new DataView(body.buffer);
    if (kind === PASSWORD_OPENER) {
      if (length !== 4 + SALT_BYTES + WRAPPED_KEY_BYTES || passwords.length > 0) return null;
      passwords.push({
        iterations: view.getUint32(0),
        salt: body.slice(4, 4 + SALT_BYTES),
        wrapped: body.slice(4 + SALT_BYTES),
      });
    } else if (kind === TIME_OPENER) {
      if (length !== 8 + TIME_CIPHERTEXT_BYTES || times.length > 0) return null;
      const round = view.getBigUint64(0);
      if (round < 1n || round > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      times.push({ round: Number(round), ciphertext: body.slice(8) });
    }
    // An opener of a kind this Player does not know may still be followed by one it knows.
  }
  if (at + NONCE_BYTES + TAG_BYTES > bytes.length) return null;
  return {
    passwords,
    times,
    header: bytes.slice(0, at),
    nonce: bytes.slice(at, at + NONCE_BYTES),
    sealed: bytes.slice(at + NONCE_BYTES),
  };
}

/** The moments a lock's time locks open at. */
export function timeLockMoments(read: ReadLock): number[] {
  return read.times.map((time) => roundTimeMs(time.round));
}

/** The content a password opens, or `null` when it opens none of the lock's password openers. */
export async function openWithPassword(
  read: ReadLock,
  password: string,
): Promise<Uint8Array | null> {
  for (const opener of read.passwords) {
    if (opener.iterations < 1 || opener.iterations > MAX_PASSWORD_ITERATIONS) continue;
    const kek = await passwordKey(password, opener.salt, opener.iterations);
    const key = await unseal(kek, new Uint8Array(NONCE_BYTES), opener.wrapped);
    const content = key === null ? null : await openContent(read, key);
    if (content !== null) return content;
  }
  return null;
}

/** The content a content key opens, or `null` for a key that does not open it, or a lock that was changed. */
export async function openContent(read: ReadLock, key: Uint8Array): Promise<Uint8Array | null> {
  if (key.length !== KEY_BYTES) return null;
  return unseal(await aesKey(key), read.nonce, read.sealed, read.header);
}

/** What the time locks gave: the content, or that none is out yet, or that the relays could not be reached. */
export type TimeOpening =
  | { readonly kind: "opened"; readonly content: Uint8Array }
  | { readonly kind: "notYet" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "notOpened" };

/**
 * Opens a lock with a time lock whose moment passed by the device clock, with its round's verified beacon from the
 * relays. A round still in the future by the device clock is not fetched; a relay that says it is not out yet decides
 * it is not.
 */
export async function openWithTime(read: ReadLock, services: LockServices): Promise<TimeOpening> {
  const now = roundAt(services.nowMs());
  const due = read.times.filter((time) => time.round <= now);
  if (due.length === 0) return { kind: read.times.length === 0 ? "notOpened" : "notYet" };
  const tlock = await services.tlock();
  let answer: BeaconAnswer["kind"] = "notYet";
  for (const time of due) {
    const beacon = await fetchBeacon(
      time.round,
      (round, signature) => tlock.verifyRoundSignature(QUICKNET_PUBLIC_KEY, round, signature),
      services.fetch,
    );
    if (beacon.kind !== "signature") {
      if (beacon.kind === "unreachable") answer = "unreachable";
      continue;
    }
    const key = tlock.openWithSignature(beacon.signature, time.ciphertext);
    const content = key === null ? null : await openContent(read, key);
    return content === null ? { kind: "notOpened" } : { kind: "opened", content };
  }
  return { kind: answer };
}

async function passwordOpener(password: string, key: Uint8Array): Promise<Uint8Array> {
  const salt = randomBytes(SALT_BYTES);
  const kek = await passwordKey(password, salt, PASSWORD_ITERATIONS);
  // The KEK seals one key only, as its salt is new, so its nonce may be zero, as age's stanzas do.
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: new Uint8Array(NONCE_BYTES) },
      kek,
      copy(key),
    ),
  );
  const iterations = new Uint8Array(4);
  new DataView(iterations.buffer).setUint32(0, PASSWORD_ITERATIONS);
  return opener(PASSWORD_OPENER, iterations, salt, wrapped);
}

/**
 * What PBKDF2 derives a password's key from: a fixed prefix, then exactly the password's UTF-8. The prefix separates
 * these keys from other uses of a password and keeps the input from being empty, which WebKit's PBKDF2 refuses.
 */
const PASSWORD_PREFIX = new TextEncoder().encode("teasescript-lock-password:");

/** The key that PBKDF2-HMAC-SHA-256 derives from the prefix and exactly the password's UTF-8. */
async function passwordKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    concat(PASSWORD_PREFIX, new TextEncoder().encode(password)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    256,
  );
  return aesKey(new Uint8Array(bits));
}

function aesKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", copy(key), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function unseal(
  key: CryptoKey,
  nonce: Uint8Array<ArrayBuffer>,
  sealed: Uint8Array<ArrayBuffer>,
  additionalData?: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        additionalData === undefined
          ? { name: "AES-GCM", iv: nonce }
          : { name: "AES-GCM", iv: nonce, additionalData },
        key,
        sealed,
      ),
    );
  } catch {
    return null;
  }
}

function opener(kind: number, ...body: Uint8Array[]): Uint8Array {
  const joined = concat(...body);
  return concat(new Uint8Array([kind, joined.length >> 8, joined.length & 0xff]), joined);
}

function uint64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
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
