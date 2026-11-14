// The frontier's receiver shapes (#2022): products of atoms and their safety, and the floor, fast and inner reads below
// a node.
//
// #2005: native reads no store at or below a receiver prefix holding no record or collection (`receiverWalk`, its
// floor, `holdsBelow`), carrying that prefix's unknowns. So a pending mark is the pair of its mark automaton's state
// and the receiver shapes it was reached under (an atom): it advances only while each of them holds something below it,
// and dies at a floor; a floor's own step stops its prefix's stores and carries its unknowns, its accepted marks too.
// The shapes are the receiver-shape graph's interned node sets (`shapesOf`: the same producers, unmarked). An atom of
// no shape is its plain state. With Q shapes reached, at most R·2^Q atoms, before absorption.

import { joinParts, keep, keptSteps } from "../../budget.js";
import { makeItem, REASON } from "../../items.js";
import { holdsBelow, unknownItem } from "../kinds.js";
import { heldBelow, lackingAt, pathAt } from "../literal-index.js";
import { markState } from "../marks.js";
import type { IndexNode } from "../model.js";
import { Retained } from "../../retained/retained.js";
import {
  Decline,
  Frontier,
  step,
  keyNode,
  holds,
  litNode,
  leafNode,
  markNode,
  plainBelow,
  intern,
  type Atom,
  type Product,
  termsAt,
} from "./nodes.js";

export function productOf(frontier: Frontier): Product {
  return (frontier.product ??= Retained.held(
    frontier,
    Retained.record<Product>("Frontier.product", {
      shapes: new Frontier(frontier.contract, frontier),
      atoms: Retained.arena("Frontier.product.atoms"),
      atomIds: Retained.map("Frontier.product.atomIds"),
      steps: Retained.map("Frontier.product.steps"),
      structured: Retained.map("Frontier.product.structured"),
      pure: Retained.map("Frontier.product.pure"),
      safe: Retained.weakMap("Frontier.product.safe"),
      accepts: Retained.map("Frontier.product.accepts"),
      floors: 0,
    }),
  ));
}

export function atomOf(product: Product, id: number): Atom {
  return id >= 0 ? { state: id, scopes: [] } : product.atoms[-id - 1]!;
}

/** #2005: the atom of `state` under `scopes`, interned once; under none, the state itself. */
export function atomId(frontier: Frontier, state: number, scopes: readonly number[]): number {
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
export function absorbed(frontier: Frontier, list: readonly number[]): readonly number[] {
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
export function covered(frontier: Frontier, states: ReadonlySet<number>, state: number): boolean {
  if (states.has(state)) return true;
  return (
    state < 0 && frontier.product !== null && states.has(atomOf(frontier.product, state).state)
  );
}

/** #2005: a node without its mark or hold. */
function baseOf(frontier: Frontier, node: number): number {
  let at = node;
  for (let n = frontier.nodes[at]!; n.kind === "mark" || n.kind === "hold"; n = frontier.nodes[at]!)
    at = n.inner;
  return at;
}

/** #2005: the receiver shape of `roots`: their base nodes, one interned set of the receiver-shape graph. */
export function shapesOf(frontier: Frontier, roots: readonly number[]): number {
  return intern(
    productOf(frontier).shapes,
    roots.map((node) => baseOf(frontier, node)),
  );
}

/**
 * #2005: one step below a node at a floor, as native reads it: a key's direct children with stores (a longer prefix's,
 * which native still reads), and its terms' unknowns, a marked one still marked; a native value's declines.
 */
export function floorBelow(
  frontier: Frontier,
  node: number,
  s: string,
  then: (node: number) => void,
): void {
  const at = frontier.nodes[baseOf(frontier, node)]!;
  step(frontier);
  if (at.kind === "key") {
    const path = keptSteps(frontier.contract.work, at.path, [s]);
    // (through the build's tasks, as a goal passes its nodes: a run of floors holds no native frame per step)
    for (const member of at.members)
      if (holds(frontier.contract, member, path))
        frontier.tasks.push([then, keyNode(frontier, member, path)]);
  }
  termsAt(
    frontier,
    node,
    // (#1072 R26: captures the frontier (an owner), `then` (registered) and `s`, a string)
    Retained.closure("Frontier.floor", (term) => {
      const leaf = frontier.nodes[term]!;
      if (leaf.kind !== "leaf") throw new Decline("floor-native");
      if (leaf.item.tag !== "unknown") return;
      if (s === "element" && (leaf.item.reasons & REASON.external) !== 0)
        throw new Decline("host element");
      const base = frontier.markBases.get(term);
      then(base === undefined ? term : markNode(frontier, base));
    }),
  );
}

/** #2005: whether no read below a node changes it: an unknown leaf, or a literal whose index holds no read below. */
export function pure(frontier: Frontier, node: number): boolean {
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
export function selfSafe(frontier: Frontier, node: number): boolean {
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
  const known = product.safe.get(at)?.get(state);
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
  const settled: [IndexNode, number][] = safe ? visited : [[at, state]];
  for (const [node, id] of settled) {
    keep(frontier.contract.work, 1);
    let bySafe = product.safe.get(node);
    if (bySafe === undefined)
      product.safe.set(node, (bySafe = Retained.map("Frontier.product.safe[]")));
    bySafe.set(id, safe);
  }
  return safe;
}

/** #2005: `steps` from `from` on below a node no read below changes, each step taken directly (`innerBelow`). */
export function fastBelow(
  frontier: Frontier,
  node: number,
  steps: readonly string[],
  from: number,
  then: (node: number) => void,
): void {
  if (from === steps.length) return then(node);
  innerBelow(
    frontier,
    node,
    steps[from]!,
    // (#1072 R26: captures the frontier (an owner), `then` (registered), and `steps` and `from`, fixed when it is made)
    Retained.closure("Frontier.fast", (found) => fastBelow(frontier, found, steps, from + 1, then)),
  );
}

/**
 * One step below a marked or held node's inner node: its goal's; #2005, scoped, a pure one's step read directly, as
 * its goal's rules would (a literal's child and a missing property's `missing`, an unknown leaf itself), each node
 * passed through the build's tasks, so a path of any length below pure nodes holds no native frame per step.
 */
export function innerBelow(
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
      frontier.tasks.push([then, node]);
      return;
    }
    if (at.kind === "mark")
      return innerBelow(
        frontier,
        at.inner,
        s,
        // (#1072 R26: captures the frontier (an owner) and `then` (registered))
        Retained.closure("Frontier.inner.mark", (found) => then(markNode(frontier, found))),
      );
    if (at.kind === "lit") {
      const { contract } = frontier;
      const { literal, index, id } = at;
      if (at.at.reference) throw new Decline("reference");
      if (s === "element" && (at.at.children.has(s) || at.at.empty))
        throw new Decline("collection");
      const child = at.at.children.get(s);
      if (child !== undefined)
        frontier.tasks.push([then, litNode(frontier, literal, pathAt(contract, id, s), child)]);
      const lacking = lackingAt(contract, index, id, s);
      if (lacking !== null)
        frontier.tasks.push([
          then,
          leafNode(frontier, joinParts("m", literal, id, s), () =>
            unknownItem(REASON.missing, lacking),
          ),
        ]);
      return;
    }
  }
  plainBelow(frontier, node, s, then);
}

/**
 * #2005: whether the node whose rules run witnesses a record where a mark accepts past its holder's root: a literal
 * holding an object, or a key whose first store is a live whole copy of an object.
 */
export function immediateSafe(frontier: Frontier): boolean {
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
