/*
 * Admission's hot-candidate discovery (#1188): touch tries. Each place's landings and contents are one persistent trie
 * of paths, built once per pass from its own live items and its sources' tries taken by reference; opaque contributors
 * are one shared payload. Contributions meet where their tries merge, each merge memoized by the two nodes it merges
 * (never by a place, a configuration, a read or a literal), a node with a small delta merged through its base. So no
 * context lists a contribution again: discovery costs its own items, the distinct pairs of nodes merged, the payloads'
 * tests and the owed paths. Every step is charged.
 */
import type { PlaceId, TypeTerm } from "../graph.js";
import { keepText, keptParts, keptSlice, keptSteps, keptText, type WorkLedger } from "./budget.js";
import type { Item } from "./items.js";

/** One contributor standing at a node: the place and path whose landing or contents these are. */
export interface TouchRef {
  /** The contributor itself: its place's number, or a literal element's own `e<uid>` (never its position). */
  readonly owner: string;
  /** The place whose written type and contents are asked; a literal element's asks its `value` instead. */
  readonly place: PlaceId;
  readonly path: readonly string[];
  /** A written type of the contributor's lands here; else it holds contents only. */
  readonly lands: boolean;
  /** Its identity in every key (`refText`). */
  readonly text: string;
  /** A literal element's own contribution: its value, whose contents at the path are asked. */
  readonly value?: PlaceId;
  /** A landing alone (a rejected copy's, Sol's review r3 F1): its written type lands here, no contents are asked. */
  readonly bare?: boolean;
}

/** A ref's text: its owner, its path, and whether it lands, holds or stands bare there. */
export function refText(work: WorkLedger, ref: Omit<TouchRef, "text">): string {
  return `${ref.owner}:${keptText(work, ref.path)}:${ref.bare === true ? "b" : ref.lands ? "l" : "h"}`;
}

interface Branch {
  readonly key: string;
  readonly priority: number;
  readonly node: Touch;
  readonly left: Branch | null;
  readonly right: Branch | null;
  readonly count: number;
}

export interface Touch {
  readonly id: number;
  readonly branches: Branch | null;
  /** The contributors at this node: its own (a leaf), or its two parts'. */
  readonly refs: readonly TouchRef[];
  readonly parts: readonly [Touch, Touch] | null;
  /** The contributors holding anything at and below this node (an opaque value), as one shared payload. */
  readonly opaque: Payload | null;
  readonly here: boolean;
  readonly landed: boolean;
  readonly size: number;
  /** The node this one merged into (the larger part) and the part merged in, for merging through the base. */
  readonly base: Touch | null;
  readonly delta: Touch | null;
  /** The shared nodes down its bases (each contained in it), by id. */
  readonly anchors: IdSet | null;
  /**
   * The meetings found in making it (`meet`), below it: a merge that finds it containing the other node owes them where
   * it differs from the other, as the other's landed types may decide the place merging them (§2.4 (d)).
   */
  readonly met: Found;
  /**
   * Whether a whole-copy ring's shared trie, or a projection of one, stands in it (`Touches.ring`): a containment there
   * owes as the accepted design has it, as each member decides by its own first store (#1270, Astra's review B1).
   */
  readonly ring: boolean;
}

/** A node's deltas down to a shared base, nearest the node first (`Touches.#hop`). */
interface Deltas {
  readonly delta: Touch;
  readonly next: Deltas | null;
}

/** From a node down its bases to the nearest shared one: the deltas on the way and what they cost. */
interface Hop {
  readonly from: Touch;
  readonly anchor: Touch;
  readonly deltas: Deltas;
  readonly cost: number;
}

/**
 * Opaque contributors, shared by reference (B1 of Astra's review): a contributor once (`leaf`, one per ref text), the
 * union of two payloads (once per pair), or a payload below a path (once per payload and path). Nothing is copied or
 * listed when payloads are merged or projected; what a test needs of them is asked once per payload node.
 */
export interface Payload {
  readonly id: number;
  readonly ref: TouchRef | null;
  readonly left: Payload | null;
  readonly right: Payload | null;
  readonly base: Payload | null;
  readonly by: readonly string[];
}

interface IdSet {
  readonly id: number;
  readonly priority: number;
  readonly left: IdSet | null;
  readonly right: IdSet | null;
}

function idPriority(id: number): number {
  return Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
}

function idHas(set: IdSet | null, id: number): boolean {
  for (let at = set; at !== null; at = id < at.id ? at.left : at.right)
    if (at.id === id) return true;
  return false;
}

function idWith(set: IdSet | null, id: number, priority = idPriority(id)): IdSet {
  if (set === null) return { id, priority, left: null, right: null };
  if (id === set.id) return set;
  if (id < set.id) {
    const left = idWith(set.left, id, priority);
    return left.priority > set.priority
      ? { ...left, right: { ...set, left: left.right } }
      : { ...set, left };
  }
  const right = idWith(set.right, id, priority);
  return right.priority > set.priority
    ? { ...right, left: { ...set, right: right.left } }
    : { ...set, right };
}

/** The paths below a node a merge found: a persistent trie of them, each union deduplicated. */
export interface Found {
  readonly id: number;
  readonly here: boolean;
  readonly branches: FoundBranch | null;
}

interface FoundBranch {
  readonly key: string;
  readonly priority: number;
  readonly node: Found;
  readonly left: FoundBranch | null;
  readonly right: FoundBranch | null;
  readonly count: number;
}

export type TouchMode = "meet" | "elements";

/** What a mode's test needs at a node: the terms landed and contents held there (`meet`), or who stands (`elements`). */
interface Summary {
  readonly terms: Map<string, TypeTerm | null>;
  readonly contents: Map<string, readonly Item[]>;
  readonly landers: Set<string>;
  readonly holders: Set<string>;
  readonly types: Set<string>;
  met: boolean;
}

export interface TouchHost {
  readonly work: WorkLedger;
  term(ref: TouchRef): TypeTerm | null;
  contents(ref: TouchRef): readonly Item[];
  compatible(items: readonly Item[], term: TypeTerm | null): boolean;
  /** Whether an item is a concrete kind (`literalElements`' kinds). */
  concrete(item: Item): boolean;
  typeText(term: TypeTerm | null): string;
}

const NONE: Found = { id: 0, here: false, branches: null };
const HERE: Found = { id: 1, here: true, branches: null };
const foundCount = (branch: FoundBranch | null): number => branch?.count ?? 0;

function priorityOf(key: string): number {
  let priority = 2166136261;
  for (let index = 0; index < key.length; index += 1)
    priority = Math.imul(priority ^ key.charCodeAt(index), 16777619);
  return priority >>> 0;
}

/**
 * Visits each node below and with `root` whose answer is not `known` after its parts (`parts`), once each, on an explicit
 * stack: a node's answer reads its parts' only, so a deep fold never deepens the native stack.
 */
