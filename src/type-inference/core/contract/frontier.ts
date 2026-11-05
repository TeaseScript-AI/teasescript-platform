import type { PlaceId } from "../../graph.js";
import { joinParts, keep, keptParts } from "../budget.js";
import type { Contract } from "../contract.js";
import { keyOf, keyPath, keyPlace, type Key } from "../definitions.js";
import { makeItem, mergeItems, REASON, type Item } from "../items.js";
import { selectsElement } from "../method-categories.js";
import { positions } from "../positions.js";
import type { Work } from "../solver.js";
import type { FlowSink } from "./contributions.js";
import { entered, ingressLeafOf } from "./ingress.js";
import { canonicalKey, isKeyId, stepsArray, type PathRef } from "./key-ids.js";
import { hostAt, propertyOnly, unknownItem } from "./kinds.js";
import { pathAt } from "./literal-index.js";
import { lackingAt } from "./literal-items.js";
import { marksNothing } from "./marks.js";
import type { IndexNode, LiteralIndex, PrefixEntry } from "./model.js";

/*
 * #1655: a read below a push, one step at a time. A prefix's key entry below its own root (`p1 = p1.q`, a copy cycle
 * through a projection) read at a rest is the key `p1.q·rest`, which reads that entry again at `q·rest`: every read
 * makes a longer key, and no two of them are one by their structure. Below such an entry's writing edge (`entryAt`'s
 * `withWriter`), the read is the join of the leaves its producers reach, found over a finite producer graph of the
 * pass: a binding's positions (`key`, its whole-copy cycle one node through the summaries' least solution), a
 * literal's index nodes (`lit`), and leaves (`leaf`: F11's `missing`, a host's unknown, a literal's terms; `native`:
 * a value the graph does not model, read natively where the path ends). `Sum(n, s)` is the nodes one step `s` below
 * `n` reaches (least solution, cycles closed by producer edges only, seedless ones empty); `Term(n)` the leaves at
 * `n`. The writing edge overwrites every writer but a pure `missing`'s, whose earliest token the join keeps, and every
 * other field the merge joins, so the join is the native nested answer there (HEAD 0, TABLE r4.385). A closure outside
 * the eligible grammar declines: the native reader answers.
 */

type FNode =
  | {
      readonly kind: "key";
      readonly place: PlaceId;
      readonly path: readonly string[];
      readonly key: Key;
      /** The places it stands for: at a root, its cycle of whole copies (equal one step below every one), else itself. */
      readonly members: readonly PlaceId[];
    }
  | {
      readonly kind: "lit";
      readonly literal: PlaceId;
      readonly index: LiteralIndex;
      readonly at: IndexNode;
      readonly id: number;
    }
  | { readonly kind: "leaf"; readonly item: Item }
  | { readonly kind: "native"; readonly value: PlaceId };

interface Goal {
  readonly node: number;
  readonly step: string;
  value: Set<number>;
  readonly readers: Set<Goal>;
  final: boolean;
}

/** The answer a pushed read takes from the graph: its leaves' items and the values read natively at its end. */
interface Reach {
  readonly items: readonly Item[];
  readonly natives: readonly PlaceId[];
}

/** A closure outside the grammar: the native reader answers. Its reason names the rule (the facts' count, tests). */
class Decline extends Error {
  public constructor(readonly reason: string) {
    super(reason);
  }
}

let pushing = true;
let horizon: number | null = null;

/** The slot of a key past the oracle's horizon (`withoutPushedReads`): it answers nothing, bottom. */
const BEYOND = "pr|beyond";

/**
 * Test-only: runs `callback` with every pushed read answered by the native reader, the oracle of #1655's lemma; with a
 * `depth`, a read of a key entry below its place's root at more steps than it answers nothing (bottom), so where the
 * native reader does not end its answers are the least fixed point's approximations from below.
 */
export function withoutPushedReads<T>(callback: () => T, depth: number | null = null): T {
  if (!pushing) throw new Error("Pushed reads are already off.");
  pushing = false;
  horizon = depth;
  try {
    return callback();
  } finally {
    pushing = true;
    horizon = null;
  }
}

