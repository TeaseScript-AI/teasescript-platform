import type { PlaceId, TypeTerm } from "../../graph.js";
import type { Admission } from "../admission.js";
import {
  joinParts,
  joinSteps,
  keep,
  keepText,
  keptParts,
  keptSplit,
  keptSteps,
  keptText,
  pathText,
  splitPath,
} from "../budget.js";
import { writtenOf } from "../contract.js";
import { keptKey, keyOf, keyPath, keyPlace, sortCost, type Key } from "../definitions.js";
import type {
  ByPath,
  CopyForest,
  Inheritance,
  InheritedCopy,
  Storing,
  WholeCycle,
} from "./model.js";
import { levelsOf } from "./permitted.js";
import { positions } from "../positions.js";

// A4 through copies' landings: where copies land in each place, the copy forest places answer through, cycles of copies.

const NO_PATHS: ByPath<never> = { under: new Map(), at: new Map() };

/**
 * The last index at or before `last` whose value is at least `least`, in a max segment tree over `size` leaves (`tree`,
 * leaves from `size`), or -1.
 */
function lastAtLeast(tree: readonly number[], size: number, last: number, least: number): number {
  // (the leaves at or before `last`, right to left, each subtree skipped whole where its greatest is too small)
  let node = size + last;
  if (tree[node]! >= least) return last;
  // climb while the node is a left child or its left sibling holds none, then take that sibling's last one
  while (node > 1 && (node % 2 === 0 || tree[node - 1]! < least)) node >>= 1;
  if (node <= 1) return -1;
  node -= 1;
  while (node < size) node = tree[2 * node + 1]! >= least ? 2 * node + 1 : 2 * node;
  return node - size;
}

/** Whether `path` starts with `prefix` (or is it). */
function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((step, index) => path[index] === step);
}

/**
 * The cycles of places a graph of copies holds (Tarjan's strongly connected components, with an explicit stack): each
 * place in one, a place copied into itself too, by the cycle's number; and every component of the graph, each place's
 * sources' before its own.
 */
