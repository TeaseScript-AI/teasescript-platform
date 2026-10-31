import type { PlaceId } from "../../graph.js";
import type { Admission } from "../admission.js";
import {
  joinSteps,
  keepText,
  keptParts,
  keptSplit,
  keptSteps,
  keptText,
  pathText,
  splitPath,
} from "../budget.js";
import { writtenOf } from "../contract.js";
import {
  canonicalKey,
  type CanonicalKey,
  isKeyId,
  keptKeyAt,
  keptParentIn,
  type KeyId,
  keyIdAt,
  keyIdBelow,
  keyIdOf,
  keyIdPath,
  rootId,
} from "../contract/key-ids.js";
import { keyLane } from "../contract/lanes.js";
import {
  keptKey,
  keptPath,
  keptPathText,
  keptPrefixes,
  keyPlace,
  type Definition,
  type Key,
} from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import type { Item } from "../items.js";
import { decided } from "./decision.js";
import { heldMeetings } from "./held.js";
import { offending, SCALAR } from "./kinds.js";
import { landingIndex } from "./landing-index.js";
import { byPath, inheritance, landed, landedBelow, wholeCycle } from "./landings.js";
import type { ByPath, DecidedAt, InheritedCopy } from "./model.js";
import { stepName } from "../program.js";
import { ownStructure } from "./own.js";
import { levelsOf } from "./permitted.js";
import { depthOf, elementsBelow, valueStructure } from "./structure.js";
import { touchOf } from "./touches.js";

// The places and paths admission decides, the stores it walks, and the hot sets among them (A5).

/**
 * Whether contents are known and scalar: some, each a scalar or `null`, so no copy meets them below their root (A2,
 * `groups`); an unknown or anything else may hold properties or elements.
 */
function scalarOnly(items: readonly Item[]): boolean {
  return items.length > 0 && items.every((item) => SCALAR.has(item.tag) || item.tag === "null");
}

/**
 * The stores admission walks: the stores, adds, returns, parameter defaults and single-site arguments into each key (a
 * multi-site argument decides nothing, F21), found once.
 */
export function stores(admission: Admission): readonly Definition[] {
  if (admission.storeList === null) {
    const { definitions, lists } = admission.pass;
    admission.storeList = [...definitions.storeDefs, ...definitions.transferDefs].filter(
      (d) =>
        (d.kind === "whole" || d.kind === "add") &&
        (d.how !== "argument" || lists.singleSite(d.fn)) &&
        !admission.besideDefault(d),
    );
  }
  return admission.storeList;
}

/**
 * Every place and path admission decides: the keys with definitions, below them a literal's structure, written elements.
 * G3 stage 1: each in its identity (`keyAt`): a wrapper's family's path its key's cursor, a projection's one step below
 * its owner's (`projectionCursor`), a parent by the arena (`keyParentIn`), never its path's text or steps.
 */