/** A pass's producer graph (per contract: a new pass has a new one). */
class Frontier {
  readonly nodes: FNode[] = [];
  readonly ids = new Map<string, number>();
  readonly goals = new Map<number, Map<string, Goal>>();
  /** Interned node sets: their members and, per step, the set one step below (final goals only). */
  readonly sets = new Map<string, number>();
  readonly members: (readonly number[])[] = [];
  readonly below = new Map<number, Map<string, number>>();
  /** Per node, the leaves at it (`Term`'s closure), once final. */
  readonly leaves = new Map<number, readonly number[]>();
  /** Per pushed slot, its reach, or `null` where its closure declined. */
  readonly reads = new Map<string, Reach | null>();
  /** Per binding, its root's node (`rootNode`). */
  readonly roots = new Map<PlaceId, number>();
  /** The bindings the graph holds a position of, which a stop at any of them makes decline (`stoppedAt`). */
  readonly places = new Set<PlaceId>();
  /** Per place, whether a copy cycle through a projection holds it. */
  readonly cyclic = new Map<PlaceId, boolean>();
  /** Per decline reason, the pushed reads it declined (`pushedDeclines`). */
  readonly declines = new Map<string, number>();
  /** The goals of the build running, finalised when it ends, dropped when it declines. */
  pending: Goal[] = [];
  queue: Goal[] = [];

  public constructor(readonly contract: Contract) {}
}

const FRONTIERS = new WeakMap<Contract, Frontier>();

function frontierOf(contract: Contract): Frontier {
  let frontier = FRONTIERS.get(contract);
  if (frontier === undefined) FRONTIERS.set(contract, (frontier = new Frontier(contract)));
  return frontier;
}

/** One unit of structure work, shared (r4.349): counted to the analysis's total, never the asker's. */
function step(frontier: Frontier, units = 1): void {
  frontier.contract.pass.program.work.charge("structureSteps", units);
}

function nodeId(frontier: Frontier, name: string, make: () => FNode): number {
  const known = frontier.ids.get(name);
  if (known !== undefined) return known;
  frontier.contract.keepText(name.length);
  frontier.contract.keep(2);
  const id = frontier.nodes.length;
  frontier.nodes.push(make());
  frontier.ids.set(name, id);
  return id;
}

/** Declines a place the graph does not model as a binding's position. */
function eligible(contract: Contract, place: PlaceId): void {
  const { program } = contract.pass;
  const kind = program.places[place]?.kind;
  if (
    kind === undefined ||
    kind.kind !== "binding" ||
    (kind.declared !== "let" && kind.declared !== "global") ||
    program.isHost(place) ||
    program.speakerPlaces.has(place) ||
    program.cellOwner.has(place) ||
    program.hasOf.has(place)
  )
    throw new Decline("place");
  if (kind.written !== null) throw new Decline("written");
  if (stoppedAt(contract, place)) throw new Decline("stopped");
}

/** A binding's position below its root, where the graph models it; declines otherwise. */
function keyNode(frontier: Frontier, place: PlaceId, path: readonly string[]): number {
  if (path.length === 0) return rootNode(frontier, place);
  const name = keyOf(place, path);
  const known = frontier.ids.get(name);
  if (known !== undefined) return known;
  const { contract } = frontier;
  eligible(contract, place);
  // (a key whose family is a cursor's, or whose first step passes a wrapper, is G3's)
  if (isKeyId(canonicalKey(contract, name))) throw new Decline("cursor");
  if (positions() && contract.wrapperHop(place, path[0]!) !== null) throw new Decline("wrapper");
  frontier.places.add(place);
  return nodeId(frontier, name, () => ({ kind: "key", place, path, key: name, members: [place] }));
}

/**
 * A binding's root as a node: one per cycle of whole copies (its root's key entries of no step, Tarjan's components
 * once per place and pass), whose members reach one another one step below at every step, so their summaries are one
 * set, listed once (the ring's content by reference, never a copy per member).
 */
