// The layers below a prefix's stores, and the reads that find a path's sources through them.

import type { PlaceId } from "../../../graph.js";
import {
  arrayRef,
  isPathSteps,
  keyIdAt,
  type PathRef,
  type Rest,
  restRef,
  rootId,
  stepsText,
  type Steps,
} from "../key-ids.js";
import { keepText, keptParts, keptText, stepText } from "../../budget.js";
import type { Contract } from "../../contract.js";
import { keptKey, keptKeyOfText, keyPath, type Definition, type Key } from "../../definitions.js";
import { subFirstOf } from "../identity.js";
import { pathAt, pathBelow } from "../literal-index.js";
import type {
  LayerFound,
  LayerOrigin,
  LayerPath,
  PrefixNode,
  PrefixStores,
  StepLayers,
  SubLayer,
  SubSource,
  SupportNode,
} from "../model.js";
import {
  mapGet,
  mapOf,
  overlay,
  positionLeaf,
  positionsIn,
  prefixAt,
  prefixUnion,
  setLeaf,
  stepKey,
  supportLeaf,
  union,
  viewOf,
} from "./tries.js";

/** The layer an alias of `place` inherits: the place's own stores below its root over the place's layers, once. */
export function aliasLayer(
  contract: Contract,
  inner: PrefixStores,
  place: PlaceId,
): SubLayer | null {
  if (contract.aliasLayers.has(inner)) return contract.aliasLayers.get(inner)!;
  const own = new Map<string, Set<Key>>();
  for (const step of subFirstOf(contract, place)) {
    contract.pass.program.work.charge("invSteps");
    own.set(step, new Set([keptKey(contract.work, place, [])]));
  }
  // (the layers its source joins are referenced, never listed again per copy; stores cut at an open copy cycle are
  // their own query's, another query or pass reads the place otherwise, so their layer has no origin to be found by)
  const layer = layerOf(
    contract,
    own,
    inner.subs,
    inner.also.map((joined) => joined.layer),
    inner.cut ? null : { kind: "alias", key: rootId(place) },
  );
  contract.aliasLayers.set(inner, layer);
  return layer;
}

/**
 * The layer a projected copy of `place` at `projection` takes: the place's own live stores below the path, once, from
 * the keys below the path alone (r4.46 (3): never the place's whole key set per copy).
 */
export function projectedLayer(
  contract: Contract,
  place: PlaceId,
  projection: Steps,
): SubLayer | null {
  // (a record's steps spelled by their record)
  const text = stepsText(projection);
  const id = keptParts(contract.work, place, text);
  if (contract.projectedLayers.has(id)) return contract.projectedLayers.get(id)!;
  const { program, definitions, lists } = contract.pass;
  const sub = keptKeyOfText(contract.work, place, text);
  const own = new Map<string, Set<Key>>();
  for (const below of definitions.keysBelow(sub)) {
    program.work.charge("invSteps");
    if ((definitions.byKey.get(below) ?? []).some((d) => lists.live(d))) {
      // (a step below the projection, its text charged where the layer first keeps it)
      const step = keyPath(below)[projection.length]!;
      if (!own.has(step)) keepText(contract.work, step.length);
      own.set(step, new Set([sub]));
    }
  }
  const layer = layerOf(contract, own, null, [], {
    kind: "projected",
    key: keyIdAt(place, arrayRef(contract, projection).id()),
  });
  contract.projectedLayers.set(id, layer);
  return layer;
}

/**
 * A prefix's layer: its own sources over the layer it inherits and the layers its source joins; none if it adds
 * neither, its parent then standing for it with its origin. A join already on the parent's chain adds nothing the
 * parent does not and is left out, and a parent on a join's chain adds nothing to its maps (`under`), so copies joined
 * again over one ancestor, in either order, stay a chain of the layers that list their steps.
 */
