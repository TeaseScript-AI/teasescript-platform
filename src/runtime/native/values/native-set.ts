import type { SerializableRuntimeScalar } from "../../values/serializable-values.js";
import type { NativeValue } from "./native-value.js";
import { nativeValueKey } from "./value-key.js";

/** Keys up to this long are kept as they are; a longer key is kept as its hash, so a member's key has a bounded size. */
const EXACT_KEY_LENGTH = 32;

/**
 * Unique members by `==`, in insertion order. Its storage is private: only these methods change it, and they keep the
 * index, once built, exact for the members. Lookups use the scalar index or one keyed bucket; hashed candidates are
 * re-keyed to resolve collisions. A member is never changed in place.
 */
export class NativeSet {
  public readonly kind = "set";
  readonly #items: NativeValue[] = [];
  /** The index of `#items`, built at the first operation that needs it; `null` until then and after a clear. */
  #membership: Membership | null = null;

  /** A set of the given items, keeping the first of equal (`==`) items. The items are taken as they are, not copied. */
  public static of(items: readonly NativeValue[]): NativeSet {
    const set = new NativeSet();
    for (const item of items) set.add(item);
    return set;
  }

  public get size(): number {
    return this.#items.length;
  }

  /** Iterates the members in insertion order without exposing the array that holds them. */
  public [Symbol.iterator](): IterableIterator<NativeValue> {
    return this.#items.values();
  }

  /** Whether the set has a member equal (`==`) to `value`. */
  public has(value: NativeValue): boolean {
    const known = this.#index();
    if (isScalar(value)) return known.scalars.has(value);
    return memberOf(known, value) !== undefined;
  }

  /**
   * Adds `value` as it is, not a copy, unless the set has an equal (`==`) member; returns whether it did. The caller
   * gives a value that nothing else holds, as `NativeValue`'s ownership rule asks.
   */
  public add(value: NativeValue): boolean {
    const known = this.#index();
    if (isScalar(value)) {
      if (known.scalars.has(value)) return false;
      known.scalars.add(value);
    } else {
      const { key, whole } = memberKey(value);
      const bucket = known.keyed.get(key);
      if (bucket === undefined) known.keyed.set(key, [value]);
      else if (whole === null || bucket.some((item) => nativeValueKey(item) === whole))
        return false;
      else bucket.push(value);
    }
    this.#items.push(value);
    return true;
  }

  /** Removes the member equal (`==`) to `value`; later members move up. Returns whether there was one. */
  public remove(value: NativeValue): boolean {
    const known = this.#index();
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
    const position = this.#items.indexOf(member);
    // An indexed member is always among the items; a primitive `indexOf` cannot find (`NaN`) is no valid value.
    if (position === -1) throw new Error("A set's index holds a member its items do not.");
    this.#items.splice(position, 1);
    return true;
  }

  /**
   * Appends a member to a set whose index is not built yet, such as one a conversion or a copy is filling. It checks
   * only that no index exists: the caller knows the member differs (`==`) from those before it, as the members of a
   * valid set do. A set whose index exists takes members only through `add`.
   */
  public appendUnindexed(member: NativeValue): void {
    if (this.#membership !== null)
      throw new Error("A set with an index takes members through add.");
    this.#items.push(member);
  }

  public clear(): void {
    this.#items.length = 0;
    this.#membership = null;
  }

  #index(): Membership {
    if (this.#membership !== null) return this.#membership;
    const built: Membership = { scalars: new Set(), keyed: new Map() };
    for (const item of this.#items) {
      if (isScalar(item)) built.scalars.add(item);
      else {
        const { key } = memberKey(item);
        const bucket = built.keyed.get(key);
        if (bucket === undefined) built.keyed.set(key, [item]);
        else bucket.push(item);
      }
    }
    this.#membership = built;
    return built;
  }
}

/**
 * A set's members by key: primitives as themselves (a `Set` compares `-0` and `0` as `==` does), every other member
 * under its key (`nativeValueKey`), or under a hash of a long key with the members whose keys share that hash.
 */
interface Membership {
  readonly scalars: Set<SerializableRuntimeScalar>;
  readonly keyed: Map<string, NativeValue[]>;
}

/** The member equal to `value`, a value that is not a primitive. */
function memberOf(known: Membership, value: NativeValue): NativeValue | undefined {
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
