// A decider's groups and regions over the carriers' transfers: its members, entries and paths, the caches it is made
// with, and the distinct values a region decides.

import type { PlaceId, TypeTerm } from "../../../graph.js";
import type { Admission } from "../../admission.js";
import {
  stepsAfter,
  stepsFrom,
  type PathRef,
  type Rest,
  type Steps,
} from "../../contract/key-ids.js";
import { keep, keepText, keptParts } from "../../budget.js";
import { writtenOf } from "../../contract.js";
import { keyPlace, sortCost } from "../../definitions.js";
import { withoutEmpty } from "../../exact-path.js";
import type { ItemTag } from "../../items.js";
import { sharing } from "../../sharing.js";
import { deciding } from "../kinds.js";
import { chooses, live, snapshotOf } from "../links.js";
import type { Expansion, Part } from "../model.js";
import type { Reads } from "../../inherited/reads.js";
import { partOfRead, TYPED_ROLES } from "../walk.js";

// The carriers' transfers: what a stored value's walk answers, over its tasks' recipes (`expand`): each
// carrier's operands answer once per pass, whatever value walks to them, a literal's cells with their literal, by path,
// as a walk lists its stops.

/**
 * A task as the decider enters it (`transferredDecider`): its lanes (`Stop.deep`, `Stop.single`) and what the
 * operations above it give it, each link's own answer (`chooses`, `TYPED_ROLES`) folded in: whether one is a typed
 * default's (a value there decides nothing), whether each gives the operand the walk took, and surely gives it;
 * whether one is a list join (`ViaChain.joined`).
 */
export interface Member {
  readonly task: Expansion;
  readonly deep: boolean;
  readonly single: boolean;
  readonly typed: boolean;
  readonly chosen: boolean;
  readonly surely: boolean;
  readonly joined: boolean;
}

/**
 * One entry of a decider group's region (`Region`), at its rank in its key's order: a task's own stop, with the member
 * it is reached from (whose gate and mask apply) and its lanes; or the parts at one position of a carrier in the
 * region, a group of their own (`bound`), with per member of it the member above and its operation.
 */
export interface Entry {
  readonly rank: number;
  readonly member: number;
  readonly task: Expansion;
  readonly deep: boolean;
  readonly single: boolean;
  readonly bound: {
    readonly group: DeciderGroup;
    readonly from: readonly number[];
    readonly through: readonly (Expansion | null)[];
    readonly roles: readonly (string | null)[];
  } | null;
  /** A call a list join carries, among the written copies (`writtenResult`). */
  readonly call?: boolean;
}

/**
 * A decider group's region: its members' tasks and the cells of the literals among them, at any depth, by the path
 * each stands at below the group's (as a walk's stops are listed, `stopsOf`), each path's entries in their key's order:
 * its values with the groups of the operands of its carriers, its literals, and its written copies. A path is a node
 * one step below its parent's, never an array or a text, so a literal nested k deep is k nodes, not k paths of up to k
 * steps each (#1438); a decided path's rest is followed step by step (`forEachPath`).
 */
interface Region {
  readonly root: RegionPath;
  /** Whether a written copy stands at any of its paths (`holdsWritten`). */
  readonly written: boolean;
  /** The groups of its carriers' operands, path by path as each first held a value (`holdsWritten` asks them so). */
  readonly bound: readonly DeciderGroup[];
}

/** One path of a region: its entries and the paths one step longer, by step. */
export interface RegionPath {
  readonly values: Entry[];
  readonly literals: Entry[];
  readonly written: Entry[];
  readonly below: Map<string, RegionPath>;
  /** Its values with each snapshot or class once (`distinctAt`), above a decided path's end and at it. */
  distinct: readonly Entry[] | null;
  distinctAtEnd: readonly Entry[] | null;
  /** Its written copies with each snapshot once per member (`writtenAt`). */
  representatives: readonly Entry[] | null;
}

/**
 * The tasks of a walk that share one evaluation key (`EvaluationKey`), whatever path is decided: a value's own, or the
 * operands at one position of a carrier (a choice's rows of one option, merged in their key's order),
 * each with what reached it. Made once per pass by its members (`groupOf`), its region when first asked, whether a
 * written copy stands in it or below it at all, and its answers per decided path's rest and mask.
 */
