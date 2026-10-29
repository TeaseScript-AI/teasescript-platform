import type { PlaceId, SourceSite } from "../../graph.js";
import type { Admission } from "../admission.js";
import type { CorePass } from "../answers.js";
import { keptSlice } from "../budget.js";
import { operandsOf } from "../carriers.js";
import { defaultOf, termAt, typeTags } from "../contract.js";
import { SELECTED_TEXT, SELECTED_VALUE, sortCost, type Definition } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import { REASON, writerKey, type IngressNode, type ItemTag, type Writer } from "../items.js";
import { conversionCategory, measuresLength } from "../method-categories.js";
import { concrete } from "./kinds.js";
import type { IngressStop, Landing, LandingIndex, Stop, Via, ViaChain } from "./model.js";
import { compareKeys, contributionSite, OWN_ROLES, stopsOf, TYPED_ROLES } from "./walk.js";

// The landing index (S6-CARRIERS §3.2): every landing walked once, and the ingresses an item's leaves name.

/** The kinds whose length is built in (F14): a text's, a collection's. */
const MEASURED: ReadonlySet<ItemTag> = new Set(["string", "list", "set", "dict"]);

/**
 * S6-CARRIERS §3.2: every store, add and transfer landing that admission does not reject walked once (`stopsOf`, the
 * walk admission's deciders and C1's contributions read), then every operation's own read, as its own landing; each
 * ingress stop recorded by the store that brings it, or as an own read. Built once per pass, at its first use. A store
 * in dead code and a dead call's argument for a written parameter are walked too: their boundaries are against the
 * destination's admitted type, as in live code (AD-3: a written type is no flow fact). `keep`: the stops of the stores
 * it keeps only, no own read walked and nothing kept (`publish` after a stop before admission settled).
 */
