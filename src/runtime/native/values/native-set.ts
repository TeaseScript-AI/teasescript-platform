import type { SerializableRuntimeScalar } from "../../values/serializable-values.js";
import { NativeSet, type NativeSetMembership, type NativeValue } from "./native-value.js";
import { nativeValueKey } from "./value-key.js";

// The members of a `NativeSet`: the only module that changes its `items` and its `membership`. Finding a member keys
// only that member (its primitive, or `nativeValueKey`), never compares it with every other member.

/** Keys up to this long are kept as they are; a longer key is kept as its hash, so a member's key has a bounded size. */
const EXACT_KEY_LENGTH = 32;

/** A set of the given items, keeping the first of equal (`==`) items. The items are taken as they are, not copied. */
export function nativeSetOf(items: readonly NativeValue[]): NativeSet {
  const set = new NativeSet();
  for (const item of items) nativeSetAdd(set, item);
  return set;
}

/** Whether the set has a member equal (`==`) to `value`. */
export function nativeSetHas(set: NativeSet, value: NativeValue): boolean {
  const known = membership(set);
  if (isScalar(value)) return known.scalars.has(value);
  return memberOf(known, value) !== undefined;
}

/**
 * Adds `value` as it is, not a copy, unless the set has an equal (`==`) member; returns whether it did. The caller gives
 * a value that nothing else holds, as `NativeValue`'s ownership rule asks.
 */
export function nativeSetAdd(set: NativeSet, value: NativeValue): boolean {
  const known = membership(set);
  if (isScalar(value)) {
    if (known.scalars.has(value)) return false;
    known.scalars.add(value);
  } else {
    const { key, whole } = memberKey(value);
    const bucket = known.keyed.get(key);
    if (bucket === undefined) known.keyed.set(key, [value]);
    else if (whole === null || bucket.some((item) => nativeValueKey(item) === whole)) return false;
    else bucket.push(value);
  }
  set.items.push(value);
  return true;
}

/** Removes the member equal (`==`) to `value`; later members move up. Returns whether there was one. */
export function nativeSetRemove(set: NativeSet, value: NativeValue): boolean {
  const known = membership(set);
  let member: NativeValue;
  if (isScalar(value)) {
    if (!known.scalars.delete(value)) return false;
    // `indexOf` compares by `===`, under which `-0` is `0`, as a member and `value` are equal.
    member = value;
  } else {
    const { key, whole } = memberKey(value);
    const bucket = known.keyed.get(key);
    const at =
      bucket === undefined
        ? -1
        : whole === null
          ? 0
          : bucket.findIndex((item) => nativeValueKey(item) === whole);
    if (at === -1) return false;
    member = bucket![at]!;
    if (bucket!.length === 1) known.keyed.delete(key);
    else bucket!.splice(at, 1);
  }
  const position = set.items.indexOf(member);
  // An indexed member is always among the items; a primitive `indexOf` cannot find (`NaN`) is no valid value.
  if (position === -1) throw new Error("A set's index holds a member its items do not.");
  set.items.splice(position, 1);
  return true;
}

/**
 * Appends a member to a set whose index is not built yet, such as one a conversion or a copy is filling. It checks only
 * that no index exists: the caller knows the member differs (`==`) from those before it, as the members of a valid set
 * do. A set whose index exists takes members only through `nativeSetAdd`.
 */
export function appendToUnindexedSet(set: NativeSet, member: NativeValue): void {
  if (set.membership !== null)
    throw new Error("A set with an index takes members through nativeSetAdd.");
  set.items.push(member);
}

/** Removes every member. */
export function nativeSetClear(set: NativeSet): void {
  set.items.length = 0;
  set.membership = null;
}

function membership(set: NativeSet): NativeSetMembership {
  if (set.membership !== null) return set.membership;
  const built: NativeSetMembership = { scalars: new Set(), keyed: new Map() };
  for (const item of set.items) {
    if (isScalar(item)) built.scalars.add(item);
    else {
      const { key } = memberKey(item);
      const bucket = built.keyed.get(key);
      if (bucket === undefined) built.keyed.set(key, [item]);
      else bucket.push(item);
    }
  }
  set.membership = built;
  return built;
}

/** The member equal to `value`, a value that is not a primitive. */
function memberOf(known: NativeSetMembership, value: NativeValue): NativeValue | undefined {
  const { key, whole } = memberKey(value);
  const bucket = known.keyed.get(key);
  if (bucket === undefined) return undefined;
  return whole === null ? bucket[0] : bucket.find((item) => nativeValueKey(item) === whole);
}

/**
 * A member's key in `keyed`: its whole `nativeValueKey` when that is short, else `#` and a hash of it, with the whole
 * key in `whole` to tell apart members whose hashes collide. No `nativeValueKey` starts with `#`.
 */
function memberKey(value: NativeValue): { readonly key: string; readonly whole: string | null } {
  const whole = nativeValueKey(value);
  return whole.length <= EXACT_KEY_LENGTH
    ? { key: whole, whole: null }
    : { key: `#${textHash(whole)}`, whole };
}

function isScalar(value: NativeValue): value is SerializableRuntimeScalar {
  return value === null || typeof value !== "object";
}

/** A 53-bit hash of a text (cyrb53). */
function textHash(text: string): number {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507);
  first ^= Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507);
  second ^= Math.imul(first ^ (first >>> 13), 3266489909);
  return 4294967296 * (2097151 & second) + (first >>> 0);
}