function rootNode(frontier: Frontier, place: PlaceId): number {
  const known = frontier.roots.get(place);
  if (known !== undefined) return known;
  const { contract } = frontier;
  const index = new Map<PlaceId, number>();
  const low = new Map<PlaceId, number>();
  const open: PlaceId[] = [];
  const held = new Set<PlaceId>();
  const frames: { readonly place: PlaceId; readonly to: readonly PlaceId[]; at: number }[] = [];
  const enter = (at: PlaceId): void => {
    eligible(contract, at);
    const to: PlaceId[] = [];
    for (const entry of contract.prefixStores(keyOf(at, [])).list) {
      step(frontier);
      if (entry.key !== undefined && !isKeyId(entry.key) && keyPath(entry.key).length === 0)
        to.push(keyPlace(entry.key));
    }
    index.set(at, index.size);
    low.set(at, index.size - 1);
    open.push(at);
    held.add(at);
    frames.push({ place: at, to, at: 0 });
  };
  enter(place);
  while (frames.length > 0) {
    const top = frames.at(-1)!;
    if (top.at < top.to.length) {
      const to = top.to[top.at++]!;
      if (frontier.roots.has(to)) continue;
      if (!index.has(to)) enter(to);
      else if (held.has(to)) low.set(top.place, Math.min(low.get(top.place)!, index.get(to)!));
      continue;
    }
    frames.pop();
    if (frames.length > 0) {
      const parent = frames.at(-1)!.place;
      low.set(parent, Math.min(low.get(parent)!, low.get(top.place)!));
    }
    if (low.get(top.place) !== index.get(top.place)) continue;
    const members: PlaceId[] = [];
    for (;;) {
      const member = open.pop()!;
      held.delete(member);
      members.push(member);
      if (member === top.place) break;
    }
    members.sort((a, b) => a - b);
    const first = members[0]!;
    for (const member of members) frontier.places.add(member);
    const id = nodeId(frontier, keyOf(first, []), () => ({
      kind: "key",
      place: first,
      path: [],
      key: keyOf(first, []),
      members,
    }));
    for (const member of members) frontier.roots.set(member, id);
  }
  return frontier.roots.get(place)!;
}

function stoppedAt(contract: Contract, place: PlaceId): boolean {
  if (!contract.anyStopped) return false;
  return contract.stoppedKeys().some((stopped) => stopped.place === place);
}

/** Whether a binding's position has stores at or below it. */
function holds(contract: Contract, place: PlaceId, path: readonly string[]): boolean {
  const { definitions } = contract.pass;
  const key = keyOf(place, path);
  return (definitions.byKey.get(key) ?? []).length > 0 || definitions.keysBelow(key).length > 0;
}

function litNode(frontier: Frontier, literal: PlaceId, id: number, at: IndexNode): number {
  return nodeId(frontier, joinParts("l", literal, id), () => ({
    kind: "lit",
    literal,
    index: frontier.contract.literalIndex(literal),
    at,
    id,
  }));
}

function leafNode(frontier: Frontier, name: string, item: () => Item): number {
  return nodeId(frontier, name, () => ({ kind: "leaf", item: item() }));
}

function nativeNode(frontier: Frontier, value: PlaceId): number {
  return nodeId(frontier, joinParts("n", value), () => ({ kind: "native", value }));
}

/** A literal's root as a node: a plain record or scalar literal (no cell, no selection). */
function literalRoot(frontier: Frontier, literal: PlaceId): number {
  const index = frontier.contract.literalIndex(literal);
  return litNode(frontier, literal, 0, index.root);
}

/**
 * The nodes a value stands for, as a step reads it: a binding's read its root, a host's read its leaf, a property read
 * its owner's nodes one step below, a literal its root; declines for any other (and for a guarded or ingress read).
 */
function valueNodes(frontier: Frontier, value: PlaceId, reader: Goal | null): readonly number[] {
  const { contract } = frontier;
  const { program, guards } = contract.pass;
  step(frontier);
  const binding = program.occurrenceOf.get(value);
  if (binding !== undefined) {
    if (program.isHost(binding)) return [hostLeaf(frontier, value)];
    if (!guards.untested(binding) || guards.guardedRead(value)) throw new Decline("guarded");
    if (ingressLeafOf(contract, value) !== undefined) throw new Decline("ingress");
    return [keyNode(frontier, binding, [])];
  }
  const projection = program.projOf.get(value);
  if (projection !== undefined) {
    if (!propertyOnly(projection.step) || selectsElement(projection.step))
      throw new Decline("step");
    if (ingressLeafOf(contract, value) !== undefined) throw new Decline("ingress");
    if (positions() && passesWrapper(contract, value)) throw new Decline("wrapper");
    return advance(
      frontier,
      valueNodes(frontier, projection.owner, reader),
      projection.step,
      reader,
    );
  }
  if (program.hasOf.has(value) && !program.cellOwner.has(value))
    return [literalRoot(frontier, value)];
  throw new Decline("value");
}

