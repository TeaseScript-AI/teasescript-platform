import type { PlaceId } from "../../graph.js";
import {
  joinParts,
  joinSteps,
  keptArray,
  keptSlice,
  keptSteps,
  pathText,
  type WorkLedger,
} from "../budget.js";
import type { Contract } from "../contract.js";
import {
  keptKey,
  keptKeyBelow,
  keptKeyBelowText,
  keptKeyOfText,
  keptParent,
  keptPath,
  keyBelow,
  keyBelowText,
  keyDepth,
  keyOf,
  keyOfText,
  keyPath,
  keyPlace,
  type Key,
} from "../definitions.js";
import { memberStep } from "../method-categories.js";
import { keyLane } from "./lanes.js";
import { pathAt } from "./literal-index.js";

// G3 stage 1 (TABLE r4.196): a key as a cursor, made one step from its parent's, and the one charged boundary between
// cursors and the texts and step arrays of keys; and the one place that decides a key's identity (`keyAt`, `keyBelowIn`,
// `canonicalKey`): a cursor where its family's lane is cursors (`keyLane`), else its text, made and charged as before.

/**
 * A key's cursor: its place and its path's id in the pass's one path arena (`pathAt`, which the literal indexes' paths
 * share), written `place#id`. A map or a set holds it by that short text, and two cursors are equal exactly when they
 * name one key of the pass. An id is allocated as the analysis first asks its path, so it orders nothing
 * (`compareKeyIds`), and it never leaves its pass (`exportKeyIds`).
 */
export type KeyId = `${number}#${number}`;

declare const canonicalTextBrand: unique symbol;

/** A text key in its family's identity: a family whose lane is text (`canonicalKey`, the identity functions). */
type CanonicalText = Key & { readonly [canonicalTextBrand]: true };

/**
 * A key in its family's identity: a cursor, or the text of a family whose lane is text. Only `canonicalKey` and the
 * identity functions make one, so a map or a set keyed by it holds each key in one form (G3 stage 1, Codex r3 R3-F1).
 */
export type CanonicalKey = KeyId | CanonicalText;

/** A text in its family's identity, as the identity functions establish it (their own lane check or construction). */
function canonicalText(key: Key): CanonicalText {
  // EVIDENCE: invariant: only canonicalKey and the identity functions call this, on a text whose family's lane is text.
  return key as CanonicalText;
}

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

/** Whether a key is a cursor (`place#id`), not a key's text (`place|path`, `definitions.ts`). */
export function isKeyId(key: Key): key is KeyId {
  return key.indexOf("|") < 0;
}

/**
 * The key of `place` at the path `steps` (an array-born key) in its family's identity (`keyLane`, by its first step):
 * its cursor where that lane is cursors, each step inspected and charged (`keyIdOf`); else its text, made plain
 * (`keyOf`; `keptKeyAt` charges it, `keptKey`). A place's own key is its text.
 */
export function keyAt(contract: Contract, place: PlaceId, steps: Steps): CanonicalKey {
  return keyAtWith(contract, place, steps, false);
}

/** `keyAt`, its text charged before it is made where it is text (`keptKey`). */
export function keptKeyAt(contract: Contract, place: PlaceId, steps: Steps): CanonicalKey {
  return keyAtWith(contract, place, steps, true);
}

function keyAtWith(contract: Contract, place: PlaceId, steps: Steps, kept: boolean): CanonicalKey {
  if (steps.length > 0 && keyLane(contract, place, steps.at(0)!) === "cursor") {
    // (a record's steps are their path's: its cursor at a visit)
    if (isPathSteps(steps)) {
      convert(contract, 1, 0, 0);
      return keyIdAt(place, steps.path);
    }
    // (a cursor family's key asked by an array: kept by the text its question makes, `textCursor`)
    return textCursor(contract, keyOf(place, steps), () => keyIdOf(contract, place, steps));
  }
  // (a record's steps spelled by their record, `textOf`)
  if (isPathSteps(steps)) {
    const text = steps.text();
    return canonicalText(kept ? keptKeyOfText(contract.work, place, text) : keyOfText(place, text));
  }
  return canonicalText(kept ? keptKey(contract.work, place, steps) : keyOf(place, steps));
}

/**
 * The key `rest` below `key`, in the identity of its family's lane: a cursor's children one step each (`keyIdBelow`); a
 * place's own key's in the lane of its first step's family; else a text below a text, made plain (`keyBelow`).
 */
export function keyBelowIn(contract: Contract, key: Key, rest: Steps): CanonicalKey {
  return keyBelowWith(contract, key, rest, false);
}

/** `keyBelowIn`, a text below a text charged before it is made (`keptKeyBelow`). */
export function keptKeyBelowIn(contract: Contract, key: Key, rest: Steps): CanonicalKey {
  return keyBelowWith(contract, key, rest, true);
}

function keyBelowWith(contract: Contract, asked: Key, rest: Steps, kept: boolean): CanonicalKey {
  // (the key in its identity first: a wrapper family's text below its place's own key is its cursor)
  const key = canonicalKey(contract, asked);
  if (rest.length === 0) return key;
  if (
    !isKeyId(key) &&
    !(key.endsWith("|") && keyLane(contract, keyPlace(key), rest.at(0)!) === "cursor")
  ) {
    // (a record's steps spelled by their record, `textOf`)
    if (isPathSteps(rest)) {
      const text = rest.text();
      return canonicalText(
        kept ? keptKeyBelowText(contract.work, key, text) : keyBelowText(key, text),
      );
    }
    return canonicalText(kept ? keptKeyBelow(contract.work, key, rest) : keyBelow(key, rest));
  }
  const start = isKeyId(key) ? key : rootId(keyPlace(key));
  // (the path below a kept path, by its steps' text: made once per path and steps, found again at one visit)
  const below = (factsOf(contract, keyIdPath(start)).below ??= new Map());
  const text = stepsText(rest);
  let path = below.get(text);
  if (path === undefined) {
    let id = start;
    for (let index = 0; index < rest.length; index += 1)
      id = keyIdBelow(contract, id, rest.at(index)!);
    path = keyIdPath(id);
    contract.keepText(text.length);
    below.set(text, path);
  } else convert(contract, 1, 0, 0);
  return keyIdAt(keyIdPlace(start), path);
}

