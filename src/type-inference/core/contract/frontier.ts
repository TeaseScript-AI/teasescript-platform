import type { PlaceId } from "../../graph.js";
import { joinParts, keep, keptParts, keptSteps } from "../budget.js";
import type { Contract } from "../contract.js";
import { keyOf, keyPath, keyPlace, type Key } from "../definitions.js";
import { marked } from "../guards.js";
import { makeItem, mergeItems, REASON, type Item } from "../items.js";
import { selectsElement } from "../method-categories.js";
import { positions } from "../positions.js";
import type { Work } from "../solver.js";
import type { FlowSink } from "./contributions.js";
import { entered, ingressLeafOf } from "./ingress.js";
import { canonicalKey, isKeyId, keyDepthIn, stepsArray, type PathRef } from "./key-ids.js";
import { holdsBelow, hostAt, propertyOnly, unknownItem } from "./kinds.js";
import { heldBelow, lackingAt, pathAt } from "./literal-index.js";
import {
  depthOf,
  markStart,
  markState,
  markStep,
  marksNothing,
  rootAccepts,
  type MarkResidual,
} from "./marks.js";
import type { Holder, IndexNode, LiteralIndex, PrefixEntry } from "./model.js";

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
 *
 * #1784: a route through a marking entry or literal read (its guard bit, or its holder's mark at the rest below it,
 * §3.2) reaches `mark` nodes: the same nodes, their leaves `marked`. A holder's mark depends on the rest's first
 * `depthOf` steps, so its route is a `hold` node carrying the residual states of the mark automaton those steps leave,
 * until they decide it (or the path ends). Marking each leaf and then joining is native's join of marked answers exactly where no native-value leaf is
 * reached marked (HEAD 1: `marked` commutes with `mergePair` per item unless a context ranked after `"branch"` meets a
 * null one, and only a native value carries one): such a leaf declines (`marks-native`).
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
  | { readonly kind: "native"; readonly value: PlaceId }
  /** #1784: `inner` reached through a marking route: its leaves `marked`. */
  | { readonly kind: "mark"; readonly inner: number }
  /**
   * #1784: `inner` (neither marked nor held) reached below entries whose holders' marks the rest decides: its pending
   * set (`internPending`), the states of their marks' automaton the steps taken since each entry left (`markStart`).
   */
  | { readonly kind: "hold"; readonly inner: number; readonly set: number };

/** A holder's mark a route newly takes: the holder and the steps since its entry, their arena path (`pathAt`). */
interface Route {
  readonly holder: Holder;
  readonly path: number;
}

/** A node one step below another: `Sum(node, step)`, its nodes as found, each passed once to every reader. */
interface Goal {
  readonly node: number;
  readonly step: string;
  readonly value: Set<number>;
  /** Its readers while it is not final; a final goal's nodes are read as they stand. */
  readers: ((node: number) => void)[] | null;
  /** #1784: per base node it holds held, the union of the pending sets it reached it with (`gain`). */
  holds?: Map<number, number>;
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
  readonly nodes: FNode[];
  readonly ids: Map<string, number>;
  readonly goals = new Map<number, Map<string, Goal>>();
  /** Interned node sets: their members and, per step, the set one step below (final goals only). */
  readonly sets = new Map<string, number>();
  readonly members: (readonly number[])[] = [];
  readonly below = new Map<number, Map<string, number>>();
  /** Per state (a node, twice it plus one where reached marked), the leaves at it (`Term`'s closure), once final. */
  readonly leaves = new Map<number, readonly number[]>();
  /** Per pushed slot, its reach, or `null` where its closure declined. */
  readonly reads = new Map<string, Reach | null>();
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
  readonly poisoned = new Map<number, Map<string, string>>();
  /** Per decline reason, the pushed reads it declined (`pushedFacts`). */
  readonly declines = new Map<string, number>();
  /** The goals of the build running, final when it ends, dropped when it declines. */
  pending: Goal[] = [];
  /** The goals whose rules are not read yet, and each node a goal gained with a reader to pass it to. */
  fresh: Goal[] = [];
  tasks: (readonly [(node: number) => void, number])[] = [];
  /** Whether a build runs (`drain`): none starts inside another. */
  draining = false;
  /**
   * #1784: the pending sets holds carry, interned apart from their nodes (`internPending`): their members (states of
   * the pass's mark automaton, ascending), ids by their names; per set and step, its advance (`advance`); per pair,
   * their union.
   */
  readonly pendingSets: (readonly number[])[] = [];
  readonly pendingIds = new Map<string, number>();
  readonly advances = new Map<number, Map<string, Decision>>();
  readonly unions = new Map<string, number>();
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
  readonly markBases = new Map<number, number>();
  /** #2005: the node whose goal's rules run (`immediateSafe`). */
  ruleNode: number | undefined = undefined;