/**
 * The nodes one step below `nodes`: settled (`star`) outside a goal's evaluation; inside one (`reader`), as its
 * dependencies stand now, each read registering the goal, so no build settles inside another.
 */
function advance(
  frontier: Frontier,
  nodes: readonly number[],
  stepName: string,
  reader: Goal | null,
): readonly number[] {
  if (reader === null)
    return setMembers(frontier, star(frontier, intern(frontier, nodes), stepName));
  const out = new Set<number>();
  stepAll(frontier, nodes, stepName, reader, out);
  return [...out];
}

/** Whether a property read's chain passes a wrapper at its first step (G3's position, `positionOf`). */
function passesWrapper(contract: Contract, value: PlaceId): boolean {
  const chain = contract.chainOf(value);
  return chain !== null && contract.wrapperHop(chain.root, chain.first) !== null;
}

/** A host read's leaf: the runtime's unknown at every path, its ingress entered (`hostAt`, `entered`). */
function hostLeaf(frontier: Frontier, value: PlaceId): number {
  return leafNode(
    frontier,
    joinParts("h", value),
    () => entered(frontier.contract, value, hostAt({ length: 0, at: () => undefined }))[0]!,
  );
}

// --- the summaries -------------------------------------------------------------------------------------------------

function goalOf(frontier: Frontier, node: number, stepName: string, reader: Goal | null): Goal {
  let bySteps = frontier.goals.get(node);
  if (bySteps === undefined) frontier.goals.set(node, (bySteps = new Map()));
  let goal = bySteps.get(stepName);
  if (goal === undefined) {
    frontier.contract.keep(2);
    goal = { node, step: stepName, value: new Set(), readers: new Set(), final: false };
    bySteps.set(stepName, goal);
    frontier.pending.push(goal);
    frontier.queue.push(goal);
  }
  if (reader !== null && !goal.final) goal.readers.add(reader);
  return goal;
}

/** The nodes one step below each of `nodes`, as they stand now (a reader of each goal). */
function stepAll(
  frontier: Frontier,
  nodes: Iterable<number>,
  stepName: string,
  reader: Goal,
  out: Set<number>,
): void {
  for (const node of nodes)
    for (const below of goalOf(frontier, node, stepName, reader).value) {
      step(frontier);
      out.add(below);
    }
}

/** A goal's nodes from the rules, with what its dependencies hold now. */
function evaluate(frontier: Frontier, goal: Goal): Set<number> {
  const { contract } = frontier;
  const node = frontier.nodes[goal.node]!;
  const s = goal.step;
  const out = new Set<number>();
  step(frontier);
  if (node.kind === "leaf") return new Set([goal.node]);
  if (node.kind === "native") throw new Decline("native");
  if (node.kind === "key") {
    const below = [...node.path, s];
    const inside = new Set(node.members);
    for (const member of node.members) {
      if (holds(contract, member, below)) out.add(keyNode(frontier, member, below));
      if (node.path.length === 0 && positions() && contract.wrapperHop(member, s) !== null)
        throw new Decline("wrapper");
      const stores = contract.prefixStores(keyOf(member, node.path));
      if (stores.subs !== null || stores.also.length > 0) throw new Decline("layers");
      for (const entry of stores.list) {
        step(frontier);
        // (a whole copy of a member: the component's own summary, which adds nothing to itself)
        if (
          node.path.length === 0 &&
          entry.key !== undefined &&
          !isKeyId(entry.key) &&
          keyPath(entry.key).length === 0 &&
          inside.has(keyPlace(entry.key)) &&
          entry.w !== null &&
          plainRead(contract, entry)
        )
          continue;
        stepEntry(frontier, entry, s, goal, out);
      }
    }
    return out;
  }
  // a literal's index node: its child at the step, F11's `missing` where an object lacks it, its reads one step below
  const { literal, index, at, id } = node;
  if (at.reference) throw new Decline("reference");
  if (at.others.length > 0) throw new Decline("native");
  const child = at.children.get(s);
  if (child !== undefined) out.add(litNode(frontier, literal, pathAt(contract, id, s), child));
  const lacking = lackingAt(contract, index, id, s);
  if (lacking !== null)
    out.add(
      leafNode(frontier, joinParts("m", literal, id, s), () =>
        unknownItem(REASON.missing, lacking),
      ),
    );
  for (const read of at.reads) {
    if (!plainRead(contract, read)) throw new Decline("marks");
    stepAll(frontier, valueNodes(frontier, read.value, goal), s, goal, out);
  }
  return out;
}

