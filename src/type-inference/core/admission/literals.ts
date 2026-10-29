import type { PlaceId, SourceSite } from "../../graph.js";
import type { Admission } from "../admission.js";
import {
  joinParts,
  keepText,
  keptParts,
  keptSplit,
  keptSlice,
  keptSteps,
  keptText,
  pathText,
} from "../budget.js";
import { defaultOf, typeTags, type IndexNode } from "../contract.js";
import {
  keptPath,
  keyPlace,
  SELECTED_TEXT,
  SELECTED_VALUE,
  sortCost,
  type Definition,
  type Key,
} from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import { MIXED_LEAF, REASON, type Item, type ItemTag } from "../items.js";
import { conversionCategory } from "../method-categories.js";
import { refText, Touches, type Touch, type TouchRef } from "../touch.js";
import { hotSets } from "./groups.js";
import { heldMeetings } from "./held.js";
import { drive } from "./inherited.js";
import { concrete, deciding, fits, NUMERIC } from "./kinds.js";
import { inheritance, landedBelow } from "./landings.js";
import type { OwnStructure } from "./model.js";
import { ownOf } from "./own.js";
import { earliestDecider } from "./scan.js";
import { literalLanding, pathsBelow, sharedPaths, valueStructure } from "./structure.js";
import { touchCopy, touchesOf, touchOf, touchRead } from "./touches.js";

// Literals (ADR 0021 1.3, A8): their elements of one type, their stores at a step, and where an error inside one sits.

/**
 * The landed paths below a collection literal's landing where one of its elements may offend another
 * (`literalElements`, F2): each element's touch trie relative to the landing (its copies' and reads' sources', its own
 * points and other values), merged largest first; a path is owed where two stand there and their contents hold two
 * kinds or more (`Touches`, `elements`), and kept where the place lands it.
 */
function touchElements(
  admission: Admission,
  landing: Key,
  list: readonly Definition[],
): { readonly path: readonly string[] }[] {
  hotSets(admission);
  const touches = touchesOf(admission);
  const work = admission.pass.program.work;
  const place = keyPlace(landing);
  const base = keptPath(admission.work, landing);
  const copies = new Set<string>();
  for (const copy of inheritance(admission).into.get(place) ?? [])
    copies.add(keptParts(admission.work, copy.path, copy.from, copy.strip));
  const owed = new Map<string, readonly string[]>();
  const take = (found: Parameters<Touches["paths"]>[0]): void => {
    const paths: (readonly string[])[] = [];
    touches.paths(found, [], paths);
    for (const path of paths) owed.set(keptText(admission.work, path), path);
  };
  const rest = (path: readonly string[]): string[] => keptSlice(admission.work, path, base.length);
  const elements = list.map((d, index): Touch | null => {
    const parts: Touch[] = [];
    const own: OwnStructure & {
      readonly points: (readonly string[])[];
      readonly below: (readonly string[])[];
      readonly reads: { readonly at: readonly string[]; readonly source: Key }[];
    } = { points: [], below: [], reads: [] };
    ownOf(admission, d, d.value!, base, copies, own, (at, from, strip) =>
      parts.push(touchCopy(admission, from, strip, rest(at))),
    );
    for (const { at, source } of own.reads) parts.push(touchRead(admission, source, rest(at)));
    const mine = (path: readonly string[]): TouchRef => {
      const ref = { owner: `e${d.uid}`, place: -1 - index, path, lands: false, value: d.value! };
      return { ...ref, text: refText(admission.work, ref) };
    };
    for (const point of own.points) parts.push(touches.leaf(rest(point), [mine(rest(point))]));
    for (const prefix of own.below)
      parts.push(touches.leaf(rest(prefix), [], [mine(rest(prefix))]));
    work.charge("indexSteps", parts.length + sortCost(parts.length));
    parts.sort((a, b) => b.size - a.size || a.id - b.id);
    let node: Touch | null = null;
    for (const part of parts) {
      const merged = touches.merge(node, part, "elements");
      node = merged.node;
      take(merged.found);
    }
    return node;
  });
  if (list.length === 0) return [];
  // (the elements merged largest first, as a place's parts are)
  const order = elements
    .map((node, index) => ({ node, index }))
    .filter((each): each is { node: Touch; index: number } => each.node !== null)
    .sort((a, b) => b.node.size - a.node.size || a.node.id - b.node.id);
  work.charge("indexSteps", order.length + sortCost(order.length));
  let merged: Touch | null = null;
  for (const { node } of order) {
    const next = touches.merge(merged, node, "elements");
    merged = next.node;
    take(next.found);
  }
  // (the owed paths are those the merges kept: two stand and hold two kinds or more. Where two contributors hold
  // anything above one, every path the place lands below it is owed, its kinds read from the literal's merged node)
  const kept = new Map<string, readonly string[]>();
  for (const [text, path] of owed) {
    if (touches.opaqueHolders(merged, path) < 2) {
      kept.set(text, path);
      continue;
    }
    for (const below of landedBelow(admission, place, keptSteps(admission.work, base, path))) {
      const steps = keptSplit(admission.work, below);
      if (steps.length <= base.length) continue;
      if (touches.kindsAt(merged, rest(steps)).size > 1)
        kept.set(keptText(admission.work, rest(steps)), rest(steps));
    }
  }
  const out: { readonly path: readonly string[] }[] = [];
  const texts = [...kept.keys()].sort();
  work.charge("indexSteps", texts.length + sortCost(texts.length));
  const landed = touchOf(admission, place).node;
  for (const text of texts) {
    const path = kept.get(text)!;
    if (path.length === 0) continue;
    // (landed in the place: by the place's trie, which lands every copy into it, not this literal's alone, a rejected
    // one too, as the landing view has it and A6 finds the rejection again in every pass)
    if (!touches.landedAt(landed, keptSteps(admission.work, base, path))) continue;
    out.push({ path });
  }
  return out;
}