export interface DeciderGroup {
  readonly members: readonly Member[];
  region: Region | null;
  holdsWritten: boolean | null;
  readonly written: Map<number, boolean>;
  /** Whether a literal task stands on the path, per rest (`literalOn`), apart from `written`. */
  readonly literal: Map<number, boolean>;
  /** Whether a member is a literal with a cell read through a projection (`literalOn`), once asked. */
  cellMember: boolean | null;
  /**
   * #2289: per rest, `literalOn`'s visit of the region's path as `writtenOn` reads it (whether a written copy there
   * asks a type, and the groups below), so the decided path is walked once for both.
   */
  readonly visits: Map<
    number,
    { readonly asks: boolean; readonly below: readonly { group: DeciderGroup; rest: number }[] }
  >;
  readonly values: Map<string, DecidingValue | null>;
}

/**
 * The maps the decider's groups are made and answered with: the pass's own (`Admission.deciderCaches`), or the
 * written-decider summary's after a stop forgot answers they were made from (`summaryCaches`), with its answers.
 */
export interface DeciderCaches {
  readonly deciders: Map<string, DeciderGroup>;
  readonly linkTests: Map<string, boolean>;
  readonly linkKinds: Map<string, Set<ItemTag>>;
  /** The summary's answer per group, by its rest's id, masks and linked members (`writtenDecider`). */
  readonly summaries: WeakMap<DeciderGroup, Map<string, WrittenSummary>>;
}

/** A value that decides a path (`transferredDecider`), with the kinds it decides by there. */
export interface DecidingValue {
  readonly value: PlaceId;
  readonly tags: readonly ItemTag[];
}

/** A group by its members' tasks, lanes and links' answers, once per pass. */
export function groupOf(
  admission: Admission,
  members: readonly Member[],
  caches: DeciderCaches = admission.deciderCaches,
): DeciderGroup {
  let name = "";
  for (const { task, deep, single, typed, chosen, surely, joined } of members) {
    admission.pass.program.work.charge("checks");
    name += `${name === "" ? "" : ","}${task.id}${deep ? "d" : ""}${single ? "s" : ""}${typed ? "t" : ""}${chosen ? "c" : ""}${surely ? "u" : ""}${joined ? "j" : ""}`;
  }
  keepText(admission.work, name.length);
  const known = caches.deciders.get(name);
  if (known !== undefined) return known;
  keep(admission.work, 1 + members.length);
  const group: DeciderGroup = {
    members,
    region: null,
    holdsWritten: null,
    written: new Map(),
    literal: new Map(),
    visits: new Map(),
    cellMember: null,
    values: new Map(),
  };
  caches.deciders.set(name, group);
  return group;
}

/** One operation's answer for the operand of one of its task's parts (`chooses`), once per part and certainty. */
function* linkTest(
  admission: Admission,
  task: Expansion,
  index: number,
  part: Part,
  surely: boolean,
  caches: DeciderCaches,
): Reads<boolean> {
  const name = keptParts(admission.work, task.id, index, surely);
  let known = caches.linkTests.get(name);
  if (known === undefined) {
    known = yield* chooses(
      admission,
      { value: task.value, node: task.node, operand: part.value },
      surely,
    );
    caches.linkTests.set(name, known);
  }
  return known;
}

/** Whether a value is a call with a written result (`earliestDecider` reads it by that type where a join carries it). */
function writtenResult(admission: Admission, value: PlaceId): boolean {
  const { program, contract } = admission.pass;
  const key = contract.resultKey(value);
  return key !== null && writtenOf(program.place(keyPlace(key)).kind) !== null;
}

/**
 * A group's region, made once (on an explicit stack, in the walk's key order: a node's own stops, then its parts by
 * position, a literal's cell walked here as it is met, a carrier's operands at one position a group of their own).
 */
