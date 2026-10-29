import type { PlaceId } from "../../graph.js";
import type { Admission } from "../admission.js";
import { keptArray, keptParts, keptSteps } from "../budget.js";
import { keptKeyBelow, keyOf, type Definition, type Key } from "../definitions.js";
import { SCALAR } from "./kinds.js";
import { inheritance } from "./landings.js";
import type { HeldExtra, HeldOwn, OwnStructure } from "./model.js";
import { fieldsOf, sourceOf } from "./structure.js";
import { stopsOf } from "./walk.js";

// A place's own contributions besides its copies (A5): from every store, and from its live stores alone.

/**
 * A place's own contributions besides its copies of inheriting places (`hotSets`, `OwnStructure`): each store's
 * literals and constants at their paths (another kind may stand there), its reads of other places' keys and calls'
 * results with where they stand, and any other value at its path with
 * what lies below it (host data through an operation: anything); a written binding's copy stands where it lands
 * (`hotSets`). `null` where there is none.
 */
export function ownStructure(admission: Admission, place: PlaceId): OwnStructure | null {
  const known = admission.owns.get(place);
  if (known !== undefined) return known;
  const { definitions } = admission.pass;
  const work = admission.pass.program.work;
  const copies = new Set<string>();
  for (const copy of inheritance(admission).into.get(place) ?? [])
    copies.add(keptParts(admission.work, copy.path, copy.from, copy.strip));
  const points: (readonly string[])[] = [];
  const below: (readonly string[])[] = [];
  const reads: { readonly at: readonly string[]; readonly source: Key }[] = [];
  const root = keyOf(place, []);
  for (const key of [root, ...definitions.keysBelow(root)])
    for (const d of definitions.byKey.get(key) ?? []) {
      work.charge("indexSteps");
      if (d.kind === "const") {
        points.push(d.path);
      }
      if ((d.kind !== "whole" && d.kind !== "add") || d.value === undefined) continue;
      const base =
        d.kind === "add" && d.how !== "elements"
          ? keptSteps(admission.work, d.path, ["element"])
          : d.path;
      ownOf(admission, d, d.value, base, copies, { points, below, reads });
    }
  const found =
    points.length === 0 && below.length === 0 && reads.length === 0
      ? null
      : { points, below, reads };
  admission.owns.set(place, found);
  return found;
}

/**
 * One store's value's own contributions standing at `base` in its place (`ownStructure`, `touchElements`), put in
 * `out`; `copied` hears of each copy the place's copies list (`copies`), which stands for its source's contents;
 * `out.held`, where given, takes what A2's held view takes beside them (`HeldExtra`).
 */
export function ownOf(
  admission: Admission,
  d: Definition,
  value: PlaceId,
  base: readonly string[],
  copies: ReadonlySet<string>,
  out: {
    readonly points: (readonly string[])[];
    readonly below: (readonly string[])[];
    readonly reads: { readonly at: readonly string[]; readonly source: Key }[];
    readonly held?: HeldExtra;
  },
  copied?: (at: readonly string[], from: PlaceId, strip: readonly string[]) => void,
  skip?: ReadonlySet<PlaceId>,
): void {
  const work = admission.pass.program.work;
  const stops = stopsOf(admission, value, d.node);
  // (a copy the place's copies list stands for its source's contents, its value with it)
  const copying = new Set<string>();
  for (const list of stops.written.values())
    for (const stop of list) {
      work.charge("indexSteps");
      if (skip?.has(stop.value) === true) continue;
      if (stop.from === null) {
        out.held?.points.push(keptSteps(admission.work, base, stop.path));
        continue;
      }
      const at = keptSteps(admission.work, base, stop.path);
      if (copies.has(keptParts(admission.work, at, stop.from, stop.strip))) {
        copying.add(keptParts(admission.work, stop.path, stop.value));
        copied?.(at, stop.from, stop.strip);
      } else out.below.push(at);
    }
  for (const list of stops.values.values())
    for (const stop of list) {
      work.charge("indexSteps");
      if (skip?.has(stop.value) === true) continue;
      // (a value a copy in the list stands for: A2's held view still takes it, `HeldExtra`)
      const into = copying.has(keptParts(admission.work, stop.path, stop.value)) ? out.held : out;
      if (into === undefined) continue;
      const at = keptSteps(admission.work, base, stop.path);
      const source = stop.deep ? null : sourceOf(admission, stop.value);
      const kinds = into !== out && source !== null ? null : admission.quietKinds(stop.value);
      if (source !== null)
        into.reads.push({ at, source: keptKeyBelow(admission.work, source, stop.strip) });
      else if (
        kinds !== null &&
        kinds.every((tag) => SCALAR.has(tag) || tag === "null") &&
        stop.strip.length === 0
      )
        into.points.push(at);
      else if (into === out) out.below.push(at);
    }
  for (const list of stops.literals.values())
    for (const stop of list) {
      work.charge("indexSteps");
      if (skip?.has(stop.value) === true) continue;
      out.points.push(keptSteps(admission.work, base, stop.path));
    }
}

