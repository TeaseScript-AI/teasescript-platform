import type { PlaceId, TypeTerm } from "../../graph.js";
import type { Admission } from "../admission.js";
import { type Key } from "../definitions.js";
import {
  canonicalKey,
  keyAtRef,
  restRef,
  type CanonicalKey,
  type Rest,
} from "../contract/key-ids.js";
import type { Inheriting } from "../admission/model.js";
import { permittedAt } from "../admission/permitted.js";

// The decisions that wait on each other through copies (a union-find by key), and what a scan reads of an inherited type.

/**
 * What `from` inherits at `path` (`inheritedAt`) as a scan asks it: the key it waits on yielded, past the
 * deepest path a written type reaches its path's prefix there.
 */
function* inheritedSteps(
  admission: Admission,
  from: PlaceId,
  asked: Rest,
  own?: { value: boolean },
): Inheriting<TypeTerm | null> {
  // (a cursor's span read by its paths' ids: its key a cursor, its prefix and rest views, G3 stage 1)
  const { contract } = admission.pass;
  const path = restRef(contract, asked);
  if (path.length > admission.reach) {
    // (a prefix's type taken below it is never its copy's own level, #1901)
    const above = yield* inheritedSteps(admission, from, path.to(admission.reach));
    return above === null ? null : permittedAt(above, path.from(admission.reach));
  }
  const key = keyAtRef(contract, from, path);
  // EVIDENCE: invariant: a key yielded is resumed with its inherited type.
  const term = (yield key) as TypeTerm | null;
  // (#1901: whether its copy reads its written type at its own root, `Admission.inheritedOwn`, read at the key made
  // for the term, once it is resolved)
  if (own !== undefined) own.value = term !== null && admission.inheritedOwn.get(key) === true;
  return term;
}

/**
 * The written type a copy of `from` at `path` carries into the decision of `into`: what `from` inherits there
 * (`inheritedAt`), none where the two wait on each other through copies (`cut`). With `own`, also whether that copy
 * reads its written type at its own root (`Admission.inheritedOwn`, #1901): false past the deepest path a written type
 * reaches, where a prefix's type is taken below it, and where it carries none.
 */
export function* inheritedInto(
  admission: Admission,
  from: PlaceId,
  asked: Rest,
  asking: Key | null,
  own?: { value: boolean },
): Inheriting<TypeTerm | null> {
  // (past the deepest path a written type reaches, the place's path there is what it waits on, `inheritedAt`)
  const { contract } = admission.pass;
  // (the decision waiting in its identity, as the cycles hold it: G3 stage 1)
  const into = asking === null ? null : canonicalKey(contract, asking);
  const path = restRef(contract, asked);
  const source = keyAtRef(
    contract,
    from,
    path.length > admission.reach ? path.to(admission.reach) : path,
  );
  if (own !== undefined) own.value = false;
  if (into !== null && cut(admission, into, source)) return null;
  const term = yield* inheritedSteps(admission, from, path, own);
  if (into !== null && cut(admission, into, source)) {
    if (own !== undefined) own.value = false;
    return null;
  }
  return term;
}

/** Whether two decisions wait on each other through copies (`cycles`). */
function cut(admission: Admission, a: CanonicalKey, b: CanonicalKey): boolean {
  return (
    admission.cycles.has(a) &&
    admission.cycles.has(b) &&
    rootOf(admission, a) === rootOf(admission, b)
  );
}

function rootOf(admission: Admission, key: CanonicalKey): CanonicalKey {
  let root = key;
  while (admission.cycles.get(root) !== root) root = admission.cycles.get(root)!;
  for (let at = key; at !== root;) {
    const parent = admission.cycles.get(at)!;
    admission.cycles.set(at, root);
    at = parent;
  }
  return root;
}

export function join(admission: Admission, first: Key, second: Key): void {
  // (both decisions in their identity: one member per key)
  const { contract } = admission.pass;
  const [a, b] = [canonicalKey(contract, first), canonicalKey(contract, second)];
  for (const key of [a, b])
    if (!admission.cycles.has(key)) {
      admission.cycles.set(key, key);
      admission.cycleSizes.set(key, 1);
    }
  const x = rootOf(admission, a);
  const y = rootOf(admission, b);
  if (x === y) return;
  admission.cycles.set(x, y);
  admission.cycleSizes.set(y, admission.cycleSizes.get(y)! + admission.cycleSizes.get(x)!);
  admission.cycleSizes.delete(x);
}
