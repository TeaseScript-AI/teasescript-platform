import type { PlaceId } from "../../graph.js";
import {
  arrayRef,
  type CanonicalKey,
  isKeyId,
  isPathSteps,
  keptKeyBelowIn,
  keyDepthIn,
  keyIdAt,
  keyIdPath,
  keyIdPlace,
  keyStepsIn,
  type PathRef,
  type Rest,
  restRef,
  rootId,
  stepsArray,
  stepsOfId,
  stepsPrefixText,
  stepsText,
  type Steps,
} from "./key-ids.js";
import { joinParts, keepText, keptParts, keptSteps, keptText, stepText } from "../budget.js";
import type { Contract } from "../contract.js";
import {
  keptKey,
  keptKeyOfText,
  keyOf,
  keyOfText,
  keyPath,
  keyPlace,
  type Definition,
  type Key,
} from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import {
  firstWriter,
  itemsSignature,
  mergeItems,
  REASON,
  type Item,
  type Writer,
} from "../items.js";
import type { ProofDemand, Proven, Work } from "../solver.js";
import { copyOnly, subFirstOf } from "./identity.js";
import { ingressLeafOf } from "./ingress.js";
import { pathAt, pathBelow } from "./literal-index.js";
import { holderAt, marksAt } from "./marks.js";
import type {
  CopyRing,
  EntryDraft,
  IdentityWork,
  LayerFound,
  LayerOrigin,
  LayerPath,
  LayerProof,
  PrefixFrame,
  PrefixNode,
  PrefixStores,
  PresenceStep,
  StepLayers,
  SubLayer,
  SubSource,
  SupportNode,
} from "./model.js";

// The prefix index: the whole stores of a prefix, its layers, and the sources its properties read.

/**
 * The root a store copies whole where `prefixWork` follows the copy into its source's own stores: a live whole store,
 * neither a parameter's default nor an argument of an unwritten parameter with several sites, copying (not calling)
 * an unguarded read of a copy-only place's root; `null` for every other store.
 */
function copiedRoot(contract: Contract, d: Definition): PlaceId | null {
  const { program, lists, guards } = contract.pass;
  if (!lists.live(d) || d.kind !== "whole" || d.how === "parameter default") return null;
  if (d.how === "argument") {
    const parameter = program.place(d.place).kind;
    if (parameter.kind === "parameter" && parameter.written === null && !lists.singleSite(d.fn))
      return null;
  }
  const copied = contract.copiedKey(d.value!);
  if (copied === null || keyDepthIn(contract, copied) > 0 || guards.guardedRead(d.value!))
    return null;
  return copyOnly(contract, keyPlace(copied)) ? keyPlace(copied) : null;
}

/** Whether `place` is a stop of a cycle of whole copies (`CopyRing`): a copy of it is an entry of its key. */
function ringStop(contract: Contract, place: PlaceId): boolean {
  return ringOf(contract, place)?.stops.has(place) === true;
}

/**
 * The cycle of whole copies `place` is a port of, or `null`: Tarjan's components over the copies `copiedRoot` follows,
 * from `place` over the places they reach, on an explicit stack, each place once per pass (one reached in an earlier
 * walk is in a finished component). A component of links alone, each copying the next, holds no stop: no cycle here,
 * `prefixWork` cuts it at its open member as before.
 */
function ringOf(contract: Contract, place: PlaceId): CopyRing | null {
  const known = contract.rings.get(place);
  if (known !== undefined) return known;
  if (!copyOnly(contract, place)) {
    contract.rings.set(place, null);
    return null;
  }
  const { definitions, lists } = contract.pass;
  const work = contract.pass.program.work;
  const index = new Map<PlaceId, number>();
  const low = new Map<PlaceId, number>();
  const held = new Set<PlaceId>();
  const order: PlaceId[] = [];
  const frames: { readonly at: PlaceId; readonly to: readonly PlaceId[]; next: number }[] = [];
  const rootsOf = (at: PlaceId): PlaceId[] => {
    const to: PlaceId[] = [];
    for (const d of definitions.byKey.get(keyOf(at, [])) ?? []) {
      work.charge("invSteps");
      const root = copiedRoot(contract, d);
      if (root !== null) to.push(root);
    }
    return to;
  };
  const visit = (at: PlaceId): void => {
    const number = index.size;
    index.set(at, number);
    low.set(at, number);
    held.add(at);
    order.push(at);
    frames.push({ at, to: rootsOf(at), next: 0 });
  };
  visit(place);
  while (frames.length > 0) {
    const top = frames.at(-1)!;
    if (top.next < top.to.length) {
      const to = top.to[top.next++]!;
      work.charge("invSteps");
      if (contract.rings.has(to)) continue;
      if (!index.has(to)) visit(to);
      else if (held.has(to)) low.set(top.at, Math.min(low.get(top.at)!, index.get(to)!));
      continue;
    }
    frames.pop();
    const lowest = low.get(top.at)!;
    if (frames.length > 0) {
      const parent = frames.at(-1)!.at;
      low.set(parent, Math.min(low.get(parent)!, lowest));
    }
    if (lowest !== index.get(top.at)) continue;
    const members: PlaceId[] = [];
    for (;;) {
      const member = order.pop()!;
      held.delete(member);
      members.push(member);
      if (member === top.at) break;
    }
    let ring: CopyRing | null = null;
    if (members.length > 1 || top.to.includes(top.at)) {
      // (a link has one live store at its root, the copy of another member; every other member is a stop)
      const stops = new Set<PlaceId>();
      for (const member of members) {
        let live = 0;
        for (const d of definitions.byKey.get(keyOf(member, [])) ?? []) {
          work.charge("invSteps");
          if (lists.live(d)) live += 1;
        }
        if (live !== 1) stops.add(member);
      }
      if (stops.size > 0) {
        ring = { ports: members.reverse(), stops };
        contract.facts.ringComponents += 1;
        contract.facts.ringPorts += members.length;
        contract.facts.ringStops += stops.size;
      }
    }
    for (const member of members) contract.rings.set(member, ring);
  }
  return contract.rings.get(place)!;
}

/**
 * The whole stores of a prefix, which every key below it shares (`state = preset` stored k times and read at k fields
 * is k stores, not k × k): one entry per source identity; a copied place that holds nothing but whole stores and has
 * at most one entry (an alias) is replaced by that entry; an add is an entry of its element, a clear or a removal one
 * of emptiness; an argument of an unwritten parameter with several sites is a deferred unknown. An explicit stack,
 * memoised per pass. A cycle of whole copies is cut at its stops at once (`CopyRing`, G5): a copy of a stop stays an
 * entry of its key, which the solver's fixpoint then closes, so each member's stores are one answer, whichever place
 * entered the cycle; any other key still open (a copy cycle through a projection) stays an entry, cut there.
 */