/**
 * A literal value's stores at one step, in evaluation order: a property's one store, a collection's every element, a
 * dict's values among them (its `element`, as its type has them). Every walk of a literal's children asks here with its
 * path's own step, so the step that reaches a child is read in this one place (TABLE r4.122).
 */
export function literalChildren(admission: Admission, value: PlaceId, step: string): Definition[] {
  const { program, definitions } = admission.pass;
  const out: Definition[] = [];
  for (const has of program.hasOf.get(value) ?? []) {
    const term = admission.termAt(has.type, step);
    if (term?.kind === "ref")
      for (const d of definitions.cellDefs.get(term.place) ?? []) out.push(d);
  }
  program.work.charge("checks", sortCost(out.length));
  return out.sort(
    (a, b) =>
      (program.places[a.value!]?.site?.start ?? 0) - (program.places[b.value!]?.site?.start ?? 0),
  );
}

/**
 * r4.35: an error for a contribution inside literals sits at the innermost offending expression: the stored value
 * walked along the path through record fields, collection elements and dict values, in evaluation order, to the first
 * value at the path's end whose own items offend.
 */
export function offendingAt(
  admission: Admission,
  d: Definition,
  at: readonly string[],
  leaf: (items: readonly Item[]) => boolean,
): Definition | null {
  const pending: [PlaceId, FlowNode, number][] = [[d.value!, d.node, 0]];
  while (pending.length > 0) {
    const [value, node, index] = pending.pop()!;
    const children = admission.literalChildren(value, at[index]!);
    if (index + 1 === at.length) {
      for (const child of children) {
        admission.pass.program.work.charge("checks");
        if (leaf(admission.items(child.value!, child.node ?? node, []))) return child;
      }
    } else
      for (let position = children.length - 1; position >= 0; position -= 1)
        pending.push([children[position]!.value!, children[position]!.node ?? node, index + 1]);
  }
  return null;
}

/** The site of an error for a store's contribution: the innermost offending expression inside literals, else the store's. */
export function siteAt(
  admission: Admission,
  d: Definition,
  at: readonly string[],
  leaf: (items: readonly Item[]) => boolean,
): SourceSite {
  const found = at.length > 0 && d.kind === "whole" ? admission.offendingAt(d, at, leaf) : null;
  return found === null ? d.site : (admission.pass.program.place(found.value!).site ?? d.site);
}

/** A literal value's stores at one step: a property's one store, a collection's every element. */
export function storesAt(
  admission: Admission,
  value: PlaceId,
  step: string,
): readonly Definition[] {
  const { program, definitions } = admission.pass;
  for (const has of program.hasOf.get(value) ?? []) {
    const at = admission.termAt(has.type, step);
    if (at?.kind === "ref") return definitions.cellDefs.get(at.place) ?? [];
  }
  return [];
}