function cyclesOf(
  edges: ReadonlyMap<PlaceId, readonly InheritedCopy[]>,
  work: { charge(counter: "indexSteps", units?: number): void },
): { readonly cycleOf: Map<PlaceId, number>; readonly order: readonly (readonly PlaceId[])[] } {
  const out = new Map<PlaceId, number>();
  // (Tarjan's components come a place's copies' first)
  const components: PlaceId[][] = [];
  const order = new Map<PlaceId, number>();
  const low = new Map<PlaceId, number>();
  const stack: PlaceId[] = [];
  const onStack = new Set<PlaceId>();
  // (each place's copies' places, once: Sol's round 4 B2)
  const adjacency = new Map<PlaceId, readonly PlaceId[]>();
  for (const [place, copies] of edges) {
    work.charge("indexSteps", copies.length);
    adjacency.set(
      place,
      copies.map((copy) => copy.place),
    );
  }
  const next = (place: PlaceId): readonly PlaceId[] => adjacency.get(place) ?? [];
  const enter = (place: PlaceId): void => {
    low.set(place, order.size);
    order.set(place, order.size);
    stack.push(place);
    onStack.add(place);
  };
  for (const start of edges.keys()) {
    if (order.has(start)) continue;
    enter(start);
    const frames: { readonly place: PlaceId; at: number }[] = [{ place: start, at: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const targets = next(frame.place);
      work.charge("indexSteps");
      if (frame.at < targets.length) {
        const target = targets[frame.at]!;
        frame.at += 1;
        if (!order.has(target)) {
          enter(target);
          frames.push({ place: target, at: 0 });
        } else if (onStack.has(target))
          low.set(frame.place, Math.min(low.get(frame.place)!, order.get(target)!));
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined)
        low.set(parent.place, Math.min(low.get(parent.place)!, low.get(frame.place)!));
      if (low.get(frame.place) !== order.get(frame.place)) continue;
      const members: PlaceId[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        members.push(member);
        if (member === frame.place) break;
      }
      work.charge("indexSteps", targets.length);
      if (members.length > 1 || targets.includes(frame.place))
        for (const member of members) out.set(member, frame.place);
      components.push(members);
    }
  }
  return { cycleOf: out, order: components.reverse() };
}

/**
 * The place whose inherited type a place's is at a path (`inheritedAt`, r4.75 (1)): a place whose only store on the
 * path is one whole copy of an unwritten inheriting place, outside every cycle of copies, inherits there what that
 * place does (its scan finds the copy, whose type is that place's, and nothing beside it); so a chain of such copies
 * answers as its nearest member with a store on the path, or its top. Each copy storing its own field asks that member
 * directly, never every copy above it (the reviewer's control of a copy's own contribution, TABLE r4.80).
 */
export function passThrough(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
): PlaceId {
  const forest = copyForest(admission);
  if (!forest.parent.has(place)) return place;
  const own = forest.stores.get(place);
  const lists: (Storing | undefined)[] = [];
  for (let length = 1; length <= path.length; length += 1) {
    admission.pass.program.work.charge("indexSteps");
    const text = keptText(admission.work, path.slice(0, length));
    if (own?.has(text) === true) return place;
    lists.push(forest.storing.get(text));
  }
  return nearest(admission, place, lists);
}

/**
 * The place whose landed paths at or below `prefix` a place's are, besides its own root (`landedBelow`): a place
 * that answers through its parent lands nothing of its own but below its keys, so a chain of them lands what its
 * nearest member storing at, above or below the prefix lands, or its top.
 */
function landsThrough(admission: Admission, place: PlaceId, prefix: readonly string[]): PlaceId {
  const forest = copyForest(admission);
  if (!forest.parent.has(place)) return place;
  const own = forest.stores.get(place);
  const lists: (Storing | undefined)[] = [];
  for (let length = 1; length <= prefix.length; length += 1) {
    admission.pass.program.work.charge("indexSteps");
    const text = keptText(admission.work, prefix.slice(0, length));
    if (own?.has(text) === true) return place;
    lists.push(forest.storing.get(text));
  }
  // (a key of its own at or below the prefix, from its keys' prefixes: never a scan of its keys, Astra's review B2)
  const text = keptText(admission.work, prefix);
  admission.pass.program.work.charge("indexSteps");
  if (forest.under.get(place)?.has(text) === true) return place;
  lists.push(forest.beneath.get(text));
  return nearest(admission, place, lists);
}

/** The deepest place above `place` in its copy tree among the lists' places (`Storing`), else its tree's top. */
function nearest(
  admission: Admission,
  place: PlaceId,
  lists: readonly (Storing | undefined)[],
): PlaceId {
  const forest = copyForest(admission);
  const work = admission.pass.program.work;
  let found = forest.top.get(place)!;
  const entry = forest.entry.get(place)!;
  for (const storing of lists) {
    if (storing === undefined) continue;
    work.charge("indexSteps", Math.ceil(Math.log2(storing.places.length + 1)) + 1);
    // (the last place entered at or before it whose subtree holds it: entries sorted, last entries in a tree)
    let low = 0;
    let high = storing.entries.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (storing.entries[middle]! <= entry) low = middle + 1;
      else high = middle;
    }
    if (low === 0) continue;
    const index = lastAtLeast(storing.exits, storing.exits.length >> 1, low - 1, entry);
    if (index < 0) continue;
    const at = storing.places[index]!;
    if (at !== place && forest.depth.get(at)! > forest.depth.get(found)!) found = at;
  }
  return found;
}