/**
 * A key's parent in its identity, `null` at a place's own key: a cursor's from the arena (a step's visit charged), a
 * place's own key's text above a first step; a text's text, made plain.
 */
export function keyParentIn(contract: Contract, key: Key): CanonicalKey | null {
  return parentWith(contract, key, false);
}

/** `keyParentIn`, a text's parent charged before it is made (`keptParent`). */
export function keptParentIn(contract: Contract, key: Key): CanonicalKey | null {
  return parentWith(contract, key, true);
}

function parentWith(contract: Contract, asked: Key, kept: boolean): CanonicalKey | null {
  const key = canonicalKey(contract, asked);
  if (!isKeyId(key)) {
    if (kept) {
      const parent = keptParent(contract.work, key);
      return parent === null ? null : canonicalText(parent);
    }
    const steps = keyPath(key);
    return steps.length === 0 ? null : canonicalText(keyOf(keyPlace(key), steps.slice(0, -1)));
  }
  convert(contract, 1, 0, 0);
  const parent = keyIdParent(contract, key);
  return parent === null || keyIdPath(parent) === 0
    ? canonicalText(keyOf(keyIdPlace(key), []))
    : parent;
}

/**
 * A key's prefix of `length` steps in its identity, for a question that reads one prefix: a cursor's ancestor of that
 * depth from its path's prefixes, climbed once per path and kept (`prefixesOf`), never per question; a place's own key
 * its text; a text's as the legacy sites made it.
 */
export function keyPrefixIn(contract: Contract, asked: Key, length: number): CanonicalKey {
  const key = canonicalKey(contract, asked);
  const place = keyPlace(key);
  if (length === 0) return canonicalText(keyOf(place, []));
  if (!isKeyId(key)) return canonicalText(keyOf(place, keyPath(key).slice(0, length)));
  return keyIdAt(place, prefixesOf(contract, keyIdPath(key))[length]!);
}

/**
 * What the cursors derive from one path of the arena (G3 stage 1), each made at its first question by its charged maker,
 * its entry kept, and found again by the path's id (`factsOf`), never derived twice: its steps and its suffixes' by
 * offset (`stepsOfId`), its prefixes' ids by length, all of them (`prefixesOf`) or one (`prefixId`), its spans' ids
 * by offset (`spanId`), its joins'
 * ids by the joined path (`joinedId`, the path the base), the paths below it by their steps' text (`keyBelowIn`), and
 * its steps as text (`textOf`).
 */
export interface PathFacts {
  steps?: PathSteps;
  suffixes?: Map<number, PathSteps>;
  prefixes?: readonly number[];
  prefixAt?: Map<number, number>;
  spans?: Map<number, number>;
  joined?: Map<number, number>;
  below?: Map<string, number>;
  text?: string;
}

/** A path's facts, the one place they are kept: made empty at its first question, its fields filled by their makers. */
function factsOf(contract: Contract, path: number): PathFacts {
  let facts = contract.pathFacts.get(path);
  if (facts === undefined) contract.pathFacts.set(path, (facts = {}));
  return facts;
}

/**
 * A path's prefixes' ids by length (0 its root), climbed once per path and kept, each later question a visit charged:
 * so a question at each of a path's lengths climbs it once, as `stepsOfId` makes its steps once.
 */
function prefixesOf(contract: Contract, path: number): readonly number[] {
  const facts = factsOf(contract, path);
  if (facts.prefixes !== undefined) {
    convert(contract, 1, 0, 0);
    return facts.prefixes;
  }
  const depth = contract.pathDepths[path]!;
  convert(contract, depth + 1, 0, 1);
  const prefixes: number[] = [];
  for (let at = path; ; at = contract.pathParents[at]!) {
    prefixes.push(at);
    if (at === 0) break;
  }
  prefixes.reverse();
  keptArray(contract.work, prefixes);
  facts.prefixes = prefixes;
  return prefixes;
}

/** A key's number of steps, made nothing: a cursor's the arena's, a text's counted (`keyDepth`). */
export function keyDepthIn(contract: Contract, key: Key): number {
  return isKeyId(key) ? keyIdDepth(contract, key) : keyDepth(key);
}

/** A key's last step, `null` at a place's own key: a cursor's the arena's, a text's after its last dot. */
export function keyLastIn(contract: Contract, key: Key): string | null {
  if (isKeyId(key)) return keyIdPath(key) === 0 ? null : keyIdStep(contract, key);
  const steps = keyPath(key);
  return steps.length === 0 ? null : steps.at(-1)!;
}

/** A key's steps, made: a cursor's through the charged boundary (`stepsOfId`), a text's plain (`keyPath`). */
export function keyStepsIn(contract: Contract, key: Key): PathSteps | string[] {
  return isKeyId(key) ? stepsOfId(contract, key) : keyPath(key);
}

/** `keyStepsIn`, a text's steps charged by its text before they are made (`keptPath`). */
export function keptStepsIn(contract: Contract, key: Key): PathSteps | string[] {
  return isKeyId(key) ? stepsOfId(contract, key) : keptPath(contract.work, key);
}

/** A key's whole path and its prefixes' keys, for a question that reads them all (`keyWalk`). */
export interface KeyWalk {
  readonly place: PlaceId;
  readonly path: PathSteps | readonly string[];
  /** The key of the prefix of `length` steps, in the key's identity. */
  prefix(length: number): CanonicalKey;
}

/**
 * A key's path and its prefixes in its identity, for a question that reads its whole path: a text's as the legacy sites
 * made them (`keyPath`, each prefix `keyOf`); a cursor's steps through the charged boundary (`stepsOfId`), its prefixes
 * its ancestors, climbed once per path and kept (`prefixesOf`, a place's own key its text).
 */
export function keyWalk(contract: Contract, key: Key): KeyWalk {
  return walkWith(contract, key, false);
}

