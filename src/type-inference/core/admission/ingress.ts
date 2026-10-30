import type { PlaceId, SourceSite } from "../../graph.js";
import type { Admission } from "../admission.js";
import { joinParts, keepText, stepText } from "../budget.js";
import {
  isPathSteps,
  keyBelowIn,
  stepsAfter,
  stepsFrom,
  stepsJoin,
  stepsPrefixText,
  stepsRest,
  stepsText,
  type Steps,
} from "../contract/key-ids.js";
import { sortCost, type Definition } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import type { IngressNode, Item } from "../items.js";
import { concrete, isExternal } from "./kinds.js";
import { landingIndex, leafIngresses } from "./landing-index.js";
import type { IngressStop, KeyStops, Level, Siting, Stop, StoreIngresses } from "./model.js";
import { distinctStops, perLink, selects } from "./scan.js";
import { sourceOf } from "./structure.js";
import { compareKeys, contributionSite, RECEIVER_ROLES, stopsOf } from "./walk.js";

// Where the external data a store brings is sited (C1, §3.4): its stops by key, its store's ingresses, its own reads.

/**
 * A store's contributions at `at`, in evaluation order: the stops of the one walk (`stopsOf`, the carrier table's)
 * standing at the path or above it, each with the rest of the path to read into it, the ones its operations may give
 * (S: `chosen`, a live read), each snapshot once (`distinctStops`, S6-CARRIERS §4.5). The obligations come from these,
 * as the decider does (invariant O).
 */
function contributions(
  admission: Admission,
  d: Definition,
  at: Steps,
): readonly { readonly stop: Stop; readonly rest: Steps }[] {
  if (d.value === undefined) return [];
  const out: { stop: Stop; rest: Steps }[] = [];
  // (a record's prefixes named by their record's texts and its rests its views; an array's as before)
  for (let length = 0; length <= at.length; length += 1)
    for (const stop of keyStops(admission, d, stepsPrefixText(at, length)).distinct()) {
      admission.pass.program.work.charge("checks");
      out.push({ stop, rest: stepsFrom(at, length) });
    }
  return out.sort((a, b) => compareKeys(a.stop.key, b.stop.key));
}

/**
 * C1's site for external data a store brings at `at` (§3.4, TABLE r4.60, r4.63 (2)): the earliest of its contributions
 * that is an ingress or reads one through projections of it, or named data in a literal cell below a combining or
 * removing operation, at its own expression (`contributionSite`); an operation's own read is no such contribution
 * (C10: the destination's check sits at the store), so the store's own site stands for it, as for named data at a
 * decided place below a selecting operation (the set's sites).
 */
export function ingressSiteOf(
  admission: Admission,
  d: Definition,
  at: Steps,
  item?: Item,
): SourceSite {
  if (d.kind !== "whole" || d.value === undefined) return d.site;
  // (the item's own ingress among them first, where it names one: the contribution that brought it; an item carrying
  // named data the store brings beside its inline data, or a fallback's or a default's own read's data (a typed
  // default's is its call's), is that data's C1, sited by its rule (an own read's at the store), the inline data owing
  // only its boundary and a host member beside it its own place's C1: r4.63 (1), (2), TABLE r4.67 (3), r4.70 (1))
  const node = item?.ingress;
  const own = node === undefined ? null : leafIngresses(admission, node);
  const stops = landingIndex(admission).byStore.get(d);
  const named =
    own !== null &&
    stops !== undefined &&
    (perNode(admission.someOwn, d, node!, () =>
      meet(admission, own, ownLeaves(admission, d, false)),
    ) ||
      meet(admission, own, namedBeside(admission, d, at)));
  let first: SourceSite | null = null;
  // (each prefix's sitings once per store, read in evaluation order only as far as the answer: Codex r23 F1; for named
  // data only its own sitings, the inline ones it skips never read, Codex r24 F2's neighbours)
  const lists: (readonly Siting[])[] = [];
  for (let length = 0; length <= at.length; length += 1) {
    const stops = keyStops(admission, d, stepsPrefixText(at, length));
    lists.push(named ? stops.namedSitings() : stops.sitings());
  }
  const positions = lists.map(() => 0);
  for (;;) {
    let best = -1;
    for (let index = 0; index < lists.length; index += 1)
      if (
        positions[index]! < lists[index]!.length &&
        (best < 0 ||
          compareKeys(
            lists[index]![positions[index]!]!.stop.key,
            lists[best]![positions[best]!]!.stop.key,
          ) < 0)
      )
        best = index;
    if (best < 0) break;
    admission.pass.program.work.charge("checks", lists.length);
    const { stop, ingress } = lists[best]![positions[best]!++]!;
    if (ingress === null) return contributionSite(admission, stop, d);
    if (named) continue;
    if (own === null || own.has(ingress)) return contributionSite(admission, stop, d);
    first ??= contributionSite(admission, stop, d);
  }
  return first ?? d.site;
}