/** The copies places answer through (`CopyForest`), once per pass. */
function copyForest(admission: Admission): CopyForest {
  if (admission.forest !== null) return admission.forest;
  const { program, definitions, lists } = admission.pass;
  const work = program.work;
  const { cycleOf } = inheritance(admission);
  // each place's keys with stores or candidates below its root
  const keys = new Map<PlaceId, Set<string>>();
  for (const map of [definitions.byKey, definitions.candidates] as const)
    for (const key of map.keys()) {
      work.charge("indexSteps");
      const path = keyPath(key);
      if (path.length === 0) continue;
      let own = keys.get(keyPlace(key));
      if (own === undefined) keys.set(keyPlace(key), (own = new Set()));
      own.add(keptText(admission.work, path));
    }
  const parent = new Map<PlaceId, PlaceId>();
  const children = new Map<PlaceId, PlaceId[]>();
  for (const place of admission.inheriting) {
    work.charge("indexSteps");
    if (cycleOf.has(place) || writtenOf(program.place(place).kind) !== null) continue;
    const stores = definitions.byKey.get(keyOf(place, [])) ?? [];
    const d = stores.length === 1 ? stores[0]! : null;
    const source =
      d !== null &&
      d.kind === "whole" &&
      d.value !== undefined &&
      d.how !== "argument" &&
      d.how !== "parameter default" &&
      lists.live(d)
        ? program.occurrenceOf.get(d.value)
        : undefined;
    if (
      source === undefined ||
      !admission.inheriting.has(source) ||
      writtenOf(program.place(source).kind) !== null
    )
      continue;
    parent.set(place, source);
    const list = children.get(source);
    if (list === undefined) children.set(source, [place]);
    else list.push(place);
  }
  const top = new Map<PlaceId, PlaceId>();
  const depth = new Map<PlaceId, number>();
  const entry = new Map<PlaceId, number>();
  const exit = new Map<PlaceId, number>();
  let clock = 0;
  for (const start of children.keys()) {
    if (parent.has(start)) continue;
    const frames: { readonly place: PlaceId; next: number }[] = [{ place: start, next: 0 }];
    top.set(start, start);
    depth.set(start, 0);
    entry.set(start, clock++);
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const below = children.get(frame.place) ?? [];
      work.charge("indexSteps");
      if (frame.next < below.length) {
        const child = below[frame.next++]!;
        top.set(child, start);
        depth.set(child, depth.get(frame.place)! + 1);
        entry.set(child, clock++);
        frames.push({ place: child, next: 0 });
        continue;
      }
      exit.set(frame.place, clock - 1);
      frames.pop();
    }
  }
  const stores = new Map<PlaceId, Set<string>>();
  const under = new Map<PlaceId, Set<string>>();
  // (per key, the places storing at it; and at it or below it, each key's prefixes, the root's too, once per place)
  const at = new Map<string, PlaceId[]>();
  const below = new Map<string, PlaceId[]>();
  const put = (map: Map<string, PlaceId[]>, text: string, place: PlaceId): void => {
    work.charge("indexSteps");
    const list = map.get(text);
    if (list === undefined) map.set(text, [place]);
    else if (list.at(-1) !== place) list.push(place);
  };
  for (const place of entry.keys()) {
    const own = keys.get(place);
    if (own === undefined) continue;
    stores.set(place, own);
    const prefixes = new Set<string>([""]);
    for (const text of own) {
      put(at, text, place);
      const steps = splitPath(text);
      for (let length = 1; length <= steps.length; length += 1)
        prefixes.add(keptText(admission.work, steps.slice(0, length)));
    }
    for (const text of prefixes) put(below, text, place);
    under.set(place, prefixes);
  }
  // (each list by entry, the last entries below its places the leaves of a max segment tree)
  const index = (map: Map<string, PlaceId[]>): Map<string, Storing> => {
    const out = new Map<string, Storing>();
    for (const [text, places] of map) {
      work.charge("indexSteps", places.length + sortCost(places.length));
      places.sort((a, b) => entry.get(a)! - entry.get(b)!);
      let size = 1;
      while (size < places.length) size <<= 1;
      const exits = Array<number>(2 * size).fill(-1);
      places.forEach((place, position) => (exits[size + position] = exit.get(place)!));
      for (let node = size - 1; node >= 1; node -= 1)
        exits[node] = Math.max(exits[2 * node]!, exits[2 * node + 1]!);
      out.set(text, { places, entries: places.map((place) => entry.get(place)!), exits });
    }
    return out;
  };
  admission.forest = {
    parent,
    stores,
    under,
    top,
    depth,
    entry,
    exit,
    storing: index(at),
    beneath: index(below),
  };
  return admission.forest;
}