export function* regionOf(
  admission: Admission,
  group: DeciderGroup,
  caches: DeciderCaches = admission.deciderCaches,
): Reads<Region> {
  if (group.region !== null) return group.region;
  const work = admission.pass.program.work;
  const emptyPath = (): RegionPath => ({
    values: [],
    literals: [],
    written: [],
    below: new Map(),
    distinct: null,
    distinctAtEnd: null,
    representatives: null,
  });
  const root = emptyPath();
  // (its paths in the order each first held a value, as `holdsWritten` asks their operands' groups)
  const valued: RegionPath[] = [];
  const value = (path: RegionPath, entry: Entry): void => {
    if (path.values.length === 0) valued.push(path);
    path.values.push(entry);
  };
  interface Item {
    readonly member: number;
    readonly task: Expansion;
    readonly deep: boolean;
    readonly single: boolean;
  }
  interface Frame {
    readonly items: readonly Item[];
    readonly path: RegionPath;
    positions:
      | readonly {
          readonly step: string | null;
          readonly items: readonly Item[];
          readonly bound: Member[];
          readonly from: number[];
          readonly through: (Expansion | null)[];
          readonly roles: (string | null)[];
        }[]
      | null;
    next: number;
  }
  let rank = 0;
  const stack: Frame[] = [
    {
      items: group.members.map((member, at) => ({
        member: at,
        task: member.task,
        deep: member.deep,
        single: member.single,
      })),
      path: root,
      positions: null,
      next: 0,
    },
  ];
  let written = false;
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    const here = frame.path;
    if (frame.positions === null) {
      const byPosition = new Map<
        string,
        {
          position: number;
          step: string | null;
          items: Item[];
          bound: Member[];
          from: number[];
          through: (Expansion | null)[];
          roles: (string | null)[];
        }
      >();
      for (const item of frame.items) {
        const entry = (): Entry => ({ ...item, rank: rank++, bound: null });
        if (item.task.inherits !== null) here.written.push(entry());
        const stop = item.task.stop;
        if (stop?.list === "written") here.written.push(entry());
        else if (stop?.list === "literals") here.literals.push(entry());
        else if (stop?.list === "values") value(here, entry());
        const above = group.members[item.member]!;
        // (a call a list join carries is read by its written result, as a written copy is, so the scan of the stops
        // answers there, `earliestDecider`; since #2378 such a call is a written stop too, and this entry answers
        // alike)
        if (stop?.list === "values" && above.joined && writtenResult(admission, item.task.value))
          here.written.push({ ...entry(), call: true });
        for (const [index, part] of item.task.parts.entries()) {
          work.charge("checks");
          const key = `${part.position}:${part.step ?? ""}`;
          let at = byPosition.get(key);
          if (at === undefined)
            byPosition.set(
              key,
              (at = {
                position: part.position,
                step: part.step,
                items: [],
                bound: [],
                from: [],
                through: [],
                roles: [],
              }),
            );
          const task = yield* partOfRead(admission, part);
          const deep = part.deep ?? item.deep;
          const single = item.single && part.single;
          if (part.step !== null) {
            at.items.push({ member: item.member, task, deep, single });
            continue;
          }
          const linked = part.role !== null;
          at.bound.push({
            task,
            deep,
            single,
            typed: above.typed || (linked && TYPED_ROLES.has(part.role!)),
            chosen:
              above.chosen &&
              (!linked || (yield* linkTest(admission, item.task, index, part, false, caches))),
            surely:
              above.surely &&
              (!linked || (yield* linkTest(admission, item.task, index, part, true, caches))),
            joined: above.joined || part.role === "concatenation/operand",
          });
          at.from.push(item.member);
          at.through.push(linked ? item.task : null);
          at.roles.push(part.role);
        }
      }
      written ||= here.written.length > 0;
      const positions = [...byPosition.values()];
      work.charge("checks", sortCost(positions.length));
      positions.sort((a, b) => a.position - b.position);
      frame.positions = positions;
    }
    if (frame.next < frame.positions.length) {
      const at = frame.positions[frame.next++]!;
      if (at.bound.length > 0)
        value(here, {
          rank: rank++,
          member: at.from[0]!,
          task: at.bound[0]!.task,
          deep: at.bound[0]!.deep,
          single: at.bound[0]!.single,
          bound: {
            group: groupOf(admission, at.bound, caches),
            from: at.from,
            through: at.through,
            roles: at.roles,
          },
        });
      if (at.items.length > 0) {
        let next = here.below.get(at.step!);
        if (next === undefined) here.below.set(at.step!, (next = emptyPath()));
        stack.push({ items: at.items, path: next, positions: null, next: 0 });
      }
      continue;
    }
    stack.pop();
  }
  const bound: DeciderGroup[] = [];
  for (const path of valued)
    for (const entry of path.values) if (entry.bound !== null) bound.push(entry.bound.group);
  // (a path is kept for the entries at or below it, and rides on their units)
  keep(admission.work, 1 + rank);
  group.region = { root, written, bound };
  return group.region;
}

