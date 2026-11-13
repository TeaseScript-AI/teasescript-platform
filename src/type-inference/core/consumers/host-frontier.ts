// The finishing read's host frontier (`finishing.ts`): what stands at each path of a place by its own stores'
// structure, the bounded walk over the copies standing there, and the host data a read reaches through them.

import type { PlaceId } from "../../graph.js";
import { expand, partOf } from "../admission/walk.js";
import type { Expansion, Part } from "../admission/model.js";
import { joinSteps, keptSteps, type WorkLedger } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { unknownItem } from "../contract.js";
import { keptPath, keyPath, keyPlace, type Definition } from "../definitions.js";
import type { FlowNode } from "../flow-graph.js";
import { ingressLeaves, REASON, type IngressNode, type Item } from "../items.js";
import { dictList } from "../method-categories.js";
import { stepName } from "../program.js";
import { FRONTIER_COPIES, FRONTIER_DEPTH } from "./model.js";
import { readKey } from "./names.js";
import { openness, prefixAt } from "./written-openness.js";

/** A place's stored paths, as a trie of their steps: each node with the stores whose values stand at its path. */
interface StoreNode {
  readonly children: Map<string, StoreNode>;
  /** Each store there (an add's at its receiver's element), and whether its value's elements stand there (`addAll`). */
  readonly stores: { readonly d: Definition; readonly elements: boolean }[];
}

/** A copy standing at a path: the read it copies, and the steps below that read it stands at. */
interface CopyTask {
  readonly value: PlaceId;
  readonly strip: readonly string[];
}

/**
 * What stands at a frontier's path beside its own content, each followed as a copy: a copy task, or, at a `values` step,
 * the frontier one step above, a dictionary whose `values` list's element is its own (#1452).
 */
type Standing = CopyTask | { readonly values: HostFrontier };

/**
 * What stands at a path of a place by its own stores' structure, made once from its owner path's by one step (as the
 * syntax decision's frontier is, `cheapFrontier`): the literal cells of the values there by the step that enters them
 * (admission's store walk, `expand`), the node of the place's stored paths there, the copies standing there, and the
 * host data standing there or above it. What its copies hold is reached by a read's bounded walk (`explore`): the copies
 * standing at a frontier's path are its own and its owner path's, one step below. A copy's frontier holds what its stores
 * hold whatever decision of its place stopped, as the copy's value does (#1560): the stop alone is the read's own
 * key's (`heldIngress`).
 */
interface HostFrontier {
  readonly cells: Map<string, Part[]>;
  readonly node: StoreNode | null;
  readonly copies: Standing[];
  host: IngressNode | undefined;
  /** Its owner path's frontier and the step below it, whose copies stand here one step below; `null` at a root. */
  readonly owner: { readonly frontier: HostFrontier; readonly step: string } | null;
  readonly steps: Map<string, HostFrontier>;
  /** What it stands for as far as followed (`sameOf`): itself, or the copy it holds alone, or one further down. */
  same: HostFrontier | undefined;
  /**
   * Whether it is a value's own frontier, one no place holds (`ownFrontier`), or a step below one: there an operand no
   * place holds is linked, never entered again (`enterValues`).
   */
  readonly own: boolean;
  /** The copies standing at levels above it (its owner path's, then further up), in that order: their number. */
  readonly above: number;
  /** Each of those, stepped down to its path (`inheritedAt`), made where it is first asked. */
  readonly inherited: HostFrontier[];
}

/** Per walk: the stored paths of each place, each place's frontier at its root, each read's and each copy's. */
interface HostFrontiers {
  readonly places: Map<PlaceId, StoreNode>;
  readonly roots: Map<PlaceId, HostFrontier>;
  /** The value each read's projections start from (`readRoot`), kept for every value on a chain it climbed. */
  readonly readRoots: Map<PlaceId, PlaceId>;
  readonly reads: Map<PlaceId, HostFrontier>;
  readonly copied: Map<Standing, HostFrontier>;
  /** The host data each place's component of the place-level copy graph reaches (`placeIngress`), `null` for none. */
  readonly unions: Map<PlaceId, IngressNode | null>;
  /** The host data each value no place holds brings through its expression (`ownIngress`), `null` for none. */
  readonly owned: Map<PlaceId, IngressNode | null>;
}

const hostFrontiers = new WeakMap<Consumers, HostFrontiers>();