function layerOf(
  contract: Contract,
  own: Map<string, Set<Key>>,
  parent: SubLayer | null,
  joins: readonly SubLayer[],
  origin: LayerOrigin | null,
): SubLayer | null {
  const work = contract.pass.program.work;
  const kept: SubLayer[] = [];
  const seen = new Set<SubLayer>();
  let covered = false;
  for (const joined of joins) {
    work.charge("invSteps");
    if (joined === parent || seen.has(joined) || onChain(contract, parent, joined)) continue;
    seen.add(joined);
    kept.push(joined);
    if (!covered && parent !== null) covered = onChain(contract, joined, parent);
  }
  if (own.size === 0 && kept.length === 0) return parent;
  work.charge("invSteps", 1 + kept.length);
  let only: Key | null | undefined = parent === null ? undefined : parent.only;
  for (const [, set] of own)
    for (const sub of set) {
      work.charge("invSteps");
      only = only === undefined || only === sub ? sub : null;
    }
  const jumps: SubLayer[] = [];
  if (parent !== null) {
    jumps.push(parent);
    for (let level = 0; jumps[level]!.jumps[level] !== undefined; level += 1) {
      work.charge("invSteps");
      jumps.push(jumps[level]!.jumps[level]!);
    }
  }
  const id = contract.layersById.length;
  const self = setLeaf(contract, id);
  // (below it, each step maps to the listing layers the maps of its parent and joins name for it; its own steps map to
  // itself)
  let level: (SupportNode | null)[] = (covered || parent === null ? kept : [parent, ...kept]).map(
    (child) => child.front,
  );
  // (united in halves, so the sets of layers made in turn join at one branch per two halves)
  while (level.length > 1) {
    const next: (SupportNode | null)[] = [];
    for (let at = 0; at < level.length; at += 2)
      next.push(at + 1 < level.length ? union(contract, level[at]!, level[at + 1]!) : level[at]!);
    level = next;
  }
  const under = level[0] ?? null;
  // (the map below its own steps kept with it, so a listing layer's read finds those below it by one lookup)
  if (under !== null) contract.keep(1);
  const keys = [...own.keys()]
    .map((step) => stepKey(contract, step))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const front = overlay(contract, under, mapOf(contract, keys, self));
  const layer: SubLayer = {
    own,
    parent,
    joins: kept,
    only: joins.length === 0 ? (only ?? null) : null,
    origin,
    paths: new Map(),
    id,
    depth: parent === null ? 0 : parent.depth + 1,
    jumps,
    self,
    under,
    front,
  };
  contract.layersById.push(layer);
  return layer;
}

/** A layer's ancestor at a depth no greater than its own: by its jumps, one per power of two. */
function ancestorAt(contract: Contract, layer: SubLayer, depth: number): SubLayer {
  let at = layer;
  while (at.depth > depth) {
    contract.pass.program.work.charge("invSteps");
    let level = 0;
    while (at.jumps[level + 1] !== undefined && at.jumps[level + 1]!.depth >= depth) level += 1;
    at = at.jumps[level]!;
  }
  return at;
}

/** Whether `layer` is `parent` or one of its parents (`ancestorAt`). */
function onChain(contract: Contract, parent: SubLayer | null, layer: SubLayer): boolean {
  return (
    parent !== null &&
    layer.depth <= parent.depth &&
    ancestorAt(contract, parent, layer.depth) === layer
  );
}

/** The layers a layer answers through below its own sources: its parent, then the layers it joins, in order. */
function below(layer: SubLayer): readonly SubLayer[] {
  return layer.parent === null ? layer.joins : [layer.parent, ...layer.joins];
}

/** The relative paths of a source's live keys below it, once per source, from the keys below it alone (r4.46 (3)). */
function ownPaths(contract: Contract, sub: Key): ReadonlySet<string> {
  const known = contract.subPaths.get(sub);
  if (known !== undefined) return known;
  const { program, definitions, lists } = contract.pass;
  const paths = new Set<string>();
  const base = keyPath(sub);
  for (const below of definitions.keysBelow(sub)) {
    program.work.charge("invSteps");
    if ((definitions.byKey.get(below) ?? []).some((d) => lists.live(d)))
      paths.add(keptText(contract.work, keyPath(below).slice(base.length)));
  }
  for (const path of paths) {
    contract.keep(1);
    const subs = contract.subsByPath.get(path);
    if (subs === undefined) contract.subsByPath.set(path, new Set([sub]));
    else subs.add(sub);
  }
  contract.subPaths.set(sub, paths);
  return paths;
}