export function landingIndex(
  admission: Admission,
  keep?: (d: Definition) => boolean,
): LandingIndex {
  if (admission.landings !== null) return admission.landings;
  const { program, definitions, lists } = admission.pass;
  const byStore = new Map<Definition, IngressStop[]>();
  const byIngress = new Map<PlaceId, Landing>();
  const entry = (ingress: PlaceId): Landing => {
    let found = byIngress.get(ingress);
    if (found === undefined) byIngress.set(ingress, (found = { stores: new Set(), own: false }));
    return found;
  };
  // the ingress a stop is, or reads through projections of it (a member of it); a length of an owner that is surely
  // a text or a collection is derived (F14), no member of its external data (F15), an object's own `length` one
  const ingressOf = (value: PlaceId): PlaceId | null => {
    let at = value;
    while (!definitions.ingress.has(at)) {
      program.work.charge("indexSteps");
      const projection = program.projOf.get(at);
      if (projection === undefined) return null;
      if (measuresLength(projection.step) && measured(admission, projection.owner)) return null;
      at = projection.owner;
    }
    return at;
  };
  // the own reads some walk reached through its own row (§3.2: never walked again as their own landing), and per
  // row of a walk (its carrier and operand) whether it or a row outside it is an own row, and the innermost typed
  // default's call at or outside it: each row once, so a stop costs only the rows no stop before it went through
  // (each value has one syntactic parent, so a row's outer rows are the same in every stop through it; Codex r21 B2)
  // r4.63 (3), r4.66 (2): host data in the default of a `load` or `fromJson` of an inferred place typed by that
  // default (its kinds definite) is the call's: the boundary at the call validates the loaded value, so the default
  // owes no own read; a default without definite kinds types nothing, its read an own read as any; the innermost
  // such call
  const reached = new Set<PlaceId>();
  const rows = new Map<string, { readonly own: boolean; readonly call: PlaceId | null }>();
  const rowOf = (
    via: ViaChain | null,
  ): { readonly own: boolean; readonly call: PlaceId | null } => {
    const rowKey = (level: Via): string => `${level.value}:${level.operand}`;
    // (the rows no stop before went through, from the innermost out)
    const fresh: Via[] = [];
    let at = via;
    for (; at !== null && !rows.has(rowKey(at.level)); at = at.outer) {
      program.work.charge("indexSteps");
      fresh.push(at.level);
    }
    let row = at !== null ? rows.get(rowKey(at.level))! : { own: false, call: null };
    for (let index = fresh.length - 1; index >= 0; index -= 1) {
      const level = fresh[index]!;
      if (OWN_ROLES.has(level.role)) reached.add(level.operand);
      row = {
        own: row.own || OWN_ROLES.has(level.role),
        call: TYPED_ROLES.has(level.role)
          ? admission.typedByDefault(level.value)
            ? level.value
            : null
          : row.call,
      };
      rows.set(rowKey(level), row);
    }
    return row;
  };
  const walk = (
    value: PlaceId,
    node: FlowNode,
    found: (stop: Stop, ingress: PlaceId, own: boolean) => void,
  ): void => {
    const stops = stopsOf(admission, value, node, admission.pass.program.work.stopped === null);
    for (const map of [stops.written, stops.values, stops.literals])
      for (const list of map.values())
        for (const stop of list) {
          program.work.charge("indexSteps");
          const row = rowOf(stop.via);
          const own = row.own;
          const ingress = lengthAt(admission, stop.value, stop.strip)
            ? null
            : ingressOf(stop.value);
          if (ingress === null) continue;
          const call = own ? row.call : null;
          if (call !== null) entry(ingress).call = call;
          else found(stop, ingress, own);
        }
  };
  for (const d of [
    ...definitions.storeDefs,
    ...definitions.transferDefs,
    ...[...definitions.deadArguments.values()].flat(),
  ]) {
    if ((d.kind !== "whole" && d.kind !== "add") || d.value === undefined) continue;
    if (!lists.live(d) || keep?.(d) === false) continue;
    walk(d.value, d.node, (stop, ingress, own) => {
      if (own) {
        entry(ingress).own = true;
        return;
      }
      const site = program.places[ingress]?.site;
      if (site === null || site === undefined) return;
      entry(ingress).stores.add(d);
      let list = byStore.get(d);
      if (list === undefined) byStore.set(d, (list = []));
      const property = stop.path.findIndex((step) => step !== "element");
      list.push({
        ingress,
        d,
        path: stop.path,
        recordPath: property < 0 ? stop.path : keptSlice(admission.work, stop.path, 0, property),
        key: stop.key,
        site,
        reads: program.places[stop.value]?.site ?? site,
        contribution: contributionSite(admission, stop, d),
        // (a loop variable's place takes its domain from the iterable, never inline: C1 beside the boundary, r4.63 (4))
        whole:
          d.how !== "loop variable" &&
          ingress === stop.value &&
          stop.strip.every((step) => step === SELECTED_VALUE || step === SELECTED_TEXT),
      });
    });
  }
  // an operation's own read is an own read wherever it stands (C10): one no walk reached is its own landing, the
  // outermost first, so a nested own read its enclosing one's walk reaches is walked once (not for some stores' stops)
  const owns: { readonly operand: PlaceId; readonly site: SourceSite }[] = [];
  for (const carrier of keep === undefined
    ? [...program.projOf.keys(), ...program.opOf.keys()]
    : [])
    for (const { operand, own } of operandsOf(program, carrier)) {
      program.work.charge("indexSteps");
      const site = own ? program.places[operand]?.site : null;
      if (site !== null && site !== undefined) owns.push({ operand, site });
    }
  program.work.charge("indexSteps", sortCost(owns.length));
  owns.sort(
    (a, b) => a.site.file - b.site.file || a.site.start - b.site.start || b.site.end - a.site.end,
  );
  for (const { operand, site } of owns) {
    program.work.charge("indexSteps");
    const node = reached.has(operand) ? null : program.exprAt(site);
    if (node !== null) walk(operand, node, (_, ingress) => (entry(ingress).own = true));
  }
  for (const list of byStore.values()) {
    program.work.charge("checks", sortCost(list.length));
    list.sort((a, b) => compareKeys(a.key, b.key));
  }
  // (a typed default's data is the call's that lands: each chain of nested typed defaults followed once)
  for (const landing of byIngress.values()) {
    const chain: Landing[] = [];
    let at: Landing | undefined = landing;
    while (at?.call !== undefined && at.stores.size === 0 && !at.own) {
      program.work.charge("indexSteps");
      chain.push(at);
      const next = byIngress.get(at.call);
      if (next?.call === undefined || next.stores.size > 0 || next.own) break;
      at = next;
    }
    const last = chain.at(-1)?.call;
    if (last !== undefined) for (const member of chain) member.call = last;
  }
  // (some stores' stops only: not the index, `keep` a stop's finishing publication, `publish`)
  if (keep !== undefined) return { byStore, byIngress };
  admission.landings = { byStore, byIngress };
  return admission.landings;
}

/**
 * Whether an ingress is a `load` or a `fromJson` typed by its default alone (F18): no declared or written expected
 * type, a default whose own kinds type it.
 */