// (the finishing read's copy bounds live in `model.ts`, which the stores' syntax shares, #1604)
export { FRONTIER_COPIES, FRONTIER_DEPTH };

/** The limits a read's walk follows (`withFrontierBound` in tests). */
let frontierBound: { readonly depth: number; readonly copies: number } = {
  depth: FRONTIER_DEPTH,
  copies: FRONTIER_COPIES,
};

/** Test-only: each read's walk, by its value and path (`withFrontierBound`), or `null`. */
let frontierReads: Map<string, FrontierRead> | null = null;

/**
 * Test-only: records a read's walk where the seam records (`withFrontierBound`), never over a cut recorded for the same
 * value and path: a later read of it follows the chain its cut compressed (`sameOf`) and may not be cut, but the
 * analysis kept the cut's answer (#1509).
 */
function recordRead(value: PlaceId, rest: readonly string[], found: () => FrontierRead): void {
  if (frontierReads === null) return;
  const read = `${value}\u0000${rest.join("\u0000")}`;
  if (frontierReads.get(read)?.cut !== true) frontierReads.set(read, found());
}

/** Test-only: what a read's walk found (`withFrontierBound`). */
export interface FrontierRead {
  /** Whether the read answered the stop alone before its walk. */
  readonly guarded: boolean;
  /** Whether its walk was cut, so it answered its place's component's host data. */
  readonly cut: boolean;
  /** The ingress writers its answer names, each by its site and kind. */
  readonly writers: ReadonlySet<string>;
  /** The copies its walk met and the deepest it went. */
  readonly copies: number;
  readonly depth: number;
}

/**
 * Test-only: runs `callback` with each read's walk bounded by `bound` (the exact reference: `Infinity` for both), and
 * records each read's walk (the bounded frontier's oracle, `type-core-stop-frontier.test.ts`).
 */
export function withFrontierBound<T>(
  bound: { readonly depth: number; readonly copies: number },
  callback: () => T,
): { readonly result: T; readonly reads: ReadonlyMap<string, FrontierRead> } {
  if (frontierReads !== null) throw new Error("The frontier is already bounded.");
  const reads = new Map<string, FrontierRead>();
  const kept = frontierBound;
  [frontierBound, frontierReads] = [bound, reads];
  try {
    const result = callback();
    return { result, reads };
  } finally {
    [frontierBound, frontierReads] = [kept, null];
  }
}

/** Whether a frontier holds nothing of its own beside its copies' frontiers: no value a step enters, no store below. */
function holdsOnlyCopies(at: HostFrontier): boolean {
  return at.cells.size === 0 && at.host === undefined && (at.node?.children.size ?? 0) === 0;
}

const NOTHING: HostFrontier = {
  cells: new Map(),
  node: null,
  copies: [],
  host: undefined,
  owner: null,
  steps: new Map(),
  same: undefined,
  above: 0,
  inherited: [],
  own: false,
};

function frontier(
  node: StoreNode | null,
  host: IngressNode | undefined,
  owner: HostFrontier["owner"],
  own = false,
): HostFrontier {
  // (an owner is entered whole before a step below it is made, so its copies are all there)
  const above = owner === null ? 0 : owner.frontier.copies.length + owner.frontier.above;
  return {
    cells: new Map(),
    node,
    copies: [],
    host,
    owner,
    steps: new Map(),
    same: undefined,
    above,
    inherited: [],
    own: owner === null ? own : owner.frontier.own,
  };
}

/** The walk's frontiers, its places' stored paths made once from the definitions (each store, add and transfer). */
function frontiersOf(walk: Consumers): HostFrontiers {
  let found = hostFrontiers.get(walk);
  if (found !== undefined) return found;
  const { program, definitions, lists } = walk.pass;
  const places = new Map<PlaceId, StoreNode>();
  const nodeAt = (place: PlaceId, path: readonly string[]): StoreNode => {
    let node: StoreNode | undefined = places.get(place);
    if (node === undefined) places.set(place, (node = { children: new Map(), stores: [] }));
    for (const step of path) {
      program.work.charge("checks");
      let child: StoreNode | undefined = node.children.get(step);
      if (child === undefined)
        node.children.set(step, (child = { children: new Map(), stores: [] }));
      node = child;
    }
    return node;
  };
  for (const [key, list] of definitions.byKey) {
    program.work.charge("checks");
    for (const d of list) {
      program.work.charge("checks");
      if ((d.kind !== "whole" && d.kind !== "add") || d.value === undefined || !lists.live(d))
        continue;
      // (an add stores at its receiver's element; an `addAll`'s value is a list of the elements it adds there)
      const path = keptPath(program.work, key);
      nodeAt(
        keyPlace(key),
        d.kind === "add" ? keptSteps(program.work, path, ["element"]) : path,
      ).stores.push({ d, elements: d.kind === "add" && d.how === "elements" });
    }
  }
  found = {
    places,
    roots: new Map(),
    reads: new Map(),
    copied: new Map(),
    unions: new Map(),
    owned: new Map(),
    readRoots: new Map(),
  };
  hostFrontiers.set(walk, found);
  return found;
}

