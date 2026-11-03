import type { PlaceId } from "../../graph.js";
import { joinParts, keptParts, textUnits } from "../budget.js";
import { keyBelowRef, restPart, restRef, restTo, stepsRest, type Rest } from "./key-ids.js";
import type { Contract } from "../contract.js";
import { type Key } from "../definitions.js";
import { withoutEmpty, withWriter } from "../exact-path.js";
import { EMPTY, firstWriter, REASON, type Item } from "../items.js";
import { stepName } from "../program.js";
import { sharing } from "../sharing.js";
import type { Work } from "../solver.js";
import { plainStep, propertyOnly, unknownItem } from "./kinds.js";
import {
  indexPaths,
  namesPart,
  nodeAt,
  pathAt,
  pathBelow,
  propertyIndex,
  propertyLack,
} from "./literal-index.js";
import { annotated, collectMarks, depthOf, marksAt, marksNothing } from "./marks.js";
import type {
  EntryGroup,
  Holder,
  LevelGroup,
  PrefixEntry,
  PrefixLevels,
  PrefixStores,
} from "./model.js";

// A prefix's levels (§4.6): its entries grouped at a path, and a literal's structure by path.

/** A prefix entry's kinds at the rest of the path. */
export function* entryAt(
  contract: Contract,
  entry: PrefixEntry,
  rest: Rest,
): Work<readonly Item[]> {
  contract.pass.program.work.charge("invSteps");
  // (a cursor's span read one step at a time, its path's id where a key or a value takes it whole, G3 stage 1)
  const ref = restRef(contract, rest);
  if (entry.unk !== undefined) return [unknownItem(entry.unk, entry.w)];
  // F6, F7: the contract's M is open
  if (entry.empty === true) return ref.length === 1 && ref.at(0) === "element" ? [EMPTY] : [];
  // F5: an add's element; an `addAll` contributes kinds, never emptiness (M unchanged)
  if (entry.elem !== undefined) {
    if (ref.length === 0 || ref.at(0) !== "element") return [];
    const at = ref.from(1).after(entry.at ?? []);
    const items = annotated(
      contract,
      entry,
      at,
      withWriter(yield* contract.contractOfValueAt(entry.elem, at), entry.w),
    );
    return ref.length === 1 ? withoutEmpty(items) : items;
  }
  // §3.2: a copy read under a guard; a tested child's mark by the entry's holder at the path (r4.15)
  if (entry.key !== undefined)
    return annotated(
      contract,
      entry,
      ref,
      withWriter(yield* contract.contractOf(keyBelowRef(contract, entry.key, ref)), entry.w),
    );
  return annotated(
    contract,
    entry,
    ref,
    withWriter(yield* contract.contractOfValueAt(entry.value!, ref.after(entry.at ?? [])), entry.w),
  );
}

/**
 * A prefix's entries as its levels read them (§4.6), once per prefix: each entry a level's member (`levelMember`)
 * starts the levels, every other entry answers each path by itself.
 */
export function prefixLevels(contract: Contract, asked: Key, stores: PrefixStores): PrefixLevels {
  // (a prefix in its identity, as the levels hold it: G3 stage 1)
  const prefix = contract.canonicalKey(asked);
  const known = contract.levelBases.get(prefix);
  if (known !== undefined) return known;
  const others: PrefixEntry[] = [];
  const base: LevelGroup[] = [];
  let closed = stores.list.length > 1;
  for (const entry of stores.list) {
    contract.pass.program.work.charge("structureSteps");
    const member = levelMember(contract, entry);
    closed &&= (member !== null || !sharing()) && closedObject(contract, entry);
    if (member === null) others.push(entry);
    else base.push(member);
  }
  // (its holders mark nothing: asked only where every entry is otherwise a closed object, so a prefix the cheap checks
  // refuse never walks its holders)
  if (closed)
    for (const entry of stores.list)
      if (!marksNothing(contract, entry.holder)) {
        closed = false;
        break;
      }
  const levels = { others, base, closed, read: false };
  contract.levelBases.set(prefix, levels);
  return levels;
}

/** #1456: a path no object holds, one step below a prefix (an author's property named `element` is quoted). */
const LACKED: Rest = ["element"];

/**
 * #1456: whether a prefix entry is a closed object literal stored whole, whose properties are its object's alone: one
 * object term, no projection, copied key, element or cell, unguarded, without ingress; its holder marking no path
 * (`marksNothing`) is asked after, of a prefix every entry of which is this. Its property's answer is then the
 * literal's own there, and a property it lacks F11's `missing` with the literal's writer; any other entry is unproved.
 */
