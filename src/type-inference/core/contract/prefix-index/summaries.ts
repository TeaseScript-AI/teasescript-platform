// A read's summary of a prefix's layers: its items, count and presence, and the proofs that carry it.

import {
  isKeyId,
  keyIdAt,
  keyIdPath,
  keyIdPlace,
  type PathRef,
  type Rest,
  restRef,
  stepsOfId,
} from "../key-ids.js";
import { joinParts } from "../../budget.js";
import type { Contract } from "../../contract.js";
import { keyOf, type Definition, type Key } from "../../definitions.js";
import { withoutEmpty } from "../../exact-path.js";
import { type Item } from "../../items.js";
import type { ProofDemand, Proven, Work } from "../../solver.js";
import type { FlowSink } from "../contributions.js";
import { marksAt } from "../marks.js";
import type { LayerProof, PrefixStores, PresenceStep, SubLayer, SupportNode } from "../model.js";
import { presenceSteps, summaryLeaf, union } from "./tries.js";
import {
  type ReadPath,
  aliasLayer,
  atPath,
  childrenAt,
  listingBelow,
  ownHas,
  pathIdAt,
  projectedLayer,
  readPath,
  topsAt,
} from "./layers.js";
import { prefixStores } from "./stores.js";
import { Retained } from "../../retained/retained.js";

// #1466: what a consumer reads of a prefix's layers at a path, as one summary per layer and path: a demand that proves
// its support with each source's own answer (`subAt`) in its leaf, so the solver owns it as every answer (its reads,
// components, stops and `forget`), and a layer's summary reads the summaries of the layers below it. A layer's demand
// is named by its origin and the path (`LayerOrigin`), so another pass finds it (`replayLayer`, #1422). A read whose
// layers are one layer with one source to answer it makes no summary: it asks that source's demand by reference
// (`singleSource`), which owns the read's dependencies and stops as any source read does; a summary's
// name asked in another pass is still found and made there (`replayLayer`).

/**
 * A summary that declined: a source the per-source reading (`relevantSubs`, `subAt`) treats apart, or a layer below
 * that declined.
 */
const DECLINED: LayerProof = { root: null, declined: true, signature: () => "declined" };

/** The proof of a summary over `root`. */
function summaryProof(contract: Contract, root: SupportNode | null): LayerProof {
  return {
    root,
    declined: false,
    // (a node is one per set of sources and contents, so its id tells every two summaries apart)
    signature: () => {
      contract.pass.program.work.charge("sigItems");
      return root === null ? "none" : String(root.id);
    },
  };
}

/**
 * A layer's summary at the path `path` as a demand, once per layer and path id: its name (`protoLayer|<origin kind>|
 * <origin cursor>|.<path id>`) made and charged once, its run reading the path from the arena's record of it.
 */
function layerDemand(contract: Contract, layer: SubLayer, path: number): ProofDemand<LayerProof> {
  const at = atPath(contract, layer, path);
  if (at.demand !== undefined) return at.demand;
  const { kind, key } = layer.origin!;
  const name = joinParts("protoLayer", kind, key, `.${path}`);
  contract.keepText(name.length);
  contract.keep(1);
  contract.facts.layerDemands += 1;
  at.demand = {
    key: name,
    kind: "contract",
    file: -1,
    offset: -1,
    proves: true,
    // #1668: the demand's own run: its frame's flow, taken as it starts
    // (#1072 R26: captures the contract (an owner), `layer`, fixed when it is made, and `path`, a number)
    make: Retained.closure("SubLayer.paths.demand", () =>
      layerMade(contract, layer, stepsOfId(contract, keyIdAt(0, path)).rest(), path),
    ),
  };
  return at.demand;
}

/**
 * A layer's summary at a path: its own sources there with a store at a prefix of the path, each read as its own
 * answer (`subAt`), over the summaries of the layers below it. It declines where a source's holder marks the path
 * or its answer holds a guarded, called or fanned item, which the per-source reading treats apart, and where a
 * layer below declines or has no origin.
 */
