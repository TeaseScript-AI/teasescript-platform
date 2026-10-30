import type { PlaceId } from "../../graph.js";
import { keptStepsIn } from "../contract/key-ids.js";
import type { Admission } from "../admission.js";
import { keptParts, keptSplit } from "../budget.js";
import { typeTags } from "../contract.js";
import { keptKey, keyPlace, sortCost, type Key } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import { refText, Touches, type Touch, type TouchRef } from "../touch.js";
import { inheritedAt } from "./inherited.js";
import { compatible, concrete } from "./kinds.js";
import { copiesOf, inheritance, membersOf } from "./landings.js";
import type { InheritedCopy, LiveGroup, TouchPart, TouchPlace, TouchTask } from "./model.js";
import { liveOwn } from "./own.js";

// Hot-candidate discovery (#1188): each place's touch and landing tries, built once per pass.

/** The touch tries of the pass (`Touches`), their tests asked of the decisions' inherited types and the contracts. */
export function touchesOf(admission: Admission): Touches {
  if (admission.touches !== null) return admission.touches;
  const { contract } = admission.pass;
  admission.touches = new Touches({
    work: admission.work,
    term: (ref) => inheritedAt(admission, ref.place, ref.path),
    contents: (ref) =>
      withoutEmpty(
        admission.run(
          ref.value === undefined
            ? contract.contractOf(keptKey(admission.work, ref.place, ref.path))
            : contract.contractOfValueAt(ref.value, ref.path),
        ),
      ),
    compatible,
    concrete,
    typeText: (term) => (term === null ? "" : typeTags(term).join("|")),
  });
  return admission.touches;
}

export function touchRef(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
  lands: boolean,
  bare = false,
): TouchRef {
  const ref = { owner: `${place}`, place, path, lands, ...(bare ? { bare } : {}) };
  return { ...ref, text: refText(admission.work, ref) };
}

/** A copy's contribution where it lands: its source's trie at its strip, landed at the copy's own path. */
export function touchCopy(
  admission: Admission,
  from: PlaceId,
  strip: readonly string[],
  at: readonly string[],
): Touch {
  const touches = touchesOf(admission);
  const source = touches.sub(touchOf(admission, from).node, strip);
  return touches.graft(touches.landedTop(source, touchRef(admission, from, strip, true)), at);
}

/** A read's contribution where it stands: its source's trie at its path, contents only. */
export function touchRead(admission: Admission, source: Key, at: readonly string[]): Touch {
  const touches = touchesOf(admission);
  const path = keptStepsIn(admission.pass.contract, source);
  const held =
    touches.sub(touchOf(admission, keyPlace(source)).node, path) ??
    touches.leaf([], [touchRef(admission, keyPlace(source), path, false)]);
  return touches.graft(held, at);
}

/**
 * A place's touch trie: its written copies' landings, its copies' sources' tries where they land, its own contents
 * and its reads' sources' contents; merged largest first, each merge's meetings this place's (`Touches.merge`). Built
 * with every trie it needs first (`build`); a place met again while its own is being built holds anything (a cycle of
 * reads).
 */
export function touchOf(admission: Admission, place: PlaceId): TouchPlace {
  const known = admission.touchPlaces.get(place);
  if (known !== undefined) return known;
  if (admission.touching.has(place))
    return {
      node: touchesOf(admission).leaf([], [], [touchRef(admission, place, [], false)]),
      found: [],
    };
  build(admission, "touch", place);
  return admission.touchPlaces.get(place)!;
}

/**
 * A place's landings alone, once per pass: its seeds and every copy into it, live or rejected, each its source's
 * landings at its strip, landed where the copy lands it (a cycle whose copies add or take steps: its listed landing
 * set). A rejected copy brings these into a place's trie and nothing else: what it lands stays landed (the landing
 * view, `landed`, as A6 finds the rejection again; Sol's review r3 F1), while what it held is gone. A place met again
 * while its own is being built lands its root (a cycle of landings, as `landed` ends a walk met again).
 */
function landingOf(admission: Admission, place: PlaceId): Touch | null {
  const known = admission.touchLandings.get(place);
  if (known !== undefined) return known;
  if (admission.landingNow.has(place))
    return touchesOf(admission).leaf([], [touchRef(admission, place, [], true, true)]);
  build(admission, "landing", place);
  return admission.touchLandings.get(place)!;
}

