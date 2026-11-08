import type { PlaceId, SourceSite, TypeTerm } from "../../graph.js";
import type { Admission } from "../admission.js";
import {
  restRef,
  restSteps,
  stepsAfter,
  stepsFrom,
  type PathRef,
  type Rest,
  type Steps,
} from "../contract/key-ids.js";
import { keep, keepText, keptParts, keptSteps, keptText } from "../budget.js";
import { typeTags, writtenOf } from "../contract.js";
import { keyPath, keyPlace, sortCost, type Key } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import type { ItemTag } from "../items.js";
import { isPlusValue, plusRun } from "../plus-index.js";
import { sharing } from "../sharing.js";
import { deciding } from "./kinds.js";
import { chooses, live, snapshotOf } from "./links.js";
import type { Expansion, Inheriting, Part } from "./model.js";
import { contributionOf } from "./own.js";
import { joinedDomain, permittedAt } from "./permitted.js";
import { inheritedInto } from "../inherited/waiting.js";
import { partOf, TYPED_ROLES } from "./walk.js";

// The carriers' transfers (G3 2c): what a stored value's walk answers, over its tasks' recipes (`expand`): each
// carrier's operands answer once per pass, whatever value walks to them, a literal's cells with their literal, by path,
// as a walk lists its stops.

/** A task's contributions to A2's held view (`heldMeetings`), each once, by text, at its path below the task's own. */
export interface HeldInput {
  readonly points: ReadonlyMap<string, readonly string[]>;
  readonly reads: ReadonlyMap<string, { readonly at: readonly string[]; readonly source: Key }>;
}

const NOTHING: HeldInput = { points: new Map(), reads: new Map() };

/**
 * A2's held view of a task (`ownOf`'s, its place's copies list empty), once per task and lane (`deep`: below an
 * operation): its own stop's point (a literal, a written copy, a value of scalar kinds read whole) or read (a value's
 * source where it is no operand), and its parts', each where it stands; a copy that may inherit stands below and
 * decides nothing here. A literal is walked with the literals nested in it as cells, each one's own at its path; any
 * other part's input is its own, joined where it stands. A part's input is taken whole where the task adds nothing to
 * it, so a carrier around a carrier keeps one input, never a list per level.
 */
export function heldInput(admission: Admission, task: Expansion, deep: boolean): HeldInput {
  const memo = admission.heldInputs;
  const name = (at: Expansion, lane: boolean): string => (lane ? `d${at.id}` : `${at.id}`);
  const known = memo.get(name(task, deep));
  if (known !== undefined) return known;
  const work = admission.pass.program.work;
  interface Frame {
    readonly name: string;
    readonly own: HeldInput;
    readonly parts: readonly {
      readonly task: Expansion;
      readonly deep: boolean;
      readonly at: readonly string[];
    }[];
    next: number;
  }
  const open = (root: Expansion, lane: boolean): Frame => {
    const points = new Map<string, readonly string[]>();
    const reads = new Map<string, { readonly at: readonly string[]; readonly source: Key }>();
    const parts: Frame["parts"][number][] = [];
    const pending: (readonly [Expansion, boolean, readonly string[]])[] = [[root, lane, []]];
    while (pending.length > 0) {
      const [current, within, at] = pending.pop()!;
      work.charge("indexSteps");
      const stop = current.stop;
      if (stop !== null) {
        const contribution =
          stop.list === "values"
            ? contributionOf(admission, current.value, stop.strip, within)
            : "point";
        if (contribution === "point") points.set(keptText(admission.work, at), at);
        else if (typeof contribution === "object")
          reads.set(keptParts(admission.work, at, contribution.read), {
            at,
            source: contribution.read,
          });
      }
      for (const part of current.parts) {
        const child = partOf(admission, part);
        const childLane = part.deep ?? within;
        if (part.step === null) parts.push({ task: child, deep: childLane, at });
        else {
          const below = keptSteps(admission.work, at, [part.step]);
          if (child.stop?.list === "literals") pending.push([child, childLane, below]);
          else parts.push({ task: child, deep: childLane, at: below });
        }
      }
    }
    return { name: name(root, lane), own: { points, reads }, parts, next: 0 };
  };
  // (each task after its parts, on an explicit stack: a nest of any depth never deepens the native one)
  const stack: Frame[] = [open(task, deep)];
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    if (frame.next < frame.parts.length) {
      const part = frame.parts[frame.next++]!;
      if (!memo.has(name(part.task, part.deep))) stack.push(open(part.task, part.deep));
      continue;
    }
    stack.pop();
    const inputs: { readonly input: HeldInput; readonly at: readonly string[] }[] = [];
    if (frame.own.points.size + frame.own.reads.size > 0) inputs.push({ input: frame.own, at: [] });
    for (const part of frame.parts) {
      const input = memo.get(name(part.task, part.deep))!;
      if (input.points.size + input.reads.size > 0) inputs.push({ input, at: part.at });
    }
    memo.set(frame.name, united(admission, inputs));
  }
  return memo.get(name(task, deep))!;
}