/**
 * A region's values at one path as the decider reads them: at the path's end without the values below an operation,
 * nor groups of only such operands, which decide nothing there; with the sharing on, of the values reached alike
 * (through one member and operation, at one strip and lanes) of an earlier one's class (`Contract.boundClass`) or
 * reading what it reads (its snapshot, `snapshotOf`), only the first: it answers as the first at every path and is
 * never read where the first decides nothing (`classFirsts`, `distinctStops`); so too of the operands at one position
 * of operations of one class, member by member. Once per group, path and end.
 */
export function distinctAt(admission: Admission, path: RegionPath, end: boolean): readonly Entry[] {
  const known = end ? path.distinctAtEnd : path.distinct;
  if (known !== null) return known;
  const remember = (list: readonly Entry[]): readonly Entry[] =>
    end ? (path.distinctAtEnd = list) : (path.distinct = list);
  // (at the path's end a value below an operation decides nothing: neither it nor a group of such operands is read)
  const all = path.values;
  const list = end
    ? all.filter((entry) =>
        entry.bound === null ? !entry.deep : entry.bound.group.members.some((m) => !m.deep),
      )
    : all;
  if (!sharing() || list.length < 2) return remember(list);
  const { contract } = admission.pass;
  const seen = new Set<string>();
  const out: Entry[] = [];
  // (a class by a short id within the list)
  const ids = new Map<string, number>();
  const idOf = (cls: string): number => {
    let id = ids.get(cls);
    if (id === undefined) ids.set(cls, (id = ids.size));
    return id;
  };
  // (a task's own stop by its member, strip, lanes and class; an operand group's by each member's, its operation's)
  const own = (
    member: number,
    task: Expansion,
    deep: boolean,
    single: boolean,
  ): readonly (string | number | boolean | readonly string[])[] | null => {
    const cls = contract.boundClass(task.value, true).cls;
    return cls === null
      ? null
      : [
          member,
          task.stop?.list ?? "",
          task.parts.length,
          task.strip,
          deep,
          single,
          idOf(cls),
          task.node.id,
        ];
  };
  for (const entry of list) {
    admission.pass.program.work.charge("checks");
    const names: string[] = [];
    if (entry.bound === null) {
      const { member, task, deep, single } = entry;
      const read = snapshotOf(admission, task.value);
      if (read !== null)
        names.push(keptParts(admission.work, "s", member, task.stop!.strip, deep, single, read));
      const parts = own(member, task, deep, single);
      if (parts !== null) names.push(keptParts(admission.work, "c", ...parts));
    } else {
      const { group, from, through, roles } = entry.bound;
      const parts: (string | number | boolean | readonly string[])[] = ["b"];
      for (const [index, member] of group.members.entries()) {
        const mine = own(from[index]!, member.task, member.deep, member.single);
        if (mine === null) {
          parts.length = 0;
          break;
        }
        // (its operation by its class, as a decider's chain names it, `viaClasses`)
        const above = through[index] ?? null;
        const cls = above === null ? null : contract.classOf(above.value, true);
        parts.push(
          ...mine,
          above === null ? "" : cls === null ? `v${above.value}` : idOf(cls),
          above?.node.id ?? -1,
          above?.strip ?? [],
          roles[index] ?? "",
          member.typed,
          member.chosen,
          member.surely,
        );
      }
      if (parts.length > 0) names.push(keptParts(admission.work, ...parts));
    }
    if (names.some((name) => seen.has(name))) continue;
    for (const name of names) seen.add(name);
    out.push(entry);
  }
  keep(admission.work, 1 + out.length);
  return remember(out);
}