export function prefixStores(contract: Contract, asked: Key): PrefixStores {
  // (a key in its identity: a wrapper family's text read as its cursor, G3 stage 1)
  const prefix = contract.canonicalKey(asked);
  if (!contract.prefix.has(prefix)) contract.settle(prefixWork(contract, prefix));
  return contract.prefix.get(prefix)!;
}

export function* prefixWork(contract: Contract, prefix: CanonicalKey): IdentityWork {
  if (contract.prefix.has(prefix)) return;
  const { program, definitions, lists, guards } = contract.pass;
  const work = program.work;
  const frame = (pk: CanonicalKey): PrefixFrame => ({
    pk,
    defs: definitions.byKey.get(pk) ?? [],
    i: 0,
    out: [],
    seen: new Map(),
    w: null,
    d: null,
    inherit: null,
    inheritedBy: new Set(),
    also: new Map(),
    ck: null,
    proj: null,
    inner: undefined,
    other: false,
    cut: false,
  });
  const entryId = (e: EntryDraft): string =>
    e.key !== undefined
      ? contract.keyIdentity(e.key).id
      : e.unk !== undefined
        ? `u${e.unk}`
        : e.empty === true
          ? "e"
          : e.elem !== undefined
            ? `a${contract.structureOf(e.elem)}@${keptText(contract.work, e.at ?? [])}`
            : `${contract.structureOf(e.value!)}@${keptText(contract.work, e.at ?? [])}`;
  const add = (f: PrefixFrame, e: EntryDraft): void => {
    work.charge("invSteps");
    const id = entryId(e);
    const w = e.w !== undefined ? e.w : f.w;
    const value = e.elem ?? e.value;
    const leaf =
      (value !== undefined && e.at === undefined) || e.elem !== undefined
        ? ingressLeafOf(contract, value!)
        : undefined;
    const ingress = leaf === undefined ? e.ingress : program.scope.ingress.union(e.ingress, leaf);
    const index = f.seen.get(id);
    if (index === undefined) {
      f.seen.set(id, f.out.length);
      contract.facts.prefixEntries += 1;
      // its marks: its identity's holder; a stored value at a path is that value's holder lifted there
      const holder =
        e.key !== undefined
          ? contract.keyIdentity(e.key).holder
          : e.elem !== undefined
            ? contract.identityOf(e.elem).holder
            : e.value !== undefined
              ? holderAt(contract, contract.identityOf(e.value).holder, e.at ?? [])
              : null;
      f.out.push({
        ...(e.key !== undefined ? { key: e.key } : {}),
        ...(e.unk !== undefined ? { unk: e.unk } : {}),
        ...(e.empty === true ? { empty: true as const } : {}),
        ...(e.elem !== undefined ? { elem: e.elem } : {}),
        ...(e.value !== undefined ? { value: e.value } : {}),
        ...(e.at !== undefined ? { at: e.at } : {}),
        w,
        ds: new Set([f.d]),
        holder,
        guarded: e.guarded === true,
        ingress,
      });
    } else {
      const entry = f.out[index]!;
      entry.ds.add(f.d);
      entry.w = firstWriter(entry.w, w);
      if (e.guarded === true) entry.guarded = true;
      if (ingress !== undefined)
        entry.ingress = program.scope.ingress.union(entry.ingress, ingress);
    }
  };
  // an entry with the identities it reads computed first
  const adding = function* (contract: Contract, f: PrefixFrame, e: EntryDraft): IdentityWork {
    yield* contract.ready(e);
    add(f, e);
  };
  // an inherited layer is shared, never copied; a further one, a join of two copies, is referenced beside it with the
  // stores that brought it, never flattened per destination (r4.46 (3))
  const addSubs = (f: PrefixFrame, layer: SubLayer | null): void => {
    if (layer === null) return;
    work.charge("invSteps");
    if (f.inherit === null || f.inherit === layer) {
      f.inherit = layer;
      f.inheritedBy.add(f.d);
      return;
    }
    let defs = f.also.get(layer);
    if (defs === undefined) {
      f.also.set(layer, (defs = new Set()));
      contract.facts.prefixEntries += 1;
    }
    defs.add(f.d);
  };
  const open = new Set<CanonicalKey>([prefix]);
  const stack: PrefixFrame[] = [];
  const push = (f: PrefixFrame): void => {
    stack.push(f);
    if (!contract.discovering.has(f.pk)) contract.discovering.set(f.pk, f);
  };
  push(frame(prefix));
  while (stack.length > 0) {
    const f = stack.at(-1)!;
    if (f.inner !== undefined && f.proj !== null) {
      // a projected copy (`state.stats = preset7.stats`): an alias root is replaced by its target at the path, its
      // own stores below the path kept apart, so k such copies are one entry, not k entries asked at every property
      const inner = f.inner;
      const projection = f.proj;
      f.inner = undefined;
      f.proj = null;
      const copiedPlace = keyPlace(f.ck!);
      // the root's own stores below it only (rescanned below at the path), no source inherited through the alias
      const ownSubsOnly =
        inner.also.length === 0 &&
        (inner.subs === null || inner.subs.only === keyOf(copiedPlace, []));
      const e = inner.list.length === 1 && !inner.other && ownSubsOnly ? inner.list[0]! : null;
      if (e === null || (e.key === undefined && e.value === undefined))
        yield* adding(contract, f, { key: f.ck! });
      else {
        yield* adding(contract, f, {
          ...(e.key !== undefined
            ? { key: keptKeyBelowIn(contract, e.key, projection) }
            : {
                value: e.value!,
                at: keptSteps(contract.work, e.at ?? [], stepsArray(projection)),
              }),
          ...(e.guarded ? { guarded: true } : {}),
          ingress: e.ingress,
        });
        // a source's own stores below the path, listed once per source and path and shared by every prefix that
        // copies it there (§8 r4.15, r4.38)
        addSubs(f, projectedLayer(contract, copiedPlace, projection));
      }
      continue;
    }
    // an alias (at most one entry) is replaced, with its own stores below the root kept apart by their first step
    // (a preset changed in one field); a longer list stays one entry, so copies of it do not copy it
    if (f.inner !== undefined) {
      const inner = f.inner;
      f.inner = undefined;
      if (inner.list.length > 1 || inner.other) yield* adding(contract, f, { key: f.ck! });
      else {
        // the copied entries keep their identity, so their marks are their holders: nothing to carry
        for (const e of inner.list) {
          work.charge("invSteps");
          yield* adding(contract, f, { ...e, w: f.w, guarded: e.guarded, ingress: e.ingress });
        }
        // the source's own stores below its root over the layers it inherits and joins, one layer per source shared
        // by its copies (r4.38: k copies of a source edited at k fields are k inheritances, not k × k listings)
        addSubs(f, aliasLayer(contract, inner, keyPlace(f.ck!)));
      }
    }
    if (f.i < f.defs.length) {
      const d = f.defs[f.i++]!;
      work.charge("invSteps");
      if (!lists.live(d)) continue;
      f.w = definitions.writerOf(d);
      f.d = d;
      if (d.kind === "const") {
        f.other = true;
        yield* adding(contract, f, { unk: REASON.opaque });
        continue;
      }
      if (d.kind === "add") {
        f.other = true;
        // an add's marks stand below the inserted value
        const source = yield* contract.needValue(d.value!);
        yield* adding(contract, f, {
          elem: d.value!,
          at: d.how === "elements" ? ["element"] : [],
          guarded: source.guarded,
        });
        continue;
      }
      if (d.kind !== "whole") {
        f.other = true;
        yield* adding(contract, f, { empty: true });
        continue;
      }
      if (d.how === "argument" || d.how === "parameter default") {
        const parameter = program.place(d.place).kind;
        const deferred =
          parameter.kind === "parameter" && parameter.written === null && !lists.singleSite(d.fn);
        // F21: a single non-recursive call's binding is exact, its argument's and its default's alike; an exact
        // argument that copies a record is a copy of it, as a `let` is, shared by every field below it (W34)
        if (d.how === "parameter default" || deferred || contract.copiedKey(d.value!) === null) {
          f.other = true;
          if (deferred) yield* adding(contract, f, { unk: REASON.deferred });
          const source = yield* contract.needValue(d.value!);
          yield* adding(contract, f, { value: d.value!, guarded: source.guarded });
          continue;
        }
      }
      const copied = contract.copiedKey(d.value!);
      if (copied === null) {
        // a call's result is its callee's result key (F20, §8 r4.13): k stores of one function's result, one entry
        const result = contract.resultKey(d.value!);
        yield* adding(contract, f, result !== null ? { key: result } : { value: d.value! });
        continue;
      }
      // §3.2: a copy read under a guard is one marked entry of its source, its aliases followed (r4.6)
      if (guards.guardedRead(d.value!)) {
        const source = yield* contract.needValue(d.value!);
        yield* adding(contract, f, { key: source.key!, guarded: true });
        continue;
      }
      // §3.2 (r4.15, r4.23): a copy of a record with a tested key below it is a mark of its source's holder
      // (collected once), looked up at the read of each path; the entry stays its source's
      const path = keyStepsIn(contract, copied);
      if (path.length > 0) {
        const root = contract.keyAt(keyPlace(copied), []);
        let direct = false;
        // (a cursor's keys below its place's own key hold no definition: its family's shape requires it, G3 stage 1)
        for (let length = 1; length <= path.length && !direct && !isKeyId(copied); length += 1) {
          work.charge("invSteps");
          if (
            (
              definitions.byKey.get(keyOfText(keyPlace(copied), stepsPrefixText(path, length))) ??
              []
            ).length > 0
          )
            direct = true;
        }
        // (a copy of a cycle's stop is its key's entry wherever the cycle is entered, never a cut, G5)
        const stop = ringStop(contract, keyPlace(copied));
        if (direct || stop || open.has(root) || !copyOnly(contract, keyPlace(copied))) {
          if (open.has(root) && !stop) f.cut = true;
          yield* adding(contract, f, { key: copied });
          continue;
        }
        f.ck = copied;
        // (the frame keeps the copied key's path while its source's layer is walked, charged as kept)
        keepText(contract.work, copied.length);
        f.proj = path;
        const memoised = contract.prefix.get(root);
        if (memoised !== undefined) {
          f.inner = memoised;
          continue;
        }
        open.add(root);
        push(frame(root));
        continue;
      }
      const stop = ringStop(contract, keyPlace(copied));
      if (stop || open.has(copied) || !copyOnly(contract, keyPlace(copied))) {
        if (open.has(copied) && !stop) f.cut = true;
        yield* adding(contract, f, { key: copied });
        continue;
      }
      f.ck = copied;
      const memoised = contract.prefix.get(copied);
      if (memoised !== undefined) {
        f.inner = memoised;
        continue;
      }
      open.add(copied);
      push(frame(copied));
      continue;
    }
    stack.pop();
    open.delete(f.pk);
    if (contract.discovering.get(f.pk) === f) contract.discovering.delete(f.pk);
    const stores: PrefixStores = {
      list: f.out,
      subs: f.inherit,
      other: f.other,
      inheritedBy: f.inheritedBy,
      also: [...f.also].map(([layer, defs]) => ({ layer, defs })),
      cut: f.cut,
    };
    // a result cut at an open copy cycle (a cycle through a projection, or of links alone) depends on where the query
    // entered it: kept only for its own query, so every order gives one answer
    if (!stores.cut || stack.length === 0) contract.prefix.set(f.pk, stores);
    else stack.at(-1)!.cut = true;
    if (stack.length > 0) stack.at(-1)!.inner = stores;
  }
}