/**
 * Enters values standing at a frontier's path: each with the carriers' operands and own contributions at the same path
 * (`expand`'s parts without a step), a host read's ingress its host data, a copy as a copy task; those with cells a
 * step enters kept for the steps. In a value's own frontier (`own`) an operand no place holds is linked as a copy at its
 * strip, its own frontier made once, on every path that enters it: the value's root or a literal's cell (Astra r1's B1 on
 * #1559: nested defaults entered again below each literal cell made k levels k² tasks).
 */
function enterValues(walk: Consumers, at: HostFrontier, values: Expansion[]): void {
  const { program } = walk.pass;
  for (let task = values.pop(); task !== undefined; task = values.pop()) {
    program.work.charge("checks");
    if (task.stop !== null && copies(program.work, task.stop)) {
      const host = hostIngress(walk, task.value);
      if (host !== null) at.host = program.scope.ingress.union(at.host, host[0]?.ingress);
      else at.copies.push({ value: task.value, strip: task.strip });
    }
    const { cells, operands } = partsOf(walk, task);
    for (const part of operands) {
      program.work.charge("checks");
      if (at.own && ownOperand(walk, task.value, part))
        at.copies.push({ value: part.value, strip: part.strip });
      else values.push(partOf(walk.admission, part));
    }
    for (const [step, parts] of cells) addCells(walk, at, step, parts);
  }
}

/**
 * Whether a value standing in a store walk is a copy the frontier follows: a read of another value (`values`), or a copy
 * of a written place where the nearest written prefix of its path admits every kind at or below it, so it holds the host
 * data its stores hold there (#1450); a restricted one holds its kinds, its stores' boundaries checking them.
 */
function copies(work: WorkLedger, stop: NonNullable<Expansion["stop"]>): boolean {
  if (stop.list === "values") return true;
  if (stop.list !== "written" || stop.term === null) return false;
  const at = prefixAt(work, stop.term, stop.strip);
  return at !== null && openness(work, at).below;
}

/** Adds cells a step enters to a frontier's, each charged once. */
function addCells(walk: Consumers, at: HostFrontier, step: string, parts: readonly Part[]): void {
  walk.pass.program.work.charge("checks", parts.length);
  const list = at.cells.get(step);
  if (list === undefined) at.cells.set(step, [...parts]);
  else list.push(...parts);
}

/** Each value's parts once (`partsOf`). */
const partsByValue = new WeakMap<
  Expansion,
  { readonly cells: Map<string, Part[]>; readonly operands: Part[] }
>();

/** A value's parts: its cells by their steps, so a step enters them in one look-up, and the operands at its path. */
function partsOf(
  walk: Consumers,
  task: Expansion,
): { readonly cells: Map<string, Part[]>; readonly operands: Part[] } {
  let found = partsByValue.get(task);
  if (found !== undefined) return found;
  found = { cells: new Map(), operands: [] };
  for (const part of task.parts) {
    walk.pass.program.work.charge("checks");
    if (part.step === null) found.operands.push(part);
    else {
      const list = found.cells.get(part.step);
      if (list === undefined) found.cells.set(part.step, [part]);
      else list.push(part);
    }
  }
  partsByValue.set(task, found);
  return found;
}