  /** A pass's graph; with `nodes`, the receiver-shape graph of that graph, sharing its nodes (#2005). */
  public constructor(
    readonly contract: Contract,
    nodes: Frontier | null = null,
  ) {
    this.nodes = nodes?.nodes ?? [];
    this.ids = nodes?.ids ?? new Map();
    this.hosts = nodes?.hosts ?? new Set();
    this.roots = nodes?.roots ?? new Map();
    this.places = nodes?.places ?? new Set();
    this.cyclic = nodes?.cyclic ?? new Map();
    this.shapeOnly = nodes !== null;
  }
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

function stoppedAt(contract: Contract, place: PlaceId): boolean {
  return contract.stoppedPlaces.has(place);
}

/**
 * Whether a decision stopped at a place the graph holds: the stopped places visited (shared work) only after a new stop
 * or a new held place, else the answer kept.
 */
function heldStopped(frontier: Frontier): boolean {
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
  frontier.stopsSeen = { stops: contract.stoppedCount, places: frontier.places.size, held };
  return held;
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

/** #1784: `inner` reached marked: once (marking is idempotent), any holder's pending mark below it moot. */
function markNode(frontier: Frontier, inner: number): number {
  let at = inner;
  for (let node = frontier.nodes[at]!; node.kind === "mark" || node.kind === "hold";) {
    if (node.kind === "mark") return at;
    at = node.inner;
    node = frontier.nodes[at]!;
  }
  return nodeId(frontier, joinParts("M", at), () => ({ kind: "mark", inner: at }));
}

/** #1784: holders' marks newly pending at a step, decided once for every node they reach (`decide`). */
interface Decision {
  /** One of them marks at the steps taken: every node is reached marked. */
  readonly marked: boolean;
  /** The set of those not decided yet (`internPending`), or -1 for none. */
  readonly rest: number;
}

/** #1784: a set of pending states, interned once: its id; -1 for none. */
function internPending(
  frontier: Frontier,
  states: ReadonlySet<number> | readonly number[],
): number {
  const sorted = [...states].sort((a, b) => a - b);
  const list = frontier.scoped ? absorbed(frontier, sorted) : sorted;
  if (list.length === 0) return -1;
  // (#2005: a build's first pending mark scopes the pass's builds, `reachSlot`)
  if (!frontier.scoped) throw new Activate();
  const name = list.join(",");
  const known = frontier.pendingIds.get(name);
  if (known !== undefined) return known;
  step(frontier, list.length);
  frontier.contract.keepText(name.length);
  const id = frontier.pendingSets.length;
  frontier.pendingSets.push(list);
  frontier.pendingIds.set(name, id);
  return id;
}

/** #1784: a residual of the mark automaton as a decision: marked, or its states pending (one set). */
function decided(frontier: Frontier, residual: MarkResidual): Decision {
  return residual.marked
    ? { marked: true, rest: -1 }
    : { marked: false, rest: internPending(frontier, residual.states) };
}

/**
 * #1784: what holders' marks newly taken at a step make of the nodes they reach, decided once (it depends on the
 * holders and the steps, never the node): each holder's automaton walked by its steps (`markStart`), marked where one
 * accepts, else the states left pending, one set of them (marking is idempotent, so a state pending twice is pending
 * once; none left marks nothing). A holder whose depth no bound holds declines (`marks-depth`).
 */
function decide(frontier: Frontier, adds: readonly Route[]): Decision {
  const { contract } = frontier;
  const rest = new Set<number>();
  for (const each of adds) {
    step(frontier);
    if (depthOf(contract, each.holder) === Infinity) throw new Decline("marks-depth");
    const residual = markStart(contract, each.holder, each.path);
    if (residual.marked) {
      // (#2005: a mark accepted past its holder's root, where no record witnesses the receiver, scopes the builds)
      if (!frontier.scoped && !rootAccepts(contract, each.holder) && !immediateSafe(frontier))
        throw new Activate();
      return { marked: true, rest: -1 };
    }
    for (const state of residual.states) rest.add(state);
  }
  return { marked: false, rest: internPending(frontier, rest) };
}

/** #1784: a pending set one step further (`markStep` of its states), once per set and step. */
function advance(frontier: Frontier, set: number, s: string): Decision {
  let bySteps = frontier.advances.get(set);
  const known = bySteps?.get(s);
  if (known !== undefined) return known;
  step(frontier);
  const states = frontier.pendingSets[set]!;
  // (#2005: a set of plain states, ascending after its atoms, has none)
  const decision =
    states[0]! >= 0
      ? decided(frontier, markStep(frontier.contract, states, s))
      : advanceAtoms(frontier, states, s);
  if (bySteps === undefined) frontier.advances.set(set, (bySteps = new Map()));
  bySteps.set(s, decision);
  return decision;
}

/** #1784: the union of two pending sets, once per pair. */
function unionPending(frontier: Frontier, a: number, b: number): number {
  if (a < 0 || a === b) return b;
  if (b < 0) return a;
  const name = a < b ? `${a},${b}` : `${b},${a}`;
  const known = frontier.unions.get(name);
  if (known !== undefined) return known;
  const states = new Set<number>();
  for (const each of [...frontier.pendingSets[a]!, ...frontier.pendingSets[b]!]) {
    step(frontier);
    states.add(each);
  }
  const id = internPending(frontier, states);
  frontier.unions.set(name, id);
  return id;
}

/**
 * #1784: `node` reached with a decision's marks: marked where it marks; else its pending set with the decision's, their
 * union (a whole-copy cycle adding the same ones again adds nothing new); a node with none pending is its own.
 */
function pendingBelow(frontier: Frontier, node: number, decision: Decision): number {
  const at = frontier.nodes[node]!;
  if (at.kind === "mark") return node;
  const inner = at.kind === "hold" ? at.inner : node;
  if (decision.marked) return markNode(frontier, inner);
  if (decision.rest < 0) return node;
  const set = at.kind === "hold" ? unionPending(frontier, at.set, decision.rest) : decision.rest;
  return nodeId(frontier, joinParts("H", inner, set), () => ({ kind: "hold", inner, set }));
}

/** An entry, or a literal's read: its guard bit, its mark holder and its ingress (`annotated`'s). */
interface MarkedRead {
  readonly guarded: boolean;
  readonly holder: PrefixEntry["holder"];
  readonly ingress: PrefixEntry["ingress"];
  readonly value?: PlaceId;
}

/**
 * #1784: what an entry or a literal's read makes of a node it gives at `steps` below it, or `null` where it marks
 * nothing: its guard bit marks it, its holder's mark as the rest decides it (`decide`); an ingress of its own
 * declines (`ingress`).
 */
function routeOf(
  frontier: Frontier,
  read: MarkedRead,
  steps: readonly string[],
): ((node: number) => number) | null {
  const { contract } = frontier;
  if (
    read.ingress !== undefined &&
    !(read.value !== undefined && read.ingress === ingressLeafOf(contract, read.value))
  )
    throw new Decline("ingress");
  if (frontier.shapeOnly) return null;
  if (read.guarded) return (node) => markNode(frontier, node);
  if (marksNothing(contract, read.holder)) return null;
  const path = steps.reduce((at, step) => pathAt(contract, at, step), 0);
  const decision = decide(frontier, [{ holder: read.holder!, path }]);
  return (node) => pendingBelow(frontier, node, decision);
}

/**
 * #1784: a component's own marking whole copies at one step, read once together: the component's summary one step
 * below, reached through every one of them. Its unmarked summary is each member's already, so the copies' routes
 * together give it marked where one of them marks: a guard bit, or a holder deciding marked; their holders still
 * pending, one hold of them all (marked where any marks, as separate routes beside the unmarked summary give it).
 */
function selfMarks(
  frontier: Frontier,
  root: number,
  copies: readonly PrefixEntry[],
  s: string,
  into: (node: number) => void,
): void {
  if (frontier.shapeOnly) return;
  const { contract } = frontier;
  const pending: Route[] = [];
  let guarded = false;
  for (const entry of copies) {
    step(frontier);
    if (
      entry.ingress !== undefined &&
      !(entry.value !== undefined && entry.ingress === ingressLeafOf(contract, entry.value))
    )
      throw new Decline("ingress");
    if (entry.guarded) guarded = true;
    else if (!marksNothing(contract, entry.holder))
      pending.push({ holder: entry.holder!, path: pathAt(contract, 0, s) });
  }
  const decision: Decision = guarded ? { marked: true, rest: -1 } : decide(frontier, pending);
  if (!decision.marked && decision.rest < 0) return;
  plainBelow(frontier, root, s, (found) => into(pendingBelow(frontier, found, decision)));
}

/** `into` through a read's marks (`routeOf`). */
function marking(
  frontier: Frontier,
  read: MarkedRead,
  steps: readonly string[],
  into: (node: number) => void,
): (node: number) => void {
  const route = routeOf(frontier, read, steps);
  return route === null ? into : (node) => into(route(node));
}

/** A literal's root as a node: a plain record or scalar literal (no cell, no selection). */
function literalRoot(frontier: Frontier, literal: PlaceId): number {
  const index = frontier.contract.literalIndex(literal);
  return litNode(frontier, literal, 0, index.root);
}

/**
 * The nodes a value stands for, each passed to `then`: a binding's read its root, a host's read its leaf, a property
 * read its owner's nodes one step below, a literal its root; declines for any other (and for a guarded or ingress read).
 * With `tail`, the nodes `tail` below those, in the same walk (#2005: one receiver scope for the whole path).
 */
function eachValue(
  frontier: Frontier,
  value: PlaceId,
  then: (node: number) => void,
  tail: readonly string[] = [],
): void {
  const { contract } = frontier;
  const { program, guards } = contract.pass;
  // (a chain of property reads walked down to its root once, its steps read below the root: no native recursion)
  const steps: string[] = [];
  let at = value;
  for (
    let projection = program.projOf.get(at);
    projection !== undefined;
    projection = program.projOf.get(at)
  ) {
    step(frontier);
    if (selectsElement(projection.step)) throw new Decline(`step ${projection.step}`);
    properties([projection.step]);
    if (ingressLeafOf(contract, at) !== undefined) throw new Decline("ingress");
    if (positions() && passesWrapper(contract, at)) throw new Decline("wrapper");
    steps.push(projection.step);
    at = projection.owner;
  }
  steps.reverse();
  step(frontier);
  let root: number;
  const binding = program.occurrenceOf.get(at);
  if (binding !== undefined) {
    if (program.isHost(binding)) root = hostLeaf(frontier, at);
    else {
      if (!frontier.shapeOnly && (!guards.untested(binding) || guards.guardedRead(at)))
        throw new Decline("guarded");
      if (ingressLeafOf(contract, at) !== undefined) throw new Decline("ingress");
      root = rootNode(frontier, binding);
    }
  } else if (program.hasOf.has(at) && !program.cellOwner.has(at)) root = literalRoot(frontier, at);
  else throw new Decline("value");
  below(frontier, root, tail.length > 0 ? keptSteps(contract.work, steps, tail) : steps, 0, then);
}

/** Declines a path with a step no property read takes (a selection, a member a built-in answers, an index). */
function properties(steps: readonly string[]): void {
  for (const each of steps) if (!propertyOnly(each)) throw new Decline(`step ${each}`);
}

/**
 * Declines a rest with a step neither a property nor an element is: an element step reads an object as F11 reads a
 * property it lacks, and a collection below it declines (`rules`).
 */
function propertiesOrElements(steps: readonly string[]): void {
  for (const each of steps)
    if (each !== "element" && !propertyOnly(each)) throw new Decline(`step ${each}`);
}

/** Whether a property read's chain passes a wrapper at its first step (G3's position, `positionOf`). */
function passesWrapper(contract: Contract, value: PlaceId): boolean {
  const chain = contract.chainOf(value);
  return chain !== null && contract.wrapperHop(chain.root, chain.first) !== null;
}

/** A host read's leaf: the runtime's unknown at every path, its ingress entered (`hostAt`, `entered`). */
function hostLeaf(frontier: Frontier, value: PlaceId): number {
  const { guards, program } = frontier.contract.pass;
  // (a host read under a test of its path is marked, `marked`: declined)
  if (!guards.untested(program.occurrenceOf.get(value)!) || guards.guardedRead(value))
    throw new Decline("guarded");
  const id = leafNode(
    frontier,
    joinParts("h", value),
    () => entered(frontier.contract, value, hostAt({ length: 0, at: () => undefined }))[0]!,
  );
  frontier.hosts.add(id);
  return id;
}

// --- the summaries -------------------------------------------------------------------------------------------------

/**
 * The summaries' least solution, one fact at a time: a goal's rules are read once, each reading the goals they need
 * one step below (`below`), and each node a goal gains is passed once to each reader. So the work is one unit per
 * rule, per node each goal gains and per reader it passes it to, never a goal's whole rules again as it grows.
 */
function goalOf(frontier: Frontier, node: number, stepName: string): Goal {
  let bySteps = frontier.goals.get(node);
  if (bySteps === undefined) frontier.goals.set(node, (bySteps = new Map()));
  let goal = bySteps.get(stepName);
  if (goal === undefined) {
    const poisoned = frontier.poisoned.get(node)?.get(stepName);
    if (poisoned !== undefined) throw new Decline(poisoned);
    frontier.contract.keep(2);
    goal = { node, step: stepName, value: new Set(), readers: [] };
    bySteps.set(stepName, goal);
    frontier.pending.push(goal);
    frontier.fresh.push(goal);
  }
  return goal;
}

/** The nodes `steps` from `from` on below `node`, each passed to `then`, as their goals find them. */
function below(
  frontier: Frontier,
  node: number,
  steps: readonly string[],
  from: number,
  then: (node: number) => void,
): void {
  if (frontier.scoped) return compose(frontier, [node], steps, from, then);
  if (from === steps.length) return then(node);
  const goal = goalOf(frontier, node, steps[from]!);
  const next = (found: number): void => below(frontier, found, steps, from + 1, then);
  step(frontier);
  goal.readers?.push(next);
  for (const found of goal.value) frontier.tasks.push([next, found]);
}

/** The nodes one step `s` below `node`, its goal's, each passed to `then`. */
function plainBelow(
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

function gain(frontier: Frontier, goal: Goal, found: number): void {
  step(frontier);
  // #1784: a base node reached held with several pending sets is reached with their union: marked where any marks. A
  // marked leaf absorbs its unmarked twin in the join (guarded makes it `pos`, `"branch"` beats no context, every other
  // field equal), so the alternatives together give what their union gives, and a set the union holds adds nothing; so
  // each base node's held states in a goal form one growing chain, not every combination of its pending marks (Codex
  // r3 B3).
  let node = found;
  const at = frontier.nodes[found]!;
  if (at.kind === "hold") {
    goal.holds ??= new Map();
    const known = goal.holds.get(at.inner);
    const set = known === undefined ? at.set : unionPending(frontier, known, at.set);
    if (set === known) return;
    goal.holds.set(at.inner, set);
    if (set !== at.set)
      node = nodeId(frontier, joinParts("H", at.inner, set), () => ({
        kind: "hold",
        inner: at.inner,
        set,
      }));
  }
  if (goal.value.has(node)) return;
  goal.value.add(node);
  keep(frontier.contract.work, 1);
  for (const reader of goal.readers ?? []) frontier.tasks.push([reader, node]);
}

/** A goal's rules, read once: what one step below its node holds, each part as it is found. */
function rules(frontier: Frontier, goal: Goal): void {
  const before = frontier.ruleNode;
  frontier.ruleNode = goal.node;
  try {
    goalRules(frontier, goal);
  } finally {
    frontier.ruleNode = before;
  }
}

function goalRules(frontier: Frontier, goal: Goal): void {
  const { contract } = frontier;
  const node = frontier.nodes[goal.node]!;
  const s = goal.step;
  const into = (found: number): void => gain(frontier, goal, found);
  step(frontier);
  if (node.kind === "leaf") {
    // (a host's data at an element step may hold none, `emptyAt`, where its read's frame holds a structure there and
    // not where it does not: a frame's own, which the graph does not keep, so declined wherever the step reaches it)
    if (s === "element" && frontier.hosts.has(goal.node)) throw new Decline("host element");
    return into(goal.node);
  }
  if (node.kind === "native") throw new Decline("native");
  if (node.kind === "mark")
    return innerBelow(frontier, node.inner, s, (found) => into(markNode(frontier, found)));
  if (node.kind === "hold") {
    const decision = advance(frontier, node.set, s);
    return innerBelow(frontier, node.inner, s, (found) =>
      into(pendingBelow(frontier, found, decision)),
    );
  }
  if (node.kind === "key") {
    const below = keptSteps(contract.work, node.path, [s]);
    const inside = new Set(node.members);
    // (#1784: the component's own marking whole copies, read once together below, `selfMarks`)
    const own: PrefixEntry[] = [];
    for (const member of node.members) {
      if (holds(contract, member, below)) into(keyNode(frontier, member, below));
      if (node.path.length === 0 && positions() && contract.wrapperHop(member, s) !== null)
        throw new Decline("wrapper");
      const stores = contract.prefixStores(keyOf(member, node.path));
      if (stores.subs !== null || stores.also.length > 0) throw new Decline("layers");
      for (const entry of stores.list) {
        step(frontier);
        // (a whole copy of a member: the component's own summary, which adds nothing to itself, or, marking, adds that
        // summary marked)
        if (
          node.path.length === 0 &&
          entry.key !== undefined &&
          !isKeyId(entry.key) &&
          keyPath(entry.key).length === 0 &&
          inside.has(keyPlace(entry.key)) &&
          entry.w !== null
        ) {
          if (!plainRead(contract, entry)) own.push(entry);
          continue;
        }
        stepEntry(frontier, entry, s, into);
      }
    }
    if (own.length > 0) selfMarks(frontier, goal.node, own, s, into);
    return;
  }
  // a literal's index node: its child at the step, F11's `missing` where an object lacks it, its reads one step below
  const { literal, index, at, id } = node;
  if (at.reference) throw new Decline("reference");
  if (at.others.length > 0) throw new Decline("native");
  // (an element of a collection, or of an empty one, is a collection's: declined; an object's is F11's `missing`)
  if (s === "element" && (at.children.has(s) || at.empty)) throw new Decline("collection");
  const child = at.children.get(s);
  if (child !== undefined) into(litNode(frontier, literal, pathAt(contract, id, s), child));
  const lacking = lackingAt(contract, index, id, s);
  if (lacking !== null)
    into(
      leafNode(frontier, joinParts("m", literal, id, s), () =>
        unknownItem(REASON.missing, lacking),
      ),
    );
  for (const read of at.reads) {
    const marked = marking(frontier, read, [s], into);
    if (frontier.scoped) eachValue(frontier, read.value, marked, [s]);
    else eachValue(frontier, read.value, (found) => below(frontier, found, [s], 0, marked));
  }
}

/** Whether an entry or a literal's read carries no mark and no ingress of its own (`annotated` leaves it as it is). */
function plainRead(contract: Contract, read: MarkedRead): boolean {
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
  into: (node: number) => void,
): void {
  const { contract } = frontier;
  if (entry.unk !== undefined || entry.empty === true || entry.elem !== undefined)
    throw new Decline("entry");
  if (entry.w === null) throw new Decline("writer");
  const marked = marking(frontier, entry, [s], into);
  if (entry.key !== undefined) {
    if (isKeyId(entry.key)) throw new Decline("cursor");
    const path = keyPath(entry.key);
    properties(path);
    return below(
      frontier,
      rootNode(frontier, keyPlace(entry.key)),
      keptSteps(contract.work, path, [s]),
      0,
      marked,
    );
  }
  const at = entry.at ?? [];
  properties(at);
  const steps = keptSteps(contract.work, at, [s]);
  if (frontier.scoped) eachValue(frontier, entry.value!, marked, steps);
  else eachValue(frontier, entry.value!, (found) => below(frontier, found, steps, 0, marked));
}

/**
 * Runs a build to its least solution: each new goal's rules read, each node gained passed on, until neither is left;
 * then every goal of the build is final. A build never starts inside another (a rule reads goals, never `drain`).
 */
function drain(frontier: Frontier): void {
  if (frontier.draining) throw new Error("A producer graph's build ran inside another.");
  frontier.draining = true;
  try {
    for (;;) {
      const goal = frontier.fresh.pop();
      if (goal !== undefined) {
        try {
          rules(frontier, goal);
        } catch (error) {
          if (error instanceof Decline) {
            if (!frontier.poisoned.has(goal.node)) frontier.poisoned.set(goal.node, new Map());
            frontier.poisoned.get(goal.node)!.set(goal.step, error.reason);
          }
          throw error;
        }
        continue;
      }
      // (#2005: a node's terms, a floor's, `termsAt`)
      const term = frontier.terms?.fresh.pop();
      if (term !== undefined) {
        termRules(frontier, term);
        continue;
      }
      const task = frontier.tasks.pop();
      if (task === undefined) break;
      task[0](task[1]);
    }
  } finally {
    frontier.draining = false;
  }
  for (const goal of frontier.pending) goal.readers = null;
  frontier.pending = [];
  if (frontier.terms !== null) {
    for (const term of frontier.terms.pending) term.readers = null;
    frontier.terms.pending = [];
  }
}

/** Drops the goals of a build that declined or stopped: none of them is final. */
function rollback(frontier: Frontier): void {
  for (const goal of frontier.pending) frontier.goals.get(goal.node)?.delete(goal.step);
  frontier.pending = [];
  frontier.fresh = [];
  frontier.tasks = [];
  frontier.draining = false;
  // (#2005: its term goals, and the receiver-shape graph's build it stopped in)
  if (frontier.terms !== null) {
    for (const term of frontier.terms.pending) frontier.terms.goals.delete(term.node);
    frontier.terms.pending = [];
    frontier.terms.fresh = [];
  }
  if (frontier.product !== null) rollback(frontier.product.shapes);
}

/** The nodes a build passes to its collector, once it is settled. */
function collect(frontier: Frontier, start: (then: (node: number) => void) => void): number[] {
  const out = new Set<number>();
  start((node) => out.add(node));
  drain(frontier);
  return [...out];
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

/** The interned set one step below a set, settled, once per set and step. */
function star(frontier: Frontier, set: number, stepName: string): number {
  let bySteps = frontier.below.get(set);
  const known = bySteps?.get(stepName);
  if (known !== undefined) return known;
  const nodes = collect(frontier, (then) => {
    if (frontier.scoped) compose(frontier, frontier.members[set]!, [stepName], 0, then);
    else for (const node of frontier.members[set]!) below(frontier, node, [stepName], 0, then);
  });
  const id = intern(frontier, nodes);
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
  // (a value read through a marking read: its nodes, a native one too, the route's, `leavesOf` marking their leaves)
  const value = (v: PlaceId, route: ((node: number) => number) | null = null): void => {
    const native = (): void => {
      const leaf = nativeNode(frontier, v);
      if (route === null) leaves.push(leaf);
      else next.push(route(leaf));
    };
    step(frontier);
    const binding = program.occurrenceOf.get(v);
    if (
      binding !== undefined ||
      program.projOf.has(v) ||
      (program.hasOf.has(v) && !program.cellOwner.has(v))
    ) {
      // (a value the graph models stands for its nodes; one it declines is read natively)
      const before = frontier.pending.length;
      try {
        for (const found of collect(frontier, (then) => eachValue(frontier, v, then)))
          next.push(route === null ? found : route(found));
      } catch (error) {
        // (a decline inside a summary's build declines the read; one at the value itself reads it natively)
        if (!(error instanceof Decline) || frontier.pending.length !== before) throw error;
        frontier.draining = false;
        native();
      }
    } else native();
  };
  if (node.kind === "leaf" || node.kind === "native") leaves.push(id);
  else if (node.kind === "mark" || node.kind === "hold")
    throw new Error("A marked node's leaves are its inner node's (`leavesOf`'s states).");
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
    for (const read of node.at.reads) value(read.value, routeOf(frontier, read, []));
    for (const other of node.at.others) leaves.push(nativeNode(frontier, other.value));
  }
  return { leaves, next };
}

/**
 * #1784: a node as `leavesOf` reads it, a state: a marked node is its inner node's marked, a held one its inner node's
 * unmarked (its pending states accept nothing yet: an accepting one has marked it); twice the node, plus one where
 * marked.
 */
function stateOf(frontier: Frontier, start: number, mark: boolean): number {
  let [node, marked] = [start, mark];
  for (;;) {
    const at = frontier.nodes[node]!;
    // (a step per marked or held node resolved: a graph without marks charges as before)
    if (at.kind === "mark" || at.kind === "hold") step(frontier);
    if (at.kind === "mark") [node, marked] = [at.inner, true];
    else if (at.kind === "hold") node = at.inner;
    else return node * 2 + (marked ? 1 : 0);
  }
}

/** #1784: a leaf reached marked: its item `marked`; a native value's declines (`marks-native`, HEAD 1's condition). */
function markedLeaf(frontier: Frontier, leaf: number): number {
  const node = frontier.nodes[leaf]!;
  if (node.kind !== "leaf") throw new Decline("marks-native");
  // (#2005: a marked leaf marked again is itself; a floor carries it marked through its base, `floorBelow`)
  if (frontier.markBases.has(leaf)) return leaf;
  const id = nodeId(frontier, joinParts("ml", leaf), () => ({
    kind: "leaf",
    item: marked([node.item])[0]!,
  }));
  if (frontier.scoped && !frontier.markBases.has(id)) {
    keep(frontier.contract.work, 2);
    frontier.markBases.set(id, leaf);
  }
  return id;
}

/**
 * The leaves at each of `start`'s nodes and every node ε below it: Tarjan's components over states (a node, marked or
 * not: `stateOf`), one leaf list each, a marked state's leaves its node's own `marked`.
 */
function leavesOf(frontier: Frontier, start: readonly number[]): Set<number> {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const open: number[] = [];
  const held = new Set<number>();
  const terms = new Map<number, { readonly leaves: number[]; readonly next: number[] }>();
  const own = new Map<
    number,
    { readonly leaves: readonly number[]; readonly next: readonly number[] }
  >();
  const frames: { readonly state: number; readonly next: readonly number[]; at: number }[] = [];
  const enter = (state: number): void => {
    const node = state >> 1;
    const marked = (state & 1) === 1;
    let term = terms.get(node);
    if (term === undefined) terms.set(node, (term = termOf(frontier, node)));
    const leaves = marked ? term.leaves.map((leaf) => markedLeaf(frontier, leaf)) : term.leaves;
    const next = term.next.map((to) => stateOf(frontier, to, marked));
    index.set(state, index.size);
    low.set(state, index.size - 1);
    open.push(state);
    held.add(state);
    own.set(state, { leaves, next });
    frames.push({ state, next, at: 0 });
  };
  const roots = start.map((node) => stateOf(frontier, node, false));
  for (const root of roots) {
    if (frontier.leaves.has(root) || index.has(root)) continue;
    enter(root);
    while (frames.length > 0) {
      const top = frames.at(-1)!;
      if (top.at < top.next.length) {
        const to = top.next[top.at++]!;
        step(frontier);
        if (frontier.leaves.has(to)) continue;
        if (!index.has(to)) enter(to);
        else if (held.has(to)) low.set(top.state, Math.min(low.get(top.state)!, index.get(to)!));
        continue;
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames.at(-1)!.state;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.state)!));
      }
      if (low.get(top.state) !== index.get(top.state)) continue;
      const members: number[] = [];
      for (;;) {
        const member = open.pop()!;
        held.delete(member);
        members.push(member);
        if (member === top.state) break;
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
  for (const root of roots)
    for (const leaf of frontier.leaves.get(root)!) {
      step(frontier);
      out.add(leaf);
    }
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
  const edges = new Map<PlaceId, readonly (readonly [PlaceId, boolean])[]>();
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
          to.push([
            keyPlace(entry.key),
            keyDepthIn(contract, entry.key) > keyDepthIn(contract, key),
          ]);
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
    const to = edgesOf(at);
    edges.set(at, to);
    frames.push({ place: at, to, at: 0 });
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
    const inside = new Set(members);
    let isCyclic = false;
    for (const member of members)
      for (const [to, projected] of edges.get(member)!)
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
  /** #1784: the marks pending in the interned pending sets, each set's once. */
  readonly pending: number;
  readonly reads: number;
  readonly declines: ReadonlyMap<string, number>;
  /** #2005: whether its builds carry receiver scopes; its atoms, their receiver constraints, its shapes and floors. */
  readonly scoped: boolean;
  readonly atoms: number;
  readonly constraints: number;
  readonly shapes: number;
  readonly floors: number;
} {
  const frontier = FRONTIERS.get(contract);
  const product = frontier?.product ?? null;
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
    pending: frontier?.pendingSets.reduce((all, set) => all + set.length, 0) ?? 0,
    reads: [...(frontier?.reads.values() ?? [])].filter((read) => read !== null).length,
    declines: frontier?.declines ?? new Map(),
    scoped: frontier?.scoped ?? false,
    atoms: product?.atoms.length ?? 0,
    constraints: product?.atoms.reduce((all, atom) => all + atom.scopes.length, 0) ?? 0,
    shapes: product?.shapes.members.length ?? 0,
    floors: product?.floors ?? 0,
  };
}

/**
 * Test-only, #1784: the hold state's invariant over the pass's graph. Every marked or held node's inner node is neither
 * (nesting depth 1); every pending set holds each automaton state once, every union of two both; and per goal, each base node has one canonical
 * pending set, the union of every pending set it was reached with, every held state of it the goal holds being a subset
 * (absorbed). Its violations, the largest pending set, and the held states and base nodes per goal.
 */
export function pushedInvariant(contract: Contract): {
  readonly violations: readonly string[];
  readonly largest: number;
  readonly held: number;
  readonly bases: number;
} {
  const frontier = FRONTIERS.get(contract);
  const violations: string[] = [];
  if (frontier === undefined) return { violations, largest: 0, held: 0, bases: 0 };
  const nameOf = (each: number): string => String(each);
  frontier.nodes.forEach((node, id) => {
    if (node.kind !== "mark" && node.kind !== "hold") return;
    const inner = frontier.nodes[node.inner]!.kind;
    if (inner === "mark" || inner === "hold")
      violations.push(`node ${id}: ${node.kind} of ${inner}`);
  });
  let largest = 0;
  frontier.pendingSets.forEach((set, id) => {
    largest = Math.max(largest, set.length);
    if (new Set(set.map(nameOf)).size !== set.length)
      violations.push(`pending set ${id}: a mark twice`);
    // (#2005: a plain state absorbs its constrained atoms)
    if (
      frontier.product !== null &&
      set.some((each) => each < 0 && set.includes(atomOf(frontier.product!, each).state))
    )
      violations.push(`pending set ${id}: an absorbed atom kept`);
  });
  // (#2005: each atom interned once, by its state and its scopes)
  frontier.product?.atoms.forEach((atom, at) => {
    const name = `${atom.state}:${atom.scopes.join(",")}`;
    if (frontier.product!.atomIds.get(name) !== -(at + 1) || atom.scopes.length === 0)
      violations.push(`atom ${-(at + 1)}: not its name's`);
  });
  // (each union of two sets holds every state of both)
  for (const [name, id] of frontier.unions) {
    const [a, b] = name.split(",").map(Number);
    if (a === undefined || b === undefined) continue;
    const union = new Set(id < 0 ? [] : frontier.pendingSets[id]!);
    if (
      [...frontier.pendingSets[a]!, ...frontier.pendingSets[b]!].some(
        (each) => !covered(frontier, union, each),
      )
    )
      violations.push(`the union of pending sets ${a} and ${b}: a state missing`);
  }
  let [held, bases] = [0, 0];
  for (const bySteps of frontier.goals.values())
    for (const goal of bySteps.values()) {
      const canonical = goal.holds ?? new Map<number, number>();
      const seen = new Set<number>();
      for (const id of goal.value) {
        const node = frontier.nodes[id]!;
        if (node.kind !== "hold") continue;
        held += 1;
        seen.add(node.inner);
        const union = canonical.get(node.inner);
        const states = new Set(union === undefined ? [] : frontier.pendingSets[union]!);
        if (frontier.pendingSets[node.set]!.some((each) => !covered(frontier, states, each)))
          violations.push(
            `goal ${goal.node} at ${goal.step}: a held state of ${node.inner} outside its union`,
          );
        if (
          union !== undefined &&
          ![...goal.value].some((other) => {
            const at = frontier.nodes[other]!;
            return at.kind === "hold" && at.inner === node.inner && at.set === union;
          })
        )
          violations.push(`goal ${goal.node} at ${goal.step}: the union of ${node.inner} not held`);
      }
      bases += seen.size;
    }
  return { violations, largest, held, bases };
}

/**
 * #1655: the pushed read's slot for a prefix entry read at `ref` (`entryAt`'s key branch), or `null` where the native
 * reader answers: a key entry below its place's root, in a copy cycle through a projection, whose closure the graph
 * models.
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
  const key = entry.key;
  const path = keyPath(key);
  if (path.length === 0) return null;
  const steps = stepsArray(ref.steps());
  return reachSlot(contract, keptParts(contract.work, "pr", key, steps), keyPlace(key), () => {
    properties(path);
    propertiesOrElements(steps);
    const frontier = frontierOf(contract);
    let set = intern(frontier, [rootNode(frontier, keyPlace(key))]);
    for (const each of path) set = star(frontier, set, each);
    for (const each of steps) set = star(frontier, set, each);
    return setMembers(frontier, set);
  });
}

/**
 * #1655: the pushed read's slot for a store's value read whole where the path ends (`contractAlong`'s definitions,
 * below their writing edge): a chain of property reads (`p1 = p1.q.q…`) of a binding in a copy cycle through a
 * projection, or `null` where the native reader answers, so the chain's own keys (`p1.q`, `p1.q.q`, …) are not the
 * binding's root's.
 */
export function pushedValueSlot(contract: Contract, value: PlaceId): string | null {
  const { program } = contract.pass;
  if (!pushing || !program.projOf.has(value)) return null;
  // (the chain's root read, from the pass's index: `Contract.chainOf`)
  const chain = contract.chainOf(value);
  const binding = chain === null ? undefined : program.occurrenceOf.get(chain.root);
  if (binding === undefined) return null;
  return reachSlot(contract, keptParts(contract.work, "pv", value), binding, () =>
    collect(frontierOf(contract), (then) => eachValue(frontierOf(contract), value, then)),
  );
}

/**
 * A pushed read's slot where `place` is in a copy cycle through a projection and the nodes `start` finds the graph
 * models, with their leaves; built once per slot and pass as shared work (r4.349), a build that declines or stops
 * keeping nothing.
 */
function reachSlot(
  contract: Contract,
  slot: string,
  place: PlaceId,
  start: () => readonly number[],
): string | null {
  try {
    return builtSlot(contract, slot, place, start);
  } catch (error) {
    if (!(error instanceof Activate)) throw error;
    // (#2005: the build stopped at its first pending mark, rolled back; built again, scoped)
    frontierOf(contract).scoped = true;
    return builtSlot(contract, slot, place, start);
  }
}

function builtSlot(
  contract: Contract,
  slot: string,
  place: PlaceId,
  start: () => readonly number[],
): string | null {
  const frontier = frontierOf(contract);
  // (after a stop at a place the graph holds, the native reader answers: its keys ask their stops one by one)
  if (heldStopped(frontier)) return null;
  if (frontier.reads.has(slot)) return frontier.reads.get(slot) === null ? null : slot;
  const work = contract.pass.program.work;
  const reach = work.shared((): Reach | null => {
    try {
      if (!cyclic(frontier, place)) return null;
      const items: Item[] = [];
      const natives: PlaceId[] = [];
      for (const leaf of leavesOf(frontier, start())) {
        const node = frontier.nodes[leaf]!;
        if (node.kind === "leaf") items.push(node.item);
        else if (node.kind === "native") natives.push(node.value);
      }
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
  place: PlaceId,
  flow: FlowSink | null = null,
): Work<readonly Item[]> {
  if (slot === BEYOND) return [];
  const site = contract.pass.program.places[place]?.site ?? null;
  flow?.include(slot, "pushed");
  return yield {
    key: slot,
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    // #1668: I, the demand's own run: its frame's flow, taken as it starts
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

// --- receiver scopes (#2005) ---------------------------------------------------------------------------------------

/*
 * #2005: native reads no store at or below a receiver prefix holding no record or collection (`receiverWalk`, its
 * floor, `holdsBelow`), carrying that prefix's unknowns. So a pending mark is the pair of its mark automaton's state
 * and the receiver shapes it was reached under (an atom): it advances only while each of them holds something below it,
 * and dies at a floor; a floor's own step stops its prefix's stores and carries its unknowns, its accepted marks too.
 * The shapes are the receiver-shape graph's interned node sets (`shapesOf`: the same producers, unmarked). An atom of
 * no shape is its plain state. With Q shapes reached, at most R·2^Q atoms, before absorption.
 */

/** #2005: a build's first pending mark, or first mark past an unwitnessed root: the build reruns, scoped. */
class Activate extends Error {}

/** #2005: a pending atom: a mark automaton state and the receiver shapes it holds under, ascending. */
interface Atom {
  readonly state: number;
  readonly scopes: readonly number[];
}

/** #2005: an atom's step, once per atom and step: marked, or its atoms one step further. */
interface AtomStep {
  readonly marked: boolean;
  readonly states: readonly number[];
}

interface Product {
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
interface TermGoal {
  readonly node: number;
  readonly value: Set<number>;
  readers: ((node: number) => void)[] | null;
}

interface Terms {
  readonly goals: Map<number, TermGoal>;
  fresh: TermGoal[];
  pending: TermGoal[];
}

function productOf(frontier: Frontier): Product {
  return (frontier.product ??= {
    shapes: new Frontier(frontier.contract, frontier),
    atoms: [],
    atomIds: new Map(),
    steps: new Map(),
    structured: new Map(),
    pure: new Map(),
    safe: new WeakMap(),
    accepts: new Map(),
    floors: 0,
  });
}

function atomOf(product: Product, id: number): Atom {
  return id >= 0 ? { state: id, scopes: [] } : product.atoms[-id - 1]!;
}

/** #2005: the atom of `state` under `scopes`, interned once; under none, the state itself. */
function atomId(frontier: Frontier, state: number, scopes: readonly number[]): number {
  if (scopes.length === 0) return state;
  const product = productOf(frontier);
  const list = [...new Set(scopes)].sort((a, b) => a - b);
  const name = `${state}:${list.join(",")}`;
  const known = product.atomIds.get(name);
  if (known !== undefined) return known;
  step(frontier, 1 + list.length);
  frontier.contract.keepText(name.length);
  keep(frontier.contract.work, 1 + list.length);
  const id = -(product.atoms.length + 1);
  product.atoms.push({ state, scopes: list });
  product.atomIds.set(name, id);
  return id;
}

/** #2005: a sorted pending list without the atoms its plain states absorb (`L(r)` holds `L(r) ∧ C`). */
function absorbed(frontier: Frontier, list: readonly number[]): readonly number[] {
  if (list.length === 0 || list[0]! >= 0) return list;
  const product = productOf(frontier);
  const plain = new Set<number>();
  for (const id of list) {
    step(frontier);
    if (id >= 0) plain.add(id);
  }
  if (plain.size === 0) return list;
  const out: number[] = [];
  for (const id of list) {
    step(frontier);
    if (id >= 0 || !plain.has(atomOf(product, id).state)) out.push(id);
  }
  return out;
}

/** #2005: whether a pending set's states hold `state`: itself, or an atom's plain state that absorbs it. */
function covered(frontier: Frontier, states: ReadonlySet<number>, state: number): boolean {
  if (states.has(state)) return true;
  return (
    state < 0 && frontier.product !== null && states.has(atomOf(frontier.product, state).state)
  );
}

/** #2005: a set's atoms one step further: each dies where one of its shapes is a floor, else steps with them. */
function advanceAtoms(frontier: Frontier, states: readonly number[], s: string): Decision {
  const product = productOf(frontier);
  const rest = new Set<number>();
  for (const id of states) {
    step(frontier);
    let bySteps = product.steps.get(id);
    let known = bySteps?.get(s);
    if (known === undefined) {
      const atom = atomOf(product, id);
      let live = true;
      const scopes: number[] = [];
      for (const scope of atom.scopes) {
        step(frontier);
        if (!structured(frontier, scope)) {
          live = false;
          break;
        }
        scopes.push(shapeStep(frontier, scope, s));
      }
      const residual = live
        ? markStep(frontier.contract, [atom.state], s)
        : { marked: false, states: [] };
      known = {
        marked: residual.marked,
        states: residual.states.map((state) => atomId(frontier, state, scopes)),
      };
      if (bySteps === undefined) product.steps.set(id, (bySteps = new Map()));
      keep(frontier.contract.work, 1 + known.states.length);
      bySteps.set(s, known);
    }
    if (known.marked) return { marked: true, rest: -1 };
    for (const state of known.states) rest.add(state);
  }
  return { marked: false, rest: internPending(frontier, rest) };
}

/** #2005: a node without its mark or hold. */
function baseOf(frontier: Frontier, node: number): number {
  let at = node;
  for (let n = frontier.nodes[at]!; n.kind === "mark" || n.kind === "hold"; n = frontier.nodes[at]!)
    at = n.inner;
  return at;
}

/** #2005: the receiver shape of `roots`: their base nodes, one interned set of the receiver-shape graph. */
function shapesOf(frontier: Frontier, roots: readonly number[]): number {
  return intern(
    productOf(frontier).shapes,
    roots.map((node) => baseOf(frontier, node)),
  );
}

/** #2005: a shape one step `s` below, the receiver-shape graph's (`next(S, s)`). */
function shapeStep(frontier: Frontier, shape: number, s: string): number {
  return star(productOf(frontier).shapes, shape, s);
}

/**
 * #2005: `H(S)`: whether a leaf of a shape holds something below it (`holdsBelow`), once per shape. A shape of no such
 * leaf but a native value's is not guessed: the native reader answers (`floor-shape-native`).
 */
function structured(frontier: Frontier, shape: number): boolean {
  const product = productOf(frontier);
  const known = product.structured.get(shape);
  if (known !== undefined) return known;
  const { shapes } = product;
  let answer = false;
  let opaque = false;
  for (const leaf of leavesOf(shapes, setMembers(shapes, shape))) {
    step(frontier);
    const node = shapes.nodes[leaf]!;
    if (node.kind === "native") opaque = true;
    else if (node.kind === "leaf" && holdsBelow(node.item)) {
      answer = true;
      break;
    }
  }
  if (!answer && opaque) throw new Decline("floor-shape-native");
  keep(frontier.contract.work, 1);
  product.structured.set(shape, answer);
  return answer;
}

/**
 * #2005: the nodes `steps` from `from` on below `roots`, each passed to `then`, in one receiver scope: at each prefix,
 * the roots' shape there (`shapesOf`, `shapeStep`); a structured one's step is its goal's, a floor's carries its
 * unknowns (`floorBelow`), and each node reached held takes the next prefix's shape (`constrain`). Roots that no read
 * below them changes take their steps directly (`fastBelow`).
 */
function compose(
  frontier: Frontier,
  roots: readonly number[],
  steps: readonly string[],
  from: number,
  then: (node: number) => void,
): void {
  if (from === steps.length) {
    for (const node of roots) then(node);
    return;
  }
  if (roots.every((node) => pure(frontier, node) || selfSafe(frontier, node))) {
    for (const node of roots) fastBelow(frontier, node, steps, from, then);
    return;
  }
  let shape = shapesOf(frontier, roots);
  const shapes = [shape];
  for (let at = from; at < steps.length; at += 1) {
    step(frontier);
    shape = shapeStep(frontier, shape, steps[at]!);
    shapes.push(shape);
  }
  const walk = (node: number, at: number): void => {
    if (at === steps.length) return then(node);
    const next = shapes[at - from + 1]!;
    const use = (found: number): void => walk(constrain(frontier, found, next), at + 1);
    if (structured(frontier, shapes[at - from]!)) plainBelow(frontier, node, steps[at]!, use);
    else floorBelow(frontier, node, steps[at]!, use);
  };
  for (const node of roots) walk(node, from);
}

/**
 * #2005: a node reached held under the receiver shape `shape`: its atoms constrained by it; at a floor, its pending
 * marks dropped (false there, and native excludes them on every continuation). A held literal that supports its marks
 * keeps them as they are (`selfSafe`).
 */
function constrain(frontier: Frontier, node: number, shape: number): number {
  const at = frontier.nodes[node]!;
  if (at.kind !== "hold" || selfSafe(frontier, node)) return node;
  const product = productOf(frontier);
  if (!structured(frontier, shape)) {
    product.floors += 1;
    return at.inner;
  }
  const states = frontier.pendingSets[at.set]!;
  let unchanged = true;
  for (const id of states) {
    step(frontier);
    if (!atomOf(product, id).scopes.includes(shape)) {
      unchanged = false;
      break;
    }
  }
  if (unchanged) return node;
  const atoms = new Set<number>();
  for (const id of states) {
    step(frontier);
    const atom = atomOf(product, id);
    atoms.add(atomId(frontier, atom.state, [...atom.scopes, shape]));
  }
  const set = internPending(frontier, atoms);
  if (set === at.set) return node;
  return nodeId(frontier, joinParts("H", at.inner, set), () => ({
    kind: "hold",
    inner: at.inner,
    set,
  }));
}

/**
 * #2005: one step below a node at a floor, as native reads it: a key's direct children with stores (a longer prefix's,
 * which native still reads), and its terms' unknowns, a marked one still marked; a native value's declines.
 */
function floorBelow(
  frontier: Frontier,
  node: number,
  s: string,
  then: (node: number) => void,
): void {
  const at = frontier.nodes[baseOf(frontier, node)]!;
  step(frontier);
  if (at.kind === "key") {
    const path = keptSteps(frontier.contract.work, at.path, [s]);
    for (const member of at.members)
      if (holds(frontier.contract, member, path)) then(keyNode(frontier, member, path));
  }
  termsAt(frontier, node, (term) => {
    const leaf = frontier.nodes[term]!;
    if (leaf.kind !== "leaf") throw new Decline("floor-native");
    if (leaf.item.tag !== "unknown") return;
    if (s === "element" && (leaf.item.reasons & REASON.external) !== 0)
      throw new Decline("host element");
    const base = frontier.markBases.get(term);
    then(base === undefined ? term : markNode(frontier, base));
  });
}

/** #2005: whether no read below a node changes it: an unknown leaf, or a literal whose index holds no read below. */
function pure(frontier: Frontier, node: number): boolean {
  const product = productOf(frontier);
  const known = product.pure.get(node);
  if (known !== undefined) return known;
  let at = frontier.nodes[node]!;
  if (at.kind === "mark") at = frontier.nodes[at.inner]!;
  let answer = at.kind === "leaf" && at.item.tag === "unknown";
  if (at.kind === "lit") {
    const held = heldBelow(frontier.contract, at.at);
    answer = held.reads === 0 && !held.others;
  }
  step(frontier);
  keep(frontier.contract.work, 1);
  product.pure.set(node, answer);
  return answer;
}

/** #2005: a node held over a pure literal whose structure supports each of its plain states (`literalSafe`). */
function selfSafe(frontier: Frontier, node: number): boolean {
  const held = frontier.nodes[node]!;
  if (held.kind !== "hold") return false;
  const at = frontier.nodes[held.inner]!;
  if (at.kind !== "lit" || !pure(frontier, held.inner)) return false;
  for (const id of frontier.pendingSets[held.set]!) {
    step(frontier);
    if (id < 0 || !literalSafe(frontier, id, at.at)) return false;
  }
  return true;
}

/** #2005: whether a mark state accepts through its epsilon edges, once per state. */
function acceptsNow(frontier: Frontier, state: number): boolean {
  const product = productOf(frontier);
  const known = product.accepts.get(state);
  if (known !== undefined) return known;
  const seen = new Set<number>([state]);
  const open = [state];
  let answer = false;
  while (open.length > 0 && !answer) {
    step(frontier);
    const at = markState(frontier.contract, open.pop()!);
    answer = at.accepting;
    for (const to of at.epsilon)
      if (!seen.has(to)) {
        seen.add(to);
        open.push(to);
      }
  }
  keep(frontier.contract.work, 1);
  product.accepts.set(state, answer);
  return answer;
}

/** #2005: whether a literal index node holds a structure: one of its terms' kinds holds below it. */
function literalHolds(frontier: Frontier, at: IndexNode): boolean {
  for (const tag of at.terms.keys()) {
    step(frontier);
    if (holdsBelow(makeItem(tag, null))) return true;
  }
  return false;
}

/**
 * #2005: whether a literal's structure supports a mark state's every continuation before it accepts, so its receiver
 * scope adds nothing: each state and index node it reaches, on an explicit stack, accepts, or holds a structure and
 * has the child each step takes. One pair failing fails it; once per state and index node.
 */
function literalSafe(frontier: Frontier, state: number, at: IndexNode): boolean {
  const product = productOf(frontier);
  let byState = product.safe.get(at);
  const known = byState?.get(state);
  if (known !== undefined) return known;
  const seen = new Map<IndexNode, Set<number>>();
  const visited: [IndexNode, number][] = [];
  const open: [IndexNode | undefined, number][] = [[at, state]];
  let safe = true;
  while (open.length > 0 && safe) {
    step(frontier);
    const [node, id] = open.pop()!;
    if (acceptsNow(frontier, id)) continue;
    if (node === undefined) {
      safe = false;
      break;
    }
    const cached = product.safe.get(node)?.get(id);
    if (cached === true) continue;
    if (cached === false || !literalHolds(frontier, node)) {
      safe = false;
      break;
    }
    let states = seen.get(node);
    if (states === undefined) seen.set(node, (states = new Set()));
    if (states.has(id)) continue;
    states.add(id);
    visited.push([node, id]);
    const mark = markState(frontier.contract, id);
    for (const [s, to] of mark.next) open.push([node.children.get(s), to]);
    for (const to of mark.epsilon) open.push([node, to]);
  }
  // (every pair a safe walk reached is safe; a failed walk says so of its start alone)
  for (const [node, id] of safe ? visited : [[at, state] as [IndexNode, number]]) {
    keep(frontier.contract.work, 1);
    let bySafe = product.safe.get(node);
    if (bySafe === undefined) product.safe.set(node, (bySafe = new Map()));
    bySafe.set(id, safe);
  }
  byState ??= product.safe.get(at);
  return byState?.get(state) ?? safe;
}

/** #2005: `steps` from `from` on below a node no read below changes, each step taken directly (`innerBelow`). */
function fastBelow(
  frontier: Frontier,
  node: number,
  steps: readonly string[],
  from: number,
  then: (node: number) => void,
): void {
  if (from === steps.length) return then(node);
  innerBelow(frontier, node, steps[from]!, (found) =>
    fastBelow(frontier, found, steps, from + 1, then),
  );
}

/**
 * One step below a marked or held node's inner node: its goal's; #2005, scoped, a pure one's step read directly, as
 * its goal's rules would (a literal's child and F11's `missing`, an unknown leaf itself).
 */
function innerBelow(
  frontier: Frontier,
  node: number,
  s: string,
  then: (node: number) => void,
): void {
  const at = frontier.nodes[node]!;
  if (frontier.scoped && pure(frontier, node)) {
    step(frontier);
    if (at.kind === "leaf") {
      if (s === "element" && frontier.hosts.has(node)) throw new Decline("host element");
      return then(node);
    }
    if (at.kind === "mark")
      return innerBelow(frontier, at.inner, s, (found) => then(markNode(frontier, found)));
    if (at.kind === "lit") {
      const { contract } = frontier;
      const { literal, index, id } = at;
      if (at.at.reference) throw new Decline("reference");
      if (s === "element" && (at.at.children.has(s) || at.at.empty))
        throw new Decline("collection");
      const child = at.at.children.get(s);
      if (child !== undefined) then(litNode(frontier, literal, pathAt(contract, id, s), child));
      const lacking = lackingAt(contract, index, id, s);
      if (lacking !== null)
        then(
          leafNode(frontier, joinParts("m", literal, id, s), () =>
            unknownItem(REASON.missing, lacking),
          ),
        );
      return;
    }
  }
  plainBelow(frontier, node, s, then);
}

/**
 * #2005: whether the node whose rules run witnesses a record where a mark accepts past its holder's root: a literal
 * holding an object, or a key whose first store is a live whole copy of an object.
 */
function immediateSafe(frontier: Frontier): boolean {
  const id = frontier.ruleNode;
  if (id === undefined) return false;
  const node = frontier.nodes[id]!;
  if (node.kind === "lit") return node.at.terms.has("object");
  if (node.kind !== "key") return false;
  const { definitions, lists, program } = frontier.contract.pass;
  const first = definitions.byKey.get(node.key)?.[0];
  return (
    first !== undefined &&
    first.kind === "whole" &&
    first.value !== undefined &&
    lists.live(first) &&
    program.hasOf.get(first.value)?.[0]?.type.kind === "object"
  );
}

/** #2005: a node's terms (`TermGoal`), each passed to `then` as found. */
function termsAt(frontier: Frontier, node: number, then: (node: number) => void): void {
  if (frontier.terms === null) frontier.terms = { goals: new Map(), fresh: [], pending: [] };
  const terms = frontier.terms;
  let goal = terms.goals.get(node);
  if (goal === undefined) {
    frontier.contract.keep(2);
    goal = { node, value: new Set(), readers: [] };
    terms.goals.set(node, goal);
    terms.fresh.push(goal);
    terms.pending.push(goal);
  }
  step(frontier);
  goal.readers?.push(then);
  for (const found of goal.value) frontier.tasks.push([then, found]);
}

function termGain(frontier: Frontier, goal: TermGoal, found: number): void {
  step(frontier);
  if (goal.value.has(found)) return;
  goal.value.add(found);
  keep(frontier.contract.work, 1);
  for (const reader of goal.readers ?? []) frontier.tasks.push([reader, found]);
}

/**
 * #2005: a term goal's rules: a leaf or native value is its own term; a marked or held node its inner node's, marked
 * where marked; a key its live whole stores' values' terms; a literal index node its terms' leaves, its reads' terms
 * through their marks and its computed values. A value the graph declines is read natively, unless the decline left
 * goals of the build.
 */
function termRules(frontier: Frontier, goal: TermGoal): void {
  const node = frontier.nodes[goal.node]!;
  const { program, definitions, lists } = frontier.contract.pass;
  const into = (found: number): void => termGain(frontier, goal, found);
  step(frontier);
  const term = (at: number, mark = false): void =>
    termsAt(frontier, at, (found) => into(mark ? markedLeaf(frontier, found) : found));
  const value = (at: PlaceId, route: ((node: number) => number) | null = null): void => {
    const native = (): void =>
      term(route === null ? nativeNode(frontier, at) : route(nativeNode(frontier, at)));
    if (
      program.occurrenceOf.get(at) === undefined &&
      !program.projOf.has(at) &&
      !(program.hasOf.has(at) && !program.cellOwner.has(at))
    )
      return native();
    const before = frontier.pending.length;
    try {
      eachValue(frontier, at, (found) => term(route === null ? found : route(found)));
    } catch (error) {
      if (!(error instanceof Decline) || frontier.pending.length !== before) throw error;
      native();
    }
  };
  if (node.kind === "leaf" || node.kind === "native") return into(goal.node);
  if (node.kind === "mark" || node.kind === "hold") return term(node.inner, node.kind === "mark");
  if (node.kind === "key") {
    for (const member of node.members)
      for (const definition of definitions.byKey.get(keyOf(member, node.path)) ?? []) {
        step(frontier);
        if (!lists.live(definition)) continue;
        if (
          definition.kind !== "whole" ||
          definition.value === undefined ||
          definition.how === "argument" ||
          definition.how === "parameter default"
        )
          throw new Decline("definition");
        value(definition.value);
      }
    return;
  }
  for (const [tag, token] of node.at.terms)
    into(
      leafNode(frontier, joinParts("t", node.literal, node.id, tag), () => makeItem(tag, token)),
    );
  for (const read of node.at.reads) value(read.value, routeOf(frontier, read, []));
  for (const other of node.at.others) into(nativeNode(frontier, other.value));
}