/** The layer an alias of `place` inherits: the place's own stores below its root over the place's layers, once. */
function aliasLayer(contract: Contract, inner: PrefixStores, place: PlaceId): SubLayer | null {
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
function projectedLayer(contract: Contract, place: PlaceId, projection: Steps): SubLayer | null {
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

/** A layer's leaf in a set of layers, by its number (`SubLayer.self`), the sets ordered as the layers were made. */
function setLeaf(contract: Contract, id: number): SupportNode {
  return {
    id: made(contract, 0),
    bit: Infinity,
    key: numberKey(id),
    left: null,
    right: null,
    items: null,
    count: 0,
    presence: null,
    layer: id,
  };
}

/**
 * A step's key in a step map: its number, given at its first listing in a layer and kept (`Contract.stepNumbers`), as two
 * code units (`numberKey`), so a map's depth follows the number of its steps, never their texts' bits.
 */
function stepKey(contract: Contract, step: string): string {
  let id = contract.stepNumbers.get(step);
  if (id === undefined) {
    contract.stepNumbers.set(step, (id = contract.stepNumbers.size));
    contract.keep(1);
  }
  return numberKey(id);
}

/** A step's key if a layer lists it anywhere (`stepKey`), else `null`: no map has it. */
function listedKey(contract: Contract, step: string): string | null {
  const id = contract.stepNumbers.get(step);
  return id === undefined ? null : numberKey(id);
}

/** A step map's leaf: a step's key (`stepKey`) mapped to a set of layers, once per key and set. */
function mapLeaf(contract: Contract, key: string, value: SupportNode): SupportNode {
  let bySet = contract.mapLeaves.get(key);
  if (bySet === undefined) contract.mapLeaves.set(key, (bySet = new Map()));
  const known = bySet.get(value.id);
  if (known !== undefined) return known;
  const leaf: SupportNode = {
    id: made(contract, 0),
    bit: Infinity,
    key,
    left: null,
    right: null,
    items: null,
    count: 0,
    presence: null,
    value,
  };
  bySet.set(value.id, leaf);
  return leaf;
}

/**
 * A step map of `steps`' keys (`stepKey`), in their bits' order, each mapped to `value`: built at once, one branch
 * where the keys part, never a path made again per step. On an explicit stack, as deep as the keys' bits part.
 */
function mapOf(
  contract: Contract,
  steps: readonly string[],
  value: SupportNode,
): SupportNode | null {
  if (steps.length === 0) return null;
  const results: SupportNode[] = [];
  // (a run of steps to map, or two runs' maps to join at the bit they part at)
  const tasks: (readonly [number, number, number?])[] = [[0, steps.length - 1]];
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    const [from, to, split] = task;
    if (split !== undefined) {
      const right = results.pop()!;
      results.push(supportBranch(contract, split, results.pop()!, right));
      continue;
    }
    if (from === to) {
      results.push(mapLeaf(contract, steps[from]!, value));
      continue;
    }
    const at = firstDifference(contract, steps[from]!, steps[to]!);
    // (the run shares every bit above `at`, so its steps with a 0 there come first: the first with a 1 found by halves)
    let low = from + 1;
    let high = to;
    while (low < high) {
      contract.pass.program.work.charge("invSteps");
      const middle = (low + high) >> 1;
      if (bitOf(steps[middle]!, at) === 1) high = middle;
      else low = middle + 1;
    }
    tasks.push([from, to, at], [low, to], [from, low - 1]);
  }
  return results.pop()!;
}

/**
 * An overlay's step on its stack: a map and the map laid over it, or an overlay waiting for its children's, with the
 * bit it parts at and the child it keeps unchanged on either side.
 */
type OverlayTask =
  | {
      readonly base: SupportNode | null;
      readonly over: SupportNode | null;
      readonly bit?: undefined;
    }
  | {
      readonly base: SupportNode;
      readonly over: SupportNode;
      readonly bit: number;
      readonly left: SupportNode | null;
      readonly right: SupportNode | null;
    };

/**
 * `base` with `over`'s steps mapped as `over` maps them instead: down to where the two part and no further, every node
 * of either that the other has no key under shared. On an explicit stack, as deep as the steps' bits part.
 */
function overlay(
  contract: Contract,
  base: SupportNode | null,
  over: SupportNode | null,
): SupportNode | null {
  const results: (SupportNode | null)[] = [];
  const tasks: OverlayTask[] = [{ base, over }];
  // (no memo: a layer's own map, laid over, is its own alone)
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.bit !== undefined) {
      const right = task.right ?? results.pop()!;
      const left = task.left ?? results.pop()!;
      results.push(supportBranch(contract, task.bit, left!, right!));
      continue;
    }
    const { base: under, over: top } = task;
    if (top === null || under === null || under === top) {
      results.push(top ?? under);
      continue;
    }
    const split = firstDifference(contract, under.key, top.key);
    if (split < Math.min(under.bit, top.bit))
      results.push(
        bitOf(under.key, split) === 0
          ? supportBranch(contract, split, under, top)
          : supportBranch(contract, split, top, under),
      );
    else if (under.bit === Infinity && top.bit === Infinity) results.push(top);
    else if (under.bit === top.bit)
      tasks.push(
        { base: under, over: top, bit: under.bit, left: null, right: null },
        { base: under.right, over: top.right },
        { base: under.left, over: top.left },
      );
    else if (under.bit < top.bit) {
      // (the map parting first holds the other whole on one side)
      const leftward = bitOf(top.key, under.bit) === 0;
      tasks.push(
        {
          base: under,
          over: top,
          bit: under.bit,
          left: leftward ? null : under.left,
          right: leftward ? under.right : null,
        },
        { base: leftward ? under.left : under.right, over: top },
      );
    } else {
      const leftward = bitOf(under.key, top.bit) === 0;
      tasks.push(
        {
          base: under,
          over: top,
          bit: top.bit,
          left: leftward ? null : top.left,
          right: leftward ? top.right : null,
        },
        { base: under, over: leftward ? top.left : top.right },
      );
    }
  }
  return results.pop() ?? null;
}

