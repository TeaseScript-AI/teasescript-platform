import type { PlaceId } from "../../graph.js";
import { joinParts, keptArray } from "../budget.js";
import type { Contract } from "../contract.js";
import { keptKey, keptKeyBelow, type Key } from "../definitions.js";
import { pathAt } from "./literal-index.js";

// G3 stage 1 (TABLE r4.196): a key as a cursor, made one step from its parent's, and the one charged boundary between
// cursors and the texts and step arrays of keys. No answer reads them yet: the literal indexes' `pathIdOf` and `stepsOf`
// stay the legacy lanes', charged as before.

/**
 * A key's cursor: its place and its path's id in the pass's one path arena (`pathAt`, which the literal indexes' paths
 * share), written `place#id`. A map or a set holds it by that short text, and two cursors are equal exactly when they
 * name one key of the pass. An id is allocated as the analysis first asks its path, so it orders nothing
 * (`compareKeyIds`), and it never leaves its pass (`exportKeyIds`).
 */
export type KeyId = `${number}#${number}`;

/** The cursor of `place` at the path id `path`. */
export function keyIdAt(place: PlaceId, path: number): KeyId {
  return `${place}#${path}`;
}

/** A place's own key's cursor: its path the empty one. */
export function rootId(place: PlaceId): KeyId {
  return keyIdAt(place, 0);
}

export function keyIdPlace(id: KeyId): PlaceId {
  return Number(id.slice(0, id.indexOf("#")));
}

/** A cursor's path's id. */
export function keyIdPath(id: KeyId): number {
  return Number(id.slice(id.indexOf("#") + 1));
}

/** The cursor one `step` below `id`: its path's child, made and charged where new (`pathAt`); the step's visit charged. */
export function keyIdBelow(contract: Contract, id: KeyId, step: string): KeyId {
  convert(contract, 1, 0, 0);
  return keyIdAt(keyIdPlace(id), pathAt(contract, keyIdPath(id), step));
}

/** The cursor one step above `id`, `null` at its place's own key. */
export function keyIdParent(contract: Contract, id: KeyId): KeyId | null {
  const path = keyIdPath(id);
  return path === 0 ? null : keyIdAt(keyIdPlace(id), contract.pathParents[path]!);
}

/** A cursor's last step, `""` at its place's own key. */
export function keyIdStep(contract: Contract, id: KeyId): string {
  return contract.pathLastSteps[keyIdPath(id)]!;
}

/** A cursor's path's number of steps. */
export function keyIdDepth(contract: Contract, id: KeyId): number {
  return contract.pathDepths[keyIdPath(id)]!;
}

/** A cursor's first step, its family's (`keyLane`), `null` at its place's own key. */
export function keyIdFirst(contract: Contract, id: KeyId): string | null {
  const path = keyIdPath(id);
  return path === 0 ? null : contract.pathFirstSteps[path]!;
}

/**
 * The one charged boundary of the cursors (TABLE r4.196): `visits` arena nodes or steps it inspects, a node already
 * made too, and `read` code units of text it scans, a unit per eight (`invSteps`), and `entries` it keeps (a unit each);
 * the texts and arrays it makes, through the kept helpers (`keptKey`, `keptArray`, TABLE r4.58). Each conversion is
 * the asking demand's own work, never a shared build's or work apart; what it makes is kept per id, never per prefix.
 */
function convert(contract: Contract, visits: number, read: number, entries: number): void {
  const inspected = visits + (read >> 3);
  if (inspected > 0) contract.work.charge("invSteps", inspected);
  if (entries > 0) contract.keep(entries);
}

/** The cursor of `place` at the path of `steps` (an array-born key or question), each step inspected and charged. */
export function keyIdOf(contract: Contract, place: PlaceId, steps: readonly string[]): KeyId {
  let read = 0;
  for (const step of steps) read += step.length;
  convert(contract, steps.length, read, 0);
  let id = 0;
  for (const step of steps) id = pathAt(contract, id, step);
  return keyIdAt(place, id);
}

/** The cursor of a key's text (`place|a.b`), scanned once and charged, each step's text made only to look it up. */
export function keyIdOfText(contract: Contract, key: Key): KeyId {
  const bar = key.indexOf("|");
  convert(contract, 1, key.length, 0);
  let id = 0;
  for (let at = bar + 1; at < key.length;) {
    const dot = key.indexOf(".", at);
    const end = dot < 0 ? key.length : dot;
    convert(contract, 1, 0, 0);
    id = pathAt(contract, id, key.slice(at, end));
    at = end + 1;
  }
  return keyIdAt(Number(key.slice(0, bar)), id);
}