export function typedByDefault(admission: Admission, value: PlaceId): boolean {
  const { program, contract } = admission.pass;
  const c = program.opOf.get(value);
  if (c === undefined || !("result" in c)) return false;
  const parses =
    c.kind === "operation" &&
    c.contract.family === "conversion" &&
    conversionCategory(c.contract.name)?.kind === "parses";
  if (c.kind !== "load" && !parses) return false;
  if (c.kind === "load" && (c.key === null || c.receiver !== null)) return false;
  const fallback = c.kind === "load" ? (c.fallback ?? undefined) : defaultOf(c);
  return (
    fallback !== undefined &&
    contract.landsIn(c.result, []) === null &&
    f18Kinds(admission, c) !== null
  );
}

/** Whether a value is surely a text or a collection, whose length is built in (F14): no kind of it unknown or other. */
function measured(admission: Admission, value: PlaceId, path: readonly string[] = []): boolean {
  const kinds = withoutEmpty(admission.run(admission.pass.contract.contractOfValueAt(value, path)));
  return kinds.length > 0 && kinds.every((item) => MEASURED.has(item.tag));
}

/** Whether a stop reads a value's length where it is surely measured (F14): derived, no member of external data. */
function lengthAt(admission: Admission, value: PlaceId, strip: readonly string[]): boolean {
  for (let at = 0; at < strip.length; at += 1) {
    admission.pass.program.work.charge("indexSteps");
    if (measuresLength(strip[at]!) && measured(admission, value, strip.slice(0, at))) return true;
  }
  return false;
}

/** The ingress a leaf names (`ingressLeaf`), or `null` for none of the program's. */
export function leafIngress(admission: Admission, leaf: Writer): PlaceId | null {
  return admission.pass.definitions.ingressAt.get(writerKey(leaf)) ?? null;
}

/** The ingresses an item's leaves name, once per provenance node and pass (C1's membership tests read it). */
export function leafIngresses(admission: Admission, node: IngressNode): ReadonlySet<PlaceId> {
  const known = admission.nodeIngresses.get(node);
  if (known !== undefined) return known;
  const out = new Set<PlaceId>();
  const seen = new Set<IngressNode>();
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    admission.pass.program.work.charge("checks");
    if ("ingress" in current) {
      const ingress = leafIngress(admission, current.ingress);
      if (ingress !== null) out.add(ingress);
    } else if ("parts" in current) for (const part of current.parts) pending.push(part);
    else if (current.contents !== null) pending.push(current.contents);
  }
  admission.nodeIngresses.set(node, out);
  return out;
}

export function f18Kinds(
  admission: Admission,
  c: CorePass["program"]["constraints"][number],
): { readonly label: string; readonly tags: readonly ItemTag[] } | null {
  if (!("result" in c)) return null;
  const known = admission.f18.get(c.result);
  if (known !== undefined) return known;
  const { program, contract, values } = admission.pass;
  const parses = c.kind === "operation" && typedIngress(c);
  let found: { readonly label: string; readonly tags: readonly ItemTag[] } | null = null;
  const node = c.kind === "load" || parses ? program.exprAt(c.site) : null;
  if (node !== null && program.live(node)) {
    // (after a stop, as the finishing read answers it: a typed call's expected type by its syntax, F18, r4.138)
    const items = withoutEmpty(
      admission.host.read?.(c.result, node, []) ??
        admission.run(values.valueItems(c.result, node, [])),
    );
    const tags: ItemTag[] = [
      ...new Set(items.filter((item) => concrete(item)).map((item) => item.tag)),
    ];
    // the admitted domain keeps its null: a nullable written type, or an untyped place's `default: null`
    const written = (c.kind === "load" ? c.receiver : null) ?? contract.landsIn(c.result, []);
    const term = written === null ? null : termAt(written, []);
    if (
      tags.length > 0 &&
      items.some((item) => item.tag === "null") &&
      (term === null || typeTags(term).includes("null"))
    )
      tags.push("null");
    if (tags.length > 0) found = { label: `${parses ? "fromJson" : "load"}.result`, tags };
    // (after a stop, a type the finishing read leaves open is no absent one: its boundary is marked, r4.144)
    else if (
      admission.pass.program.work.stopped !== null &&
      items.some((item) => item.tag === "unknown" && (item.reasons & REASON.budget) !== 0)
    )
      admission.f18Open.add(c.result);
  }
  admission.f18.set(c.result, found);
  return found;
}

/** Whether a constraint is a typed ingress (F18): a load, or a parse of text to a type. */
export function typedIngress(c: CorePass["program"]["constraints"][number]): boolean {
  return (
    c.kind === "load" ||
    (c.kind === "operation" &&
      c.contract.family === "conversion" &&
      conversionCategory(c.contract.name)?.kind === "parses")
  );
}
