import type { PlaceId } from "../../graph.js";
import { joinParts, joinSteps, keptParts } from "../budget.js";
import type { Contract } from "../contract.js";
import { keyBelow, type Key } from "../definitions.js";
import { withoutEmpty, withWriter } from "../exact-path.js";
import { EMPTY, firstWriter, type Item } from "../items.js";
import { stepName } from "../program.js";
import { sharing } from "../sharing.js";
import type { Work } from "../solver.js";
import { plainStep, unknownItem } from "./kinds.js";
import { indexPaths, namesPart, nodeAt, pathBelow } from "./literal-index.js";
import { annotated, collectMarks, depthOf, marksAt } from "./marks.js";
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
  rest: readonly string[],
): Work<readonly Item[]> {
  contract.pass.program.work.charge("invSteps");
  if (entry.unk !== undefined) return [unknownItem(entry.unk, entry.w)];
  // F6, F7: the contract's M is open
  if (entry.empty === true) return rest.length === 1 && rest[0] === "element" ? [EMPTY] : [];
  // F5: an add's element; an `addAll` contributes kinds, never emptiness (M unchanged)
  if (entry.elem !== undefined) {
    if (rest[0] !== "element") return [];
    const at = joinSteps(entry.at ?? [], rest.slice(1));
    const items = annotated(
      contract,
      entry,
      at,
      withWriter(yield* contract.contractOfValueAt(entry.elem, at), entry.w),
    );
    return rest.length === 1 ? withoutEmpty(items) : items;
  }
  // §3.2: a copy read under a guard; a tested child's mark by the entry's holder at the path (r4.15)
  if (entry.key !== undefined)
    return annotated(
      contract,
      entry,
      rest,
      withWriter(yield* contract.contractOf(keyBelow(entry.key, rest)), entry.w),
    );
  return annotated(
    contract,
    entry,
    rest,
    withWriter(
      yield* contract.contractOfValueAt(entry.value!, joinSteps(entry.at ?? [], rest)),
      entry.w,
    ),
  );
}

/**
 * A prefix's entries as its levels read them (§4.6), once per prefix: each entry a level's member (`levelMember`)
 * starts the levels, every other entry answers each path by itself.
 */
export function prefixLevels(contract: Contract, prefix: Key, stores: PrefixStores): PrefixLevels {
  const known = contract.levelBases.get(prefix);
  if (known !== undefined) return known;
  const others: PrefixEntry[] = [];
  const base: LevelGroup[] = [];
  for (const entry of stores.list) {
    contract.pass.program.work.charge("structureSteps");
    const member = levelMember(contract, entry);
    if (member === null) others.push(entry);
    else base.push(member);
  }
  const levels = { others, base };
  contract.levelBases.set(prefix, levels);
  return levels;
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
  prefix: Key,
  base: readonly LevelGroup[],
  path: readonly string[],
): readonly LevelGroup[] {
  const memoKey = joinParts(prefix, path);
  const known = contract.levelGroups.get(memoKey);
  if (known !== undefined) return known;
  contract.keepText(memoKey.length);
  const { program } = contract.pass;
  collectMarks(contract);
  // each group's key, to its position in the list; the members themselves at the prefix (a projection's literal at
  // its steps into it)
  const merged = new Map<string, number>();
  const groups: LevelGroup[] = [];
  for (const group of path.length === 0
    ? base
    : groupsAt(contract, prefix, base, path.slice(0, -1))) {
    program.work.charge("structureSteps");
    const levels = levelsOf(contract, group.literal);
    // (what stands at each step above the path: entries read below it, objects lacking the next step, a
    // reference, an empty collection; and whether the literal is a cell, every path then below an element)
    const above: string[] = [];
    let id = 0;
    contract.keep(group.at.length + path.length);
    for (const step of joinSteps(group.at, path)) {
      above.push(levels.at.get(id) ?? "");
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
  contract.levelGroups.set(memoKey, groups);
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