/** A4 through copies' landings (`Inheritance`), once per pass. */
export function inheritance(admission: Admission): Inheritance {
  if (admission.inherits !== null) return admission.inherits;
  const work = admission.pass.program.work;
  const seeds = new Map<PlaceId, Map<string, Set<TypeTerm>>>();
  // (once per landing path and written type: k copies of one binding into one literal are one)
  const copied = new Map<Key, Set<TypeTerm>>();
  for (const { place, path, term } of admission.a4Copies) {
    const key = keptKey(admission.work, place, path);
    let terms = copied.get(key);
    if (terms === undefined) copied.set(key, (terms = new Set()));
    work.charge("indexSteps");
    if (terms.has(term)) continue;
    terms.add(term);
    let paths = seeds.get(place);
    if (paths === undefined) seeds.set(place, (paths = new Map()));
    // (each element level with the written type there)
    let step: readonly string[] = [];
    for (const level of levelsOf(admission, term)) {
      work.charge("indexSteps");
      const text = keptText(admission.work, joinSteps(path, step));
      let levels = paths.get(text);
      if (levels === undefined) paths.set(text, (levels = new Set()));
      levels.add(level);
      step = joinSteps(step, ["element"]);
    }
  }
  const into = new Map<PlaceId, InheritedCopy[]>();
  const owned = new Map<PlaceId, Set<string>>();
  const bySource = new Map<PlaceId, InheritedCopy[]>();
  const distinct = new Set<string>();
  for (const copy of admission.a4Inherits) {
    const list = bySource.get(copy.from);
    if (list === undefined) bySource.set(copy.from, [copy]);
    else list.push(copy);
    work.charge("indexSteps");
    const id = keptParts(admission.work, copy.place, copy.path, copy.from, copy.strip);
    if (distinct.has(id)) continue;
    distinct.add(id);
    const own = into.get(copy.place);
    if (own === undefined) into.set(copy.place, [copy]);
    else own.push(copy);
    let paths = owned.get(copy.place);
    if (paths === undefined) owned.set(copy.place, (paths = new Set()));
    paths.add(keptText(admission.work, copy.path));
  }
  const { cycleOf, order } = cyclesOf(bySource, work);
  const cycles = new Map<PlaceId, Set<string>>();
  const fed = new Map<PlaceId, PlaceId>();
  const wholes = new Map<PlaceId, WholeCycle>();
  admission.inherits = { seeds, into, owned, cycleOf, cycles, fed, order, wholes };
  // (whether a live store makes each copy, Astra's B2)
  for (const copy of admission.a4Inherits) {
    const id = keptParts(admission.work, copy.place, copy.path, copy.from, copy.strip);
    if (
      copy.store !== undefined &&
      admission.pass.lists.live(copy.store) &&
      copy.cellsLive !== false
    )
      admission.liveCopies.add(id);
  }
  // a cycle's landed paths, sources before it: a copy from outside it brings its own path and every path landed below
  // its strip, as base; within it a copy brings its source's base paths only, kept base by a whole copy alone, so no
  // path grows by going round (Sol's round 4 B1)
  for (const component of order) {
    const cycle = cycleOf.get(component[0]!);
    if (cycle === undefined) continue;
    const brings = (copy: InheritedCopy, land: (path: readonly string[]) => void): void => {
      land(copy.path);
      for (const text of landedBelow(admission, copy.from, copy.strip)) {
        const steps = splitPath(text);
        if (steps.length > copy.strip.length)
          land(keptSteps(admission.work, copy.path, steps.slice(copy.strip.length)));
      }
    };
    // (a cycle of whole copies: each member's base paths reach every other's whole, so its members land one set, their
    // own, their copies' from outside, and the root each whole copy lands)
    // (fed by whole copies of one place outside it, nothing written of its own: that place's landings, asked of it,
    // Sol's review r2's independent cycles)
    if (wholeCycle(admission, component) && component.every((member) => !seeds.has(member))) {
      const feeding = new Set<PlaceId>();
      let whole = true;
      for (const member of component)
        for (const copy of into.get(member) ?? []) {
          work.charge("indexSteps");
          if (cycleOf.get(copy.from) === cycle) continue;
          feeding.add(copy.from);
          whole &&= copy.path.length === 0 && copy.strip.length === 0;
        }
      if (whole && feeding.size === 1) {
        const source = [...feeding][0]!;
        for (const member of component) fed.set(member, source);
        continue;
      }
    }
    // (a cycle of whole copies lands its copies from outside by reference, never listed: Astra's B3)
    if (wholeCycle(admission, component)) {
      const copies: InheritedCopy[] = [];
      const distinct = new Set<string>();
      const unionSeeds = new Map<string, Set<TypeTerm>>();
      const ownedPaths = new Set<string>([""]);
      for (const member of component) {
        for (const [text, levels] of seeds.get(member) ?? []) {
          work.charge("indexSteps");
          let found = unionSeeds.get(text);
          if (found === undefined) unionSeeds.set(text, (found = new Set()));
          for (const level of levels) found.add(level);
        }
        for (const copy of into.get(member) ?? []) {
          work.charge("indexSteps");
          if (cycleOf.get(copy.from) === cycle) continue;
          const id = keptParts(admission.work, copy.path, copy.from, copy.strip);
          if (distinct.has(id)) continue;
          distinct.add(id);
          copies.push(copy);
          ownedPaths.add(keptText(admission.work, copy.path));
        }
      }
      const whole: WholeCycle = {
        members: [...component],
        copies,
        seeds: unionSeeds,
        owned: ownedPaths,
      };
      for (const member of component) wholes.set(member, whole);
      continue;
    }
    const all = new Map<PlaceId, Set<string>>();
    // (each member's base paths in the order they came, so a copy reads only those it has not read)
    const base = new Map<PlaceId, { readonly paths: Set<string>; readonly list: string[] }>();
    for (const member of component) {
      const own = [...(seeds.get(member)?.keys() ?? [])];
      all.set(member, new Set(own));
      base.set(member, { paths: new Set(own), list: own });
    }
    // a path landed in a member, kept base by a copy that keeps it; whether its base grew
    const land = (member: PlaceId, path: readonly string[], keeps: boolean): boolean => {
      work.charge("indexSteps");
      const text = keptText(admission.work, path);
      all.get(member)!.add(text);
      const kept = base.get(member)!;
      if (!keeps || kept.paths.has(text)) return false;
      kept.paths.add(text);
      kept.list.push(text);
      return true;
    };
    const outgoing = new Map<PlaceId, InheritedCopy[]>();
    for (const member of component)
      for (const copy of into.get(member) ?? []) {
        if (cycleOf.get(copy.from) !== cycle) {
          brings(copy, (path) => land(member, path, true));
          continue;
        }
        const list = outgoing.get(copy.from);
        if (list === undefined) outgoing.set(copy.from, [copy]);
        else list.push(copy);
      }
    // (a member taken again only where its base paths grew; each copy reads its source's from where it stopped)
    const read = new Map<InheritedCopy, number>();
    const queue = [...component];
    const queued = new Set(queue);
    for (let index = 0; index < queue.length; index += 1) {
      const from = queue[index]!;
      queued.delete(from);
      for (const copy of outgoing.get(from) ?? []) {
        const keeps = copy.path.length === 0 && copy.strip.length === 0;
        let grew = land(copy.place, copy.path, keeps);
        const list = base.get(from)!.list;
        for (let at = read.get(copy) ?? 0; at < list.length; at += 1) {
          const steps = splitPath(list[at]!);
          if (steps.length > copy.strip.length && isPrefix(copy.strip, steps))
            grew =
              land(
                copy.place,
                keptSteps(admission.work, copy.path, steps.slice(copy.strip.length)),
                keeps,
              ) || grew;
        }
        read.set(copy, list.length);
        if (grew && !queued.has(copy.place)) {
          queued.add(copy.place);
          queue.push(copy.place);
        }
      }
    }
    for (const member of component) cycles.set(member, all.get(member)!);
  }
  return admission.inherits;
}

