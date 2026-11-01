import type { PlaceId } from "../../graph.js";
import { joinParts, keptParts } from "../budget.js";
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
  const levels = { others, base, closed };
  contract.levelBases.set(prefix, levels);
  return levels;
}

/**
 * #1456: whether a prefix entry is a closed object literal stored whole, whose properties are its object's alone: one
 * object term, no projection, copied key, element or cell, unguarded, without ingress, its holder marking no path
 * (`marksNothing`). Its property's answer is then the literal's own there, and a property it lacks F11's `missing`
 * with the literal's writer; any other entry is unproved.
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
  return (
    terms?.length === 1 && terms[0]!.type.kind === "object" && marksNothing(contract, entry.holder)
  );
}

/**
 * #1456: a prefix's contributions at a property below it where its entries are closed objects (`PrefixLevels.closed`),
 * from its property index (`propertyIndex`): the answers of the sources holding the property alone (each entry by
 * itself, the sharing off; on, their groups at the path, folded from theirs as `groupsAt` folds, never kept as the
 * prefix's, whose complete list a deeper path folds), and F11's one `missing` for those without it, with the earliest
 * literal writer, standing where the first of them stands among the holders (`propertyLack`); `null` for any other
 * prefix or path, which its levels answer.
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
  let index = contract.propertyIndexes.get(stores);
  if (index === undefined) {
    index = propertyIndex(
      contract,
      stores.list,
      sharing() ? groupsAt(contract, asked, levels.base, stepsRest([])) : null,
    );
    contract.propertyIndexes.set(stores, index);
  }
  const { work } = contract.pass.program;
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
  const groups = foldGroups(
    contract,
    path,
    path.length === 0
      ? base
      : groupsAt(contract, prefix, base, restTo(contract, path, path.length - 1)),
  );
  contract.levelGroups.set(memoKey, groups);
  return groups;
}

/**
 * `groupsAt`'s fold at a path of the groups one step above it (`parents`), the marks collected; for a property of a
 * prefix of closed objects, its holders' groups alone (`propertyItems`).
 */
function foldGroups(
  contract: Contract,
  path: Rest,
  parents: readonly LevelGroup[],
): readonly LevelGroup[] {
  const { program } = contract.pass;
  // each group's key, to its position in the list
  const merged = new Map<string, number>();
  const groups: LevelGroup[] = [];
  for (const group of parents) {
    program.work.charge("structureSteps");
    const levels = levelsOf(contract, group.literal);
    // (what stands at each step above the path: entries read below it, objects lacking the next step, a
    // reference, an empty collection; and whether the literal is a cell, every path then below an element)
    const above: string[] = [];
    let id = 0;
    contract.keep(group.at.length + path.length);
    for (let index = 0; index < group.at.length + path.length; index += 1) {
      above.push(levels.at.get(id) ?? "");
      const step = index < group.at.length ? group.at[index]! : path.at(index - group.at.length)!;
      id = pathBelow(contract, id, step);
    }
    const cell = program.cellOwner.get(group.literal)?.kind === "cell" ? "cell" : "";
    // (its marks: alike where they cannot depend on steps past the path, else its own, §3.2 r4.23)
    const marks =
      group.holder === null
        ? ""
        : depthOf(contract, group.holder) <= path.length
          ? String(marksAt(contract, group.holder, path))
          : group.holder.id;
    const key = contract.kept(
      `${levels.below.get(id) ?? ""}|${contract.joined(above, "|")}|${cell}|${marks}`,
    );
    const position = merged.get(key);
    if (position === undefined) {
      merged.set(key, groups.length);
      groups.push(group);
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