/**
 * Builds a place's touch or landing trie with every trie its parts need first, on an explicit stack in the order its
 * parts ask them, so a chain of copies or reads of any length never deepens the native stack. A task's members are
 * marked while it is open, as `touchOf` and `landingOf` read them; a stop thrown through the build leaves none
 * marked.
 */
function build(admission: Admission, kind: "touch" | "landing", place: PlaceId): void {
  const open: TouchTask[] = [];
  const marks = (task: TouchTask): Set<PlaceId> =>
    task.kind === "touch" ? admission.touching : admission.landingNow;
  const start = (kind: "touch" | "landing", place: PlaceId): void => {
    const task = kind === "touch" ? touchTask(admission, place) : landingTask(admission, place);
    for (const member of task.members) marks(task).add(member);
    open.push(task);
  };
  start(kind, place);
  try {
    while (open.length > 0) {
      const task = open.at(-1)!;
      if (task.next < task.parts.length) {
        const part = task.parts[task.next++]!;
        const need =
          part.kind === "read"
            ? { kind: "touch" as const, place: keyPlace(part.source) }
            : part.kind === "copy"
              ? { kind: part.live ? ("touch" as const) : ("landing" as const), place: part.from }
              : part.kind === "landing"
                ? { kind: "landing" as const, place: part.place }
                : null;
        if (
          need !== null &&
          !(need.kind === "touch"
            ? admission.touchPlaces.has(need.place) || admission.touching.has(need.place)
            : admission.touchLandings.has(need.place) || admission.landingNow.has(need.place))
        )
          start(need.kind, need.place);
        continue;
      }
      // (finished while still open, so a stop thrown through its finishing leaves none of its members marked)
      finish(admission, task);
      open.pop();
      for (const member of task.members) marks(task).delete(member);
    }
  } finally {
    for (const task of open) for (const member of task.members) marks(task).delete(member);
  }
}

/** A place's touch trie's parts, by what they are made of, and the members it is built for. */
function touchTask(admission: Admission, place: PlaceId): TouchTask {
  const { seeds, cycleOf, cycles, fed, wholes, into } = inheritance(admission);
  const work = admission.pass.program.work;
  const whole = wholes.get(place);
  const feeder = fed.get(place);
  // (a cycle of whole copies has one trie, its members' all, Astra's B3; only the members its live copies join,
  // Astra's recheck r3 F1 and N1)
  const group = whole !== undefined || feeder !== undefined ? liveGroup(admission, place) : null;
  const members = group?.members ?? [place];
  const parts: TouchPart[] = [];
  const lander = (at: PlaceId, path: readonly string[]): void => {
    parts.push({ kind: "leaf", path, ref: touchRef(admission, at, path, true), opaque: false });
  };
  // (B2: a store rejected by the previous pass is dead in this one, as the value side has it: a copy it makes brings
  // its landings alone, Sol's review r3 F1)
  const copy = (each: InheritedCopy, live = liveCopy(admission, each)): void => {
    parts.push({ kind: "copy", from: each.from, strip: each.strip, at: each.path, live });
  };
  if (cycleOf.has(place) && !fed.has(place) && whole === undefined) {
    // a cycle whose copies add or take steps: its landed set, and anything beside it
    for (const text of cycles.get(place)!) lander(place, keptSplit(admission.work, text));
    parts.push({
      kind: "leaf",
      path: [],
      ref: touchRef(admission, place, [], false),
      opaque: true,
    });
    return { kind: "touch", place, members, parts, next: 0 };
  }
  const first = members[0]!;
  if (group?.split === true) {
    // (a cycle split by a rejected copy lands as a whole, its landing view historical, so its landings stand bare;
    // its contents are only what this group holds and what live copies bring into it)
    if (whole !== undefined) parts.push({ kind: "landing", place });
    for (const member of members)
      for (const text of seeds.get(member)?.keys() ?? [])
        lander(member, keptSplit(admission.work, text));
    if (whole !== undefined) lander(first, []);
    const cycle = cycleOf.get(place);
    for (const member of members)
      for (const each of into.get(member) ?? []) {
        work.charge("indexSteps");
        if (cycleOf.get(each.from) !== cycle) {
          // (a fed cycle's copies of its feeder are its made-up one, below)
          if (feeder === undefined) copy(each);
          continue;
        }
        // (a copy within the group is the group itself; a rejected one lands only what the cycle lands)
        if (group.has.has(each.from) || !liveCopy(admission, each)) continue;
        copy(each, true);
      }
  } else {
    for (const text of (whole?.seeds ?? seeds.get(place))?.keys() ?? [])
      lander(first, keptSplit(admission.work, text));
    if (whole !== undefined) {
      lander(first, []);
      // (each copy from outside once, live where any member's copy of it is: the live copies join every member, so a
      // live one brings its contents to all)
      const outside = new Map<string, { each: InheritedCopy; live: boolean }>();
      for (const member of members)
        for (const each of into.get(member) ?? []) {
          work.charge("indexSteps");
          if (cycleOf.get(each.from) === cycleOf.get(place)) continue;
          const id = keptParts(admission.work, each.path, each.from, each.strip);
          const live = liveCopy(admission, each);
          const known = outside.get(id);
          if (known === undefined || (live && !known.live)) outside.set(id, { each, live });
        }
      for (const { each, live } of outside.values()) copy(each, live);
    } else if (feeder === undefined) for (const each of copiesOf(admission, place)) copy(each);
  }
  // (a fed cycle's made-up copy of its feeder is live where a live copy of the feeder lands in the group, as the
  // value side has it, Astra's recheck r3 N1)
  if (feeder !== undefined) copy({ place, path: [], from: feeder, strip: [] }, group!.fedLive);
  for (const member of members) {
    const own = liveOwn(admission, member);
    for (const path of own?.points ?? [])
      parts.push({
        kind: "leaf",
        path,
        ref: touchRef(admission, member, path, false),
        opaque: false,
      });
    for (const path of own?.below ?? [])
      parts.push({
        kind: "leaf",
        path,
        ref: touchRef(admission, member, path, false),
        opaque: true,
      });
    for (const { at, source } of own?.reads ?? []) parts.push({ kind: "read", source, at });
  }
  return { kind: "touch", place, members, parts, next: 0 };
}

