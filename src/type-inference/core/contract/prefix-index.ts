import type { PlaceId } from "../../graph.js";
import {
  type CanonicalKey,
  isKeyId,
  keptKeyBelowIn,
  keyDepthIn,
  keyStepsIn,
  type Rest,
  restRef,
  restSteps,
} from "./key-ids.js";
import { keepText, keptParts, keptSteps, keptText, pathText, stepText } from "../budget.js";
import type { Contract } from "../contract.js";
import { keptKey, keyOf, keyPath, keyPlace, type Definition, type Key } from "../definitions.js";
import { firstWriter, REASON } from "../items.js";
import { copyOnly, subFirstOf } from "./identity.js";
import { ingressLeafOf } from "./ingress.js";
import { holderAt } from "./marks.js";
import type {
  CopyRing,
  EntryDraft,
  IdentityWork,
  PrefixFrame,
  PrefixStores,
  SubLayer,
  SubSource,
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
            : { value: e.value!, at: keptSteps(contract.work, e.at ?? [], projection) }),
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
        // the source's own stores below its root over the sources it inherits, one layer per source shared by its
        // copies (r4.38: k copies of a source edited at k fields are k inheritances, not k × k listings)
        addSubs(f, aliasLayer(contract, inner, keyPlace(f.ck!)));
        for (const joined of inner.also) addSubs(f, joined.layer);
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
            (definitions.byKey.get(keyOf(keyPlace(copied), path.slice(0, length))) ?? []).length > 0
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

/** The layer an alias of `place` inherits: the place's own stores below its root over the place's sources, once. */
function aliasLayer(contract: Contract, inner: PrefixStores, place: PlaceId): SubLayer | null {
  if (contract.aliasLayers.has(inner)) return contract.aliasLayers.get(inner)!;
  const own = new Map<string, Set<Key>>();
  for (const step of subFirstOf(contract, place)) {
    contract.pass.program.work.charge("invSteps");
    own.set(step, new Set([keptKey(contract.work, place, [])]));
  }
  const layer = layerOf(contract, own, inner.subs);
  contract.aliasLayers.set(inner, layer);
  return layer;
}

/**
 * The layer a projected copy of `place` at `projection` takes: the place's own live stores below the path, once, from
 * the keys below the path alone (r4.46 (3): never the place's whole key set per copy).
 */
function projectedLayer(
  contract: Contract,
  place: PlaceId,
  projection: readonly string[],
): SubLayer | null {
  const id = keptParts(contract.work, place, projection);
  if (contract.projectedLayers.has(id)) return contract.projectedLayers.get(id)!;
  const { program, definitions, lists } = contract.pass;
  const sub = keptKey(contract.work, place, projection);
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
  const layer = layerOf(contract, own, null);
  contract.projectedLayers.set(id, layer);
  return layer;
}