/** Whether an entry or a literal's read carries no mark and no ingress of its own (`annotated` leaves it as it is). */
function plainRead(
  contract: Contract,
  read: {
    readonly guarded: boolean;
    readonly holder: PrefixEntry["holder"];
    readonly ingress: PrefixEntry["ingress"];
    readonly value?: PlaceId;
  },
): boolean {
  if (read.guarded || !marksNothing(contract, read.holder)) return false;
  return (
    read.ingress === undefined ||
    (read.value !== undefined && read.ingress === ingressLeafOf(contract, read.value))
  );
}

/** A prefix entry one step below: a key entry its key's nodes then the step, a value's nodes at its steps then it. */
function stepEntry(
  frontier: Frontier,
  entry: PrefixEntry,
  s: string,
  goal: Goal,
  out: Set<number>,
): void {
  const { contract } = frontier;
  if (entry.unk !== undefined || entry.empty === true || entry.elem !== undefined)
    throw new Decline("entry");
  if (entry.w === null) throw new Decline("writer");
  if (!plainRead(contract, entry)) throw new Decline("marks");
  if (entry.key !== undefined) {
    if (isKeyId(entry.key)) throw new Decline("cursor");
    const path = keyPath(entry.key);
    let nodes: Iterable<number> = [keyNode(frontier, keyPlace(entry.key), [])];
    for (const each of path) {
      if (!propertyOnly(each)) throw new Decline("step");
      const next = new Set<number>();
      stepAll(frontier, nodes, each, goal, next);
      nodes = next;
    }
    stepAll(frontier, nodes, s, goal, out);
    return;
  }
  let nodes: Iterable<number> = valueNodes(frontier, entry.value!, goal);
  for (const each of entry.at ?? []) {
    if (!propertyOnly(each)) throw new Decline("step");
    const next = new Set<number>();
    stepAll(frontier, nodes, each, goal, next);
    nodes = next;
  }
  stepAll(frontier, nodes, s, goal, out);
}

/** Runs the queued goals to their least solution; each goal re-evaluated where a goal it read grew. */
function settle(frontier: Frontier): void {
  for (let goal = frontier.queue.pop(); goal !== undefined; goal = frontier.queue.pop()) {
    if (goal.final) continue;
    const next = evaluate(frontier, goal);
    if (next.size === goal.value.size) continue;
    keep(frontier.contract.work, next.size - goal.value.size);
    goal.value = next;
    for (const reader of goal.readers) frontier.queue.push(reader);
  }
  for (const goal of frontier.pending) {
    goal.final = true;
    goal.readers.clear();
  }
  frontier.pending = [];
}

/** Drops the goals of a build that declined or stopped: none of them is final. */
function rollback(frontier: Frontier): void {
  for (const goal of frontier.pending) frontier.goals.get(goal.node)?.delete(goal.step);
  frontier.pending = [];
  frontier.queue = [];
}

function intern(frontier: Frontier, nodes: Iterable<number>): number {
  const list = [...new Set(nodes)].sort((a, b) => a - b);
  step(frontier, list.length);
  const name = list.join(",");
  const known = frontier.sets.get(name);
  if (known !== undefined) return known;
  frontier.contract.keepText(name.length);
  keep(frontier.contract.work, list.length + 2);
  const id = frontier.members.length;
  frontier.members.push(list);
  frontier.sets.set(name, id);
  return id;
}

function setMembers(frontier: Frontier, set: number): readonly number[] {
  return frontier.members[set]!;
}