/**
 * The values within a stored literal that a rejected cell holds (dead in this pass, as the value
 * side has it), with every value nested in them; walked through the literal's cells, once per value.
 */
function deadCells(admission: Admission, value: PlaceId): ReadonlySet<PlaceId> {
  const { program, definitions, lists } = admission.pass;
  const out = new Set<PlaceId>();
  const pending: [PlaceId, boolean][] = [[value, false]];
  while (pending.length > 0) {
    const [at, dead] = pending.pop()!;
    program.work.charge("indexSteps");
    if (dead) out.add(at);
    for (const has of program.hasOf.get(at) ?? [])
      for (const [, field] of fieldsOf(has.type))
        if (field.kind === "ref")
          for (const d of definitions.cellDefs.get(field.place) ?? [])
            if (d.value !== undefined) pending.push([d.value, dead || !lists.live(d)]);
  }
  return out;
}

/** A place's own contributions from its live stores only (`ownStructure`'s walk), once (Astra's B2). */
export function liveOwn(admission: Admission, place: PlaceId): HeldOwn | null {
  const known = admission.liveOwns.get(place);
  if (known !== undefined) return known;
  const { definitions, lists } = admission.pass;
  const work = admission.pass.program.work;
  const copies = new Set<string>();
  for (const each of inheritance(admission).into.get(place) ?? [])
    copies.add(keptParts(admission.work, each.path, each.from, each.strip));
  const points: (readonly string[])[] = [];
  const below: (readonly string[])[] = [];
  const reads: { readonly at: readonly string[]; readonly source: Key }[] = [];
  const held: HeldExtra = { points: [], reads: [] };
  // (each live store's own slice of them, A2's stores of a live group's member, `finishHeld`)
  const stores: HeldOwn[] = [];
  const root = keyOf(place, []);
  let live = false;
  let dead = false;
  for (const key of [root, ...definitions.keysBelow(root)])
    for (const d of definitions.byKey.get(key) ?? []) {
      work.charge("indexSteps");
      if (!lists.live(d)) {
        dead = true;
        continue;
      }
      live = true;
      const [fromPoints, fromBelow, fromReads, fromHeldPoints, fromHeldReads] = [
        points.length,
        below.length,
        reads.length,
        held.points.length,
        held.reads.length,
      ];
      if (d.kind === "const") {
        points.push(d.path);
      }
      if ((d.kind === "whole" || d.kind === "add") && d.value !== undefined) {
        const base =
          d.kind === "add" && d.how !== "elements"
            ? keptSteps(admission.work, d.path, ["element"])
            : d.path;
        ownOf(
          admission,
          d,
          d.value,
          base,
          copies,
          { points, below, reads, held },
          undefined,
          deadCells(admission, d.value),
        );
      }
      stores.push({
        points: keptArray(admission.work, points.slice(fromPoints)),
        below: keptArray(admission.work, below.slice(fromBelow)),
        reads: keptArray(admission.work, reads.slice(fromReads)),
        held: {
          points: keptArray(admission.work, held.points.slice(fromHeldPoints)),
          reads: keptArray(admission.work, held.reads.slice(fromHeldReads)),
        },
      });
    }
  admission.liveStores.set(place, stores);
  const found =
    points.length === 0 &&
    below.length === 0 &&
    reads.length === 0 &&
    held.points.length === 0 &&
    held.reads.length === 0
      ? null
      : { points, below, reads, held };
  if (dead && !live) admission.deadOnly.add(place);
  admission.liveOwns.set(place, found);
  return found;
}