/** Enters the stores at a frontier's node: each value there, an `addAll`'s elements. */
function enterStores(walk: Consumers, at: HostFrontier): void {
  const { program } = walk.pass;
  for (const { d, elements } of at.node?.stores ?? []) {
    program.work.charge("checks");
    const value = [expand(walk.admission, d.value!, d.node, [])];
    if (!elements) enterValues(walk, at, value);
    else {
      // (each element whole: what the list's value holds at its element step, the copies standing there, and the copies
      // of the lists it copies at their element, so an element enters with its stored descendants)
      const list = frontier(null, undefined, null);
      enterValues(walk, list, value);
      const element = stepOwn(walk, list, "element");
      for (const [step, parts] of element.cells) addCells(walk, at, step, parts);
      for (const task of element.copies) {
        program.work.charge("checks");
        at.copies.push(task);
      }
      for (const task of list.copies) {
        program.work.charge("checks");
        // (the values entered there stand as copy tasks alone)
        if ("value" in task)
          at.copies.push({
            value: task.value,
            strip: keptSteps(program.work, task.strip, ["element"]),
          });
      }
      at.host = program.scope.ingress.union(at.host, element.host);
    }
  }
}

/**
 * A place's frontier at a path, from its root's by its steps: what its stores hold there, whatever decision of the place
 * stopped (a read of a stopped key answers the stop alone before its walk, `heldIngress`; a copy of one holds what its
 * stores hold, #1560).
 */
function locate(walk: Consumers, place: PlaceId, path: readonly string[]): HostFrontier {
  const frontiers = frontiersOf(walk);
  let at = frontiers.roots.get(place);
  if (at === undefined) {
    at = frontier(frontiers.places.get(place) ?? null, undefined, null);
    frontiers.roots.set(place, at);
    enterStores(walk, at);
  }
  for (const step of path) at = stepOwn(walk, at, step);
  return at;
}

/**
 * A frontier's own content one step below, made once: its cells and its stored paths there, the copies standing there
 * and the host data standing at it, whatever decision of its place stopped (`locate`). At a `values`
 * step, which reads a dictionary's values list where its receiver is one and an object's own property where it is an
 * object, both: its own content and the frontier above it, standing there as a copy whose element is the
 * dictionary's (#1452). A dictionary's `keys` list holds text no store's host data reaches.
 */
function stepOwn(walk: Consumers, from: HostFrontier, step: string): HostFrontier {
  const { program } = walk.pass;
  program.work.charge("checks");
  if (from === NOTHING) return NOTHING;
  const known = from.steps.get(step);
  if (known !== undefined) return known;
  const at = frontier(from.node?.children.get(step) ?? null, from.host, { frontier: from, step });
  from.steps.set(step, at);
  if (dictList(step) === "values") {
    program.work.charge("checks");
    at.copies.push({ values: from });
  }
  const cells: Expansion[] = [];
  for (const part of from.cells.get(step) ?? []) {
    program.work.charge("checks");
    cells.push(partOf(walk.admission, part));
  }
  enterValues(walk, at, cells);
  enterStores(walk, at);
  return at;
}

/**
 * The place a read reads: its binding's target root, a call's function's result place, a projection's owner's; `null`
 * else.
 */
function readPlace(walk: Consumers, value: PlaceId): PlaceId | null {
  const { program } = walk.pass;
  const at = readRoot(walk, value);
  const binding = program.occurrenceOf.get(at);
  const target = binding === undefined ? null : program.targetRoot(binding);
  return target?.root ?? walk.resultOfCall.get(at) ?? null;
}

/**
 * The value a read's projections start from: its outermost projection's owner, or the read itself. Kept for every value
 * on the chain it climbs (`readRoots`), so the reads along one chain climb it once (Astra r1's B2 on #1559: a cut read
 * found its root through `readPlace` and `readRoot` again, k reads 2k² steps).
 */
function readRoot(walk: Consumers, value: PlaceId): PlaceId {
  const { program } = walk.pass;
  const { readRoots } = frontiersOf(walk);
  const chain: PlaceId[] = [];
  let at = value;
  for (
    let projection = program.projOf.get(at);
    projection !== undefined && !readRoots.has(at);
    projection = program.projOf.get(at)
  ) {
    program.work.charge("checks");
    chain.push(at);
    at = projection.owner;
  }
  const root = readRoots.get(at) ?? at;
  for (const each of chain) readRoots.set(each, root);
  return root;
}

/** A value's node: its expression's, where its own content is read (`ownFrontier`); `null` for a value without one. */
function ownNode(walk: Consumers, value: PlaceId): FlowNode | null {
  const site = walk.pass.program.places[value]?.site ?? null;
  return site === null ? null : walk.pass.program.exprAt(site);
}

/**
 * A read's frontier: its binding's at its target path, a call's its function's result's, a projection's its owner's one
 * step below; else its own (`ownFrontier`).
 */
