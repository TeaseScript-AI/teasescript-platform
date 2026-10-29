import type { PlaceId, TypeTerm } from "../../graph.js";
import type { Admission } from "../admission.js";
import type { Key } from "../definitions.js";
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
  path: readonly string[],
): Inheriting<TypeTerm | null> {
  if (path.length > admission.reach) {
    const above = yield* inheritedSteps(admission, from, path.slice(0, admission.reach));
    return above === null ? null : permittedAt(above, path.slice(admission.reach));
  }
  const key = admission.keyId(from, path);
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
  path: readonly string[],
  into: Key | null,
): Inheriting<TypeTerm | null> {
  // (past the deepest path a written type reaches, the place's path there is what it waits on, `inheritedAt`)
  const source = admission.keyId(
    from,
    path.length > admission.reach ? path.slice(0, admission.reach) : path,
  );
  if (into !== null && cut(admission, into, source)) return null;
  const term = yield* inheritedSteps(admission, from, path);
  return into !== null && cut(admission, into, source) ? null : term;
}

/** Whether two decisions wait on each other through copies (`cycles`). */
function cut(admission: Admission, a: Key, b: Key): boolean {
  return (
    admission.cycles.has(a) &&
    admission.cycles.has(b) &&
    rootOf(admission, a) === rootOf(admission, b)
  );
}

/** A decision's cycle as it stands (`cycles`): its root and size, empty outside every cycle. */
export function cycleOf(admission: Admission, key: Key): string {
  if (!admission.cycles.has(key)) return "";
  const root = rootOf(admission, key);
  return `${admission.cycleSizes.get(root)!}:${root}`;
}

function rootOf(admission: Admission, key: Key): Key {
  let root = key;
  while (admission.cycles.get(root) !== root) root = admission.cycles.get(root)!;
  for (let at = key; at !== root;) {
    const parent = admission.cycles.get(at)!;
    admission.cycles.set(at, root);
    at = parent;
  }
  return root;
}

export function join(admission: Admission, a: Key, b: Key): void {
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
