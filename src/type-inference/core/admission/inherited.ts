import type { PlaceId, TypeTerm } from "../../graph.js";
import type { Admission } from "../admission.js";
import { joinParts, keep, keepText } from "../budget.js";
import { typeTags, writtenOf } from "../contract.js";
import { keptKey, keyOf, keyPath, keyPlace, type Definition, type Key } from "../definitions.js";
import { landed, passThrough } from "./landings.js";
import type { Frontier, Inheriting, Stop, Stops, Waiting } from "./model.js";
import { permittedAt, unrestricted } from "./permitted.js";
import { inputsOf, scanAt } from "./scan.js";
import { cycleOf, inheritedInto, join } from "./waiting.js";
import { copySources, stopsOf } from "./walk.js";
import { wholeOf } from "./eligibility.js";
import { positions } from "../positions.js";

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
      // (G3 3a: a key past a wrapper inherits what the wrapper's read does below it, from its frontier, `wrapped`)
      const frontier = positions() ? wrappedFrontier(admission, place, path) : null;
      if (frontier !== null)
        return {
          key: next,
          steps: wrapped(admission, next, place, path, frontier, () => ownScan(next)),
          cycle: "",
        };
      return ownScan(next);
    };
    const ownScan = (next: Key): Waiting => {
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

/**
 * G3 3a: where a key's inherited type stands past wrappers (`Contract.wrapperHop`): the read its path's last wrapper
 * holds, with the path below it, when its first step passes one and each wrapper on the way is one for A2's scan too
 * (`scanHop`); `null` where the first step passes none. Once per place and path (by its id), from its parent's.
 */
function wrappedFrontier(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
): Frontier | null {
  if (path.length === 0 || scanHop(admission, place, path[0]!) === null) return null;
  const { contract } = admission.pass;
  const ids: number[] = [contract.pathIdOf(path)];
  // (up to the nearest path known, then each one step below its parent's)
  for (let id = ids[0]!; !admission.frontiers.has(joinParts(place, id)) && id > 0;) {
    id = contract.pathParent(id);
    ids.push(id);
  }
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    const id = ids[index]!;
    const memoKey = joinParts(place, id);
    if (admission.frontiers.has(memoKey)) continue;
    keepText(admission.work, memoKey.length);
    if (id === 0) {
      admission.frontiers.set(memoKey, { place, read: null, rest: 0 });
      continue;
    }
    const above = admission.frontiers.get(joinParts(place, contract.pathParent(id)))!;
    const step = path[contract.pathDepth(id) - 1]!;
    const hop = above.rest === 0 ? scanHop(admission, above.place, step) : null;
    admission.frontiers.set(
      memoKey,
      hop === null
        ? { place: above.place, read: above.read, rest: contract.pathStep(above.rest, step) }
        : { place: hop.binding, read: hop.read, rest: 0 },
    );
  }
  return admission.frontiers.get(joinParts(place, ids[0]!))!;
}

/**
 * G3 3a: a wrapper's step as A2's scan reads it (`scanAt`, `earliestDecider`), or `null`: the binding is a wrapper at
 * the step (`Contract.wrapperHop`) whose declaration is its key's one eligible store, no other definition's class, and
 * its literal's stops at the step are the read's own (a written stop where its binding is written or inherits one, and
 * its value), none at the literal's root or below the read. So the scan of a key `place|step·rest` finds the read's
 * written type at the rest first, before its value, and else decides by values: its inherited type is the read's
 * binding's at the rest (`inheritedInto`), optional where the declaration's value there holds `null`. Once per place and
 * step.
 */
