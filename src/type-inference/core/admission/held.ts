import type { PlaceId } from "../../graph.js";
import type { Admission } from "../admission.js";
import { keptArray, keptSlice, keptText } from "../budget.js";
import {
  keptKey,
  keptPath,
  keyPlace,
  sortCost,
  type Definition,
  type Key,
} from "../definitions.js";
import { refText, type Found, type Touch, type TouchRef } from "../touch.js";
import type { HeldExtra, HeldOwn } from "./model.js";
import { liveOwn, ownOf } from "./own.js";
import { touchesOf, touchRef } from "./touches.js";

// What a place's live stores definitely hold (A2, TABLE r4.131): its held tries, built once per pass, and where they meet.

/** No copies listed (`ownOf`): every copy of a written type stands below, as a value holding anything (A2). */
const NO_COPIES: ReadonlySet<string> = new Set();

/**
 * The strongly connected components of a graph over `nodes` and the nodes they reach (`next`: a node's successors),
 * Tarjan's on an explicit stack, a component after every one it reaches; `step` hears of each node and edge.
 */
function keyComponents<T>(
  nodes: readonly T[],
  next: (node: T) => readonly T[],
  step: () => void,
): T[][] {
  const order = new Map<T, number>();
  const low = new Map<T, number>();
  const onStack = new Set<T>();
  const stack: T[] = [];
  const out: T[][] = [];
  for (const root of nodes) {
    if (order.has(root)) continue;
    const frames: { readonly node: T; edge: number }[] = [{ node: root, edge: 0 }];
    order.set(root, order.size);
    low.set(root, order.get(root)!);
    stack.push(root);
    onStack.add(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      step();
      const successors = next(frame.node);
      if (frame.edge < successors.length) {
        const to = successors[frame.edge++]!;
        if (!order.has(to)) {
          order.set(to, order.size);
          low.set(to, order.get(to)!);
          stack.push(to);
          onStack.add(to);
          frames.push({ node: to, edge: 0 });
        } else if (onStack.has(to))
          low.set(frame.node, Math.min(low.get(frame.node)!, order.get(to)!));
        continue;
      }
      frames.pop();
      const above = frames[frames.length - 1];
      if (above !== undefined)
        low.set(above.node, Math.min(low.get(above.node)!, low.get(frame.node)!));
      if (low.get(frame.node) !== order.get(frame.node)) continue;
      const component: T[] = [];
      for (;;) {
        const top = stack.pop()!;
        onStack.delete(top);
        component.push(top);
        if (top === frame.node) break;
      }
      out.push(component);
    }
  }
  return out;
}

/**
 * Whether what a place's stores definitely hold meets at a path (A2, TABLE r4.131): a store bringing the other type
 * there errs where it meets the place, never at a later read (ADR 0021 rule 1.1).
 */
export function atCopy(admission: Admission, root: PlaceId, path: readonly string[]): boolean {
  admission.groups();
  return admission.atCopies.has(keptKey(admission.work, root, path));
}

/**
 * What a place's live stores definitely hold (A2, `heldMeetings`): its own points (`heldPoints`) and its reads'
 * sources' held tries where they stand, by reference (`heldReads`); none of its landings, its copies inheriting
 * written types (A4's) or its values holding anything, which decide nothing there. `null` where it holds nothing
 * definite. Built with its reads' sources first (`buildHeld`).
 */
function heldOf(admission: Admission, place: PlaceId): Touch | null {
  const known = admission.helds.get(place);
  if (known !== undefined) return known;
  buildHeld(admission, place);
  return admission.helds.get(place)!;
}

/**
 * A store's own points in a held trie (A2): what it holds itself, its copies of written bindings among them, whose
 * contents there are their types', a contribution like any other (`HeldExtra`, Astra r1 N1).
 */
function heldPoints(admission: Admission, own: HeldOwn | null): readonly (readonly string[])[] {
  if (own === null) return [];
  if (own.held.points.length === 0) return own.points;
  return keptArray(admission.work, [...own.points, ...own.held.points]);
}