/** `keyWalk`, a text's steps charged by its text before they are made (`keptPath`). */
export function keptKeyWalk(contract: Contract, key: Key): KeyWalk {
  return walkWith(contract, key, true);
}

function walkWith(contract: Contract, asked: Key, kept: boolean): KeyWalk {
  const key = canonicalKey(contract, asked);
  const place = keyPlace(key);
  if (!isKeyId(key)) {
    const path = kept ? keptPath(contract.work, key) : keyPath(key);
    return { place, path, prefix: (length) => canonicalText(keyOf(place, path.slice(0, length))) };
  }
  const path = stepsOfId(contract, key);
  let prefixes: readonly number[] | null = null;
  return {
    place,
    path,
    prefix: (length) => {
      if (length === 0) return canonicalText(keyOf(place, []));
      prefixes ??= prefixesOf(contract, keyIdPath(key));
      return keyIdAt(place, prefixes[length]!);
    },
  };
}

/**
 * A key in its family's identity: a cursor as it is; a text of a family whose lane is cursors as its cursor, its text
 * scanned once per pass, charged and kept (`keyIdOfText`), so no map holds one key in both forms; any other text as it
 * is. Where a key
 * enters the contract or admission from outside them (a consumer's key made of its own path).
 */
export function canonicalKey(contract: Contract, key: Key): CanonicalKey {
  if (isKeyId(key)) return key;
  const bar = key.indexOf("|");
  if (bar === key.length - 1) return canonicalText(key);
  const dot = key.indexOf(".", bar + 1);
  const first = key.slice(bar + 1, dot < 0 ? key.length : dot);
  if (keyLane(contract, Number(key.slice(0, bar)), first) !== "cursor") return canonicalText(key);
  return textCursor(contract, key, () => keyIdOfText(contract, key));
}

/**
 * A text of a family whose lane is cursors as its cursor, converted at its first question by `convert`, charged, and
 * kept by its text: a text asked again, as a consumer's reads ask theirs at each question, is found, never converted.
 */
function textCursor(contract: Contract, text: Key, convertIt: () => KeyId): KeyId {
  let id = contract.textCursors.get(text);
  if (id === undefined) {
    id = convertIt();
    contract.keepText(text.length);
    contract.textCursors.set(text, id);
  }
  return id;
}

/**
 * A literal's rest in its identity (the `cl|` demand's name): an array asked of a wrapper family's own declaration
 * literal is its cursor's span, its family's key converted once and kept by its text (`textCursor`); any other rest, a
 * span among them, stands as asked.
 */
export function canonicalRest(contract: Contract, literal: PlaceId, rest: Rest): Rest {
  // (an array or a view of one: a span stands as asked)
  const steps = isSteps(rest) ? rest : rest.kind === "steps" ? rest.steps() : null;
  if (steps === null || steps.length === 0) return rest;
  const d = (contract.pass.definitions.byValue.get(literal) ?? []).find(
    (each) => each.how === "initializer" && each.kind === "whole" && each.path.length === 0,
  );
  if (d === undefined || keyLane(contract, d.place, steps.at(0)!) !== "cursor") return rest;
  // (a record's steps their own path's span: the cursor's path is the path they spell, kept by its key's text as an
  // array's is, for the keys asked by text)
  if (isPathSteps(steps)) {
    textCursor(contract, keyOfText(d.place, steps.text()), () => keyIdAt(d.place, steps.path));
    return spanRef(contract, steps.path);
  }
  // (a member chain asks one literal and rest again at every level: its key's text found, never converted again)
  const key = keyOf(d.place, steps);
  return spanRef(
    contract,
    keyIdPath(textCursor(contract, key, () => keyIdOf(contract, d.place, steps))),
  );
}

/**
 * The id of the path of `path`'s steps from its step `from` on (a span's own path: `q.r.s` from 1 is `r.s`), found down
 * from the nearest of its ancestors whose span from `from` is known, each one step below its parent's (`pathAt`), its
 * visit and entry charged and kept: so the spans of one offset of k nested paths cost k steps, never k² (G3 stage 1).
 */
function spanId(contract: Contract, path: number, from: number): number {
  if (from === 0) return path;
  const { pathDepths: depths, pathParents: parents, pathLastSteps: steps } = contract;
  const known = (node: number): number | undefined =>
    contract.pathFacts.get(node)?.spans?.get(from);
  const way: number[] = [];
  let at = path;
  for (; depths[at]! > from && known(at) === undefined; at = parents[at]!) way.push(at);
  let id = depths[at]! <= from ? 0 : known(at)!;
  convert(contract, way.length + 1, 0, way.length);
  for (let index = way.length - 1; index >= 0; index -= 1) {
    id = pathAt(contract, id, steps[way[index]!]!);
    (factsOf(contract, way[index]!).spans ??= new Map()).set(from, id);
  }
  return id;
}

/** The id of `path`'s span from `from` on where `spanId` has found it, else `undefined`: it finds none. */
function spanMade(contract: Contract, path: number, from: number): number | undefined {
  return from === 0 ? path : contract.pathFacts.get(path)?.spans?.get(from);
}

/**
 * The id of the prefix of `path` of `length` steps (`length` at most its depth): from its path's prefixes where they
 * are kept (`prefixesOf`), else found from the nearest of its ancestors whose prefix of that length is kept (each
 * node's `prefixAt`), each node on the way kept and charged as `spanId`'s: so the prefixes of one length of k nested
 * paths cost k steps, never k².
 */
export function prefixId(contract: Contract, path: number, length: number): number {
  const { pathDepths: depths, pathParents: parents } = contract;
  if (depths[path]! <= length) return path;
  const whole = contract.pathFacts.get(path)?.prefixes;
  if (whole !== undefined) {
    convert(contract, 1, 0, 0);
    return whole[length]!;
  }
  const known = (node: number): number | undefined =>
    contract.pathFacts.get(node)?.prefixAt?.get(length);
  const way: number[] = [];
  let at = path;
  for (; depths[at]! > length && known(at) === undefined; at = parents[at]!) way.push(at);
  const id = depths[at]! === length ? at : known(at)!;
  convert(contract, way.length + 1, 0, way.length);
  for (const node of way) (factsOf(contract, node).prefixAt ??= new Map()).set(length, id);
  return id;
}