/**
 * ADR 0021 1.3, A8: a list's, set's or dict's literal elements (values), and the properties its objects share, have
 * one type at every path their known structure gives, a copy's or a call's its source's (F2): the earliest element's,
 * or a copy of a written binding's written type (A4), unless the literal lands directly in a written place, whose
 * type then checks them (A1). A definite element of another type is an error at the innermost offending expression
 * (r4.35) and is rejected: later uses see the earliest element's type (A6). `error` hears of each with the element's
 * store, the literal's cell, the path, the earliest element's kinds there (by family, and its own, which a sentence
 * names) and the offending element's (D1). `undecided`, after a stop before admission settled: a literal whose element
 * needs a decision admission did not make (a named element, or one the finishing read leaves `STOPPED`) is not
 * compared; it is reported there instead, so its store marks (TABLE r4.126).
 */
export function literalElements(
  admission: Admission,
  order: <T>(list: readonly T[]) => T[],
  error: (
    site: SourceSite,
    found: {
      readonly d: Definition;
      readonly cell: PlaceId;
      readonly path: readonly string[];
      readonly decided: readonly ItemTag[];
      readonly earliest: readonly ItemTag[];
      readonly kinds: readonly ItemTag[];
      readonly atCopy: boolean;
    },
  ) => void,
  undecided?: (cell: PlaceId) => void,
): void {
  const { program, definitions, contract } = admission.pass;
  const family = (tag: ItemTag): ItemTag => (NUMERIC.has(tag) ? "number" : tag);
  // a named element: one whose structure holds a source (a copy, a call, what a carrier takes of either)
  const named = (d: Definition): boolean =>
    d.value !== undefined && valueStructure(admission, d.value).sources.length > 0;
  // per landing and the distinct groups of a literal's elements' contracts (flow-insensitive: by source identity,
  // class or a typed ingress's type and default, `conflictGroups`), the paths below them where their contracts hold
  // more than one kind: only there can one element offend another (F2)
  const conflicts = new Map<string, readonly (readonly string[])[]>();
  // (per key, the paths where what the elements definitely hold meets, A2's)
  const atCopies = new Map<string, ReadonlySet<string>>();
  cells: for (const [cell, list] of order([...definitions.cellDefs])) {
    const owner = program.cellOwner.get(cell);
    if (owner?.kind !== "cell" || list.length < 2 || contract.landsIn(owner.owner, []) !== null)
      continue;
    if (undecided !== undefined && list.some(named)) {
      undecided(cell);
      continue;
    }
    let shared: readonly (readonly string[])[] | null = null;
    let atCopy: ReadonlySet<string> = new Set();
    if (list.some(named)) {
      const ids = list.map((d) => (d.value === undefined ? "" : contract.identityOf(d.value).id));
      const distinct = [...new Set(ids)].sort();
      // (elements of one source identity hold one value: none offends another)
      if (distinct.length === 1) continue;
      const landing = literalLanding(admission, owner.owner);
      const classes = conflictGroups(admission, list);
      const kinds = [...new Set(classes)].sort();
      const key = joinParts(landing ?? "", kinds.join(","));
      let paths = conflicts.get(key);
      if (paths === undefined) {
        const firstOf = new Map<string, Definition>();
        for (const [index, kind] of classes.entries())
          if (!firstOf.has(kind)) firstOf.set(kind, list[index]!);
        program.work.charge("checks", classes.length);
        const representatives = kinds.map((kind) => firstOf.get(kind)!);
        const kept: (readonly string[])[] = [];
        const listed = pathsBelow(admission, representatives[0]!.value!, [
          ...sharedPaths(admission, landing, representatives),
          ...representatives.slice(1).flatMap((d) => pathsBelow(admission, d.value!, [])),
        ]);
        // (each object literal asked at its own properties' paths only: a wide object beside k small ones takes their
        // sizes, not their product, #1199)
        const holding = holdersByProperty(admission, representatives);
        for (const path of listed) {
          const kinds = new Set<ItemTag>();
          for (const d of holding(path)) {
            program.work.charge("checks");
            for (const item of withoutEmpty(
              admission.run(contract.contractOfValueAt(d.value!, path)),
            ))
              if (concrete(item)) kinds.add(item.tag);
          }
          if (kinds.size > 1) kept.push(path);
        }
        // (beside them the landed paths where two elements' tries meet, their kinds from the literal's merged trie,
        // no element asked: Astra's review B1, #1188)
        const texts = new Set<string>();
        for (const path of listed) texts.add(keptText(admission.work, path));
        const keep = (path: readonly string[]): void => {
          const text = keptText(admission.work, path);
          if (texts.has(text)) return;
          texts.add(text);
          kept.push(path);
        };
        if (landing !== null)
          for (const met of touchElements(admission, landing, representatives)) keep(met.path);
        // (and where what they definitely hold meets: a property only copies of whole objects bring, checked where
        // the copy meets the literal, A2, TABLE r4.131)
        const base = landing === null ? [] : keptPath(admission.work, landing);
        const met = new Set<string>();
        for (const path of heldMeetings(
          admission,
          representatives.map((d) => ({ d, at: base })),
          base,
        )) {
          met.add(keptText(admission.work, path));
          keep(path);
        }
        keepText(admission.work, key.length);
        conflicts.set(key, (paths = kept));
        atCopies.set(key, met);
      }
      shared = paths;
      atCopy = atCopies.get(key)!;
    }
    const first = new Map<
      string,
      {
        readonly tags: readonly ItemTag[];
        readonly written: boolean;
        readonly own: readonly ItemTag[];
      }
    >();
    // an element of one family offends where none of its kinds fits: a written type by the kinds themselves (a whole
    // number fits a written integer, a fraction does not), an earliest element's by their family
    const offends = (at: string, tags: readonly ItemTag[]): boolean => {
      const decided = first.get(at)!;
      const families = [...new Set(tags.map(family))];
      return (
        families.length === 1 &&
        (decided.written ? tags : families).every(
          (tag) => !decided.tags.some((ref) => fits(tag, ref, decided.written)),
        )
      );
    };
    // the error at the innermost offending expression (r4.35), the element rejected (A6)
    const offended = (d: Definition, path: readonly string[]): void => {
      const at = pathText(path);
      const inner =
        path.length > 0
          ? admission.offendingAt(d, path, (items) =>
              offends(at, [...new Set(deciding(items).map((item) => item.tag))]),
            )
          : null;
      error(inner === null ? d.site : (program.place(inner.value!).site ?? d.site), {
        d,
        cell,
        path,
        decided: first.get(at)!.tags,
        earliest: first.get(at)!.own,
        kinds: [...new Set(deciding(admission.valueAt(d, path)).map((item) => item.tag))],
        atCopy: atCopy.has(at),
      });
      admission.reject(d, cell, path);
    };
    // a named literal's elements are compared at those paths, a literal's own elements at their structure's; per source
    // identity in the literal, the paths its first element offends at, where each later one offends too
    const offending = new Map<string, (readonly string[])[]>();
    for (const d of list) {
      if (d.value === undefined) continue;
      const identity = named(d) ? contract.identityOf(d.value).id : null;
      const known = identity === null ? undefined : offending.get(identity);
      const found: (readonly string[])[] = [];
      if (identity !== null && known === undefined) offending.set(identity, found);
      const below = known !== undefined ? [] : (shared ?? pathsBelow(admission, d.value, []));
      for (const path of [[], ...below]) {
        const at = keptText(admission.work, path);
        const items = admission.valueAt(d, path);
        if (
          undecided !== undefined &&
          items.some((item) => item.tag === "unknown" && (item.reasons & REASON.budget) !== 0)
        ) {
          undecided(cell);
          continue cells;
        }
        const own = [...new Set(deciding(items).map((item) => item.tag))];
        if (!first.has(at)) {
          // A4: a copy of a written binding gives its written type, whatever it holds now, where it is the earliest
          // decider on the path; an element whose structure holds no source holds no copy (#1106: k literals nested
          // in each other asked each other's stops)
          const copied =
            identity === null
              ? null
              : (drive(admission, earliestDecider(admission, d.value, d.node, path, null))?.term ??
                null);
          const kinds = [...new Set(own.map(family))];
          if (copied !== null) {
            const tags = typeTags(copied).filter((tag) => tag !== "null");
            first.set(at, { tags, written: true, own: tags });
          } else if (kinds.length === 1) first.set(at, { tags: kinds, written: false, own });
          continue;
        }
        if (!offends(at, own)) continue;
        offended(d, path);
        if (path.length > 0) found.push(path);
      }
      for (const path of known ?? []) offended(d, path);
    }
  }
}