/** Whether two sets of ingresses share one, reading the smaller. */
function meet(admission: Admission, a: ReadonlySet<PlaceId>, b: ReadonlySet<PlaceId>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const ingress of small) {
    admission.pass.program.work.charge("checks");
    if (large.has(ingress)) return true;
  }
  return false;
}

/**
 * A store's stops at one key, once per store and key (Codex r23 F1: a path's readers take its prefixes' lists, never
 * the store's whole walk again): the ones its operations may give (`selects`), in evaluation order, and, on demand,
 * the ones C1 may be sited at (`ingressSiteOf`) and the named data among them (`namedBeside`).
 */
function keyStops(admission: Admission, d: Definition, key: string): KeyStops {
  const memoKey = joinParts(d.uid, key);
  const known = admission.keyed.get(memoKey);
  if (known !== undefined) return known;
  const { program, definitions } = admission.pass;
  const stops = stopsOf(admission, d.value!, d.node);
  const selected: Stop[] = [];
  for (const map of [stops.written, stops.values, stops.literals])
    for (const stop of map.get(key) ?? []) {
      program.work.charge("checks");
      if (stop.via === null || selects(admission, stop)) selected.push(stop);
    }
  program.work.charge("checks", sortCost(selected.length));
  selected.sort((a, b) => compareKeys(a.key, b.key));
  // (the ingress a value reads through projections of it, never an iteration's: where its source stands)
  const baseOf = (value: PlaceId): PlaceId => {
    for (
      let projection = program.projOf.get(value);
      projection !== undefined && projection.step !== "iteration";
      projection = program.projOf.get(value)
    ) {
      program.work.charge("checks");
      value = projection.owner;
    }
    return value;
  };
  let sitings: readonly Siting[] | null = null;
  let namedSitings: readonly Siting[] | null = null;
  let distinct: readonly Stop[] | null = null;
  let named: readonly Stop[] | null = null;
  const entry: KeyStops = {
    selected,
    distinct: () => (distinct ??= distinctStops(admission, selected)),
    // an operation's own read is no contribution C1 is sited at (C10); named data below a combining operation or a
    // member of named data is sited at its own expression (`ingress` null), an ingress where it is read
    sitings: () => {
      if (sitings !== null) return sitings;
      const out: Siting[] = [];
      for (const stop of selected) {
        program.work.charge("checks");
        if (stop.via?.own === true) continue;
        if (namedBelowCombining(admission, stop) || namedMember(admission, stop))
          out.push(
            definitions.ingress.has(baseOf(stop.value))
              ? { stop, ingress: null, host: true }
              : { stop, ingress: null },
          );
        else {
          const base = baseOf(stop.value);
          if (definitions.ingress.has(base)) out.push({ stop, ingress: base });
        }
      }
      return (sitings = out);
    },
    // (a member of host data beside them is its own place's C1, never the merged item's: TABLE r4.70 (1))
    namedSitings: () =>
      (namedSitings ??= entry
        .sitings()
        .filter((siting) => siting.ingress === null && siting.host === undefined)),
    // named external data outside every ingress the store holds whole and every own read (`namedBeside`)
    named: () => {
      if (named !== null) return named;
      const { inline } = storeIngresses(admission, d);
      let inlineLinks = admission.inlineLinks.get(inline);
      if (inlineLinks === undefined)
        admission.inlineLinks.set(inline, (inlineLinks = new WeakMap()));
      const out: Stop[] = [];
      for (const stop of selected) {
        program.work.charge("checks");
        // (host data itself, or a member of it, is the store's own ingress, no named data: its global has a key too)
        let base = stop.value;
        while (!definitions.ingress.has(base) && program.projOf.has(base)) {
          program.work.charge("checks");
          base = program.projOf.get(base)!.owner;
        }
        if (
          !definitions.ingress.has(base) &&
          sourceOf(admission, stop.value) !== null &&
          stop.via?.own !== true &&
          !perLink(admission, inlineLinks, stop.via, false, (level) => inline.has(level.value))
        )
          out.push(stop);
      }
      // (equal snapshots bring equal named data at every path below: each read once, Codex r24 F2's neighbours)
      return (named = distinctStops(admission, out));
    },
  };
  keepText(admission.work, memoKey.length);
  admission.keyed.set(memoKey, entry);
  return entry;
}