function readFrontier(walk: Consumers, value: PlaceId): HostFrontier {
  const { program } = walk.pass;
  const reads = frontiersOf(walk).reads;
  const chain: PlaceId[] = [];
  let at = value;
  for (
    let projection = program.projOf.get(at);
    projection !== undefined && !reads.has(at);
    projection = program.projOf.get(at)
  ) {
    chain.push(at);
    at = projection.owner;
  }
  let found = reads.get(at);
  if (found === undefined) {
    program.work.charge("checks");
    // (a binding's read at its target path; a call's result its function's result place)
    const binding = program.occurrenceOf.get(at);
    const target = binding === undefined ? null : program.targetRoot(binding);
    const result = walk.resultOfCall.get(at);
    found =
      target !== null
        ? locate(walk, target.root, target.path)
        : result !== undefined
          ? locate(walk, result, [])
          : ownFrontier(walk, at, reads);
    reads.set(at, found);
  }
  for (const next of chain.reverse()) {
    program.work.charge("checks");
    const step = program.projOf.get(next)!.step;
    found = step === "iteration" ? NOTHING : stepOwn(walk, found, stepName(step));
    reads.set(next, found);
  }
  return found;
}

/**
 * The frontier of a value no place holds (a literal, a fallback, an operation), at its expression's node: what it holds
 * by its own structure, as a store of it brings (`enterValues`), so a read of a literal's projection or of a fallback
 * holds its host data as a read of a stored one does (#1491, #1502). It is `own`: an operand no place holds stands in it
 * and below it as a copy (`ownOperand`), its own frontier made once whatever reads it. Kept as the value's read before
 * it is entered: a carrier's own contribution is a copy of itself, which stands for nothing more.
 */
function ownFrontier(
  walk: Consumers,
  value: PlaceId,
  reads: Map<PlaceId, HostFrontier>,
): HostFrontier {
  const node = ownNode(walk, value);
  if (node === null) return NOTHING;
  const at = frontier(null, undefined, null, true);
  reads.set(value, at);
  enterValues(walk, at, [expand(walk.admission, value, node, [])]);
  return at;
}

/** Whether a part of a value's expansion is another value no place holds (`ownFrontier`, `ownIngress`). */
function ownOperand(walk: Consumers, value: PlaceId, part: Part): boolean {
  return part.value !== value && readPlace(walk, part.value) === null;
}

/** A copy task's frontier: its read's, at its strip; made once. A dictionary standing at its `values` list: its own. */
function copyFrontier(walk: Consumers, task: Standing): HostFrontier {
  if ("values" in task) return task.values;
  const { copied } = frontiersOf(walk);
  let found = copied.get(task);
  if (found === undefined) {
    found = readFrontier(walk, task.value);
    for (const step of task.strip) found = stepOwn(walk, found, step);
    copied.set(task, found);
  }
  return found;
}

/**
 * Visits the copies standing at a frontier's path, each by its frontier there: its own, then its owner path's one step
 * below, and so on up (`inheritedAt`), until `visit` answers `false`. Each copy met is charged, with its steps.
 */
function eachCopy(walk: Consumers, at: HostFrontier, visit: (copy: HostFrontier) => boolean): void {
  const { program } = walk.pass;
  program.work.charge("checks");
  for (const task of at.copies) {
    program.work.charge("checks");
    if (!visit(copyFrontier(walk, task))) return;
  }
  // (each charged in `inheritedAt`)
  for (let index = 0; index < at.above; index += 1)
    if (!visit(inheritedAt(walk, at, index))) return;
}

/**
 * A copy standing above a frontier, stepped down to its path: the `index`th of its owner's own copies and then of those
 * above its owner, each one step below the owner's. Each frontier's entry is made once, from its owner's, so the reads
 * along one path share every step of the climb and each read's is bounded by the copies it meets (Codex r1's B1 on
 * #1559: a copy at a deep path's root, climbed and replayed again for each read below it, made k reads k² steps).
 */
function inheritedAt(walk: Consumers, at: HostFrontier, index: number): HostFrontier {
  const { program } = walk.pass;
  const chain: [HostFrontier, number][] = [];
  let found: HostFrontier;
  for (let level = at, k = index; ;) {
    program.work.charge("checks");
    const known = level.inherited[k];
    if (known !== undefined) {
      found = known;
      break;
    }
    chain.push([level, k]);
    const owner = level.owner!.frontier;
    if (k < owner.copies.length) {
      found = copyFrontier(walk, owner.copies[k]!);
      break;
    }
    k -= owner.copies.length;
    level = owner;
  }
  for (let n = chain.length - 1; n >= 0; n -= 1) {
    const [level, k] = chain[n]!;
    found = stepOwn(walk, found, level.owner!.step);
    level.inherited[k] = found;
  }
  return found;
}

