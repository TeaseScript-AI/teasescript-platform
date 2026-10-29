import type { PlaceId, TypeTerm } from "../../graph.js";
import type { Admission } from "../admission.js";
import { joinParts, keepText } from "../budget.js";
import { typeTags, writtenOf } from "../contract.js";
import { keptKey, keyOf, keyPath, keyPlace, type Key } from "../definitions.js";
import { landed, passThrough } from "./landings.js";
import type { Inheriting, Waiting } from "./model.js";
import { permittedAt, unrestricted } from "./permitted.js";
import { inputsOf, scanAt } from "./scan.js";
import { cycleOf, join } from "./waiting.js";
import { copySources } from "./walk.js";

// A4 through copies: the written type an unwritten place's decision inherits, from the graph of copies.

/**
 * A copied written type as a place's own decision admits it: with its `null` where the decision is nullable beside the
 * copy (S6-CARRIERS §4.2: a `null` before the written decider, a literal's `null` element), so a copy of the place keeps
 * that too (Astra's F2 on #1049).
 */
function optionalOf(term: TypeTerm | null, nullable: boolean): TypeTerm | null {
  if (term === null || !nullable || typeTags(term).includes("null")) return term;
  return { kind: "union", members: [term, { kind: "atom", name: "null" }] };
}

/**
 * A4 through copies (ADR 0021 1.3: a copy of a binding with a written type keeps that type, so a copy of that copy does
 * too; r4.75 (1)), from every definition's stores: the unwritten places a copy of a written binding lands in, then
 * those a copy of such a place lands in, at any path (`inheriting`). Only their copies carry an inherited type.
 */
export function copyGraph(admission: Admission): void {
  const { program, definitions } = admission.pass;
  const work = program.work;
  const targets = new Set(program.occurrenceOf.values());
  const edges = new Map<PlaceId, PlaceId[]>();
  const seeds: PlaceId[] = [];
  for (const list of definitions.byKey.values())
    for (const d of list) {
      work.charge("indexSteps");
      if (d.value === undefined) continue;
      if (!targets.has(d.place) || writtenOf(program.place(d.place).kind) !== null) continue;
      for (const { binding } of copySources(admission, d.value)) {
        work.charge("indexSteps");
        if (writtenOf(program.place(binding).kind) !== null) seeds.push(d.place);
        else {
          const out = edges.get(binding);
          if (out === undefined) edges.set(binding, [d.place]);
          else out.push(d.place);
        }
      }
    }
  const queue = [...new Set(seeds)];
  for (const place of queue) admission.inheriting.add(place);
  for (let index = 0; index < queue.length; index += 1)
    for (const next of edges.get(queue[index]!) ?? []) {
      work.charge("indexSteps");
      if (admission.inheriting.has(next)) continue;
      admission.inheriting.add(next);
      queue.push(next);
    }
}

/**
 * A4 through copies (ADR 0021 1.3; r4.75 (1), (1a)): the written type an unwritten place's own decision copies at a
 * path, through whatever copy of a written binding it comes (a chain of copies, a projection, a selected carrier, a
 * literal, a parameter's default), at every collection level: `scanAt`'s copied type, with the place's own `null`
 * where its decision is nullable beside the copy (`optionalOf`), `null` where a value decides the path or nothing does. A copy of the place carries that type there. Once per place and path, iteratively: a scan
 * that needs another place's type first is suspended where it stands (`Inheriting`) and goes on from there once that
 * type is known, so a chain of copies never deepens the native stack and a scanned prefix is never scanned again for a
 * sibling resolved later (the owner's reviewer's F1 on #1049, TABLE r4.80). A scan that needs the very place and path
 * whose own scan is waiting closes a cycle of copies: those waiting from there on are joined (`cycles`), and a copy
 * between two of them carries no written type (`cut`): a cycle of copies decides nothing written, whichever of its
 * places is asked first. A scan whose own cycle grew while it waited is taken again from its start, since the cut may
 * now drop a copy it already read; nothing else changes what it read. A place at another path is no cycle (`a.q = a`:
 * `a.q.p` needs `a.p`). Past the deepest path a written type reaches (`reach`) a place inherits only what its path's
 * prefix there leaves below it (an unrestricted part), so a copy nesting a place in itself never deepens without end.
 */