/**
 * The elements whose contracts may hold a kind at a path below them (`literalElements`), in their order. Step by step
 * along the path, an element whose literal holds objects alone at a step (one kind, no read or other value beside
 * them) is asked only where they have the next property (F11: without it they hold `missing` there and below), one
 * that holds a collection alone there only below its element step, and below any other step as its derived member's
 * owner; any other element is asked at every path below the step (a copy, a read, an operation), as at a selection's
 * step (V30 §19) and at the path's end. Each step's properties are listed at the first path asked below it, where each
 * element's contract would be read anyway, so a wide object beside k small ones takes their sizes, not their product,
 * at any depth and through lists (#1199, Astra's review B1).
 */
function holdersByProperty(
  admission: Admission,
  elements: readonly Definition[],
): (path: readonly string[]) => readonly Definition[] {
  const { program, contract } = admission.pass;
  // per step walked: the elements asked at every path below it and those holding objects or a collection alone there,
  // each in their order; the objects' properties with their elements, listed once; the steps one longer
  type Holders = {
    /** Per element asked here, its literal's index node at the steps walked (`null`: none, or no literal). */
    readonly nodes: ReadonlyMap<number, IndexNode | null>;
    readonly always: readonly number[];
    readonly objects: readonly number[];
    readonly collections: readonly number[];
    named: Map<string, number[]> | null;
    readonly below: Map<string, Holders>;
  };
  // (two lists merged in the elements' order)
  const merged = (a: readonly number[], b: readonly number[]): number[] => {
    const out: number[] = [];
    for (let i = 0, j = 0; i < a.length || j < b.length;)
      out.push(j >= b.length || (i < a.length && a[i]! < b[j]!) ? a[i++]! : b[j++]!);
    return out;
  };
  const holders = (
    nodes: ReadonlyMap<number, IndexNode | null>,
    candidates: readonly number[],
    always: readonly number[],
  ): Holders => {
    const objects: number[] = [];
    const collections: number[] = [];
    const others: number[] = [];
    for (const at of candidates) {
      program.work.charge("checks");
      const node = nodes.get(at) ?? null;
      const kinds = node?.terms;
      if (node === null || kinds?.size !== 1 || node.reads.length > 0 || node.others.length > 0)
        others.push(at);
      else if (node.objects !== null) objects.push(at);
      else if (kinds.has("list") || kinds.has("set") || kinds.has("dict")) collections.push(at);
      else others.push(at);
    }
    return {
      nodes,
      always: others.length === 0 ? always : merged(always, others),
      objects,
      collections,
      named: null,
      below: new Map(),
    };
  };
  let root: Holders | null = null;
  return (path) => {
    const first = path[0];
    if (first === undefined || first === SELECTED_VALUE || first === SELECTED_TEXT) return elements;
    root ??= holders(
      new Map(
        elements.map(({ value }, at) => [
          at,
          program.hasOf.has(value!) ? contract.literalIndex(value!).root : null,
        ]),
      ),
      [...elements.keys()],
      [],
    );
    let at = root;
    for (let length = 0; length < path.length; length += 1) {
      const step = path[length]!;
      if (step === SELECTED_VALUE || step === SELECTED_TEXT) break;
      let next = at.below.get(step);
      if (next === undefined) {
        if (at.named === null) {
          const named = new Map<string, number[]>();
          for (const element of at.objects)
            for (const name of at.nodes.get(element)!.objects!.count.keys()) {
              program.work.charge("checks");
              const list = named.get(name);
              if (list === undefined) named.set(name, [element]);
              else list.push(element);
            }
          at.named = named;
        }
        const element = step === "element";
        const candidates = element ? at.collections : (at.named.get(step) ?? []);
        // (each candidate's node one step down, charged as kept)
        const below = new Map<number, IndexNode | null>();
        for (const candidate of candidates) {
          admission.work.charge("literalUnits");
          below.set(candidate, at.nodes.get(candidate)?.children.get(step) ?? null);
        }
        next = holders(
          below,
          candidates,
          element || at.collections.length === 0 ? at.always : merged(at.always, at.collections),
        );
        at.below.set(step, next);
      }
      at = next;
    }
    return merged(at.always, merged(at.objects, at.collections)).map((index) => elements[index]!);
  };
}