/**
 * The frontier one stands for: itself, or, where it holds nothing of its own beside one copy, what that copy's stands
 * for; nothing where it holds nothing (a cycle of such frontiers holds nothing either). Each link followed is one of the
 * copies its read's walk meets (`budget`), but no copy deep; past them `null`. Each frontier followed keeps the
 * furthest one found (`same`, itself where it stands for itself), so each copy is listed once and a later read jumps
 * where an earlier one stopped.
 */
function sameOf(
  walk: Consumers,
  start: HostFrontier,
  budget: { met: number },
): HostFrontier | null {
  const chain: HostFrontier[] = [];
  const met = new Set<HostFrontier>();
  let at = start;
  for (;;) {
    walk.pass.program.work.charge("checks");
    if (at === NOTHING || at.same === at) break;
    if (met.has(at)) {
      at = NOTHING;
      break;
    }
    met.add(at);
    let next = at.same;
    if (next === undefined) {
      if (!holdsOnlyCopies(at)) {
        at.same = at;
        break;
      }
      const copies: HostFrontier[] = [];
      eachCopy(walk, at, (copy) => copies.push(copy) < 2);
      if (copies.length > 1) {
        at.same = at;
        break;
      }
      next = copies[0] ?? NOTHING;
    }
    chain.push(at);
    if (++budget.met > frontierBound.copies) {
      for (const each of chain) {
        walk.pass.program.work.charge("checks");
        each.same = next;
      }
      return null;
    }
    at = next;
  }
  for (const each of chain) {
    walk.pass.program.work.charge("checks");
    each.same = at;
  }
  return at;
}

/**
 * A read's bounded walk (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-208): the host
 * data standing at its frontier and at the frontiers of the copies standing there, breadth first, each frontier once,
 * at most `frontierBound.depth` copies deep and `.copies` copies met. Cut where a copy would lead deeper, or past the
 * copies it may meet, to a frontier it has not met: then the read answers its place's component's host data
 * (`placeIngress`).
 */
function explore(
  walk: Consumers,
  start: HostFrontier,
): {
  readonly host: IngressNode | undefined;
  readonly cut: boolean;
  readonly copies: number;
  readonly depth: number;
} {
  const { program } = walk.pass;
  const budget = { met: 0 };
  const first = sameOf(walk, start, budget);
  let cut = first === null;
  const met = new Set<HostFrontier>(first === null ? [] : [first]);
  let layer = first === null || first === NOTHING ? [] : [first];
  let host: IngressNode | undefined;
  let depth = 0;
  for (; layer.length > 0 && !cut; depth += 1) {
    const next: HostFrontier[] = [];
    for (const at of layer) {
      program.work.charge("checks");
      host = program.scope.ingress.union(host, at.host);
      if (cut) continue;
      eachCopy(walk, at, (copy) => {
        if (++budget.met > frontierBound.copies) return !(cut = true);
        const same = sameOf(walk, copy, budget);
        if (same === null) return !(cut = true);
        if (same === NOTHING || met.has(same)) return true;
        if (depth >= frontierBound.depth) return !(cut = true);
        met.add(same);
        next.push(same);
        return true;
      });
    }
    layer = next;
  }
  return { host, cut, copies: budget.met, depth: Math.max(0, depth - 1) };
}

/**
 * The host data a place's stores bring and the places their copies read (each store's value walked once), for the
 * place-level copy graph (`placeIngress`).
 */
function placeEdges(
  walk: Consumers,
  place: PlaceId,
): { readonly host: IngressNode | undefined; readonly places: PlaceId[] } {
  const { program } = walk.pass;
  const edges: Edges = { host: undefined, places: [] };
  const nodes = [frontiersOf(walk).places.get(place)].filter((node) => node !== undefined);
  for (let node = nodes.pop(); node !== undefined; node = nodes.pop()) {
    program.work.charge("checks");
    nodes.push(...node.children.values());
    for (const { d } of node.stores) {
      program.work.charge("checks");
      valueEdges(walk, expand(walk.admission, d.value!, d.node, []), edges);
    }
  }
  return edges;
}

