// The time lock's pairing cryptography: drand tlock's identity-based encryption on BLS12-381 for the quicknet chain
// (`bls-unchained-g1-rfc9380`), and the verification of a quicknet beacon. Browsers have no pairing cryptography, so this
// uses Noble; the Player loads this module only when it locks or opens a time lock.
//
// Ported from tlock-js 0.9.0 (`crypto/ibe.js`, `encryptOnG2RFC9380` and `decryptOnG2`; MIT OR Apache-2.0, Copyright
// Protocol Labs), the reference that drand's tlock (Go) interoperates with, with the same hashes and serialization.

import { bls12_381 as bls } from "@noble/curves/bls12-381.js";
import { bytesToNumberBE, concatBytes, numberToBytesBE } from "@noble/curves/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** The message a beacon signs and the identity a round is locked to: the SHA-256 of the round as 8 bytes. */
function roundIdentity(round: number): Uint8Array {
  return sha256(numberToBytesBE(BigInt(round), 8));
}

/** quicknet's hash-to-curve domain, RFC 9380 on G1. */
const DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

/** The bytes of U (a compressed G2 point), V, and W of a ciphertext of a 32-byte message. */
const TLOCK_CIPHERTEXT_BYTES = 96 + 32 + 32;

const text = new TextEncoder();

function labelled(label: string, ...parts: Uint8Array[]): Uint8Array {
  return sha256(concatBytes(text.encode(label), ...parts));
}

function xor(left: Uint8Array, right: Uint8Array): Uint8Array {
  return Uint8Array.from(left, (byte, index) => byte ^ right[index]!);
}

type Fp12 = ReturnType<typeof bls.pairing>;
type Fp6 = Fp12["c0"];
type Fp2 = Fp6["c0"];

const fp = (value: bigint) => numberToBytesBE(value, 48);
const fp2 = (value: Fp2) => concatBytes(fp(value.c1), fp(value.c0));
const fp6 = (value: Fp6) => concatBytes(fp2(value.c2), fp2(value.c1), fp2(value.c0));
/** A GT element as tlock serializes it, highest coefficients first. */
const fp12 = (value: Fp12) => concatBytes(fp6(value.c1), fp6(value.c0));

/** H3: the scalar r from sigma and the message, by rejection sampling as tlock does. */
function scalar(sigma: Uint8Array, message: Uint8Array): bigint {
  const seed = labelled("IBE-H3", sigma, message);
  for (let index = 1; index < 65_535; index += 1) {
    const candidate = sha256(concatBytes(new Uint8Array([index & 0xff, index >> 8]), seed));
    candidate[0] = candidate[0]! >> 1;
    const number = bytesToNumberBE(candidate);
    if (number < bls.fields.Fr.ORDER) return number;
  }
  throw new Error("No scalar found.");
}

/**
 * Locks a 32-byte message to a round: only the round's beacon signature, which the drand network publishes when the
 * round comes and not before, opens it. `publicKey` is the chain's G2 public key.
 */
export function sealToRound(publicKey: Uint8Array, round: number, message: Uint8Array): Uint8Array {
  if (message.length !== 32) throw new Error("A time lock holds a 32-byte key.");
  const identity = bls.G1.hashToCurve(roundIdentity(round), { DST });
  const master = bls.G2.Point.fromBytes(publicKey);
  const gid = bls.pairing(identity, master);
  const sigma = crypto.getRandomValues(new Uint8Array(32));
  const r = scalar(sigma, message);
  const u = bls.G2.Point.BASE.multiply(r).toBytes();
  const v = xor(sigma, labelled("IBE-H2", fp12(bls.fields.Fp12.pow(gid, r))));
  const w = xor(message, labelled("IBE-H4", sigma));
  return concatBytes(u, v, w);
}

/** Opens a ciphertext of `sealToRound` with its round's beacon signature, or gives `null` when they do not fit. */
export function openWithSignature(
  signature: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array | null {
  if (ciphertext.length !== TLOCK_CIPHERTEXT_BYTES) return null;
  try {
    const key = bls.G1.Point.fromBytes(signature);
    const u = bls.G2.Point.fromBytes(ciphertext.subarray(0, 96));
    const sigma = xor(ciphertext.subarray(96, 128), labelled("IBE-H2", fp12(bls.pairing(key, u))));
    const message = xor(ciphertext.subarray(128, 160), labelled("IBE-H4", sigma));
    // The proof: U must be r·G2 for the r that sigma and the message give.
    return bls.G2.Point.BASE.multiply(scalar(sigma, message)).equals(u) ? message : null;
  } catch {
    return null;
  }
}

/** Whether `signature` is the chain's beacon signature of `round`. */
export function verifyRoundSignature(
  publicKey: Uint8Array,
  round: number,
  signature: Uint8Array,
): boolean {
  try {
    return bls.shortSignatures.verify(
      signature,
      bls.shortSignatures.hash(roundIdentity(round), DST),
      publicKey,
    );
  } catch {
    return false;
  }
}