function* layerMade(
  contract: Contract,
  layer: SubLayer,
  rest: PathRef,
  path: number,
): Work<Proven<LayerProof>> {
  // (#1668: its sources' and the layers' below it, staged: a summary that declines includes none of them)
  const flow = contract.pass.solver.sink();
  const staged = flow?.child() ?? null;
  let root: SupportNode | null = null;
  for (const sub of layer.own.get(rest.at(0)) ?? []) {
    contract.pass.program.work.charge("invSteps");
    if (!ownHas(contract, sub, rest)) continue;
    if (marksAt(contract, contract.keyIdentity(sub).holder, rest))
      return { items: [], proof: DECLINED };
    const items = yield* contract.subAt(sub, rest, staged);
    if (!summarised(items)) return { items: [], proof: DECLINED };
    root = union(contract, root, summaryLeaf(contract, sub, items));
  }
  for (const child of childrenAt(contract, layer, rest, path)) {
    if (child.origin === null) return { items: [], proof: DECLINED };
    const demand = layerDemand(contract, child, path);
    staged?.include(demand.key, "summary");
    const { proof } = yield* contract.pass.solver.proven(demand);
    if (proof === null || proof.declined) return { items: [], proof: DECLINED };
    root = union(contract, root, proof.root);
  }
  if (staged !== null) flow!.attach(staged);
  return { items: root?.items ?? [], proof: summaryProof(contract, root) };
}

/**
 * The layers a summary of a prefix's layers reads at a path, each with the stores that brought its top, and the path,
 * its id made only where a summary's demand needs it (`pathIdAt`): a read one source answers by reference makes none.
 */
interface LayersAt {
  readonly layers: readonly {
    readonly layer: SubLayer;
    readonly defs: ReadonlySet<Definition | null>;
  }[];
  readonly path: ReadPath;
}

/**
 * The listing layers a summary of a prefix's layers at `rest` reads (`topsAt`), found without
 * a demand: none where no layer may hold a source there; `undefined` where the prefix's stores are cut at an open copy
 * cycle or a layer has no origin, so the consumer reads each source by itself (`relevantSubs`).
 *
 * No path or span id is made while a read's selection runs, here and in `singleSource`'s choice: the
 * read's steps are read through `PathRef.read`, its id looked up where made (`madePathId`), and the holders below the
 * layers it passes kept per made id or, without one, in the read's own map (`ReadPath.holders`); an id is made only for
 * a summary's demand (`pathIdAt`). The holder mark check reads the source's own identity (`keyIdentity`), as every
 * reading of that source does.
 */
function layersAt(contract: Contract, stores: PrefixStores, rest: Rest): LayersAt | undefined {
  const ref = restRef(contract, rest);
  const read = readPath(ref);
  if (ref.length === 0) return { layers: [], path: read };
  const tops = topsAt(contract, stores, ref, read);
  if (tops.length === 0) return { layers: [], path: read };
  if (stores.cut) return undefined;
  const layers: LayersAt["layers"][number][] = [];
  for (const { layer, defs } of tops) {
    if (layer.origin === null) return undefined;
    layers.push({ layer, defs });
  }
  return { layers, path: read };
}

/** The union of the summaries of the layers `layersAt` found; `undefined` where one declines. */
function* unionOf(
  contract: Contract,
  at: LayersAt,
  flow: FlowSink | null = null,
): Work<SupportNode | null | undefined> {
  const roots: SupportNode[] = [];
  for (const { layer } of at.layers) {
    const demand = layerDemand(contract, layer, pathIdAt(contract, at.path));
    // (#1668: a layer's summary, whose proof's root holds the items the prefix's answer takes)
    flow?.include(demand.key, "summary");
    const { proof } = yield* contract.pass.solver.proven(demand);
    if (proof === null || proof.declined) return undefined;
    if (proof.root !== null) roots.push(proof.root);
  }
  // (united in halves of the summaries in their first keys' order, so summaries of different sources join at one
  // branch per two halves; a union is the same in any order)
  let level: (SupportNode | null)[] = roots.sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  contract.pass.program.work.charge("invSteps", level.length);
  while (level.length > 1) {
    const next: (SupportNode | null)[] = [];
    for (let index = 0; index < level.length; index += 2)
      next.push(
        index + 1 < level.length
          ? union(contract, level[index]!, level[index + 1]!)
          : level[index]!,
      );
    level = next;
  }
  return level[0] ?? null;
}

