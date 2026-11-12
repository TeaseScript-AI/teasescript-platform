import type { PlaceId } from "../../graph.js";
import { joinParts, joinSteps, keptParts } from "../budget.js";
import {
  isSteps,
  keyBelowRef,
  restPart,
  restRef,
  restTo,
  someStepOf,
  stepsRest,
  type Rest,
} from "./key-ids.js";
import type { Contract } from "../contract.js";
import { keyPlace, SELECTED_TEXT, SELECTED_VALUE, type Key } from "../definitions.js";
import { withoutEmpty, withWriter } from "../exact-path.js";
import { EMPTY, firstWriter, mergeItems, REASON, type Item, type Writer } from "../items.js";
import { stepName } from "../program.js";
import { sharing } from "../sharing.js";
import type { Work } from "../solver.js";
import type { FlowSink } from "./contributions.js";
import { pushedRead, pushedSlot } from "./frontier.js";
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
  LiteralIndex,
  PrefixEntry,
  PrefixLevels,
  PrefixStores,
  PropertyIndex,
  PropertyReads,
  PropertySource,
} from "./model.js";
import { amend, Retained, retainedModule } from "../retained/retained.js";

// A prefix's levels (§4.6): its entries grouped at a path, and a literal's structure by path.

/** A prefix entry's kinds at the rest of the path. */
export function* entryAt(
  contract: Contract,
  entry: PrefixEntry,
  rest: Rest,
  flow: FlowSink | null = null,
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
    const element = flow?.child() ?? null;
    const items = annotated(
      contract,
      entry,
      at,
      withWriter(yield* contract.contractOfValueAt(entry.elem, at, element), entry.w),
    );
    const kept = ref.length === 1 ? withoutEmpty(items) : items;
    // (#1668: kept under its filter: the snapshot drops it where the filter removes its items whole)
    if (element !== null)
      flow!.attach(
        element,
        ...(ref.length === 1 ? (["withoutEmpty"] as const) : []),
        "annotated",
        "writer",
      );
    return kept;
  }
  // §3.2: a copy read under a guard; a tested child's mark by the entry's holder at the path
  if (entry.key !== undefined) {
    // (#1668: the copied key below, the edge a copy makes, as its marks and writer annotate it)
    const below = flow?.child() ?? null;
    // #1655: a key below its place's root in a copy cycle through a projection, read one step at a time below the
    // writing edge (`frontier.ts`)
    const pushed = pushedSlot(contract, entry, ref);
    const items = annotated(
      contract,
      entry,
      ref,
      withWriter(
        pushed !== null
          ? yield* pushedRead(contract, pushed, keyPlace(entry.key), below)
          : yield* contract.contractOf(keyBelowRef(contract, entry.key, ref), below),
        entry.w,
      ),
    );
    if (below !== null) flow!.attach(below, "annotated", "writer");
    return items;
  }
  const stored = flow?.child() ?? null;
  const items = annotated(
    contract,
    entry,
    ref,
    withWriter(
      yield* contract.contractOfValueAt(entry.value!, ref.after(entry.at ?? []), stored),
      entry.w,
    ),
  );
  if (stored !== null) flow!.attach(stored, "annotated", "writer");
  return items;
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
  const levels = Retained.record<PrefixLevels>("Contract.levelBases", {
    others,
    base,
    closed,
    reads: 0,
  });
  contract.levelBases.set(prefix, levels);
  return levels;
}

/**
 * #1456: whether a prefix entry is a closed object literal stored whole, whose properties are its object's alone: one
 * object term, no projection, copied key, element or cell, unguarded, without ingress; its holder marking no path
 * (`marksNothing`) is asked after, of a prefix every entry of which is this. Its property's answer is then the
 * literal's own there, and a property it lacks F11's `missing` with the literal's writer; any other entry is unproved.
 */