/** Whether a cycle of copies holds only whole copies within it (no step added or taken), its members' one landing. */
export function wholeCycle(admission: Admission, component: readonly PlaceId[]): boolean {
  const { into, cycleOf } = inheritance(admission);
  const work = admission.pass.program.work;
  const cycle = cycleOf.get(component[0]!);
  return component.every((member) =>
    (into.get(member) ?? []).every((copy) => {
      work.charge("indexSteps");
      return (
        cycleOf.get(copy.from) !== cycle || (copy.path.length === 0 && copy.strip.length === 0)
      );
    }),
  );
}

/**
 * The copies a place lands through (`landed`, `landedBelow`): its own, or, for a member of a cycle a place outside it
 * feeds (`Inheritance.fed`), one whole copy of that place.
 */
export function copiesOf(admission: Admission, place: PlaceId): readonly InheritedCopy[] {
  const { into, fed, wholes } = inheritance(admission);
  const whole = wholes.get(place);
  if (whole !== undefined) return whole.copies;
  const source = fed.get(place);
  return source === undefined
    ? (into.get(place) ?? [])
    : [{ place, path: [], from: source, strip: [] }];
}

/**
 * Whether copies land a path in a place (`Inheritance`): its own landings, else its copies' sources' landings below
 * their strips, on an explicit stack, each place and path asked once.
 */
export function landed(admission: Admission, place: PlaceId, path: readonly string[]): boolean {
  // (G3 3a: a path past wrappers lands as its frontier's rest lands in the frontier's read's binding, `landedFrontier`)
  if (path.length > 1 && positions()) {
    const frontier = landedFrontier(admission, place, path);
    if (frontier.place !== place)
      return landedOwn(admission, frontier.place, admission.pass.contract.pathSteps(frontier.rest));
  }
  return landedOwn(admission, place, path);
}

/**
 * G3 3a: where a place's path lands past wrappers (`landingHop`): each wrapper whose path goes on below its step lands
 * there what its read's binding lands at the rest; the binding and the rest (a path id) where no wrapper follows. Once
 * per place and path, from its parent's.
 */
function landedFrontier(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
): { readonly place: PlaceId; readonly rest: number } {
  const { contract } = admission.pass;
  const ids: number[] = [contract.pathIdOf(path)];
  for (let id = ids[0]!; !admission.landedFrontiers.has(joinParts(place, id)) && id > 0;) {
    id = contract.pathParent(id);
    ids.push(id);
  }
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    const id = ids[index]!;
    const memoKey = joinParts(place, id);
    if (admission.landedFrontiers.has(memoKey)) continue;
    keepText(admission.work, memoKey.length);
    if (id === 0) {
      admission.landedFrontiers.set(memoKey, { place, rest: 0 });
      continue;
    }
    const above = admission.landedFrontiers.get(joinParts(place, contract.pathParent(id)))!;
    const step = path[contract.pathDepth(id) - 1]!;
    // (a rest of one step goes on below it: its wrapper hands the path on, keeping the new step)
    const hop =
      contract.pathDepth(above.rest) === 1
        ? landingHop(admission, above.place, contract.pathLast(above.rest))
        : null;
    admission.landedFrontiers.set(
      memoKey,
      hop === null
        ? { place: above.place, rest: contract.pathStep(above.rest, step) }
        : { place: hop, rest: contract.pathStep(0, step) },
    );
  }
  return admission.landedFrontiers.get(joinParts(place, ids[0]!))!;
}