/**
 * The id of the path of `base`'s steps followed by `rest`'s (`joinSteps` of the two), found down from the nearest of
 * `rest`'s ancestors whose join with `base` is known (`base`'s facts), one step each, charged and kept as `spanId`'s.
 */
function joinedId(contract: Contract, base: number, rest: number): number {
  if (base === 0) return rest;
  const { pathParents: parents, pathLastSteps: steps } = contract;
  const byRest = (factsOf(contract, base).joined ??= new Map());
  const way: number[] = [];
  let at = rest;
  for (; at !== 0 && !byRest.has(at); at = parents[at]!) way.push(at);
  let id = at === 0 ? base : byRest.get(at)!;
  convert(contract, way.length + 1, 0, way.length);
  for (let index = way.length - 1; index >= 0; index -= 1) {
    id = pathAt(contract, id, steps[way[index]!]!);
    byRest.set(way[index]!, id);
  }
  return id;
}

/**
 * A path a decision reads below a key (G3 stage 1): a legacy array of steps, read as before, or a span of the arena (a
 * decided cursor's path from one of its steps on), read one step at a time from its spans' paths (`spanId`), its steps
 * never made but at the charged boundary (`steps`). A decided cursor's scan reads its paths so, never an array per
 * prefix.
 */
export interface PathRef extends Iterable<string> {
  /** An array's steps, or a span of the arena. */
  readonly kind: "steps" | "span";
  readonly length: number;
  /** The step at `index`. */
  at(index: number): string;
  /**
   * The step at `index`, read making no path or span id (a read's selection, TABLE r4.262): an array's as `at`, a span's
   * from its steps, made once per view at the charged boundary (`steps`).
   */
  read(index: number): string;
  /**
   * Its path's id where made already, else `undefined`, making none: a span's own where found (`spanId`'s entries), a
   * record's where found (`PathSteps.made`); a plain array's `undefined` (its walk looks its prefixes up, `pathBelow`).
   */
  made(): number | undefined;
  /** The steps from `from` on, a view. */
  from(from: number): PathRef;
  /** Its first `length` steps, a view. */
  to(length: number): PathRef;
  /** Its steps made: an array's itself; a span's through the charged boundary (`stepsOfId`), a record's. */
  steps(): PathSteps | readonly string[];
  /** The text of its first `length` steps (`pathText`), made. */
  text(length: number): string;
  /** Its path's id in the arena: a span's own (`spanId`); an array's by its steps (`pathIdOf`, as before). */
  id(): number;
  /** A short name for a memo: an array's text, a span's id after a dot (no path's text starts with one). */
  name(): string;
  /** The steps of `strip`, then its own (`joinSteps`). */
  after(strip: readonly string[]): PathRef;
  /** It as a composite key's part (`joinParts`): an array's steps, a span's name. */
  part(): readonly string[] | string;
}

/** A path as a legacy site passes it, an array of steps, or as a cursor's scan does, a `PathRef`. */
export type Rest = readonly string[] | PathRef;

/** A `Rest` as a `PathRef`. */
export function restRef(contract: Contract, rest: Rest): PathRef {
  return isRef(rest) ? rest : arrayRef(contract, rest);
}

function isRef(rest: Rest): rest is PathRef {
  return !isSteps(rest);
}

/** Whether a `Rest` is an array of steps. */
export function isSteps(rest: Rest): rest is readonly string[] {
  return Array.isArray(rest);
}

/** Whether a demand name's token is a cursor (`place#id`). */
function isCursorToken(token: string): token is KeyId {
  return CURSOR.test(token);
}

/** A `Rest`'s steps: an array as it is, a `PathRef`'s made (a span's through the charged boundary). */
export function restSteps(rest: Rest): PathSteps | readonly string[] {
  return isRef(rest) ? rest.steps() : rest;
}

/** A `Rest`'s first `length` steps: an array's sliced as before, a view's its own (`PathRef.to`). */
export function restTo(contract: Contract, rest: Rest, length: number): Rest {
  if (isSteps(rest)) return length >= rest.length ? rest : rest.slice(0, length);
  return restRef(contract, rest).to(length);
}

/** A `Rest` from step `from` on: an array's sliced as before, a view's its own (`PathRef.from`). */
export function restFrom(rest: Rest, from: number): Rest {
  if (isSteps(rest)) return from === 0 ? rest : rest.slice(from);
  return rest.from(from);
}

/** Whether a step of a `Rest` satisfies `test`, read by position. */
export function someStepOf(rest: Rest, test: (step: string) => boolean): boolean {
  for (let index = 0; index < rest.length; index += 1) if (test(rest.at(index)!)) return true;
  return false;
}

/** A `Rest` as a composite key's part (`joinParts`): an array's steps, a span's name. */
export function restPart(rest: Rest): readonly string[] | string {
  return isRef(rest) ? rest.part() : rest;
}

/**
 * The key of `place` at `rest` in its family's identity: below a cursor's family the cursor of its path's id, a visit
 * charged (a span's path its own, `spanId`, never its steps); else as `keyAt` makes it from the steps.
 */
export function keyAtRef(contract: Contract, place: PlaceId, rest: Rest): CanonicalKey {
  return keyAtRefWith(contract, place, rest, false);
}

/** `keyAtRef`, a text charged before it is made (`keptKey`). */
export function keptKeyAtRef(contract: Contract, place: PlaceId, rest: Rest): CanonicalKey {
  return keyAtRefWith(contract, place, rest, true);
}

function keyAtRefWith(contract: Contract, place: PlaceId, rest: Rest, kept: boolean): CanonicalKey {
  const ref = restRef(contract, rest);
  if (ref.kind === "span" && ref.length > 0 && keyLane(contract, place, ref.at(0)) === "cursor") {
    convert(contract, 1, 0, 0);
    return keyIdAt(place, ref.id());
  }
  return keyAtWith(contract, place, ref.steps(), kept);
}