/** A place's landing trie's parts (`landingOf`), and the members it is built for. */
function landingTask(admission: Admission, place: PlaceId): TouchTask {
  const { seeds, cycleOf, cycles, fed, wholes } = inheritance(admission);
  const whole = wholes.get(place);
  const members = whole?.members ?? (fed.has(place) ? membersOf(admission, place) : [place]);
  const parts: TouchPart[] = [];
  const lander = (at: PlaceId, path: readonly string[]): void => {
    parts.push({
      kind: "leaf",
      path,
      ref: touchRef(admission, at, path, true, true),
      opaque: false,
    });
  };
  if (cycleOf.has(place) && !fed.has(place) && whole === undefined)
    for (const text of cycles.get(place)!) lander(place, keptSplit(admission.work, text));
  else {
    const first = members[0]!;
    for (const text of (whole?.seeds ?? seeds.get(place))?.keys() ?? [])
      lander(first, keptSplit(admission.work, text));
    if (whole !== undefined) lander(first, []);
    for (const each of copiesOf(admission, place))
      parts.push({ kind: "copy", from: each.from, strip: each.strip, at: each.path, live: false });
  }
  return { kind: "landing", place, members, parts, next: 0 };
}

/** A task's trie from its parts, every trie they need built: merged, and recorded for each of its members. */
function finish(admission: Admission, task: TouchTask): void {
  const touches = touchesOf(admission);
  const parts = task.parts.flatMap((part): Touch[] => {
    switch (part.kind) {
      case "leaf":
        return [
          part.opaque
            ? touches.leaf(part.path, [], [part.ref])
            : touches.leaf(part.path, [part.ref]),
        ];
      case "copy":
        return [
          part.live
            ? touchCopy(admission, part.from, part.strip, part.at)
            : touchLanding(admission, part.from, part.strip, part.at),
        ];
      case "read":
        return [touchRead(admission, part.source, part.at)];
      case "landing": {
        const landing = landingOf(admission, part.place);
        return landing === null ? [] : [landing];
      }
    }
  });
  admission.pass.program.work.charge("indexSteps", parts.length + sortCost(parts.length));
  parts.sort((a, b) => b.size - a.size || a.id - b.id);
  if (task.kind === "landing") {
    let node: Touch | null = null;
    for (const part of parts) node = touches.merge(node, part, "meet").node;
    touches.share(node);
    for (const member of task.members) admission.touchLandings.set(member, node);
    return;
  }
  // (its largest part, and the rest merged, recorded as its base and delta: a merge with it goes through the base)
  let rest: Touch | null = null;
  const found: (readonly string[])[] = [];
  for (const part of parts.slice(1)) {
    const merged = touches.merge(rest, part, "meet");
    rest = merged.node;
    touches.paths(merged.found, [], found);
  }
  let node: Touch | null = parts[0] ?? null;
  if (node !== null && rest !== null) {
    const merged = touches.merge(node, rest, "meet");
    touches.paths(merged.found, [], found);
    node = touches.derived(merged.node!, node, rest);
  }
  // (nothing known of it, a parameter or a call's result: anything; but a place whose every store is dead holds
  // nothing in this pass, as the value side drops them)
  if (node === null && !task.members.every((member) => admission.deadOnly.has(member)))
    node = touches.leaf([], [], [touchRef(admission, task.place, [], false)]);
  touches.share(node);
  // (a live group of two or more members of a whole-copy ring shares this trie: `Touches.ring`)
  if (task.members.length > 1) touches.ring(node);
  const out = { node, found };
  for (const member of task.members) admission.touchPlaces.set(member, out);
}

