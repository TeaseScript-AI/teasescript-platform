// A literal's elements of one type (ADR 0021 1.3, A8).
import type { PlaceId, SourceSite } from "../../../graph.js";
import type { Admission } from "../../admission.js";
import {
  joinParts,
  keepText,
  keptParts,
  keptSlice,
  keptSplit,
  keptSteps,
  keptText,
  pathText,
} from "../../budget.js";
import { defaultOf, type IndexNode, typeTags } from "../../contract.js";
import {
  type Definition,
  keptPath,
  type Key,
  keyPlace,
  SELECTED_TEXT,
  SELECTED_VALUE,
  sortCost,
} from "../../definitions.js";
import { withoutEmpty } from "../../exact-path.js";
import { drive } from "../../inherited/inherited.js";
import { type Item, type ItemTag, MIXED_LEAF, REASON } from "../../items.js";
import { conversionCategory } from "../../method-categories.js";
import type { MixedSteps } from "../../result.js";
import { refText, type Touch, Touches, type TouchRef } from "../../touch.js";
import { hotSets } from "../groups.js";
import { heldMeetings } from "../held.js";
import { concrete, deciding, fits, NUMERIC } from "../kinds.js";
import { inheritance, landedBelow } from "../landings/inheritance.js";
import type { OwnStructure } from "../model.js";
import { ownOf } from "../own.js";
import { earliestDecider } from "../scan.js";
import {
  expectStructures,
  holdsSource,
  literalLanding,
  pathsBelow,
  sharedPaths,
} from "../structure.js";
import { touchCopy, touchesOf, touchOf, touchRead } from "../touches.js";
import {
  intermediateDepths,
  layersAt,
  mixedOptional,
  type MixedOptional,
  occurrenceNull,
  shownOf,
} from "./mixed-sentence.js";

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
 * ADR 0021 1.3, A8: a list's, set's or dict's literal elements (values), and the properties its objects share, have
 * one type at every path their known structure gives, a copy's or a call's its source's (F2): the earliest element's,
 * or a copy of a written binding's written type (A4), unless the literal lands directly in a written place, whose
 * type then checks them (A1). A definite element of another type is an error at the innermost offending expression
 * and is rejected: later uses see the earliest element's type (A6). `error` hears of each with the element's
 * store, the literal's cell, the path, the earliest element's kinds there (by family, and its own, which a sentence
 * names) and the offending element's (D1). `undecided`, after a stop before admission settled: a literal whose element
 * needs a decision admission did not make (a named element, or one the finishing read leaves `STOPPED`) is not
 * compared; it is reported there instead, so its store marks.
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
      readonly optional?: MixedOptional;
      readonly shown?: MixedSteps;
    },
  ) => void,
  undecided?: (cell: PlaceId) => void,
): void {
  const { program, definitions, contract } = admission.pass;
  const family = (tag: ItemTag): ItemTag => (NUMERIC.has(tag) ? "number" : tag);
  // a named element: one whose structure holds a source (a copy, a call, what a carrier takes of either)
  const named = (d: Definition): boolean =>
    d.value !== undefined && holdsSource(admission, d.value);
  // per landing and the distinct groups of a literal's elements' contracts (flow-insensitive: by source identity,
  // class or a typed ingress's type and default, `conflictGroups`), the paths below them where their contracts hold
  // more than one kind: only there can one element offend another (F2)
  const conflicts = new Map<string, readonly (readonly string[])[]>();
  // (per key, the paths where what the elements definitely hold meets, A2's)
  const atCopies = new Map<string, ReadonlySet<string>>();
  // (an element that may give a concrete kind: every one but a value proved to hold only `null`, which decides nothing,
  // ADR 0021 §1.3's `deciding`, and has no descendants: #1857)
  const contributes = (d: Definition): boolean => {
    const own = d.value === undefined ? [] : (program.hasOf.get(d.value) ?? []);
    return !(own.length === 1 && own[0]!.type.kind === "atom" && own[0]!.type.name === "null");
  };
  // (a literal of two elements or more that may give a concrete kind, landing in no written type: its elements are
  // compared; with one at most, no pair of them can be mixed, at its root or below it, #1857)
  const compared = (cell: PlaceId, list: readonly Definition[]): boolean => {
    const owner = program.cellOwner.get(cell);
    if (owner?.kind !== "cell") return false;
    let concrete = 0;
    for (const d of list) if (contributes(d) && ++concrete === 2) break;
    return concrete >= 2 && contract.landsIn(owner.owner, []) === null;
  };
  // (the compared elements' own structures, announced before any is asked, so a nest of them is listed inside first
  // whichever cell the order takes first: #1444)
  const elements = [...definitions.cellDefs].flatMap(([cell, list]) =>
    compared(cell, list) ? list.flatMap((d) => (d.value === undefined ? [] : [d.value])) : [],
  );
  expectStructures(admission, elements);
  cells: for (const [cell, list] of order([...definitions.cellDefs])) {
    const owner = program.cellOwner.get(cell);
    if (!compared(cell, list) || owner?.kind !== "cell") continue;
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
        // the copy meets the literal, A2)
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
        readonly d: Definition;
        // (#1765: its layers at this path, `layersAt`'s, once asked; #1762: its dict layers too)
        layers?: boolean[];
        dicts?: boolean[];
        sets?: boolean[];
      }
    >();
    // an element of one family offends where none of its kinds fits: a written type by the kinds themselves (a whole
    // number fits a written integer, a fraction does not), an earliest element's by their family; an element its written
    // type decides (`laterKinds`) offends where none of that type's kinds fits, as the earliest's decides it (#1906)
    const offends = (at: string, tags: readonly ItemTag[], written = false): boolean => {
      const decided = first.get(at)!;
      const families = [...new Set(tags.map(family))];
      return (
        (written ? families.length > 0 : families.length === 1) &&
        (decided.written ? tags : families).every(
          (tag) => !decided.tags.some((ref) => fits(tag, ref, decided.written)),
        )
      );
    };
    // the error at the innermost offending expression, the element rejected (A6)
    const offended = (
      d: Definition,
      path: readonly string[],
      decided?: readonly ItemTag[],
    ): void => {
      const at = pathText(path);
      const inner =
        path.length > 0
          ? admission.offendingAt(d, path, (items) =>
              offends(at, [...new Set(deciding(items).map((item) => item.tag))]),
            )
          : null;
      // (#1765: the layers between the element and the leaf that may hold null, each element's by its form
      // (`mayHoldNull`); the sentence's type alone, as the leaf's own null is, #1753)
      // (each element's layers by one walk down the error's path, each value at a path from the pass's memo of
      // `mayHoldNull`, Codex r6's B3, Astra r1's B2)
      // (the earliest element's walked once per path, whichever later element offends there: a wide earliest literal
      // is otherwise walked once per conflict, Codex r9's B1)
      const depths = intermediateDepths(path);
      const layers = (of: Definition): boolean[] =>
        layersAt(admission, of.value!, of.node, path, depths);
      const earliest = first.get(at)!;
      earliest.layers ??= layers(earliest.d);
      // (#1790: the later element's kinds its own, as on main, with the null it may hold at the leaf by #1765's rule, read
      // by the same walk one depth more: a value at its own level as it is read at its node (a narrowed copy holds none,
      // a typed host value may), a copy below its own level by its term, an `otherwise`'s fallback only where its
      // operand may be null. Codex r1–r4, Astra r1 on #1819; the null decides nothing, #1753)
      const later = layersAt(admission, d.value!, d.node, path, [...depths, path.length]);
      const optional = mixedOptional(earliest.layers, later.slice(0, -1));
      const own = decided ?? laterKinds(admission, d, path, admission.valueAt(d, path)).kinds;
      const kinds = later.at(-1)! ? [...own, "null" as const] : own;
      error(inner === null ? d.site : (program.place(inner.value!).site ?? d.site), {
        d,
        cell,
        path,
        decided: first.get(at)!.tags,
        earliest: first.get(at)!.own,
        kinds,
        atCopy: atCopy.has(at),
        ...(optional === undefined ? {} : { optional }),
        ...shownOf(
          path,
          (fact, steps, asked) =>
            (earliest[fact === "dict" ? "dicts" : "sets"] ??= layersAt(
              admission,
              earliest.d.value!,
              earliest.d.node,
              steps,
              asked,
              fact,
            )),
          (fact, steps, asked) => layersAt(admission, d.value!, d.node, steps, asked, fact),
        ),
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
          const decider =
            identity === null
              ? null
              : drive(admission, earliestDecider(admission, d.value, d.node, path, null));
          const copied = decider?.term ?? null;
          const kinds = [...new Set(own.map(family))];
          // (the kinds its error names: below the element, with any null the earliest may hold there, as its written
          // type is described; the null decides nothing, #1753)
          const below = path.length > 0;
          if (copied !== null) {
            const written = typeTags(copied);
            const tags = written.filter((tag) => tag !== "null");
            // (its leaf's null by the form rule's copy case, as the later element's (`mayHoldNull`): at the deciding
            // copy's own level as it is read, narrowed, below it by the copied term. #1901, Astra r1's B1 on #1908; from
            // the decider already asked, so no walk down the element, Codex r3)
            const leafNull =
              decider!.own === true
                ? occurrenceNull(admission, d.value, d.node, path)
                : written.includes("null");
            first.set(at, {
              tags,
              written: true,
              own: below && leafNull ? [...tags, "null"] : tags,
              d,
            });
          } else if (kinds.length === 1) {
            const nulls = below && items.some((item) => item.tag === "null");
            first.set(at, { tags: kinds, written: false, own: nulls ? [...own, "null"] : own, d });
          }
          continue;
        }
        const later = laterKinds(admission, d, path, items);
        if (!offends(at, later.kinds, later.written)) continue;
        offended(d, path, later.kinds);
        if (path.length > 0) found.push(path);
      }
      for (const path of known ?? []) offended(d, path);
    }
  }
}