/** The set of layers a step map names for `step`, or `null`: down its key's bits (`stepKey`), each node charged. */
function mapGet(contract: Contract, map: SupportNode | null, step: string): SupportNode | null {
  const key = listedKey(contract, step);
  if (key === null) return null;
  let at = map;
  for (; at !== null && at.bit !== Infinity; at = bitOf(key, at.bit) === 0 ? at.left : at.right)
    contract.pass.program.work.charge("invSteps");
  return at !== null && at.key === key ? (at.value ?? null) : null;
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
function listingBelow(contract: Contract, layer: SubLayer, step: string): SupportNode | null {
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
function ownHas(contract: Contract, sub: Key, ref: PathRef): boolean {
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
interface ReadPath {
  readonly ref: PathRef;
  id: number | undefined;
  /** The longest prefix of a plain array's steps found made (`pathBelow`), its length and its id. */
  found: number;
  foundId: number;
}

/** A path asked below a prefix, its id not yet made (`pathIdAt`). */
function readPath(ref: PathRef): ReadPath {
  return { ref, id: undefined, found: 0, foundId: 0 };
}

/**
 * A read's path's id: a span's and a record's their own (`PathRef.id`, a record's charged as it is made); a plain
 * array's made below the longest prefix its selection found made, each step past it charged: the ids `PathRef.id` makes
 * (`pathAt` per step), in its order.
 */
function pathIdAt(contract: Contract, path: ReadPath): number {
  if (path.id !== undefined) return path.id;
  const { ref } = path;
  if (ref.kind !== "steps" || isPathSteps(ref.steps())) return (path.id = ref.id());
  if (path.found === ref.length) return (path.id = path.foundId);
  contract.pass.program.work.charge("invSteps", ref.length - path.found);
  if (path.found === 0) return (path.id = ref.id());
  let id = path.foundId;
  for (let at = path.found; at < ref.length; at += 1) id = pathAt(contract, id, ref.at(at));
  return (path.id = id);
}

/** A layer's answers at a path, made where first asked. */
function atPath(contract: Contract, layer: SubLayer, path: number): LayerPath {
  let at = layer.paths.get(path);
  if (at === undefined) {
    layer.paths.set(path, (at = {}));
    contract.keep(1);
    contract.facts.supportEdges += 1;
  }
  return at;
}

// #1466: a layer answers a path once, from its own sources and the answers of the layers below it, as a support of
// source keys shared by every layer above it: a persistent binary radix tree, by the bits of the keys' UTF-16 code units
// (`SupportNode`), whose equal sets are one node, so a stack of k copies joined two by two keeps O(k log k) nodes and
// links, never a list of sources per layer.

/** A key's bit `at`: per code unit a lead bit (1 within the key, 0 past its end) and its 16 bits, highest first. */
function bitOf(key: string, at: number): number {
  const unit = Math.floor(at / 17);
  if (unit >= key.length) return 0;
  const offset = at % 17;
  return offset === 0 ? 1 : (key.charCodeAt(unit) >> (16 - offset)) & 1;
}

/** The first bit two keys differ at (`bitOf`), `Infinity` where they are one; the code units compared charged. */
function firstDifference(contract: Contract, a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  let unit = 0;
  while (unit < length && a.charCodeAt(unit) === b.charCodeAt(unit)) unit += 1;
  contract.pass.program.work.charge("invSteps", 1 + (unit >> 3));
  if (unit === length) return a.length === b.length ? Infinity : unit * 17;
  return unit * 17 + Math.clz32(a.charCodeAt(unit) ^ b.charCodeAt(unit)) - 15;
}

/** A node made: its id, counted with what it keeps (a branch its two children). */
function made(contract: Contract, edges: number): number {
  contract.keep(1 + edges);
  contract.facts.supportEdges += edges;
  return contract.facts.supportNodes++;
}

/** A source's leaf in a support of sources alone, once per source. */
function supportLeaf(contract: Contract, sub: Key): SupportNode {
  const known = contract.supportLeaves.get(sub);
  if (known !== undefined) return known;
  const leaf: SupportNode = {
    id: made(contract, 0),
    bit: Infinity,
    key: sub,
    left: null,
    right: null,
    items: null,
    count: 0,
    presence: null,
  };
  contract.supportLeaves.set(sub, leaf);
  return leaf;
}

/**
 * A source's leaf in a summary, once per source and content: its items in their order with everything a reader can
 * tell apart, its ingress stores by their nodes (C9), the text charged as its items' signature is and kept where new.
 */
function summaryLeaf(contract: Contract, sub: Key, items: readonly Item[]): SupportNode {
  const content = items
    .map((item) =>
      joinParts(
        itemsSignature([item], contract.pass.program.scope),
        item.ingress === undefined ? -1 : item.ingress.id,
      ),
    )
    .join(",");
  let bySub = contract.summaryLeaves.get(sub);
  if (bySub === undefined) contract.summaryLeaves.set(sub, (bySub = new Map()));
  const known = bySub.get(content);
  if (known !== undefined) return known;
  contract.keepText(content.length);
  const leaf: SupportNode = {
    id: made(contract, 0),
    bit: Infinity,
    key: sub,
    left: null,
    right: null,
    items,
    count: withoutEmpty(items).length > 0 ? 1 : 0,
    presence: presenceSteps(items),
  };
  bySub.set(content, leaf);
  return leaf;
}

/** The branch of two nodes that part at `bit`, the lesser keys left, once per bit and children; a summary's merged. */
function supportBranch(
  contract: Contract,
  bit: number,
  left: SupportNode,
  right: SupportNode,
): SupportNode {
  let byLeft = contract.supportBranches.get(bit);
  if (byLeft === undefined) contract.supportBranches.set(bit, (byLeft = new Map()));
  let byRight = byLeft.get(left.id);
  if (byRight === undefined) byLeft.set(left.id, (byRight = new Map()));
  const known = byRight.get(right.id);
  if (known !== undefined) return known;
  contract.pass.program.work.charge("invSteps");
  const summary = left.items !== null && right.items !== null;
  const branch: SupportNode = {
    id: made(contract, 2),
    bit,
    key: left.key,
    left,
    right,
    items: summary
      ? mergeItems([...left.items!, ...right.items!], contract.pass.program.scope)
      : null,
    count: Math.min(2, left.count + right.count),
    presence: summary ? thenPresence(left.presence!, right.presence!) : null,
  };
  byRight.set(right.id, branch);
  return branch;
}

/**
 * One key in both nodes: a step map's step with the union of its two sets of layers; a summary's source with its two
 * contents merged in the order the nodes were made.
 */
function mergedLeaf(contract: Contract, a: SupportNode, b: SupportNode): SupportNode {
  if (a.value !== undefined)
    return mapLeaf(contract, a.key, union(contract, a.value, b.value ?? null)!);
  const [first, then] = a.id < b.id ? [a, b] : [b, a];
  return summaryLeaf(
    contract,
    first.key,
    mergeItems([...first.items!, ...then.items!], contract.pass.program.scope),
  );
}

/**
 * A union's step on its stack: two nodes to unite, or a union waiting for its children's, with the bit it parts at and
 * the child it keeps unchanged where only one is asked.
 */
type UnionTask =
  | { readonly a: SupportNode | null; readonly b: SupportNode | null; readonly bit?: undefined }
  | {
      readonly a: SupportNode;
      readonly b: SupportNode;
      readonly bit: number;
      readonly kept: SupportNode | null;
      readonly keptLeft: boolean;
    };

/**
 * The union of two supports, each pair of nodes once per pass, down to where they part and no further: equal subtrees
 * are one node, so a union stops at what both share. On an explicit stack, as deep as the keys' bits part.
 */
function union(
  contract: Contract,
  first: SupportNode | null,
  second: SupportNode | null,
): SupportNode | null {
  const results: (SupportNode | null)[] = [];
  const tasks: UnionTask[] = [{ a: first, b: second }];
  const remember = (a: SupportNode, b: SupportNode, node: SupportNode): void => {
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    let byHigh = contract.supportUnions.get(low.id);
    if (byHigh === undefined) contract.supportUnions.set(low.id, (byHigh = new Map()));
    byHigh.set(high.id, node);
    contract.keep(1);
    contract.facts.supportEdges += 1;
    results.push(node);
  };
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.bit !== undefined) {
      const right = task.kept !== null && !task.keptLeft ? task.kept : results.pop()!;
      const left = task.kept !== null && task.keptLeft ? task.kept : results.pop()!;
      remember(task.a, task.b, supportBranch(contract, task.bit, left, right));
      continue;
    }
    const { a, b } = task;
    if (a === null || b === null || a === b) {
      results.push(a ?? b);
      continue;
    }
    const known = contract.supportUnions.get(Math.min(a.id, b.id))?.get(Math.max(a.id, b.id));
    if (known !== undefined) {
      results.push(known);
      continue;
    }
    // (every key of a node shares its first key's bits above the node's own bit)
    const split = firstDifference(contract, a.key, b.key);
    if (split < Math.min(a.bit, b.bit)) {
      const [left, right] = bitOf(a.key, split) === 0 ? [a, b] : [b, a];
      remember(a, b, supportBranch(contract, split, left, right));
    } else if (a.bit === Infinity && b.bit === Infinity) remember(a, b, mergedLeaf(contract, a, b));
    else if (a.bit === b.bit)
      tasks.push(
        { a, b, bit: a.bit, kept: null, keptLeft: false },
        { a: a.right, b: b.right },
        { a: a.left, b: b.left },
      );
    else {
      // (the node parting first holds the other whole on one side)
      const [upper, lower] = a.bit < b.bit ? [a, b] : [b, a];
      const leftward = bitOf(lower.key, upper.bit) === 0;
      tasks.push(
        { a, b, bit: upper.bit, kept: leftward ? upper.right : upper.left, keptLeft: !leftward },
        { a: leftward ? upper.left : upper.right, b: lower },
      );
    }
  }
  return results.pop() ?? null;
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
 * C5c's reading of one source (`propertyPresence`): from each incoming state (lacks 1, has 2), the state after its
 * items; once a source lacks the property and one has it, no further source is read. An empty source supplies no
 * object; a source without the property gives `missing`, an unknown value of a present property says nothing of it.
 */
export function presenceSteps(all: readonly Item[]): readonly PresenceStep[] {
  const items = withoutEmpty(all);
  let mask = 0;
  let unknown = false;
  let literal: Writer | null = null;
  for (const item of items)
    if (item.tag === "unknown" && (item.reasons & REASON.missing) !== 0) {
      mask |= 1;
      literal = firstWriter(literal, item.writer);
    }
  if (items.some((item) => !(item.tag === "unknown" && item.reasons === REASON.missing))) mask |= 2;
  if (items.some((item) => item.tag === "unknown" && item.reasons !== REASON.missing))
    unknown = true;
  return [0, 1, 2, 3].map((from) =>
    from === 3 || items.length === 0
      ? { mask: from, unknown: false, literal: null }
      : { mask: from | mask, unknown, literal },
  );
}

/** Reading two runs of sources in turn: from each incoming state, the first's step, then the second's from there. */
function thenPresence(
  first: readonly PresenceStep[],
  then: readonly PresenceStep[],
): readonly PresenceStep[] {
  return first.map((step) => {
    const next = then[step.mask]!;
    return {
      mask: next.mask,
      unknown: step.unknown || next.unknown,
      literal: firstWriter(step.literal, next.literal),
    };
  });
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
 * of its path's length. With `path`, the walk notes the longest prefix of a plain array's steps already made, for its id.
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
    text = length === 1 ? ref.at(0) : stepText(text, ref.at(length - 1));
    if (found >= 0) {
      found = pathBelow(contract, found, ref.at(length - 1));
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
 */
function holdersIn(
  contract: Contract,
  set: SupportNode,
  ref: PathRef,
  path: number,
): SupportNode | null {
  const step = ref.at(0);
  const answered = (each: SupportNode): SupportNode | null | undefined =>
    contract.holdersBelow.get(each)?.get(path);
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
    let byPath = contract.holdersBelow.get(at);
    if (byPath === undefined) contract.holdersBelow.set(at, (byPath = new Map()));
    byPath.set(path, root);
    contract.keep(1);
  }
  return answered(set) ?? null;
}

/**
 * The listing layers a prefix's read at `ref` asks: of those found under its first step (`stepLayersOf`), those listing
 * a source with a store at a prefix of its path, whose summaries hold the layers below them; and for a found layer that
 * holds nothing at the path, which the read passes through, the holders below it (`holdersIn`), with the stores that
 * brought the found layers above them; so the layers asked, and their demands, are the layers holding a source at the
 * path. So k copies joined into one place, each storing its own property below one step, are not each asked per read
 * of one of those properties (#1078), however their joins nest or share a listing layer below them.
 */
function topsAt(
  contract: Contract,
  stores: PrefixStores,
  ref: PathRef,
  path: ReadPath,
): PrefixStores["also"] {
  const work = contract.pass.program.work;
  // (the first read under a step keeps its memo, as `main`'s, whether or not a layer lists it; later reads read it)
  const step = ref.at(0);
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
  for (const index of passedBelow(contract, layers, holding)) {
    const { set, defs } = layers.below[index]!;
    for (const layer of layersIn(contract, holdersIn(contract, set, ref, pathIdAt(contract, path))))
      out.push({ layer, defs: defs! });
  }
  return out;
}

/** The layers holding a source at `ref` below a listing layer (`holdersIn` of the set below it), which its summary reads. */
function childrenAt(contract: Contract, layer: SubLayer, ref: PathRef, path: number): SubLayer[] {
  const set = listingBelow(contract, layer, ref.at(0));
  return set === null ? [] : layersIn(contract, holdersIn(contract, set, ref, path));
}

/** A number's key in a set (a layer's, a position's): two code units, so the keys' bits order the numbers. */
function numberKey(at: number): string {
  return String.fromCharCode(at >>> 16, at & 0xffff);
}

/** A position's leaf in a set of positions of a prefix's layers (`topAt`), once per position. */
function positionLeaf(contract: Contract, at: number): SupportNode {
  const known = contract.positionLeaves.get(at);
  if (known !== undefined) return known;
  const leaf: SupportNode = {
    id: made(contract, 0),
    bit: Infinity,
    key: numberKey(at),
    left: null,
    right: null,
    items: null,
    count: 0,
    presence: null,
    layer: at,
  };
  contract.positionLeaves.set(at, leaf);
  return leaf;
}

/** A set of positions' positions, in order, each node visited and charged. */
function positionsIn(contract: Contract, set: SupportNode): number[] {
  const out: number[] = [];
  const stack = [set];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    contract.pass.program.work.charge("invSteps");
    if (node.left === null) out.push(node.layer!);
    else stack.push(node.right!, node.left);
  }
  return out;
}

/** A map node seen under a set of positions, once per node and set. */
function viewOf(contract: Contract, inner: SupportNode, positions: SupportNode): PrefixNode {
  let bySet = contract.prefixViews.get(inner.id);
  if (bySet === undefined) contract.prefixViews.set(inner.id, (bySet = new Map()));
  const known = bySet.get(positions.id);
  if (known !== undefined) return known;
  const view: PrefixNode = { id: made(contract, 2), kind: "view", inner, positions };
  bySet.set(positions.id, view);
  return view;
}

/**
 * An operand of a prefix union (`prefixUnion`): a prefix map's node, or a layer's map node seen under a set of positions
 * not yet made a view (`viewOf`), as the descent meets one inside a view; made a view only where the union keeps it.
 */
type PrefixOperand =
  | PrefixNode
  | { readonly kind: "seen"; readonly inner: SupportNode; readonly positions: SupportNode };

const prefixBit = (node: PrefixOperand): number =>
  node.kind === "view" || node.kind === "seen"
    ? node.inner.bit
    : node.kind === "branch"
      ? node.bit
      : Infinity;
const prefixKey = (node: PrefixOperand): string =>
  node.kind === "view" || node.kind === "seen" ? node.inner.key : node.key;

/** An operand as a prefix map's node: a seen map node made a view. */
function prefixNode(contract: Contract, node: PrefixOperand): PrefixNode {
  return node.kind === "seen" ? viewOf(contract, node.inner, node.positions) : node;
}

/** An operand's two children: a view's or a seen node's are its inner node's, seen under the same positions. */
function prefixChildren(node: PrefixOperand): readonly [PrefixOperand, PrefixOperand] {
  if (node.kind === "branch") return [node.left, node.right];
  if (node.kind === "leaf") throw new Error("A prefix map's leaf has no children.");
  return [
    { kind: "seen", inner: node.inner.left!, positions: node.positions },
    { kind: "seen", inner: node.inner.right!, positions: node.positions },
  ];
}

/** One step in two parts naming different sets: a leaf joining them, enumerated where the step is read (`prefixAt`). */
function prefixLeaf(contract: Contract, a: PrefixOperand, b: PrefixOperand): PrefixNode {
  return {
    id: made(contract, 2),
    kind: "leaf",
    key: prefixKey(a),
    first: prefixNode(contract, a),
    second: prefixNode(contract, b),
  };
}

/** A prefix map's branch at `bit`. */
function prefixBranch(
  contract: Contract,
  bit: number,
  left: PrefixOperand,
  right: PrefixOperand,
): PrefixNode {
  contract.pass.program.work.charge("invSteps");
  const [low, high] = [prefixNode(contract, left), prefixNode(contract, right)];
  return {
    id: made(contract, 2),
    kind: "branch",
    bit,
    key: prefixKey(low),
    left: low,
    right: high,
  };
}

/** A prefix union's step on its stack, as `UnionTask`'s. */
type PrefixTask =
  | { readonly a: PrefixOperand | null; readonly b: PrefixOperand | null; readonly bit?: undefined }
  | { readonly bit: number; readonly kept: PrefixOperand | null; readonly keptLeft: boolean };

/**
 * The union of two prefix maps, once per pair of maps: two views of one map node are one view under both sets of
 * positions, never descended, so the union descends only where its layers' maps part, through their nodes as seen
 * (`PrefixOperand`), and makes views only of the nodes it keeps. On an explicit stack.
 */
function prefixUnion(
  contract: Contract,
  first: PrefixNode | null,
  second: PrefixNode | null,
): PrefixNode | null {
  if (first === null || second === null || first === second) return first ?? second;
  const known = contract.prefixUnions
    .get(Math.min(first.id, second.id))
    ?.get(Math.max(first.id, second.id));
  if (known !== undefined) return known;
  const results: PrefixOperand[] = [];
  const tasks: PrefixTask[] = [{ a: first, b: second }];
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.bit !== undefined) {
      const right = task.kept !== null && !task.keptLeft ? task.kept : results.pop()!;
      const left = task.kept !== null && task.keptLeft ? task.kept : results.pop()!;
      results.push(prefixBranch(contract, task.bit, left, right));
      continue;
    }
    const { a, b } = task;
    if (a === null || b === null || a === b) {
      results.push((a ?? b)!);
      continue;
    }
    const seenA = a.kind === "view" || a.kind === "seen";
    const seenB = b.kind === "view" || b.kind === "seen";
    if (seenA && seenB && a.inner === b.inner) {
      results.push({
        kind: "seen",
        inner: a.inner,
        positions: union(contract, a.positions, b.positions)!,
      });
      continue;
    }
    const [aBit, bBit] = [prefixBit(a), prefixBit(b)];
    const split = firstDifference(contract, prefixKey(a), prefixKey(b));
    if (split < Math.min(aBit, bBit)) {
      const [left, right] = bitOf(prefixKey(a), split) === 0 ? [a, b] : [b, a];
      results.push(prefixBranch(contract, split, left, right));
    } else if (aBit === Infinity && bBit === Infinity) results.push(prefixLeaf(contract, a, b));
    else if (aBit === bBit) {
      const [aLeft, aRight] = prefixChildren(a);
      const [bLeft, bRight] = prefixChildren(b);
      tasks.push(
        { bit: aBit, kept: null, keptLeft: false },
        { a: aRight, b: bRight },
        { a: aLeft, b: bLeft },
      );
    } else {
      // (the node parting first holds the other whole on one side)
      const [upper, lower] = aBit < bBit ? [a, b] : [b, a];
      const [upperLeft, upperRight] = prefixChildren(upper);
      const leftward = bitOf(prefixKey(lower), prefixBit(upper)) === 0;
      tasks.push(
        { bit: prefixBit(upper), kept: leftward ? upperRight : upperLeft, keptLeft: !leftward },
        { a: leftward ? upperLeft : upperRight, b: lower },
      );
    }
  }
  const united = prefixNode(contract, results.pop()!);
  const [low, high] = first.id < second.id ? [first, second] : [second, first];
  let byHigh = contract.prefixUnions.get(low.id);
  if (byHigh === undefined) contract.prefixUnions.set(low.id, (byHigh = new Map()));
  byHigh.set(high.id, united);
  contract.keep(1);
  return united;
}