/** A set of layers' layers, each node visited and charged. */
function layersIn(contract: Contract, set: SupportNode | null): SubLayer[] {
  const out: SubLayer[] = [];
  const stack = set === null ? [] : [set];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    contract.pass.program.work.charge("invSteps");
    if (node.left === null) out.push(contract.layersById[node.layer!]!);
    else stack.push(node.right!, node.left);
  }
  return out;
}

/**
 * The nearest layers below `layer` that list `step`, as one set: one lookup in its map below its own steps (`under`), once
 * per layer and step.
 */
export function listingBelow(
  contract: Contract,
  layer: SubLayer,
  step: string,
): SupportNode | null {
  // (a layer's set below it at a step is the same for every path under the step: found once per layer and step)
  let bySteps = contract.layersBelow.get(layer);
  if (bySteps === undefined) contract.layersBelow.set(layer, (bySteps = new Map()));
  const known = bySteps.get(step);
  if (known !== undefined) return known;
  const set = mapGet(contract, layer.under, step);
  bySteps.set(step, set);
  contract.keep(1);
  return set;
}

/** Whether a source has a store of its own at a prefix of `ref` below its root (`ownPaths`). */
export function ownHas(contract: Contract, sub: Key, ref: PathRef): boolean {
  const paths = ownPaths(contract, sub);
  for (let length = 1; length <= ref.length; length += 1) {
    contract.pass.program.work.charge("invSteps");
    if (paths.has(ref.text(length))) return true;
  }
  return false;
}

/**
 * A path asked below a prefix and its id, made once on its first asking (`pathIdAt`). The selection's walk of a plain
 * array's steps notes the longest prefix of them already made (`holdingAt`), so the id is made below it: a read walks its
 * steps once, never again for its id. A record's steps (`PathSteps`) make their own id, lazily and in their own order (a
 * view's suffix before its join, `PathSteps.after`), charging each step they visit (`convert`), so theirs is always
 * theirs and never walked again (Codex r7's F1).
 */
export interface ReadPath {
  readonly ref: PathRef;
  id: number | undefined;
  /** The longest prefix of a plain array's steps found made (`pathBelow`), its length and its id. */
  found: number;
  foundId: number;
  /**
   * The holders below the listing layers its selection passed, by set, while its path has no id (`holdersIn`): kept per
   * set and id once one is made (`pathIdAt`).
   */
  holders: Map<SupportNode, SupportNode | null> | undefined;
}

/** A path asked below a prefix, its id not yet made (`pathIdAt`). */
export function readPath(ref: PathRef): ReadPath {
  return { ref, id: undefined, found: 0, foundId: 0, holders: undefined };
}

/**
 * A read's path's id, made on its first asking (`idMade`); the holders its selection found below listing layers while it
 * had none kept under it then, as if found under it (their entries charged as they were made, `holdersIn`).
 */
export function pathIdAt(contract: Contract, path: ReadPath): number {
  if (path.id !== undefined) return path.id;
  const id = (path.id = idMade(contract, path));
  if (path.holders !== undefined) {
    for (const [set, root] of path.holders) {
      const byPath = holdersOf(contract, set);
      if (!byPath.has(id)) byPath.set(id, root);
    }
    path.holders = undefined;
  }
  return id;
}

/**
 * A read's path's id: a span's and a record's their own (`PathRef.id`, a record's charged as it is made); a plain
 * array's made below the longest prefix its selection found made, each step past it charged: the ids `PathRef.id` makes
 * (`pathAt` per step), in its order.
 */
function idMade(contract: Contract, path: ReadPath): number {
  const { ref } = path;
  if (ref.kind !== "steps" || isPathSteps(ref.steps())) return ref.id();
  if (path.found === ref.length) return path.foundId;
  contract.pass.program.work.charge("invSteps", ref.length - path.found);
  if (path.found === 0) return ref.id();
  let id = path.foundId;
  for (let at = path.found; at < ref.length; at += 1) id = pathAt(contract, id, ref.at(at));
  return id;
}

/**
 * A read's path's id where it is made already, else `undefined`, making and charging none: a span's and a record's where
 * found (`PathRef.made`); a plain array's where the selection's walk found every step made (`holdingAt`; a path is made
 * only below its parent's).
 */
function madePathId(path: ReadPath): number | undefined {
  if (path.id !== undefined) return path.id;
  const { ref } = path;
  if (ref.kind === "steps" && !isPathSteps(ref.steps()))
    return path.found === ref.length ? path.foundId : undefined;
  return ref.made();
}