/** Whether a written copy stands in a group's region or in a group below it (`writtenOn` asks only there), once. */
export function* holdsWritten(
  admission: Admission,
  root: DeciderGroup,
  caches: DeciderCaches = admission.deciderCaches,
): Reads<boolean> {
  if (root.holdsWritten !== null) return root.holdsWritten;
  function* bounds(group: DeciderGroup): Reads<readonly DeciderGroup[]> {
    return (yield* regionOf(admission, group, caches)).bound;
  }
  const stack: {
    readonly group: DeciderGroup;
    readonly below: readonly DeciderGroup[];
    next: number;
  }[] = [{ group: root, below: yield* bounds(root), next: 0 }];
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    if (frame.next === 0 && (yield* regionOf(admission, frame.group, caches)).written) {
      frame.group.holdsWritten = true;
      stack.pop();
      continue;
    }
    let found = false;
    while (frame.next < frame.below.length) {
      const child = frame.below[frame.next]!;
      admission.pass.program.work.charge("checks");
      if (child.holdsWritten === null) break;
      frame.next += 1;
      if (child.holdsWritten) {
        found = true;
        break;
      }
    }
    if (!found && frame.next < frame.below.length) {
      const child = frame.below[frame.next]!;
      stack.push({ group: child, below: yield* bounds(child), next: 0 });
      continue;
    }
    frame.group.holdsWritten = found;
    stack.pop();
  }
  return root.holdsWritten!;
}

/**
 * Whether an entry's written copy is one the decider asks its type (`earliestDecider`'s copies): at the path's end a
 * copy below an operation only where each literal it was read out of has it alone and each operation surely gives it;
 * a call a join carries wherever it stands.
 */
export function asksType(
  admission: Admission,
  group: DeciderGroup,
  entry: Entry,
  end: boolean,
): boolean {
  if (entry.call === true) return true;
  return !(
    entry.deep &&
    end &&
    !(entry.single && group.members[entry.member]!.surely && live(admission, entry.task.value))
  );
}

/**
 * The kinds an entry's own value decides by at the decided path's rest from `rest` (`earliestDecider`'s values), `null`
 * where it decides nothing: a value below an operation only above the path's end, a literal only at it and on no
 * operand; reached through no typed default and given by each operation; of definite kinds, no unknown beside them,
 * each held definitely by each operation above it (`mask`).
 */
export function* decides(
  admission: Admission,
  member: Member,
  entry: Entry,
  at: PathRef,
  rest: number,
  mask: ReadonlySet<ItemTag> | null,
): Reads<readonly ItemTag[] | null> {
  const { task } = entry;
  if ((rest === at.length && entry.deep) || member.typed || !member.chosen) return null;
  if (mask !== null && mask.size === 0) return null;
  const items = withoutEmpty(
    yield* admission.runRead(() =>
      admission.pass.values.valueItems(
        task.value,
        task.node,
        restAfter(task.stop!.strip, at, rest),
      ),
    ),
  );
  if (items.some((item) => item.tag === "unknown")) return null;
  const definite = deciding(items);
  return definite.length > 0 && (mask === null || definite.every((item) => mask.has(item.tag)))
    ? definite.map((item) => item.tag)
    : null;
}

export const EMPTY: ReadonlySet<ItemTag> = new Set();

/**
 * A member's mask below its operation (`through`): the kinds the operation's own value holds definitely at the decided
 * path's rest there, once per operation and rest; nothing where no value below it can decide.
 */