/**
 * A prefix map's sets under `step`, each with its positions: down its bits to a view of a layer's map, read there to the
 * step's set, or to the step's leaf joining parts (`prefixLeaf`), whose parts are read only when asked; each node
 * charged. Empty for none.
 */
function prefixAt(
  contract: Contract,
  map: PrefixNode | null,
  step: string,
): (() => (readonly [SupportNode, SupportNode])[]) | null {
  const work = contract.pass.program.work;
  const key = listedKey(contract, step);
  if (key === null) return null;
  for (let at = map; at !== null;) {
    work.charge("invSteps");
    if (at.kind === "view") {
      const set = mapGet(contract, at.inner, step);
      const positions = at.positions;
      return set === null ? null : () => [[set, positions]];
    }
    if (at.kind === "leaf") {
      if (at.key !== key) return null;
      const leaf = at;
      return () => {
        const out: (readonly [SupportNode, SupportNode])[] = [];
        // (each position in one part: a layer's map names one set per step; a part is a view of a map's leaf)
        const stack: PrefixNode[] = [leaf];
        for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
          work.charge("invSteps");
          if (node.kind === "leaf") stack.push(node.second, node.first);
          else if (node.kind === "view") out.push([node.inner.value!, node.positions]);
        }
        return out;
      };
    }
    at = bitOf(key, at.bit) === 0 ? at.left : at.right;
  }
  return null;
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