/** A layer's answers at a path, made where first asked. */
export function atPath(contract: Contract, layer: SubLayer, path: number): LayerPath {
  let at = layer.paths.get(path);
  if (at === undefined) {
    layer.paths.set(path, (at = {}));
    contract.keep(1);
    contract.facts.supportEdges += 1;
  }
  return at;
}

/** A support's sources in their keys' order, each node visited and charged. */
function sourcesOf(contract: Contract, root: SupportNode | null): Key[] {
  const out: Key[] = [];
  const stack = root === null ? [] : [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    contract.pass.program.work.charge("invSteps");
    if (node.left === null) out.push(node.key);
    else stack.push(node.right!, node.left);
  }
  return out;
}

/**
 * The sources a layer lists at a path with a store of their own at a prefix of it below their root, its own and those
 * of the layers below it, as one support, once per layer and path: on an explicit stack, each layer below it answered
 * first and once.
 */
function layerSupport(
  contract: Contract,
  top: SubLayer,
  ref: PathRef,
  path: number,
): SupportNode | null {
  const step = ref.at(0);
  const done = (layer: SubLayer): boolean => layer.paths.get(path)?.support !== undefined;
  const stack: (readonly [SubLayer, boolean])[] = [[top, false]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [layer, ready] = next;
    if (done(layer)) continue;
    if (!ready) {
      stack.push([layer, true]);
      for (const child of childrenAt(contract, layer, ref, path))
        if (!done(child)) stack.push([child, false]);
      continue;
    }
    let root: SupportNode | null = null;
    for (const sub of layer.own.get(step) ?? []) {
      contract.pass.program.work.charge("invSteps");
      if (ownHas(contract, sub, ref)) root = union(contract, root, supportLeaf(contract, sub));
    }
    for (const child of childrenAt(contract, layer, ref, path))
      root = union(contract, root, child.paths.get(path)!.support ?? null);
    atPath(contract, layer, path).support = root;
  }
  return top.paths.get(path)!.support ?? null;
}

/** How many layers a prefix inherits or joins (`topAt`). */
function topCount(stores: PrefixStores): number {
  return (stores.subs === null ? 0 : 1) + stores.also.length;
}

/**
 * A prefix's layer at a position among those it inherits or joins, with its stores that brought it: the one it inherits
 * first, by index, so a read takes the layers it selects without copying the others.
 */
function topAt(stores: PrefixStores, at: number): PrefixStores["also"][number] {
  if (stores.subs === null) return stores.also[at]!;
  return at === 0 ? { layer: stores.subs, defs: stores.inheritedBy } : stores.also[at - 1]!;
}

/**
 * The listing layers a read under a step finds below `owner` (`find`: those the maps of its layers name for the step,
 * `SubLayer.front`), once per owner and step (`stepLayers`): the sources each lists there, by the found layers listing
 * them, and the sets of listing layers below them (`SubLayer.under`), each once, with the stores that brought the found
 * layers above it.
 */
function stepLayersOf(
  contract: Contract,
  owner: PrefixStores | SupportNode,
  find: () => readonly LayerFound[],
  step: string,
): StepLayers {
  const work = contract.pass.program.work;
  let bySteps = contract.stepLayers.get(owner);
  if (bySteps === undefined) contract.stepLayers.set(owner, (bySteps = new Map()));
  const known = bySteps.get(step);
  if (known !== undefined) return known;
  const found = find();
  const own = new Map<Key, number[]>();
  const sets: { set: SupportNode; over: number; defs: Set<LayerFound["defs"]> }[] = [];
  const setAt = new Map<number, number>();
  const belowOf: number[] = [];
  for (let at = 0; at < found.length; at += 1) {
    const { layer, defs } = found[at]!;
    for (const sub of layer.own.get(step) ?? []) {
      work.charge("invSteps");
      ownPaths(contract, sub);
      contract.keep(1);
      const listed = own.get(sub);
      if (listed === undefined) own.set(sub, [at]);
      else listed.push(at);
    }
    const set = listingBelow(contract, layer, step);
    if (set === null) {
      belowOf.push(-1);
      continue;
    }
    let index = setAt.get(set.id);
    if (index === undefined) {
      setAt.set(set.id, (index = sets.length));
      sets.push({ set, over: 0, defs: new Set() });
    }
    sets[index]!.over += 1;
    sets[index]!.defs.add(defs);
    belowOf.push(index);
  }
  // (a set below found layers brought by several prefixes' stores is brought by all of them, as one set made once)
  const below = sets.map(({ set, over, defs }) => {
    if (defs.size === 1) return { set, over, defs: [...defs][0]! };
    const all = new Set<Definition | null>();
    for (const each of defs)
      for (const d of each ?? []) {
        work.charge("invSteps");
        all.add(d);
      }
    return { set, over, defs: all };
  });
  contract.keep(1 + found.length + below.length);
  const made = { found, own, below, belowOf };
  bySteps.set(step, made);
  return made;
}