function closedObject(contract: Contract, entry: PrefixEntry): boolean {
  const { program } = contract.pass;
  const value = entry.value;
  if (
    value === undefined ||
    entry.at !== undefined ||
    entry.key !== undefined ||
    entry.elem !== undefined ||
    entry.guarded ||
    entry.ingress !== undefined ||
    program.cellOwner.has(value)
  )
    return false;
  const terms = program.hasOf.get(value);
  return terms?.length === 1 && terms[0]!.type.kind === "object";
}

/**
 * #1456: a prefix's contributions at a property below it where its entries are closed objects (`PrefixLevels.closed`),
 * from its property index (`propertyIndex`): the answers of the sources holding the property alone (each entry by
 * itself, the sharing off; on, their groups at the path, folded from theirs as `groupsAt` folds, never kept as the
 * prefix's, whose complete list a deeper path folds), and F11's one `missing` for those without it, with the earliest
 * literal writer, standing where the first of them stands among the holders (`propertyLack`); `null` for any other
 * prefix or path, which its levels answer, and for the prefix's reads before its index pays: its first at the levels'
 * own cost, so a prefix read once costs what its levels do, each later one until the reads reach the index's size.
 */
export function* propertyItems(
  contract: Contract,
  asked: Key,
  stores: PrefixStores,
  rest: Rest,
): Work<readonly Item[] | null> {
  if (rest.length !== 1 || !propertyOnly(rest.at(0)!)) return null;
  const levels = prefixLevels(contract, asked, stores);
  if (!levels.closed) return null;
  const { work } = contract.pass.program;
  let index = contract.propertyIndexes.get(stores);
  if (index === undefined || !("holders" in index)) {
    // (its first property read: the levels answer it at their own cost, nothing kept for it)
    if (!levels.read) {
      levels.read = true;
      return null;
    }
    const groups = sharing() ? groupsAt(contract, asked, levels.base, stepsRest([])) : null;
    const sources = groups ?? stores.list;
    if (index === undefined) {
      // (the index's size: its sources' property names)
      let names = 0;
      const count = (literal: PlaceId): void => {
        work.charge("structureSteps");
        names += contract.literalIndex(literal).root.objects!.list[0]!.names.size;
      };
      if (groups === null) for (const entry of stores.list) count(entry.value!);
      else for (const group of groups) count(group.literal);
      contract.keep(2);
      contract.propertyIndexes.set(stores, (index = { asked: 1, names }));
    }
    // (its levels read it, a fold of the sources each, while what they read for the prefix's properties is less than
    // the index's size: a prefix of a few wide objects, as each of k copies of one read twice, is never indexed)
    if ((index.asked + 1) * sources.length < index.names) {
      index.asked += 1;
      return null;
    }
    let shared: { groups: readonly LevelGroup[]; writers: Set<PlaceId> } | null = null;
    if (groups !== null) {
      // (where groups lack a property the levels fold those alike there into the first, whose literal F11 names:
      // alike by their root and marks, whatever the property, so as at a step no object holds)
      const writers = new Set<PlaceId>();
      for (const group of foldGroups(contract, LACKED, groups)) {
        contract.keep(1);
        writers.add(group.literal);
      }
      shared = { groups, writers };
    }
    index = propertyIndex(contract, stores.list, shared);
    contract.propertyIndexes.set(stores, index);
  }
  const step = rest.at(0)!;
  const path = pathAt(contract, 0, step);
  const holders = index.holders.get(path) ?? [];
  const lack = propertyLack(contract, index, path, step);
  const out: Item[] = [];
  let placed = lack.writer === null;
  // (the `missing` before the first holder after the first source without the property)
  const before = (at: number): void => {
    if (placed || at < lack.at) return;
    placed = true;
    out.push(unknownItem(REASON.missing, lack.writer));
  };
  if (!sharing())
    for (const source of holders) {
      work.charge("invSteps");
      before(source.at);
      for (const item of yield* contract.entryAt(source.entry!, rest)) out.push(item);
    }
  else {
    contract.keep(holders.length);
    // (a fold's group stands where its first holder does: the holders in order, each group's first among them)
    let first = 0;
    for (const group of foldGroups(
      contract,
      rest,
      holders.map((source) => source.group!),
    )) {
      work.charge("invSteps");
      while (holders[first]!.group!.literal !== group.literal) first += 1;
      before(holders[first]!.at);
      // (a literal stored whole: its group stands at the prefix itself)
      for (const item of annotated(
        contract,
        group,
        rest,
        withWriter(yield* contract.contractOfValueAt(group.literal, rest), group.w),
      ))
        out.push(item);
    }
  }
  before(Infinity);
  return out;
}