// #1466: what a consumer reads of a prefix's layers at a path, as one summary per layer and path: a demand that proves
// its support with each source's own answer (`subAt`) in its leaf, so the solver owns it as every answer (its reads,
// components, stops and `forget`), and a layer's summary reads the summaries of the layers below it. A layer's demand
// is named by its origin and the path (`LayerOrigin`), so another pass finds it (`replayLayer`, #1422). A read whose
// layers are one layer with one source to answer it makes no summary: it asks that source's demand by reference
// (`singleSource`, TABLE r4.251), which owns the read's dependencies and stops as any source read does; a summary's
// name asked in another pass is still found and made there (`replayLayer`).

/** A summary that declined: a source the old per-source reading treats apart, or a layer below that declined. */
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
    make: () => layerMade(contract, layer, stepsOfId(contract, keyIdAt(0, path)).rest(), path),
  };
  return at.demand;
}

/**
 * A layer's summary at a path: its own sources there with a store at a prefix of the path, each read as its own
 * answer (`subAt`), over the summaries of the layers below it. It declines where a source's holder marks the path
 * (§3.2) or its answer holds a guarded, called or fanned item, which the per-source reading treats apart, and where a
 * layer below declines or has no origin.
 */
function* layerMade(
  contract: Contract,
  layer: SubLayer,
  rest: PathRef,
  path: number,
): Work<Proven<LayerProof>> {
  let root: SupportNode | null = null;
  for (const sub of layer.own.get(rest.at(0)) ?? []) {
    contract.pass.program.work.charge("invSteps");
    if (!ownHas(contract, sub, rest)) continue;
    if (marksAt(contract, contract.keyIdentity(sub).holder, rest))
      return { items: [], proof: DECLINED };
    const items = yield* contract.subAt(sub, rest);
    if (!summarised(items)) return { items: [], proof: DECLINED };
    root = union(contract, root, summaryLeaf(contract, sub, items));
  }
  for (const child of childrenAt(contract, layer, rest, path)) {
    if (child.origin === null) return { items: [], proof: DECLINED };
    const { proof } = yield* contract.pass.solver.proven(layerDemand(contract, child, path));
    if (proof === null || proof.declined) return { items: [], proof: DECLINED };
    root = union(contract, root, proof.root);
  }
  return { items: root?.items ?? [], proof: summaryProof(contract, root) };
}