export function* narrowed(
  admission: Admission,
  mask: ReadonlySet<ItemTag> | null,
  member: Member,
  through: Expansion | null,
  at: PathRef,
  rest: number,
  id: number,
  caches: DeciderCaches = admission.deciderCaches,
): Reads<ReadonlySet<ItemTag> | null> {
  if (through === null) return mask;
  if (!member.chosen || member.typed || (mask !== null && mask.size === 0)) return EMPTY;
  const name = keptParts(admission.work, through.id, id);
  let held = caches.linkKinds.get(name);
  if (held === undefined) {
    held = new Set();
    for (const item of withoutEmpty(
      yield* admission.runRead(() =>
        admission.pass.values.valueItems(
          through.value,
          through.node,
          restAfter(through.strip, at, rest),
        ),
      ),
    ))
      if (item.cert === "def") held.add(item.tag);
    keep(admission.work, 1 + held.size);
    caches.linkKinds.set(name, held);
  }
  return mask === null ? held : new Set([...mask].filter((tag) => held!.has(tag)));
}

/** A mask's name in a group's answers: its kinds, `*` for every kind. */
export function maskName(mask: ReadonlySet<ItemTag> | null): string {
  return mask === null ? "*" : [...mask].sort().join(" ");
}

/**
 * A decided path's rest from step `rest`, after a strip: an array's joined; a span's a view, its path's id one step
 * from its parent's (`joinedId`), never made.
 */
export function restAfter(strip: readonly string[], at: PathRef, rest: number): Rest {
  return at.kind === "span"
    ? at.from(rest).after(strip)
    : stepsAfter(strip, stepsFrom(at.steps(), rest));
}

/** The ids of a decided path's rests (`ids[k]` the rest from step `k`), one per distinct rest in the pass. */
export function restIds(admission: Admission, at: Steps): number[] {
  const ids: number[] = [];
  ids[at.length] = 0;
  for (let index = at.length - 1; index >= 0; index -= 1) {
    const name = keptParts(admission.work, ids[index + 1]!, at.at(index)!);
    let id = admission.restIds.get(name);
    if (id === undefined) admission.restIds.set(name, (id = admission.restIds.size + 1));
    ids[index] = id;
  }
  return ids;
}

/**
 * Each prefix of a decided path's rest from `rest`, with its length, the empty one first, and the region's path there:
 * `null` past the region's paths, where nothing stands.
 */
export function forEachPath(
  region: Region,
  at: PathRef,
  rest: number,
  visit: (path: RegionPath | null, length: number) => void,
): void {
  let path: RegionPath | null = region.root;
  for (let length = 0; rest + length <= at.length; length += 1) {
    if (length > 0) path = path?.below.get(at.at(rest + length - 1)) ?? null;
    // (a span's walk ends past the region's paths, where nothing stands: no visit per step beyond)
    if (path === null && at.kind === "span") break;
    visit(path, length);
  }
}

/**
 * `forEachPath` of a visit that makes reads (`Read`), each path visited where `forEachPath` visits it (#1072: a read
 * inside an inherited proof is yielded, never run).
 */
export function* forEachPathRead(
  region: Region,
  at: PathRef,
  rest: number,
  visit: (path: RegionPath | null, length: number) => Reads<void>,
): Reads<void> {
  let path: RegionPath | null = region.root;
  for (let length = 0; rest + length <= at.length; length += 1) {
    if (length > 0) path = path?.below.get(at.at(rest + length - 1)) ?? null;
    if (path === null && at.kind === "span") break;
    yield* visit(path, length);
  }
}

/** A written copy that decides a path in a group's region or below it, at its depth below the group's own path. */
export interface WrittenCandidate {
  readonly term: TypeTerm;
  readonly value: PlaceId;
  readonly joined: boolean;
  /** A call a list join carries, read by its written result (`Entry.call`). */
  readonly call: boolean;
  readonly depth: number;
  /** Whether it decides at its own level: no step of the asked path is left below it (#1901). */
  readonly own: boolean;
}

/**
 * #1444: what a group's region decides at a rest of the path, for the masks and linked members it is asked with
 * (`writtenDecider`): its earliest written copy whose type decides (a list join's only of definite kinds), its
 * earliest deciding value, which of the two comes first, the shallowest list join whose written operand leaves the
 * path open, and whether a joined written operand holds `null`.
 */
export interface WrittenSummary {
  readonly copy: WrittenCandidate | null;
  readonly first: DecidingValue | null;
  readonly copyFirst: boolean;
  readonly open: WrittenCandidate | null;
  readonly joinedNull: boolean;
}