/**
 * A cursor's key as its text (`keyOf`), made once per cursor and kept: down from the nearest key above it whose text is
 * made, so a conversion walks no prefix twice and makes no prefix's text it was not asked for.
 */
export function keyOfId(contract: Contract, id: KeyId): Key {
  const place = keyIdPlace(id);
  const path = keyIdPath(id);
  let texts = contract.keyTexts.get(place);
  const known = texts?.get(path);
  if (known !== undefined) {
    convert(contract, 1, 0, 0);
    return known;
  }
  const way: string[] = [];
  let at = path;
  for (; at !== 0 && texts?.get(at) === undefined; at = contract.pathParents[at]!)
    way.push(contract.pathLastSteps[at]!);
  convert(contract, way.length + 1, 0, 1);
  way.reverse();
  const text =
    at === 0
      ? keptKey(contract.work, place, way)
      : keptKeyBelow(contract.work, texts!.get(at)!, way);
  if (texts === undefined) contract.keyTexts.set(place, (texts = new Map()));
  texts.set(path, text);
  return text;
}

/**
 * The steps of a cursor's path from its step `from` on (a span: `from` 0 the whole path), made and charged; the whole
 * path's made once per path and kept, a span's from it where it is made, else by a walk of the span alone.
 */
export function stepsOfId(contract: Contract, id: KeyId, from = 0): readonly string[] {
  const path = keyIdPath(id);
  const depth = contract.pathDepths[path]!;
  if (!Number.isInteger(from) || from < 0 || from > depth)
    throw new RangeError(`A path of ${depth} steps has no step ${from}.`);
  const whole = contract.pathStepLists.get(path);
  if (whole !== undefined) {
    convert(contract, 1, 0, 0);
    return from === 0 ? whole : keptArray(contract.work, whole.slice(from));
  }
  convert(contract, depth - from, 0, from === 0 ? 1 : 0);
  const steps: string[] = [];
  for (let at = path; contract.pathDepths[at]! > from; at = contract.pathParents[at]!)
    steps.push(contract.pathLastSteps[at]!);
  steps.reverse();
  keptArray(contract.work, steps);
  if (from === 0) contract.pathStepLists.set(path, steps);
  return steps;
}

/**
 * The first step of a cursor's path from its step `from` on that a built-in value answers by itself (`memberStep`), by
 * its index in the path, or -1: from the nearest such step at or above the cursor (`pathMembers`), climbing only the
 * member steps below `from`, each charged.
 */
export function memberStepIn(contract: Contract, id: KeyId, from = 0): number {
  let found = -1;
  convert(contract, 1, 0, 0);
  for (
    let at = contract.pathMembers[keyIdPath(id)]!;
    at !== 0 && contract.pathDepths[at]! > from;
    at = contract.pathMembers[contract.pathParents[at]!]!
  ) {
    convert(contract, 1, 0, 0);
    found = contract.pathDepths[at]! - 1;
  }
  return found;
}

/**
 * Two cursors in the order of their keys' texts (`keyOfId`, UTF-16 code units), the canonical order (#1398), never
 * their ids': their places' decimal texts, then their paths from the steps where they part, found by climbing to them
 * (each node charged); a path before the paths below it.
 */
export function compareKeyIds(contract: Contract, a: KeyId, b: KeyId): number {
  if (a === b) return 0;
  const [placeA, placeB] = [keyIdPlace(a), keyIdPlace(b)];
  if (placeA !== placeB) return joinParts(placeA, "") < joinParts(placeB, "") ? -1 : 1;
  const [pathA, pathB] = [keyIdPath(a), keyIdPath(b)];
  const { pathParents: parents, pathDepths: depths } = contract;
  let [x, y] = [pathA, pathB];
  let [belowX, belowY] = [-1, -1];
  for (; depths[x]! > depths[y]!; x = parents[x]!) {
    convert(contract, 1, 0, 0);
    belowX = x;
  }
  for (; depths[y]! > depths[x]!; y = parents[y]!) {
    convert(contract, 1, 0, 0);
    belowY = y;
  }
  for (; x !== y; [x, y] = [parents[x]!, parents[y]!]) {
    convert(contract, 2, 0, 0);
    [belowX, belowY] = [x, y];
  }
  if (belowX < 0) return -1;
  if (belowY < 0) return 1;
  // (two distinct steps below one path: each text goes on with a dot where its path goes deeper, else ends, and a step
  // holds no dot, so the texts part at or before it)
  const [stepX, stepY] = [contract.pathLastSteps[belowX]!, contract.pathLastSteps[belowY]!];
  convert(contract, 0, Math.min(stepX.length, stepY.length), 0);
  const textX = belowX === pathA ? stepX : `${stepX}.`;
  const textY = belowY === pathB ? stepY : `${stepY}.`;
  return textX < textY ? -1 : 1;
}