/**
 * G3 3a: a wrapper's step as `landed` reads it, or `null`: the place answers through no copy above it and stands in no
 * cycle of copies; of the copies landing in it, one alone lies along a path through `step`, a copy of the wrapper's read
 * at `step` exactly, at its root (`Contract.wrapperHop`); no copy of a written type, and no copy of its own, lands
 * strictly below `step`. So a path through `step` and below it lands in the place as its rest lands in the read's
 * binding (`landedOwn`'s frames). Once per place and step.
 */
function landingHop(admission: Admission, place: PlaceId, step: string): PlaceId | null {
  const memoKey = joinParts(place, step);
  const known = admission.landingHops.get(memoKey);
  if (known !== undefined) return known;
  keepText(admission.work, memoKey.length);
  const { program, contract } = admission.pass;
  const { seeds, owned, cycleOf, fed, wholes } = inheritance(admission);
  program.work.charge("indexSteps");
  const hop = contract.wrapperHop(place, step);
  const binding = hop === null ? undefined : program.occurrenceOf.get(hop.read);
  let found: PlaceId | null = null;
  if (
    binding !== undefined &&
    !cycleOf.has(place) &&
    !fed.has(place) &&
    !wholes.has(place) &&
    passThrough(admission, place, [step]) === place
  ) {
    const steps = landingSteps(admission, place, seeds, owned);
    const along = steps.copies.get(step) ?? [];
    if (
      !steps.whole &&
      along.length === 1 &&
      along[0]!.path.length === 1 &&
      along[0]!.strip.length === 0 &&
      along[0]!.from === binding &&
      !steps.deeper.has(step)
    )
      found = binding;
  }
  admission.landingHops.set(memoKey, found);
  return found;
}

/**
 * A place's landings by their paths' first steps (`landingHop`): whether a copy lands at its root, the copies by their
 * paths' first steps, and the first steps of the paths of two steps or more its written copies and its own copies land
 * at. Once per place.
 */
function landingSteps(
  admission: Admission,
  place: PlaceId,
  seeds: Inheritance["seeds"],
  owned: Inheritance["owned"],
): {
  readonly whole: boolean;
  readonly copies: ReadonlyMap<string, readonly InheritedCopy[]>;
  readonly deeper: ReadonlySet<string>;
} {
  const known = admission.landingSteps.get(place);
  if (known !== undefined) return known;
  const work = admission.pass.program.work;
  let whole = false;
  const copies = new Map<string, InheritedCopy[]>();
  for (const copy of copiesOf(admission, place)) {
    work.charge("indexSteps");
    if (copy.path.length === 0) whole = true;
    else {
      const list = copies.get(copy.path[0]!);
      if (list === undefined) copies.set(copy.path[0]!, [copy]);
      else list.push(copy);
    }
  }
  const deeper = new Set<string>();
  for (const text of [...(seeds.get(place)?.keys() ?? []), ...(owned.get(place) ?? [])]) {
    work.charge("indexSteps");
    if (text.includes(".")) deeper.add(text.slice(0, text.indexOf(".")));
  }
  keep(admission.work, 1 + copies.size + deeper.size);
  const found = { whole, copies, deeper };
  admission.landingSteps.set(place, found);
  return found;
}