/**
 * The union of held inputs, each below its path: the largest at the task's own path taken whole, the others' entries
 * it lacks added to a copy of it, each charged as kept before it is made.
 */
function united(
  admission: Admission,
  inputs: readonly { readonly input: HeldInput; readonly at: readonly string[] }[],
): HeldInput {
  const work = admission.pass.program.work;
  let base: HeldInput = NOTHING;
  let largest = -1;
  for (const [index, { input, at }] of inputs.entries())
    if (
      at.length === 0 &&
      (largest < 0 || input.points.size + input.reads.size > base.points.size + base.reads.size)
    ) {
      base = input;
      largest = index;
    }
  let points: Map<string, readonly string[]> | null = null;
  let reads: Map<string, { readonly at: readonly string[]; readonly source: Key }> | null = null;
  for (const [index, { input, at: below }] of inputs.entries()) {
    if (index === largest) continue;
    for (const [text, path] of input.points) {
      work.charge("checks");
      const at = below.length === 0 ? path : keptSteps(admission.work, below, path);
      const name = below.length === 0 ? text : keptText(admission.work, at);
      if ((points ?? base.points).has(name)) continue;
      points ??= new Map(base.points);
      keep(admission.work, 1);
      points.set(name, at);
    }
    for (const { at: where, source } of input.reads.values()) {
      work.charge("checks");
      const at = below.length === 0 ? where : keptSteps(admission.work, below, where);
      const name = keptParts(admission.work, at, source);
      if ((reads ?? base.reads).has(name)) continue;
      reads ??= new Map(base.reads);
      keep(admission.work, 1);
      reads.set(name, { at, source });
    }
  }
  if (points !== null) keep(admission.work, base.points.size);
  if (reads !== null) keep(admission.work, base.reads.size);
  return points === null && reads === null
    ? base
    : { points: points ?? base.points, reads: reads ?? base.reads };
}

/**
 * A task as the decider enters it (`transferredDecider`): its lanes (`Stop.deep`, `Stop.single`) and what the
 * operations above it give it, each link's own answer (`chooses`, `TYPED_ROLES`) folded in: whether one is a typed
 * default's (a value there decides nothing, F18), whether each gives the operand the walk took, and surely gives it;
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
interface Entry {
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
interface RegionPath {
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
 * operands at one position of a carrier (a choice's rows of one option, merged in their key's order: S6's interleave),
 * each with what reached it. Made once per pass by its members (`groupOf`), its region when first asked, whether a
 * written copy stands in it or below it at all, and its answers per decided path's rest and mask.
 */
export interface DeciderGroup {
  readonly members: readonly Member[];
  region: Region | null;
  holdsWritten: boolean | null;
  readonly written: Map<number, boolean>;
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
function groupOf(
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
    values: new Map(),
  };
  caches.deciders.set(name, group);
  return group;
}