/**
 * Cursors as a JSON-safe packet any pass reads back (`importKeyIds`), never their ids: each path node once, after its
 * parent, as its parent's index (-1 the empty path) and its step, and each key as its place and its path's node (-1 the
 * empty path), in `ids`' order. Made while the pass that made the cursors holds them (#1422 B1); each node and key an entry
 * charged, its step the arena's own text.
 */
export interface KeyPacket {
  readonly nodes: readonly (readonly [parent: number, step: string])[];
  readonly keys: readonly (readonly [place: PlaceId, node: number])[];
}

export function exportKeyIds(contract: Contract, ids: readonly KeyId[]): KeyPacket {
  const index = new Map<number, number>([[0, -1]]);
  const nodes: (readonly [number, string])[] = [];
  const keys: (readonly [PlaceId, number])[] = [];
  for (const id of ids) {
    const path = keyIdPath(id);
    // (the path's nodes not in the packet yet, the deepest first)
    const way: number[] = [];
    for (let at = path; !index.has(at); at = contract.pathParents[at]!) way.push(at);
    convert(contract, way.length + 1, 0, way.length + 1);
    for (let at = way.length - 1; at >= 0; at -= 1) {
      const node = way[at]!;
      const step = contract.pathLastSteps[node]!;
      index.set(node, nodes.length);
      nodes.push([index.get(contract.pathParents[node]!)!, step]);
    }
    keys.push([keyIdPlace(id), index.get(path)!]);
  }
  return { nodes, keys };
}

/** A packet's entry as its two parts, unread, or `null` (`importKeyIds`). */
function pairOf(entry: unknown): readonly [unknown, unknown] | null {
  return Array.isArray(entry) && entry.length === 2 ? [entry[0], entry[1]] : null;
}

/** An index into what a packet has read so far: -1, or below `length`. */
function indexBelow(at: unknown, length: number): at is number {
  return typeof at === "number" && Number.isInteger(at) && at >= -1 && at < length;
}

/**
 * The cursors of a packet (`exportKeyIds`) in this pass: its nodes made or found here, parent first, each inspected and
 * charged, then its keys; a malformed packet is refused, whole entries checked as they are read.
 */
export function importKeyIds(contract: Contract, packet: unknown): KeyId[] {
  const malformed = (what: string): Error => new Error(`A key packet has ${what}.`);
  if (typeof packet !== "object" || packet === null || !("nodes" in packet) || !("keys" in packet))
    throw malformed("no nodes and keys");
  const { nodes, keys } = packet;
  if (!Array.isArray(nodes) || !Array.isArray(keys)) throw malformed("no nodes and keys");
  const ids: number[] = [];
  for (const node of nodes) {
    const pair = pairOf(node);
    if (pair === null) throw malformed("a node that is no pair");
    const [parent, step] = pair;
    if (!indexBelow(parent, ids.length)) throw malformed("a node before its parent");
    if (typeof step !== "string" || step === "" || step.includes("."))
      throw malformed("a node whose step is no step");
    convert(contract, 1, step.length, 0);
    ids.push(pathAt(contract, parent < 0 ? 0 : ids[parent]!, step));
  }
  return keys.map((key: unknown) => {
    const pair = pairOf(key);
    if (pair === null) throw malformed("a key that is no pair");
    const [place, node] = pair;
    if (typeof place !== "number" || !Number.isSafeInteger(place) || place < 0)
      throw malformed("a key with no place");
    if (!indexBelow(node, ids.length)) throw malformed("a key with no node");
    convert(contract, 1, 0, 0);
    return keyIdAt(place, node < 0 ? 0 : ids[node]!);
  });
}