/** Whether a source's answer is one a summary takes: none of its items guarded, called or fanned (`layerMade`). */
function summarised(items: readonly Item[]): boolean {
  return !items.some(
    (item) => item.guarded === true || item.called === true || item.fan !== undefined,
  );
}

/**
 * The one source a read of a prefix's layers at `rest` asks directly, or
 * `null`: where `layersAt` found one layer, with one own source under the path's first step and no listing layer below
 * that step (`listingBelow`), whose holder marks nothing at the path, that layer's summary is the source's answer
 * alone, so the read asks the source's own demand (`subAt`) at the caller's path as given, an array or a cursor, never
 * the layer's demand; the selection (`topsAt`) has found the source's store at a prefix of the path. Every other shape
 * reads its summaries.
 */
function singleSource(contract: Contract, at: LayersAt, rest: Rest): Key | null {
  if (at.layers.length !== 1) return null;
  const { layer } = at.layers[0]!;
  const first = restRef(contract, rest).read(0);
  const own = layer.own.get(first);
  if (own?.size !== 1 || listingBelow(contract, layer, first) !== null) return null;
  const [sub] = own;
  contract.pass.program.work.charge("invSteps");
  return marksAt(contract, contract.keyIdentity(sub!).holder, rest) ? null : sub!;
}

/** `contractAlong`'s items of a prefix's layers at `rest`: every source's answer merged in their keys' order. */
export function* summaryItems(
  contract: Contract,
  stores: PrefixStores,
  rest: Rest,
  flow: FlowSink | null = null,
): Work<readonly Item[] | null> {
  const at = layersAt(contract, stores, rest);
  if (at === undefined) return null;
  // (#1668: staged until the summary is taken; where it declines, its caller reads each source and includes those)
  const staged = flow?.child() ?? null;
  const sub = singleSource(contract, at, rest);
  if (sub !== null) {
    const items = yield* contract.subAt(sub, rest, staged);
    if (!summarised(items)) return null;
    if (staged !== null) flow!.attach(staged, "summary");
    return items;
  }
  const root = yield* unionOf(contract, at, staged);
  if (root === undefined) return null;
  if (staged !== null) flow!.attach(staged, "summary");
  return root?.items ?? [];
}

/** `severalWork`'s count of a prefix's layers at `rest`: the distinct sources whose answer holds an element, to two. */
export function* summaryCount(
  contract: Contract,
  stores: PrefixStores,
  rest: Rest,
): Work<number | null> {
  const at = layersAt(contract, stores, rest);
  if (at === undefined) return null;
  const sub = singleSource(contract, at, rest);
  if (sub !== null) {
    // #1668: a count, a presence test or an offending test over the sources
    const items = yield* contract.subAt(sub, rest);
    return summarised(items) ? (withoutEmpty(items).length > 0 ? 1 : 0) : null;
  }
  // #1668: a count over the layers' summaries
  const root = yield* unionOf(contract, at);
  return root === undefined ? null : (root?.count ?? 0);
}

/**
 * A property's presence after a prefix's layers at `rest`, read in their sources' order from the incoming state `mask`,
 * its demands run by `run`, with the read's allowance, and nothing run where no layer may hold a source there; `null`
 * where a summary declines or the run stops.
 */
export function summaryPresence(
  contract: Contract,
  stores: PrefixStores,
  rest: Rest,
  mask: number,
  run: (work: Work<readonly Item[]>) => readonly Item[],
): PresenceStep | null {
  const at = layersAt(contract, stores, rest);
  if (at === undefined) return null;
  let after: PresenceStep | null = { mask, unknown: false, literal: null };
  if (at.layers.length === 0) return after;
  const sub = singleSource(contract, at, rest);
  after = null;
  run(
    // #1668: presence evidence
    (function* (): Work<readonly Item[]> {
      if (sub !== null) {
        // #1668: a count, a presence test or an offending test over the sources
        const items = yield* contract.subAt(sub, rest);
        if (summarised(items)) after = presenceSteps(items)[mask]!;
        return [];
      }
      // #1668: a presence test over the layers' summaries
      const root = yield* unionOf(contract, at);
      if (root !== undefined)
        after = root === null ? { mask, unknown: false, literal: null } : root.presence![mask]!;
      return [];
    })(),
  );
  return after;
}