export function groups(admission: Admission): readonly DecidedAt[] {
  if (admission.groupList !== null) return admission.groupList;
  const { program, definitions, contract } = admission.pass;
  const work = program.work;
  // (each key in its identity: a definition's key is its family's text, G3 stage 1)
  const tracked = new Set<CanonicalKey>();
  for (const key of [...definitions.byKey.keys(), ...definitions.candidates.keys()])
    tracked.add(canonicalKey(contract, key));
  const chains = new Map<PlaceId, ChainLink>();
  for (const c of program.constraints)
    if (c.kind === "project") {
      const cursor = projectionCursor(admission, chains, c.into);
      if (cursor !== null) {
        tracked.add(cursor);
        continue;
      }
      const target = program.targetRoot(c.into);
      if (!program.cellOwner.has(target.root) && !program.hasOf.has(target.root))
        tracked.add(keptKeyAt(contract, target.root, target.path));
    }
  for (const [, binding] of program.occurrenceOf) tracked.add(keptKeyAt(contract, binding, []));
  const reaching = admission.stores();
  const stores = new Map<Key, number>();
  for (const d of reaching)
    for (const key of [d.key, ...keptPrefixes(admission.work, d.key)]) {
      work.charge("indexSteps");
      stores.set(key, (stores.get(key) ?? 0) + 1);
    }
  // a stored value's structure where another store or add reaches the place or below it: its literals', and below a
  // copy or a call its source's elements (F2), the deepest once per path it lands at (its prefixes follow below)
  const deepest = new Map<Key, number>();
  for (const d of reaching)
    if ((stores.get(d.key) ?? 0) > 1) {
      const base = joinSteps(d.path, d.kind === "add" && d.how !== "elements" ? ["element"] : []);
      const structure = valueStructure(admission, d.value!);
      for (const path of structure.paths)
        tracked.add(keptKeyAt(contract, d.place, joinSteps(base, path)));
      for (const { below, key } of structure.sources) {
        work.charge("indexSteps");
        const landing = keptKey(admission.work, d.place, joinSteps(base, below));
        const depth = depthOf(admission, key);
        if (depth <= (deepest.get(landing) ?? 0)) continue;
        deepest.set(landing, depth);
        tracked.add(
          keptKeyAt(
            contract,
            d.place,
            joinSteps(base, below, Array<string>(depth).fill("element")),
          ),
        );
      }
    }
  // a literal holding a named value (a copy, a call, what an operation carries of either) decides the paths its own
  // structure gives with its store, read or not, so the named value's uncertain contents meet C1 there (the owner's
  // F1, round 10 B1)
  for (const d of reaching)
    if ((stores.get(d.key) ?? 0) === 1) {
      const structure = valueStructure(admission, d.value!);
      if (structure.sources.length === 0) continue;
      const base = joinSteps(d.path, d.kind === "add" && d.how !== "elements" ? ["element"] : []);
      for (const path of structure.paths) {
        work.charge("indexSteps");
        tracked.add(keptKeyAt(contract, d.place, joinSteps(base, path)));
      }
    }
  // A2 (TABLE r4.131): a place receiving copies is checked where they meet it, read or not: the paths where what two
  // of its stores definitely hold meets with two kinds or more (`heldMeetings`), so the store that brings the other
  // type errs there (a rejected one too, as A6 finds it again); not where all the place holds is known and scalar, as
  // a scalar has no property to meet at
  const byPlace = new Map<PlaceId, { readonly d: Definition; readonly at: readonly string[] }[]>();
  const named = new Set<PlaceId>();
  for (const d of reaching) {
    work.charge("indexSteps");
    const at = keptSteps(
      admission.work,
      d.path,
      d.kind === "add" && d.how !== "elements" ? ["element"] : [],
    );
    const list = byPlace.get(d.place);
    if (list === undefined) byPlace.set(d.place, [{ d, at }]);
    else list.push({ d, at });
    if (valueStructure(admission, d.value!).sources.length > 0) named.add(d.place);
  }
  for (const [place, list] of byPlace)
    if (
      list.length > 1 &&
      named.has(place) &&
      !scalarOnly(
        withoutEmpty(
          admission.run(admission.pass.contract.contractOf(keptKey(admission.work, place, []))),
        ),
      )
    )
      for (const path of heldMeetings(admission, list, [])) {
        const key = keptKeyAt(contract, place, path);
        tracked.add(key);
        admission.atCopies.add(key);
      }
  // (and where a live group's members owe its meetings, `finishHeld`; the groups the discovery above made, so every
  // order of the consumers sees the same)
  for (const key of admission.groupMeetings) {
    work.charge("indexSteps");
    tracked.add(key);
    admission.atCopies.add(key);
  }
  // C9: where each ingress store's external data stands below its destination, decided with the store whether a
  // consumer reads the place or not (the owner's F1): its landings' contribution paths (§3.2)
  for (const [d, stops] of landingIndex(admission).byStore)
    for (const stop of stops) {
      work.charge("indexSteps");
      const below = elementsBelow(d, stop.path);
      if (below.length > 0)
        tracked.add(keptKeyAt(contract, d.place, joinSteps(admission.destPath(d), below)));
    }
  // (each key's prefixes, walked up a step at a time to one whose own are in already: each prefix made once, so a
  // literal nested k deep makes its k keys' prefixes in k steps, not k² made again per key, TABLE r4.100 (2))
  const closed = new Set<CanonicalKey>();
  for (const key of [...tracked])
    for (let at: CanonicalKey | null = key; at !== null && !closed.has(at);) {
      closed.add(at);
      at = keptParentIn(contract, at);
      if (at === null) break;
      work.charge("indexSteps");
      tracked.add(at);
    }
  work.charge(
    "checks",
    tracked.size +
      program.places.length +
      program.constraints.length +
      definitions.storeDefs.length,
  );
  // (per place its paths' texts, a cursor's its path's id after a NUL, which no path's text holds)
  const roots = new Map<PlaceId, Set<string>>();
  for (const key of tracked) {
    let paths = roots.get(keyPlace(key));
    if (paths === undefined) roots.set(keyPlace(key), (paths = new Set()));
    paths.add(
      isKeyId(key) ? cursorEntry(admission, keyIdPath(key)) : keptPathText(admission.work, key),
    );
  }
  // (a path added by its steps or its text, in its family's identity: a wrapper's family's its cursor's entry)
  const entry = (place: PlaceId, path: readonly string[] | string): string => {
    if (typeof path === "string") {
      const first = path === "" ? null : path.split(".", 1)[0]!;
      return first !== null && keyLane(contract, place, first) === "cursor"
        ? cursorEntry(admission, keyIdPath(keyIdOf(contract, place, splitPath(path))))
        : path;
    }
    return path.length > 0 && keyLane(contract, place, path[0]!) === "cursor"
      ? cursorEntry(admission, keyIdPath(keyIdOf(contract, place, path)))
      : keptText(admission.work, path);
  };
  // A1, A8: a written collection's elements at every depth
  for (const place of program.places) {
    const written = writtenOf(place.kind);
    const paths = roots.get(place.id);
    if (written === null || paths === undefined) continue;
    let path: readonly string[] = [];
    for (let level = 1; level < levelsOf(admission, written).length; level += 1)
      paths.add(keptText(admission.work, (path = joinSteps(path, ["element"]))));
  }
  const at = (place: PlaceId): Set<string> => {
    let paths = roots.get(place);
    if (paths === undefined) roots.set(place, (paths = new Set()));
    return paths;
  };
  // A4: a copied written type's paths, where the copy lands and below (A8: its elements)
  const { seeds, into, order } = inheritance(admission);
  for (const [place, paths] of seeds) {
    const own = at(place);
    for (const text of paths.keys()) own.add(entry(place, text));
  }
  // A4 through copies (r4.75 (1)): a copy of a place that may inherit a written type lands at its own path; below it,
  // where copies of written types land in that place, it is decided with the copy only where the place's contents may
  // not fit (`hotSets`: a store's host data or other kinds, two copies of different sources meeting, a store taken again),
  // and where an answer asks otherwise (`lazily`), so a copy costs its own divergences, never its source's every
  // path (the owner's reviewer's F1 on #1049, TABLE r4.80; r4.51)
  const hots = hotSets(admission);
  for (const component of order)
    for (const place of component) {
      const copies = into.get(place);
      if (copies === undefined) continue;
      const own = at(place);
      for (const { path } of copies) {
        work.charge("indexSteps");
        own.add(entry(place, path));
      }
      for (const path of hots.get(place) ?? []) {
        work.charge("indexSteps");
        own.add(entry(place, path));
      }
    }
  const groups: DecidedAt[] = [];
  for (const [root, paths] of roots)
    for (const entry of paths)
      groups.push(
        entry.startsWith("\u0000")
          ? { root, key: keyIdAt(root, Number(entry.slice(1))) }
          : { root, path: keptSplit(admission.work, entry) },
      );
  admission.groupList = groups;
  return groups;
}