function afterParts<T>(
  root: T,
  parts: (node: T) => readonly T[],
  known: (node: T) => boolean,
  visit: (node: T) => void,
): void {
  const stack: { readonly node: T; open: boolean }[] = [{ node: root, open: false }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (known(top.node)) {
      stack.pop();
      continue;
    }
    if (!top.open) {
      top.open = true;
      for (const part of parts(top.node)) if (!known(part)) stack.push({ node: part, open: false });
      continue;
    }
    stack.pop();
    visit(top.node);
  }
}

/** An entry of a persistent treap: a children map's (`Branch`) or a found trie's (`FoundBranch`). */
interface Entry<N> {
  readonly key: string;
  readonly node: N;
  readonly left: Entry<N> | null;
  readonly right: Entry<N> | null;
  readonly count: number;
}

/**
 * The entries of `a` whose key `b` lacks or holds another node at, passing whole every subtree the two share: a map
 * made from another by a few insertions shares all of it but those insertions' paths (a key's priority fixes its place),
 * so this walks only those. `null` past `limit` steps, each charged.
 */
function differing<N>(
  a: Entry<N> | null,
  b: Entry<N> | null,
  limit: number,
  charge: () => void,
): [string, N][] | null {
  const out: [string, N][] = [];
  // (each treap's subtrees and entries still to pass, in key order, the next one last; an open one stands for its own
  // entry, its children pushed beside it)
  type Pending = { readonly entry: Entry<N>; readonly open: boolean };
  const left: Pending[] = a === null ? [] : [{ entry: a, open: false }];
  const right: Pending[] = b === null ? [] : [{ entry: b, open: false }];
  const open = (stack: Pending[]): void => {
    const { entry } = stack.pop()!;
    if (entry.right !== null) stack.push({ entry: entry.right, open: false });
    stack.push({ entry, open: true });
    if (entry.left !== null) stack.push({ entry: entry.left, open: false });
  };
  for (let steps = 1; left.length > 0; steps += 1) {
    if (steps > limit) return null;
    charge();
    const x = left[left.length - 1]!;
    const y = right[right.length - 1];
    if (y !== undefined && !x.open && !y.open && x.entry === y.entry) {
      left.pop();
      right.pop();
    } else if (!x.open && (y === undefined || y.open || x.entry.count >= y.entry.count)) open(left);
    else if (y !== undefined && !y.open) open(right);
    else if (y === undefined || x.entry.key < y.entry.key) {
      out.push([x.entry.key, x.entry.node]);
      left.pop();
    } else if (y.entry.key < x.entry.key) right.pop();
    else {
      if (x.entry.node !== y.entry.node) out.push([x.entry.key, x.entry.node]);
      left.pop();
      right.pop();
    }
  }
  return out;
}

const countOf = (branch: Branch | null): number => branch?.count ?? 0;

function made(
  key: string,
  priority: number,
  node: Touch,
  left: Branch | null,
  right: Branch | null,
): Branch {
  return { key, priority, node, left, right, count: 1 + countOf(left) + countOf(right) };
}