/**
 * S6c (the typed-ingress presets, S4's product): a prefix's entries that answer by themselves (`prefixLevels`), in
 * groups that answer alike at every path apart from their writers and ingress stores, once per prefix: adds of values
 * of one class (`classOf`, its ingresses by what their contract reads), each unguarded or each guarded, none holding
 * a mark (a holder of no guarded path, read or reference); any other entry its own group. An entry's ingress stores
 * reach only its unknowns (C9), an operator's result its operand's identity, so where the group's first answers
 * without either, it answers for the group, the earliest writer for its kinds (F28); k adds of a typed `load` of one
 * default, or of literals of two, each its own source (r4.15), read at k fields, are one group read once per field
 * (review r6 B2). In the entries' order.
 */
export function entryGroups(contract: Contract, levels: PrefixLevels): readonly EntryGroup[] {
  const known = contract.entryGroupsOf.get(levels);
  if (known !== undefined) return known;
  const groups: EntryGroup[] = [];
  const byShape = new Map<string, number>();
  for (const entry of levels.others) {
    contract.pass.program.work.charge("structureSteps");
    const shape =
      !sharing() || entry.elem === undefined || !markFree(contract, entry.holder)
        ? null
        : contract.classOf(entry.elem, false);
    const key =
      shape === null
        ? null
        : keptParts(contract.work, shape, entry.at ?? [], entry.guarded ? "g" : "");
    const at = key === null ? undefined : byShape.get(key);
    contract.keep(1);
    if (at !== undefined) {
      const into = groups[at]!;
      into.entries.push(entry);
      into.w = firstWriter(into.w, entry.w);
      continue;
    }
    if (key !== null) byShape.set(key, groups.length);
    contract.keep(2);
    groups.push({ entries: [entry], w: entry.w });
  }
  contract.entryGroupsOf.set(levels, groups);
  return groups;
}

/** Whether a holder marks no path (§3.2): none of its paths guarded, no read and no reference of its own. */
export function markFree(contract: Contract, holder: Holder | null): boolean {
  if (holder === null) return true;
  collectMarks(contract);
  return holder.guarded.size === 0 && holder.reads.length === 0 && holder.refsAt.size === 0;
}

/**
 * A prefix entry as a level's member (§4.6): a literal stored whole, or a projection of one by property or index
 * steps, the selected prefix normalized to the literal and the steps into it, so the k projections
 * `({noise: hostValue otherwise null, data: root}).data` are the literals at `data`, whose level holds the read of
 * `root` once; `null` for any other entry, which answers each path itself, and for a literal holding a carrier whose
 * operand read is marked below it: such literals differ by where their reads are marked, so a level of k of them
 * would be k groups at every path, its work beside each entry's own answer (Codex r21 B1).
 */
function levelMember(contract: Contract, entry: PrefixEntry): LevelGroup | null {
  if (
    !sharing() ||
    entry.value === undefined ||
    entry.at !== undefined ||
    entry.key !== undefined ||
    entry.elem !== undefined
  )
    return null;
  const { program } = contract.pass;
  const steps: string[] = [];
  let value = entry.value;
  while (!program.hasOf.has(value)) {
    const projection = program.projOf.get(value);
    // (a property or an index selects what its owner holds there; a selection, a length, a dict's lists and the
    // temporal members answer otherwise)
    if (projection === undefined || !plainStep(projection.step)) return null;
    program.work.charge("structureSteps");
    steps.push(stepName(projection.step));
    value = projection.owner;
  }
  if (contract.markedStructures.has(contract.structureOf(value))) return null;
  return {
    literal: value,
    at: steps.reverse(),
    w: entry.w,
    holder: entry.holder,
    guarded: entry.guarded,
    ingress: entry.ingress,
  };
}

/**
 * S6-CARRIERS §4.6: a prefix's level members grouped at a path below it, built from the groups one step up: groups
 * that hold the same structure below the path (`levelsOf`, at the member's steps into its literal) and the same
 * facts at every step above it merge, the earliest standing for the group and the annotations united; a group whose
 * marks may depend on steps past the path stays its own. Once per prefix and path, so k literals that differ only
 * beside the path are one group there, never k at every path below.
 */