/** A cursor's entry among a place's paths (`groups`): its path's id after a NUL, its slot charged as a kept text. */
function cursorEntry(admission: Admission, path: number): string {
  const text = `\u0000${path}`;
  keepText(admission.work, text.length);
  return text;
}

/** A projection's chain (`projectionCursor`): its root, its first step, its key's cursor in a wrapper's family. */
interface ChainLink {
  readonly root: PlaceId;
  readonly first: string;
  readonly key: KeyId | null;
}

/**
 * The cursor of a projection's key (`targetRoot`'s, a read's steps by their names) where its family is a wrapper's
 * (`keyLane`), else `null`: down from the nearest projection of its chain known in `chains`, each one step below its
 * owner's (`keyIdBelow`), so a chain of k projections makes k cursors and walks k links, never k² (G3 stage 1).
 */
function projectionCursor(
  admission: Admission,
  chains: Map<PlaceId, ChainLink>,
  value: PlaceId,
): KeyId | null {
  const { program, contract } = admission.pass;
  const way: PlaceId[] = [];
  let at = value;
  for (;;) {
    if (chains.has(at)) break;
    const projection = program.projOf.get(at);
    if (projection === undefined) break;
    way.push(at);
    at = program.occurrenceOf.get(projection.owner) ?? projection.owner;
  }
  let link = chains.get(at) ?? null;
  for (let index = way.length - 1; index >= 0; index -= 1) {
    const step = stepName(program.projOf.get(way[index]!)!.step);
    if (link === null) {
      const key =
        keyLane(contract, at, step) === "cursor" ? keyIdBelow(contract, rootId(at), step) : null;
      link = { root: at, first: step, key };
    } else
      link = {
        root: link.root,
        first: link.first,
        key: link.key === null ? null : keyIdBelow(contract, link.key, step),
      };
    chains.set(way[index]!, link);
  }
  return chains.get(value)?.key ?? null;
}