/**
 * A later element's kinds at a path below it (`literalElements`): its value's definite kinds there; where it has none,
 * a named element whose value may hold a kind there (a join's elements, `pos`) or holds what the script cannot know
 * (a typed host value, `unknown`) is a copy of what decides it, as the earliest element is (A4): its decider's written
 * type, without `null`, which decides nothing (#1753, #1906), `written`. A value proved to hold only `null` there, and
 * an `unknown` a stop left (`REASON.budget`), keep their own kinds, none.
 */
function laterKinds(
  admission: Admission,
  d: Definition,
  path: readonly string[],
  items: readonly Item[],
): { readonly kinds: readonly ItemTag[]; readonly written: boolean } {
  const own = [...new Set(deciding(items).map((item) => item.tag))];
  if (
    own.length > 0 ||
    !holdsSource(admission, d.value!) ||
    !items.some(
      (item) => concrete(item) || (item.tag === "unknown" && (item.reasons & REASON.budget) === 0),
    )
  )
    return { kinds: own, written: false };
  const decider = drive(admission, earliestDecider(admission, d.value!, d.node, path, null));
  return decider?.term == null
    ? { kinds: own, written: false }
    : { kinds: typeTags(decider.term).filter((tag) => tag !== "null"), written: true };
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
 * share one discovery, while each keeps its own identity and its boundary check (C9, §8), and a default reading
 * host data counts by the contract's class of its global and guards (`classOf`, #1196); a read, a literal or an
 * `otherwise` whose class is mixed by its leaves alone that class (`Contract.boundClass`: k reads of one global,
 * #1207, k `load(…) otherwise {…}` of one default and one fallback or objects holding them, #1304, k bindings of loads
 * of one default, #1313, each share one discovery); any other value its contract-side class (`Contract.classOf`, so k
 * method results or conversions beside an object are not each asked at each of its properties, #1078), or without
 * one its source identity. Values of one class have the same kinds at every path.
 */
function conflictClass(admission: Admission, value: PlaceId): string {
  const { program, contract } = admission.pass;
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
  return joinParts(
    "f18",
    by,
    term,
    fallback === undefined
      ? ""
      : joinParts("snapshot", contract.classOf(fallback, true) ?? `site${fallback}`),
  );
}