function scanHop(
  admission: Admission,
  place: PlaceId,
  step: string,
): { readonly binding: PlaceId; readonly read: PlaceId; readonly decl: Definition } | null {
  const memoKey = joinParts(place, step);
  const known = admission.scanHops.get(memoKey);
  if (known !== undefined) return known;
  keepText(admission.work, memoKey.length);
  const { program, contract } = admission.pass;
  program.work.charge("checks");
  let found: {
    readonly binding: PlaceId;
    readonly read: PlaceId;
    readonly decl: Definition;
  } | null = null;
  const hop = contract.wrapperHop(place, step);
  const binding = hop === null ? undefined : program.occurrenceOf.get(hop.read);
  if (hop !== null && binding !== undefined) {
    const root = keyOf(place, []);
    const eligible = wholeOf(admission, root, false);
    const stops = stopsOf(admission, hop.literal, hop.decl.node);
    const own = (list: readonly Stop[] | undefined): boolean =>
      list === undefined ||
      list.every(
        (stop) =>
          stop.value === hop.read && stop.strip.length === 0 && stop.via === null && !stop.deep,
      );
    const beside = stopSteps(admission, stops);
    if (
      eligible.length === 1 &&
      eligible[0] === hop.decl &&
      !admission.members.has(hop.decl) &&
      !admission.pass.definitions.deadArguments.has(root) &&
      passThrough(admission, place, [step]) === place &&
      own(stops.written.get(step)) &&
      own(stops.values.get(step)) &&
      !beside.root &&
      !beside.deeper.has(step)
    )
      found = { binding, read: hop.read, decl: hop.decl };
  }
  admission.scanHops.set(memoKey, found);
  return found;
}

/**
 * A walk's written and value stops by their paths' first steps (`scanHop`): whether one stands at the root, and the
 * first steps of the paths of two steps or more. Once per walk.
 */
function stopSteps(
  admission: Admission,
  stops: Stops,
): { readonly root: boolean; readonly deeper: ReadonlySet<string> } {
  const known = admission.stopSteps.get(stops);
  if (known !== undefined) return known;
  let root = false;
  const deeper = new Set<string>();
  for (const map of [stops.written, stops.values])
    for (const text of map.keys()) {
      admission.pass.program.work.charge("checks");
      if (text === "") root = true;
      else if (text.includes(".")) deeper.add(text.slice(0, text.indexOf(".")));
    }
  keep(admission.work, 1 + deeper.size);
  const found = { root, deeper };
  admission.stopSteps.set(stops, found);
  return found;
}

/**
 * G3 3a: a key's scan past wrappers (`inheritedAt`): its frontier's written type at the rest (the read's binding's own,
 * or what it inherits there, `inheritedInto`, into the key's decision), optional where the key's declaration's value at
 * the path holds `null`; each wrapper's scan on the way gives what the one below it does, its value's kinds the same at
 * every one of them, which the value side's position through the same wrappers proves (`Values.valuePosition`). Where it
 * does not, the key's own scan (`own`).
 */
function* wrapped(
  admission: Admission,
  key: Key,
  place: PlaceId,
  path: readonly string[],
  frontier: Frontier,
  own: () => Waiting,
): Inheriting<{ readonly copied: TypeTerm | null; readonly nullable: boolean } | null> {
  const { program, values, contract } = admission.pass;
  const decl = scanHop(admission, place, path[0]!)!.decl;
  const value = admission.run(values.valuePosition(decl.value!, decl.node, path));
  const at = value.proof;
  if (
    at === null ||
    !at.hopped ||
    at.read !== frontier.read ||
    at.rest !== frontier.rest ||
    frontier.read === null
  ) {
    const steps = own().steps;
    return steps === null ? null : yield* steps;
  }
  const rest = contract.pathSteps(frontier.rest);
  const written = writtenOf(program.place(frontier.place).kind);
  const copied =
    written !== null
      ? permittedAt(written, rest)
      : admission.inheriting.has(frontier.place)
        ? yield* inheritedInto(admission, frontier.place, rest, key)
        : null;
  if (copied === null) return null;
  return {
    copied,
    nullable: typeTags(copied).includes("null") || value.items.some((item) => item.tag === "null"),
  };
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