/**
 * Whether a contribution is a member of named external data: a property read of it, or what a receiver's operation
 * reads of it (`parcel.field`, `parcel.get(0, default: 1)`): C1 at the member read (TABLE r4.60).
 */
function namedMember(admission: Admission, stop: Stop): boolean {
  const { program, definitions, values } = admission.pass;
  if (definitions.ingress.has(stop.value) || sourceOf(admission, stop.value) === null) return false;
  // (only the innermost operation takes the stop's value as its operand, `ViaChain`)
  const level = stop.via?.level;
  const member =
    program.projOf.has(stop.value) ||
    (level !== undefined && RECEIVER_ROLES.has(level.role) && level.operand === stop.value);
  return (
    member && admission.run(values.valueItems(stop.value, stop.node, stop.strip)).some(isExternal)
  );
}

/**
 * Whether a contribution is named external data in a cell of a literal that a combining or removing operation takes
 * (`[a] + [named]`, `[k, named].removeAt(1)`): the operand that brought the kind, C1's site (TABLE r4.63 (2)).
 */
function namedBelowCombining(admission: Admission, stop: Stop): boolean {
  const { definitions, values } = admission.pass;
  // (only the innermost operation takes the stop's value as its operand, `ViaChain`)
  const via = stop.via;
  const combining =
    via !== null &&
    (via.level.operand === stop.value ? via.outer?.combining === true : via.combining);
  return (
    !definitions.ingress.has(stop.value) &&
    sourceOf(admission, stop.value) !== null &&
    combining &&
    admission.run(values.valueItems(stop.value, stop.node, stop.strip)).some(isExternal)
  );
}

/**
 * Where a store's value at `at` carries external data another store brought (r4.50 (1)): the first read among its
 * contributions of a source key (`sourceOf`: a binding, a member of one, a call's result) no store validates (its
 * contract there holds no kind), whose items there are external, a member the runtime reads included (F15, r4.60: C5's
 * obligation on the receiver waives nothing at the destination); `null` where none does. Inline data is the store's
 * own ingress (C9's boundary): it does not count.
 */
export function namedExternalSite(
  admission: Admission,
  d: Definition,
  at: Steps,
): SourceSite | null {
  const { contract, values } = admission.pass;
  const { inline } = storeIngresses(admission, d);
  // (each snapshot once: equal reads of one source through one chain hold equal named data, S6-CARRIERS §4.5)
  for (const { stop, rest } of contributions(admission, d, at)) {
    const source = sourceOf(admission, stop.value);
    if (source === null || inline.has(stop.value)) continue;
    const path = stepsJoin(stop.strip, rest);
    const key = keyBelowIn(contract, source, path);
    if (withoutEmpty(admission.run(contract.contractOf(key))).some(concrete)) continue;
    if (admission.run(values.valueItems(stop.value, stop.node, stepsRest(path))).some(isExternal))
      // (an operation's own read: the destination's check at the store's value, TABLE r4.63 (3))
      return stop.via?.own === true ? d.site : contributionSite(admission, stop, d);
  }
  return null;
}

/**
 * Whether an external item a store brings is an operation's own read's data alone (C10: a fallback's, a default's):
 * each ingress it names reaches the store's value through an own read, as host data or in named data. Its boundary is
 * against `[unknown]`, so A7's whole-store exception never stands in for the destination's check of it (TABLE r4.67
 * (2)). It reads no path: once per store and provenance node (Codex r23 F1).
 */