export function inheritedAt(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
): TypeTerm | null {
  if (path.length > admission.reach) {
    const above = inheritedAt(admission, place, path.slice(0, admission.reach));
    return above === null ? null : permittedAt(above, path.slice(admission.reach));
  }
  const key = keyOf(place, path);
  const known = admission.inherited.get(key);
  if (known !== undefined) return known;
  // (a resolution resolves every key its scans wait on itself, so none starts inside another)
  if (admission.resolving)
    throw new Error(`The inherited type of '${key}' was asked while resolving.`);
  admission.resolving = true;
  try {
    const scan = (next: Key): Waiting => {
      const [place, path] = [keyPlace(next), keyPath(next)];
      // (a place that answers through a copy above it asks that copy's place, nothing scanned)
      const through = passThrough(admission, place, path);
      if (through !== place)
        return {
          key: next,
          steps: answerOf(admission, keptKey(admission.work, through, path)),
          cycle: "",
        };
      const inputs = inputsOf(admission, place, path);
      return {
        key: next,
        steps: inputs === null ? null : scanAt(admission, inputs.direct, inputs.prefixes, next),
        cycle: "",
      };
    };
    const pending: Waiting[] = [scan(key)];
    // (the positions of the waiting scans, and the last cycle closed)
    const waiting = new Map<Key, number>([[key, 0]]);
    let closed = "";
    // (the type the top scan waited on, given to it as it goes on)
    let given: TypeTerm | null = null;
    // the top scan's type is taken, the scan below it goes on, or is taken again where its cycle grew meanwhile
    const resolved = (term: TypeTerm | null): void => {
      const done = pending.pop()!;
      keepText(admission.work, done.key.length);
      admission.inherited.set(done.key, term);
      waiting.delete(done.key);
      const below = pending.at(-1);
      if (below !== undefined && below.cycle !== cycleOf(admission, below.key))
        pending[pending.length - 1] = scan(below.key);
      given = term;
    };
    while (pending.length > 0) {
      const top = pending.at(-1)!;
      // (a key no store reaches finds nothing)
      const step =
        top.steps === null ? { done: true as const, value: null } : top.steps.next(given);
      given = null;
      if (step.done === true) {
        resolved(step.value === null ? null : optionalOf(step.value.copied, step.value.nullable));
        continue;
      }
      const needed = step.value;
      const from = waiting.get(needed);
      if (from !== undefined) {
        const cycle = joinParts(top.key, needed);
        // (a scan that asks again across the cycle just closed inherits nothing: it never waits on itself twice)
        if (cycle === closed) {
          resolved(null);
          continue;
        }
        closed = cycle;
        for (let index = from; index < pending.length; index += 1)
          join(admission, pending[index]!.key, needed);
        // (its cycle grew: taken again, as every scan it joined is when it goes on)
        pending[pending.length - 1] = scan(top.key);
        continue;
      }
      top.cycle = cycleOf(admission, top.key);
      waiting.set(needed, pending.length);
      pending.push(scan(needed));
    }
  } finally {
    admission.resolving = false;
  }
  return admission.inherited.get(key)!;
}

/** A computation run outside a resolution: each inherited type it waits on resolved by `inheritedAt` first. */
export function drive<T>(admission: Admission, steps: Inheriting<T>): T {
  let given: TypeTerm | null = null;
  for (;;) {
    const step = steps.next(given);
    if (step.done === true) return step.value;
    given = inheritedAt(admission, keyPlace(step.value), keyPath(step.value));
  }
}

/** Another key's inherited type as a scan's answer (`inheritedAt`'s `passThrough`): known, or waited on. */
function* answerOf(
  admission: Admission,
  key: Key,
): Inheriting<{ readonly copied: TypeTerm | null; readonly nullable: boolean } | null> {
  const known = admission.inherited.get(key);
  const term = known !== undefined ? known : yield key;
  return term === null ? null : { copied: term, nullable: false };
}

/**
 * Whether a written type a copy decides at a prefix of a path leaves the path unrestricted (A4 through copies, the
 * lead's ruling on #1215: a copied written type is the written type below it too): a prefix copies land at
 * (`landed`) whose decision copies a written type (`inheritedAt`) unrestricted at the rest (`permittedAt`), as an
 * own written type is below it, whatever a store on the path decided before the copy. Only in a place copies land in,
 * walked down from its root one step at a time (`OpenStep`), so each of its paths is asked of the landings once.
 */
export function openAbove(admission: Admission, place: PlaceId, path: readonly string[]): boolean {
  if (!admission.a4Places.has(place)) return false;
  let at = admission.a4Places.get(place) ?? null;
  if (at === null) admission.a4Places.set(place, (at = { carried: [], below: new Map() }));
  for (let length = 0; length < path.length && at.carried !== true; length += 1) {
    const step = path[length]!;
    let next = at.below.get(step);
    if (next === undefined) {
      const terms = [...at.carried];
      const prefix = path.slice(0, length);
      const own = landed(admission, place, prefix) ? inheritedAt(admission, place, prefix) : null;
      if (own !== null && !terms.includes(own)) terms.push(own);
      let carried: TypeTerm[] | true = [];
      for (const term of terms) {
        const below = permittedAt(term, [step]);
        if (below === null) continue;
        if (unrestricted(below)) {
          carried = true;
          break;
        }
        if (!carried.includes(below)) carried.push(below);
      }
      at.below.set(step, (next = { carried, below: new Map() }));
    }
    at = next;
  }
  return at.carried === true;
}