/**
 * The found layers listing a source with a store at a prefix of `ref` (`subsByPath`), by their indices. Each prefix's
 * text is made one step longer than the last and only looked up, never kept: kept, they would charge a read the square
 * of its path's length. Its steps are read making no id (`PathRef.read`); with `path`, the walk notes the longest prefix
 * of a plain array's steps already made, for its id.
 */
function holdingAt(
  contract: Contract,
  own: ReadonlyMap<Key, readonly number[]>,
  ref: PathRef,
  path?: ReadPath,
): Set<number> {
  const work = contract.pass.program.work;
  const holding = new Set<number>();
  let text = "";
  let found = path === undefined || ref.kind !== "steps" || isPathSteps(ref.steps()) ? -1 : 0;
  for (let length = 1; length <= ref.length && own.size > 0; length += 1) {
    work.charge("invSteps");
    text = length === 1 ? ref.read(0) : stepText(text, ref.read(length - 1));
    if (found >= 0) {
      found = pathBelow(contract, found, ref.read(length - 1));
      if (found >= 0) [path!.found, path!.foundId] = [length, found];
    }
    const having = contract.subsByPath.get(text);
    if (having === undefined) continue;
    // (from the smaller of the sources found and the sources with a store there)
    if (having.size <= own.size)
      for (const sub of having) {
        work.charge("invSteps");
        for (const at of own.get(sub) ?? []) holding.add(at);
      }
    else
      for (const [sub, at] of own) {
        work.charge("invSteps");
        if (having.has(sub)) for (const each of at) holding.add(each);
      }
  }
  return holding;
}

/** The sets below found layers a read passes through: below a found layer holding nothing at its path (`holdingAt`). */
function passedBelow(
  contract: Contract,
  { below, belowOf }: StepLayers,
  holding: ReadonlySet<number>,
): number[] {
  const held = new Map<number, number>();
  for (const index of holding) {
    const set = belowOf[index]!;
    if (set >= 0) held.set(set, (held.get(set) ?? 0) + 1);
  }
  const passed: number[] = [];
  for (let index = 0; index < below.length; index += 1) {
    contract.pass.program.work.charge("invSteps");
    // (below layers that all hold a source at the path, the set is in their summaries)
    if ((held.get(index) ?? 0) < below[index]!.over) passed.push(index);
  }
  return passed;
}

/** A set of listing layers' own layers, found under a step with no stores of a prefix bringing them. */
function setFound(contract: Contract, set: SupportNode): () => LayerFound[] {
  return () => layersIn(contract, set).map((layer) => ({ layer, defs: null }));
}

/**
 * The layers holding a source at `ref` in a set of listing layers or below them, as one set, once per set and path
 * (`Contract.holdersBelow`): of the set's layers found under the path's first step (`stepLayersOf`), those listing a
 * source with a store at a prefix of the path; and below any that holds nothing there, which a read passes through, the
 * holders in the set below it (`SubLayer.under`), in turn. On an explicit stack, each set below answered first and once.
 * By the path's id (`Contract.holdersBelow`); a read's path without one yet (`madePathId`) by the read's own answers
 * (`ReadPath.holders`), kept under its id when one is made, so a read's selection makes no id (r4.262).
 */