/** `landed` itself, for a place and path. */
function landedOwn(admission: Admission, place: PlaceId, path: readonly string[]): boolean {
  const { seeds, owned, cycleOf, cycles, fed, wholes } = inheritance(admission);
  const work = admission.pass.program.work;
  const memo = admission.landedPaths;
  const frames: {
    readonly key: string;
    readonly path: readonly string[];
    readonly copies: readonly InheritedCopy[];
    next: number;
  }[] = [];
  // a place and path's answer where its own landings give it, else its frame, its copies' sources asked one by one;
  // a place that answers through its parent answers as the copy it answers through (`passThrough`)
  const open = (place: PlaceId, steps: readonly string[]): boolean | null => {
    const at = steps.length === 0 ? place : passThrough(admission, place, steps);
    const key = keptParts(admission.work, at, steps);
    const known = memo.get(key);
    if (known !== undefined) return known;
    work.charge("indexSteps");
    const text = pathText(steps);
    const whole = wholes.get(at);
    const found =
      cycleOf.has(at) && !fed.has(at) && whole === undefined
        ? cycles.get(at)!.has(text)
        : (whole?.seeds ?? seeds.get(at))?.has(text) === true ||
          (whole?.owned ?? owned.get(at))?.has(text) === true ||
          (fed.has(at) && steps.length === 0) ||
          null;
    if (found !== null) memo.set(key, found);
    // (its copies above the path, looked up by its prefixes, Astra's review r2 B2)
    else
      frames.push({ key, path: steps, copies: copiesAlong(admission, at, steps, false), next: 0 });
    return found;
  };
  const first = open(place, path);
  if (first !== null) return first;
  const key = frames[0]!.key;
  let answer: boolean | null = null;
  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    if (answer === true) {
      memo.set(frame.key, true);
      frames.pop();
      continue;
    }
    if (frame.next >= frame.copies.length) {
      memo.set(frame.key, false);
      frames.pop();
      answer = false;
      continue;
    }
    const copy = frame.copies[frame.next++]!;
    answer = open(
      copy.from,
      keptSteps(admission.work, copy.strip, frame.path.slice(copy.path.length)),
    );
  }
  return memo.get(key)!;
}

/**
 * The paths copies land in a place at or below `prefix` (`Inheritance`), each once: its own landings and, through each
 * copy, its source's at or below the copy's strip, written where the copy lands them; on an explicit stack, each
 * source, prefix and way of writing its paths once.
 */
export function landedBelow(
  admission: Admission,
  place: PlaceId,
  prefix: readonly string[],
): string[] {
  const { cycleOf, fed, wholes } = inheritance(admission);
  const work = admission.pass.program.work;
  const out = new Set<string>();
  const seen = new Set<string>();
  // a task: a place, the prefix its paths are taken at or below, and how its path is written in the place asked:
  // its first `drop` steps replaced by `prepend`
  const tasks: {
    readonly place: PlaceId;
    readonly below: readonly string[];
    readonly drop: number;
    readonly prepend: readonly string[];
  }[] = [{ place, below: prefix, drop: 0, prepend: [] }];
  while (tasks.length > 0) {
    const task = tasks.pop()!;
    const id = keptParts(admission.work, task.place, task.below, task.drop, task.prepend);
    if (seen.has(id)) continue;
    seen.add(id);
    const add = (path: readonly string[]): void => {
      if (isPrefix(task.below, path))
        out.add(keptText(admission.work, joinSteps(task.prepend, path.slice(task.drop))));
    };
    const emit = (path: readonly string[]): void => {
      work.charge("indexSteps");
      add(path);
    };
    // (a place that lands through its parent lands its root and what the copy it lands through does, `landsThrough`)
    const through = landsThrough(admission, task.place, task.below);
    if (through !== task.place) {
      emit([]);
      tasks.push({ ...task, place: through });
      continue;
    }
    // (a cycle's landed paths, and the copies at, above or below the prefix, from indexes by path: never every one
    // for each prefix, Astra's review r2 B2)
    if (cycleOf.has(task.place) && !fed.has(task.place) && !wholes.has(task.place)) {
      const landing = cycleLanding(admission, task.place);
      for (const path of landing.under.get(keptText(admission.work, task.below)) ?? []) emit(path);
      continue;
    }
    // (a cycle of whole copies lands its root)
    if (wholes.has(task.place) && task.below.length === 0) emit([]);
    for (const text of seedsUnder(admission, task.place, task.below)) emit(splitPath(text));
    for (const copy of copiesAlong(admission, task.place, task.below, true)) {
      add(copy.path);
      // (the source's paths at or below the strip, those the prefix asks for)
      const below = isPrefix(copy.path, task.below)
        ? keptSteps(admission.work, copy.strip, task.below.slice(copy.path.length))
        : isPrefix(task.below, copy.path)
          ? copy.strip
          : null;
      if (below === null) continue;
      tasks.push(
        task.drop <= copy.path.length
          ? {
              place: copy.from,
              below,
              drop: copy.strip.length,
              prepend: keptSteps(admission.work, task.prepend, copy.path.slice(task.drop)),
            }
          : {
              place: copy.from,
              below,
              drop: copy.strip.length + task.drop - copy.path.length,
              prepend: task.prepend,
            },
      );
    }
  }
  return [...out];
}

/** The members of a place's cycle of copies (`Inheritance.order`), once per pass. */
export function membersOf(admission: Admission, place: PlaceId): readonly PlaceId[] {
  const { cycleOf, order } = inheritance(admission);
  if (admission.cycleMembers === null) {
    admission.cycleMembers = new Map();
    for (const component of order) {
      admission.pass.program.work.charge("indexSteps");
      const cycle = cycleOf.get(component[0]!);
      if (cycle !== undefined) admission.cycleMembers.set(cycle, [...component]);
    }
  }
  return admission.cycleMembers.get(cycleOf.get(place)!) ?? [place];
}