export function groupsAt(
  contract: Contract,
  asked: Key,
  base: readonly LevelGroup[],
  path: Rest,
): readonly LevelGroup[] {
  // (a prefix in its identity, as the levels' groups are named by it: G3 stage 1; a span by its name, never its text)
  const prefix = contract.canonicalKey(asked);
  const memoKey = joinParts(prefix, restPart(path));
  const known = contract.levelGroups.get(memoKey);
  if (known !== undefined) return known;
  contract.keepText(memoKey.length);
  collectMarks(contract);
  // the members themselves at the prefix (a projection's literal at its steps into it)
  const parents =
    path.length === 0
      ? null
      : groupsAt(contract, prefix, base, restTo(contract, path, path.length - 1));
  const groups = foldGroups(contract, path, parents ?? base, parents);
  contract.levelGroups.set(memoKey, groups);
  return groups;
}

/**
 * What a fold read of a group at its path (#1607): its literal's path there (`id`, -1 where its index holds none) and
 * what stands at each step above it, one interned vector (`above`, `aboveOf`). A fold one step down takes both from its
 * parent group's, one step more, so the folds at each of a path's k prefixes walk k steps, never k².
 */
interface Folded {
  readonly id: number;
  readonly above: number;
  /** The length of the vector's parts' texts, as a fold that joins them makes them (`foldGroups`'s accounting). */
  readonly length: number;
}

/** The fold facts of the groups `foldGroups` made, in their order. */
const foldsOf = new WeakMap<readonly LevelGroup[], readonly Folded[]>();

/** Per pass, the interned vectors of `Folded.above`: each one's id by its parent vector's and its last part. */
const vectorsOf = new WeakMap<Contract, Map<string, number>>();

/**
 * The interned vector `parent` (0 the empty one) with `part` after it, made where new: its entry charged there unless the
 * caller's walk charged each step already (`charged`).
 */
function aboveOf(contract: Contract, parent: number, part: string, charged: boolean): number {
  let vectors = vectorsOf.get(contract);
  if (vectors === undefined) vectorsOf.set(contract, (vectors = new Map()));
  const name = joinParts(parent, part);
  let id = vectors.get(name);
  if (id === undefined) {
    contract.keepText(name.length);
    if (!charged) contract.keep(1);
    vectors.set(name, (id = vectors.size + 1));
  }
  return id;
}

/**
 * `groupsAt`'s fold at a path of the groups one step above it (`parents`), the marks collected; for a property of a
 * prefix of closed objects, its holders' groups alone (`propertyItems`). Each group's fold read from its parent's one
 * step up where the parents are `groupsAt`'s at the path's parent (`above`, their facts, #1607), else from its root, as
 * a shared build; its demand counts what the fold from the root charged (`WorkLedger.repeat`), its path read as there.
 */
function foldGroups(
  contract: Contract,
  path: Rest,
  parents: readonly LevelGroup[],
  above: readonly LevelGroup[] | null = null,
): readonly LevelGroup[] {
  const { program } = contract.pass;
  const known = above === null ? undefined : foldsOf.get(above);
  // each group's key, to its position in the list
  const merged = new Map<string, number>();
  const groups: LevelGroup[] = [];
  const folds: Folded[] = [];
  for (const [index, group] of parents.entries()) {
    program.work.charge("structureSteps");
    const levels = levelsOf(contract, group.literal);
    // (what stands at each step above the path: entries read below it, objects lacking the next step, a
    // reference, an empty collection; and whether the literal is a cell, every path then below an element)
    const parent = known?.[index];
    const steps = group.at.length + path.length;
    // (the path's steps read as a fold from the root reads them, through the path's own reads, each charged as there)
    const along: string[] = [];
    for (let at = 0; at < path.length; at += 1) along.push(path.at(at)!);
    // (the fold itself a shared build: its interned vector, from the parent group's fold or from the root, charged to
    // the analysis and never to the demand, which counts the fold from the root below)
    const fold = program.work.shared((): Folded => {
      if (parent !== undefined) {
        const part = levels.at.get(parent.id) ?? "";
        return {
          id: pathBelow(contract, parent.id, along.at(-1)!),
          above: aboveOf(contract, parent.above, part, false),
          length: parent.length + part.length,
        };
      }
      // (from the literal's root: each step walked charged, as the vector it makes)
      let id = 0;
      let vector = 0;
      let length = 0;
      contract.keep(steps);
      for (let at = 0; at < steps; at += 1) {
        const part = levels.at.get(id) ?? "";
        vector = aboveOf(contract, vector, part, true);
        length += part.length;
        id = pathBelow(
          contract,
          id,
          at < group.at.length ? group.at[at]! : along[at - group.at.length]!,
        );
      }
      return { id, above: vector, length };
    });
    const cell = program.cellOwner.get(group.literal)?.kind === "cell" ? "cell" : "";
    // (its marks: alike where they cannot depend on steps past the path, else its own, §3.2 r4.23)
    const marks =
      group.holder === null
        ? ""
        : depthOf(contract, group.holder) <= path.length
          ? String(marksAt(contract, group.holder, path))
          : group.holder.id;
    const key = program.work.shared(() =>
      contract.kept(`${levels.below.get(fold.id) ?? ""}|${fold.above}|${cell}|${marks}`),
    );
    // (to its demand exactly what the fold of the group from its root charges besides its path's reads: its steps kept,
    // its vector's parts joined and its key holding that text, `WorkLedger.repeat`; so every demand stops where the folds
    // from the root stopped it, and the saving is the analysis's alone)
    const joined = steps === 0 ? 0 : fold.length + steps - 1;
    program.work.repeat(
      steps + textUnits(joined) + textUnits(key.length - String(fold.above).length + joined),
    );
    const position = merged.get(key);
    if (position === undefined) {
      merged.set(key, groups.length);
      groups.push(group);
      folds.push(fold);
      continue;
    }
    const into = groups[position]!;
    groups[position] = {
      literal: into.literal,
      at: into.at,
      w: firstWriter(into.w, group.w),
      holder: into.holder,
      guarded: into.guarded || group.guarded,
      ingress: program.scope.ingress.union(into.ingress, group.ingress),
    };
  }
  foldsOf.set(groups, folds);
  return groups;
}