/** A store's reads in a held trie (A2): each where it stands, whether its place's copies list stands for it. */
function heldReads(
  admission: Admission,
  own: HeldOwn | null,
): readonly { readonly at: readonly string[]; readonly source: Key }[] {
  if (own === null) return [];
  if (own.held.reads.length === 0) return own.reads;
  return keptArray(admission.work, [...own.reads, ...own.held.reads]);
}

/** A read's contribution to a held trie where it stands: its source's held trie at its path. */
function heldRead(admission: Admission, source: Key, at: readonly string[]): Touch | null {
  const touches = touchesOf(admission);
  const held = touches.sub(heldOf(admission, keyPlace(source)), keptPath(admission.work, source));
  return held === null ? null : touches.graft(held, at);
}

/**
 * Builds a place's held trie and every one its reads need first: the components of the places its live stores read
 * (`keyComponents`, each place and read once), sources first (`finishHeld`). A component is recorded only once
 * complete, so a stop thrown through the build leaves no partial answer.
 */
function buildHeld(admission: Admission, root: PlaceId): void {
  const work = admission.pass.program.work;
  const sources = new Map<PlaceId, readonly PlaceId[]>();
  const next = (place: PlaceId): readonly PlaceId[] => {
    let list = sources.get(place);
    if (list === undefined) {
      const found: PlaceId[] = [];
      for (const { source } of heldReads(admission, liveOwn(admission, place))) {
        work.charge("indexSteps");
        if (!admission.helds.has(keyPlace(source))) found.push(keyPlace(source));
      }
      sources.set(place, (list = found));
    }
    return list;
  };
  for (const component of keyComponents([root], next, () => work.charge("indexSteps")))
    finishHeld(admission, component);
}

/**
 * The held tries of a component of the places live stores read (A2, TABLE r4.131 and r4.154: design §2.1.2 as
 * accepted). Its members that hold each other through whole copies (a place read whole into a place) form live
 * groups, the strongly connected components of those copies: each group one trie, its members' own points and what
 * their reads bring from outside the group, sources first; where those meet, a member owes what its own contribution
 * brings there (`groupHeld`). Every other read is by reference, its source's held trie at its path where it stands. A
 * read within the component that adds or takes steps (`a.inner = a`, `a = b.right`) closes a cycle outside that class
 * and brings nothing definite: what reaches a place only through it is found where it is read.
 */
function finishHeld(admission: Admission, members: readonly PlaceId[]): void {
  const touches = touchesOf(admission);
  const work = admission.pass.program.work;
  const index = new Map<PlaceId, number>();
  for (const [at, member] of members.entries()) index.set(member, at);
  // (each member's own points and reads from outside the component, and its whole copies within it by source)
  const own: Touch[][] = members.map(() => []);
  const copies: number[][] = members.map(() => []);
  for (const [at, member] of members.entries()) {
    const found = liveOwn(admission, member);
    for (const path of heldPoints(admission, found)) {
      work.charge("indexSteps");
      own[at]!.push(touches.leaf(path, [touchRef(admission, member, path, false)]));
    }
    for (const { at: where, source } of heldReads(admission, found)) {
      work.charge("indexSteps");
      const from = index.get(keyPlace(source));
      if (from === undefined) {
        const held = heldRead(admission, source, where);
        if (held !== null) own[at]!.push(held);
      } else if (where.length === 0 && keptPath(admission.work, source).length === 0)
        copies[at]!.push(from);
    }
  }
  // (the live groups, sources first: a whole copy from an earlier group brings its trie by reference)
  const fold = (parts: Touch[], heard?: (found: Found) => void): Touch | null => {
    work.charge("indexSteps", parts.length + sortCost(parts.length));
    parts.sort((a, b) => b.size - a.size || a.id - b.id);
    let node: Touch | null = null;
    for (const part of parts) {
      const merged = touches.merge(node, part, "copies");
      node = merged.node;
      heard?.(merged.found);
    }
    return node;
  };
  for (const group of keyComponents(
    members.map((_, at) => at),
    (at) => copies[at]!,
    () => work.charge("indexSteps"),
  )) {
    const inside = new Set(group);
    let held: Touch | null;
    if (group.length === 1) {
      const at = group[0]!;
      const parts = [...own[at]!];
      for (const from of copies[at]!) {
        const earlier = from === at ? undefined : admission.helds.get(members[from]!);
        if (earlier !== null && earlier !== undefined) parts.push(earlier);
      }
      held = fold(parts);
    } else
      held = groupHeld(
        admission,
        group.map((at) => members[at]!),
        inside,
        index,
        members,
        fold,
      );
    touches.share(held);
    for (const at of group) admission.helds.set(members[at]!, held);
  }
}

