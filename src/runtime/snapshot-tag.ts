import type { InstructionPlan } from "../plan/model.js";

/*
 * Tags that prove that this engine exported a snapshot's JSON in this process, for one plan
 * (docs/RUNTIME.md#runtime-sessions). A tag is SipHash-2-4 (Aumasson and Bernstein, 2012), a keyed pseudorandom
 * function for authenticating data, of the JSON's UTF-16 code units, under a 128-bit key of its own for each plan that
 * `crypto.getRandomValues` gives when a session of the plan first exports a tagged snapshot. The keys never leave this
 * module, so only this module can give a tag.
 */

const planKeys = new WeakMap<InstructionPlan, Int32Array>();

/** The tag of `json`, a snapshot of `plan` that this engine wrote. */
export function snapshotTag(plan: InstructionPlan, json: string): string {
  let key = planKeys.get(plan);
  if (key === undefined) {
    key = globalThis.crypto.getRandomValues(new Int32Array(4));
    planKeys.set(plan, key);
  }
  return sipHash24(key, json);
}

/** Whether `tag` is the tag this process gives `json` for `plan`. */
export function hasSnapshotTag(plan: InstructionPlan, json: string, tag: string): boolean {
  const key = planKeys.get(plan);
  if (key === undefined) return false;
  const expected = sipHash24(key, json);
  // Every character is compared, so the time taken does not tell how much of a forged tag is right.
  let difference = expected.length ^ tag.length;
  for (let index = 0; index < expected.length; index += 1)
    difference |= expected.charCodeAt(index) ^ tag.charCodeAt(index);
  return difference === 0;
}

/**
 * SipHash-2-4 of `text` as UTF-16LE bytes, so that every string has its own message, under the 128-bit key given as
 * four little-endian 32-bit words: the 64-bit result as 16 hexadecimal digits. JavaScript has no 64-bit integer
 * arithmetic that is fast, so each 64-bit word is a low and a high 32-bit half; the loop body is written out for speed.
 */
export function sipHash24(key: Int32Array, text: string): string {
  const k0l = key[0] ?? 0;
  const k0h = key[1] ?? 0;
  const k1l = key[2] ?? 0;
  const k1h = key[3] ?? 0;
  // The initial state is the key XOR "somepseudorandomlygeneratedbytes".
  let v0l = k0l ^ 0x70736575;
  let v0h = k0h ^ 0x736f6d65;
  let v1l = k1l ^ 0x6e646f6d;
  let v1h = k1h ^ 0x646f7261;
  let v2l = k0l ^ 0x6e657261;
  let v2h = k0h ^ 0x6c796765;
  let v3l = k1l ^ 0x79746573;
  let v3h = k1h ^ 0x74656462;
  const length = text.length;
  // Each message word is four code units; the last word holds the rest and the byte length modulo 256 in its top
  // byte. Two more passes without a message word are the four finalization rounds.
  const last = length >> 2;
  for (let word = 0; word <= last + 2; word += 1) {
    const index = word << 2;
    let ml = 0;
    let mh = 0;
    if (word < last) {
      ml = text.charCodeAt(index) | (text.charCodeAt(index + 1) << 16);
      mh = text.charCodeAt(index + 2) | (text.charCodeAt(index + 3) << 16);
    } else if (word === last) {
      const rest = length - index;
      if (rest > 0) ml = text.charCodeAt(index);
      if (rest > 1) ml |= text.charCodeAt(index + 1) << 16;
      if (rest > 2) mh = text.charCodeAt(index + 2);
      mh |= length << 25;
    } else if (word === last + 1) {
      v2l ^= 0xff;
    }
    v3l ^= ml;
    v3h ^= mh;
    // Two SipRounds. A 64-bit sum carries the low halves' carry, ((a & b) | ((a | b) & ~sum)) >>> 31, into its high
    // half; a rotation by 32 swaps the halves.
    for (let round = 0; round < 2; round += 1) {
      let t = (v0l + v1l) | 0;
      v0h = (v0h + v1h + (((v0l & v1l) | ((v0l | v1l) & ~t)) >>> 31)) | 0;
      v0l = t;
      t = v1h;
      v1h = ((v1h << 13) | (v1l >>> 19)) ^ v0h;
      v1l = ((v1l << 13) | (t >>> 19)) ^ v0l;
      t = v0l;
      v0l = v0h;
      v0h = t;
      t = (v2l + v3l) | 0;
      v2h = (v2h + v3h + (((v2l & v3l) | ((v2l | v3l) & ~t)) >>> 31)) | 0;
      v2l = t;
      t = v3h;
      v3h = ((v3h << 16) | (v3l >>> 16)) ^ v2h;
      v3l = ((v3l << 16) | (t >>> 16)) ^ v2l;
      t = (v0l + v3l) | 0;
      v0h = (v0h + v3h + (((v0l & v3l) | ((v0l | v3l) & ~t)) >>> 31)) | 0;
      v0l = t;
      t = v3h;
      v3h = ((v3h << 21) | (v3l >>> 11)) ^ v0h;
      v3l = ((v3l << 21) | (t >>> 11)) ^ v0l;
      t = (v2l + v1l) | 0;
      v2h = (v2h + v1h + (((v2l & v1l) | ((v2l | v1l) & ~t)) >>> 31)) | 0;
      v2l = t;
      t = v1h;
      v1h = ((v1h << 17) | (v1l >>> 15)) ^ v2h;
      v1l = ((v1l << 17) | (t >>> 15)) ^ v2l;
      t = v2l;
      v2l = v2h;
      v2h = t;
    }
    v0l ^= ml;
    v0h ^= mh;
  }
  return hexWord(v0h ^ v1h ^ v2h ^ v3h) + hexWord(v0l ^ v1l ^ v2l ^ v3l);
}

function hexWord(word: number): string {
  return (word >>> 0).toString(16).padStart(8, "0");
}
