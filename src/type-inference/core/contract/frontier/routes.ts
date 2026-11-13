// The frontier's decisions and routes (#1784): pending node sets, a route through a marking entry or a held mark, and a
// goal's gains.

import type { PlaceId } from "../../../graph.js";
import { joinParts, keep } from "../../budget.js";
import type { Contract } from "../../contract.js";
import { marked } from "../../indexes/guards.js";
import { entered, ingressLeafOf } from "../ingress.js";
import { hostAt } from "../kinds.js";
import { pathAt } from "../literal-index.js";
import { markStart, rootAccepts, type MarkResidual } from "../mark-automaton.js";
import { depthOf, marksNothing } from "../marks.js";
import type { PrefixEntry } from "../model.js";
import { Retained } from "../../retained/retained.js";
import {
  type Route,
  type Goal,
  Decline,
  Frontier,
  step,
  nodeId,
  litNode,
  leafNode,
  markNode,
  type Decision,
  type MarkedRead,
  plainBelow,
  Activate,
} from "./nodes.js";
import { absorbed, immediateSafe } from "./shapes.js";

/** #1784: a set of pending states, interned once: its id; -1 for none. */
export function internPending(
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
export function decided(frontier: Frontier, residual: MarkResidual): Decision {
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
export function pendingBelow(frontier: Frontier, node: number, decision: Decision): number {
  const at = frontier.nodes[node]!;
  if (at.kind === "mark") return node;
  const inner = at.kind === "hold" ? at.inner : node;
  if (decision.marked) return markNode(frontier, inner);
  if (decision.rest < 0) return node;
  const set = at.kind === "hold" ? unionPending(frontier, at.set, decision.rest) : decision.rest;
  return nodeId(frontier, joinParts("H", inner, set), () => ({ kind: "hold", inner, set }));
}

/**
 * #1784: what an entry or a literal's read makes of a node it gives at `steps` below it, or `null` where it marks
 * nothing: its guard bit marks it, its holder's mark as the rest decides it (`decide`); an ingress of its own
 * declines (`ingress`).
 */
export function routeOf(
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
export function selfMarks(
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
  plainBelow(
    frontier,
    root,
    s,
    // (#1072 R26: captures the frontier (an owner), `into` (registered) and `decision`, fixed when it is made)
    Retained.closure("Frontier.selfMarks", (found) =>
      into(pendingBelow(frontier, found, decision)),
    ),
  );
}

/** `into` through a read's marks (`routeOf`). */
export function marking(
  frontier: Frontier,
  read: MarkedRead,
  steps: readonly string[],
  into: (node: number) => void,
): (node: number) => void {
  const route = routeOf(frontier, read, steps);
  // (#1072 R26: captures `into` (registered) and `route`, fixed when it is made, itself capturing only the frontier (an
  // owner) and a `decision` fixed when it is made)
  return route === null ? into : Retained.closure("Frontier.marking", (node) => into(route(node)));
}

/** A literal's root as a node: a plain record or scalar literal (no cell, no selection). */
export function literalRoot(frontier: Frontier, literal: PlaceId): number {
  const index = frontier.contract.literalIndex(literal);
  return litNode(frontier, literal, 0, index.root);
}

/** A host read's leaf: the runtime's unknown at every path, its ingress entered (`hostAt`, `entered`). */
export function hostLeaf(frontier: Frontier, value: PlaceId): number {
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

export function gain(frontier: Frontier, goal: Goal, found: number): void {
  step(frontier);
  // #1784: a base node reached held with several pending sets is reached with their union: marked where any marks. A
  // marked leaf absorbs its unmarked twin in the join (guarded makes it `pos`, `"branch"` beats no context, every other
  // field equal), so the alternatives together give what their union gives, and a set the union holds adds nothing; so
  // each base node's held states in a goal form one growing chain, not every combination of its pending marks (Codex
  // r3 B3).
  let node = found;
  const at = frontier.nodes[found]!;
  if (at.kind === "hold") {
    goal.holds ??= Retained.held(goal, Retained.map("Frontier.goal.holds"));
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

/** Whether an entry or a literal's read carries no mark and no ingress of its own (`annotated` leaves it as it is). */
export function plainRead(contract: Contract, read: MarkedRead): boolean {
  if (read.guarded || !marksNothing(contract, read.holder)) return false;
  return (
    read.ingress === undefined ||
    (read.value !== undefined && read.ingress === ingressLeafOf(contract, read.value))
  );
}

/** #1784: a leaf reached marked: its item `marked`; a native value's declines (`marks-native`, HEAD 1's condition). */
export function markedLeaf(frontier: Frontier, leaf: number): number {
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
