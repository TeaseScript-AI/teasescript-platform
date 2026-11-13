// The pushed-read frontier's producer graph (#1655): its record per contract, its nodes, goals and term goals, and the
// steps that make, intern and charge them.

import type { PlaceId } from "../../../graph.js";
import { joinParts, keep } from "../../budget.js";
import type { Contract } from "../../contract.js";
import { keyOf, keyPath, keyPlace, type Key } from "../../definitions.js";
import { type Item } from "../../items.js";
import { positions } from "../../positions.js";
import { canonicalKey, isKeyId } from "../key-ids.js";
import { propertyOnly } from "../kinds.js";
import type { Holder, IndexNode, LiteralIndex, PrefixEntry } from "../model.js";
import { amend, Retained } from "../../retained/retained.js";

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
  | { readonly kind: "native"; readonly value: PlaceId }
  /** #1784: `inner` reached through a marking route: its leaves `marked`. */
  | { readonly kind: "mark"; readonly inner: number }
  /**
   * #1784: `inner` (neither marked nor held) reached below entries whose holders' marks the rest decides: its pending
   * set (`internPending`), the states of their marks' automaton the steps taken since each entry left (`markStart`).
   */
  | { readonly kind: "hold"; readonly inner: number; readonly set: number };

/** A holder's mark a route newly takes: the holder and the steps since its entry, their arena path (`pathAt`). */
export interface Route {
  readonly holder: Holder;
  readonly path: number;
}

/** A node one step below another: `Sum(node, step)`, its nodes as found, each passed once to every reader. */
export interface Goal {
  readonly node: number;
  readonly step: string;
  readonly value: Set<number>;
  /** Its readers while it is not final; a final goal's nodes are read as they stand. */
  readers: ((node: number) => void)[] | null;
  /** #1784: per base node it holds held, the union of the pending sets it reached it with (`gain`). */
  holds?: Map<number, number>;
}

/** The answer a pushed read takes from the graph: its leaves' items and the values read natively at its end. */
export interface Reach {
  readonly items: readonly Item[];
  readonly natives: readonly PlaceId[];
}

/** A closure outside the grammar: the native reader answers. Its reason names the rule (the facts' count, tests). */
export class Decline extends Error {
  public constructor(readonly reason: string) {
    super(reason);
  }
}

/** A pass's producer graph (per contract: a new pass has a new one). */
export class Frontier {
  readonly nodes: FNode[];
  readonly ids: Map<string, number>;
  readonly goals = Retained.map<number, Map<string, Goal>>("Frontier.goals");
  /** Interned node sets: their members and, per step, the set one step below (final goals only). */
  readonly sets = Retained.map<string, number>("Frontier.sets");
  readonly members: (readonly number[])[] = Retained.arena("Frontier.members");
  readonly below = Retained.map<number, Map<string, number>>("Frontier.below");
  /** Per state (a node, twice it plus one where reached marked), the leaves at it (`Term`'s closure), once final. */
  readonly leaves = Retained.map<number, readonly number[]>("Frontier.leaves");
  /** Per pushed slot, its reach, or `null` where its closure declined. */
  readonly reads = Retained.map<string, Reach | null>("Frontier.reads");
  /** The host reads' leaves (`hostLeaf`). */
  readonly hosts: Set<number>;
  /** The stops and held places `heldStopped` last answered for, and its answer. */
  stopsSeen = { stops: -1, places: -1, held: false };
  /** Per binding, its root's node (`rootNode`). */
  readonly roots: Map<PlaceId, number>;
  /** The bindings the graph holds a position of, which a stop at any of them makes decline (`stoppedAt`). */
  readonly places: Set<PlaceId>;
  /** Per place, whether a copy cycle through a projection holds it. */
  readonly cyclic: Map<PlaceId, boolean>;
  /** Per goal (`node|step`) whose rules declined, the reason: a later build reaching it declines at once. */
  readonly poisoned = Retained.map<number, Map<string, string>>("Frontier.poisoned");
  /** Per decline reason, the pushed reads it declined (`pushedFacts`). */
  readonly declines = Retained.map<string, number>("Frontier.declines");
  /** The goals of the build running, final when it ends, dropped when it declines. */
  pending: Goal[] = Retained.arena("Frontier.pending");
  /** The goals whose rules are not read yet, and each node a goal gained with a reader to pass it to. */
  fresh: Goal[] = Retained.array("Frontier.fresh");
  tasks: (readonly [(node: number) => void, number])[] = Retained.array("Frontier.tasks");
  /** Whether a build runs (`drain`): none starts inside another. */
  draining = false;
  /**
   * #1784: the pending sets holds carry, interned apart from their nodes (`internPending`): their members (states of
   * the pass's mark automaton, ascending), ids by their names; per set and step, its advance (`advance`); per pair,
   * their union.
   */
  readonly pendingSets: (readonly number[])[] = Retained.arena("Frontier.pendingSets");
  readonly pendingIds = Retained.map<string, number>("Frontier.pendingIds");
  readonly advances = Retained.map<number, Map<string, Decision>>("Frontier.advances");
  readonly unions = Retained.map<string, number>("Frontier.unions");
  /**
   * #2005: whether its builds carry receiver scopes (`compose`): from a build's first pending mark, or first mark
   * accepted past a root a record does not witness, on (`Activate`), for the rest of the pass.
   */
  scoped = false;
  /** #2005: the receiver-shape graph's (`shapesOf`): its routes mark nothing and its reads are not declined as guarded. */
  readonly shapeOnly: boolean;
  /** #2005: the pending atoms, the receiver-shape graph and their caches (`productOf`), once the builds are scoped. */
  product: Product | null = null;
  /** #2005: the term goals a floor reads (`termsAt`), and the marked leaves' unmarked bases (`markedLeaf`). */
  terms: Terms | null = null;
  readonly markBases = Retained.map<number, number>("Frontier.markBases");
  /** #2005: the node whose goal's rules run (`immediateSafe`). */
  ruleNode: number | undefined = undefined;