export class Touches {
  #ids = 0;
  readonly #paths = new Map<string, Touch>();
  readonly #leaves = new Map<string, Touch>();
  readonly #memo = new Map<string, { readonly node: Touch | null; readonly found: Found }>();
  readonly #expanded = new Map<string, Found>();
  /** Per mode, whether a node or a branch holds a node `#expand` asks, at or below it (`#asksBelow`). */
  readonly #asking: Readonly<Record<TouchMode, WeakMap<Touch | Branch, boolean>>> = {
    meet: new WeakMap(),
    elements: new WeakMap(),
  };
  readonly #owes = new Map<string, Found>();
  readonly #metOwes = new Map<number, Found>();
  /** The tries of whole-copy rings, each the trie of every member of its live group, and their projections. */
  readonly #rings = new Set<number>();
  readonly #summaries: Readonly<Record<TouchMode, Map<number, Summary>>> = {
    meet: new Map(),
    elements: new Map(),
  };
  readonly #subs = new Map<string, Touch | null>();
  readonly #items = new Map<number, Map<string, Item>>();
  readonly #tops = new Map<string, Touch>();
  readonly #hops = new Map<number, Hop | null>();
  #payloadIds = 0;
  readonly #payloadLeaves = new Map<string, Payload>();
  readonly #payloadUnions = new Map<string, Payload>();
  readonly #payloadShifts = new Map<string, Payload>();
  readonly #payloadMet = new Map<string, boolean>();
  readonly #payloadTwo = new Map<number, readonly string[]>();
  readonly #payloadItems = new Map<string, ReadonlyMap<string, Item>>();
  readonly #payloadKindSets = new Map<string, ReadonlySet<string>>();
  /** The nodes others take whole (a place's trie, a node below it, one landed at its top): the bases worth merging through. */
  readonly #shared = new Set<number>();

  public constructor(readonly host: TouchHost) {}

  /**
   * A merged node recorded as its base and delta (a place's trie: its largest part, and the rest merged), so a merge
   * with it goes through that base.
   */
  public derived(node: Touch, base: Touch, delta: Touch): Touch {
    return this.#node({
      branches: node.branches,
      refs: [],
      parts: [base, delta],
      opaque: node.opaque,
      here: node.here,
      landed: node.landed,
      size: node.size,
      base,
      delta,
      anchors: this.#anchorsBelow(base),
      met: node.met,
    });
  }

  /** The shared nodes down to and with a base: those a node made on it contains. */
  #anchorsBelow(base: Touch): IdSet | null {
    return this.#shared.has(base.id) ? idWith(base.anchors, base.id) : base.anchors;
  }

  /**
   * From a node down its bases to the nearest shared one, each base reached through a delta of at most half of it:
   * `null` where none is. Once per node, from its base's, down a chain of bases on an explicit stack.
   */
  #hop(node: Touch): Hop | null {
    const chain: Touch[] = [];
    let at = node;
    let found: Hop | null;
    for (;;) {
      const known = this.#hops.get(at.id);
      if (known !== undefined) {
        found = known;
        break;
      }
      const { base, delta } = at;
      if (base === null || delta === null || 2 * delta.size > base.size) {
        found = null;
        this.#hops.set(at.id, found);
        break;
      }
      this.#charge();
      if (this.#shared.has(base.id)) {
        found = { from: at, anchor: base, deltas: { delta, next: null }, cost: delta.size };
        this.#hops.set(at.id, found);
        break;
      }
      chain.push(at);
      at = base;
    }
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const above = chain[index]!;
      const delta = above.delta!;
      found =
        found === null
          ? null
          : {
              from: above,
              anchor: found.anchor,
              deltas: { delta, next: found.deltas },
              cost: delta.size + found.cost,
            };
      this.#hops.set(above.id, found);
    }
    return found;
  }

  /** Whether a node contains another: the same, or one of its shared bases. */
  #contains(outer: Touch, inner: Touch): boolean {
    this.#charge();
    return outer === inner || idHas(outer.anchors, inner.id);
  }

  /** Marks a node as one others take whole (a place's trie). */
  public share(node: Touch | null): void {
    if (node !== null) this.#shared.add(node.id);
  }

  #charge(units = 1): void {
    this.host.work.charge("indexSteps", units);
  }

  /** A treap step's cost: its depth, about the log of its size. */
  #depth(branch: Branch | null): number {
    return 1 + Math.ceil(Math.log2(1 + countOf(branch)));
  }

  #get(branch: Branch | null, key: string): Touch | undefined {
    for (let at = branch; at !== null; at = key < at.key ? at.left : at.right)
      if (at.key === key) return at.node;
    return undefined;
  }

  #with(branch: Branch | null, key: string, node: Touch, priority = priorityOf(key)): Branch {
    if (branch === null) return made(key, priority, node, null, null);
    if (key === branch.key) return made(key, branch.priority, node, branch.left, branch.right);
    if (key < branch.key) {
      const left = this.#with(branch.left, key, node, priority);
      return left.priority > branch.priority
        ? made(
            left.key,
            left.priority,
            left.node,
            left.left,
            made(branch.key, branch.priority, branch.node, left.right, branch.right),
          )
        : made(branch.key, branch.priority, branch.node, left, branch.right);
    }
    const right = this.#with(branch.right, key, node, priority);
    return right.priority > branch.priority
      ? made(
          right.key,
          right.priority,
          right.node,
          made(branch.key, branch.priority, branch.node, branch.left, right.left),
          right.right,
        )
      : made(branch.key, branch.priority, branch.node, branch.left, right);
  }

  #entries(branch: Branch | null, out: [string, Touch][]): void {
    if (branch === null) return;
    this.#entries(branch.left, out);
    out.push([branch.key, branch.node]);
    this.#entries(branch.right, out);
  }

  #node(fields: Omit<Touch, "id" | "ring">): Touch {
    this.#charge();
    // (a ring stands in a node where it stands in one of its parts, or in a path node's one child)
    const ring =
      fields.parts !== null
        ? this.#isRing(fields.parts[0]) || this.#isRing(fields.parts[1])
        : fields.branches !== null && this.#isRing(fields.branches.node);
    return { id: this.#ids++, ...fields, ring };
  }

  /**
   * Marks a whole-copy ring's trie (a live group of two or more members): its members share it, each deciding by its own
   * first store, so two elements copying different members may offend each other where their nodes are one node.
   */
  public ring(node: Touch | null): void {
    if (node !== null) this.#rings.add(node.id);
  }

  #isRing(node: Touch): boolean {
    return node.ring || this.#rings.has(node.id);
  }

  /** The payload of one opaque contributor, one per ref. */
  #payloadOf(ref: TouchRef): Payload {
    let found = this.#payloadLeaves.get(ref.text);
    if (found === undefined) {
      this.#charge();
      found = { id: this.#payloadIds++, ref, left: null, right: null, base: null, by: [] };
      this.#payloadLeaves.set(ref.text, found);
    }
    return found;
  }

  /** Two payloads as one, once per pair (nothing listed). */
  public unitePayloads(a: Payload | null, b: Payload | null): Payload | null {
    if (a === null) return b;
    if (b === null || a === b) return a;
    const key = keptParts(this.host.work, Math.min(a.id, b.id), Math.max(a.id, b.id));
    let found = this.#payloadUnions.get(key);
    if (found === undefined) {
      this.#charge();
      found = { id: this.#payloadIds++, ref: null, left: a, right: b, base: null, by: [] };
      this.#payloadUnions.set(key, found);
    }
    return found;
  }

  /** A payload below a path: its contributors there, once per payload and path (nothing listed). */
  #shiftPayload(p: Payload, by: readonly string[]): Payload {
    if (by.length === 0) return p;
    const key = keptParts(this.host.work, p.id, by);
    let found = this.#payloadShifts.get(key);
    if (found === undefined) {
      this.#charge();
      found =
        p.base !== null
          ? this.#shiftPayload(p.base, keptSteps(this.host.work, p.by, by))
          : { id: this.#payloadIds++, ref: null, left: null, right: null, base: p, by };
      this.#payloadShifts.set(key, found);
    }
    return found;
  }

  /** Up to two distinct contributors of a payload (whether two hold anything there), once per payload node. */
  #two(p: Payload): readonly string[] {
    afterParts(
      p,
      (at) => (at.ref !== null ? [] : at.base !== null ? [at.base] : [at.left!, at.right!]),
      (at) => this.#payloadTwo.has(at.id),
      (at) => {
        this.#charge();
        let out: readonly string[];
        if (at.ref !== null) out = [at.ref.owner];
        else if (at.base !== null) out = this.#payloadTwo.get(at.base.id)!;
        else {
          const both = new Set([
            ...this.#payloadTwo.get(at.left!.id)!,
            ...this.#payloadTwo.get(at.right!.id)!,
          ]);
          out = [...both].slice(0, 2);
        }
        this.#payloadTwo.set(at.id, out);
      },
    );
    return this.#payloadTwo.get(p.id)!;
  }

  /**
   * Whether a payload's contents may not meet these landed types (`meet`): a union's when either side's may not (the
   * test is conjunctive over contents), a contributor's by its contents at its path below `by`; once per payload node,
   * shift and types, down the payload on an explicit stack.
   */
  #payloadMeets(
    p: Payload,
    by: readonly string[],
    terms: ReadonlyMap<string, TypeTerm | null>,
    key: string,
  ): boolean {
    const frames: { p: Payload; by: readonly string[]; memo: string; side: number }[] = [];
    // (the answer of the frame last finished, or of one already known)
    let met = false;
    const enter = (at: Payload, under: readonly string[]): boolean => {
      const memo = keptParts(this.host.work, at.id, under, key);
      const known = this.#payloadMet.get(memo);
      if (known !== undefined) {
        met = known;
        return true;
      }
      this.#charge();
      frames.push({ p: at, by: under, memo, side: 0 });
      return false;
    };
    const finish = (answer: boolean): void => {
      this.#payloadMet.set(frames.pop()!.memo, answer);
      met = answer;
    };
    if (enter(p, by)) return met;
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const { p: at } = frame;
      if (at.ref !== null) {
        const items = [...this.#itemsOf(at.ref, frame.by).values()];
        let answer = false;
        for (const term of terms.values()) {
          this.host.work.charge("checks");
          if (!this.host.compatible(items, term)) {
            answer = true;
            break;
          }
        }
        finish(answer);
        continue;
      }
      if (at.base !== null) {
        if (frame.side === 0) {
          frame.side = 1;
          if (!enter(at.base, keptSteps(this.host.work, at.by, frame.by))) continue;
        }
        finish(met);
        continue;
      }
      if (frame.side === 0) {
        frame.side = 1;
        if (!enter(at.left!, frame.by)) continue;
      }
      if (frame.side === 1) {
        if (met) {
          finish(true);
          continue;
        }
        frame.side = 2;
        if (!enter(at.right!, frame.by)) continue;
      }
      finish(met);
    }
    return met;
  }

  /** A contributor's contents below a path, once per contributor and path. */
  #itemsOf(ref: TouchRef, by: readonly string[]): ReadonlyMap<string, Item> {
    const shifted = this.shifted(ref, by);
    let found = this.#payloadItems.get(shifted.text);
    if (found === undefined) {
      const items = new Map<string, Item>();
      this.#held(items, shifted);
      this.#payloadItems.set(shifted.text, (found = items));
    }
    return found;
  }

  /**
   * The concrete kinds a payload's contributors hold below a path (a literal's owed path's kinds): a union's its two
   * sides', so once per payload node and path, each a set of kinds, never its contributors listed again (as
   * `#payloadMeets`); down the payload on an explicit stack.
   */
  #payloadKinds(p: Payload, by: readonly string[]): ReadonlySet<string> {
    const memo = this.#payloadKindSets;
    const frames: { p: Payload; by: readonly string[]; key: string; parts: string[] | null }[] = [];
    const enter = (at: Payload, under: readonly string[]): string => {
      const key = keptParts(this.host.work, at.id, under);
      if (!memo.has(key)) frames.push({ p: at, by: under, key, parts: null });
      return key;
    };
    const root = enter(p, by);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      if (memo.has(frame.key)) {
        frames.pop();
        continue;
      }
      const { p: at } = frame;
      if (frame.parts === null) {
        // (its sides first: a contributor has none, a shifted payload its base below the shift)
        frame.parts =
          at.ref !== null
            ? []
            : at.base !== null
              ? [enter(at.base, keptSteps(this.host.work, at.by, frame.by))]
              : [enter(at.left!, frame.by), enter(at.right!, frame.by)];
        continue;
      }
      frames.pop();
      this.#charge();
      const kinds = new Set<string>();
      if (at.ref !== null) {
        for (const item of this.#itemsOf(at.ref, frame.by).values())
          if (this.host.concrete(item)) kinds.add(item.tag);
      } else
        for (const part of frame.parts)
          for (const kind of memo.get(part)!) {
            this.host.work.charge("checks");
            kinds.add(kind);
          }
      memo.set(frame.key, kinds);
    }
    return memo.get(root)!;
  }

  /** A node standing for refs at a path (and opaque ones), nothing below. */
  public leaf(
    path: readonly string[],
    refs: readonly TouchRef[],
    opaque: readonly TouchRef[] = [],
  ): Touch {
    let payload: Payload | null = null;
    for (const ref of opaque) payload = this.unitePayloads(payload, this.#payloadOf(ref));
    const key = keptParts(
      this.host.work,
      path,
      refs.map((ref) => ref.text).join(","),
      opaque.map((ref) => ref.text).join(","),
    );
    let found = this.#leaves.get(key);
    if (found === undefined) {
      found = this.#node({
        branches: null,
        refs,
        parts: null,
        opaque: payload,
        here: refs.length > 0 || payload !== null,
        landed: refs.some((ref) => ref.lands),
        size: 1,
        base: null,
        delta: null,
        anchors: null,
        met: NONE,
      });
      found = this.graft(found, path);
      this.#leaves.set(key, found);
    }
    return found;
  }

  /** A node under a path: each step a node holding only the one below, shared by every graft of that node. */
  public graft(node: Touch, path: readonly string[]): Touch {
    let at = node;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const step = path[index]!;
      const key = keptParts(this.host.work, at.id, step);
      let found = this.#paths.get(key);
      if (found === undefined) {
        found = this.#node({
          branches: made(step, priorityOf(step), at, null, null),
          refs: [],
          parts: null,
          opaque: null,
          here: false,
          landed: false,
          size: at.size + 1,
          base: null,
          delta: null,
          anchors: null,
          met: this.#under(step, at.met),
        });
        this.#paths.set(key, found);
        if (this.#shared.has(at.id)) this.#shared.add(found.id);
      }
      at = found;
    }
    return at;
  }

  /**
   * The node at a path below a node: `null` where none stands; under an opaque node, a leaf of its contributors at the
   * rest (they hold anything there).
   */
  public sub(node: Touch | null, path: readonly string[]): Touch | null {
    if (node === null || path.length === 0) return node;
    const key = keptParts(this.host.work, node.id, path);
    const known = this.#subs.get(key);
    if (known !== undefined) return known;
    // (the node there, and the contributors of the opaque nodes above it, who hold anything there too)
    let at: Touch | null = node;
    let above: Payload | null = null;
    for (let index = 0; index < path.length && at !== null; index += 1) {
      this.#charge(this.#depth(at.branches));
      if (at.opaque !== null)
        above = this.unitePayloads(above, this.#shiftPayload(at.opaque, path.slice(index)));
      at = this.#get(at.branches, path[index]!) ?? null;
    }
    let found: Touch | null = at;
    if (above !== null)
      found = at === null ? this.#payloadLeaf(above) : this.#withOpaque(at, above);
    if (found !== null && this.#shared.has(node.id)) this.#shared.add(found.id);
    if (found !== null && this.#isRing(node)) this.#rings.add(found.id);
    this.#subs.set(key, found);
    return found;
  }

  /** A node of a payload alone, once per payload. */
  #payloadLeaf(payload: Payload): Touch {
    const key = `p${payload.id}`;
    let found = this.#leaves.get(key);
    if (found === undefined) {
      found = this.#node({
        branches: null,
        refs: [],
        parts: null,
        opaque: payload,
        here: true,
        landed: false,
        size: 1,
        base: null,
        delta: null,
        anchors: null,
        met: NONE,
      });
      this.#leaves.set(key, found);
    }
    return found;
  }

  /** A node beside a payload at its top (a sub below an opaque node): taken through the node. */
  #withOpaque(node: Touch, payload: Payload): Touch {
    const held = this.#payloadLeaf(payload);
    const opaque = this.unitePayloads(node.opaque, payload);
    return this.#node({
      branches: node.branches,
      refs: [],
      parts: [node, held],
      opaque,
      here: true,
      landed: node.landed,
      size: node.size + 1,
      base: node,
      delta: held,
      anchors: this.#anchorsBelow(node),
      met: node.met,
    });
  }

  /** A ref below a path: the same contributor (its owner, value and kind kept), at its path and `rest`. */
  public shifted(ref: TouchRef, rest: readonly string[]): TouchRef {
    if (rest.length === 0) return ref;
    const below = { ...ref, path: keptSteps(this.host.work, ref.path, rest) };
    return { ...below, text: refText(this.host.work, below) };
  }

  /** Whether a node holds or lands at a path: a node there standing, or an opaque one at or above it. */
  public touches(node: Touch | null, path: readonly string[]): boolean {
    let at = node;
    for (const step of path) {
      if (at === null) return false;
      this.#charge(this.#depth(at.branches));
      if (at.opaque !== null) return true;
      at = this.#get(at.branches, step) ?? null;
    }
    return at !== null && at.here;
  }

  /**
   * The concrete kinds held at a path below a node: its node's contents' (its contributors' by its parts, a contribution
   * shared by several of them taken once, as its node is), and the opaque contributors' above it.
   */
  public kindsAt(node: Touch | null, path: readonly string[]): ReadonlySet<string> {
    const kinds = new Set<string>();
    let at = node;
    for (let index = 0; at !== null; index += 1) {
      this.#charge(this.#depth(at.branches));
      if (at.opaque !== null)
        for (const kind of this.#payloadKinds(at.opaque, keptSlice(this.host.work, path, index)))
          kinds.add(kind);
      if (index === path.length) {
        for (const item of this.#contents(at).values()) {
          this.host.work.charge("checks");
          if (this.host.concrete(item)) kinds.add(item.tag);
        }
        break;
      }
      at = this.#get(at.branches, path[index]!) ?? null;
    }
    return kinds;
  }

  /** Whether a path below a node is landed: its node there stands with a written type landed. */
  public landedAt(node: Touch | null, path: readonly string[]): boolean {
    let at = node;
    for (const step of path) {
      if (at === null) return false;
      this.#charge(this.#depth(at.branches));
      at = this.#get(at.branches, step) ?? null;
    }
    return at !== null && at.landed;
  }

  /** How many distinct contributors hold anything at or above a path below a node. */
  public opaqueHolders(node: Touch | null, path: readonly string[]): number {
    const texts = new Set<string>();
    let at = node;
    for (let index = 0; at !== null; index += 1) {
      this.#charge(this.#depth(at.branches));
      if (at.opaque !== null) for (const text of this.#two(at.opaque)) texts.add(text);
      if (texts.size > 1 || index === path.length) break;
      at = this.#get(at.branches, path[index]!) ?? null;
    }
    return texts.size;
  }

  /** Whether an opaque node stands at or above a path below a node. */
  public opaqueAt(node: Touch | null, path: readonly string[]): boolean {
    let at = node;
    for (let index = 0; at !== null; index += 1) {
      this.#charge(this.#depth(at.branches));
      if (at.opaque !== null) return true;
      if (index === path.length) return false;
      at = this.#get(at.branches, path[index]!) ?? null;
    }
    return false;
  }

  /** Whether `#expand` asks a node in a mode: one standing there, for `meet` with a written type landed. */
  #asks(node: Touch, mode: TouchMode): boolean {
    return node.here && (mode === "elements" || node.landed);
  }

  /**
   * Whether a node, or a node below it (for a branch, below its nodes), is one `#expand` asks in a mode; once per node
   * and branch, after their parts, on an explicit stack. Merges share both, so a node a merge makes costs only its new
   * branches (#1307).
   */
  #asksBelow(root: Touch | Branch, mode: TouchMode): boolean {
    const memo = this.#asking[mode];
    afterParts<Touch | Branch>(
      root,
      (at) => {
        if ("branches" in at) return at.branches === null ? [] : [at.branches];
        const parts: (Touch | Branch)[] = [at.node];
        if (at.left !== null) parts.push(at.left);
        if (at.right !== null) parts.push(at.right);
        return parts;
      },
      (at) => memo.has(at),
      (at) => {
        this.#charge();
        memo.set(
          at,
          "branches" in at
            ? this.#asks(at, mode) || (at.branches !== null && memo.get(at.branches)!)
            : memo.get(at.node)! ||
                (at.left !== null && memo.get(at.left)!) ||
                (at.right !== null && memo.get(at.right)!),
        );
      },
    );
    return memo.get(root)!;
  }

  /** A branch's entries whose nodes hold a node asked in a mode (`#asksBelow`), in their order. */
  #askedEntries(branch: Branch | null, mode: TouchMode, out: [string, Touch][]): void {
    if (branch === null || !this.#asksBelow(branch, mode)) return;
    this.#askedEntries(branch.left, mode, out);
    if (this.#asksBelow(branch.node, mode)) out.push([branch.key, branch.node]);
    this.#askedEntries(branch.right, mode, out);
  }

  /**
   * The nodes below a node (itself too) that `#expand` asks in a mode, with the path to each, for an opaque contributor
   * above them: a node or branch holding none is never entered, so a node's k other properties are not walked again for
   * each of k contributors merged into it one by one (#1307).
   */
  #walk(node: Touch, mode: TouchMode, visit: (node: Touch, rest: readonly string[]) => void): void {
    if (!this.#asksBelow(node, mode)) return;
    const stack: { readonly node: Touch; readonly rest: readonly string[] }[] = [
      { node, rest: [] },
    ];
    while (stack.length > 0) {
      const { node: at, rest } = stack.pop()!;
      this.#charge();
      if (this.#asks(at, mode)) visit(at, rest);
      const entries: [string, Touch][] = [];
      this.#askedEntries(at.branches, mode, entries);
      for (const [step, child] of entries)
        stack.push({ node: child, rest: keptSteps(this.host.work, rest, [step]) });
    }
  }

  /** The written types landed at a node (`meet`), or who stands there (`elements`), from its refs or its parts. */
  #summary(node: Touch, mode: TouchMode): Summary {
    const summaries = this.#summaries[mode];
    afterParts(
      node,
      (at) => at.parts ?? [],
      (at) => summaries.has(at.id),
      (at) => {
        const summary: Summary = {
          terms: new Map(),
          contents: new Map(),
          landers: new Set(),
          holders: new Set(),
          types: new Set(),
          met: false,
        };
        if (at.parts !== null)
          for (const part of at.parts) this.#combine(summary, summaries.get(part.id)!, mode);
        else for (const ref of at.refs) this.#add(summary, ref, mode);
        summaries.set(at.id, summary);
      },
    );
    return summaries.get(node.id)!;
  }

  /**
   * The contents held at a node (`meet`), as one list of distinct items (`compatible` takes each item on its own and
   * every definite kind against every admitted one, so the union stands for the lists): asked only where a test needs
   * them, from its refs or its parts.
   */
  #contents(node: Touch): ReadonlyMap<string, Item> {
    afterParts(
      node,
      (at) => at.parts ?? [],
      (at) => this.#items.has(at.id),
      (at) => {
        const items = new Map<string, Item>();
        if (at.parts !== null)
          for (const part of at.parts) {
            const from = this.#items.get(part.id)!;
            this.host.work.charge("checks", 1 + from.size);
            for (const [text, item] of from) items.set(text, item);
          }
        else for (const ref of at.refs) this.#held(items, ref);
        this.#items.set(at.id, items);
      },
    );
    return this.#items.get(node.id)!;
  }

  #held(items: Map<string, Item>, ref: TouchRef): void {
    this.host.work.charge("checks");
    if (ref.bare === true) return;
    for (const item of this.host.contents(ref)) {
      const text = `${item.tag}:${item.cert}:${item.reasons}`;
      keepText(this.host.work, text.length);
      items.set(text, item);
    }
  }

  #add(summary: Summary, ref: TouchRef, mode: TouchMode): void {
    this.host.work.charge("checks");
    if (mode === "meet") {
      if (!ref.lands || summary.met) return;
      const text = this.host.typeText(this.host.term(ref));
      if (text === "") summary.met = true;
      else if (summary.terms.size < 4) summary.terms.set(text, this.host.term(ref));
      else summary.met = true;
    } else if (ref.lands) {
      if (summary.landers.size < 3) summary.landers.add(ref.text.slice(0, -2));
      if (summary.types.size < 2) summary.types.add(this.host.typeText(this.host.term(ref)));
      summary.holders.delete(ref.text.slice(0, -2));
    } else if (summary.holders.size < 3 && !summary.landers.has(ref.text.slice(0, -2)))
      summary.holders.add(ref.text.slice(0, -2));
  }

  #combine(into: Summary, from: Summary, mode: TouchMode): void {
    this.host.work.charge("checks", 1 + from.terms.size + from.landers.size + from.holders.size);
    if (mode === "meet") {
      into.met ||= from.met;
      if (into.met) return;
      for (const [text, term] of from.terms)
        if (into.terms.size < 4) into.terms.set(text, term);
        else into.met = true;
      return;
    }
    for (const lander of from.landers) {
      if (into.landers.size < 3) into.landers.add(lander);
      into.holders.delete(lander);
    }
    for (const type of from.types) if (into.types.size < 2) into.types.add(type);
    for (const holder of from.holders)
      if (into.holders.size < 3 && !into.landers.has(holder)) into.holders.add(holder);
  }

  /**
   * Whether a meeting at a node is owed: a written type landed there may not meet the contents there (`meet`: a type
   * landed with none, or contents some landed type does not admit), or two stand there (`elements`).
   */
  #owed(nodes: readonly Touch[], extra: readonly TouchRef[], mode: TouchMode): boolean {
    const summary: Summary = {
      terms: new Map(),
      contents: new Map(),
      landers: new Set(),
      holders: new Set(),
      types: new Set(),
      met: false,
    };
    for (const node of nodes) this.#combine(summary, this.#summary(node, mode), mode);
    for (const ref of extra) this.#add(summary, ref, mode);
    if (mode === "elements") {
      // (two stand there, and their contents there hold two kinds or more: `literalElements` keeps the path; the test
      // is the merge's, once per pair of nodes, never once per literal)
      if (!(
        summary.holders.size > 1 ||
        (summary.holders.size > 0 && summary.landers.size > 0) ||
        summary.types.size > 1
      ))
        return false;
      const kinds = new Set<string>();
      for (const node of nodes)
        for (const item of this.#contents(node).values()) {
          this.host.work.charge("checks");
          if (this.host.concrete(item)) kinds.add(item.tag);
        }
      const held = new Map<string, Item>();
      for (const ref of extra) this.#held(held, ref);
      for (const item of held.values()) if (this.host.concrete(item)) kinds.add(item.tag);
      return kinds.size > 1;
    }
    if (summary.met) return true;
    if (summary.terms.size === 0) return false;
    const items = new Map<string, Item>();
    for (const node of nodes)
      for (const [text, item] of this.#contents(node)) {
        this.host.work.charge("checks");
        items.set(text, item);
      }
    for (const ref of extra) this.#held(items, ref);
    const list = [...items.values()];
    for (const term of summary.terms.values()) {
      this.host.work.charge("checks");
      if (!this.host.compatible(list, term)) return true;
    }
    return false;
  }

  /** A node landed at its top by one more contributor (a copy's own path), without a test: one per node and ref. */
  public landedTop(node: Touch | null, ref: TouchRef): Touch {
    const top = this.leaf([], [ref]);
    if (node === null) return top;
    const key = keptParts(this.host.work, node.id, ref.text);
    let found = this.#tops.get(key);
    if (found === undefined) {
      found = this.#node({
        branches: node.branches,
        refs: [],
        parts: [node, top],
        opaque: node.opaque,
        here: true,
        landed: true,
        size: node.size + 1,
        base: node,
        delta: top,
        anchors: this.#anchorsBelow(node),
        met: node.met,
      });
      this.#tops.set(key, found);
      if (this.#shared.has(node.id)) this.#shared.add(found.id);
    }
    return found;
  }

  #foundIds = 2;
  readonly #unions = new Map<string, Found>();
  readonly #unders = new Map<string, Found>();

  #foundWith(
    branch: FoundBranch | null,
    key: string,
    node: Found,
    priority = priorityOf(key),
  ): FoundBranch {
    const make = (
      k: string,
      p: number,
      n: Found,
      l: FoundBranch | null,
      r: FoundBranch | null,
    ): FoundBranch => ({
      key: k,
      priority: p,
      node: n,
      left: l,
      right: r,
      count: 1 + foundCount(l) + foundCount(r),
    });
    if (branch === null) return make(key, priority, node, null, null);
    if (key === branch.key) return make(key, branch.priority, node, branch.left, branch.right);
    if (key < branch.key) {
      const left = this.#foundWith(branch.left, key, node, priority);
      return left.priority > branch.priority
        ? make(
            left.key,
            left.priority,
            left.node,
            left.left,
            make(branch.key, branch.priority, branch.node, left.right, branch.right),
          )
        : make(branch.key, branch.priority, branch.node, left, branch.right);
    }
    const right = this.#foundWith(branch.right, key, node, priority);
    return right.priority > branch.priority
      ? make(
          right.key,
          right.priority,
          right.node,
          make(branch.key, branch.priority, branch.node, branch.left, right.left),
          right.right,
        )
      : make(branch.key, branch.priority, branch.node, branch.left, right);
  }

  #foundGet(branch: FoundBranch | null, key: string): Found | undefined {
    for (let at = branch; at !== null; at = key < at.key ? at.left : at.right)
      if (at.key === key) return at.node;
    return undefined;
  }

  #foundEntries(branch: FoundBranch | null, out: [string, Found][]): void {
    if (branch === null) return;
    this.#foundEntries(branch.left, out);
    out.push([branch.key, branch.node]);
    this.#foundEntries(branch.right, out);
  }

  /**
   * The paths of both, each once: the smaller's branches put in the larger's, once per pair; only those the larger does
   * not hold as they are, where the two share subtrees (a node's meetings are mostly its parts', #1270).
   */
  #unite(a: Found, b: Found): Found {
    if (a === b || b === NONE) return a;
    if (a === NONE) return b;
    const key = keptParts(this.host.work, Math.min(a.id, b.id), Math.max(a.id, b.id));
    const known = this.#unions.get(key);
    if (known !== undefined) return known;
    const [big, small] = foundCount(a.branches) >= foundCount(b.branches) ? [a, b] : [b, a];
    let branches = big.branches;
    let entries = differing(small.branches, big.branches, 8 + foundCount(small.branches), () =>
      this.#charge(),
    );
    if (entries === null) this.#foundEntries(small.branches, (entries = []));
    for (const [step, inner] of entries) {
      this.#charge(1 + Math.ceil(Math.log2(1 + foundCount(branches))));
      const other = this.#foundGet(branches, step);
      branches = this.#foundWith(
        branches,
        step,
        other === undefined ? inner : this.#unite(other, inner),
      );
    }
    const out: Found =
      branches === big.branches && big.here === (a.here || b.here)
        ? big
        : { id: this.#foundIds++, here: a.here || b.here, branches };
    this.#unions.set(key, out);
    return out;
  }

  /** A found trie under one step. */
  #under(step: string, inner: Found): Found {
    if (inner === NONE) return NONE;
    const key = keptParts(this.host.work, inner.id, step);
    let out = this.#unders.get(key);
    if (out === undefined) {
      this.#charge();
      out = { id: this.#foundIds++, here: false, branches: this.#foundWith(null, step, inner) };
      this.#unders.set(key, out);
    }
    return out;
  }

  /**
   * A payload's contributors meeting every node standing below another node (itself too), once per payload and node:
   * for `elements` every node standing there is owed (a holder beside it); for `meet` a landed node where its own
   * meeting or the payload's contents may not meet its landed types, the payload asked once per payload node and types.
   */
  #expand(payload: Payload, other: Touch, mode: TouchMode): Found {
    const key = keptParts(this.host.work, mode, payload.id, other.id);
    const known = this.#expanded.get(key);
    if (known !== undefined) return known;
    const found: [readonly string[]][] = [];
    this.#walk(other, mode, (node, rest) => {
      if (mode === "elements") {
        // (a holder beside what stands there: owed where the contents there hold two kinds or more, the payload's
        // kinds asked once per payload node and path)
        const kinds = new Set<string>(this.#payloadKinds(payload, rest));
        for (const item of this.#contents(node).values()) {
          this.host.work.charge("checks");
          if (this.host.concrete(item)) kinds.add(item.tag);
        }
        if (kinds.size > 1) found.push([rest]);
        return;
      }
      const summary = this.#summary(node, "meet");
      if (summary.met) {
        found.push([rest]);
        return;
      }
      if (summary.terms.size === 0) return;
      const terms = [...summary.terms.keys()].sort().join(",");
      keepText(this.host.work, terms.length);
      if (this.#owed([node], [], mode) || this.#payloadMeets(payload, rest, summary.terms, terms))
        found.push([rest]);
    });
    let out: Found = NONE;
    for (const [rest] of found) out = this.#unite(out, this.#at(rest));
    this.#expanded.set(key, out);
    return out;
  }

  /**
   * For `elements`, what a node holding a ring owes where it contains the other (or is merged with itself): its meetings
   * found in making it where its contents hold two kinds or more, as an element standing in the other's stead may offend
   * there (§2.2). Once per node.
   */
  #metOwed(node: Touch): Found {
    const known = this.#metOwes.get(node.id);
    if (known !== undefined) return known;
    const paths: (readonly string[])[] = [];
    this.paths(node.met, [], paths);
    let out: Found = NONE;
    for (const path of paths)
      if (this.kindsAt(node, path).size > 1) out = this.#unite(out, this.#at(path));
    this.#metOwes.set(node.id, out);
    return out;
  }

  /**
   * What a node containing another owes where a merge ends at it, no ring standing in it (§2.2 step 3, §2.4 (d)): its
   * meetings found in making it, as the contained node's landed types may decide the place merging them; for `elements`
   * only where its contents hold two kinds or more, as an element standing in the other's stead may offend there. Only
   * where the two differ:
   * below a path where they are one node, under the same payloads, nothing of the container's own stands, so it meets
   * the contained node there no more than a node merged with itself does (#1270: a shared node's meetings were owed again
   * by every place or literal holding it beside a small part of its own). The walk enters the children the two do not
   * share, found from the smaller of the meetings there and the two children maps' difference. Once per pair.
   */
  #containedOwes(outer: Touch, inner: Touch, mode: TouchMode): Found {
    const key = keptParts(this.host.work, mode, outer.id, inner.id);
    const known = this.#owes.get(key);
    if (known !== undefined) return known;
    let out: Found = NONE;
    // (every meeting below a path: for `meet` the found trie itself, taken whole; for `elements` each path's kinds read)
    const oweAll = (met: Found, path: readonly string[]): void => {
      if (mode === "meet") {
        let at = met;
        for (let index = path.length - 1; index >= 0; index -= 1)
          at = this.#under(path[index]!, at);
        out = this.#unite(out, at);
        return;
      }
      const paths: (readonly string[])[] = [];
      this.paths(met, path, paths);
      for (const each of paths)
        if (this.kindsAt(outer, each).size > 1) out = this.#unite(out, this.#at(each));
    };
    const stack: {
      readonly x: Touch | undefined;
      readonly y: Touch | undefined;
      readonly met: Found;
      readonly path: readonly string[];
    }[] = [{ x: outer, y: inner, met: outer.met, path: [] }];
    while (stack.length > 0) {
      const { x, y, met, path } = stack.pop()!;
      this.#charge();
      if (met === NONE || x === y) continue;
      if (x === undefined || y === undefined || x.opaque !== y.opaque) {
        // (the contained node stands nowhere here, or a payload of the container's own stands here, which meets
        // everything below: every meeting below is owed)
        oweAll(met, path);
        continue;
      }
      if (met.here && (mode === "meet" || this.kindsAt(outer, path).size > 1))
        out = this.#unite(out, this.#at(path));
      const differs = differing(x.branches, y.branches, 8 + 2 * foundCount(met.branches), () =>
        this.#charge(),
      );
      const steps: string[] = [];
      if (differs !== null) for (const [step] of differs) steps.push(step);
      else {
        const entries: [string, Found][] = [];
        this.#foundEntries(met.branches, entries);
        for (const [step] of entries) steps.push(step);
      }
      for (const step of steps) {
        this.#charge(this.#depth(x.branches));
        const below = this.#foundGet(met.branches, step);
        if (below === undefined) continue;
        stack.push({
          x: this.#get(x.branches, step),
          y: this.#get(y.branches, step),
          met: below,
          path: keptSteps(this.host.work, path, [step]),
        });
      }
    }
    this.#owes.set(key, out);
    return out;
  }

  #at(rest: readonly string[]): Found {
    let out = HERE;
    for (let index = rest.length - 1; index >= 0; index -= 1) out = this.#under(rest[index]!, out);
    return out;
  }

  /**
   * What a node merged with itself owes: nothing it did not meet in its making, but for `elements` a node holding a ring
   * owes its meetings with two kinds or more, as elements copying different members of the ring stand on it (§2.2).
   */
  #selfOwes(node: Touch, mode: TouchMode): Found {
    return mode === "elements" && this.#isRing(node) ? this.#metOwed(node) : NONE;
  }

  /**
   * The two nodes merged at one place's path, with the paths below it where they meet as the mode owes: memoized by
   * the two nodes; where one is a node merged with a small delta, through its base first (the base's merge with the
   * other is then shared by every place merging them), as far as the deltas cost no more than listing the smaller.
   */
  public merge(
    a: Touch | null,
    b: Touch | null,
    mode: TouchMode,
  ): { node: Touch | null; found: Found } {
    if (a === null) return { node: b, found: NONE };
    if (b === null) return { node: a, found: NONE };
    if (a === b) return { node: a, found: this.#selfOwes(a, mode) };
    const key = (x: Touch, y: Touch): string =>
      keptParts(this.host.work, mode, Math.min(x.id, y.id), Math.max(x.id, y.id));
    const known = this.#memo.get(key(a, b));
    if (known !== undefined) {
      this.#charge();
      return known;
    }
    // (one walk down both nodes' bases, from shared node to shared node: at each pair, a known merge or a containment
    // either way ends it; else the cheaper next hop is taken (ties: the larger node's, then the lower id) while the
    // deltas taken cost no more than half the smaller node. Every pair passed is memoized as its deltas are merged
    // back, so no later walk passes it again, a failed one included; a base is reached only through deltas of at most
    // half their bases, so a fold or a tree of like parts is never taken apart)
    const budget = Math.min(a.size, b.size) / 2;
    let x = a;
    let y = b;
    let spent = 0;
    const deltas: Touch[] = [];
    let core: { node: Touch | null; found: Found } | null = null;
    // (the pairs passed on the way, each before its deltas were taken: each is known once the deltas are merged back)
    const pairs: ([Touch, Touch] | null)[] = [];
    const take = (hop: Hop, pair: [Touch, Touch]): void => {
      const taken: Touch[] = [];
      for (let at: Deltas | null = hop.deltas; at !== null; at = at.next) taken.push(at.delta);
      // (the deltas nearest the anchor are merged back first: the list runs from the node down)
      for (let index = 0; index < taken.length; index += 1) {
        pairs.push(index === 0 ? pair : null);
        deltas.push(taken[index]!);
      }
      spent += hop.cost;
    };
    for (;;) {
      // (a node containing the other is their union; it owes the meetings found in making it where it differs from the
      // other, whose landed types may decide where the two are merged; all of them where a ring stands in it)
      const owes = (outer: Touch, inner: Touch): Found =>
        outer === inner
          ? this.#selfOwes(outer, mode)
          : !this.#isRing(outer)
            ? this.#containedOwes(outer, inner, mode)
            : mode === "elements"
              ? this.#metOwed(outer)
              : outer.met;
      if (this.#contains(x, y)) core = { node: x, found: owes(x, y) };
      else if (this.#contains(y, x)) core = { node: y, found: owes(y, x) };
      else core = this.#memo.get(key(x, y)) ?? null;
      if (core !== null) break;
      const hopOf = (node: Touch): Hop | null => {
        const hop = this.#hop(node);
        return hop !== null && spent + hop.cost <= budget ? hop : null;
      };
      const hx = hopOf(x);
      const hy = hopOf(y);
      if (hx === null && hy === null) break;
      const takesX =
        hy === null ||
        (hx !== null &&
          (hx.cost < hy.cost ||
            (hx.cost === hy.cost && (x.size > y.size || (x.size === y.size && x.id < y.id)))));
      if (takesX) {
        take(hx!, [x, y]);
        x = hx!.anchor;
      } else {
        take(hy!, [x, y]);
        y = hy!.anchor;
      }
    }
    let result: { node: Touch | null; found: Found };
    if (deltas.length === 0) result = core ?? this.#direct(a, b, mode);
    else {
      if (core === null) {
        core = this.#direct(x, y, mode);
        this.#memo.set(key(x, y), core);
      }
      let node = core.node;
      let found = core.found;
      for (let index = deltas.length - 1; index >= 0; index -= 1) {
        const next = this.merge(node, deltas[index]!, mode);
        node = next.node;
        found = this.#unite(found, next.found);
        const pair = pairs[index];
        if (pair !== null && pair !== undefined)
          this.#memo.set(key(pair[0], pair[1]), { node, found });
      }
      result = { node, found };
    }
    this.#memo.set(key(a, b), result);
    return result;
  }

  #direct(a: Touch, b: Touch, mode: TouchMode): { node: Touch; found: Found } {
    const [big, small] = a.size >= b.size ? [a, b] : [b, a];
    let found: Found = NONE;
    let here = false;
    // (an opaque node's contributors hold anything below it: they meet every node standing below the other)
    // (for `elements`, two opaque nodes owe every path landed below them, which the literal walks once: no expansion)
    const both = mode === "elements" && a.opaque !== null && b.opaque !== null;
    if (a.opaque !== null && !both) found = this.#unite(found, this.#expand(a.opaque, b, mode));
    if (b.opaque !== null && !both) found = this.#unite(found, this.#expand(b.opaque, a, mode));
    if (both) here = true;
    else if (a.here && b.here && (mode === "elements" || a.landed || b.landed))
      here = this.#owed([a, b], [], mode);
    // (the smaller node's branches, each looked up in the larger's: the common ones merged, the others taken whole)
    let branches = big.branches;
    const entries: [string, Touch][] = [];
    this.#entries(small.branches, entries);
    for (const [step, child] of entries) {
      this.#charge(this.#depth(branches));
      const other = this.#get(big.branches, step);
      if (other === undefined) {
        branches = this.#with(branches, step, child);
        continue;
      }
      const merged = this.merge(other, child, mode);
      if (merged.node !== other) branches = this.#with(branches, step, merged.node!);
      if (merged.found !== NONE) found = this.#unite(found, this.#under(step, merged.found));
    }
    const opaque = this.unitePayloads(a.opaque, b.opaque);
    if (here) found = this.#unite(found, HERE);
    const node = this.#node({
      branches,
      refs: [],
      parts: [a, b],
      opaque,
      here: a.here || b.here,
      landed: a.landed || b.landed,
      size: big.size + small.size,
      base: big,
      delta: small,
      anchors: this.#anchorsBelow(big),
      met:
        mode === "meet" ? this.#unite(this.#unite(a.met, b.met), found) : this.#unite(a.met, b.met),
    });
    return { node, found };
  }

  /** The paths a found trie holds, each under `prefix`. */
  public paths(found: Found, prefix: readonly string[], out: (readonly string[])[]): void {
    const stack: { readonly found: Found; readonly prefix: readonly string[] }[] = [
      { found, prefix },
    ];
    while (stack.length > 0) {
      const { found: at, prefix: under } = stack.pop()!;
      this.#charge();
      if (at.here) out.push(under);
      const entries: [string, Found][] = [];
      this.#foundEntries(at.branches, entries);
      for (const [step, inner] of entries)
        stack.push({ found: inner, prefix: keptSteps(this.host.work, under, [step]) });
    }
  }
}