/**
 * A literal's elements grouped for the conflict paths of `literalElements` (§8): elements of one source identity, or
 * of one class (`conflictClass`), have the same kinds at every path, so the elements either joins are one group,
 * asked once; each group named by its least identity or class, so literals of alike groups share one discovery. (An
 * identity may join what a class keeps apart, k bindings of alike objects, #1313, and a class what identities keep
 * apart, k method results of one class, #1078.)
 */
function conflictGroups(admission: Admission, list: readonly Definition[]): string[] {
  const { program, contract } = admission.pass;
  const tags = list.map((d) =>
    d.value === undefined
      ? [""]
      : [joinParts("identity", contract.identityOf(d.value).id), conflictClass(admission, d.value)],
  );
  // (a union-find over the elements, joined by each tag they share)
  const parent = list.map((_, index) => index);
  const find = (at: number): number => {
    while (parent[at] !== at) at = parent[at] = parent[parent[at]!]!;
    return at;
  };
  const byTag = new Map<string, number>();
  for (const [index, own] of tags.entries())
    for (const tag of own) {
      program.work.charge("checks");
      const other = byTag.get(tag);
      if (other === undefined) byTag.set(tag, index);
      else parent[find(index)] = find(other);
    }
  const least = new Map<number, string>();
  for (const [index, own] of tags.entries()) {
    const root = find(index);
    for (const tag of own) {
      const known = least.get(root);
      if (known === undefined || tag < known) least.set(root, tag);
    }
  }
  return list.map((_, index) => least.get(find(index))!);
}