/**
 * Per place copies land in, the landed paths a copy decides with its store (`groups`): those where the place's
 * contents may hold a kind its decision there does not admit (`hotAt`), among its candidates: where its written types
 * land (a written binding's own host data, which each copy carries on: C9 r4.50 (1)), its own stores' host data,
 * other values and literals (`ownStructure`), the hot paths of the sources it copies where it lands them, and where
 * its contributions meet (`touchOf`); and each store taken again (A6). Elsewhere a copy's
 * contents fit what its source's decision admits, so its decision there owes nothing; a copy that only copies one
 * source, whole, stands for that source's (TABLE r4.80). Sources first; a cycle's members test every landed path.
 */
export function hotSets(
  admission: Admission,
): ReadonlyMap<PlaceId, readonly (readonly string[])[]> {
  if (admission.hots !== null) return admission.hots;
  const { seeds, into, cycleOf, cycles, order } = inheritance(admission);
  const work = admission.pass.program.work;
  const hots = new Map<PlaceId, readonly (readonly string[])[]>();
  // (the source a copy that only copies one source whole stands for, and a bound on each place's landed paths)
  const origins = new Map<PlaceId, PlaceId>();
  const retaken = new Map<PlaceId, (readonly string[])[]>();
  for (const key of admission.retaken.keys()) {
    work.charge("indexSteps");
    const list = retaken.get(keyPlace(key));
    if (list === undefined) retaken.set(keyPlace(key), [keptPath(admission.work, key)]);
    else list.push(keptPath(admission.work, key));
  }
  // (a copy's source's hot paths at or below its strip, from an index of each hot set: never the whole set for each
  // copy, Astra's review r2 B2)
  const indexed = new Map<readonly (readonly string[])[], ByPath<readonly string[]>>();
  const hotUnder = (copy: InheritedCopy): readonly (readonly string[])[] => {
    work.charge("indexSteps");
    const list = hots.get(copy.from) ?? [];
    let index = indexed.get(list);
    if (index === undefined) indexed.set(list, (index = byPath(admission, list, (path) => path)));
    return index.under.get(keptText(admission.work, copy.strip)) ?? [];
  };
  for (const component of order) {
    if (cycleOf.has(component[0]!)) {
      const cycle = cycleOf.get(component[0]!);
      const owns = component.map((member) => ownStructure(admission, member));
      if (wholeCycle(admission, component)) {
        // a cycle of whole copies holds what all its members' stores and its copies from outside bring, at its one
        // landing (`Inheritance.wholes`, or the place outside it that feeds it, asked): its candidates the members',
        // and a path hot where any member's contents may not fit there
        const lands = (path: readonly string[]): boolean => landed(admission, component[0]!, path);
        const candidates = new Map<string, readonly string[]>();
        const put = (path: readonly string[]): void => {
          work.charge("indexSteps");
          candidates.set(keptText(admission.work, path), path);
        };
        const classes = new Map<string, InheritedCopy>();
        for (const [index, member] of component.entries()) {
          work.charge("indexSteps");
          for (const text of seeds.get(member)?.keys() ?? []) put(keptSplit(admission.work, text));
          const own = owns[index]!;
          for (const path of own?.points ?? []) if (lands(path)) put(path);
          // (its other values and its reads, everything landed below each)
          for (const prefixes of [own?.below ?? [], (own?.reads ?? []).map(({ at }) => at)])
            for (const prefix of prefixes)
              for (const text of landedBelow(admission, member, prefix))
                put(keptSplit(admission.work, text));
          for (const copy of into.get(member) ?? []) {
            if (cycleOf.get(copy.from) === cycle) continue;
            const origin = origins.get(copy.from) ?? copy.from;
            const id = keptParts(admission.work, origin, copy.path, copy.strip);
            if (!classes.has(id))
              classes.set(id, origin === copy.from ? copy : { ...copy, from: origin });
          }
        }
        for (const copy of classes.values())
          for (const path of hotUnder(copy)) {
            work.charge("indexSteps");
            put(keptSteps(admission.work, copy.path, path.slice(copy.strip.length)));
          }
        // (its contributions meet as its touch tries find, one per group of members its live copies join: Astra's B3,
        // her recheck r3 F1)
        if (inheritance(admission).wholes.has(component[0]!)) {
          const met = new Set<object>();
          for (const member of component) {
            const touched = touchOf(admission, member);
            if (met.has(touched)) continue;
            met.add(touched);
            for (const path of touched.found) put(path);
          }
        }
        const hot: (readonly string[])[] = [];
        for (const path of candidates.values())
          if (component.some((member) => hotAt(admission, member, path))) hot.push(path);
        for (const member of component)
          for (const path of retaken.get(member) ?? []) if (lands(path)) hot.push(path);
        for (const member of component) {
          hots.set(member, hot);
          origins.set(member, member);
        }
        continue;
      }
      // (a cycle whose copies add or take steps: every landed path of each member tested, and each store taken
      // again kept, Sol's review r1 B4)
      for (const member of component) {
        const hot: (readonly string[])[] = [];
        for (const text of cycles.get(member)!) {
          const path = keptSplit(admission.work, text);
          if (hotAt(admission, member, path)) hot.push(path);
        }
        for (const path of retaken.get(member) ?? [])
          if (cycles.get(member)!.has(pathText(path))) hot.push(path);
        hots.set(member, hot);
        origins.set(member, member);
      }
      continue;
    }
    const place = component[0]!;
    const copies = into.get(place) ?? [];
    // its copies, a copy of a place standing for one source by that source
    const classes = new Map<string, InheritedCopy>();
    for (const copy of copies) {
      work.charge("indexSteps");
      const origin = origins.get(copy.from) ?? copy.from;
      const id = keptParts(admission.work, origin, copy.path, copy.strip);
      if (!classes.has(id))
        classes.set(id, origin === copy.from ? copy : { ...copy, from: origin });
    }
    const own = ownStructure(admission, place);
    const only = classes.size === 1 ? [...classes.values()][0]! : null;
    if (
      only !== null &&
      own === null &&
      !seeds.has(place) &&
      !retaken.has(place) &&
      only.path.length === 0 &&
      only.strip.length === 0
    ) {
      origins.set(place, only.from);
      hots.set(place, hots.get(only.from) ?? []);
      continue;
    }
    const candidates = new Map<string, readonly string[]>();
    const put = (path: readonly string[]): void => {
      work.charge("indexSteps");
      candidates.set(keptText(admission.work, path), path);
    };
    for (const copy of copies)
      for (const path of hotUnder(copy)) {
        work.charge("indexSteps");
        put(keptSteps(admission.work, copy.path, path.slice(copy.strip.length)));
      }
    for (const text of seeds.get(place)?.keys() ?? []) put(keptSplit(admission.work, text));
    for (const path of own?.points ?? []) if (landed(admission, place, path)) put(path);
    for (const prefix of own?.below ?? [])
      for (const text of landedBelow(admission, place, prefix))
        put(keptSplit(admission.work, text));
    for (const path of touchOf(admission, place).found) put(path);
    const hot: (readonly string[])[] = [];
    for (const path of candidates.values()) if (hotAt(admission, place, path)) hot.push(path);
    for (const path of retaken.get(place) ?? []) if (landed(admission, place, path)) hot.push(path);
    hots.set(place, hot);
  }
  admission.hots = hots;
  return hots;
}

/** Whether a place's contents at a path hold a kind its decision there does not admit (`hotSets`, A5). */
function hotAt(admission: Admission, place: PlaceId, path: readonly string[]): boolean {
  const found = decided(admission, place, path);
  if (found === null || found.tags === null || found.tags.includes("unknown")) return false;
  return offending(
    withoutEmpty(admission.run(admission.pass.contract.contractOf(found.key))),
    found,
  );
}
