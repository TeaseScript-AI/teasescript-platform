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
import type { Inheriting } from "./model.js";
import { permittedAt } from "./permitted.js";

// The decisions that wait on each other through copies (a union-find by key), and what a scan reads of an inherited type.

/**
 * What `from` inherits at `path` (`inheritedAt`) as a scan asks it: known, or the key it waits on yielded, past the
 * deepest path a written type reaches its path's prefix there.
 */
function* inheritedSteps(
  admission: Admission,
  from: PlaceId,
  asked: Rest,
): Inheriting<TypeTerm | null> {
  // (a cursor's span read by its paths' ids: its key a cursor, its prefix and rest views, G3 stage 1)
  const { contract } = admission.pass;
  const path = restRef(contract, asked);
  if (path.length > admission.reach) {
    const above = yield* inheritedSteps(admission, from, path.to(admission.reach));
    return above === null ? null : permittedAt(above, path.from(admission.reach));
  }
  const key = keyAtRef(contract, from, path);
  const known = admission.inherited.get(key);
  return known !== undefined ? known : yield key;
}

/**
 * The written type a copy of `from` at `path` carries into the decision of `into`: what `from` inherits there
 * (`inheritedAt`), none where the two wait on each other through copies (`cut`).
 */
export function* inheritedInto(
  admission: Admission,
  from: PlaceId,
  asked: Rest,
  asking: Key | null,
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
  if (into !== null && cut(admission, into, source)) return null;
  const term = yield* inheritedSteps(admission, from, path);
  return into !== null && cut(admission, into, source) ? null : term;
}

/** Whether two decisions wait on each other through copies (`cycles`). */
function cut(admission: Admission, a: CanonicalKey, b: CanonicalKey): boolean {
  return (
    admission.cycles.has(a) &&
    admission.cycles.has(b) &&
    rootOf(admission, a) === rootOf(admission, b)
  );
}

/** A decision's cycle as it stands (`cycles`): its root and size, empty outside every cycle. */
export function cycleOf(admission: Admission, asked: Key): string {
  const key = canonicalKey(admission.pass.contract, asked);
  if (!admission.cycles.has(key)) return "";
  const root = rootOf(admission, key);
  return `${admission.cycleSizes.get(root)!}:${root}`;
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
