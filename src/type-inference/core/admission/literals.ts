import type { PlaceId, SourceSite } from "../../graph.js";
import { operandsOf, type Strip } from "../carriers.js";
import type { Admission } from "../admission.js";
import type { MixedSteps } from "../result.js";
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
  stepText,
} from "../budget.js";
import { keyStepsIn, stepsArray, type Steps } from "../contract/key-ids.js";
import { defaultOf, typeTags, type IndexNode } from "../contract.js";
import {
  joinedOperand,
  keptKey,
  keptPath,
  keyOf,
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
import { drive } from "../inherited/inherited.js";
import { admitsNumber, concrete, deciding, fits, NUMERIC } from "./kinds.js";
import { inheritance, landedBelow } from "./landings.js";
import type { Join, JoinDecided, OwnStructure } from "./model.js";
import { ownOf } from "./own.js";
import { joinedDomain, permittedAt, unrestricted } from "./permitted.js";
import { earliestDecider } from "./scan.js";
import {
  expectStructures,
  holdsSource,
  literalLanding,
  pathsBelow,
  sharedPaths,
  sourceOf,
} from "./structure.js";
import { touchCopy, touchesOf, touchOf, touchRead } from "./touches.js";
import { writtenSource } from "./walk.js";

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

/** The carriers a value is read through to what it selects: a projection's owner, an `otherwise`'s sides. */
const RESOLVED: ReadonlySet<string> = new Set([
  "projection/owner",
  "projection/record field",
  "otherwise/operand",
  "otherwise/fallback",
]);

/** One side's walk down a mixed error's path for a collection fact (`layersAt`'s), at the asked depths. */
type CollectionWalk = (
  fact: "dict" | "set",
  path: readonly string[],
  depths: readonly number[],
) => boolean[];

/**
 * #1762, #1825: a mixed error's path as one side's sentence reads it: each `element` step below a dict its `entry` and
 * below a set its `member`, where that side's value there is one (`walk`, one walk down the path per collection);
 * admission's own path, which rejects and checks, unchanged. `member` is a sentence's word alone: no path, check or
 * key holds it.
 */
function shownSteps(path: readonly string[], walk: CollectionWalk): readonly string[] {
  const asked: number[] = [];
  for (let at = 0; at < path.length; at += 1) if (path[at] === "element") asked.push(at);
  const dicts = walk("dict", path, asked);
  const sets = walk("set", path, asked);
  let next = 0;
  return path.map((step) => {
    if (step !== "element") return step;
    const at = next++;
    return dicts[at] === true ? "entry" : sets[at] === true ? "member" : step;
  });
}

/**
 * #1762, #1825: each side's steps as its sentence writes them (`MixedSteps`), the earliest element's and the other's,
 * each by its own values: a list, a set and a dict may meet at one path (Codex r1 on #1814); none where both are the
 * path.
 */
function shownOf(
  path: readonly string[],
  earliest: CollectionWalk,
  other: CollectionWalk,
): { readonly shown?: MixedSteps } {
  const type = shownSteps(path, earliest);
  const kinds = shownSteps(path, other);
  return type.every((step, at) => step === path[at]) && kinds.every((step, at) => step === path[at])
    ? {}
    : { shown: { type, kinds } };
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
  at: Steps,
  leaf: (items: readonly Item[]) => boolean,
): Definition | null {
  const pending: [PlaceId, FlowNode, number][] = [[d.value!, d.node, 0]];
  while (pending.length > 0) {
    const [value, node, index] = pending.pop()!;
    const children = admission.literalChildren(value, at.at(index)!);
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
  at: Steps,
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
        readonly d: Definition;
        // (#1765: its layers at this path, `layersAt`'s, once asked; #1762: its dict layers too)
        layers?: boolean[];
        dicts?: boolean[];
        sets?: boolean[];
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
      const own = [...new Set(deciding(admission.valueAt(d, path)).map((item) => item.tag))];
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
 * with the kinds of every operand the join holds; each operand's domain by `joinedDomain` (an open one leaves the join
 * open, one holding only `null` decides nothing but at a strict written destination). A right operand whose elements there are of one other family, none
 * of whose kinds fits, is an error at its join, unless the written type the tree lands in directly holds both (A1), and
 * is rejected from that join (A6): the join then holds its left operand's elements alone. A right operand is compared
 * at the paths of its own structure, a join's at its list levels as a variable holding it is (`pathsBelow`); a join's
 * paths are its operands', the smaller one's added to the larger one's, so a chain of k joins, on either side, costs
 * its operands' structures once. `error` hears of each with the join, the path, the decided kinds there and the
 * operand's, the tree's value, whose declaration a fix may give the type (#1268), and the type it writes: `levels`, what
 * the tree's elements hold at each list level down to the path, its `null`s and numbers kept. `undecided`, before
 * admission settled (`Consumers.#freshStores`): a join an operand of which is read through a decision.
 */
export function joinElements(
  admission: Admission,
  order: <T>(list: readonly T[]) => T[],
  error: (found: {
    readonly c: Join;
    readonly path: readonly string[];
    readonly earliest: readonly ItemTag[];
    readonly kinds: readonly ItemTag[];
    readonly value: PlaceId;
    readonly levels: readonly (readonly ItemTag[])[] | null;
    readonly optional?: MixedOptional;
    readonly shown?: MixedSteps;
  }) => void,
  undecided?: (value: PlaceId) => void,
): void {
  const { program, contract, definitions } = admission.pass;
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
  const byResult = new Map<PlaceId, Join>();
  for (const root of roots) byResult.set(root.result, root);
  // a tree's operands in source order, each with the node it is read at (a `+=`'s its statement's): what the type a fix
  // writes holds (`levelsAt`); and its joins, each before the joins it holds; once per tree
  const shapes = new Map<
    PlaceId,
    {
      readonly operands: readonly { readonly operand: PlaceId; readonly node: FlowNode }[];
      readonly tree: readonly Join[];
    }
  >();
  const shapeOf = (root: Join) => {
    const known = shapes.get(root.result);
    if (known !== undefined) return known;
    const operands: { readonly operand: PlaceId; readonly node: FlowNode }[] = [];
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
    const shape = { operands, tree };
    shapes.set(root.result, shape);
    return shape;
  };
  // each value's element type per path, as a variable holding it is decided (`scanAt`): an operand's own at the paths of
  // its structure, a join's its operands' in evaluation order (its paths the earliest decider of each, the kinds of every
  // operand it holds there), the earliest operand deciding the element asked at any other path (its type may give it);
  // read once per operand, never by reading a join's tree again (Astra's B1, Codex r7's B1 and B3 on #1310). An operand
  // open at a path (`list`, V30 §13: any list) leaves the join open there and below, whichever operand came first: no
  // conflict is proved from it (Astra r2's B1a on #1310)
  interface Decider {
    readonly decided: JoinDecided | "open";
    readonly position: number;
  }
  interface Entry {
    readonly path: readonly string[];
    first: Decider | null;
    readonly kinds: Set<ItemTag>;
  }
  interface Held {
    readonly entries: Map<string, Entry>;
    /** The paths an operand leaves open: open there and below. */
    readonly opens: Set<string>;
    /** Its list levels: where a variable holding it is compared (`pathsBelow`). */
    readonly levels: Set<string>;
    head: { readonly operand: PlaceId; readonly node: FlowNode; readonly position: number } | null;
  }
  // (what an operand's value is, through the projections the join rule resolves (`carriersOf`, a literal's cells at the
  // step read): a projection's owner, an `otherwise`'s sides; each part an earlier tree's join, whose composed type
  // stands for it, or a value taken for its own type; `null` where no part is a join, or a step is read into a value
  // that is no literal and carries nothing. The join check never derives again a type the join rule already composed:
  // a join answers the same inline as kept (the lead's rule on #1310))
  type Part = { readonly join: PlaceId } | { readonly leaf: PlaceId };
  const reaches = new Map<PlaceId, readonly Part[] | null>();
  const reachOf = (operand: PlaceId): readonly Part[] | null => {
    const known = reaches.get(operand);
    if (known !== undefined) return known;
    const parts: Part[] = [];
    let joined = false;
    let resolved = true;
    const pending: (readonly [PlaceId, readonly string[]])[] = [[operand, []]];
    while (resolved && pending.length > 0) {
      const [at, strip] = pending.pop()!;
      program.work.charge("checks");
      if (joins.has(at)) {
        resolved = strip.length === 0 && byResult.has(at);
        parts.push({ join: at });
        joined = true;
        continue;
      }
      const literal = program.hasOf.has(at);
      if (writtenSource(admission, at, strip) === null && literal && strip.length > 0) {
        const children = literalChildren(admission, at, strip[0]!);
        resolved = children.length > 0;
        const rest = keptSlice(admission.work, strip, 1);
        for (let index = children.length - 1; index >= 0; index -= 1)
          pending.push([children[index]!.value!, rest]);
        continue;
      }
      const carried =
        literal || sourceOf(admission, at) !== null || writtenSource(admission, at, strip) !== null
          ? []
          : admission.carriersOf(at, strip);
      if (carried.length > 0 && carried.every(([, , role]) => RESOLVED.has(role))) {
        for (let index = carried.length - 1; index >= 0; index -= 1)
          pending.push([carried[index]![0], carried[index]![1]]);
        continue;
      }
      resolved = strip.length === 0;
      parts.push({ leaf: at });
    }
    const out = resolved && joined ? parts : null;
    reaches.set(operand, out);
    return out;
  };
  // (each tree composed once, a tree an operand reaches before the tree reading it, and reported in the order given)
  const composed = new Map<PlaceId, { readonly held: Held | null; readonly report: () => void }>();
  // (the trees whose composed type an operand took: each is reached once, by the operand holding it)
  const taken = new Set<PlaceId>();
  const compose = (root: Join): { readonly held: Held | null; readonly report: () => void } => {
    const { operands, tree } = shapeOf(root);
    const reports: (() => void)[] = [];
    const done = (final: Held | null) => ({
      held: final,
      report: () => {
        for (const each of reports) each();
      },
    });
    if (operands.length < 2) return done(null);
    // (before admission settled, a decision is read nowhere: a join with an operand that reads a place or holds a
    // source, a copy or a call, is marked instead, as a literal with a named element is)
    if (
      undecided !== undefined &&
      operands.some(
        ({ operand }) =>
          contract.copiedKey(operand) !== null ||
          contract.resultKey(operand) !== null ||
          holdsSource(admission, operand),
      )
    ) {
      reports.push(() => undecided(root.result));
      return done(null);
    }
    const written = contract.landsIn(root.result, []);
    // (a `+=`'s left operand reads the place its store sets, a selection there an own property where the store's
    // target keeps it, #1275)
    const target = (definitions.byValue.get(root.result) ?? []).find(
      (d) => d.kind === "whole" && d.how === "compound",
    );
    const stored = (operand: PlaceId): boolean =>
      target !== undefined && operand === root.arguments[0];
    const isList = (operand: PlaceId, node: FlowNode): boolean =>
      stored(operand)
        ? admission.admitted(target!.place, target!.path).includes("list")
        : admission.items(operand, node, []).some((item) => item.tag === "list");
    // the place an operand reads, whose admitted type is its type: a variable's or a property's, a call's result
    // (F20: a written result's type decides, Codex r5 on #1310), a `+=`'s target
    const placeOf = (
      operand: PlaceId,
    ): { readonly place: PlaceId; readonly path: readonly string[] } | null => {
      if (stored(operand)) return target!;
      const key = contract.copiedKey(operand) ?? contract.resultKey(operand);
      // (a cursor's steps through the charged boundary, G3 stage 1)
      // (a tree's target keeps an array: a cursor's steps copied out, `stepsArray`)
      return key === null
        ? null
        : { place: keyPlace(key), path: stepsArray(keyStepsIn(contract, key)) };
    };
    // (the left operand that reads the place the tree is stored into, a `+=`'s or `xs = xs + …`'s: a strict written
    // destination, whose type holds only what it holds)
    const destination = (operand: PlaceId): boolean => {
      if (operand !== root.arguments[0]) return false;
      if (stored(operand)) return true;
      const read = placeOf(operand);
      return (
        read !== null &&
        (definitions.byValue.get(root.result) ?? []).some(
          (d) =>
            d.kind === "whole" &&
            d.place === read.place &&
            pathText(d.path) === pathText(read.path),
        )
      );
    };
    // what an operand's elements are at a path, by `joinedDomain`: a written copy's type, a read's place's decision,
    // the earliest deciding value's kinds, else its own kinds of one family and no unknown (a type holding only `null`
    // decides nothing, its `null` the sentence's walk's, never an empty domain no kind fits, but at a strict written
    // destination: Astra r2's B1b on #1310)
    const decidedAt = (
      operand: PlaceId,
      node: FlowNode,
      path: readonly string[],
    ): JoinDecided | "open" | null => {
      const at = joinSteps(["element"], path);
      const decider = joinDecider(admission, operand, node, at);
      if (decider !== null && decider.term !== null) {
        const domain = joinedDomain(typeTags(decider.term));
        if (domain === "open") return "open";
        if (domain === "null" && !destination(operand)) return null;
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
        const domain = joinedDomain(place.tags);
        if (domain === "open") return "open";
        if (domain === "null" && !(place.byWritten && destination(operand))) return null;
        const tags = place.tags.filter((tag) => tag !== "null");
        return {
          tags,
          written: place.byWritten,
          typed: place.byWritten,
          own: tags,
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
    // (an operand's place in evaluation order: where its source starts, so an earlier tree's composed type keeps its
    // own operands' places inside the operand that reaches it, before every operand after it and after every one before)
    const startOf = (value: PlaceId): number => program.places[value]?.site?.start ?? 0;
    const positions = new Map<PlaceId, { readonly node: FlowNode; readonly position: number }>();
    for (const { operand, node } of operands)
      positions.set(operand, { node, position: startOf(operand) });
    const leaf = (operand: PlaceId, node: FlowNode, position: number): Held | null => {
      if (!isList(operand, node)) return null;
      const held: Held = { entries: new Map(), opens: new Set(), levels: new Set(), head: null };
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
          first: ruled === null ? null : { decided: ruled, position },
          kinds: new Set(ruled === null || ruled === "open" ? [] : ruled.own),
        });
        if (ruled === "open") held.opens.add(at);
        if (path.every((step) => step === "element")) held.levels.add(at);
        if (path.length === 0 && ruled !== null) held.head = { operand, node, position };
      }
      // (a type open at a list level below its value's levels, `list[]` holding no element yet, leaves the join open
      // there too: each further level asked once while the one above holds lists)
      let level: readonly string[] = [];
      let above = held.entries.get("")?.first?.decided ?? null;
      while (above !== null && above !== "open" && above.tags.includes("list")) {
        program.work.charge("checks");
        level = keptSteps(admission.work, level, ["element"]);
        const at = keptText(admission.work, level);
        const entry = held.entries.get(at);
        above =
          entry !== undefined ? (entry.first?.decided ?? null) : decidedAt(operand, node, level);
        if (entry === undefined && above === "open") held.opens.add(at);
      }
      return held;
    };
    // (a head's decisions at paths its structure does not give, each asked once)
    const asked = new Map<
      PlaceId,
      Map<string, { readonly decided: JoinDecided | "open" } | null>
    >();
    const decisionOf = (
      held: Held,
      path: readonly string[],
      at: string,
    ): { readonly decided: JoinDecided | "open" } | null => {
      // (open at the path or above it: each prefix's text one step longer than the last)
      if (held.opens.size > 0)
        for (let depth = 0, text = ""; depth <= path.length; depth += 1) {
          program.work.charge("checks");
          if (depth > 0) text = depth === 1 ? path[0]! : stepText(text, path[depth - 1]!);
          keepText(admission.work, text.length);
          if (held.opens.has(text)) return { decided: "open" };
        }
      const entry = held.entries.get(at);
      let first = entry?.first ?? null;
      let kinds: ReadonlySet<ItemTag> = entry?.kinds ?? new Set();
      const head = held.head;
      if (head !== null && (first === null || head.position < first.position)) {
        let mine = asked.get(head.operand);
        if (mine === undefined) asked.set(head.operand, (mine = new Map()));
        let found = mine.get(at);
        if (found === undefined) {
          const ruled = decidedAt(head.operand, head.node, path);
          found = ruled === null ? null : { decided: ruled };
          mine.set(at, found);
        }
        if (found !== null) {
          const { decided: ruled } = found;
          first = { decided: ruled, position: head.position };
          if (ruled !== "open") kinds = new Set([...kinds, ...ruled.own]);
        }
      }
      if (first === null) return null;
      const { decided: ruled } = first;
      if (ruled === "open" || ruled.typed || [...kinds].every((kind) => ruled.own.includes(kind)))
        return { decided: ruled };
      // (a value's kinds, as `decidedAt` reads them: whole numbers beside numbers are numbers, ADR 0021 1.3; several
      // families each fit as itself)
      const own = kinds.has("number") ? [...new Set([...kinds].map(family))] : [...kinds];
      return {
        decided: { tags: own, written: new Set(own.map(family)).size > 1, typed: false, own },
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
      }
      for (const at of from.opens) into.opens.add(at);
      for (const at of from.levels) into.levels.add(at);
      if (from.head !== null && (into.head === null || from.head.position < into.head.position))
        into.head = from.head;
      return into;
    };
    // (an earlier join's composed type for an operand that reaches it, taken whole: a join's result is reached by one
    // operand only, and its own operands' places stand inside that operand's; compared at its list levels, as a join is
    // (its paths are the earlier tree's, which grow with a chain: Codex r7's B3, #1383))
    const reaching = new Set<PlaceId>();
    // (an operand's parts in evaluation order, the earlier part `first`: the earliest deciding at a path decides alone, as
    // `decidedAt`'s earliest decider does, a later part adding only the numbers that make whole numbers numbers, and
    // deciding where no earlier part does. The larger part's map is the result, by reference, and only the
    // smaller part's entries, opens and levels are visited, whichever of the two it is, so a growing earlier join is never
    // walked again whatever position it stands in (Codex r15's and r16's B1 on #1310: the lead's rule))
    const parted = (first: Held, later: Held): Held => {
      const numbers = (into: Entry, from: Entry): void => {
        if (into.kinds.has("integer"))
          for (const kind of from.kinds) if (NUMERIC.has(kind)) into.kinds.add(kind);
      };
      if (first.entries.size >= later.entries.size) {
        // (a later part leaves its paths open where the earlier part decides nothing: asked before its entries join)
        for (const at of later.opens) {
          program.work.charge("partVisits");
          if ((first.entries.get(at)?.first ?? null) === null) first.opens.add(at);
        }
        for (const [at, entry] of later.entries) {
          program.work.charge("partVisits");
          const known = first.entries.get(at);
          if (known !== undefined && known.first !== null) {
            numbers(known, entry);
            continue;
          }
          first.entries.set(at, entry);
        }
        for (const at of later.levels) first.levels.add(at);
        first.head ??= later.head;
        return first;
      }
      for (const [at, entry] of first.entries) {
        program.work.charge("partVisits");
        const known = later.entries.get(at);
        if (entry.first === null) {
          if (known === undefined) later.entries.set(at, entry);
          continue;
        }
        if (known !== undefined) numbers(entry, known);
        later.entries.set(at, entry);
        later.opens.delete(at);
      }
      for (const at of first.opens) later.opens.add(at);
      for (const at of first.levels) later.levels.add(at);
      later.head = first.head ?? later.head;
      return later;
    };
    const reached = (operand: PlaceId): Held | null | undefined => {
      const parts = reachOf(operand);
      if (
        parts === null ||
        parts.some(
          (part) =>
            "join" in part &&
            ((composed.get(part.join)?.held ?? null) === null || taken.has(part.join)),
        )
      )
        return undefined;
      const { node } = positions.get(operand)!;
      let out: Held | null = null;
      for (const part of parts) {
        let one: Held | null;
        if ("join" in part) {
          taken.add(part.join);
          one = composed.get(part.join)!.held;
        } else one = leaf(part.leaf, node, startOf(part.leaf));
        out = out === null ? one : one === null ? out : parted(out, one);
      }
      reaching.add(operand);
      return out;
    };
    // each join after the joins it holds, its operands' values taken once
    const held = new Map<PlaceId, Held | null>();
    const take = (value: PlaceId): Held | null => {
      if (!joins.has(value)) {
        const found = reached(value);
        if (found !== undefined) return found;
        const { node, position } = positions.get(value)!;
        return leaf(value, node, position);
      }
      const found = held.get(value) ?? null;
      held.delete(value);
      return found;
    };
    for (const c of tree.toReversed()) {
      const [left, right] = [c.arguments[0]!, c.arguments[1]!];
      const ours = take(left);
      const theirs = take(right);
      let rejected = !admission.pass.lists.joined(right);
      if (ours !== null && theirs !== null)
        for (const at of joins.has(right) || reaching.has(right)
          ? theirs.levels
          : theirs.entries.keys()) {
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
          // (#1765: the layers between the element and the leaf that may hold null, each side's by its form, as a
          // literal's elements are: each operand walked down below its elements, Codex r5's B2; #1790/#1828: and its
          // leaf by the same walk one depth more, the sentence's null as this occurrence holds it, not as the decided
          // domain allows it: `n: integer? = 1` joined names no null, a copied `integer?[]` its written leaf)
          const joinNode = program.exprAt(c.site) ?? program.flow.statementAt(c.site) ?? null;
          const below = joinSteps(["element"], path);
          const depths = [...intermediateDepths(path).map((depth) => depth + 1), below.length];
          const layers = (side: PlaceId): boolean[] =>
            joinNode === null
              ? depths.map(() => false)
              : layersAt(admission, side, joinNode, below, depths);
          // (an operand whose occurrence says nothing at the leaf, as a compound assignment's target read through a
          // property, names its place's admitted null there, as the sentence did before: the walk has nothing to read)
          const leafOf = (side: PlaceId, walked: boolean[]): boolean[] => {
            if (walked.at(-1)! || joinNode === null) return walked;
            const read = placeOf(side);
            if (
              read === null ||
              !admission.items(side, joinNode, below).every((item) => item.tag === "unknown") ||
              !admission.admitted(read.place, joinSteps(read.path, below)).includes("null")
            )
              return walked;
            return [...walked.slice(0, -1), true];
          };
          const [leftLayers, rightLayers] = [
            leafOf(left, layers(left)),
            leafOf(right, layers(right)),
          ];
          const optional = mixedOptional(leftLayers.slice(0, -1), rightLayers.slice(0, -1));
          // (#1762, #1825: each operand's layers are a dict's or a set's by the same walk below its elements, its
          // contract's items, Astra r1 on #1814)
          const collections =
            (side: PlaceId): CollectionWalk =>
            (fact, walked, asked) =>
              joinNode === null
                ? asked.map(() => false)
                : layersAt(
                    admission,
                    side,
                    joinNode,
                    keptSteps(admission.work, ["element"], walked),
                    asked.map((depth) => depth + 1),
                    fact,
                  );
          const found: Parameters<typeof error>[0] = {
            ...(optional === undefined ? {} : { optional }),
            c,
            path,
            ...shownOf(path, collections(left), collections(right)),
            earliest: leftLayers.at(-1)! ? [...ruled.decided.own, "null"] : ruled.decided.own,
            kinds: rightLayers.at(-1)! ? [...kinds, "null"] : kinds,
            value: root.result,
            levels: levelsAt(path),
          };
          const key = keptKey(admission.work, c.result, joinSteps(["element"], path));
          reports.push(() => {
            error(found);
            admission.rejections += 1;
            admission.newlyRejected.set(joinedOperand(right), new Set([key]));
          });
          rejected = true;
          break;
        }
      held.set(
        c.result,
        theirs === null || rejected ? ours : ours === null ? theirs : joined(ours, theirs),
      );
    }
    return done(held.get(root.result) ?? null);
  };
  // (a tree after the earlier trees its operands reach: each asked before the tree reading it, without recursion)
  const ensure = (first: Join): void => {
    const stack: { readonly root: Join; ready: boolean }[] = [{ root: first, ready: false }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      program.work.charge("checks");
      if (composed.has(top.root.result)) stack.pop();
      else if (top.ready) {
        stack.pop();
        composed.set(top.root.result, compose(top.root));
      } else {
        top.ready = true;
        for (const { operand } of shapeOf(top.root).operands)
          for (const part of reachOf(operand) ?? [])
            if ("join" in part && !composed.has(part.join))
              stack.push({ root: byResult.get(part.join)!, ready: false });
      }
    }
  };
  for (const root of order(roots)) {
    ensure(root);
    composed.get(root.result)!.report();
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

/**
 * #1765: whether each layer of a mixed element between the element and its leaf may hold null, the earliest element's
 * (`type`) and the other's (`kinds`), for the sentence's written type; `undefined` where none may.
 */
export interface MixedOptional {
  readonly type: readonly boolean[];
  readonly kinds: readonly boolean[];
}

/** The written decider's answer for a value at a node and path outside every decision (`earliestDecider`'s). */
type JoinDecider =
  ReturnType<typeof earliestDecider> extends Generator<unknown, infer R> ? R : never;
// (per admission, while no stop forgot an answer: per node, value and path)
const JOIN_DECIDERS = new WeakMap<
  Admission,
  {
    readonly forgets: number;
    readonly byNode: Map<FlowNode, Map<PlaceId, Map<string, JoinDecider>>>;
  }
>();

/**
 * #1828: `earliestDecider` of `value` at `node` and `steps` outside every decision, asked once while no stop forgot an
 * answer. A mixed join's operand is asked it by `decidedAt` and again by its sentence's walk (`mayHoldNull`); the
 * second ask takes the first's answer (Codex r2 on #1899).
 */
function joinDecider(
  admission: Admission,
  value: PlaceId,
  node: FlowNode,
  steps: readonly string[],
): JoinDecider {
  const forgets = admission.pass.solver.forgets;
  let known = JOIN_DECIDERS.get(admission);
  if (known === undefined || known.forgets !== forgets)
    JOIN_DECIDERS.set(admission, (known = { forgets, byNode: new Map() }));
  let byValue = known.byNode.get(node);
  if (byValue === undefined) known.byNode.set(node, (byValue = new Map()));
  let byPath = byValue.get(value);
  if (byPath === undefined) byValue.set(value, (byPath = new Map()));
  const at = pathText(steps);
  if (byPath.has(at)) return byPath.get(at)!;
  const answer = drive(admission, earliestDecider(admission, value, node, steps, null));
  // (its key kept, charged as a structure's)
  keepText(admission.work, at.length);
  byPath.set(at, answer);
  return answer;
}

/**
 * #1765: whether a value may hold null at a layer, by its own form, one case per form, never by what a written copy's
 * items hold (the lead's ruling (A) on #1789, after Codex r1–r11 and Astra r1–r2):
 * 1. at its own level (no step left), as it is read at its node (`occurrenceNull`); an `otherwise` by its tree, each leaf
 *    so read: its fallback's null where its operand may be null (`1 otherwise null` holds none: its fallback never runs;
 *    `null otherwise m` none where `m` holds `[1]`, Astra r2's B2);
 * 2. a literal, by its children at the layer's next step, each by this same rule below;
 * 3. a carried value (the carrier table's: a projection's owner, an `otherwise`'s sides, a `get`'s receiver and default,
 *    a method's receiver, a dict's values, a `+` join's admitted operands), by each value it carries, at the path into
 *    it; an `otherwise`'s fallback only where its operand may be null;
 * 4. a written copy, by its term alone, whatever a rejected store put there, where it decides the layer from above (its
 *    parent layer's term is its too); a layer that is a copy's own level, as it is read there;
 * 5. another read or a call's result, by its place's admitted type where admission decides it;
 * 6. any other value (an undecided place's read, an operation's own result), by its own items.
 * Cases 2 and 3 compose: `layersOf` follows them, every layer of a path in one descent. This function answers the
 * others, a value at its own level or one neither a literal nor a carrier holds. An `otherwise`'s operand may be null as
 * `operandNull` reads it. A join has no case of its own: the carrier table gives only its admitted operands (`joined`),
 * so a rejected operand brings nothing (ADR 0021 1.1, Astra r1's B1; Codex r9).
 */
function mayHoldNull(
  admission: Admission,
  at: PlaceId,
  from: FlowNode,
  steps: readonly string[],
): boolean {
  const { program, contract } = admission.pass;
  admission.work.charge("checks");
  if (steps.length === 0)
    // (an `otherwise`'s own null is its narrowed tree's; the operand's null is what the fallback replaces. Codex r3 on
    // #1819, Astra r2's B2 on #1789)
    return program.opOf.get(at)?.kind === "fallback"
      ? operandNull(admission, at, from)
      : occurrenceNull(admission, at, from);
  const decided = holdsSource(admission, at) ? joinDecider(admission, at, from, steps) : null;
  // (a copy's term where the deciding copy stands above the layer, which lies below its own level: `b: string?[]` in
  // `[[1],b]`, `d`'s element in `held = d + [2]`; where the layer is the deciding copy's own level, `atom` in
  // `{v:atom}`, as it is read there, narrowed: Codex r1 on #1819, #1901)
  if (decided !== null && decided.term !== null)
    return decided.own === true
      ? occurrenceNull(admission, at, from, steps)
      : typeTags(decided.term).includes("null");
  const key = contract.copiedKey(at) ?? contract.resultKey(at);
  if (key !== null) {
    const path = joinSteps(stepsArray(keyStepsIn(contract, key)), steps);
    const admitted = admission.admitted(keyPlace(key), path);
    // (no kind, or an unknown, decides nothing: `null` alone settles no type, Codex r5's B3)
    if (admitted.length > 0 && !admitted.includes("unknown")) return admitted.includes("null");
  }
  return withoutEmpty(admission.run(contract.contractOfValueAt(at, steps))).some(
    (item) => item.tag === "null",
  );
}

/**
 * #1765: whether a value may be null as it is read at its node (at `steps` below it): its type allows null (its contract's items, which a
 * rejected store does not reach) and its items there, narrowed, hold null or an unknown no test guards (a typed host
 * value, Astra r1's B1 on #1819; under `!= null` its unknown is guarded). A written copy narrowed by its assignment or a
 * test holds none, as the current checker reads it.
 */
function occurrenceNull(
  admission: Admission,
  at: PlaceId,
  from: FlowNode,
  steps: readonly string[] = [],
): boolean {
  return (
    withoutEmpty(admission.run(admission.pass.contract.contractOfValueAt(at, steps))).some(
      (item) => item.tag === "null",
    ) &&
    admission
      .items(at, from, steps)
      .some((item) => item.tag === "null" || (item.tag === "unknown" && item.guarded !== true))
  );
}

/**
 * #1765: whether an `otherwise`'s operand may be null at its node: its items there, narrowed as it is read (a written copy
 * narrowed by its assignment or a test never runs its fallback, as the current checker reads it); an operand that is
 * itself an `otherwise`, only where its operand and its fallback both may be (Codex r10's B1). Each node's answer once per
 * pass and node (`NARROWED`), an `otherwise` after its operand and fallback, so a chain is walked once (Codex r11's B2).
 */
function operandNull(admission: Admission, operand: PlaceId, from: FlowNode): boolean {
  const { program } = admission.pass;
  let byNode = NARROWED.get(admission.pass);
  if (byNode === undefined) NARROWED.set(admission.pass, (byNode = new Map()));
  let known = byNode.get(from);
  if (known === undefined) byNode.set(from, (known = new Map()));
  const open = [operand];
  while (open.length > 0) {
    const at = open.at(-1)!;
    if (known.has(at)) {
      open.pop();
      continue;
    }
    admission.work.charge("checks");
    const op = program.opOf.get(at);
    if (op?.kind !== "fallback") {
      known.set(at, occurrenceNull(admission, at, from));
      open.pop();
      continue;
    }
    const left = known.get(op.left);
    const right = known.get(op.right);
    if (left === false || right === false || (left === true && right === true)) {
      known.set(at, left === true && right === true);
      open.pop();
    } else open.push(left === undefined ? op.left : op.right);
  }
  return known.get(operand)!;
}

/** Per pass and node, whether an `otherwise`'s operand may be null there (`mayHoldNull`'s `operandNull`). */
const NARROWED = new WeakMap<object, Map<FlowNode, Map<PlaceId, boolean>>>();

/**
 * #1762, #1825: whether a value is a dict (or a set) there, by its contract's items, which compose its written and
 * carried terms: `a otherwise dict {}`, `a` a written dict holding a host value, is a dict, where its stored values
 * (`valueAt`) lose it (Astra r1 on #1814).
 */
function collectionHeld(
  admission: Admission,
  at: PlaceId,
  steps: readonly string[],
  tag: "dict" | "set",
): boolean {
  return withoutEmpty(admission.run(admission.pass.contract.contractOfValueAt(at, steps))).some(
    (item) => item.tag === tag,
  );
}

/**
 * #1762, #1825: whether a value is a dict (or a set) at its own level: an `otherwise` its operand where the operand,
 * narrowed at its node, may hold a value, and its fallback where the operand may be null (a fallback never run names no
 * dict, nor an operand proved null, Codex r5–r6 on #1814); any other value by its items (`collectionHeld`) or its own
 * reads (a default). Each node's answer once per pass, collection and node (`COLLECTION_OWN`), a value after the sides
 * it takes, so a chain is walked once.
 */
function collectionOwn(
  admission: Admission,
  value: PlaceId,
  from: FlowNode,
  tag: "dict" | "set",
): boolean {
  const { program } = admission.pass;
  const memo = COLLECTION_OWN[tag];
  let byNode = memo.get(admission.pass);
  if (byNode === undefined) memo.set(admission.pass, (byNode = new Map()));
  let known = byNode.get(from);
  if (known === undefined) byNode.set(from, (known = new Map()));
  const open = [value];
  while (open.length > 0) {
    const at = open.at(-1)!;
    if (known.has(at)) {
      open.pop();
      continue;
    }
    admission.work.charge("checks");
    const op = program.opOf.get(at);
    // (any other value a dict by its items, or where an operand that is its own read is: a `get`'s, a `load`'s or a
    // parse's default, which hands the value on whole; its items lose a host-assigned written dict, Codex r8 on #1814)
    const sides =
      op?.kind === "fallback"
        ? [
            ...(admission.items(op.left, from, []).some((item) => item.tag !== "null")
              ? [op.left]
              : []),
            ...(operandNull(admission, op.left, from) ? [op.right] : []),
          ]
        : collectionHeld(admission, at, [], tag)
          ? null
          : operandsOf(program, at)
              .filter((operand) => operand.own)
              .map((operand) => operand.operand);
    if (sides === null) {
      known.set(at, true);
      open.pop();
      continue;
    }
    const missing = sides.find((side) => !known.has(side));
    if (missing !== undefined) open.push(missing);
    else {
      known.set(
        at,
        sides.some((side) => known.get(side) === true),
      );
      open.pop();
    }
  }
  return known.get(value)!;
}

/** Per collection, pass and node, whether a value is one at its own level (`collectionOwn`). */
const COLLECTION_OWN = {
  dict: new WeakMap<object, Map<FlowNode, Map<PlaceId, boolean>>>(),
  set: new WeakMap<object, Map<FlowNode, Map<PlaceId, boolean>>>(),
};

/**
 * #1765: the depths of the collection layers strictly between a mixed error's elements (or its path's last property)
 * and its leaf, outermost first: the prefixes `optional` describes, by their lengths.
 */
function intermediateDepths(path: readonly string[]): number[] {
  const property = path.findLastIndex((step) => step !== "element" && step !== "entry");
  const depths: number[] = [];
  for (let end = property + 2; end < path.length; end += 1) depths.push(end);
  return depths;
}

/**
 * #1765: whether each of `depths` along `path` holds `fact` for a side, read by one descent down the path (`layersOf`):
 * through a literal's children and through a carried value's parts alike (Astra r2's B1 on #1789: a carrier's literal
 * was descended once per longer prefix). The facts' own levels and leaves, side by side:
 * - `null` (#1765): `mayHoldNull`'s rule;
 * - `dict` (#1762) and `set` (#1825): `collectionOwn` at a value's own level, its items below it (`collectionHeld`).
 */
function layersAt(
  admission: Admission,
  value: PlaceId,
  node: FlowNode,
  path: readonly string[],
  depths: readonly number[],
  fact: "null" | "dict" | "set" = "null",
): boolean[] {
  return depths.length === 0 ? [] : layersOf(admission, value, node, path, depths, fact);
}

/**
 * A path below a value (`layersOf`), read without copying it: steps a carrier prepends (`head`), then the rest of an
 * outer view (`tail`), from `start`. A step past the head moves to the tail, so reading a step is constant work.
 */
interface Rope {
  readonly head: readonly string[];
  readonly tail: PathView | null;
}
interface PathView {
  readonly rope: Rope;
  readonly start: number;
  readonly length: number;
}

function viewStep(view: PathView, index: number): string | undefined {
  let at: PathView = view;
  let step = at.start + index;
  while (step >= at.rope.head.length && at.rope.tail !== null) {
    step -= at.rope.head.length;
    at = at.rope.tail;
    step += at.start;
  }
  return at.rope.head[step];
}

// (the view one step further, its head left once passed)
function viewRest(view: PathView): PathView {
  let at: PathView = { rope: view.rope, start: view.start + 1, length: view.length - 1 };
  while (at.start >= at.rope.head.length && at.rope.tail !== null) {
    const tail: PathView = at.rope.tail;
    at = { rope: tail.rope, start: tail.start + at.start - at.rope.head.length, length: at.length };
  }
  return at;
}

// (its first `count` steps, read once from the front: Codex r13)
function viewSteps(admission: Admission, view: PathView, count: number): readonly string[] {
  const out: string[] = [];
  let at: PathView | null = view;
  let from = view.start;
  while (at !== null && out.length < count) {
    const { head } = at.rope;
    for (let step = from; step < head.length && out.length < count; step += 1)
      out.push(head[step]!);
    at = at.rope.tail;
    from = at?.start ?? 0;
  }
  return keptSlice(admission.work, out, 0);
}

/**
 * A value's path in `layersOf`, as a `Strip` the carrier table transforms as it does steps: its view, the shift that
 * places the asked depths on it (`depths[i] + shift`), the first depth not yet answered above it (`next`), and its key,
 * made from its parent's and the step taken, so no key spells its path; `null` below a literal's step, where no key is
 * asked again.
 */
interface MarkedStrip extends Strip<MarkedStrip> {
  readonly view: PathView;
  readonly shift: number;
  readonly next: number;
  readonly key: number | null;
}

/**
 * Whether a value may hold null at each of `depths` along `path`, by one descent per pass: a depth at its own level and
 * every depth of a value no literal or carrier composes by `mayHoldNull`; a literal's depths below it by its children, a
 * carried value's by its parts (the carrier table's; an `otherwise`'s fallback only where its operand may be null, its
 * operand where it may hold a value), as `mayHoldNull` composes one path. Each frame is constant work: the depths stay
 * the asker's (each frame their shift and the first one left), the path a view, each answer written once. A value the
 * asker's own carriers reach, before any literal's step, has a key (`LAYERS`, its parent's key and one step, interned);
 * asked under a key it was asked under before, it keeps its answer per pass, so a join's growing operands are each read
 * once. Any other value writes each answer straight to the nearest value that keeps one, so no answer is copied along
 * a chain asked once (Codex r12–r15). A value asked again while its own answer is pending adds nothing.
 */
function layersOf(
  admission: Admission,
  value: PlaceId,
  node: FlowNode,
  path: readonly string[],
  depths: readonly number[],
  fact: "null" | "dict" | "set",
): boolean[] {
  const { program } = admission.pass;
  // (each fact its own answers per pass, #1762, #1825)
  const memos = fact === "null" ? LAYERS : fact === "dict" ? DICT_LAYERS : SET_LAYERS;
  let memo = memos.get(admission.pass);
  if (memo === undefined)
    memos.set(
      admission.pass,
      (memo = { keys: new Map(), answers: new Map(), seen: new Map(), count: { value: 0 } }),
    );
  const { keys, answers, seen, count } = memo;
  const intern = (parent: number | null, step: string): number | null => {
    if (parent === null) return null;
    admission.work.charge("checks");
    let mine = keys.get(parent);
    if (mine === undefined) keys.set(parent, (mine = new Map()));
    let key = mine.get(step);
    if (key === undefined) mine.set(step, (key = count.value += 1));
    return key;
  };
  const strip = (view: PathView, shift: number, next: number, key: number | null): MarkedStrip => {
    const made: MarkedStrip = {
      view,
      shift,
      next,
      key,
      length: view.length,
      at: (index) => viewStep(view, index),
      rest: () => {
        let left = next;
        while (left < depths.length && depths[left]! + shift - 1 < 0) left += 1;
        return strip(viewRest(view), shift - 1, left, intern(key, "rest"));
      },
      // (nothing prepended is the same path, and the same key: a join's operand is asked as its join is)
      under: (below) =>
        below.length === 0
          ? made
          : strip(
              { rope: { head: below, tail: view }, start: 0, length: view.length + below.length },
              shift + below.length,
              next,
              key === null ? null : intern(key, `under ${keptText(admission.work, below)}`),
            ),
    };
    return made;
  };
  // (where answers go: a set taken whole from the first answer that brings one, shared with it, and copied only where a
  // second must join it, so an answer kept along a chain is moved, not copied, Codex r16)
  class Sink {
    set: ReadonlySet<number> = EMPTY;
    private own = false;
    add(slot: number): void {
      if (this.set.has(slot)) return;
      // EVIDENCE: invariant: `own` is true only after this sink made `set` itself, a `Set` it may change.
      const mine = this.own ? (this.set as Set<number>) : new Set(this.set);
      mine.add(slot);
      this.set = mine;
      this.own = true;
    }
    take(answer: ReadonlySet<number>): void {
      if (answer.size === 0 || answer === this.set) return;
      if (this.set.size === 0) {
        this.set = answer;
        this.own = false;
        return;
      }
      for (const slot of answer) this.add(slot);
    }
  }
  // (a frame: its value, its path, the answers it keeps (`holds`: its own where it is kept, else those of the value that
  // keeps them), where they go, its parts, the next part)
  type Part = readonly [PlaceId, FlowNode, MarkedStrip];
  interface Frame {
    readonly at: PlaceId;
    readonly kept: boolean;
    readonly holds: Sink;
    readonly into: Sink;
    readonly strip: MarkedStrip;
    readonly parts: readonly Part[];
    next: number;
  }
  const pending = new Map<PlaceId, Set<number>>();
  const open = (
    at: PlaceId,
    from: FlowNode,
    here: MarkedStrip,
    into: Sink,
    kept: boolean,
  ): Frame => {
    admission.work.charge("checks");
    const literal = program.hasOf.has(at);
    const holds = kept ? new Sink() : into;
    let { next } = here;
    // (the depth at its own level, if one is)
    if (next < depths.length && depths[next]! + here.shift === 0) {
      if (
        fact === "null"
          ? mayHoldNull(admission, at, from, [])
          : collectionOwn(admission, at, from, fact)
      )
        holds.add(next);
      next += 1;
    }
    let parts: Part[] = [];
    if (next < depths.length) {
      const below = strip(here.view, here.shift, next, here.key);
      if (literal) {
        // (a literal's children: no key below its step)
        const rest = strip(viewRest(here.view), here.shift - 1, next, null);
        parts = literalChildren(admission, at, viewStep(here.view, 0)!).map(
          (child) => [child.value!, child.node ?? from, rest] as const,
        );
      } else {
        // (an `otherwise`'s operand where it may hold a value, its fallback where it may be null: a side never taken
        // brings nothing, Codex r5–r7 on #1814)
        const carried = admission.carriersBy(at, below);
        const operand = carried.find(([, , role]) => role === "otherwise/operand")?.[0];
        const falls = operand === undefined || operandNull(admission, operand, from);
        const taken =
          operand === undefined ||
          admission.items(operand, from, []).some((item) => item.tag !== "null");
        parts = carried
          .filter(
            ([, , role]) =>
              (role !== "otherwise/fallback" || falls) && (role !== "otherwise/operand" || taken),
          )
          .map(([part, path]) => [part, from, path] as const);
        // (a value no carrier composes: each depth by `mayHoldNull`, or its items for a dict, its path one read of the
        // longest)
        if (carried.length === 0) {
          const longest = viewSteps(admission, here.view, depths.at(-1)! + here.shift);
          for (let slot = next; slot < depths.length; slot += 1) {
            const steps = keptSlice(admission.work, longest, 0, depths[slot]! + here.shift);
            if (
              fact === "null"
                ? mayHoldNull(admission, at, from, steps)
                : collectionHeld(admission, at, steps, fact)
            )
              holds.add(slot);
          }
        }
      }
    }
    if (kept) {
      let mine = pending.get(at);
      if (mine === undefined) pending.set(at, (mine = new Set()));
      mine.add(here.key!);
    }
    return { at, kept, holds, into, strip: here, parts, next: 0 };
  };
  const out = new Sink();
  const root = strip(
    { rope: { head: path, tail: null }, start: 0, length: path.length },
    0,
    0,
    intern(-1, `${keptText(admission.work, path)}#${depths.join(",")}`),
  );
  const stack: Frame[] = [];
  // (a value asked under a key it was asked under before keeps its answer, read from then on; asked the first time, it
  // writes each answer straight to its asker's, so a chain asked once copies no answer, Codex r15)
  const ask = (at: PlaceId, from: FlowNode, here: MarkedStrip, into: Sink): void => {
    let kept = false;
    if (here.key !== null && !program.hasOf.has(at)) {
      const answer = answers.get(at)?.get(here.key);
      if (answer !== undefined) {
        into.take(answer);
        return;
      }
      if (pending.get(at)?.has(here.key) === true) return;
      let mine = seen.get(at);
      if (mine === undefined) seen.set(at, (mine = new Set()));
      kept = mine.has(here.key);
      mine.add(here.key);
    }
    stack.push(open(at, from, here, into, kept));
  };
  ask(value, node, root, out);
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    if (frame.next < frame.parts.length) {
      const [at, from, here] = frame.parts[frame.next]!;
      frame.next += 1;
      ask(at, from, here, frame.holds);
      continue;
    }
    stack.pop();
    if (!frame.kept) continue;
    let mine = answers.get(frame.at);
    if (mine === undefined) answers.set(frame.at, (mine = new Map()));
    mine.set(frame.strip.key!, frame.holds.set);
    pending.get(frame.at)!.delete(frame.strip.key!);
    frame.into.take(frame.holds.set);
  }
  return depths.map((_, slot) => out.set.has(slot));
}

/**
 * Per pass, `layersOf`'s keys (each a parent's and one step, interned) and the answer of each value the asker's own
 * carriers reach under its key, shared by every literal's and join's error.
 */
const EMPTY: ReadonlySet<number> = new Set();

const LAYERS = new WeakMap<
  object,
  {
    readonly keys: Map<number, Map<string, number>>;
    readonly answers: Map<PlaceId, Map<number, ReadonlySet<number>>>;
    readonly seen: Map<PlaceId, Set<number>>;
    readonly count: { value: number };
  }
>();
/**
 * Per pass, `layersOf`'s keys and answers for the dict fact (#1762), as `LAYERS` holds the null fact's. Apart from
 * `SET_LAYERS`: the answers last the pass, so a later sentence over the same values (a growing join's) reads what an
 * earlier one kept, and a shared memo would give a set ask a dict answer (Codex r1 on #2017).
 */
const DICT_LAYERS = new WeakMap<
  object,
  {
    readonly keys: Map<number, Map<string, number>>;
    readonly answers: Map<PlaceId, Map<number, ReadonlySet<number>>>;
    readonly seen: Map<PlaceId, Set<number>>;
    readonly count: { value: number };
  }
>();
/** Per pass, the same for the set fact (#1825), apart from `DICT_LAYERS` for the reason given there. */
const SET_LAYERS = new WeakMap<
  object,
  {
    readonly keys: Map<number, Map<string, number>>;
    readonly answers: Map<PlaceId, Map<number, ReadonlySet<number>>>;
    readonly seen: Map<PlaceId, Set<number>>;
    readonly count: { value: number };
  }
>();

function mixedOptional(type: boolean[], kinds: boolean[]): MixedOptional | undefined {
  return type.includes(true) || kinds.includes(true) ? { type, kinds } : undefined;
}