/** The interned set one step below a set: each member's goal settled first, once per set and step. */
function star(frontier: Frontier, set: number, stepName: string): number {
  let bySteps = frontier.below.get(set);
  const known = bySteps?.get(stepName);
  if (known !== undefined) return known;
  const goals = frontier.members[set]!.map((node) => goalOf(frontier, node, stepName, null));
  settle(frontier);
  const out = new Set<number>();
  for (const goal of goals)
    for (const node of goal.value) {
      step(frontier);
      out.add(node);
    }
  const id = intern(frontier, out);
  if (bySteps === undefined) frontier.below.set(set, (bySteps = new Map()));
  bySteps.set(stepName, id);
  return id;
}

// --- the leaves at a node ------------------------------------------------------------------------------------------

/** What a node holds where the path ends: its leaves, and the nodes whose leaves are its own too (ε). */
function termOf(frontier: Frontier, id: number): { leaves: number[]; next: number[] } {
  const { contract } = frontier;
  const { program, definitions, lists } = contract.pass;
  const node = frontier.nodes[id]!;
  const leaves: number[] = [];
  const next: number[] = [];
  step(frontier);
  const value = (v: PlaceId): void => {
    step(frontier);
    const binding = program.occurrenceOf.get(v);
    if (binding !== undefined && program.isHost(binding)) leaves.push(hostLeaf(frontier, v));
    else if (
      binding !== undefined ||
      program.projOf.has(v) ||
      (program.hasOf.has(v) && !program.cellOwner.has(v))
    ) {
      // (a value the graph models stands for its nodes; one it declines is read natively)
      const before = frontier.pending.length;
      try {
        next.push(...valueNodes(frontier, v, null));
      } catch (error) {
        // (a decline inside a summary's build declines the read; one at the value itself reads it natively)
        if (!(error instanceof Decline) || frontier.pending.length !== before) throw error;
        leaves.push(nativeNode(frontier, v));
      }
    } else leaves.push(nativeNode(frontier, v));
  };
  if (node.kind === "leaf" || node.kind === "native") leaves.push(id);
  else if (node.kind === "key") {
    for (const member of node.members)
      for (const d of definitions.byKey.get(keyOf(member, node.path)) ?? []) {
        step(frontier);
        if (!lists.live(d)) continue;
        if (d.kind !== "whole" || d.how === "argument" || d.how === "parameter default")
          throw new Decline("definition");
        value(d.value!);
      }
  } else {
    for (const [tag, token] of node.at.terms)
      leaves.push(
        leafNode(frontier, joinParts("t", node.literal, node.id, tag), () => makeItem(tag, token)),
      );
    for (const read of node.at.reads) {
      if (!plainRead(contract, read)) throw new Decline("marks");
      value(read.value);
    }
    for (const other of node.at.others) leaves.push(nativeNode(frontier, other.value));
  }
  return { leaves, next };
}

/** The leaves at each of `start`'s nodes and every node ε below it: Tarjan's components, one leaf list each. */
function leavesOf(frontier: Frontier, start: readonly number[]): Set<number> {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const open: number[] = [];
  const held = new Set<number>();
  const own = new Map<
    number,
    { readonly leaves: readonly number[]; readonly next: readonly number[] }
  >();
  const frames: { readonly node: number; readonly next: readonly number[]; at: number }[] = [];
  const enter = (node: number): void => {
    const term = termOf(frontier, node);
    // (projections' nodes found by their summaries, settled before the walk reads them)
    settle(frontier);
    index.set(node, index.size);
    low.set(node, index.size - 1);
    open.push(node);
    held.add(node);
    own.set(node, term);
    frames.push({ node, next: term.next, at: 0 });
  };
  for (const root of start) {
    if (frontier.leaves.has(root) || index.has(root)) continue;
    enter(root);
    while (frames.length > 0) {
      const top = frames.at(-1)!;
      if (top.at < top.next.length) {
        const to = top.next[top.at++]!;
        step(frontier);
        if (frontier.leaves.has(to)) continue;
        if (!index.has(to)) enter(to);
        else if (held.has(to)) low.set(top.node, Math.min(low.get(top.node)!, index.get(to)!));
        continue;
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames.at(-1)!.node;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.node)!));
      }
      if (low.get(top.node) !== index.get(top.node)) continue;
      const members: number[] = [];
      for (;;) {
        const member = open.pop()!;
        held.delete(member);
        members.push(member);
        if (member === top.node) break;
      }
      // (a component's leaves: its members' own and those of every component below it, finished already)
      const union = new Set<number>();
      for (const member of members) {
        const term = own.get(member)!;
        for (const leaf of term.leaves) union.add(leaf);
        for (const to of term.next)
          for (const leaf of frontier.leaves.get(to) ?? []) {
            step(frontier);
            union.add(leaf);
          }
      }
      const list = [...union].sort((a, b) => a - b);
      keep(frontier.contract.work, list.length);
      for (const member of members) frontier.leaves.set(member, list);
    }
  }
  const out = new Set<number>();
  for (const root of start) for (const leaf of frontier.leaves.get(root)!) out.add(leaf);
  return out;
}