/** Whether a live store makes a copy (a made-up one, with no store, is decided by its maker). */
function liveCopy(admission: Admission, copy: InheritedCopy): boolean {
  return (
    copy.store === undefined ||
    admission.liveCopies.has(
      keptParts(admission.work, copy.place, copy.path, copy.from, copy.strip),
    )
  );
}

/**
 * The members of a place's cycle of whole copies that hold each other through copies live stores make (strongly
 * connected by them), and whether a live copy from outside lands in one of them (Astra's recheck r3 F1, N1). The whole
 * cycle where they all are, as before any rejection; once per cycle. Its members' contents are equal only there, so
 * only there do they share a trie; its landings stay the cycle's (historical, `landed`).
 */
function liveGroup(admission: Admission, place: PlaceId): LiveGroup {
  const known = admission.liveGroups.get(place);
  if (known !== undefined) return known;
  const { into, cycleOf } = inheritance(admission);
  const work = admission.pass.program.work;
  const cycle = cycleOf.get(place);
  const members = membersOf(admission, place);
  const index = new Map<PlaceId, number>();
  for (const [at, member] of members.entries()) index.set(member, at);
  // (the live copies within the cycle, from source to receiver, and the members a live copy from outside lands in)
  const next: number[][] = members.map(() => []);
  const feeds = members.map(() => false);
  for (const [at, member] of members.entries())
    for (const copy of into.get(member) ?? []) {
      work.charge("indexSteps");
      const live = liveCopy(admission, copy);
      if (cycleOf.get(copy.from) !== cycle) feeds[at] ||= live;
      else if (live) next[index.get(copy.from)!]!.push(at);
    }
  // (strongly connected components, iteratively: Tarjan's, each member and live copy once)
  const order = members.map(() => -1);
  const low = members.map(() => 0);
  const onStack = members.map(() => false);
  const stack: number[] = [];
  const groups: number[][] = [];
  let counter = 0;
  for (let root = 0; root < members.length; root += 1) {
    if (order[root] !== -1) continue;
    const frames: [number, number][] = [[root, 0]];
    order[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = true;
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const [at, edge] = frame;
      work.charge("indexSteps");
      if (edge < next[at]!.length) {
        frame[1] += 1;
        const to = next[at]![edge]!;
        if (order[to] === -1) {
          order[to] = low[to] = counter++;
          stack.push(to);
          onStack[to] = true;
          frames.push([to, 0]);
        } else if (onStack[to]) low[at] = Math.min(low[at]!, order[to]!);
        continue;
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1]![0];
        low[parent] = Math.min(low[parent]!, low[at]!);
      }
      if (low[at] !== order[at]) continue;
      const group: number[] = [];
      for (;;) {
        const top = stack.pop()!;
        onStack[top] = false;
        group.push(top);
        if (top === at) break;
      }
      groups.push(group.sort((a, b) => a - b));
    }
  }
  const split = groups.length > 1;
  for (const group of groups) {
    const list = group.map((at) => members[at]!);
    const found: LiveGroup = {
      members: list,
      has: new Set(list),
      split,
      fedLive: group.some((at) => feeds[at]),
    };
    for (const member of list) admission.liveGroups.set(member, found);
  }
  return admission.liveGroups.get(place)!;
}

/** A rejected copy's contribution where it lands: its source's landings at its strip, landed at the copy's path. */
function touchLanding(
  admission: Admission,
  from: PlaceId,
  strip: readonly string[],
  at: readonly string[],
): Touch {
  const touches = touchesOf(admission);
  const source = touches.sub(landingOf(admission, from), strip);
  return touches.graft(touches.landedTop(source, touchRef(admission, from, strip, true, true)), at);
}