export function ownReadItem(admission: Admission, item: Item, d: Definition): boolean {
  if (item.ingress === undefined) return false;
  const ingresses = leafIngresses(admission, item.ingress);
  return perNode(admission.ownItems, d, item.ingress, () => {
    if (ingresses.size === 0) return false;
    const own = ownLeaves(admission, d);
    for (const ingress of ingresses) {
      admission.pass.program.work.charge("checks");
      if (!own.has(ingress)) return false;
    }
    return true;
  });
}

/**
 * The ingresses that reach a store's value through an operation's own read, once per store; `typed` false leaves out
 * those only a typed default reads (F18: its data's C1 at the call's ingress, TABLE r4.66 (3)).
 */
function ownLeaves(admission: Admission, d: Definition, typed = true): ReadonlySet<PlaceId> {
  const memoKey = joinParts(d.uid, typed);
  const known = admission.ownReads.get(memoKey);
  if (known !== undefined) return known;
  const { program, definitions, values } = admission.pass;
  const own = new Set<PlaceId>();
  if (d.value !== undefined) {
    const stops = stopsOf(admission, d.value, d.node);
    for (const map of [stops.written, stops.values, stops.literals])
      for (const list of map.values())
        for (const stop of list) {
          program.work.charge("checks");
          if ((typed ? stop.via?.own : stop.via?.ownUntyped) !== true) continue;
          let base = stop.value;
          while (!definitions.ingress.has(base) && program.projOf.has(base)) {
            program.work.charge("checks");
            base = program.projOf.get(base)!.owner;
          }
          if (definitions.ingress.has(base)) {
            own.add(base);
            continue;
          }
          for (const item of admission.run(values.valueItems(stop.value, stop.node, stop.strip)))
            if (isExternal(item) && item.ingress !== undefined)
              for (const ingress of leafIngresses(admission, item.ingress)) own.add(ingress);
        }
  }
  admission.ownReads.set(memoKey, own);
  return own;
}

/**
 * The whole value a stored value's path lies below (a copy, external data, an operation), not a field or element of
 * one of its literals, or `null`.
 */
export function wholeBelow(admission: Admission, value: PlaceId, at: Steps): PlaceId | null {
  const { program } = admission.pass;
  // the values at each depth of the path, and the first whole one there, once per value and path prefix: the paths
  // of a stored value share their prefixes (each field of a list's elements its element step)
  let level: Level = { values: [value], whole: program.hasOf.has(value) ? null : value };
  let key = `${value}`;
  for (let index = 0; index + 1 < at.length && level.whole === null; index += 1) {
    // (a record's prefix named by its record's text, `prefixText`; an array's step by step as before)
    key = isPathSteps(at)
      ? stepText(String(value), at.prefixText(index + 1))
      : stepText(key, at[index]!);
    let next = admission.levels.get(key);
    if (next === undefined) {
      const values: PlaceId[] = [];
      for (const current of level.values)
        for (const d of admission.storesAt(current, at.at(index)!)) values.push(d.value!);
      program.work.charge("checks", values.length + 1);
      next = { values, whole: values.find((current) => !program.hasOf.has(current)) ?? null };
      keepText(admission.work, key.length);
      admission.levels.set(key, next);
    }
    level = next;
  }
  return at.length > 0 ? level.whole : null;
}

/**
 * Whether an item's external data came in at the store `d` itself (C9: its boundary there checks it): data that stands
 * whole in the store's value, with what that ingress holds (a typed default's data is its call's). A member the store
 * brings of host data (r4.60), or named data the store brings beside the inline data at `at`, owes its own check
 * (Codex r21 B3).
 */
export function ownIngress(admission: Admission, item: Item, d: Definition, at: Steps): boolean {
  if (item.ingress === undefined) return false;
  const stops = landingIndex(admission).byStore.get(d);
  if (stops === undefined) return false;
  const ingresses = leafIngresses(admission, item.ingress);
  // (whether the store holds the item's data whole and nowhere as a member reads no path: once per provenance node,
  // its leaves asked of the store's index)
  const whole = perNode(admission.wholeItems, d, item.ingress, () => {
    const { inline, members } = storeIngresses(admission, d);
    let held = false;
    for (const ingress of ingresses) {
      admission.pass.program.work.charge("checks");
      if (members.has(ingress)) return false;
      if (inline.has(ingress)) held = true;
    }
    return held;
  });
  return whole && !meet(admission, ingresses, namedBeside(admission, d, at));
}