export function closedObject(contract: Contract, entry: PrefixEntry): boolean {
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
 * #1456: a prefix's contributions at a path below it whose first step is a property, where its entries are closed
 * objects (`PrefixLevels.closed`), from its property index (`propertyIndex`): the answers of the sources holding the
 * property alone (each entry by itself at the path, the sharing off; on, their groups at the path, folded from theirs
 * one step at a time as `groupsAt` folds, never kept as the prefix's), and F11's one `missing` for those without it,
 * with the earliest literal writer, standing where the first of them stands among the holders (`propertyLack`); `null`
 * for any other prefix or path (a selection below the property: each entry by itself, `contractAlong`), which its
 * levels answer, and for the prefix's reads before its index pays: its first at the levels' own cost, so a prefix
 * read once costs what its levels do, each later one until the folds its reads would save reach its construction.
 * `null` also below a property every source holds, where the index skips no source: the levels' fold there is the
 * holders' own.
 *
 * #1948, #1585: the same at any depth below the property. What this reasons about lasts the pass's index of the
 * prefix's settled stores (`Contract.propertyIndexes`): the prefix's groups it was made from, and the F11 `missing`
 * it places where the first source without the property stands. Such a source is a closed object lacking the
 * property, so its read at every path below the property is that `missing`, with its own object's writer, and nothing
 * below; and each group's fold key holds its root object's property names at every path below the prefix
 * (`foldGroups`' `above`), so a holder's group never merges with a group without the property at any of them. The
 * groups the full fold makes at the path from the prefix's are then the holders' fold's, in the same order with the
 * same members, and the others' items its one `missing`.
 */
export function* propertyItems(
  contract: Contract,
  asked: Key,
  stores: PrefixStores,
  rest: Rest,
  flow: FlowSink | null = null,
): Work<readonly Item[] | null> {
  if (rest.length === 0 || !propertyOnly(rest.at(0)!)) return null;
  if (someStepOf(rest, (step) => step === SELECTED_VALUE || step === SELECTED_TEXT)) return null;
  const levels = prefixLevels(contract, asked, stores);
  if (!levels.closed) return null;
  const { work } = contract.pass.program;
  let index = contract.propertyIndexes.get(stores);
  if (index === undefined || !("holders" in index)) {
    // (its first property read: the levels answer it at their own cost, nothing kept for it)
    levels.reads += 1;
    if (levels.reads === 1) return null;
    const groups = sharing() ? groupsAt(contract, asked, levels.base, stepsRest([])) : null;
    const sources = groups ?? stores.list;
    // (#1948: its levels read it while the folds its reads would have saved are less than the index's construction, its
    // names and sources. A read from the index folds its property's holders alone, so it saves the sources without the
    // property: all for an absent one, none for one every source holds. Its sources' names are counted once its reads
    // could pay for the least index, at most all sources but one saved a read against one name a source
    // (`propertyIndex` charges at least two units a source), so that a prefix of two objects read fewer than four times
    // takes its levels alone, as before #1948; each name's holders, once they could pay for this index, so that a prefix
    // of a few wide objects read twice is never counted; from then on each read adds the sources its own property
    // lacks, until they reach the index's construction. Objects read only at properties they all hold are never
    // indexed; k objects of a distinct property each are, at their fifth read; k objects of k shared properties
    // read at absent ones, at about their 2k-th)
    if (levels.reads * (sources.length - 1) < 2 * sources.length) return null;
    if (index === undefined) {
      // (its sources' property names)
      let names = 0;
      const count = (literal: PlaceId): void => {
        work.charge("structureSteps");
        names += contract.literalIndex(literal).root.objects!.list[0]!.names.size;
      };
      if (groups === null) for (const entry of stores.list) count(entry.value!);
      else for (const group of groups) count(group.literal);
      contract.keep(2);
      contract.propertyIndexes.set(
        stores,
        (index = Retained.record<PropertyReads>("Contract.propertyIndexes.draft", {
          names,
          holding: null,
          saved: 0,
        })),
      );
    }
    // (the index, made at an earlier read or just now, its holding and savings filled in place below)
    amend(index);
    const cost = index.names + sources.length;
    if (index.holding === null) {
      if (levels.reads * (sources.length - 1) < cost) return null;
      const holding = Retained.map<string, number>("Contract.propertyIndexes.holding");
      const add = (literal: PlaceId): void => {
        for (const name of contract.literalIndex(literal).root.objects!.list[0]!.names) {
          work.charge("structureSteps");
          const known = holding.get(name);
          if (known === undefined) contract.keep(1);
          holding.set(name, (known ?? 0) + 1);
        }
      };
      if (groups === null) for (const entry of stores.list) add(entry.value!);
      else for (const group of groups) add(group.literal);
      index.holding = holding;
    }
    index.saved += sources.length - (index.holding.get(rest.at(0)!) ?? 0);
    if (index.saved < cost) return null;
    // (#1323: with the sharing on every group, F11's earliest lacking named among them as among entries off)
    const shared = groups === null ? null : { groups };
    index = propertyIndex(contract, stores.list, shared);
    contract.propertyIndexes.set(stores, index);
  }
  const step = rest.at(0)!;
  const path = pathAt(contract, 0, step);
  const holders = index.holders.get(path) ?? [];
  // (#1948: below a property every source holds, the index skips no source, and its walk of each holder costs more
  // than the levels' own fold)
  if (rest.length > 1 && holders.length === index.sources.length) return null;
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
      for (const item of yield* contract.entryAt(source.entry!, rest, flow)) out.push(item);
    }
  else {
    // (a fold's group stands where its first holder does: the holders in order, each group's first among them)
    let first = 0;
    for (const group of holderGroups(contract, index, holders, rest)) {
      work.charge("invSteps");
      while (holders[first]!.group!.literal !== group.literal) first += 1;
      before(holders[first]!.at);
      // (a literal stored whole: its group stands at the prefix itself)
      for (const item of yield* groupRead(contract, group, rest, flow)) out.push(item);
    }
  }
  before(Infinity);
  return out;
}

/**
 * #1948: a property's holders' groups at a path below a prefix of closed objects (`propertyItems`), the path's first
 * step the property: folded from the holders' groups at the prefix one step at a time, as `groupsAt` folds every
 * group, so each group's members stand in the order its parents merged at each step (a fold made at the path alone
 * would merge them in the holders' order). Once per index and path below a deeper read (`asked`), so the reads of the
 * path's group share its members' name (`membersKey`) as they do at `groupsAt`'s; a read of the property itself is
 * folded afresh unless a deeper read kept its fold. Never kept as the prefix's groups, whose complete list a read
 * without the index folds.
 */
function holderGroups(
  contract: Contract,
  index: PropertyIndex,
  holders: readonly PropertySource[],
  path: Rest,
  asked = path,
): readonly LevelGroup[] {
  const memoKey = joinParts(restPart(path));
  const known = index.folds.get(memoKey);
  if (known !== undefined) return known;
  // (a read of the property itself folds its holders afresh, keeping nothing, as before #1948)
  const kept = asked.length > 1;
  if (kept) contract.keepText(memoKey.length);
  contract.keep(path.length === 1 ? holders.length : 1);
  const groups = foldGroups(
    contract,
    path,
    path.length === 1
      ? holders.map((source) => source.group!)
      : holderGroups(contract, index, holders, restTo(contract, path, path.length - 1), asked),
  );
  if (kept) {
    index.folds.set(memoKey, groups);
  }
  return groups;
}

/**
 * S6c (the typed-ingress presets, S4's product): a prefix's entries that answer by themselves (`prefixLevels`), in
 * groups that answer alike at every path apart from their writers and ingress stores, once per prefix: adds of values
 * of one class (`classOf`, its ingresses by what their contract reads), each unguarded or each guarded, none holding
 * a mark (a holder of no guarded path, read or reference); any other entry its own group. An entry's ingress stores
 * reach only its unknowns (C9), an operator's result its operand's identity, so where the group's first answers
 * without either, it answers for the group, the earliest writer for its kinds (F28); k adds of a typed `load` of one
 * default, or of literals of two, each its own source, read at k fields, are one group read once per field
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
    entry,
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
 * `groupsAt`'s fold at a path of the groups one step above it (`parents`), the marks collected; for a path below a
 * property of a prefix of closed objects, its holders' groups alone (`propertyItems`).
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
  // (#1323: a merged group's members, made where it first merges; an unmerged group keeps its own list)
  const members: (LevelGroup[] | null)[] = [];
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
    // (its marks: alike where they cannot depend on steps past the path, else its own, §3.2)
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
      members.push(null);
      continue;
    }
    const into = groups[position]!;
    // (#1323: the members kept for the group's reads, structure shared by them:
    // docs/specifications/type-inference-accepted-record/solver-and-work.md#r4-349)
    program.work.shared(() => {
      contract.keep(group.members?.length ?? 1);
      let list = members[position]!;
      if (list === null) {
        contract.keep(into.members?.length ?? 1);
        members[position] = list = [...(into.members ?? [into])];
      }
      list.push(...(group.members ?? [group]));
    });
    groups[position] = {
      literal: into.literal,
      at: into.at,
      w: firstWriter(into.w, group.w),
      holder: into.holder,
      guarded: into.guarded || group.guarded,
      ingress: program.scope.ingress.union(into.ingress, group.ingress),
    };
  }
  for (const [position, list] of members.entries()) {
    if (list === null) continue;
    program.work.shared(() => {
      // (its members' identity and whether they stand at the same steps, once: every read of the group asks them)
      const first = contract.joined(list[0]!.at, ".");
      const alike = list.every((member) => contract.joined(member.at, ".") === first);
      // (a short name for the list, made once: a read's scan key never spells its members out)
      const known = MEMBER_LISTS().get(contract) ?? 0;
      MEMBER_LISTS().set(contract, known + 1);
      const membersKey = `m${known}`;
      groups[position] = { ...groups[position]!, members: list, membersKey, alike };
    });
  }
  return groups;
}

/**
 * #1323 (docs/specifications/type-inference-accepted-record/sharing.md#r4-371): a group's items at `rest` (below its
 * steps), annotated and with its writer, F11's pure `missing` among them named as the unshared join names it: by the
 * earliest (`firstWriter`, F28) `missing` writer among its members' own completed reads there, each
 * `contractOfValueAt(member.literal, member.at + rest)`, the other items, reasons, context and the holder's position
 * the group's; `EMPTY` has no writer. The fold's equivalence proves where its members hold a `missing`: only where the
 * group's items do. Reads the equivalence proves alike share one scan of the members (`absenceClass`); where none is
 * proved (a member's read reaching a `.get`, a call's result, other steps), the read declines the fold and each member
 * answers as its entry does with the sharing off. Either way the reads beyond the group's own are its provenance,
 * counted to the total and not to the asking decision (`sharedSteps`,
 * docs/specifications/type-inference-accepted-record/solver-and-work.md#r4-349).
 */
export function* groupRead(
  contract: Contract,
  group: LevelGroup,
  rest: Rest,
  flow: FlowSink | null,
): Work<readonly Item[]> {
  const { work } = contract.pass.program;
  const missing = (item: Item): boolean =>
    item.tag === "unknown" && item.reasons === REASON.missing;
  const literal = flow?.child() ?? null;
  let items = yield* contract.contractOfValueAt(
    group.literal,
    isSteps(rest) ? joinSteps(group.at, rest) : rest.after(group.at),
    literal,
  );
  const list = group.members;
  if (list !== undefined && items.some(missing)) {
    const shared = work.shared(() => absenceClass(contract, group, items.filter(missing)));
    if (shared === null) {
      // (the fold declined: each member as its entry; the first's is the group's own read, already made)
      const first = list[0]!.entry!;
      const out: Item[] = [
        ...annotated(contract, first, restRef(contract, rest), withWriter(items, first.w)),
      ];
      if (literal !== null) flow!.attach(literal, "annotated", "writer");
      for (const member of list.slice(1))
        // #1668: I, each member's entry read takes the flow (`entryAt`)
        for (const item of yield* work.sharedSteps(contract.entryAt(member.entry!, rest, flow)))
          out.push(item);
      // (merged here, so its reader merges what the group's own read would give it)
      return work.shared(() => mergeItems(out, contract.pass.program.scope));
    }
    const kept = keptAbsences(contract);
    let earliest = kept.get(shared);
    if (earliest === undefined) {
      let own = true;
      earliest = null;
      for (const member of list) {
        let found = false;
        // #1668: K, a member's own read names the writer of the group's `missing`; none of its items is included
        for (const item of yield* work.sharedSteps(
          contract.contractOfValueAt(
            member.literal,
            isSteps(rest) ? joinSteps(member.at, rest) : rest.after(member.at),
          ),
        )) {
          if (!missing(item) || item.writer === null) continue;
          found = true;
          const writer = item.writer;
          own &&= work.shared(() => ownAbsence(contract, member.literal).has(writer));
          earliest = firstWriter(earliest, item.writer);
        }
        own &&= found;
      }
      // (kept where every writer is a member's own object: its literal's structure, never a solver answer)
      const found = earliest;
      if (own) work.shared(() => (contract.keepText(shared.length), kept.set(shared, found)));
    }
    const writer = earliest;
    if (writer !== null) items = items.map((item) => (missing(item) ? { ...item, writer } : item));
  }
  if (literal !== null) flow!.attach(literal, "groupFirst", "annotated", "writer");
  return annotated(contract, group, rest, withWriter(items, group.w));
}

/**
 * The scan a group's read shares with the other reads of its members (`groupRead`), or `null`: where its members
 * stand at the same steps and each `missing` it holds is its first member's own object, at a node of its own literal
 * and a position there. Their fold keys hold, at each step and below, the same objects' names in the same order, so at
 * each such node every member lacks a step at the same position as the first: every read whose missing stand there
 * names the same objects of each member, whatever step below it lacks.
 */
function absenceClass(
  contract: Contract,
  group: LevelGroup,
  missing: readonly Item[],
): string | null {
  if (group.alike !== true) return null;
  const own = ownAbsence(contract, group.literal);
  const places: string[] = [];
  for (const item of missing) {
    const place = item.writer === null ? undefined : own.get(item.writer);
    if (place === undefined) return null;
    places.push(place);
  }
  return joinParts(
    "absent",
    group.membersKey!,
    contract.joined(group.at, "."),
    contract.joined([...new Set(places)].sort(), ","),
  );
}

/**
 * A literal's own objects, by token, each its node's path id and position: a `missing` naming one is the literal's
 * structure alone (`lackingAt`), never a solver answer, so a scan of such missing is kept for the pass. Once per
 * literal, each node charged as it is found (`nodeAt`).
 */
function ownAbsence(contract: Contract, literal: PlaceId): ReadonlyMap<Writer, string> {
  const index = contract.literalIndex(literal);
  let known = OWN_ABSENCE().get(index);
  if (known === undefined) {
    // (structure shared by every read of the literal, counted to the total and not to the asking decision:
    // docs/specifications/type-inference-accepted-record/solver-and-work.md#r4-349)
    known = contract.pass.program.work.shared(() => ownObjects(contract, index));
    OWN_ABSENCE().set(index, known);
  }
  return known;
}

/** `ownAbsence`'s map of one literal index. */
function ownObjects(contract: Contract, index: LiteralIndex): Map<Writer, string> {
  const known = Retained.map<Writer, string>("levels.OWN_ABSENCE[]");
  for (const [position, object] of (index.root.objects?.list ?? []).entries()) {
    contract.keep(1);
    known.set(object.token, `0:${position}`);
  }
  for (const [id] of indexPaths(contract, index))
    for (const [position, object] of (nodeAt(contract, index, id)?.objects?.list ?? []).entries()) {
      contract.keep(1);
      known.set(object.token, `${id}:${position}`);
    }
  return known;
}

/** The member lists named so far, per contract (a pass's): their count. */
const MEMBER_LISTS = retainedModule("levels.MEMBER_LISTS", Retained.weakMap<Contract, number>);

/** `ownAbsence`'s maps, per literal index. */
const OWN_ABSENCE = retainedModule(
  "levels.OWN_ABSENCE",
  Retained.weakMap<object, Map<Writer, string>>,
);

/** `groupRead`'s kept scans, per contract (a pass's): by class, the earliest writer. */
function keptAbsences(contract: Contract): Map<string, Writer | null> {
  let kept = KEPT_ABSENCES().get(contract);
  if (kept === undefined)
    KEPT_ABSENCES().set(contract, (kept = Retained.map("levels.KEPT_ABSENCES[]")));
  return kept;
}
const KEPT_ABSENCES = retainedModule(
  "levels.KEPT_ABSENCES",
  Retained.weakMap<Contract, Map<string, Writer | null>>,
);

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
  const at = Retained.map<number, string>("Contract.literalLevels.at");
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
  const below = Retained.map<number, string>("Contract.literalLevels.below");
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