/**
 * A live group's held trie, its members' own contributions merged, and what each member owes where they meet (A2,
 * `groupMeetings`). A store's own contribution is what it brings itself, its own points and its reads from outside
 * the group (a whole copy from an earlier group by reference), or, for a whole copy of a member of the group, that
 * member's own contribution. A member owes a meeting path where one of its stores' own contribution stands, beside a
 * whole copy of a member (which brings what the group holds there, another kind): its own conflicting contribution,
 * one decision for a ring fed at its members and for a relay of two members' copies. A member whose stores bring
 * nothing there (a relay of relays, an empty object) owes nothing, and one store alone has nothing to meet. Each
 * contribution is asked once against the group's meetings (`Touches.standsAt`), so the work follows the
 * contributions, never a member for every path.
 */
function groupHeld(
  admission: Admission,
  group: readonly PlaceId[],
  inside: ReadonlySet<number>,
  index: ReadonlyMap<PlaceId, number>,
  members: readonly PlaceId[],
  fold: (parts: Touch[], heard?: (found: Found) => void) => Touch | null,
): Touch | null {
  const touches = touchesOf(admission);
  const work = admission.pass.program.work;
  // (each member's stores: a whole copy of a member of the group by that member, else its own contribution)
  const stores = group.map((member) =>
    (admission.liveStores.get(member) ?? []).map((store) => {
      let copyOf: PlaceId | null = null;
      const parts: Touch[] = [];
      for (const path of heldPoints(admission, store)) {
        work.charge("indexSteps");
        parts.push(touches.leaf(path, [touchRef(admission, member, path, false)]));
      }
      for (const { at: where, source } of heldReads(admission, store)) {
        work.charge("indexSteps");
        const from = index.get(keyPlace(source));
        const whole = where.length === 0 && keptPath(admission.work, source).length === 0;
        if (from === undefined) {
          const held = heldRead(admission, source, where);
          if (held !== null) parts.push(held);
        } else if (whole && inside.has(from)) copyOf = members[from]!;
        else if (whole) {
          const earlier = admission.helds.get(members[from]!);
          if (earlier !== null && earlier !== undefined) parts.push(earlier);
        }
        // (a read within the component that adds or takes steps brings nothing definite, `finishHeld`)
      }
      return { copyOf, own: fold(parts) };
    }),
  );
  // (each member's own contribution, and the group's trie, with the paths where they meet: in a member's own stores
  // or between members)
  const meetings: { met: Found | null } = { met: null };
  const heard = (found: Found): void => {
    meetings.met = meetings.met === null ? found : touches.unite(meetings.met, found);
  };
  const owns = new Map<PlaceId, Touch | null>();
  for (const [at, member] of group.entries())
    owns.set(
      member,
      fold(
        stores[at]!.flatMap(({ own }) => (own === null ? [] : [own])),
        heard,
      ),
    );
  const held = fold(
    [...owns.values()].filter((own): own is Touch => own !== null),
    heard,
  );
  const met = meetings.met;
  if (met === null) return held;
  // (what each member owes there)
  for (const [at, member] of group.entries()) {
    const copies = stores[at]!.filter(({ copyOf }) => copyOf !== null).length;
    const owed: (readonly string[])[] = [];
    for (const { copyOf, own } of stores[at]!) {
      work.charge("indexSteps");
      if (copies < (copyOf === null ? 1 : 2)) continue;
      touches.paths(touches.standsAt(copyOf === null ? own : owns.get(copyOf)!, met), [], owed);
    }
    for (const path of owed)
      if (path.length > 0) admission.groupMeetings.push(keptKey(admission.work, member, path));
  }
  return held;
}

