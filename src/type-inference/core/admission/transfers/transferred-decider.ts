// The earliest decider a transfer reads: a written or literal route's first deciding value, and the decider's root.

import type { Admission } from "../../admission.js";
import { restRef, type PathRef, type Rest } from "../../contract/key-ids.js";
import { keep, keptParts } from "../../budget.js";
import type { ItemTag } from "../../items.js";
import { isPlusValue, plusRun } from "../../indexes/plus-index.js";
import { deciding } from "../kinds.js";
import type { Expansion } from "../model.js";
import type { Reads } from "../../inherited/reads.js";
import { hasCell } from "../walk.js";
import {
  type Member,
  type Entry,
  type DeciderGroup,
  type DecidingValue,
  groupOf,
  regionOf,
  distinctAt,
  holdsWritten,
  asksType,
  decides,
  narrowed,
  maskName,
  restIds,
  forEachPath,
} from "./regions.js";

/**
 * Whether a written copy on the decided path asks a type in a group's region or in a group below it (`asksType`),
 * once per group and rest: only where one stands at all (`holdsWritten`).
 */
function* writtenOn(
  admission: Admission,
  root: DeciderGroup,
  at: PathRef,
  ids: (rest: number) => number,
): Reads<boolean> {
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
      if (known !== undefined || !(yield* holdsWritten(admission, group))) {
        stack.pop();
        answer = known ?? false;
        continue;
      }
      let asks = false;
      let below: readonly { group: DeciderGroup; rest: number }[] = [];
      const visited = group.visits.get(ids(rest));
      if (visited !== undefined) ({ asks, below } = visited);
      else {
        const found: { group: DeciderGroup; rest: number }[] = [];
        forEachPath(yield* regionOf(admission, group), at, rest, (path, length) => {
          admission.pass.program.work.charge("checks");
          for (const entry of path?.written ?? [])
            asks ||= asksType(admission, group, entry, rest + length === at.length);
          for (const entry of path?.values ?? [])
            if (entry.bound !== null) found.push({ group: entry.bound.group, rest: rest + length });
        });
        below = found;
      }
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
 * #2289: whether a literal with a cell stands on the asked path (a link of the value's `View`), so its cell answers there and no
 * summary of its flattened parts may: a literal read whole at a rest shorter than the path (its own stop,
 * `RegionPath.literals`), or a literal read through a projection as a member of a group on it (whose cells are the
 * group below it). Any other part is reached by a literal's cell step, below a literal read whole that is found first.
 * Pruned by no written test; once per group and rest, structural.
 */
export function* literalRoute(admission: Admission, decider: DeciderRoot): Reads<boolean> {
  // (a program whose every cell has one element at most has none: its paths are main's)
  if (!admission.pass.definitions.manyCells) return false;
  return (yield* holdsWritten(admission, decider.root)) && (yield* literalOn(admission, decider));
}

function* literalOn(admission: Admission, decider: DeciderRoot): Reads<boolean> {
  const { root, at, ids } = decider;
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
    frame.group.literal.set(ids(frame.rest), value);
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
      const known = group.literal.get(ids(rest));
      if (known !== undefined) {
        stack.pop();
        answer = known;
        continue;
      }
      // (a literal with a cell only: a step of one element is that element's own reading, which the summaries read;
      // whether a member is one, once per group)
      if (group.cellMember === null) {
        admission.pass.program.work.charge("checks", group.members.length);
        group.cellMember = group.members.some(
          (member) => member.task.strip.length > 0 && hasCell(admission, member.task),
        );
      }
      let on = group.cellMember;
      const below: { group: DeciderGroup; rest: number }[] = [];
      if (!on) {
        let asks = false;
        forEachPath(yield* regionOf(admission, group), at, rest, (path, length) => {
          admission.pass.program.work.charge("checks");
          if (path === null) return;
          if (
            rest + length < at.length &&
            path.literals.some((entry) => hasCell(admission, entry.task))
          )
            on = true;
          for (const entry of path.written)
            asks ||= asksType(admission, group, entry, rest + length === at.length);
          for (const entry of path.values)
            if (entry.bound !== null) below.push({ group: entry.bound.group, rest: rest + length });
        });
        group.visits.set(ids(rest), { asks, below });
      }
      if (on) {
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
function* firstValue(
  admission: Admission,
  root: DeciderGroup,
  at: PathRef,
  ids: (rest: number) => number,
): Reads<DecidingValue | null> {
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
      forEachPath(yield* regionOf(admission, group), at, rest, (path, length) => {
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
      // (each member's mask in turn, as a map makes them)
      const innerMasks: (ReadonlySet<ItemTag> | null)[] = [];
      for (const [index, member] of inner.members.entries())
        innerMasks.push(
          yield* narrowed(
            admission,
            masks[from[index]!]!,
            member,
            through[index]!,
            at,
            below,
            ids(below),
          ),
        );
      stack.push(frame(inner, below, innerMasks));
      continue;
    }
    const tags = yield* decides(
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
export function* transferredDecider(
  admission: Admission,
  task: Expansion,
  asked: Rest,
  written?: { root: DeciderGroup | null; ids: ((rest: number) => number) | null },
  decider: DeciderRoot = deciderRoot(admission, task, asked),
): Reads<DecidingValue | null | undefined> {
  const { root, at, ids } = decider;
  if (yield* writtenOn(admission, root, at, ids)) {
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
    deciding(
      yield* admission.runRead(() =>
        admission.pass.values.valueItems(task.value, task.node, asked),
      ),
    ).length === 0
  )
    return null;
  return yield* firstValue(admission, root, at, ids);
}

/** A stored value's root group and asked path with its rests' ids, as `transferredDecider` and `literalOn` read them. */
export interface DeciderRoot {
  readonly root: DeciderGroup;
  readonly at: PathRef;
  readonly ids: (rest: number) => number;
}

export function deciderRoot(admission: Admission, task: Expansion, asked: Rest): DeciderRoot {
  const root = groupOf(admission, [rootMember(task)]);
  // (an array's rests named as before, all at once; a span's by its rests' path ids as asked, below zero so the two
  // never meet in a group's answers, G3 stage 1)
  const at = restRef(admission.pass.contract, asked);
  let ids: (rest: number) => number;
  if (at.kind === "span") ids = (rest) => -1 - at.from(rest).id();
  else {
    const list = restIds(admission, at.steps());
    ids = (rest) => list[rest]!;
  }
  return { root, at, ids };
}

/** The decider's root group's one member: the stored value's own task, chosen, not below an operation. */
export function rootMember(task: Expansion): Member {
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
