import { serializableEquals } from "../../values/serializable-values.js";
import {
  isNativeComposite,
  NativeDict,
  NativeObject,
  NativeSet,
  type NativeValue,
} from "./native-value.js";
import { nativeSetHas } from "./native-set.js";

/**
 * `==` on native values, as `serializableEquals` decides it for their canonical forms: lists compare in order; objects,
 * dicts and sets regardless of order; primitives by `===` (`-0` is `0`); leaf records by `serializableEquals`. Nested
 * values use an explicit stack, so deep values never exhaust the JavaScript call stack. Comparing two sets builds the
 * right one's index.
 */
export function nativeEquals(left: NativeValue, right: NativeValue): boolean {
  const pending: Array<readonly [NativeValue, NativeValue]> = [[left, right]];
  while (pending.length > 0) {
    const [a, b] = pending.pop()!;
    if (a === b) continue;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let index = 0; index < a.length; index += 1) {
        const item = a[index]!;
        const other = b[index]!;
        if (item === other) continue;
        if (typeof item !== "object" || item === null) return false;
        pending.push([item, other]);
      }
    } else if (a instanceof NativeObject) {
      if (!(b instanceof NativeObject) || !compareNamed(a.properties, b.properties, pending))
        return false;
    } else if (a instanceof NativeDict) {
      if (!(b instanceof NativeDict) || !compareNamed(a.entries, b.entries, pending)) return false;
    } else if (a instanceof NativeSet) {
      if (!(b instanceof NativeSet) || a.items.length !== b.items.length) return false;
      for (const item of a.items) if (!nativeSetHas(b, item)) return false;
    } else {
      if (isNativeComposite(b) || !serializableEquals(a, b)) return false;
    }
  }
  return true;
}

/** Whether two maps have the same names, queueing each pair of values under one name for comparison. */
function compareNamed(
  mine: ReadonlyMap<string, NativeValue>,
  theirs: ReadonlyMap<string, NativeValue>,
  pending: Array<readonly [NativeValue, NativeValue]>,
): boolean {
  if (mine.size !== theirs.size) return false;
  for (const [name, item] of mine) {
    if (!theirs.has(name)) return false;
    pending.push([item, theirs.get(name)!]);
  }
  return true;
}