/** The key `rest` below `key` in its identity: a span below a cursor or a cursor family's root, by path ids alone. */
export function keyBelowRef(contract: Contract, key: Key, rest: Rest): CanonicalKey {
  return keyBelowRefWith(contract, key, rest, false);
}

function keyBelowRefWith(contract: Contract, key: Key, rest: Rest, kept: boolean): CanonicalKey {
  const ref = restRef(contract, rest);
  if (ref.length === 0) return canonicalKey(contract, key);
  if (ref.kind === "span") {
    if (isKeyId(key)) {
      convert(contract, 1, 0, 0);
      return keyIdAt(keyIdPlace(key), joinedId(contract, keyIdPath(key), ref.id()));
    }
    if (key.endsWith("|")) return keyAtRefWith(contract, keyPlace(key), ref, kept);
  }
  return keyBelowWith(contract, key, ref.steps(), kept);
}

/** An array as a `PathRef`, read as the legacy sites read it. */
export function arrayRef(contract: Contract, steps: Steps): PathRef {
  // (each view made as the legacy sites made it: a slice or a join of the steps, plain, uncharged as before; a record's
  // steps their own views, spelled by their record)
  const view = (made: Steps): PathRef => arrayRef(contract, made);
  const below = (from: number): PathRef => view(stepsFrom(steps, from));
  const above = (length: number): PathRef => view(stepsTo(steps, length));
  const text = (length: number): string =>
    length === steps.length ? stepsText(steps) : stepsPrefixText(steps, length);
  const after = (strip: readonly string[]): PathRef =>
    strip.length === 0 ? view(steps) : view(stepsJoin(strip, steps));
  const id = (): number => {
    if (isPathSteps(steps)) return steps.path;
    let at = 0;
    for (const step of steps) at = pathAt(contract, at, step);
    return at;
  };
  return {
    kind: "steps",
    length: steps.length,
    at: (index) => steps.at(index)!,
    read: (index) => steps.at(index)!,
    made: () => (isPathSteps(steps) ? steps.made : undefined),
    from: below,
    to: above,
    steps: () => steps,
    text,
    id,
    name: () => stepsText(steps),
    after,
    part: () => (isPathSteps(steps) ? steps.text() : steps),
    *[Symbol.iterator]() {
      for (let index = 0; index < steps.length; index += 1) yield steps.at(index)!;
    },
  };
}

/** The span of the arena's path `path` from its step `from` on, as a `PathRef`. */
export function spanRef(contract: Contract, path: number, from = 0): PathRef {
  const length = contract.pathDepths[path]! - from;
  // (its own path's id, found once per view: `spanId`)
  let own: number | undefined;
  const ownId = (): number => (own ??= spanId(contract, path, from));
  // (its steps for a read that makes no id, made once per view: `stepsOfId`)
  let kept: PathSteps | undefined;
  const ref: PathRef = {
    kind: "span",
    length,
    // (a step its span's first: the span's id kept per offset in its path's facts, shared by the paths below it)
    at: (index) =>
      contract.pathFirstSteps[index === 0 ? ownId() : spanId(contract, path, from + index)]!,
    read: (index) => (kept ??= stepsOfId(contract, keyIdAt(0, path), from)).at(index)!,
    made: () => own ?? spanMade(contract, path, from),
    from: (more) => (more === 0 ? ref : spanRef(contract, path, from + more)),
    to: (count) => (count >= length ? ref : spanRef(contract, prefixId(contract, ownId(), count))),
    steps: () => stepsOfId(contract, keyIdAt(0, path), from),
    // (the text kept on its prefix's own path: each a visit found again)
    text: (count) => (count === 0 ? "" : textOf(contract, prefixId(contract, ownId(), count))),
    id: ownId,
    name: () => `.${ownId()}`,
    after: (strip) => {
      if (strip.length === 0) return ref;
      convert(contract, strip.length, 0, 0);
      let base = 0;
      for (const step of strip) base = pathAt(contract, base, step);
      return spanRef(contract, joinedId(contract, base, ownId()));
    },
    part: () => ref.name(),
    // (one step at a time, as far as the reader goes)
    *[Symbol.iterator]() {
      for (let index = 0; index < length; index += 1) yield ref.at(index);
    },
  };
  return ref;
}

/** A path's steps as text (`pathText`), made once per path from its kept steps, its text kept; found again at one visit. */
function textOf(contract: Contract, path: number): string {
  if (path === 0) return "";
  const facts = factsOf(contract, path);
  if (facts.text !== undefined) {
    convert(contract, 1, 0, 0);
    return facts.text;
  }
  // (a path's text made here alone: no text builder takes a record's steps, `PathSteps`)
  const text = pathText(ownSteps(stepsOfId(contract, keyIdAt(0, path))));
  contract.keepText(text.length);
  facts.text = text;
  return text;
}

/**
 * The one charged boundary of the cursors (TABLE r4.196): `visits` arena nodes or steps it inspects, a node already
 * made too, and `read` code units of text it scans, a unit per eight (`invSteps`), and `entries` it keeps (a unit each);
 * the texts and arrays it makes, through the kept helpers (`keptKey`, `keptArray`, TABLE r4.58). Each conversion is
 * the asking demand's own work, never a shared build's or work apart; what it makes is kept per id, never per prefix.
 * A label's rendering (`labelText`) is charged here too.
 */