// --- the pushed read -----------------------------------------------------------------------------------------------

/**
 * Whether a copy cycle through a projection holds `place`: its root's and positions' key entries and value reads as
 * edges between places, a projected key's (one below its place's root) marking the edge; Tarjan's components over
 * them, once per place and pass. A place whose component holds a marked edge is one.
 */
function cyclic(frontier: Frontier, place: PlaceId): boolean {
  const known = frontier.cyclic.get(place);
  if (known !== undefined) return known;
  const { contract } = frontier;
  const { program, definitions } = contract.pass;
  const index = new Map<PlaceId, number>();
  const low = new Map<PlaceId, number>();
  const open: PlaceId[] = [];
  const held = new Set<PlaceId>();
  const marked = new Map<PlaceId, boolean>();
  const frames: {
    readonly place: PlaceId;
    readonly to: readonly (readonly [PlaceId, boolean])[];
    at: number;
  }[] = [];
  const edgesOf = (at: PlaceId): (readonly [PlaceId, boolean])[] => {
    const to: (readonly [PlaceId, boolean])[] = [];
    if (program.places[at]?.kind.kind !== "binding") return to;
    const root = keyOf(at, []);
    for (const key of [root, ...definitions.keysBelow(root)]) {
      step(frontier);
      for (const entry of contract.prefixStores(key).list) {
        step(frontier);
        if (entry.key !== undefined) {
          if (isKeyId(entry.key)) continue;
          to.push([keyPlace(entry.key), keyPath(entry.key).length > keyPath(key).length]);
        } else if (entry.value !== undefined) {
          let value = entry.value;
          let projected = false;
          for (
            let projection = program.projOf.get(value);
            projection !== undefined;
            projection = program.projOf.get(value)
          ) {
            step(frontier);
            projected = true;
            value = projection.owner;
          }
          const binding = program.occurrenceOf.get(value);
          if (binding !== undefined) to.push([binding, projected]);
        }
      }
    }
    return to;
  };
  const enter = (at: PlaceId): void => {
    index.set(at, index.size);
    low.set(at, index.size - 1);
    open.push(at);
    held.add(at);
    frames.push({ place: at, to: edgesOf(at), at: 0 });
  };
  enter(place);
  while (frames.length > 0) {
    const top = frames.at(-1)!;
    if (top.at < top.to.length) {
      const [to] = top.to[top.at++]!;
      if (frontier.cyclic.has(to)) continue;
      if (!index.has(to)) enter(to);
      else if (held.has(to)) low.set(top.place, Math.min(low.get(top.place)!, index.get(to)!));
      continue;
    }
    frames.pop();
    if (frames.length > 0) {
      const parent = frames.at(-1)!.place;
      low.set(parent, Math.min(low.get(parent)!, low.get(top.place)!));
    }
    if (low.get(top.place) !== index.get(top.place)) continue;
    const members: PlaceId[] = [];
    for (;;) {
      const member = open.pop()!;
      held.delete(member);
      members.push(member);
      if (member === top.place) break;
    }
    marked.set(top.place, false);
    const inside = new Set(members);
    let isCyclic = false;
    for (const member of members)
      for (const [to, projected] of edgesOf(member))
        if (projected && inside.has(to)) isCyclic = true;
    for (const member of members) frontier.cyclic.set(member, isCyclic);
  }
  return frontier.cyclic.get(place)!;
}