/**
 * The conflict candidates of a prefix's layers at `rest`: the stores that brought each layer whose summary holds an
 * offending item (`offends` holds of a merge exactly where it holds of one of the merged sources' answers), its demands
 * run by `run`, nothing run where no layer may hold a source there; `null` where a
 * summary declines.
 */
export function offendingStores(
  contract: Contract,
  stores: PrefixStores,
  rest: Rest,
  offends: (items: readonly Item[]) => boolean,
  run: (work: Work<ReadonlySet<Definition | null> | null>) => ReadonlySet<Definition | null> | null,
): ReadonlySet<Definition | null> | null {
  const at = layersAt(contract, stores, rest);
  if (at === undefined) return null;
  const out = new Set<Definition | null>();
  if (at.layers.length === 0) return out;
  const sub = singleSource(contract, at, rest);
  return run(
    (function* (): Work<ReadonlySet<Definition | null> | null> {
      if (sub !== null) {
        // #1668: a count, a presence test or an offending test over the sources
        const items = yield* contract.subAt(sub, rest);
        if (!summarised(items)) return null;
        if (offends(items)) {
          const { defs } = at.layers[0]!;
          contract.pass.program.work.charge("invSteps", defs.size);
          for (const d of defs) out.add(d);
        }
        return out;
      }
      for (const { layer, defs } of at.layers) {
        // #1668: the offending test over the layers' summaries
        const { items, proof } = yield* contract.pass.solver.proven(
          layerDemand(contract, layer, pathIdAt(contract, at.path)),
        );
        if (proof === null || proof.declined) return null;
        if (!offends(items)) continue;
        contract.pass.program.work.charge("invSteps", defs.size);
        for (const d of defs) out.add(d);
      }
      return out;
    })(),
  );
}

/**
 * A layer summary's demand asked by its name in another pass (#1422, `solveDemands`): its layer found again from its
 * origin through this pass's own stores (an alias's from its place's prefix, a projected copy's from its place and
 * path), never by a number another pass allocated; rejected where this pass cuts the place's stores at an open copy
 * cycle or finds no such layer.
 */
export function* replayLayer(contract: Contract, parts: readonly string[]): Work<readonly Item[]> {
  const [kind, origin, span] = parts;
  // (a path id of this pass's arena, as `importNames` makes the tokens)
  const inArena = (id: number): boolean =>
    Number.isInteger(id) && id >= 0 && id < contract.pathParents.length;
  const path = span?.startsWith(".") === true ? Number(span.slice(1)) : -1;
  if (
    origin === undefined ||
    !isKeyId(origin) ||
    !Number.isInteger(keyIdPlace(origin)) ||
    !inArena(keyIdPath(origin)) ||
    !inArena(path)
  )
    throw new Error(`No layer is written '${parts.join("|")}'.`);
  const place = keyIdPlace(origin);
  let layer: SubLayer | null;
  if (kind === "alias") {
    const inner = prefixStores(contract, keyOf(place, []));
    if (inner.cut) throw new Error(`The stores of the layer '${parts.join("|")}' are cut here.`);
    layer = aliasLayer(contract, inner, place);
  } else if (kind === "projected")
    layer = projectedLayer(contract, place, stepsOfId(contract, origin));
  else throw new Error(`No layer is written '${parts.join("|")}'.`);
  if (layer?.origin?.kind !== kind || layer.origin.key !== origin)
    throw new Error(`No layer comes from '${parts.join("|")}' here.`);
  // (#1668: a replayed name's answer is the layer's summary)
  const demand = layerDemand(contract, layer, path);
  contract.pass.solver.sink()?.include(demand.key, "summary");
  return (yield* contract.pass.solver.proven(demand)).items;
}