/**
 * A literal's structure by path, once (§4.6): what stands at each path of its index itself (its own terms' kinds,
 * its reads' and other values' structures, its objects' property names, a reference, an empty collection), and below
 * each path everything under it, interned; each by its path's id (`pathAt`).
 */
function levelsOf(
  contract: Contract,
  literal: PlaceId,
): { readonly below: ReadonlyMap<number, string>; readonly at: ReadonlyMap<number, string> } {
  const known = contract.literalLevels.get(literal);
  if (known !== undefined) return known;
  const { program } = contract.pass;
  const index = contract.literalIndex(literal);
  // (the literal's own path too: its whole structure is a member's key at the prefix; and each path's prefixes)
  const paths = new Set<number>([0]);
  for (const [id] of indexPaths(contract, index)) {
    contract.keep(1);
    paths.add(id);
  }
  for (const path of [...paths])
    for (
      let parent = contract.pathParents[path]!;
      parent >= 0 && !paths.has(parent);
      parent = contract.pathParents[parent]!
    ) {
      contract.keep(1);
      paths.add(parent);
    }
  const at = new Map<number, string>();
  for (const id of paths) {
    program.work.charge("structureSteps");
    const node = nodeAt(contract, index, id);
    const tags = [...(node?.terms.keys() ?? [])].sort();
    contract.keep(tags.length);
    const parts = [
      contract.joined(tags, ","),
      ...[...(node?.reads ?? []), ...(node?.others ?? [])].map((entry) =>
        contract.structureOf(entry.value),
      ),
      ...(node?.objects?.list ?? []).map((object) => namesPart(contract, object.names)),
      node?.reference === true ? "ref" : "",
      node?.empty === true ? "empty" : "",
    ];
    at.set(id, contract.internStructure(`at(${contract.joined(parts, ";")})`));
  }
  // below a path: its own and, deepest first, every path one step under it
  const below = new Map<number, string>();
  const children = new Map<number, number[]>();
  for (const id of paths) {
    if (id === 0) continue;
    contract.keep(1);
    const parent = contract.pathParents[id]!;
    let list = children.get(parent);
    if (list === undefined) children.set(parent, (list = []));
    list.push(id);
  }
  const depths = contract.pathDepths;
  contract.keep(paths.size);
  for (const id of [...paths].sort((a, b) => depths[b]! - depths[a]!)) {
    program.work.charge("structureSteps");
    const listed = (children.get(id) ?? []).map((child) =>
      contract.kept(`${child}=${below.get(child)}`),
    );
    contract.keep(listed.length);
    below.set(
      id,
      contract.internStructure(`below(${at.get(id)};${contract.joined(listed.sort(), ",")})`),
    );
  }
  const levels = { below, at };
  contract.literalLevels.set(literal, levels);
  return levels;
}