  /** A pass's graph; with `nodes`, the receiver-shape graph of that graph, sharing its nodes (#2005). */
  public constructor(
    readonly contract: Contract,
    nodes: Frontier | null = null,
  ) {
    this.nodes = nodes?.nodes ?? Retained.arena("Frontier.nodes");
    this.ids = nodes?.ids ?? Retained.map("Frontier.ids");
    this.hosts = nodes?.hosts ?? Retained.set("Frontier.hosts");
    this.roots = nodes?.roots ?? Retained.map("Frontier.roots");
    this.places = nodes?.places ?? Retained.set("Frontier.places");
    this.cyclic = nodes?.cyclic ?? Retained.map("Frontier.cyclic");
    this.shapeOnly = nodes !== null;
    Retained.owner(this, "Frontier");
  }
}

/**
 * One unit of structure work, shared (docs/specifications/type-inference-accepted-record/solver-and-work.md#r4-349):
 * counted to the analysis's total, never the asker's.
 */
export function step(frontier: Frontier, units = 1): void {
  frontier.contract.pass.program.work.charge("structureSteps", units);
}

export function nodeId(frontier: Frontier, name: string, make: () => FNode): number {
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
export function keyNode(frontier: Frontier, place: PlaceId, path: readonly string[]): number {
  if (path.length === 0) return rootNode(frontier, place);
  const name = keyOf(place, path);
  const known = frontier.ids.get(name);
  if (known !== undefined) return known;
  const { contract } = frontier;
  eligible(contract, place);
  // (declined here: a key whose family is a cursor's, and, with `positions()` on, one whose first step passes a
  // wrapper)
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
export function rootNode(frontier: Frontier, place: PlaceId): number {
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
      // (#1784: a marking whole copy joins the component too: every member then reaches every leaf of it marked, through
      // that copy's marked edge, `rules`, and a marked item absorbs its unmarked twin in the join)
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

/**
 * Whether a decision stopped at `place` (`Contract.stoppedPlaces`), not recorded as asked: the pushed read's demand is
 * remembered instead (`pushedRun`), so a stop forgets it.
 */
function stoppedAt(contract: Contract, place: PlaceId): boolean {
  return contract.stoppedPlaces.has(place);
}

/**
 * Whether a decision stopped at a place the graph holds: the stopped places visited (shared work) only after a new stop
 * or a new held place, else the answer kept.
 */
export function heldStopped(frontier: Frontier): boolean {
  const { contract } = frontier;
  if (!contract.anyStopped) return false;
  const seen = frontier.stopsSeen;
  if (seen.stops === contract.stoppedCount && seen.places === frontier.places.size)
    return seen.held;
  const held = contract.pass.program.work.shared(() => {
    for (const place of contract.stoppedPlaces.keys()) {
      step(frontier);
      if (frontier.places.has(place)) return true;
    }
    return false;
  });
  amend(frontier);
  frontier.stopsSeen = { stops: contract.stoppedCount, places: frontier.places.size, held };
  return held;
}

/** Whether a binding's position has stores at or below it. */
export function holds(contract: Contract, place: PlaceId, path: readonly string[]): boolean {
  const { definitions } = contract.pass;
  const key = keyOf(place, path);
  return (definitions.byKey.get(key) ?? []).length > 0 || definitions.keysBelow(key).length > 0;
}

export function litNode(frontier: Frontier, literal: PlaceId, id: number, at: IndexNode): number {
  return nodeId(frontier, joinParts("l", literal, id), () => ({
    kind: "lit",
    literal,
    index: frontier.contract.literalIndex(literal),
    at,
    id,
  }));
}

export function leafNode(frontier: Frontier, name: string, item: () => Item): number {
  return nodeId(frontier, name, () => ({ kind: "leaf", item: item() }));
}

export function nativeNode(frontier: Frontier, value: PlaceId): number {
  return nodeId(frontier, joinParts("n", value), () => ({ kind: "native", value }));
}

/** #1784: `inner` reached marked: once (marking is idempotent), any holder's pending mark below it moot. */
export function markNode(frontier: Frontier, inner: number): number {
  let at = inner;
  for (let node = frontier.nodes[at]!; node.kind === "mark" || node.kind === "hold";) {
    if (node.kind === "mark") return at;
    at = node.inner;
    node = frontier.nodes[at]!;
  }
  return nodeId(frontier, joinParts("M", at), () => ({ kind: "mark", inner: at }));
}

/** #1784: holders' marks newly pending at a step, decided once for every node they reach (`decide`). */
export interface Decision {
  /** One of them marks at the steps taken: every node is reached marked. */
  readonly marked: boolean;
  /** The set of those not decided yet (`internPending`), or -1 for none. */
  readonly rest: number;
}

/** An entry, or a literal's read: its guard bit, its mark holder and its ingress (`annotated`'s). */
export interface MarkedRead {
  readonly guarded: boolean;
  readonly holder: PrefixEntry["holder"];
  readonly ingress: PrefixEntry["ingress"];
  readonly value?: PlaceId;
}

/** Declines a path with a step no property read takes (a selection, a member a built-in answers, an index). */
export function properties(steps: readonly string[]): void {
  for (const each of steps) if (!propertyOnly(each)) throw new Decline(`step ${each}`);
}

/**
 * Declines a rest with a step neither a property nor an element is: an element step reads an object as a missing
 * property is read, and a collection below it declines (`rules`).
 */
export function propertiesOrElements(steps: readonly string[]): void {
  for (const each of steps)
    if (each !== "element" && !propertyOnly(each)) throw new Decline(`step ${each}`);
}

/** Whether a property read's chain passes a wrapper at its first step (a position's, `positionOf`). */
export function passesWrapper(contract: Contract, value: PlaceId): boolean {
  const chain = contract.chainOf(value);
  return chain !== null && contract.wrapperHop(chain.root, chain.first) !== null;
}

// --- the summaries -------------------------------------------------------------------------------------------------

/**
 * The summaries' least solution, one fact at a time: a goal's rules are read once, each reading the goals they need
 * one step below (`below`), and each node a goal gains is passed once to each reader. So the work is one unit per
 * rule, per node each goal gains and per reader it passes it to, never a goal's whole rules again as it grows.
 */
export function goalOf(frontier: Frontier, node: number, stepName: string): Goal {
  let bySteps = frontier.goals.get(node);
  if (bySteps === undefined) frontier.goals.set(node, (bySteps = Retained.map("Frontier.goals[]")));
  let goal = bySteps.get(stepName);
  if (goal === undefined) {
    const poisoned = frontier.poisoned.get(node)?.get(stepName);
    if (poisoned !== undefined) throw new Decline(poisoned);
    frontier.contract.keep(2);
    goal = Retained.record<Goal>("Frontier.goal", {
      node,
      step: stepName,
      value: Retained.set("Frontier.goal.value"),
      readers: Retained.array("Frontier.goal.readers"),
    });
    bySteps.set(stepName, goal);
    frontier.pending.push(goal);
    frontier.fresh.push(goal);
  }
  return goal;
}

/** The nodes one step `s` below `node`, its goal's, each passed to `then`. */
export function plainBelow(
  frontier: Frontier,
  node: number,
  s: string,
  then: (node: number) => void,
): void {
  const goal = goalOf(frontier, node, s);
  step(frontier);
  goal.readers?.push(then);
  for (const found of goal.value) frontier.tasks.push([then, found]);
}

export function intern(frontier: Frontier, nodes: Iterable<number>): number {
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

export function setMembers(frontier: Frontier, set: number): readonly number[] {
  return frontier.members[set]!;
}

/**
 * #1784: a node as `leavesOf` reads it, a state: a marked node is its inner node's marked, a held one its inner node's
 * unmarked (its pending states accept nothing yet: an accepting one has marked it); twice the node, plus one where
 * marked.
 */
export function stateOf(frontier: Frontier, start: number, mark: boolean): number {
  let [node, marked] = [start, mark];
  for (;;) {
    const at = frontier.nodes[node]!;
    // (a step per marked or held node resolved: a graph without marks charges none here)
    if (at.kind === "mark" || at.kind === "hold") step(frontier);
    if (at.kind === "mark") [node, marked] = [at.inner, true];
    else if (at.kind === "hold") node = at.inner;
    else return node * 2 + (marked ? 1 : 0);
  }
}

// --- receiver scopes (#2005): see `shapes.ts` ----------------------------------------------------------------------

/** #2005: a build's first pending mark, or first mark past an unwitnessed root: the build reruns, scoped. */
export class Activate extends Error {}

/** #2005: a pending atom: a mark automaton state and the receiver shapes it holds under, ascending. */
export interface Atom {
  readonly state: number;
  readonly scopes: readonly number[];
}

/** #2005: an atom's step, once per atom and step: marked, or its atoms one step further. */
interface AtomStep {
  readonly marked: boolean;
  readonly states: readonly number[];
}

export interface Product {
  /** The receiver-shape graph: its interned sets are the shapes. */
  readonly shapes: Frontier;
  /** The atoms by id (`-1 - index`), and their ids by state and scopes. */
  readonly atoms: Atom[];
  readonly atomIds: Map<string, number>;
  readonly steps: Map<number, Map<string, AtomStep>>;
  /** Per shape, whether a leaf of it holds below it (`structured`). */
  readonly structured: Map<number, boolean>;
  /** Per node, whether nothing below it reads (`pure`); per literal index node and state, its support (`literalSafe`). */
  readonly pure: Map<number, boolean>;
  readonly safe: WeakMap<IndexNode, Map<number, boolean>>;
  /** Per state, whether it accepts through its epsilon edges. */
  readonly accepts: Map<number, boolean>;
  floors: number;
}

/** #2005: a node's terms as a floor reads them: its leaves and native values, found as goals are (`termsAt`). */
export interface TermGoal {
  readonly node: number;
  readonly value: Set<number>;
  readers: ((node: number) => void)[] | null;
}

interface Terms {
  readonly goals: Map<number, TermGoal>;
  fresh: TermGoal[];
  pending: TermGoal[];
}

/** #2005: a node's terms (`TermGoal`), each passed to `then` as found. */
export function termsAt(frontier: Frontier, node: number, then: (node: number) => void): void {
  if (frontier.terms === null) {
    amend(frontier);
    frontier.terms = Retained.record<Terms>("Frontier.terms", {
      goals: Retained.map("Frontier.terms.goals"),
      fresh: Retained.array("Frontier.terms.fresh"),
      pending: Retained.arena("Frontier.terms.pending"),
    });
  }
  const terms = frontier.terms;
  let goal = terms.goals.get(node);
  if (goal === undefined) {
    frontier.contract.keep(2);
    goal = Retained.record<TermGoal>("Frontier.terms.goal", {
      node,
      value: Retained.set("Frontier.terms.goal.value"),
      readers: Retained.array("Frontier.terms.goal.readers"),
    });
    terms.goals.set(node, goal);
    terms.fresh.push(goal);
    terms.pending.push(goal);
  }
  step(frontier);
  goal.readers?.push(then);
  for (const found of goal.value) frontier.tasks.push([then, found]);
}

export function termGain(frontier: Frontier, goal: TermGoal, found: number): void {
  step(frontier);
  if (goal.value.has(found)) return;
  goal.value.add(found);
  keep(frontier.contract.work, 1);
  for (const reader of goal.readers ?? []) frontier.tasks.push([reader, found]);
}