/** The host data values bring and the places their copies read (`placeEdges`). */
interface Edges {
  host: IngressNode | undefined;
  readonly places: PlaceId[];
}

/**
 * Adds to `edges` the host data a value brings and the places its copies read, through its parts; with `owned`, a part
 * that is another value no place holds is listed there instead (`ownIngress`).
 */
function valueEdges(walk: Consumers, value: Expansion, edges: Edges, owned?: PlaceId[]): void {
  const { program } = walk.pass;
  const values = [value];
  for (let task = values.pop(); task !== undefined; task = values.pop()) {
    program.work.charge("checks");
    if (task.stop !== null && copies(program.work, task.stop)) {
      const ingress = hostIngress(walk, task.value);
      if (ingress !== null)
        edges.host = program.scope.ingress.union(edges.host, ingress[0]?.ingress);
      else {
        const read = readPlace(walk, task.value);
        if (read !== null) edges.places.push(read);
      }
    }
    for (const part of task.parts) {
      program.work.charge("checks");
      if (owned !== undefined && ownOperand(walk, task.value, part)) owned.push(part.value);
      else values.push(partOf(walk.admission, part));
    }
  }
}

/**
 * The host data a read whose walk is cut answers
 * (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-208): its place's component's
 * (`placeIngress`), or, for a value no place holds, what its expression brings (`ownIngress`). A superset of what its
 * walk would name, never a dropped check.
 */
function cutIngress(walk: Consumers, value: PlaceId): IngressNode | undefined {
  const place = readPlace(walk, value);
  return place !== null ? placeIngress(walk, place) : ownIngress(walk, readRoot(walk, value));
}

/**
 * The host data a value no place holds brings through its expression at every path: what its parts bring, the components
 * of the places they read (`placeIngress`) and each operand no place holds by its own, each value once (`owned`),
 * iteratively.
 */
function ownIngress(walk: Consumers, value: PlaceId): IngressNode | undefined {
  const { program } = walk.pass;
  const { owned } = frontiersOf(walk);
  const ingress = program.scope.ingress;
  const known = owned.get(value);
  if (known !== undefined) return known ?? undefined;
  const open = new Set<PlaceId>();
  const frames: {
    readonly value: PlaceId;
    readonly operands: PlaceId[];
    next: number;
    host: IngressNode | undefined;
  }[] = [];
  const enter = (at: PlaceId): void => {
    open.add(at);
    const node = ownNode(walk, at);
    const edges: Edges = { host: undefined, places: [] };
    const operands: PlaceId[] = [];
    if (node !== null) valueEdges(walk, expand(walk.admission, at, node, []), edges, operands);
    let host = edges.host;
    for (const read of edges.places) {
      program.work.charge("checks");
      host = ingress.union(host, placeIngress(walk, read));
    }
    frames.push({ value: at, operands, next: 0, host });
  };
  enter(value);
  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    program.work.charge("checks");
    if (frame.next < frame.operands.length) {
      const operand = frame.operands[frame.next++]!;
      const done = owned.get(operand);
      if (done !== undefined) frame.host = ingress.union(frame.host, done ?? undefined);
      else if (!open.has(operand)) enter(operand);
      continue;
    }
    frames.pop();
    owned.set(frame.value, frame.host ?? null);
    const parent = frames.at(-1);
    if (parent !== undefined) parent.host = ingress.union(parent.host, frame.host);
  }
  return owned.get(value) ?? undefined;
}

/**
 * The host data a place's component of the place-level copy graph reaches, at every path: its members' stores' and
 * every component's its copies read, each component once (Tarjan's, iteratively), shared as one ingress union by every
 * place that reaches it. A cut read answers its place's (`explore`), a superset of what its walk would name.
 */