/** Test-only: the pass's graph by its size (nodes, goals, their edges, interned sets) and its declines by reason. */
export function pushedFacts(contract: Contract): {
  readonly nodes: number;
  readonly goals: number;
  readonly edges: number;
  readonly sets: number;
  readonly reads: number;
  readonly declines: ReadonlyMap<string, number>;
} {
  const frontier = FRONTIERS.get(contract);
  let goals = 0;
  let edges = 0;
  for (const bySteps of frontier?.goals.values() ?? [])
    for (const goal of bySteps.values()) {
      goals += 1;
      edges += goal.value.size;
    }
  return {
    nodes: frontier?.nodes.length ?? 0,
    goals,
    edges,
    sets: frontier?.members.length ?? 0,
    reads: [...(frontier?.reads.values() ?? [])].filter((read) => read !== null).length,
    declines: frontier?.declines ?? new Map(),
  };
}

/**
 * #1655: the pushed read's slot for a prefix entry read at `ref` (`entryAt`'s key branch), or `null` where the native
 * reader answers: a key entry below its place's root, in a copy cycle through a projection, whose closure the graph
 * models. Its structure is built here, shared work (r4.349); a build that declines or stops keeps nothing.
 */
export function pushedSlot(contract: Contract, entry: PrefixEntry, ref: PathRef): string | null {
  if (!pushing)
    return horizon !== null &&
      entry.key !== undefined &&
      !isKeyId(entry.key) &&
      keyPath(entry.key).length > 0 &&
      keyPath(entry.key).length + ref.length > horizon
      ? BEYOND
      : null;
  if (entry.key === undefined || isKeyId(entry.key) || ref.length === 0 || ref.kind !== "steps")
    return null;
  const path = keyPath(entry.key);
  if (path.length === 0) return null;
  const frontier = frontierOf(contract);
  const steps = stepsArray(ref.steps());
  const slot = keptParts(contract.work, "pr", entry.key, steps);
  // (after a stop at a place the graph holds, the native reader answers: its keys ask their stops one by one)
  if (
    contract.anyStopped &&
    contract.stoppedKeys().some((stopped) => frontier.places.has(stopped.place))
  )
    return null;
  if (frontier.reads.has(slot)) return frontier.reads.get(slot) === null ? null : slot;
  const work = contract.pass.program.work;
  const reach = work.shared((): Reach | null => {
    try {
      if (!cyclic(frontier, keyPlace(entry.key!))) return null;
      if (!steps.every(propertyOnly) || !path.every(propertyOnly)) return null;
      let set = intern(frontier, [keyNode(frontier, keyPlace(entry.key!), [])]);
      for (const each of [...path, ...steps]) set = star(frontier, set, each);
      const items: Item[] = [];
      const natives: PlaceId[] = [];
      for (const leaf of leavesOf(frontier, setMembers(frontier, set))) {
        const node = frontier.nodes[leaf]!;
        if (node.kind === "leaf") items.push(node.item);
        else if (node.kind === "native") natives.push(node.value);
      }
      settle(frontier);
      return { items, natives };
    } catch (error) {
      rollback(frontier);
      if (!(error instanceof Decline)) throw error;
      frontier.declines.set(error.reason, (frontier.declines.get(error.reason) ?? 0) + 1);
      return null;
    }
  });
  frontier.reads.set(slot, reach);
  return reach === null ? null : slot;
}

/** The pushed read (`pushedSlot`) as a demand: its leaves joined, each value the graph does not model read natively. */
export function* pushedRead(
  contract: Contract,
  slot: string,
  entry: PrefixEntry,
  flow: FlowSink | null = null,
): Work<readonly Item[]> {
  if (slot === BEYOND) return [];
  const site = contract.pass.program.places[keyPlace(entry.key!)]?.site ?? null;
  flow?.include(slot, "pushed");
  return yield {
    key: slot,
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    make: () => pushedRun(contract, slot),
  };
}

function* pushedRun(contract: Contract, slot: string): Work<readonly Item[]> {
  // (#1668: this run's flow: the native reads it makes, under the entry's writer)
  const flow = contract.pass.solver.sink();
  // (any stop forgets it: the keys it stands for are not asked one by one, `remember`)
  contract.remember(slot);
  const reach = frontierOf(contract).reads.get(slot)!;
  const out: Item[] = [...reach.items];
  for (const value of reach.natives) {
    const read = flow?.child() ?? null;
    for (const item of yield* contract.contractOfValueAt(value, [], read)) out.push(item);
    if (read !== null) flow!.attach(read, "writer");
  }
  return mergeItems(out, contract.pass.program.scope);
}
