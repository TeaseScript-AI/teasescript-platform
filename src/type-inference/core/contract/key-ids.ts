import type { PlaceId } from "../../graph.js";
import { keptArray, keptSplit, pathText } from "../budget.js";
import type { Contract } from "../contract.js";
import { cursors } from "../cursors.js";
import { keptParent, keptPathText, keyBelow, keyOf, keyPlace, type Key } from "../definitions.js";
import { pathAt, stepsOf } from "./literal-index.js";

// Path cursors: a key or path as an id in the path trie, and the id's parent, place, path and text.

/**
 * A key's cursor (`cursors.ts`): its place and its path's id (`pathAt`), the name of the demands of its contract
 * (`c|`, `cp|`, `rc|`) in place of its text, which a long key made again in each; its text inside `withTextKeys`.
 */
export function keyId(contract: Contract, key: Key): string {
  if (!cursors()) return key;
  const bar = key.indexOf("|");
  let id = 0;
  for (let at = bar + 1; at < key.length;) {
    const dot = key.indexOf(".", at);
    const end = dot < 0 ? key.length : dot;
    id = pathAt(contract, id, key.slice(at, end));
    at = end + 1;
  }
  return `${key.slice(0, bar)}#${id}`;
}

/** The cursor one `step` below a key's cursor (`keyId`); below a key's text, that text and the step. */
export function keyIdBelow(contract: Contract, id: string, step: string): string {
  const hash = id.indexOf("#");
  if (hash < 0) return keyBelow(id, [step]);
  return `${id.slice(0, hash)}#${pathAt(contract, Number(id.slice(hash + 1)), step)}`;
}

/** A path's cursor (`keyId`): its id on the path trie, its text inside `withTextKeys`. */
export function pathKey(contract: Contract, path: readonly string[]): string {
  return cursors() ? `#${contract.pathIdOf(path)}` : pathText(path);
}

/** A key's cursor's parent, one step up (`keyId`), `null` at a place's own key; a key's text's parent text. */
export function keyIdParent(contract: Contract, id: string): string | null {
  const hash = id.indexOf("#");
  if (hash < 0) return keptParent(contract.work, id);
  const path = Number(id.slice(hash + 1));
  return path === 0 ? null : `${id.slice(0, hash)}#${contract.pathParents[path]!}`;
}

/** A key cursor's place (`keyId`). */
export function keyIdPlace(id: string): PlaceId {
  const hash = id.indexOf("#");
  return hash < 0 ? keyPlace(id) : Number(id.slice(0, hash));
}

/** A key cursor's path's cursor (`pathKey`); a key text's path text. */
export function keyIdPath(contract: Contract, id: string): string {
  const hash = id.indexOf("#");
  return hash < 0 ? keptPathText(contract.work, id) : id.slice(hash);
}

/** A path cursor's steps (`pathKey`), made and kept; a path text's, split. */
export function pathOfKey(contract: Contract, key: string): readonly string[] {
  if (!key.startsWith("#")) return keptSplit(contract.work, key);
  return keptArray(contract.work, stepsOf(contract, Number(key.slice(1))));
}

/** A place's own key's cursor (`keyId`). */
export function rootId(place: PlaceId): string {
  return cursors() ? `${place}#0` : keyOf(place, []);
}

/** The key a cursor names (`keyId`); a key's text names itself. */
export function keyOfId(contract: Contract, id: string): Key {
  const hash = id.indexOf("#");
  if (hash < 0) return id;
  return keyOf(Number(id.slice(0, hash)), stepsOf(contract, Number(id.slice(hash + 1))));
}