/**
 * The layers a summary of a prefix's layers reads at a path, each with the stores that brought its top, and the path,
 * its id made only where a summary's demand needs it (`pathIdAt`): a read one source answers by reference makes none
 * (Astra r1's F1).
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
function* unionOf(contract: Contract, at: LayersAt): Work<SupportNode | null | undefined> {
  const roots: SupportNode[] = [];
  for (const { layer } of at.layers) {
    const { proof } = yield* contract.pass.solver.proven(
      layerDemand(contract, layer, pathIdAt(contract, at.path)),
    );
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
 * The one source a read of a prefix's layers at `rest` asks directly (TABLE r4.251, Sol's singleton reference), or
 * `null`: where `layersAt` found one layer, with one own source under the path's first step and no listing layer below
 * that step (`listingBelow`), whose holder marks nothing at the path, that layer's summary is the source's answer
 * alone, so the read asks the source's own demand (`subAt`) at the caller's path as given, an array or a cursor, never
 * the layer's demand; the selection (`topsAt`) has found the source's store at a prefix of the path. Every other shape
 * reads its summaries.
 */
function singleSource(contract: Contract, at: LayersAt, rest: Rest): Key | null {
  if (at.layers.length !== 1) return null;
  const { layer } = at.layers[0]!;
  const first = restRef(contract, rest).at(0);
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
): Work<readonly Item[] | null> {
  const at = layersAt(contract, stores, rest);
  if (at === undefined) return null;
  const sub = singleSource(contract, at, rest);
  if (sub !== null) {
    const items = yield* contract.subAt(sub, rest);
    return summarised(items) ? items : null;
  }
  const root = yield* unionOf(contract, at);
  return root === undefined ? null : (root?.items ?? []);
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
    const items = yield* contract.subAt(sub, rest);
    return summarised(items) ? (withoutEmpty(items).length > 0 ? 1 : 0) : null;
  }
  const root = yield* unionOf(contract, at);
  return root === undefined ? null : (root?.count ?? 0);
}

/**
 * C5c's presence after a prefix's layers at `rest`, read in their sources' order from the incoming state `mask`, its
 * demands run as the consumer runs its reads (`run`, with its read's allowance), and nothing run where no layer may
 * hold a source there; `null` where a summary declines or the run stops, so the consumer reads each source by itself,
 * each with its own allowance, as before.
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
    (function* (): Work<readonly Item[]> {
      if (sub !== null) {
        const items = yield* contract.subAt(sub, rest);
        if (summarised(items)) after = presenceSteps(items)[mask]!;
        return [];
      }
      const root = yield* unionOf(contract, at);
      if (root !== undefined)
        after = root === null ? { mask, unknown: false, literal: null } : root.presence![mask]!;
      return [];
    })(),
  );
  return after;
}

/**
 * A5's candidates of a prefix's layers at `rest`: the stores that brought each layer whose summary holds an offending
 * item (`offends` holds of a merge exactly where it holds of one of the merged sources' answers), its demands run as
 * admission runs its questions (`run`), nothing run where no layer may hold a source there; `null` where a summary
 * declines.
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
  return (yield* contract.pass.solver.proven(layerDemand(contract, layer, path))).items;
}
