import type { PlaceId } from "../../graph.js";
import {
  arrayRef,
  type CanonicalKey,
  isKeyId,
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
import { holderAt, marksAt } from "./marks.js";
import type {
  CopyRing,
  EntryDraft,
  IdentityWork,
  LayerOrigin,
  LayerPath,
  LayerProof,
  PrefixFrame,
  PrefixStores,
  PresenceStep,
  StepNode,
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
 * neither, its parent then standing for it with its origin.
 */
function layerOf(
  contract: Contract,
  own: Map<string, Set<Key>>,
  parent: SubLayer | null,
  joins: readonly SubLayer[],
  origin: LayerOrigin | null,
): SubLayer | null {
  if (own.size === 0 && joins.length === 0) return parent;
  const work = contract.pass.program.work;
  work.charge("invSteps", 1 + joins.length);
  let only: Key | null | undefined = parent === null ? undefined : parent.only;
  for (const [, set] of own)
    for (const sub of set) {
      work.charge("invSteps");
      only = only === undefined || only === sub ? sub : null;
    }
  const layer: SubLayer = {
    own,
    parent,
    joins,
    only: joins.length === 0 ? (only ?? null) : null,
    origin,
    paths: new Map(),
    depth: parent === null ? 0 : parent.depth + 1,
    listers: parent?.listers ?? null,
    joined: parent?.joined ?? null,
    steps: parent?.steps ?? null,
  };
  // (it is its own nearest layer for the steps it lists, and where it joins further layers; the steps below it are
  // its parent's and joins' shared, with its own)
  for (const step of own.keys()) {
    layer.listers = stepAdded(contract, layer.listers, step, layer);
    layer.steps = union(contract, layer.steps, stepLeaf(contract, step));
  }
  for (const joined of joins) layer.steps = union(contract, layer.steps, joined.steps);
  if (joins.length > 0) layer.joined = layer;
  return layer;
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

/** A step map (`StepNode`) with `step` mapped to `layer`: the nodes on the step's path made again, the rest shared. */
function stepAdded(
  contract: Contract,
  map: StepNode | null,
  step: string,
  layer: SubLayer,
): StepNode {
  const node = (bit: number, left: StepNode | null, right: StepNode | null): StepNode => {
    contract.keep(1);
    return { bit, step: left?.step ?? step, left, right, layer: left === null ? layer : null };
  };
  const path: (readonly [StepNode, boolean])[] = [];
  let at = map;
  while (at !== null && at.bit !== Infinity && firstDifference(contract, step, at.step) >= at.bit) {
    const right = bitOf(step, at.bit) === 1;
    path.push([at, right]);
    at = right ? at.right : at.left;
  }
  let added = node(Infinity, null, null);
  const split = at === null ? Infinity : firstDifference(contract, step, at.step);
  if (split !== Infinity)
    added = bitOf(step, split) === 0 ? node(split, added, at) : node(split, at, added);
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const [above, right] = path[index]!;
    added = right ? node(above.bit, above.left, added) : node(above.bit, added, above.right);
  }
  return added;
}

/** The layer a step map holds for `step`, or `null`: down the step's bits, each node charged. */
function listerOf(contract: Contract, map: StepNode | null, step: string): SubLayer | null {
  let at = map;
  for (; at !== null && at.bit !== Infinity; at = bitOf(step, at.bit) === 0 ? at.left : at.right)
    contract.pass.program.work.charge("invSteps");
  return at !== null && at.step === step ? at.layer : null;
}

/**
 * The layer a read under `step` asks for `layer` and the layers below it by parents: the nearest of them that lists
 * the step or joins further layers, whose answer is theirs; `null` where none does.
 */
function entryAt(contract: Contract, layer: SubLayer | null, step: string): SubLayer | null {
  if (layer === null) return null;
  const lister = listerOf(contract, layer.listers, step);
  const joined = layer.joined;
  if (lister === null || joined === null) return lister ?? joined;
  return lister.depth >= joined.depth ? lister : joined;
}

/** Whether `layer` or a layer below it lists `step`: down the step's bits in its steps (`SubLayer.steps`). */
function holds(contract: Contract, layer: SubLayer, step: string): boolean {
  let at = layer.steps;
  for (; at !== null && at.bit !== Infinity; at = bitOf(step, at.bit) === 0 ? at.left : at.right)
    contract.pass.program.work.charge("invSteps");
  return at !== null && at.key === step;
}

/** The layers a layer's answer under `step` reads below its own sources: its parent's and its joins' entries holding it. */
function nextAt(contract: Contract, layer: SubLayer, step: string): SubLayer[] {
  const out: SubLayer[] = [];
  for (const child of [layer.parent, ...layer.joins]) {
    const entry = entryAt(contract, child, step);
    if (entry !== null && holds(contract, entry, step)) out.push(entry);
  }
  return out;
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

/** The id of a path asked below a prefix: a span's own; an array's each step charged (`PathRef.id`). */
function pathOf(contract: Contract, ref: PathRef): number {
  if (ref.kind === "steps") contract.pass.program.work.charge("invSteps", ref.length);
  return ref.id();
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

/** A step's leaf in a layer's steps (`SubLayer.steps`), once per step. */
function stepLeaf(contract: Contract, step: string): SupportNode {
  const known = contract.stepLeaves.get(step);
  if (known !== undefined) return known;
  const leaf: SupportNode = {
    id: made(contract, 0),
    bit: Infinity,
    key: step,
    left: null,
    right: null,
    items: null,
    count: 0,
    presence: null,
  };
  contract.stepLeaves.set(step, leaf);
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

/** One source in both nodes: a summary's two contents of it merged in the order the nodes were made. */
function mergedLeaf(contract: Contract, a: SupportNode, b: SupportNode): SupportNode {
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
      for (const child of nextAt(contract, layer, step))
        if (!done(child)) stack.push([child, false]);
      continue;
    }
    let root: SupportNode | null = null;
    for (const sub of layer.own.get(step) ?? []) {
      contract.pass.program.work.charge("invSteps");
      if (ownHas(contract, sub, ref)) root = union(contract, root, supportLeaf(contract, sub));
    }
    for (const child of nextAt(contract, layer, step))
      root = union(contract, root, child.paths.get(path)!.support ?? null);
    atPath(contract, layer, path).support = root;
  }
  return top.paths.get(path)!.support ?? null;
}

/** The layers a prefix inherits or joins, each with its stores that brought it: the one it inherits first. */
function topsOf(stores: PrefixStores): PrefixStores["also"] {
  return stores.subs === null
    ? stores.also
    : [{ layer: stores.subs, defs: stores.inheritedBy }, ...stores.also];
}

/**
 * The layers a prefix inherits or joins that may hold a source at `ref`, in their order, the others holding none: per
 * layer the first read under a step finds the sources it lists there and whether a layer below it lists the step
 * (`stepLayers`, `nextAt`); every read takes those of the latter, and of the former those listing a source with a
 * store at a prefix of its path, found per prefix from the smaller of those sources and the sources with a store there
 * (`subsByPath`). So k copies joined into one place, each storing its own property below one step, are not each asked
 * per read of one of those properties (#1078).
 */
function topsAt(contract: Contract, stores: PrefixStores, ref: PathRef): PrefixStores["also"] {
  const tops = topsOf(stores);
  const work = contract.pass.program.work;
  const step = ref.at(0);
  let bySteps = contract.stepLayers.get(stores);
  if (bySteps === undefined) contract.stepLayers.set(stores, (bySteps = new Map()));
  let known = bySteps.get(step);
  if (known === undefined) {
    const own = new Map<Key, number[]>();
    const deep: number[] = [];
    for (let at = 0; at < tops.length; at += 1) {
      const { layer } = tops[at]!;
      for (const sub of layer.own.get(step) ?? []) {
        work.charge("invSteps");
        ownPaths(contract, sub);
        contract.keep(1);
        const listed = own.get(sub);
        if (listed === undefined) own.set(sub, [at]);
        else listed.push(at);
      }
      if (nextAt(contract, layer, step).length > 0) deep.push(at);
    }
    contract.keep(1 + deep.length);
    bySteps.set(step, (known = { own, deep }));
  }
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
  return [...walked].sort((a, b) => a - b).map((at) => tops[at]!);
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
  if (ref.length === 0 || topsOf(stores).length === 0) return [];
  const tops = topsAt(contract, stores, ref);
  if (tops.length === 0) return [];
  const path = pathOf(contract, ref);
  // (a source's stores: the set of the one layer listing it, shared; a set of its own, made and charged as the second
  // layer listing it is met, where several do)
  const found = new Map<Key, ReadonlySet<Definition | null>>();
  const owned = new Map<Key, Set<Definition | null>>();
  for (const { layer, defs } of tops)
    for (const sub of sourcesOf(
      contract,
      layerSupport(contract, entryAt(contract, layer, ref.at(0))!, ref, path),
    )) {
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
  const stack = [...topsOf(stores)].reverse().map((top) => top.layer);
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
// is named by its origin and the path (`LayerOrigin`), so another pass finds it (`replayLayer`, #1422).

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
    if (
      items.some((item) => item.guarded === true || item.called === true || item.fan !== undefined)
    )
      return { items: [], proof: DECLINED };
    root = union(contract, root, summaryLeaf(contract, sub, items));
  }
  for (const child of nextAt(contract, layer, rest.at(0))) {
    if (child.origin === null) return { items: [], proof: DECLINED };
    const { proof } = yield* contract.pass.solver.proven(layerDemand(contract, child, path));
    if (proof === null || proof.declined) return { items: [], proof: DECLINED };
    root = union(contract, root, proof.root);
  }
  return { items: root?.items ?? [], proof: summaryProof(contract, root) };
}

/**
 * The summary of a prefix's layers at `rest`: the union of each layer's (`layerDemand`); `undefined` where one
 * declines, the prefix's stores are cut at an open copy cycle, or a layer has no origin, so the consumer reads each
 * source by itself (`relevantSubs`).
 */
function* summaryOf(
  contract: Contract,
  stores: PrefixStores,
  rest: Rest,
): Work<SupportNode | null | undefined> {
  const ref = restRef(contract, rest);
  if (ref.length === 0 || topsOf(stores).length === 0) return null;
  if (stores.cut) return undefined;
  const tops = topsAt(contract, stores, ref);
  if (tops.length === 0) return null;
  const path = pathOf(contract, ref);
  let root: SupportNode | null = null;
  for (const top of tops) {
    const layer = entryAt(contract, top.layer, ref.at(0))!;
    if (layer.origin === null) return undefined;
    const { proof } = yield* contract.pass.solver.proven(layerDemand(contract, layer, path));
    if (proof === null || proof.declined) return undefined;
    root = union(contract, root, proof.root);
  }
  return root;
}

/** `contractAlong`'s items of a prefix's layers at `rest`: every source's answer merged in their keys' order. */
export function* summaryItems(
  contract: Contract,
  stores: PrefixStores,
  rest: Rest,
): Work<readonly Item[] | null> {
  const root = yield* summaryOf(contract, stores, rest);
  return root === undefined ? null : (root?.items ?? []);
}

/** `severalWork`'s count of a prefix's layers at `rest`: the distinct sources whose answer holds an element, to two. */
export function* summaryCount(
  contract: Contract,
  stores: PrefixStores,
  rest: Rest,
): Work<number | null> {
  const root = yield* summaryOf(contract, stores, rest);
  return root === undefined ? null : (root?.count ?? 0);
}

/**
 * C5c's presence after a prefix's layers at `rest`, read in their sources' order from the incoming state `mask`, its
 * demands run as the consumer runs its reads (`run`, with its read's allowance); `null` where a summary declines or the
 * run stops, so the consumer reads each source by itself, each with its own allowance, as before.
 */
export function summaryPresence(
  contract: Contract,
  stores: PrefixStores,
  rest: Rest,
  mask: number,
  run: (work: Work<readonly Item[]>) => readonly Item[],
): PresenceStep | null {
  let after: PresenceStep | null = null;
  run(
    (function* (): Work<readonly Item[]> {
      const root = yield* summaryOf(contract, stores, rest);
      if (root !== undefined)
        after = root === null ? { mask, unknown: false, literal: null } : root.presence![mask]!;
      return [];
    })(),
  );
  return after;
}

/**
 * A5's candidates of a prefix's layers at `rest`: the stores that brought each layer whose summary holds an offending
 * item (`offends` holds of a merge exactly where it holds of one of the merged sources' answers); `null` where a
 * summary declines.
 */
export function* offendingStores(
  contract: Contract,
  stores: PrefixStores,
  rest: Rest,
  offends: (items: readonly Item[]) => boolean,
): Work<ReadonlySet<Definition | null> | null> {
  const ref = restRef(contract, rest);
  const out = new Set<Definition | null>();
  if (ref.length === 0 || topsOf(stores).length === 0) return out;
  if (stores.cut) return null;
  const tops = topsAt(contract, stores, ref);
  if (tops.length === 0) return out;
  const path = pathOf(contract, ref);
  for (const top of tops) {
    const { defs } = top;
    const layer = entryAt(contract, top.layer, ref.at(0))!;
    if (layer.origin === null) return null;
    const { items, proof } = yield* contract.pass.solver.proven(layerDemand(contract, layer, path));
    if (proof === null || proof.declined) return null;
    if (!offends(items)) continue;
    contract.pass.program.work.charge("invSteps", defs.size);
    for (const d of defs) out.add(d);
  }
  return out;
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