/** One operation's answer for the operand of one of its task's parts (`chooses`), once per part and certainty. */
function linkTest(
  admission: Admission,
  task: Expansion,
  index: number,
  part: Part,
  surely: boolean,
  caches: DeciderCaches,
): boolean {
  const name = keptParts(admission.work, task.id, index, surely);
  let known = caches.linkTests.get(name);
  if (known === undefined) {
    known = chooses(admission, { value: task.value, node: task.node, operand: part.value }, surely);
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
function regionOf(
  admission: Admission,
  group: DeciderGroup,
  caches: DeciderCaches = admission.deciderCaches,
): Region {
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
        // answers there: F20, `earliestDecider`)
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
          const task = partOf(admission, part);
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
              (!linked || linkTest(admission, item.task, index, part, false, caches)),
            surely:
              above.surely &&
              (!linked || linkTest(admission, item.task, index, part, true, caches)),
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
function distinctAt(admission: Admission, path: RegionPath, end: boolean): readonly Entry[] {
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
function holdsWritten(
  admission: Admission,
  root: DeciderGroup,
  caches: DeciderCaches = admission.deciderCaches,
): boolean {
  if (root.holdsWritten !== null) return root.holdsWritten;
  const bounds = (group: DeciderGroup): readonly DeciderGroup[] =>
    regionOf(admission, group, caches).bound;
  const stack: {
    readonly group: DeciderGroup;
    readonly below: readonly DeciderGroup[];
    next: number;
  }[] = [{ group: root, below: bounds(root), next: 0 }];
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    if (frame.next === 0 && regionOf(admission, frame.group, caches).written) {
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
      stack.push({ group: child, below: bounds(child), next: 0 });
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
function asksType(admission: Admission, group: DeciderGroup, entry: Entry, end: boolean): boolean {
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
function decides(
  admission: Admission,
  member: Member,
  entry: Entry,
  at: PathRef,
  rest: number,
  mask: ReadonlySet<ItemTag> | null,
): readonly ItemTag[] | null {
  const { task } = entry;
  if ((rest === at.length && entry.deep) || member.typed || !member.chosen) return null;
  if (mask !== null && mask.size === 0) return null;
  const items = withoutEmpty(
    admission.run(
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

const EMPTY: ReadonlySet<ItemTag> = new Set();

/**
 * A member's mask below its operation (`through`): the kinds the operation's own value holds definitely at the decided
 * path's rest there, once per operation and rest; nothing where no value below it can decide.
 */
function narrowed(
  admission: Admission,
  mask: ReadonlySet<ItemTag> | null,
  member: Member,
  through: Expansion | null,
  at: PathRef,
  rest: number,
  id: number,
  caches: DeciderCaches = admission.deciderCaches,
): ReadonlySet<ItemTag> | null {
  if (through === null) return mask;
  if (!member.chosen || member.typed || (mask !== null && mask.size === 0)) return EMPTY;
  const name = keptParts(admission.work, through.id, id);
  let held = caches.linkKinds.get(name);
  if (held === undefined) {
    held = new Set();
    for (const item of withoutEmpty(
      admission.run(
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
function maskName(mask: ReadonlySet<ItemTag> | null): string {
  return mask === null ? "*" : [...mask].sort().join(" ");
}

/**
 * A decided path's rest from step `rest`, after a strip: an array's joined as before; a span's a view, its path's id
 * one step from its parent's (`joinedId`), never made (G3 stage 1).
 */
function restAfter(strip: readonly string[], at: PathRef, rest: number): Rest {
  return at.kind === "span"
    ? at.from(rest).after(strip)
    : stepsAfter(strip, stepsFrom(at.steps(), rest));
}

/** The ids of a decided path's rests (`ids[k]` the rest from step `k`), one per distinct rest in the pass. */
function restIds(admission: Admission, at: Steps): number[] {
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
function forEachPath(
  region: Region,
  at: PathRef,
  rest: number,
  visit: (path: RegionPath | null, length: number) => void,
): void {
  let path: RegionPath | null = region.root;
  for (let length = 0; rest + length <= at.length; length += 1) {
    if (length > 0) path = path?.below.get(at.at(rest + length - 1)) ?? null;
    // (a span's walk ends past the region's paths, where nothing stands: no visit per step beyond, G3 stage 1)
    if (path === null && at.kind === "span") break;
    visit(path, length);
  }
}

/**
 * Whether a written copy on the decided path asks a type in a group's region or in a group below it (`asksType`),
 * once per group and rest: only where one stands at all (`holdsWritten`).
 */
function writtenOn(
  admission: Admission,
  root: DeciderGroup,
  at: PathRef,
  ids: (rest: number) => number,
): boolean {
  interface Frame {
    readonly group: DeciderGroup;
    readonly rest: number;
    below: readonly { readonly group: DeciderGroup; readonly rest: number }[] | null;
    next: number;
  }
  const stack: Frame[] = [{ group: root, rest: 0, below: null, next: 0 }];
  let answer: boolean | null = null;
  const finish = (value: boolean): void => {
    const frame = stack.pop()!;
    frame.group.written.set(ids(frame.rest), value);
    answer = value;
  };
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    const { group, rest } = frame;
    if (answer !== null) {
      if (answer) {
        finish(true);
        continue;
      }
      answer = null;
    } else if (frame.below === null) {
      const known = group.written.get(ids(rest));
      if (known !== undefined || !holdsWritten(admission, group)) {
        stack.pop();
        answer = known ?? false;
        continue;
      }
      let asks = false;
      const below: { group: DeciderGroup; rest: number }[] = [];
      forEachPath(regionOf(admission, group), at, rest, (path, length) => {
        admission.pass.program.work.charge("checks");
        for (const entry of path?.written ?? [])
          asks ||= asksType(admission, group, entry, rest + length === at.length);
        for (const entry of path?.values ?? [])
          if (entry.bound !== null) below.push({ group: entry.bound.group, rest: rest + length });
      });
      if (asks) {
        finish(true);
        continue;
      }
      frame.below = below;
    }
    const below = frame.below!;
    if (frame.next < below.length) {
      stack.push({ ...below[frame.next++]!, below: null, next: 0 });
      continue;
    }
    finish(false);
  }
  return answer!;
}

/**
 * A group's first value that decides (`decides`), in its key's order: its region's values on the path (above its
 * end, each operand group asked in turn at the rest there, its mask narrowed by its operation) and its literals at
 * the path's end, merged by rank; once per group, rest and masks; `null` for none.
 */
function firstValue(
  admission: Admission,
  root: DeciderGroup,
  at: PathRef,
  ids: (rest: number) => number,
): DecidingValue | null {
  interface Frame {
    readonly group: DeciderGroup;
    readonly rest: number;
    readonly masks: readonly (ReadonlySet<ItemTag> | null)[];
    readonly name: string;
    lists: { readonly list: readonly Entry[]; readonly length: number }[] | null;
    positions: number[];
  }
  const frame = (
    group: DeciderGroup,
    rest: number,
    masks: readonly (ReadonlySet<ItemTag> | null)[],
  ): Frame => {
    const name = keptParts(admission.work, ids(rest), ...masks.map(maskName));
    return { group, rest, masks, name, lists: null, positions: [] };
  };
  const stack: Frame[] = [
    frame(
      root,
      0,
      root.members.map(() => null),
    ),
  ];
  let answer: DecidingValue | null | undefined = undefined;
  const finish = (value: DecidingValue | null): void => {
    const done = stack.pop()!;
    if (!done.group.values.has(done.name)) keep(admission.work, 1);
    done.group.values.set(done.name, value);
    answer = value;
  };
  while (stack.length > 0) {
    const top = stack.at(-1)!;
    const { group, rest, masks } = top;
    if (answer !== undefined) {
      if (answer !== null) {
        finish(answer);
        continue;
      }
      answer = undefined;
    } else if (top.lists === null) {
      const known = group.values.get(top.name);
      if (known !== undefined) {
        stack.pop();
        answer = known;
        continue;
      }
      const lists: { list: readonly Entry[]; length: number }[] = [];
      forEachPath(regionOf(admission, group), at, rest, (path, length) => {
        if (path === null) return;
        const end = rest + length === at.length;
        const list = distinctAt(admission, path, end);
        if (list.length > 0) lists.push({ list, length });
        if (end && path.literals.length > 0) lists.push({ list: path.literals, length });
      });
      top.lists = lists;
      top.positions = lists.map(() => 0);
    }
    const lists = top.lists!;
    // (the next entry in key order: the least rank among the lists' next ones)
    let best = -1;
    for (let index = 0; index < lists.length; index += 1)
      if (
        top.positions[index]! < lists[index]!.list.length &&
        (best < 0 ||
          lists[index]!.list[top.positions[index]!]!.rank <
            lists[best]!.list[top.positions[best]!]!.rank)
      )
        best = index;
    if (best < 0) {
      finish(null);
      continue;
    }
    admission.pass.program.work.charge("checks", lists.length);
    const entry = lists[best]!.list[top.positions[best]!++]!;
    const below = rest + lists[best]!.length;
    if (entry.bound !== null) {
      const { group: inner, from, through } = entry.bound;
      stack.push(
        frame(
          inner,
          below,
          inner.members.map((member, index) =>
            narrowed(
              admission,
              masks[from[index]!]!,
              member,
              through[index]!,
              at,
              below,
              ids(below),
            ),
          ),
        ),
      );
      continue;
    }
    const tags = decides(
      admission,
      group.members[entry.member]!,
      entry,
      at,
      below,
      masks[entry.member]!,
    );
    if (tags !== null) finish({ value: entry.task.value, tags });
  }
  return answer!;
}

/**
 * A2, A4, A8: the earliest value that decides a stored value's path (`earliestDecider`), read from its carriers'
 * transfers: `undefined` where a written copy on the path asks a type, which the scan of the stops answers, in its
 * order (its type may wait on another decision, `inheritedInto`); else the first value that decides, with the kinds it
 * decides by, `null` for none.
 * The value's own task and the literals it holds, by path, then each carrier's operands, their roles merged at each
 * common operand in their keys' order, each group's answer once per pass for its rest of the path, whatever value
 * walks to it (`groupOf`).
 */
export function transferredDecider(
  admission: Admission,
  task: Expansion,
  asked: Rest,
  written?: { root: DeciderGroup | null; ids: ((rest: number) => number) | null },
): DecidingValue | null | undefined {
  const root = groupOf(admission, [
    { task, deep: false, single: true, typed: false, chosen: true, surely: true, joined: false },
  ]);
  // (an array's rests named as before, all at once; a span's by its rests' path ids as asked, below zero so the two
  // never meet in a group's answers, G3 stage 1)
  const at = restRef(admission.pass.contract, asked);
  let ids: (rest: number) => number;
  if (at.kind === "span") ids = (rest) => -1 - at.from(rest).id();
  else {
    const list = restIds(admission, at.steps());
    ids = (rest) => list[rest]!;
  }
  if (writtenOn(admission, root, at, ids)) {
    if (written !== undefined) [written.root, written.ids] = [root, ids];
    return undefined;
  }
  // #1384: below an indexed run of `+` (`plusRun`) whose own value holds no definite kind at the path, no value below
  // it decides: each mask there holds only kinds that value holds definitely (`narrowed`); a span's step read only
  // there, a charged visit
  if (
    at.length >= 2 &&
    isPlusValue(admission.pass, task.value) &&
    at.at(0) === "element" &&
    plusRun(admission.pass, task.value, at.at(1), true) !== null &&
    deciding(admission.run(admission.pass.values.valueItems(task.value, task.node, asked)))
      .length === 0
  )
    return null;
  return firstValue(admission, root, at, ids);
}

/** The decider's root group's one member: the stored value's own task, chosen, not below an operation. */
function rootMember(task: Expansion): Member {
  return {
    task,
    deep: false,
    single: true,
    typed: false,
    chosen: true,
    surely: true,
    joined: false,
  };
}

/**
 * A region path's written copies as the decider's scan reads them (`earliestDecider`'s `snapshots`): of one member's
 * copies there that read one snapshot at one strip and lanes, the first (a member's copies share its chain of
 * operations, `viaSignature`); once per path.
 */
function writtenAt(admission: Admission, path: RegionPath): readonly Entry[] {
  if (path.representatives !== null) return path.representatives;
  if (!sharing() || path.written.length < 2) return (path.representatives = path.written);
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const entry of path.written) {
    admission.pass.program.work.charge("checks");
    const read = snapshotOf(admission, entry.task.value);
    if (read !== null) {
      const inherited = entry.call !== true && entry.task.inherits !== null;
      const strip = inherited ? entry.task.inherits!.strip : entry.task.stop!.strip;
      const name = keptParts(
        admission.work,
        entry.member,
        strip,
        entry.deep,
        entry.single,
        read,
        inherited,
      );
      if (seen.has(name)) continue;
      seen.add(name);
    }
    out.push(entry);
  }
  keep(admission.work, 1 + out.length);
  return (path.representatives = out);
}

/** A written copy that decides a path in a group's region or below it, at its depth below the group's own path. */
interface WrittenCandidate {
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

/**
 * The maps the written-decider summary reads and keeps its answers in: the pass's own while no stop forgot an answer
 * since admission began (each made from the solver's current answers), else maps of its own made since the last
 * `Solver.forget`, the only place a finished answer changes within a pass. A forget replaces them whole, so no answer
 * made before it is read after it; the pass's own maps are never written then.
 */
function summaryCaches(admission: Admission): DeciderCaches {
  const forgets = admission.pass.solver.forgets;
  const known = admission.summary;
  if (known !== null && known.forgets === forgets) return known.caches;
  const own = admission.deciderCaches;
  const caches: DeciderCaches =
    forgets === admission.forgetsAtStart
      ? {
          deciders: own.deciders,
          linkTests: own.linkTests,
          linkKinds: own.linkKinds,
          summaries: new WeakMap(),
        }
      : {
          deciders: new Map(),
          linkTests: new Map(),
          linkKinds: new Map(),
          summaries: new WeakMap(),
        };
  admission.summary = { forgets, caches };
  admission.summaryEpochs += 1;
  return caches;
}

/**
 * #1444(b,c): `earliestDecider`'s answer where a written copy on the path asks a type (`transferredDecider` answered
 * `undefined`), asked outside every decision and into no decision's place (`literalElements`, `joinElements`), from its
 * groups' regions instead of a walk of its stops: each group's answer at a rest of the path once per masks and linked
 * members, its written copies and values in its region's rank order, each operand group's answer taken at its rank
 * (a nest's levels each answered once, never each level's whole walk again). The same answer as the scan: an open list
 * join's operand first, else the earlier of the earliest written copy (`copy`) and the earliest deciding value.
 * A decision's own scan stays the stops' (`earliestDecider`), so each decision charges what it charged before.
 */
export function* writtenDecider(
  admission: Admission,
  task: Expansion,
  asked: Rest,
  found: { readonly root: DeciderGroup | null; readonly ids: ((rest: number) => number) | null },
): Inheriting<{
  readonly term: TypeTerm | null;
  readonly site: SourceSite | null;
  readonly tags?: readonly ItemTag[];
  readonly joined?: boolean;
  readonly joinedNull?: boolean;
  readonly own?: boolean;
} | null> {
  const caches = summaryCaches(admission);
  const { program, contract } = admission.pass;
  const work = program.work;
  const at = restRef(contract, asked);
  const ids = found.ids!;
  const root =
    caches.deciders === admission.deciders
      ? found.root!
      : groupOf(admission, [rootMember(task)], caches);
  type Kind = "written" | "value" | "bound";
  interface Frame {
    readonly group: DeciderGroup;
    readonly rest: number;
    readonly masks: readonly (ReadonlySet<ItemTag> | null)[];
    readonly linked: readonly boolean[];
    /** Its answer's name in its group's (`DeciderCaches.summaries`), `null` for the root's, which is not kept. */
    readonly name: string | null;
    entries: { readonly entry: Entry; readonly length: number; readonly kind: Kind }[] | null;
    next: number;
    copy: WrittenCandidate | null;
    first: DecidingValue | null;
    open: WrittenCandidate | null;
    copyRank: number;
    firstRank: number;
    openRank: number;
    copyFirst: boolean;
    joinedNull: boolean;
    waiting: { readonly rank: number; readonly length: number } | null;
  }
  const frame = (
    group: DeciderGroup,
    rest: number,
    masks: readonly (ReadonlySet<ItemTag> | null)[],
    linked: readonly boolean[],
    name: string | null,
  ): Frame => ({
    group,
    rest,
    masks,
    linked,
    name,
    entries: null,
    next: 0,
    copy: null,
    first: null,
    open: null,
    copyRank: Infinity,
    firstRank: Infinity,
    openRank: Infinity,
    copyFirst: false,
    joinedNull: false,
    waiting: null,
  });
  // (an earlier open join wins: the shallower, at one depth a written operand before a call, then the earlier rank)
  const earlierOpen = (a: WrittenCandidate, rank: number, f: Frame): boolean =>
    f.open === null ||
    a.depth < f.open.depth ||
    (a.depth === f.open.depth &&
      (Number(a.call) < Number(f.open.call) || (a.call === f.open.call && rank < f.openRank)));
  const merge = (f: Frame, s: WrittenSummary, rank: number, length: number): void => {
    if (s.copy !== null && rank < f.copyRank) {
      f.copy = { ...s.copy, depth: length + s.copy.depth };
      f.copyRank = rank;
    }
    if (s.first !== null && rank < f.firstRank) {
      f.first = s.first;
      f.firstRank = rank;
    }
    if (s.open !== null) {
      const open = { ...s.open, depth: length + s.open.depth };
      if (earlierOpen(open, rank, f)) {
        f.open = open;
        f.openRank = rank;
      }
    }
    f.joinedNull ||= s.joinedNull;
    if (f.copyRank !== f.firstRank) f.copyFirst = f.copyRank < f.firstRank;
    else if (rank === f.copyRank) f.copyFirst = s.copyFirst;
  };
  const stack: Frame[] = [
    frame(
      root,
      0,
      root.members.map(() => null),
      root.members.map(() => false),
      null,
    ),
  ];
  let answer: WrittenSummary | null = null;
  while (stack.length > 0) {
    const f = stack.at(-1)!;
    if (answer !== null) {
      merge(f, answer, f.waiting!.rank, f.waiting!.length);
      f.waiting = null;
      answer = null;
    }
    if (f.entries === null) {
      admission.summaryStates += 1;
      const entries: { entry: Entry; length: number; kind: Kind }[] = [];
      forEachPath(regionOf(admission, f.group, caches), at, f.rest, (path, length) => {
        if (path === null) return;
        for (const entry of writtenAt(admission, path))
          entries.push({ entry, length, kind: "written" });
        const end = f.rest + length === at.length;
        for (const entry of distinctAt(admission, path, end))
          if (!end || entry.bound === null)
            entries.push({ entry, length, kind: entry.bound === null ? "value" : "bound" });
        // (at the path's end an operand group of operands below operations decides no value, but its written copies
        // still may: it is entered for them)
        if (end)
          for (const entry of distinctAt(admission, path, false))
            if (
              entry.bound !== null &&
              (entry.bound.group.members.some((member) => !member.deep) ||
                holdsWritten(admission, entry.bound.group, caches))
            )
              entries.push({ entry, length, kind: "bound" });
        if (end) for (const entry of path.literals) entries.push({ entry, length, kind: "value" });
      });
      f.entries = entries;
    }
    if (f.next >= f.entries.length) {
      const done: WrittenSummary = {
        copy: f.copy,
        first: f.first,
        copyFirst: f.copyFirst,
        open: f.open,
        joinedNull: f.joinedNull,
      };
      if (f.name !== null) {
        let byName = caches.summaries.get(f.group);
        if (byName === undefined) caches.summaries.set(f.group, (byName = new Map()));
        byName.set(f.name, done);
        keep(
          work,
          1 + Number(f.copy !== null) + Number(f.first !== null) + Number(f.open !== null),
        );
      }
      stack.pop();
      answer = done;
      continue;
    }
    const { entry, length, kind } = f.entries[f.next++]!;
    const rest = f.rest + length;
    const member = f.group.members[entry.member]!;
    work.charge("checks");
    if (kind === "bound") {
      const { group: inner, from, through } = entry.bound!;
      const values =
        (rest !== at.length || inner.members.some((each) => !each.deep)) &&
        entry.rank <= Math.min(f.copyRank, f.firstRank);
      const masks = inner.members.map((each, index) =>
        values
          ? narrowed(
              admission,
              f.masks[from[index]!]!,
              each,
              through[index]!,
              at,
              rest,
              ids(rest),
              caches,
            )
          : EMPTY,
      );
      const linked = inner.members.map(
        (_, index) => f.linked[from[index]!]! || through[index] !== null,
      );
      const name = keptParts(
        work,
        ids(rest),
        ...masks.map((mask, index) => `${maskName(mask)}${linked[index] ? "'" : ""}`),
      );
      const known = caches.summaries.get(inner)?.get(name);
      if (known !== undefined) {
        merge(f, known, entry.rank, length);
        continue;
      }
      f.waiting = { rank: entry.rank, length };
      stack.push(frame(inner, rest, masks, linked, name));
      continue;
    }
    if (kind === "value") {
      if (entry.rank > Math.min(f.copyRank, f.firstRank)) continue;
      const tags = decides(admission, member, entry, at, rest, f.masks[entry.member]!);
      if (tags !== null)
        merge(
          f,
          {
            copy: null,
            first: { value: entry.task.value, tags },
            copyFirst: false,
            open: null,
            joinedNull: false,
          },
          entry.rank,
          length,
        );
      continue;
    }
    // (a written copy after the earliest one decides nothing, but a list join's may still leave the path open)
    if (!member.joined && entry.rank > f.copyRank) continue;
    if (!asksType(admission, f.group, entry, rest === at.length)) continue;
    let term: TypeTerm | null;
    // (whether the copy reads its written type at its own level: a written copy's where no step of the asked path is
    // left below it, an inheriting copy's as the inheritance pass recorded it (`inheritedInto`'s `own`); a call's
    // result never is a copy read as an occurrence, #1901)
    let own = false;
    if (entry.call === true) {
      const key = contract.resultKey(entry.task.value);
      const result = key === null ? null : writtenOf(program.place(keyPlace(key)).kind);
      term =
        result === null || !member.chosen || !live(admission, entry.task.value)
          ? null
          : permittedAt(
              result,
              stepsAfter(keyPath(key!), restSteps(restAfter(entry.task.stop!.strip, at, rest))),
            );
    } else if (entry.task.inherits !== null) {
      const below = restAfter(entry.task.inherits.strip, at, rest);
      const inherited = { value: false };
      term = yield* inheritedInto(admission, entry.task.inherits.from, below, null, inherited);
      own = inherited.value;
    } else {
      const below = restAfter(entry.task.stop!.strip, at, rest);
      own = below.length === 0;
      term = permittedAt(entry.task.stop!.term!, below);
    }
    // (a copy reached through operations decides only where they select it, A4)
    if (
      term !== null &&
      entry.call !== true &&
      f.linked[entry.member]! &&
      !(member.chosen && live(admission, entry.task.value))
    )
      term = null;
    if (term === null) continue;
    const candidate: WrittenCandidate = {
      term,
      value: entry.task.value,
      joined: member.joined,
      call: entry.call === true,
      depth: 0,
      own,
    };
    const domain = member.joined ? joinedDomain(typeTags(term)) : "kinds";
    merge(
      f,
      {
        copy: domain === "kinds" ? candidate : null,
        first: null,
        copyFirst: true,
        open: domain === "open" ? candidate : null,
        joinedNull: member.joined && typeTags(term).includes("null"),
      },
      entry.rank,
      length,
    );
  }
  const s = answer!;
  const siteOf = (value: PlaceId): SourceSite | null => program.places[value]?.site ?? null;
  if (s.open !== null) return { term: s.open.term, site: siteOf(s.open.value) };
  if (s.copy !== null && s.copyFirst)
    return {
      term: s.copy.term,
      site: siteOf(s.copy.value),
      joined: s.copy.joined,
      joinedNull: s.joinedNull,
      own: s.copy.own,
    };
  return s.first === null ? null : { term: null, site: siteOf(s.first.value), tags: s.first.tags };
}