/** Entries by path (`ByPath`): each under every prefix of its path, its own text included, and at its path. */
export function byPath<T>(
  admission: Admission,
  entries: readonly T[],
  pathOf: (entry: T) => readonly string[],
): ByPath<T> {
  if (entries.length === 0) return NO_PATHS;
  const work = admission.pass.program.work;
  const under = new Map<string, T[]>();
  const at = new Map<string, T[]>();
  const put = (map: Map<string, T[]>, text: string, entry: T): void => {
    const list = map.get(text);
    if (list === undefined) map.set(text, [entry]);
    else list.push(entry);
  };
  for (const entry of entries) {
    const path = pathOf(entry);
    let text = "";
    for (let length = 0; length <= path.length; length += 1) {
      work.charge("indexSteps");
      text = keptText(admission.work, path.slice(0, length));
      put(under, text, entry);
    }
    put(at, text, entry);
  }
  return { under, at };
}

/** A place's copies (`copiesOf`) with their positions by path (`ByPath`), once per place. */
function copyIndex(
  admission: Admission,
  place: PlaceId,
): { readonly list: readonly InheritedCopy[]; readonly index: ByPath<number> } {
  let found = admission.copyIndexes.get(place);
  if (found === undefined) {
    const list = copiesOf(admission, place);
    const positions = list.map((_, position) => position);
    found = { list, index: byPath(admission, positions, (position) => list[position]!.path) };
    admission.copyIndexes.set(place, found);
  }
  return found;
}

/**
 * A place's copies whose paths stand above a path (strictly), and with `under` those at or below it too, in the
 * copies' order (`landed`, `landedBelow`): the path's prefixes looked up, never every copy for each path, or the
 * copies tested where they are no more than the prefixes; each copy taken or tested charged here.
 */
function copiesAlong(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
  under: boolean,
): readonly InheritedCopy[] {
  const work = admission.pass.program.work;
  const copies = copiesOf(admission, place);
  if (copies.length <= path.length + 1) {
    // (no more copies than the path has prefixes: each tested, as cheap as the lookups)
    const out: InheritedCopy[] = [];
    for (const copy of copies) {
      work.charge("indexSteps");
      if (
        (copy.path.length < path.length && isPrefix(copy.path, path)) ||
        (under && isPrefix(path, copy.path))
      )
        out.push(copy);
    }
    return out;
  }
  const { list, index } = copyIndex(admission, place);
  const positions: number[] = [];
  for (let length = 0; length <= path.length; length += 1) {
    work.charge("indexSteps");
    const text = keptText(admission.work, path.slice(0, length));
    const found =
      length < path.length ? index.at.get(text) : under ? index.under.get(text) : undefined;
    for (const position of found ?? []) {
      work.charge("indexSteps");
      positions.push(position);
    }
  }
  if (positions.length > 1) {
    work.charge("indexSteps", sortCost(positions.length));
    positions.sort((a, b) => a - b);
  }
  return positions.map((position) => list[position]!);
}

/** A member of a cycle of copies' landed paths by path (`Inheritance.cycles`, `landedBelow`), once per landing. */
function cycleLanding(admission: Admission, place: PlaceId): ByPath<readonly string[]> {
  const landing = inheritance(admission).cycles.get(place)!;
  let found = admission.cycleLandings.get(landing);
  if (found === undefined) {
    const paths: (readonly string[])[] = [];
    for (const text of landing) paths.push(keptSplit(admission.work, text));
    admission.cycleLandings.set(landing, (found = byPath(admission, paths, (path) => path)));
  }
  return found;
}

/** A place's seeds' paths at or below a prefix (`Inheritance.seeds`), from an index of every seed's prefixes. */
function seedsUnder(
  admission: Admission,
  place: PlaceId,
  prefix: readonly string[],
): readonly string[] {
  const inherits = inheritance(admission);
  const own = inherits.wholes.get(place)?.seeds ?? inherits.seeds.get(place);
  if (own === undefined) return [];
  let index = admission.seedIndex.get(place);
  if (index === undefined) {
    admission.seedIndex.set(place, (index = new Map()));
    for (const text of own.keys()) {
      const steps = keptSplit(admission.work, text);
      for (let length = 0; length <= steps.length; length += 1) {
        admission.pass.program.work.charge("indexSteps");
        const at = keptText(admission.work, steps.slice(0, length));
        const list = index.get(at);
        if (list === undefined) index.set(at, [text]);
        else list.push(text);
      }
    }
  }
  return index.get(pathText(prefix)) ?? [];
}