function holdersIn(
  contract: Contract,
  set: SupportNode,
  ref: PathRef,
  path: number | Map<SupportNode, SupportNode | null>,
): SupportNode | null {
  const step = ref.read(0);
  const answered = (each: SupportNode): SupportNode | null | undefined =>
    typeof path === "number" ? contract.holdersBelow.get(each)?.get(path) : path.get(each);
  const stack: (readonly [SupportNode, ReadonlySet<number> | null])[] = [[set, null]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [at, ready] = next;
    if (answered(at) !== undefined) continue;
    const layers = stepLayersOf(contract, at, setFound(contract, at), step);
    const holding = ready ?? holdingAt(contract, layers.own, ref);
    const passed = passedBelow(contract, layers, holding);
    const waiting = passed.filter((index) => answered(layers.below[index]!.set) === undefined);
    if (waiting.length > 0) {
      stack.push([at, holding]);
      for (const index of waiting) stack.push([layers.below[index]!.set, null]);
      continue;
    }
    let root: SupportNode | null = null;
    for (const index of holding) root = union(contract, root, layers.found[index]!.layer.self);
    for (const index of passed)
      root = union(contract, root, answered(layers.below[index]!.set) ?? null);
    if (typeof path === "number") holdersOf(contract, at).set(path, root);
    else path.set(at, root);
    contract.keep(1);
  }
  return answered(set) ?? null;
}

/** A set's holders kept by path id (`Contract.holdersBelow`), made where first asked. */
function holdersOf(contract: Contract, set: SupportNode): Map<number, SupportNode | null> {
  let byPath = contract.holdersBelow.get(set);
  if (byPath === undefined) contract.holdersBelow.set(set, (byPath = new Map()));
  return byPath;
}

/**
 * The listing layers a prefix's read at `ref` asks: of those found under its first step (`stepLayersOf`), those listing
 * a source with a store at a prefix of its path, whose summaries hold the layers below them; and for a found layer that
 * holds nothing at the path, which the read passes through, the holders below it (`holdersIn`), with the stores that
 * brought the found layers above them; so the layers asked, and their demands, are the layers holding a source at the
 * path. So k copies joined into one place, each storing its own property below one step, are not each asked per read
 * of one of those properties (#1078), however their joins nest or share a listing layer below them.
 */
export function topsAt(
  contract: Contract,
  stores: PrefixStores,
  ref: PathRef,
  path: ReadPath,
): PrefixStores["also"] {
  const work = contract.pass.program.work;
  // (the first read under a step keeps its memo, as `main`'s, whether or not a layer lists it; later reads read it)
  const step = ref.read(0);
  const layers = stepLayersOf(
    contract,
    stores,
    () => prefixFound(contract, stores, step)?.() ?? [],
    step,
  );
  if (layers.found.length === 0) return [];
  const holding = holdingAt(contract, layers.own, ref, path);
  const out: PrefixStores["also"][number][] = [];
  for (const index of [...holding].sort((a, b) => a - b)) {
    work.charge("invSteps");
    const { layer, defs } = layers.found[index]!;
    out.push({ layer, defs: defs! });
  }
  const passed = passedBelow(contract, layers, holding);
  if (passed.length === 0) return out;
  const answers = madePathId(path) ?? (path.holders ??= new Map());
  for (const index of passed) {
    const { set, defs } = layers.below[index]!;
    for (const layer of layersIn(contract, holdersIn(contract, set, ref, answers)))
      out.push({ layer, defs: defs! });
  }
  return out;
}

/** The layers holding a source at `ref` below a listing layer (`holdersIn` of the set below it), which its summary reads. */
export function childrenAt(
  contract: Contract,
  layer: SubLayer,
  ref: PathRef,
  path: number,
): SubLayer[] {
  const set = listingBelow(contract, layer, ref.at(0));
  return set === null ? [] : layersIn(contract, holdersIn(contract, set, ref, path));
}

/**
 * A prefix's listing layers under `step`, by its per-step map, the only selection of its layers: the listing layers
 * its layers' maps name for the step (`SubLayer.front`), each with the stores that brought the layer it was found
 * under, in their positions' order; `null` where none lists the step. One layer's map is its own (the layer itself
 * where it lists the step). Several layers' map is the union of their maps, each seen under its position
 * (`prefixUnion`), made once per prefix (`Contract.prefixSteps`), in halves of the positions: layers sharing their maps'
 * nodes (two copies of one place) share them in it. A lookup under any step, listed or not, finds the positions listing
 * it and their sets, never a visit to each layer.
 */