/** A prefix's layer: its own sources over the layer it inherits, indexed by their first steps; none if it adds none. */
function layerOf(
  contract: Contract,
  own: Map<string, Set<Key>> | null,
  parent: SubLayer | null,
): SubLayer | null {
  if (own === null || own.size === 0) return parent;
  const work = contract.pass.program.work;
  const jumps: SubLayer[] = [];
  if (parent !== null) {
    jumps.push(parent);
    for (let level = 0; jumps[level]!.jumps[level] !== undefined; level += 1) {
      work.charge("invSteps");
      jumps.push(jumps[level]!.jumps[level]!);
    }
  }
  let only: Key | null | undefined = parent === null ? undefined : parent.only;
  for (const [, set] of own)
    for (const sub of set) {
      work.charge("invSteps");
      only = only === undefined || only === sub ? sub : null;
    }
  const layer: SubLayer = {
    own,
    parent,
    depth: parent === null ? 0 : parent.depth + 1,
    jumps,
    root: parent === null ? null : (parent.root ?? parent),
    only: only ?? null,
    byStep: new Map(),
  };
  const index = (layer.root ?? layer).byStep;
  for (const step of own.keys()) {
    work.charge("invSteps");
    let byDepth = index.get(step);
    if (byDepth === undefined) index.set(step, (byDepth = new Map()));
    const layers = byDepth.get(layer.depth);
    if (layers === undefined) byDepth.set(layer.depth, new Set([layer]));
    else layers.add(layer);
  }
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

/**
 * The sources a prefix's property reads apart from the shared entries: those listed under the property's first step
 * with stores of their own at the property's path or above it below their root; per layer the prefix inherits or
 * joins (one lookup each), the layers asked are that layer and, per depth at which a layer lists the step, its
 * ancestor there, with the stores that brought that layer (`walkLayer`). The first read under a step walks every
 * layer and keeps which can hold such a source (`stepLayers`): the sources each lists in its own map, and the layers
 * one of whose ancestors lists the step, without listing the ancestors' sources. A later read walks, in their order,
 * those layers and the ones whose own sources include one with a store at a prefix of its path, found per prefix from
 * the smaller of those sources and the sources with a store there (`subsByPath`). So k copies joined into one place,
 * each storing its own property below one step, are not each walked per read of one of those properties (#1078).
 */
export function relevantSubs(
  contract: Contract,
  stores: PrefixStores,
  asked: Rest,
): readonly SubSource[] {
  // (a cursor's span read one step at a time; its steps made only for a layer that walks them)
  const ref = restRef(contract, asked);
  if (ref.length === 0) return [];
  const work = contract.pass.program.work;
  const step = ref.at(0);
  let bySteps = contract.stepLayers.get(stores);
  if (bySteps === undefined) contract.stepLayers.set(stores, (bySteps = new Map()));
  // (the layers it inherits or joins, by position: the one it inherits first, then those it joins)
  const inherited = stores.subs === null ? 0 : 1;
  const topAt = (at: number): (typeof stores.also)[number] =>
    at < inherited
      ? { layer: stores.subs!, defs: stores.inheritedBy }
      : stores.also[at - inherited]!;
  const count = inherited + stores.also.length;
  const found = new Map<Key, Set<Definition | null>>();
  const known = bySteps.get(step);
  if (known === undefined) {
    const own = new Map<Key, number[]>();
    const deep: number[] = [];
    for (let at = 0; at < count; at += 1) {
      const { layer: top, defs } = topAt(at);
      for (const sub of top.own.get(step) ?? []) {
        work.charge("invSteps");
        ownPaths(contract, sub);
        contract.keep(1);
        const listed = own.get(sub);
        if (listed === undefined) own.set(sub, [at]);
        else listed.push(at);
      }
      if (walkLayer(contract, top, defs, step, restSteps(asked), found)) deep.push(at);
    }
    contract.keep(1 + deep.length);
    bySteps.set(step, { own, deep });
  } else {
    const { own, deep } = known;
    const walked = new Set(deep);
    let text = "";
    for (let length = 1; length <= ref.length && own.size > 0; length += 1) {
      work.charge("invSteps");
      text = length === 1 ? step : stepText(text, ref.at(length - 1));
      const having = contract.subsByPath.get(text);
      if (having === undefined) continue;
      if (having.size <= own.size)
        for (const sub of having) {
          work.charge("invSteps");
          for (const at of own.get(sub) ?? []) walked.add(at);
        }
      else
        for (const [sub, at] of own) {
          work.charge("invSteps");
          if (having.has(sub)) for (const each of at) walked.add(each);
        }
    }
    work.charge("invSteps", walked.size);
    for (const at of [...walked].sort((a, b) => a - b)) {
      const { layer, defs } = topAt(at);
      walkLayer(contract, layer, defs, step, restSteps(asked), found);
    }
  }
  return [...found]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, defs]) => ({ key, defs }));
}

/**
 * One layer's part of `relevantSubs`: the layer and, per depth at which a layer lists the step, its ancestor there,
 * each source listed under the step with a store of its own at a prefix of the path taken with the stores that
 * brought the layer; whether an ancestor lists the step.
 */
function walkLayer(
  contract: Contract,
  top: SubLayer,
  brought: ReadonlySet<Definition | null>,
  step: string,
  rest: readonly string[],
  found: Map<Key, Set<Definition | null>>,
): boolean {
  const work = contract.pass.program.work;
  let deep = false;
  for (const [depth, layers] of (top.root ?? top).byStep.get(step) ?? []) {
    work.charge("invSteps");
    if (depth > top.depth) continue;
    const layer = ancestorAt(contract, top, depth);
    if (!layers.has(layer)) continue;
    if (depth < top.depth) deep = true;
    for (const sub of layer.own.get(step) ?? []) {
      work.charge("invSteps");
      const paths = ownPaths(contract, sub);
      let held = false;
      for (let length = 1; length <= rest.length && !held; length += 1) {
        work.charge("invSteps");
        held = paths.has(pathText(rest.slice(0, length)));
      }
      if (!held) continue;
      let defs = found.get(sub);
      if (defs === undefined) found.set(sub, (defs = new Set()));
      for (const d of brought) defs.add(d);
    }
  }
  return deep;
}

/** Every source of a prefix's layers, inherited and joined (the answers' properties). */
export function subSources(stores: PrefixStores): Key[] {
  const out = new Set<Key>();
  for (const top of [stores.subs, ...stores.also.map((joined) => joined.layer)])
    for (let layer = top; layer !== null; layer = layer.parent)
      for (const [, set] of layer.own) for (const sub of set) out.add(sub);
  return [...out];
}