/**
 * The ingresses of the named external data a store brings at `at` outside every ingress its value holds whole and
 * every operation's own read (C10's): what an item merging them with inline data owes beside its boundary. Once per
 * store and path, reading only its prefixes' named data (`keyStops`).
 */
function namedBeside(admission: Admission, d: Definition, at: Steps): ReadonlySet<PlaceId> {
  // (a record's path named by its record's text, `stepsText`)
  const memoKey = joinParts(d.uid, stepsText(at));
  const known = admission.beside.get(memoKey);
  if (known !== undefined) return known;
  const { program, values } = admission.pass;
  const out = new Set<PlaceId>();
  for (let length = 0; length <= at.length; length += 1)
    for (const stop of keyStops(admission, d, stepsPrefixText(at, length)).named()) {
      program.work.charge("checks");
      const rest = stepsAfter(stop.strip, stepsFrom(at, length));
      for (const item of admission.run(values.valueItems(stop.value, stop.node, rest)))
        if (isExternal(item) && item.ingress !== undefined)
          for (const ingress of leafIngresses(admission, item.ingress)) out.add(ingress);
    }
  keepText(admission.work, memoKey.length);
  admission.beside.set(memoKey, out);
  return out;
}

/** A store's answer for a provenance node, once: one that reads no path (Codex r23 F1). */
function perNode<T>(
  memo: Map<number, Map<IngressNode, T>>,
  d: Definition,
  node: IngressNode,
  answer: () => T,
): T {
  let known = memo.get(d.uid);
  if (known === undefined) memo.set(d.uid, (known = new Map()));
  const hit = known.get(node);
  if (hit !== undefined) return hit;
  const value = answer();
  known.set(node, value);
  return value;
}

/** C9's site for an item a store brings (§3.4): the earliest evaluated of its contributions there, else `site`. */
export function cellSited(
  admission: Admission,
  site: SourceSite,
  item: Item,
  d: Definition,
): SourceSite {
  return firstStop(admission, item, d)?.reads ?? site;
}

/**
 * C1's site for an item an add or an `addAll` brings (§3.4, r4.60): the earliest evaluated of its contributions, what
 * a receiver's operation reads of it at that operation (`xs.add(hostValue.get(0, default: 1))`: the `get`, Codex r21
 * N1), else `site`.
 */
export function contributionSited(
  admission: Admission,
  site: SourceSite,
  item: Item,
  d: Definition,
): SourceSite {
  return firstStop(admission, item, d)?.contribution ?? site;
}

/** The earliest evaluated of a store's stops of an item's ingresses (its own expression), once per provenance node. */
function firstStop(admission: Admission, item: Item, d: Definition): IngressStop | null {
  if (item.ingress === undefined) return null;
  const stops = landingIndex(admission).byStore.get(d);
  if (stops === undefined) return null;
  const ingresses = leafIngresses(admission, item.ingress);
  return perNode(admission.firstStops, d, item.ingress, () => {
    const { first } = storeIngresses(admission, d);
    let earliest = -1;
    for (const ingress of ingresses) {
      admission.pass.program.work.charge("checks");
      const index = first.get(ingress);
      if (index !== undefined && (earliest < 0 || index < earliest)) earliest = index;
    }
    return earliest < 0 ? null : stops[earliest]!;
  });
}

/**
 * A store's landing stops by ingress, once per store (Codex r24 F1: an item's leaves ask it, never the store's list
 * again): the ingresses it holds whole, those it brings as members, and each ingress's first stop.
 */
function storeIngresses(admission: Admission, d: Definition): StoreIngresses {
  const known = admission.byIngress.get(d.uid);
  if (known !== undefined) return known;
  const inline = new Set<PlaceId>();
  const members = new Set<PlaceId>();
  const first = new Map<PlaceId, number>();
  (landingIndex(admission).byStore.get(d) ?? []).forEach((stop, index) => {
    admission.pass.program.work.charge("checks");
    (stop.whole ? inline : members).add(stop.ingress);
    if (!first.has(stop.ingress)) first.set(stop.ingress, index);
  });
  const out: StoreIngresses = { inline, members, first };
  admission.byIngress.set(d.uid, out);
  return out;
}
