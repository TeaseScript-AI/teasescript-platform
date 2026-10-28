import type { PlaceId, SourceSite } from "../../graph.js";
import type { Admission } from "../admission.js";
import {
  joinParts,
  joinSteps,
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
  joinedOperand,
  keptKey,
  keptPath,
  keyOf,
  keyPath,
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
import { decided } from "./decision.js";
import { hotSets } from "./groups.js";
import { heldMeetings } from "./held.js";
import { drive } from "./inherited.js";
import { admitsNumber, concrete, deciding, fits, NUMERIC } from "./kinds.js";
import { inheritance, landedBelow } from "./landings.js";
import type { Join, JoinDecided, OwnStructure } from "./model.js";
import { ownOf } from "./own.js";
import { permittedAt, unrestricted } from "./permitted.js";
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
 * ADR 0021 1.3, V30 §4 and §16: a list's `+` (and `+=`) holds both operands' elements, so a join's right operand must
 * fit the element type its left operand holds (#1272), as a store into a variable holding the left one must. Each
 * value's element type at a path is the one a variable holding it is decided by (`scanAt`, A2, A4), so a join answers
 * the same inline as kept in a variable: an operand's own (`decidedAt`: a written copy by its type, a read or a call by
 * its place's decision, else its elements' kinds as a literal's earliest element decides them, `earliestDecider`); a
 * join's from its operands' in evaluation order, the earliest deciding there decides, a written type by itself, else
 * with the kinds of every operand the join holds. A right operand whose elements there are of one other family, none
 * of whose kinds fits, is an error at its join, unless the written type the tree lands in directly holds both (A1), and
 * is rejected from that join (A6): the join then holds its left operand's elements alone. A right operand is compared
 * at the paths of its own structure, a join's at its list levels as a variable holding it is (`pathsBelow`); a join's
 * paths are its operands', the smaller one's added to the larger one's, so a chain of k joins, on either side, costs
 * its operands' structures once. `error` hears of each with the join, the path, the decided kinds there and the
 * operand's, the operands a fix may name and the type it writes: `named`, the operands a fix may declare, in order:
 * alone in its tree, the join's left one where its elements decided the path, then its right one, whose elements
 * offend; beside other errors of its tree, only a left one that decided every one of them, whose union holds them all
 * (Codex r5 on #1310); `levels`, what the tree's elements hold at each list level down to the path, its `null`s and
 * numbers kept. `undecided`, before admission settled (`Consumers.#freshStores`): a join an operand of which is read
 * through a decision.
 */
export function joinElements(
  admission: Admission,
  order: <T>(list: readonly T[]) => T[],
  error: (found: {
    readonly c: Join;
    readonly path: readonly string[];
    readonly earliest: readonly ItemTag[];
    readonly kinds: readonly ItemTag[];
    readonly named: readonly PlaceId[];
    readonly levels: readonly (readonly ItemTag[])[] | null;
  }) => void,
  undecided?: (value: PlaceId) => void,
): void {
  const { program, contract } = admission.pass;
  const family = (tag: ItemTag): ItemTag => (NUMERIC.has(tag) ? "number" : tag);
  const joins = new Map<PlaceId, Join>();
  for (const c of program.constraints)
    if (
      c.kind === "operation" &&
      c.contract.family === "operator" &&
      c.contract.name === "+" &&
      c.arguments.length === 2
    )
      joins.set(c.result, c);
  // (a tree's root: no join's operand)
  const inner = new Set<PlaceId>();
  for (const c of joins.values())
    for (const operand of c.arguments) if (joins.has(operand)) inner.add(operand);
  const roots: Join[] = [];
  for (const c of joins.values()) if (!inner.has(c.result)) roots.push(c);
  for (const root of order(roots)) {
    // the tree's operands in source order, each with the node it is read at (a `+=`'s its statement's): what the type
    // a fix writes holds (`levelsAt`)
    const operands: { readonly operand: PlaceId; readonly node: FlowNode }[] = [];
    // (and its joins, each before the joins it holds)
    const tree: Join[] = [];
    const pending: { value: PlaceId; node: FlowNode | null }[] = [
      { value: root.result, node: null },
    ];
    while (pending.length > 0) {
      const { value, node } = pending.pop()!;
      program.work.charge("checks");
      const c = joins.get(value);
      if (c === undefined) {
        if (node !== null) operands.push({ operand: value, node });
        continue;
      }
      tree.push(c);
      const at = program.exprAt(c.site) ?? program.flow.statementAt(c.site) ?? null;
      pending.push({ value: c.arguments[1]!, node: at });
      pending.push({ value: c.arguments[0]!, node: at });
    }
    if (operands.length < 2) continue;
    // (before admission settled, a decision is read nowhere: a join with an operand that reads a place or holds a
    // source, a copy or a call, is marked instead, as a literal with a named element is)
    if (
      undecided !== undefined &&
      operands.some(
        ({ operand }) =>
          contract.copiedKey(operand) !== null ||
          contract.resultKey(operand) !== null ||
          valueStructure(admission, operand).sources.length > 0,
      )
    ) {
      undecided(root.result);
      continue;
    }
    const written = contract.landsIn(root.result, []);
    const isList = (operand: PlaceId, node: FlowNode): boolean =>
      admission.items(operand, node, []).some((item) => item.tag === "list");
    // the place an operand reads, whose admitted type is its type: a variable's or a property's, a call's result
    // (F20: a written result's type decides, Codex r5 on #1310)
    const placeOf = (
      operand: PlaceId,
    ): { readonly place: PlaceId; readonly path: readonly string[] } | null => {
      const key = contract.copiedKey(operand) ?? contract.resultKey(operand);
      return key === null ? null : { place: keyPlace(key), path: keyPath(key) };
    };
    // what an operand's elements are at a path: a written copy's type (`open` where it leaves every kind), a read's
    // place's decision, the earliest deciding value's kinds, else its own kinds of one family and no unknown
    const decidedAt = (
      operand: PlaceId,
      node: FlowNode,
      path: readonly string[],
    ): JoinDecided | "open" | null => {
      const at = joinSteps(["element"], path);
      const decider = drive(admission, earliestDecider(admission, operand, node, at, null));
      if (decider !== null && decider.term !== null) {
        if (unrestricted(decider.term)) return "open";
        const tags = typeTags(decider.term).filter((tag) => tag !== "null");
        return {
          tags,
          written: true,
          typed: true,
          own: tags,
          nullable: typeTags(decider.term).includes("null"),
        };
      }
      const read = placeOf(operand);
      const place = read === null ? null : decided(admission, read.place, joinSteps(read.path, at));
      if (place?.tags !== null && place?.tags !== undefined) {
        if (place.tags.includes("unknown")) return "open";
        return {
          tags: place.tags,
          written: place.byWritten,
          typed: place.byWritten,
          own: place.tags,
          nullable: place.byWritten && place.nullable,
        };
      }
      const items = admission.items(operand, node, at);
      const kinds =
        decider?.tags ??
        (items.some((item) => item.tag === "unknown")
          ? []
          : [...new Set(items.filter(concrete).map((item) => item.tag))]);
      // (whole numbers beside numbers are numbers, ADR 0021 1.3, as a place's decision has them: r4.28)
      const own =
        kinds.includes("integer") && items.some(admitsNumber)
          ? [...new Set(kinds.map(family))]
          : kinds;
      // (elements of several families hold a union an earlier type declared, a written result's through a copy:
      // each of its kinds fits as itself)
      return own.length === 0
        ? null
        : { tags: own, written: new Set(own.map(family)).size > 1, typed: false, own };
    };
    // (the type a fix writes holds every value the tree's operands bring and every legitimate store of the places
    // they read and it lands in: at each list level down to a path of elements, a place's admitted type, a value's
    // kinds, `null` among them, and numbers where external data may give one beside whole numbers; per path once,
    // whatever errs there)
    const levels = new Map<string, readonly (readonly ItemTag[])[] | null>();
    const levelsAt = (path: readonly string[]): readonly (readonly ItemTag[])[] | null => {
      const at = keptText(admission.work, path);
      if (levels.has(at)) return levels.get(at)!;
      let out: ItemTag[][] | null = null;
      if (path.every((step) => step === "element")) {
        out = [];
        for (let depth = 0; depth <= path.length; depth += 1) {
          const kinds = new Set<ItemTag>();
          let external = false;
          const prefix = keptSlice(admission.work, path, 0, depth);
          const steps = joinSteps(["element"], prefix);
          // (a place's admitted type, every legitimate store into it held: its written type, or its decision with
          // its null and its numbers; a number external data may store there too)
          const admitted = (place: PlaceId, path: readonly string[]): boolean => {
            const below = joinSteps(path, steps);
            const tags = admission.admitted(place, below).filter((tag) => tag !== "unknown");
            for (const tag of tags) kinds.add(tag);
            for (const item of withoutEmpty(
              admission.run(contract.contractOf(keyOf(place, below))),
            ))
              external ||= item.tag === "number" && item.extOnly === true;
            return tags.length > 0;
          };
          for (const { operand, node } of operands) {
            const read = placeOf(operand);
            if (read !== null && admitted(read.place, read.path)) continue;
            // (a value's own elements; external data is checked where it comes in: its kinds are no part of the
            // type, but a number it may give makes whole numbers numbers, as an operation on it may: r4.36)
            for (const item of admission.items(operand, node, steps))
              if (item.tag === "unknown" || item.extOnly === true)
                external ||= item.tag === "number";
              else kinds.add(item.tag);
            // (a written type it copies may hold null where its value does not yet, A4)
            const ruled = decidedAt(operand, node, prefix);
            if (ruled !== null && ruled !== "open" && ruled.nullable === true) kinds.add("null");
          }
          // (and the place the tree lands in, whose other stores the fix keeps too, once admission settled)
          if (undecided === undefined)
            for (const d of admission.pass.definitions.byValue.get(root.result) ?? [])
              if (d.kind === "whole") admitted(d.place, d.path);
          // (whole numbers beside numbers are numbers, in the whole numbers' place)
          out.push(
            external || kinds.has("number")
              ? [...new Set([...kinds].map((kind) => (kind === "integer" ? "number" : kind)))]
              : [...kinds],
          );
        }
      }
      levels.set(at, out);
      return out;
    };
    // (a place's admitted type holds its null where a read of it, below F11's selection, says nothing)
    const nullAt = (operand: PlaceId, node: FlowNode, path: readonly string[]): boolean => {
      const steps = joinSteps(["element"], path);
      if (admission.items(operand, node, steps).some((item) => item.tag === "null")) return true;
      const read = placeOf(operand);
      return (
        read !== null &&
        admission.admitted(read.place, joinSteps(read.path, steps)).includes("null")
      );
    };
    // each value's element type per path, as a variable holding it is decided (`scanAt`): an operand's own at the paths
    // of its structure, a join's its operands' in evaluation order (its paths the earliest decider of each, the kinds of
    // every operand it holds there), the earliest operand deciding the element asked at any other path (its type may
    // give it); read once per operand, never by reading a join's tree again (Astra's B1, Codex r7's B1 and B3 on #1310)
    interface Decider {
      readonly decided: JoinDecided | "open";
      readonly operand: PlaceId;
      readonly position: number;
    }
    interface Entry {
      readonly path: readonly string[];
      first: Decider | null;
      readonly kinds: Set<ItemTag>;
      nulls: boolean;
    }
    interface Held {
      readonly entries: Map<string, Entry>;
      /** Its list levels: where a variable holding it is compared (`pathsBelow`). */
      readonly levels: Set<string>;
      head: {
        readonly operand: PlaceId;
        readonly node: FlowNode;
        readonly position: number;
      } | null;
    }
    const positions = new Map<PlaceId, { readonly node: FlowNode; readonly position: number }>();
    for (const [position, { operand, node }] of operands.entries())
      positions.set(operand, { node, position });
    const leaf = (operand: PlaceId): Held | null => {
      const { node, position } = positions.get(operand)!;
      if (!isList(operand, node)) return null;
      const held: Held = { entries: new Map(), levels: new Set(), head: null };
      const paths: (readonly string[])[] = [[]];
      for (const path of pathsBelow(admission, operand, []))
        if (path.length > 1 && path[0] === "element")
          paths.push(keptSlice(admission.work, path, 1));
      for (const path of paths) {
        program.work.charge("checks");
        const at = keptText(admission.work, path);
        const ruled = decidedAt(operand, node, path);
        held.entries.set(at, {
          path,
          first: ruled === null ? null : { decided: ruled, operand, position },
          kinds: new Set(ruled === null || ruled === "open" ? [] : ruled.own),
          nulls: nullAt(operand, node, path),
        });
        if (path.every((step) => step === "element")) held.levels.add(at);
        if (path.length === 0 && ruled !== null) held.head = { operand, node, position };
      }
      return held;
    };
    // (a head's decisions at paths its structure does not give, each asked once)
    const asked = new Map<
      PlaceId,
      Map<string, { readonly decided: JoinDecided | "open"; readonly nulls: boolean } | null>
    >();
    const decisionOf = (
      held: Held,
      path: readonly string[],
      at: string,
    ): {
      readonly decided: JoinDecided | "open";
      readonly decider: PlaceId;
      readonly nulls: boolean;
    } | null => {
      const entry = held.entries.get(at);
      let first = entry?.first ?? null;
      let kinds: ReadonlySet<ItemTag> = entry?.kinds ?? new Set();
      let nulls = entry?.nulls ?? false;
      const head = held.head;
      if (head !== null && (first === null || head.position < first.position)) {
        let mine = asked.get(head.operand);
        if (mine === undefined) asked.set(head.operand, (mine = new Map()));
        let found = mine.get(at);
        if (found === undefined) {
          const ruled = decidedAt(head.operand, head.node, path);
          found =
            ruled === null
              ? null
              : { decided: ruled, nulls: nullAt(head.operand, head.node, path) };
          mine.set(at, found);
        }
        if (found !== null) {
          const { decided: ruled } = found;
          first = { decided: ruled, operand: head.operand, position: head.position };
          if (ruled !== "open") kinds = new Set([...kinds, ...ruled.own]);
          nulls ||= found.nulls;
        }
      }
      if (first === null) return null;
      const { decided: ruled, operand: decider } = first;
      if (ruled === "open" || ruled.typed || [...kinds].every((kind) => ruled.own.includes(kind)))
        return { decided: ruled, decider, nulls };
      // (a value's kinds, as `decidedAt` reads them: whole numbers beside numbers are numbers, ADR 0021 1.3; several
      // families each fit as itself)
      const own = kinds.has("number") ? [...new Set([...kinds].map(family))] : [...kinds];
      return {
        decided: { tags: own, written: new Set(own.map(family)).size > 1, typed: false, own },
        decider,
        nulls,
      };
    };
    // (a join's paths: the smaller operand's added to the larger one's, the earlier decider at each)
    const joined = (left: Held, right: Held): Held => {
      const [into, from] = left.entries.size < right.entries.size ? [right, left] : [left, right];
      for (const [at, entry] of from.entries) {
        program.work.charge("checks");
        const known = into.entries.get(at);
        if (known === undefined) {
          into.entries.set(at, entry);
          continue;
        }
        if (
          entry.first !== null &&
          (known.first === null || entry.first.position < known.first.position)
        )
          known.first = entry.first;
        for (const kind of entry.kinds) known.kinds.add(kind);
        known.nulls ||= entry.nulls;
      }
      for (const at of from.levels) into.levels.add(at);
      if (from.head !== null && (into.head === null || from.head.position < into.head.position))
        into.head = from.head;
      return into;
    };
    // each join after the joins it holds, its operands' values taken once
    const held = new Map<PlaceId, Held | null>();
    const take = (value: PlaceId): Held | null => {
      if (!joins.has(value)) return leaf(value);
      const found = held.get(value) ?? null;
      held.delete(value);
      return found;
    };
    const errors: (Omit<Parameters<typeof error>[0], "named"> & { readonly decider: PlaceId })[] =
      [];
    for (const c of tree.toReversed()) {
      const [left, right] = [c.arguments[0]!, c.arguments[1]!];
      const ours = take(left);
      const theirs = take(right);
      let rejected = !admission.pass.lists.joined(right);
      if (ours !== null && theirs !== null)
        for (const at of joins.has(right) ? theirs.levels : theirs.entries.keys()) {
          program.work.charge("checks");
          const path = theirs.entries.get(at)!.path;
          const ruled = decisionOf(ours, path, at);
          if (ruled === null || ruled.decided === "open") continue;
          const own = decisionOf(theirs, path, at);
          if (own === null || own.decided === "open") continue;
          const kinds = own.decided.own;
          const { tags, written: exact } = ruled.decided;
          if (
            (exact ? kinds : kinds.map(family)).some((tag) =>
              tags.some((ref) => fits(tag, ref, exact)),
            )
          )
            continue;
          // (A1: a written type the tree lands in directly holds both)
          const landing =
            written === null ? null : permittedAt(written, joinSteps(["element"], path));
          if (
            landing !== null &&
            (unrestricted(landing) ||
              [...ruled.decided.own, ...kinds].every((tag) =>
                typeTags(landing).some((ref) => fits(tag, ref, true)),
              ))
          )
            continue;
          errors.push({
            c,
            path,
            earliest:
              ruled.nulls || ruled.decided.nullable === true
                ? [...ruled.decided.own, "null"]
                : ruled.decided.own,
            kinds: own.nulls || own.decided.nullable === true ? [...kinds, "null"] : kinds,
            decider: ruled.decider,
            levels: levelsAt(path),
          });
          admission.rejections += 1;
          const key = keptKey(admission.work, c.result, joinSteps(["element"], path));
          admission.newlyRejected.set(joinedOperand(right), new Set([key]));
          rejected = true;
          break;
        }
      held.set(
        c.result,
        theirs === null || rejected ? ours : ours === null ? theirs : joined(ours, theirs),
      );
    }
    // (each error's fix, once the tree's errors are known)
    const shared = errors.every((each) => each.decider === errors[0]?.decider);
    for (const { decider, ...found } of errors) {
      const [left, right] = [found.c.arguments[0]!, found.c.arguments[1]!];
      error({
        ...found,
        named:
          errors.length === 1
            ? left === decider
              ? [left, right]
              : [right]
            : shared && left === decider
              ? [left]
              : [],
      });
    }
  }
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