/**
 * The class of a literal element's contracts, for the conflict paths of `literalElements` (§8): a `load` or a parse is
 * typed by its expected type, else by its default (F18), so the k ingresses of one typed default have one class and
 * share one discovery, while each keeps its own identity and its boundary check (C9, §8 r4.15), and a default reading
 * host data counts by the contract's class of its global and guards (`classOf`, #1196); a read, a literal or an
 * `otherwise` whose class is mixed by its leaves alone that class (`Contract.boundClass`: k reads of one global,
 * #1207, k `load(…) otherwise {…}` of one default and one fallback or objects holding them, #1304, k bindings of loads
 * of one default, #1313, each share one discovery); any other value its contract-side class (`Contract.classOf`, so k
 * method results or conversions beside an object are not each asked at each of its properties, #1078), or without
 * one its source identity. Values of one class have the same kinds at every path.
 */
function conflictClass(admission: Admission, value: PlaceId): string {
  const { program, contract, definitions } = admission.pass;
  // (a class and an identity tagged apart, as an identity may read like any short id, a carrier's `c<n>` among
  // them; a short id per class, as a class's text may hold the "," that joins a literal's classes into its key)
  const tagged = (cls: string | null, of: PlaceId): string => {
    if (cls === null) return joinParts("identity", contract.identityOf(of).id);
    let id = admission.classIds.get(cls);
    if (id === undefined) admission.classIds.set(cls, (id = admission.classIds.size));
    return joinParts("class", id);
  };
  const own = (of: PlaceId): string => tagged(contract.classOf(of, false), of);
  const c = program.opOf.get(value);
  if (c === undefined || c.kind === "fallback") {
    const bound = contract.boundClass(value, false);
    return bound.mixed === MIXED_LEAF ? tagged(bound.cls, value) : own(value);
  }
  let fallback: PlaceId | undefined;
  if (c.kind === "load" && c.key !== null) fallback = c.fallback ?? undefined;
  else if (
    c.kind === "operation" &&
    c.contract.family === "conversion" &&
    conversionCategory(c.contract.name)?.kind === "parses"
  )
    fallback = defaultOf(c);
  else return own(value);
  const expected = (c.kind === "load" ? c.receiver : null) ?? contract.landsIn(c.result, []);
  let term = "";
  if (expected !== null) {
    term = admission.termIds.get(expected) ?? `t${admission.termIds.size}`;
    admission.termIds.set(expected, term);
  }
  const by = c.kind === "load" ? "load" : c.contract.name;
  const host =
    fallback !== undefined &&
    program.occurrenceOf.has(fallback) &&
    definitions.ingress.has(fallback);
  return joinParts(
    "f18",
    by,
    term,
    fallback === undefined
      ? ""
      : host
        ? own(fallback)
        : joinParts("identity", contract.identityOf(fallback).id),
  );
}
