import {
  isNativeComposite,
  NativeDict,
  NativeObject,
  type NativeComposite,
  type NativeValue,
} from "./native-value.js";
import { NativeSet } from "./native-set.js";

/**
 * An independent copy of a value: every list, object, dict and set in it is new, and primitives and leaf records, which
 * nothing changes in place, are shared. A copied set builds its index again at its first operation. Deep values are
 * copied without recursion on the JavaScript call stack.
 */
export function copyNativeValue(value: NativeValue): NativeValue {
  if (!isNativeComposite(value)) return value;
  const root = emptyCopy(value);
  const work: Array<readonly [NativeComposite, NativeComposite]> = [[value, root]];
  // A nested list, object, dict or set gets an empty copy now, filled when its pair comes off `work`.
  const copyPart = (part: NativeValue): NativeValue => {
    if (!isNativeComposite(part)) return part;
    const copied = emptyCopy(part);
    work.push([part, copied]);
    return copied;
  };
  while (work.length > 0) {
    const [source, target] = work.pop()!;
    if (Array.isArray(source)) {
      // EVIDENCE: invariant: `emptyCopy` pairs each list with a new empty list.
      const items = target as NativeValue[];
      // Filled by `push`, so that the copy is a packed array, as fast to index as its source.
      for (let index = 0, length = source.length; index < length; index += 1)
        items.push(copyPart(source[index]!));
    } else if (source instanceof NativeSet) {
      // EVIDENCE: invariant: `emptyCopy` pairs each set with a new set; copies of unique members are unique.
      const set = target as NativeSet;
      for (const item of source.items) set.appendUnindexed(copyPart(item));
    } else {
      const from = source instanceof NativeObject ? source.properties : source.entries;
      // EVIDENCE: invariant: `emptyCopy` pairs each object with a new object and each dict with a new dict.
      const into =
        target instanceof NativeObject ? target.properties : (target as NativeDict).entries;
      for (const [name, part] of from) into.set(name, copyPart(part));
    }
  }
  return root;
}

/** A new empty list, object, dict or set of `value`'s kind. */
function emptyCopy(value: NativeComposite): NativeComposite {
  if (Array.isArray(value)) return [];
  if (value instanceof NativeObject) return new NativeObject();
  if (value instanceof NativeDict) return new NativeDict();
  return new NativeSet();
}