/**
 * A2 (TABLE r4.131): the paths where what the stores into one place (`base` empty, each store at its own path) or a
 * literal's elements (each at `base`, its landing) definitely hold meet with two kinds or more (`copies`), relative to
 * `base`, sorted by text. Each store's or element's trie is its own points (`heldPoints`) and its reads' held tries
 * (`heldOf`), and the distinct ones are merged largest first, so k stores of one copy merge it once. A property only
 * copies of whole objects bring is owed as any other: the copy is checked where it meets the place. A4's copies
 * inheriting written types and the values holding anything stand below and decide nothing here.
 */
export function heldMeetings(
  admission: Admission,
  list: readonly { readonly d: Definition; readonly at: readonly string[] }[],
  base: readonly string[],
): (readonly string[])[] {
  const touches = touchesOf(admission);
  const work = admission.pass.program.work;
  const owed = new Map<string, readonly string[]>();
  const take = (found: Found): void => {
    const paths: (readonly string[])[] = [];
    touches.paths(found, [], paths);
    for (const path of paths) if (path.length > 0) owed.set(keptText(admission.work, path), path);
  };
  const rest = (path: readonly string[]): string[] => keptSlice(admission.work, path, base.length);
  const distinct = new Map<number, Touch>();
  for (const [index, { d, at }] of list.entries()) {
    if (d.value === undefined) continue;
    const own: HeldOwn & {
      readonly points: (readonly string[])[];
      readonly below: (readonly string[])[];
      readonly reads: { readonly at: readonly string[]; readonly source: Key }[];
      readonly held: HeldExtra;
    } = { points: [], below: [], reads: [], held: { points: [], reads: [] } };
    ownOf(admission, d, d.value, at, NO_COPIES, own);
    const parts: Touch[] = [];
    for (const { at: where, source } of heldReads(admission, own)) {
      const held = heldRead(admission, source, rest(where));
      if (held !== null) parts.push(held);
    }
    // (its own points, their contents asked of its value below `at`)
    const mine = (path: readonly string[]): TouchRef => {
      const ref = { owner: `e${d.uid}`, place: -1 - index, path, lands: false, value: d.value! };
      return { ...ref, text: refText(admission.work, ref) };
    };
    for (const point of heldPoints(admission, own))
      parts.push(touches.leaf(rest(point), [mine(keptSlice(admission.work, point, at.length))]));
    work.charge("indexSteps", parts.length + sortCost(parts.length));
    parts.sort((a, b) => b.size - a.size || a.id - b.id);
    let node: Touch | null = null;
    for (const part of parts) {
      const merged = touches.merge(node, part, "copies");
      node = merged.node;
      take(merged.found);
    }
    if (node !== null) distinct.set(node.id, node);
  }
  const order = [...distinct.values()].sort((a, b) => b.size - a.size || a.id - b.id);
  work.charge("indexSteps", order.length + sortCost(order.length));
  let merged: Touch | null = null;
  for (const node of order) {
    const next = touches.merge(merged, node, "copies");
    merged = next.node;
    take(next.found);
  }
  const texts = [...owed.keys()].sort();
  work.charge("indexSteps", texts.length + sortCost(texts.length));
  return texts.map((text) => owed.get(text)!);
}