function prefixFound(
  contract: Contract,
  stores: PrefixStores,
  step: string,
): (() => readonly LayerFound[]) | null {
  const count = topCount(stores);
  if (count === 0) return null;
  if (count === 1) {
    const { layer: top, defs } = topAt(stores, 0);
    if (top.own.has(step)) return () => [{ layer: top, defs }];
    const set = mapGet(contract, top.under, step);
    return set === null ? null : () => layersIn(contract, set).map((layer) => ({ layer, defs }));
  }
  let map = contract.prefixSteps.get(stores);
  if (map === undefined) {
    let level = Array.from({ length: count }, (_, at): PrefixNode | null => {
      const front = topAt(stores, at).layer.front;
      return front === null ? null : viewOf(contract, front, positionLeaf(contract, at));
    });
    while (level.length > 1) {
      const next: (PrefixNode | null)[] = [];
      for (let at = 0; at < level.length; at += 2)
        next.push(
          at + 1 < level.length ? prefixUnion(contract, level[at]!, level[at + 1]!) : level[at]!,
        );
      level = next;
    }
    map = level[0]!;
    contract.prefixSteps.set(stores, map);
    contract.keep(1);
  }
  const sets = prefixAt(contract, map, step);
  if (sets === null) return null;
  return () =>
    sets()
      .flatMap(([set, positions]) =>
        positionsIn(contract, positions).map((at) => [at, set] as const),
      )
      .sort(([a], [b]) => a - b)
      .flatMap(([at, set]) => {
        const { defs } = topAt(stores, at);
        return layersIn(contract, set).map((layer) => ({ layer, defs }));
      });
}

/**
 * The sources a prefix's property reads apart from the shared entries, in their keys' order, each with the prefix's
 * stores that brought a layer listing it (A5's candidates): those its layers list under the property's first step with
 * stores of their own at the property's path or above it below their root (`layerSupport`). The exact enumeration,
 * which costs its output: a consumer that needs less reads a layer's summary (`summaryItems` and its siblings).
 */
export function relevantSubs(
  contract: Contract,
  stores: PrefixStores,
  asked: Rest,
): readonly SubSource[] {
  const ref = restRef(contract, asked);
  if (ref.length === 0) return [];
  const read = readPath(ref);
  const tops = topsAt(contract, stores, ref, read);
  if (tops.length === 0) return [];
  const path = pathIdAt(contract, read);
  // (a source's stores: the set of the one layer listing it, shared; a set of its own, made and charged as the second
  // layer listing it is met, where several do)
  const found = new Map<Key, ReadonlySet<Definition | null>>();
  const owned = new Map<Key, Set<Definition | null>>();
  for (const { layer, defs } of tops)
    for (const sub of sourcesOf(contract, layerSupport(contract, layer, ref, path))) {
      const brought = found.get(sub);
      if (brought === undefined || brought === defs) {
        found.set(sub, defs);
        continue;
      }
      let own = owned.get(sub);
      if (own === undefined) {
        contract.pass.program.work.charge("invSteps", brought.size);
        owned.set(sub, (own = new Set(brought)));
        found.set(sub, own);
      }
      contract.pass.program.work.charge("invSteps", defs.size);
      for (const d of defs) own.add(d);
    }
  contract.facts.listedSources += found.size;
  return [...found]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, defs]) => ({ key, defs }));
}

/**
 * Every source of a prefix's layers, inherited and joined (the answers' properties), in the order first met: each
 * layer's own, then the layer below it and its joins in turn, each layer once.
 */
export function subSources(stores: PrefixStores): Key[] {
  const out = new Set<Key>();
  const seen = new Set<SubLayer>();
  const stack: SubLayer[] = [];
  for (let at = topCount(stores) - 1; at >= 0; at -= 1) stack.push(topAt(stores, at).layer);
  for (let layer = stack.pop(); layer !== undefined; layer = stack.pop()) {
    if (seen.has(layer)) continue;
    seen.add(layer);
    for (const [, set] of layer.own) for (const sub of set) out.add(sub);
    const next = below(layer);
    for (let index = next.length - 1; index >= 0; index -= 1) stack.push(next[index]!);
  }
  return [...out];
}