export function convert(contract: Contract, visits: number, read: number, entries: number): void {
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
 * The steps of a cursor's path from its step `from` on (a span: `from` 0 the whole path), made and charged once per
 * path and offset and kept in the path's facts: a suffix from the path's kept steps where they are, else by a walk of
 * the span alone.
 */
export function stepsOfId(contract: Contract, id: KeyId, from = 0): PathSteps {
  const path = keyIdPath(id);
  const depth = contract.pathDepths[path]!;
  if (!Number.isInteger(from) || from < 0 || from > depth)
    throw new RangeError(`A path of ${depth} steps has no step ${from}.`);
  const facts = factsOf(contract, path);
  const known = from === 0 ? facts.steps : facts.suffixes?.get(from);
  if (known !== undefined) {
    convert(contract, 1, 0, 0);
    return known;
  }
  let steps: PathSteps;
  if (from > 0 && facts.steps !== undefined) {
    // (a suffix of a path whose steps are kept: from them, once per offset)
    convert(contract, 1, 0, 1);
    steps = kept(contract, path, from, ownSteps(facts.steps).slice(from));
  } else {
    // (the span's nodes and the one it ends at, an empty span's endpoint too)
    convert(contract, depth - from + 1, 0, 1);
    const made: string[] = [];
    for (let at = path; contract.pathDepths[at]! > from; at = contract.pathParents[at]!)
      made.push(contract.pathLastSteps[at]!);
    made.reverse();
    steps = kept(contract, path, from, made);
  }
  if (from === 0) facts.steps = steps;
  else (facts.suffixes ??= new Map()).set(from, steps);
  return steps;
}

/** Each `PathSteps`' steps, read by this module alone: no other module can spell them; a view's those it views. */
const rawSteps = new WeakMap<PathSteps, readonly string[]>();

/** Where a view starts in the steps it views (`PathSteps`, set by its class alone). */
let offsetOf: (steps: PathSteps) => number;

/** Steps' own steps as an array, for this module's makers: a view's sliced from those it views. */
function ownSteps(steps: PathSteps): readonly string[] {
  const raw = rawSteps.get(steps)!;
  const start = offsetOf(steps);
  return start === 0 && steps.length === raw.length ? raw : raw.slice(start, start + steps.length);
}

/**
 * A path's steps as its record keeps them (G3 stage 1), opaque: read by position (`length`, `at`), spelled only by the
 * record (`text`, `prefixText`, `textOf`), and copied out only by `toArray`, a charged copy, each site's listed with its
 * reason (`tests/type-core-key-ids.test.ts`). Its views (`from`, `to`) read the steps they view in place, never a
 * copy; a view's path's id and text, found where asked (`spanId`, `prefixId`, `textOf`), are kept on the steps it views
 * by its offset and length (an entry), so the same view made again finds both free, as a span view's own id is. Its
 * joins (`stepsJoin`, `stepsAfter`) hold the steps a join of arrays held, made as plainly, their path the arena's join
 * where asked. No text builder takes one, so a path's text is made by its record alone.
 */
export class PathSteps {
  static {
    offsetOf = (steps) => steps.#offset;
  }
  readonly #contract: Contract;
  readonly length: number;
  #id: number | undefined;
  readonly #find: () => number;
  #text: string | undefined;
  /** The steps it is a view of (none: its own), and where in them it starts. */
  #of: PathSteps | null = null;
  readonly #offset: number;
  /** Its views' paths and texts by offset and length, each found once and kept: a view made again finds them free. */
  #views: Map<number, { readonly id: number; text?: string }> | undefined;
  /** Its own entry there, a view's. */
  #entry: { readonly id: number; text?: string } | undefined;
  constructor(
    contract: Contract,
    steps: readonly string[],
    id: number | (() => number),
    offset = 0,
    length = steps.length,
  ) {
    this.#contract = contract;
    this.#offset = offset;
    this.length = length;
    if (typeof id === "number") this.#id = id;
    this.#find = typeof id === "number" ? () => id : id;
    rawSteps.set(this, steps);
  }
  /** The step at `index`, none past its length. */
  at(index: number): string | undefined {
    return index >= 0 && index < this.length
      ? rawSteps.get(this)![this.#offset + index]
      : undefined;
  }
  /** The id of the path it spells, found once (`spanId`, `prefixId`, `joinedId`). */
  get path(): number {
    return (this.#id ??= this.#find());
  }
  /**
   * The id of the path it spells where found already, else `undefined`: it finds none. A view's is found once and kept on
   * the steps it views (`#view`), so a view made again finds it there.
   */
  get made(): number | undefined {
    if (this.#id !== undefined) return this.#id;
    const of = this.#of;
    return of === null
      ? undefined
      : of.#views?.get(this.#offset * (of.length + 1) + this.length)?.id;
  }
  /** Its text, through the record (`textOf`), found once. */
  text(): string {
    if (this.#text !== undefined) return this.#text;
    const path = this.path;
    const entry = this.#entry;
    this.#text = entry?.text ?? textOf(this.#contract, path);
    if (entry !== undefined) entry.text = this.#text;
    return this.#text;
  }
  /** The text of its first `length` steps, through the record (`textOf` of its prefix's path). */
  prefixText(length: number): string {
    return length === 0 ? "" : textOf(this.#contract, prefixId(this.#contract, this.path, length));
  }
  /** Its steps from `more` on, a view. */
  from(more: number): PathSteps {
    return more === 0 ? this : this.#view(this.#offset + more, this.length - more);
  }
  /** Its first `count` steps, a view. */
  to(count: number): PathSteps {
    return count >= this.length ? this : this.#view(this.#offset, count);
  }
  /**
   * A view of the steps it is one of, `length` from `offset`, read in place: its path the span (`spanId`) and prefix
   * (`prefixId`) of theirs, found where asked and kept on them (an entry).
   */
  #view(offset: number, length: number): PathSteps {
    const of = this.#of ?? this;
    const contract = this.#contract;
    const key = offset * (of.length + 1) + length;
    const find = (): number => {
      let entry = of.#views?.get(key);
      if (entry === undefined) {
        const from = offset === 0 ? of.path : spanId(contract, of.path, offset);
        entry = { id: offset + length === of.length ? from : prefixId(contract, from, length) };
        (of.#views ??= new Map()).set(key, entry);
        contract.keep(1);
      }
      view.#entry = entry;
      return entry.id;
    };
    const view = new PathSteps(contract, rawSteps.get(of)!, find, offset, length);
    view.#of = of;
    return view;
  }
  /** Its steps followed by `then`'s: their path the arena's join (`joinedId`) where asked. */
  followedBy(then: Steps): PathSteps {
    if (then.length === 0) return this;
    const made = joinSteps(ownSteps(this), isPathSteps(then) ? ownSteps(then) : then);
    return new PathSteps(this.#contract, made, () =>
      joinedId(this.#contract, this.path, idOf(this.#contract, then)),
    );
  }
  /** `strip`'s steps followed by its own: their path the arena's join (`joinedId`) where asked. */
  after(strip: readonly string[]): PathSteps {
    if (strip.length === 0) return this;
    return new PathSteps(this.#contract, joinSteps(strip, ownSteps(this)), () =>
      joinedId(this.#contract, idOf(this.#contract, strip), this.path),
    );
  }
  /** It as a `Rest`, read as an array's steps are (`arrayRef`): views, never a copy. */
  rest(): PathRef {
    return arrayRef(this.#contract, this);
  }
  /** A copy as an array, for a site that keeps or hands on one: charged as a kept array. */
  toArray(): readonly string[] {
    convert(this.#contract, 1, 0, 0);
    return keptArray(this.#contract.work, [...ownSteps(this)]);
  }
}

/** The id of the path of steps: a record's its own (`PathSteps.path`); an array's each step inspected and charged. */
function idOf(contract: Contract, steps: Steps): number {
  if (isPathSteps(steps)) return steps.path;
  convert(contract, steps.length, 0, 0);
  let id = 0;
  for (const step of steps) id = pathAt(contract, id, step);
  return id;
}

/** A path's steps as a site reads them: a record's (`PathSteps`) or a legacy array. */
export type Steps = PathSteps | readonly string[];

/** Whether steps are a record's. */
export function isPathSteps(steps: Steps): steps is PathSteps {
  return steps instanceof PathSteps;
}

/** Steps' first `length` steps' text: a record's through its record, an array's made plain, as the legacy sites made it. */
export function stepsPrefixText(steps: Steps, length: number): string {
  return isPathSteps(steps) ? steps.prefixText(length) : pathText(steps.slice(0, length));
}

/** Steps' text: a record's through its record (`textOf`), an array's made plain (`pathText`), as the legacy sites made it. */
export function stepsText(steps: Steps): string {
  return isPathSteps(steps) ? steps.text() : pathText(steps);
}

/** Steps from step `from` on: a record's its view (`PathSteps.from`), an array's sliced as before. */
export function stepsFrom(steps: Steps, from: number): Steps {
  return isPathSteps(steps) ? steps.from(from) : from === 0 ? steps : steps.slice(from);
}

/** Steps' first `length`: a record's its view (`PathSteps.to`), an array's sliced as before. */
export function stepsTo(steps: Steps, length: number): Steps {
  return isPathSteps(steps)
    ? steps.to(length)
    : length >= steps.length
      ? steps
      : steps.slice(0, length);
}

/** The index of `step` in steps, or -1, read by position. */
export function stepIndex(steps: Steps, step: string): number {
  for (let index = 0; index < steps.length; index += 1) if (steps.at(index) === step) return index;
  return -1;
}

/** Whether a step of steps satisfies `test`, read by position. */
export function someStep(steps: Steps, test: (step: string) => boolean): boolean {
  for (let index = 0; index < steps.length; index += 1) if (test(steps.at(index)!)) return true;
  return false;
}

/** Steps as a `Rest`: a record's read as an array's steps are (`PathSteps.rest`); an array as it is. */
export function stepsRest(steps: Steps): Rest {
  return isPathSteps(steps) ? steps.rest() : steps;
}

/** Steps followed by others: a record's joined (`PathSteps.followedBy`, `after`), arrays as before (`joinSteps`). */
export function stepsJoin(first: Steps, then: Steps): Steps {
  if (isPathSteps(first)) return first.followedBy(then);
  return isPathSteps(then) ? then.after(first) : joinSteps(first, then);
}

/** `stepsFrom`, charged before it is made, as `keptSlice` charges an array's slice. */
export function keptStepsFrom(work: WorkLedger, steps: Steps, from: number): Steps {
  if (!isPathSteps(steps)) return keptSlice(work, steps, from);
  const view = steps.from(from);
  keptArray(work, ownSteps(view));
  return view;
}

/** `stepsJoin`, charged before it is made, as `keptSteps` charges an array's join. */
export function keptStepsJoin(work: WorkLedger, first: Steps, then: Steps): Steps {
  if (!isPathSteps(first) && !isPathSteps(then)) return keptSteps(work, first, then);
  const joined = stepsJoin(first, then);
  if (isPathSteps(joined)) keptArray(work, ownSteps(joined));
  return joined;
}

/** `strip`'s steps, then steps', as a `Rest`: a record's joined (`PathSteps.after`), an array's as before. */
export function stepsAfter(strip: readonly string[], steps: Steps): Rest {
  return isPathSteps(steps) ? steps.after(strip).rest() : joinSteps(strip, steps);
}

/** Steps as an array, for a site that needs one: a record's copied out (`PathSteps.toArray`, counted), an array as it is. */
export function stepsArray(steps: Steps): readonly string[] {
  return isPathSteps(steps) ? steps.toArray() : steps;
}

/** Steps kept in a path's record, charged as kept (`keptArray`): a record's own, its path's span from `from` on. */
function kept(contract: Contract, path: number, from: number, steps: readonly string[]): PathSteps {
  keptArray(contract.work, steps);
  return new PathSteps(contract, steps, from === 0 ? path : () => spanId(contract, path, from));
}

/**
 * `memberStep`: the first step of `path` from `from` on that a built-in value answers, its scan charged by the text it
 * reads, a unit per eight code units (TABLE r4.58; it keeps nothing, so no text's header), so a long member chain of
 * long names reaches the allowance by its own work.
 */
export function memberStepOf(contract: Contract, path: Steps, from: number): number {
  const at = memberStep(path, from);
  let length = 0;
  for (let index = from, end = at < 0 ? path.length : at + 1; index < end; index += 1)
    length += path.at(index)!.length + 1;
  contract.pass.program.work.charge("invSteps", length >> 3);
  return at;
}

/**
 * `memberStepOf` for a cursor: -1 at one visit where the nearest member step at or above it (`pathMembers`) is not
 * below `from`; else its path's steps, made once per path and kept (`stepsOfId`), scanned from `from` as the legacy
 * lane scans a text's, so a question at each of a path's offsets inspects only its own scan's steps.
 */
export function memberStepIn(contract: Contract, id: KeyId, from = 0): number {
  const nearest = contract.pathMembers[keyIdPath(id)]!;
  if (nearest === 0 || contract.pathDepths[nearest]! <= from) {
    convert(contract, 1, 0, 0);
    return -1;
  }
  return memberStepOf(contract, stepsOfId(contract, id), from);
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
  return compareSteps(
    contract,
    contract.pathLastSteps[belowX]!,
    belowX !== pathA,
    contract.pathLastSteps[belowY]!,
    belowY !== pathB,
  );
}

/**
 * Two distinct steps below one path in the order of their keys' texts, compared in place, no text made: each text goes
 * on with a dot where its path goes deeper (`more`), else ends, and a step holds no dot, so the texts part at or before
 * the shorter step's end; the code units scanned charged.
 */
function compareSteps(
  contract: Contract,
  x: string,
  moreX: boolean,
  y: string,
  moreY: boolean,
): number {
  let at = 0;
  while (at < x.length && at < y.length && x.charCodeAt(at) === y.charCodeAt(at)) at += 1;
  convert(contract, 0, at + 1, 0);
  if (at < x.length && at < y.length) return x.charCodeAt(at) < y.charCodeAt(at) ? -1 : 1;
  // (one step ends here: its text's next code unit is a dot, or none, which sorts first)
  const dot = 46;
  if (at === x.length) return !moreX || dot < y.charCodeAt(at) ? -1 : 1;
  return !moreY || dot < x.charCodeAt(at) ? 1 : -1;
}

/** A cursor token of a demand's name (`place#id`), and a span's name (`.id`, `PathRef.name`). */
const CURSOR = /^\d+#\d+$/;
const SPAN = /^\.\d+$/;

/**
 * Two demands' names in the order of their logical texts (#1398, the solver's `canonical`): a name holding a cursor
 * (`place#id`) or a span's name (`.id`) compares as the name its key's text or its path's would make, made through the
 * charged boundary once per name (`keyOfId`, `stepsOfId`) and kept, never by its ids; any other name as itself.
 */
export function compareDemandNames(contract: Contract, a: string, b: string): number {
  if (a === b) return 0;
  const [x, y] = [logicalName(contract, a), logicalName(contract, b)];
  return x < y ? -1 : x > y ? 1 : 0;
}

function logicalName(contract: Contract, name: string): string {
  if (!name.includes("#") && !name.includes("|.")) return name;
  const known = contract.logicalNames.get(name);
  if (known !== undefined) return known;
  const tokens = name.split("|");
  if (!tokens.some((token) => CURSOR.test(token) || SPAN.test(token))) return name;
  const text = tokens
    .map((token) =>
      isCursorToken(token)
        ? keyOfId(contract, token)
        : SPAN.test(token)
          ? textOf(contract, Number(token.slice(1)))
          : token,
    )
    .join("|");
  convert(contract, 0, 0, 1);
  contract.keepText(text.length);
  contract.logicalNames.set(name, text);
  return text;
}

/**
 * Demands' names as another pass replays them (#1422 B1, `solveDemands`): each cursor's and span's token replaced by
 * its index in one packet of their paths (`exportKeyIds`), made while this pass holds them, never their ids; `null`
 * where no name holds one.
 */
export function exportNames(
  contract: Contract,
  names: readonly string[],
): { readonly names: readonly string[]; readonly packet: KeyPacket } | null {
  const ids: KeyId[] = [];
  const index = new Map<string, number>();
  const token = (part: string): string => {
    const cursor = isCursorToken(part) ? part : null;
    if (cursor === null && !SPAN.test(part)) return part;
    let at = index.get(part);
    if (at === undefined) {
      index.set(part, (at = ids.length));
      ids.push(cursor ?? keyIdAt(0, Number(part.slice(1))));
    }
    return cursor !== null ? `${keyIdPlace(cursor)}#${at}` : `.${at}`;
  };
  const made = names.map((name) => name.split("|").map(token).join("|"));
  return ids.length === 0 ? null : { names: made, packet: exportKeyIds(contract, ids) };
}

/**
 * Names a packet came with (`exportNames`) in this pass: its paths made here, parent first (`importKeyIds`), each
 * cursor's token its key's text and each span's its path's, so this pass asks each demand in its own identity; a layer
 * summary's (`protoLayer|`, #1466) keeps them as this pass's cursor and span, the tokens its demand is named by.
 */
export function importNames(
  contract: Contract,
  names: readonly string[],
  packet: unknown,
): string[] {
  const ids = importKeyIds(contract, packet);
  return names.map((name) => {
    const native = name.startsWith("protoLayer|");
    return name
      .split("|")
      .map((part) => {
        if (isCursorToken(part)) {
          const id = ids[keyIdPath(part)]!;
          return native ? id : keyOfId(contract, id);
        }
        if (!SPAN.test(part)) return part;
        const path = keyIdPath(ids[Number(part.slice(1))]!);
        return native ? spanRef(contract, path).name() : textOf(contract, path);
      })
      .join("|");
  });
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
  const packet = keyPacket();
  for (const id of ids) appendKeyId(contract, packet, id);
  return packet;
}

/** A packet made one cursor at a time (`appendKeyId`), its nodes' indexes by path id kept with it. */
export interface KeyPacketMaking extends KeyPacket {
  readonly index: Map<number, number>;
  readonly nodes: (readonly [number, string])[];
  readonly keys: (readonly [PlaceId, number])[];
}

export function keyPacket(): KeyPacketMaking {
  return { index: new Map([[0, -1]]), nodes: [], keys: [] };
}

/**
 * One cursor more in a packet (`exportKeyIds`): its path's nodes not in it yet, parent first, each node and the key an
 * entry charged; its key's index in the packet.
 */
export function appendKeyId(contract: Contract, packet: KeyPacketMaking, id: KeyId): number {
  const { index, nodes, keys } = packet;
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
  return keys.length - 1;
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
