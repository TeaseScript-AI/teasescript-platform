import type { PlaceId, TypeTerm } from "../../../graph.js";
import type { Admission } from "../../admission.js";
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
  type WorkLedger,
} from "../../budget.js";
import { writtenOf } from "../../contract.js";
import { type Steps, stepsPrefixText } from "../../contract/key-ids.js";
import { keptKey, type Key, keyOf, keyPath, keyPlace, sortCost } from "../../definitions.js";
import type {
  ByPath,
  CopyForest,
  Inheritance,
  InheritedCopy,
  LandingTask,
  Listing,
  ListingNode,
  Storing,
  TapePoint,
  WholeCycle,
} from "../model.js";
import { levelsOf } from "../permitted.js";
import { Retained } from "../../retained/retained.js";

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
function isPrefix(prefix: Steps, path: Steps): boolean {
  if (prefix.length > path.length) return false;
  for (let index = 0; index < prefix.length; index += 1)
    if (path.at(index) !== prefix.at(index)) return false;
  return true;
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
export function nearest(
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
export function copyForest(admission: Admission): CopyForest {
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
 * The reporter's operations (#1428): each growing one debited `indexSteps` through `debit`, and, under
 * `withLandingOps`, counted apart where it happens, so a debit missing at one site shows against its own count.
 */
export type LandingOp = "report" | "child" | "select" | "visit" | "node" | "lookup" | "publish";

/** Test-only: per `landedBelow` call, each operation's count where it happens and its units debited. */
export interface LandingOps {
  readonly ops: Record<LandingOp, number>;
  readonly debited: Record<LandingOp, number>;
  /** The units the call charged the pass's work. */
  units: number;
  /**
   * The slots the call left retained (`census`): its tape and each listing it kept or left pending, every object once,
   * and the trie nodes it made.
   */
  retained: number;
  /** The listings the call kept or left pending (`census`). */
  readonly kept: Listing[];
  /** The trie nodes the call made (`Admission.listings`), roots and prefixes. */
  trieNodes: number;
}

/**
 * The slots a call's retained state holds, every object counted once: its tape (per path its steps and four, per
 * repeat three, each index node one), and per listing one, three per point, one per child, and per task (a frame, a
 * child's or one a `parent` reaches) four and its steps.
 */
function census(tape: LandingTape, listings: readonly Listing[]): number {
  const counted = new Set<object>();
  let slots =
    tape.paths.reduce((sum, path) => sum + path.length + 4, 0) +
    3 * tape.at.length +
    tape.levels.slice(1).reduce((sum, level) => sum + level.length, 0);
  const point = (at: TapePoint): void => {
    if (counted.has(at)) return;
    counted.add(at);
    slots += 3;
  };
  const task = (start: LandingTask): void => {
    for (
      let at: LandingTask | undefined = start;
      at !== undefined && !counted.has(at);
      at = at.parent
    ) {
      counted.add(at);
      slots += 4 + at.below.length + at.prepend.length;
    }
  };
  for (const listing of listings) {
    slots += 1;
    point(listing.from);
    point(listing.own);
    point(listing.to);
    task(listing.frame);
    for (const child of listing.children) {
      slots += 1;
      point(child.from);
      task(child.task);
    }
  }
  return slots;
}

/** Each operation at 0. */
function noOps(): Record<LandingOp, number> {
  return { report: 0, child: 0, select: 0, visit: 0, node: 0, lookup: 0, publish: 0 };
}
let opsHook: ((place: PlaceId, prefix: readonly string[], ops: LandingOps) => void) | null = null;
let currentOps: LandingOps | null = null;

/** Counts `units` of `op` where it happens (test-only, `withLandingOps`). */
function happened(op: LandingOp, units = 1): void {
  if (currentOps !== null) currentOps.ops[op] += units;
}

/** Debits `units` of `op` to the pass's work. */
function debit(work: WorkLedger, op: LandingOp, units = 1): void {
  work.charge("indexSteps", units);
  if (currentOps !== null) currentOps.debited[op] += units;
}

/**
 * Test-only: runs `callback` with each `landedBelow` call's operations, counted where they happen and as debited, given
 * to `onCall` (calls made inside another, as `inheritance`'s, counted apart).
 */
export function withLandingOps<T>(
  onCall: (place: PlaceId, prefix: readonly string[], ops: LandingOps) => void,
  callback: () => T,
): T {
  if (opsHook !== null) throw new Error("Landing operations are already counted.");
  opsHook = onCall;
  try {
    return callback();
  } finally {
    opsHook = null;
  }
}

/** Test-only: what `withLandingComparison` gives each `landedBelow` call, the listings' result beside the walk's. */
let comparison:
  | ((
      place: PlaceId,
      prefix: readonly string[],
      listed: readonly string[],
      walked: readonly string[],
      units: { readonly listed: number; readonly walked: number },
    ) => void)
  | null = null;

/**
 * Test-only: runs `callback` with every `landedBelow` call also walked without the pass's listings (as `main` walks),
 * that walk's work counted apart, and both results given to `onCall`: the oracle that a taken listing gives the paths,
 * in their order, that the walk finds.
 */
export function withLandingComparison<T>(
  onCall: (
    place: PlaceId,
    prefix: readonly string[],
    listed: readonly string[],
    walked: readonly string[],
    units: { readonly listed: number; readonly walked: number },
  ) => void,
  callback: () => T,
): T {
  if (comparison !== null) throw new Error("Landings are already compared.");
  comparison = onCall;
  try {
    return callback();
  } finally {
    comparison = null;
  }
}

/**
 * One `landedBelow` call's tape (#1428): the paths it brought, each by its index in the order first brought, and the
 * order its walk met them as events, one per first bring and one per repeat (a path met again where its last event
 * lies before the innermost open record). A listing is two points of it; nothing of it is copied. First brings are
 * never indexed: in any range they are its new paths, one run of indexes. Repeats keep the position of their path's
 * event before them (`prev`), and a min index over those (`levels`: level h the least `prev` of each complete aligned
 * block of 2^h repeats) answers which repeats in a range are their path's first event there.
 */
export class LandingTape {
  readonly paths: (readonly string[])[] = [];
  readonly texts: string[] = [];
  /** Per path, the position of its first event and of the last one appended. */
  readonly first: number[] = [];
  readonly last: number[] = [];
  events = 0;
  /** Per repeat, its position, its path and its path's event before it. */
  readonly at: number[] = [];
  readonly path: number[] = [];
  readonly prev: number[] = [];
  readonly levels: number[][] = [this.prev];

  private readonly work: WorkLedger;

  public constructor(work: WorkLedger) {
    this.work = work;
    Retained.owner(this, "LandingTape");
  }

  /** The tape's point now. */
  public point(): TapePoint {
    return { events: this.events, paths: this.texts.length, repeats: this.at.length };
  }

  /** A path first brought: its index. */
  public bring(steps: readonly string[], text: string): number {
    const index = this.texts.length;
    this.paths.push(steps);
    this.texts.push(text);
    this.first.push(this.events);
    this.last.push(this.events);
    this.events += 1;
    return index;
  }

  /** A path met again: a repeat event, each block it completes a node of the min index. */
  public repeat(index: number): void {
    this.at.push(this.events);
    this.path.push(index);
    this.prev.push(this.last[index]!);
    this.last[index] = this.events;
    this.events += 1;
    for (let h = 1; this.levels[h - 1]!.length % 2 === 0; h += 1) {
      const below = this.levels[h - 1]!;
      if (this.levels.length === h) this.levels.push([]);
      happened("node");
      debit(this.work, "node");
      this.levels[h]!.push(Math.min(below.at(-2)!, below.at(-1)!));
    }
  }

  /**
   * The paths whose first event within `from` to `to` lies there, in the order of those events: the range's new paths
   * merged with its repeats whose path's event before them lies before the range. The repeats' side walks the range's
   * complete aligned blocks left to right and descends only where a block's least `prev` lies before the range.
   */
  public reports(from: TapePoint, to: TapePoint): number[] {
    const start = from.events;
    const found: number[] = [];
    const descend = (h: number, block: number, selected: boolean): void => {
      const least = this.levels[h]![block]!;
      // (a reported repeat rides its report's debit; every other node looked at is debited)
      if (!selected && !(h === 0 && least < start)) {
        happened("visit");
        debit(this.work, "visit");
      }
      if (least >= start) return;
      if (h === 0) found.push(block);
      else {
        descend(h - 1, 2 * block, false);
        descend(h - 1, 2 * block + 1, false);
      }
    };
    for (let low = from.repeats; low < to.repeats;) {
      // (the largest block aligned at `low` within the range, at once: its trailing zeros, the range's length's log)
      const aligned = low === 0 ? 31 : 31 - Math.clz32(low & -low);
      const h = Math.min(aligned, 31 - Math.clz32(to.repeats - low));
      happened("select");
      debit(this.work, "select");
      descend(h, low >> h, true);
      low += 1 << h;
    }
    const out: number[] = [];
    let next = from.paths;
    let taken = 0;
    while (next < to.paths || taken < found.length) {
      if (taken >= found.length || (next < to.paths && this.first[next]! < this.at[found[taken]!]!))
        out.push(next++);
      else out.push(this.path[found[taken++]!]!);
    }
    return out;
  }
}

/**
 * The paths copies land in a place at or below `prefix` (`Inheritance`), each once: its own landings and, through each
 * copy, its source's at or below the copy's strip, written where the copy lands them; on an explicit stack, each
 * source, prefix and way of writing its paths once. Where an earlier call of the pass listed a place and prefix the walk
 * reaches, it takes that listing as the walk would bring it (`walkLandings`, #1428, #1547).
 */
export function landedBelow(
  admission: Admission,
  place: PlaceId,
  prefix: readonly string[],
): string[] {
  const work = admission.pass.program.work;
  const outer = currentOps;
  currentOps =
    opsHook === null
      ? null
      : { ops: noOps(), debited: noOps(), units: 0, retained: 0, kept: [], trieNodes: 0 };
  const counts = currentOps;
  const before = work.total;
  try {
    const listing = walkLandings(admission, place, prefix, true);
    // (kept when a later walk first looks at its place, so a place no walk reaches costs nothing more: #1670's chain)
    const pending = admission.pendingListings.get(place);
    if (pending === undefined) admission.pendingListings.set(place, [listing]);
    else pending.push(listing);
    const texts = [...listing.tape.texts];
    if (counts !== null) {
      counts.units = work.total - before;
      counts.retained += census(listing.tape, [listing, ...counts.kept]);
    }
    if (comparison !== null) {
      currentOps = null;
      const apart = (): number => [...work.apartCounts().values()].reduce((a, b) => a + b, 0);
      const from = apart();
      const walked = work.apart(() => [
        ...walkLandings(admission, place, prefix, false).tape.texts,
      ]);
      comparison(place, prefix, texts, walked, {
        listed: work.total - before,
        walked: apart() - from,
      });
    }
    if (opsHook !== null && counts !== null) opsHook(place, prefix, counts);
    return texts;
  } finally {
    currentOps = outer;
  }
}

/** A listing kept for its place and prefix, for the pass (`Admission.listings`): each trie node walked or made debited. */
function keepListing(admission: Admission, listing: Listing): void {
  const work = admission.pass.program.work;
  happened("publish");
  debit(work, "publish");
  let node: ListingNode | undefined = admission.listings.get(listing.frame.place);
  if (node === undefined) {
    admission.listings.set(listing.frame.place, (node = { listing: null, next: new Map() }));
    madeNode();
  }
  for (const step of listing.frame.below) {
    happened("publish");
    debit(work, "publish");
    let next: ListingNode | undefined = node.next.get(step);
    if (next === undefined) {
      node.next.set(step, (next = { listing: null, next: new Map() }));
      madeNode();
    }
    node = next;
  }
  node.listing = listing;
}

/**
 * A place's listings (`Admission.listings`), the calls' results asked of it kept first, in the order they were made
 * (`landedBelow`), each debited as its keeping; `undefined` where it has none.
 */
function trieOf(admission: Admission, place: PlaceId): ListingNode | undefined {
  const pending = admission.pendingListings.get(place);
  if (pending !== undefined) {
    admission.pendingListings.delete(place);
    for (const listing of pending) keepListing(admission, listing);
  }
  return admission.listings.get(place);
}

/** A trie node made, a place's root or a prefix's (test-only, `withLandingOps`: one retained slot each). */
function madeNode(): void {
  if (currentOps === null) return;
  currentOps.retained += 1;
  currentOps.trieNodes += 1;
}

/** The listing of a place's node at `below`, or `null`: each trie node walked debited. */
function lookup(work: WorkLedger, node: ListingNode, below: readonly string[]): Listing | null {
  let at: ListingNode | undefined = node;
  happened("lookup");
  debit(work, "lookup");
  for (const step of below) {
    happened("lookup");
    debit(work, "lookup");
    at = at.next.get(step);
    if (at === undefined) return null;
  }
  return at.listing;
}

/**
 * How a listing's path is written where `task` writes: `prepend`, then the path from `cut` (the listing's frame and the
 * task's composed, as a task's push composes them).
 */
function writing(
  admission: Admission,
  from: Listing,
  task: LandingTask,
): { readonly prepend: readonly string[]; readonly cut: number } {
  const { below, drop, prepend } = from.frame;
  return task.drop <= drop
    ? {
        prepend: keptSteps(admission.work, task.prepend, below.slice(task.drop, drop)),
        cut: prepend.length,
      }
    : { prepend: task.prepend, cut: prepend.length + task.drop - drop };
}

/** A task of a listing written where `written` writes, as the walk taking it writes it. */
function writtenTask(
  admission: Admission,
  written: { readonly prepend: readonly string[]; readonly cut: number },
  task: LandingTask,
): LandingTask {
  return written.cut <= task.prepend.length
    ? {
        ...task,
        prepend: keptSteps(admission.work, written.prepend, task.prepend.slice(written.cut)),
      }
    : { ...task, drop: task.drop + written.cut - task.prepend.length, prepend: written.prepend };
}

/**
 * `landedBelow`'s walk, taking the pass's listings where `listed`. A task's walk ends before anything under it, so what
 * it brings is one range of the call's tape: a record (the call's root, and each longer prefix of a place with
 * listings) keeps its range, its own paths' and each child's, as a listing, where nothing in it was skipped as walked
 * before it opened (`least` against `mark`, both task orders). A task with a listing takes it: its own range, then each
 * child neither walked nor covered, its range; each child it brings is then covered at the taking task's order (R3): a
 * later step skips it as it skips a walked task, at that order, so a cover from before a record opened breaks it.
 */
function walkLandings(
  admission: Admission,
  place: PlaceId,
  prefix: readonly string[],
  listed: boolean,
): Listing {
  const { cycleOf, fed, wholes } = inheritance(admission);
  const work = admission.pass.program.work;
  const tape = new LandingTape(work);
  // (per text its path's index; per task id its order, and per task a take brought its taker's order)
  const out = new Map<string, number>();
  const seen = new Map<string, number>();
  const covered = new Map<string, number>();
  const root: LandingTask = { place, below: prefix, drop: 0, prepend: [] };
  const tasks: (LandingTask | null)[] = [root];
  interface Record {
    readonly task: LandingTask;
    readonly start: TapePoint;
    readonly mark: number;
    least: number;
    own: TapePoint | null;
    readonly children: { readonly task: LandingTask; readonly from: TapePoint }[];
  }
  // the open records, innermost last, and each by its task
  const records: Record[] = [];
  const recordOf = new Map<LandingTask, Record>();
  const open = (task: LandingTask): void => {
    const record: Record = {
      task,
      start: tape.point(),
      mark: seen.size - 1,
      least: Infinity,
      own: null,
      children: [],
    };
    records.push(record);
    recordOf.set(task, record);
  };
  const close = (record: Record): Listing => {
    recordOf.delete(record.task);
    const to = tape.point();
    return {
      tape,
      frame: record.task,
      from: record.start,
      own: record.own ?? to,
      children: record.children,
      to,
    };
  };
  const put = (steps: readonly string[], text: string): void => {
    const index = out.get(text);
    if (index === undefined) out.set(text, tape.bring(steps, text));
    // (a path whose last event lies before the innermost record is that record's too: R2)
    else if (tape.last[index]! < records.at(-1)!.start.events) tape.repeat(index);
  };
  // whether a task is to be skipped here: walked in this call, or brought by a take (its paths are all brought), a
  // skip at its order or its taker's; one before the innermost record opened breaks that record (`least`)
  const skipped = (id: string): boolean => {
    const at = seen.get(id) ?? covered.get(id);
    if (at === undefined) return false;
    const record = records.at(-1)!;
    record.least = Math.min(record.least, at);
    return true;
  };
  // a listing's paths written where `task` writes, each report and child step debited before anything is suppressed
  const take = (listing: Listing, task: LandingTask): void => {
    const written = writing(admission, listing, task);
    const report = (from: TapePoint, to: TapePoint): void => {
      for (const index of listing.tape.reports(from, to)) {
        happened("report");
        debit(work, "report");
        const steps = joinSteps(written.prepend, listing.tape.paths[index]!.slice(written.cut));
        put(steps, keptText(admission.work, steps));
      }
    };
    report(listing.from, listing.own);
    listing.children.forEach((child, position) => {
      happened("child");
      debit(work, "child");
      const moved = writtenTask(admission, written, child.task);
      const id = keptParts(admission.work, moved.place, moved.below, moved.drop, moved.prepend);
      if (skipped(id)) return;
      report(child.from, listing.children[position + 1]?.from ?? listing.to);
      covered.set(id, seen.size - 1);
    });
  };
  open(root);
  while (tasks.length > 0) {
    const task = tasks.pop()!;
    if (task === null) {
      const record = records.pop()!;
      // (a skip inside it is a skip inside the record around it)
      const outer = records.at(-1);
      if (outer !== undefined) outer.least = Math.min(outer.least, record.least);
      if (record.least >= record.mark) {
        const listing = close(record);
        keepListing(admission, listing);
        currentOps?.kept.push(listing);
      } else recordOf.delete(record.task);
      continue;
    }
    // (a child of an open record's root: its paths and tasks start here)
    const parent = task.parent === undefined ? undefined : recordOf.get(task.parent);
    if (parent !== undefined) {
      parent.own ??= tape.point();
      parent.children.push({ task, from: tape.point() });
    }
    const id = keptParts(admission.work, task.place, task.below, task.drop, task.prepend);
    if (skipped(id)) continue;
    seen.set(id, seen.size);
    const add = (path: readonly string[]): void => {
      if (!isPrefix(task.below, path)) return;
      const steps = joinSteps(task.prepend, path.slice(task.drop));
      put(steps, keptText(admission.work, steps));
    };
    const emit = (path: readonly string[]): void => {
      work.charge("indexSteps");
      add(path);
    };
    // (a place without listings walks as before: no trie is looked at, #1670's chain)
    const node = listed && task !== root ? trieOf(admission, task.place) : undefined;
    const known = node === undefined ? null : lookup(work, node, task.below);
    if (known !== null) {
      take(known, task);
      continue;
    }
    // (a place that lands through its parent lands its root and what the copy it lands through does, `landsThrough`)
    const through = landsThrough(admission, task.place, task.below);
    if (through !== task.place) {
      emit([]);
      tasks.push({ ...task, place: through, parent: task });
      continue;
    }
    // (a cycle's landed paths, and the copies at, above or below the prefix, from indexes by path: never every one
    // for each prefix, Astra's review r2 B2)
    if (cycleOf.has(task.place) && !fed.has(task.place) && !wholes.has(task.place)) {
      const landing = cycleLanding(admission, task.place);
      for (const path of landing.under.get(keptText(admission.work, task.below)) ?? []) emit(path);
      continue;
    }
    // (a longer prefix of a place a call asked: this walk kept as its listing)
    if (node !== undefined && task.below.length > 0) {
      open(task);
      tasks.push(null);
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
              parent: task,
            }
          : {
              place: copy.from,
              below,
              drop: copy.strip.length + task.drop - copy.path.length,
              prepend: task.prepend,
              parent: task,
            },
      );
    }
  }
  return close(records.pop()!);
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
 * copies tested where they are no more than the prefixes; each copy taken or tested charged here. Without `under`
 * (`landed`), a prefix's copies only where their sources may land the path (`nextStepCopies`); `landedBelow`'s walk
 * keeps every one, its listings recording the tasks it walks.
 */
export function copiesAlong(
  admission: Admission,
  place: PlaceId,
  path: Steps,
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
    // (a record's prefixes spelled by their record, charged as `keptText` charges an array's)
    const text = stepsPrefixText(path, length);
    keepText(admission.work, text.length);
    const at = length < path.length ? index.at.get(text) : undefined;
    const found =
      at !== undefined && !under
        ? nextStepCopies(admission, place, list, text, at, path.at(length)!)
        : length < path.length
          ? at
          : under
            ? index.under.get(text)
            : undefined;
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

/**
 * #1948: of a place's copies at a path (`bucket`, their positions in its copy list), those strictly above a longer path
 * `landed` asks, whose next step past the bucket's path is `step`, that may land it: those whose sources land past
 * their strips at `step` (`sourceSteps`), and each one whose source's landings are not proved; in the copies' order.
 * A copy left out has a source that lands nothing at its translated path, so `landedOwn`'s frame would take it to a
 * `false`: no answer changes, only the copies tried. The bucket's first scan, and each later one until its scans reach
 * the index's size (its copies and their sources' seeds), takes every copy, as before; the index lasts its receiving
 * domain's admission (`ReceivingDomain.reset`).
 */
function nextStepCopies(
  admission: Admission,
  place: PlaceId,
  list: readonly InheritedCopy[],
  text: string,
  bucket: readonly number[],
  step: string,
): readonly number[] {
  // (a step holding the separator: landings' texts do not split at its name)
  if (step.includes(".")) return bucket;
  const domain = admission.pass.receivingDomain;
  const work = admission.pass.program.work;
  const key = joinParts(place, text);
  let state = domain.nextSteps.get(key);
  if (state === undefined) {
    keepText(admission.work, key.length);
    keep(admission.work, 1);
    domain.nextSteps.set(key, (state = { scans: 0, size: -1, next: null, any: [] }));
  }
  if (state.next === null) {
    state.scans += 1;
    if (state.scans === 1) return bucket;
    if (state.size < 0) {
      const { seeds } = inheritance(admission);
      let size = bucket.length;
      for (const position of bucket) {
        work.charge("indexSteps");
        size += seeds.get(list[position]!.from)?.size ?? 0;
      }
      state.size = size;
    }
    if (state.scans * bucket.length < state.size) return bucket;
    const next = new Map<string, number[]>();
    const any: number[] = [];
    for (const position of bucket) {
      work.charge("indexSteps");
      const copy = list[position]!;
      const steps = sourceSteps(admission, copy.from, copy.strip);
      keep(admission.work, steps === null ? 1 : steps.size);
      if (steps === null) any.push(position);
      else
        for (const at of steps) {
          const along = next.get(at);
          if (along === undefined) next.set(at, [position]);
          else along.push(position);
        }
    }
    keep(admission.work, next.size);
    state.next = next;
    state.any = any;
  }
  const along = state.next.get(step) ?? [];
  const any = state.any;
  if (any.length === 0) return along;
  if (along.length === 0) return any;
  // (both in the copies' order: merged, each position charged where `copiesAlong` takes it)
  keep(admission.work, along.length + any.length);
  const out: number[] = [];
  for (let i = 0, j = 0; i < along.length || j < any.length;)
    out.push(
      j >= any.length || (i < along.length && along[i]! < any[j]!) ? along[i++]! : any[j++]!,
    );
  return out;
}

/**
 * #1948: the first steps past `strip` of a source's landings, where they are proved to be its seeds alone: a place in
 * no cycle of copies, no copy landing in it, and answering through no other (`passThrough`), so `landedOwn` answers a
 * path in it by its seeds alone; `null` for any other place, each copy of which is taken. Once per source and strip.
 */
function sourceSteps(
  admission: Admission,
  source: PlaceId,
  strip: readonly string[],
): ReadonlySet<string> | null {
  const domain = admission.pass.receivingDomain;
  const prefix = keptText(admission.work, strip);
  const key = joinParts(source, prefix);
  const known = domain.sourceSteps.get(key);
  if (known !== undefined) return known;
  keepText(admission.work, key.length);
  const { seeds, owned, cycleOf, fed, wholes } = inheritance(admission);
  const work = admission.pass.program.work;
  work.charge("indexSteps");
  let found: Set<string> | null = null;
  if (
    !cycleOf.has(source) &&
    !fed.has(source) &&
    !wholes.has(source) &&
    copiesOf(admission, source).length === 0 &&
    (owned.get(source)?.size ?? 0) === 0 &&
    !copyForest(admission).parent.has(source)
  ) {
    found = new Set();
    for (const text of seeds.get(source)?.keys() ?? []) {
      work.charge("indexSteps");
      // (a seed strictly below the strip: its step past it)
      if (strip.length === 0 ? text === "" : !text.startsWith(`${prefix}.`)) continue;
      found.add(
        keptSplit(admission.work, strip.length === 0 ? text : text.slice(prefix.length + 1))[0]!,
      );
    }
  }
  domain.sourceSteps.set(key, found);
  return found;
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