function placeIngress(walk: Consumers, start: PlaceId): IngressNode | undefined {
  const { program } = walk.pass;
  const { unions } = frontiersOf(walk);
  const known = unions.get(start);
  if (known !== undefined) return known ?? undefined;
  const ingress = program.scope.ingress;
  const order = new Map<PlaceId, { readonly index: number; low: number }>();
  const open: PlaceId[] = [];
  // (each member's host data and its closed successors', until its component closes)
  const pendingHost = new Map<PlaceId, IngressNode | undefined>();
  const frames: {
    readonly place: PlaceId;
    readonly edges: ReturnType<typeof placeEdges>;
    next: number;
    host: IngressNode | undefined;
  }[] = [];
  const enter = (place: PlaceId): void => {
    order.set(place, { index: order.size, low: order.size });
    open.push(place);
    const edges = placeEdges(walk, place);
    frames.push({ place, edges, next: 0, host: edges.host });
  };
  enter(start);
  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    program.work.charge("checks");
    const own = order.get(frame.place)!;
    if (frame.next < frame.edges.places.length) {
      const to = frame.edges.places[frame.next++]!;
      const done = unions.get(to);
      if (done !== undefined) frame.host = ingress.union(frame.host, done ?? undefined);
      else if (!order.has(to)) enter(to);
      else own.low = Math.min(own.low, order.get(to)!.index);
      continue;
    }
    frames.pop();
    const parent = frames.at(-1);
    if (own.low === own.index) {
      // (a component: its members' host data and the components they reach, one union for all of them)
      const members: PlaceId[] = [];
      for (let member = open.pop(); member !== undefined; member = open.pop()) {
        program.work.charge("checks");
        members.push(member);
        if (member === frame.place) break;
      }
      let host = frame.host;
      for (const member of members) {
        program.work.charge("checks");
        host = ingress.union(host, pendingHost.get(member));
      }
      for (const member of members) {
        program.work.charge("checks");
        unions.set(member, host ?? null);
        pendingHost.delete(member);
      }
      if (parent !== undefined) parent.host = ingress.union(parent.host, host);
    } else {
      // (inside a component not yet closed: its host data waits for the component's root)
      pendingHost.set(frame.place, frame.host);
      if (parent !== undefined) {
        const above = order.get(parent.place)!;
        above.low = Math.min(above.low, own.low);
      }
    }
  }
  return unions.get(start) ?? undefined;
}

/**
 * The host data a domain read holds after a settled stop (#1432, #1415): its own host ingress and what its bounded walk
 * meets (`explore`), and where the walk is cut its place's component's or its own value's (`cutIngress`), as one
 * external item naming those reads. Nothing below a key whose decision stopped.
 */
export function heldIngress(
  walk: Consumers,
  value: PlaceId,
  rest: readonly string[],
): readonly Item[] {
  const { program, contract, definitions } = walk.pass;
  if (!walk.settled || program.work.stopped === null || definitions.ingress.size === 0) return [];
  if (contract.anyStopped) {
    const key = readKey(walk, value);
    if (
      key === null ||
      walk.admission.decisionStopped(keyPlace(key), joinSteps(keyPath(key), rest))
    ) {
      recordRead(value, rest, () => ({
        guarded: true,
        cut: false,
        writers: new Set(),
        copies: 0,
        depth: 0,
      }));
      return [];
    }
  }
  let at = readFrontier(walk, value);
  for (const step of rest) at = stepOwn(walk, at, step);
  const found = explore(walk, at);
  // (cut, its place's component's host data, or its own value's, holds all its walk met: that one union, shared by
  // every read of the component or the value, so a consumer resolves it once)
  const structural = hostIngress(walk, value)?.[0] ?? null;
  const domain = found.cut ? cutIngress(walk, value) : found.host;
  const node = program.scope.ingress.union(structural?.ingress, domain);
  recordRead(value, rest, () => ({
    guarded: false,
    cut: found.cut,
    writers: new Set(
      node === undefined ? [] : ingressLeaves(node).map((writer) => JSON.stringify(writer)),
    ),
    copies: found.copies,
    depth: found.depth,
  }));
  if (node === undefined) return [];
  const item: Item = { ...unknownItem(REASON.external), ingress: node };
  // (what the stores bring is its mark's content, `Consumers.boundariesAt`, #1448; a host read's own ingress, in it too,
  // forms whatever they hold)
  if (domain !== undefined && structural === null) {
    program.work.charge("checks");
    walk.domainOwned.add(item);
  }
  return [item];
}

/**
 * A host read's ingress, directly or through projections (`Contract.ingressOf`): its external data named by its leaf,
 * known from the program's structure whatever the script stores into the global; else `null`.
 */
export function hostIngress(walk: Consumers, value: PlaceId): readonly Item[] | null {
  const { contract, program } = walk.pass;
  const ingress = contract.ingressOf(value);
  const binding = ingress === null ? undefined : program.occurrenceOf.get(ingress);
  return binding !== undefined && program.isHost(binding)
    ? contract.entered(value, [unknownItem(REASON.external)])
    : null;
}
