// The frontier's walk: goals advanced through their rules, drained and collected, a node's terms and leaves, and shapes
// composed below a node.

import type { PlaceId } from "../../../graph.js";
import { joinParts, keep, keptSteps } from "../../budget.js";
import { keyOf, keyPath, keyPlace } from "../../definitions.js";
import { makeItem, REASON } from "../../items.js";
import { selectsElement } from "../../method-categories.js";
import { positions } from "../../positions.js";
import { ingressLeafOf } from "../ingress.js";
import { isKeyId } from "../key-ids.js";
import { holdsBelow, unknownItem } from "../kinds.js";
import { lackingAt, pathAt } from "../literal-index.js";
import { markStep } from "../mark-automaton.js";
import type { PrefixEntry } from "../model.js";
import { amend, Retained } from "../../retained/retained.js";
import {
  type Goal,
  Decline,
  Frontier,
  step,
  nodeId,
  keyNode,
  rootNode,
  holds,
  litNode,
  leafNode,
  nativeNode,
  markNode,
  type Decision,
  properties,
  passesWrapper,
  goalOf,
  plainBelow,
  intern,
  setMembers,
  stateOf,
  type TermGoal,
  termsAt,
  termGain,
} from "./nodes.js";
import {
  productOf,
  atomOf,
  atomId,
  shapesOf,
  floorBelow,
  pure,
  selfSafe,
  fastBelow,
  innerBelow,
} from "./shapes.js";
import {
  internPending,
  decided,
  pendingBelow,
  routeOf,
  selfMarks,
  marking,
  literalRoot,
  hostLeaf,
  gain,
  plainRead,
  markedLeaf,
} from "./routes.js";

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
  if (bySteps === undefined)
    frontier.advances.set(set, (bySteps = Retained.map("Frontier.advances[]")));
  bySteps.set(s, decision);
  return decision;
}

/**
 * The nodes a value stands for, each passed to `then`: a binding's read its root, a host's read its leaf, a property
 * read its owner's nodes one step below, a literal its root; declines for any other (and for a guarded or ingress read).
 * With `tail`, the nodes `tail` below those, in the same walk (#2005: one receiver scope for the whole path).
 */
export function eachValue(
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
  // (#1072 R26: captures the frontier (an owner), `then` (registered), and `steps` and `from`, fixed when it is made)
  const next = Retained.closure("Frontier.below", (found: number): void =>
    below(frontier, found, steps, from + 1, then),
  );
  step(frontier);
  goal.readers?.push(next);
  for (const found of goal.value) frontier.tasks.push([next, found]);
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
  // (#1072 R26: captures the frontier (an owner) and `goal` (a record))
  const into = Retained.closure("Frontier.goal.into", (found: number): void =>
    gain(frontier, goal, found),
  );
  step(frontier);
  if (node.kind === "leaf") {
    // (a host's data at an element step may hold none, `emptyAt`, where its read's frame holds a structure there and
    // not where it does not: a frame's own, which the graph does not keep, so declined wherever the step reaches it)
    if (s === "element" && frontier.hosts.has(goal.node)) throw new Decline("host element");
    return into(goal.node);
  }
  if (node.kind === "native") throw new Decline("native");
  if (node.kind === "mark")
    return innerBelow(
      frontier,
      node.inner,
      s,
      // (#1072 R26: captures the frontier (an owner) and `into` (registered))
      Retained.closure("Frontier.goal.mark", (found) => into(markNode(frontier, found))),
    );
  if (node.kind === "hold") {
    const decision = advance(frontier, node.set, s);
    return innerBelow(
      frontier,
      node.inner,
      s,
      // (#1072 R26: captures the frontier (an owner), `into` (registered) and `decision`, fixed when it is made)
      Retained.closure("Frontier.goal.hold", (found) =>
        into(pendingBelow(frontier, found, decision)),
      ),
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
    else
      eachValue(
        frontier,
        read.value,
        // (#1072 R26: captures the frontier (an owner), `marked` (registered) and `s`, a string)
        Retained.closure("Frontier.goal.read", (found) => below(frontier, found, [s], 0, marked)),
      );
  }
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
  else
    eachValue(
      frontier,
      entry.value!,
      // (#1072 R26: captures the frontier (an owner), `marked` (registered) and `steps`, fixed when it is made)
      Retained.closure("Frontier.entry", (found) => below(frontier, found, steps, 0, marked)),
    );
}

/**
 * Runs a build to its least solution: each new goal's rules read, each node gained passed on, until neither is left;
 * then every goal of the build is final. A build never starts inside another (a rule reads goals, never `drain`).
 */
function drain(frontier: Frontier): void {
  if (frontier.draining) throw new Error("A producer graph's build ran inside another.");
  // (its flag, and its pending goals replaced at the end: the frontier's own fields)
  amend(frontier);
  frontier.draining = true;
  try {
    for (;;) {
      const goal = frontier.fresh.pop();
      if (goal !== undefined) {
        try {
          rules(frontier, goal);
        } catch (error) {
          if (error instanceof Decline) {
            if (!frontier.poisoned.has(goal.node))
              frontier.poisoned.set(goal.node, Retained.map("Frontier.poisoned[]"));
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
  frontier.pending = Retained.arena("Frontier.pending");
  if (frontier.terms !== null) {
    for (const term of frontier.terms.pending) term.readers = null;
    frontier.terms.pending = Retained.arena("Frontier.terms.pending");
  }
}

/** The nodes a build passes to its collector, once it is settled. */
export function collect(
  frontier: Frontier,
  start: (then: (node: number) => void) => void,
): number[] {
  const out = new Set<number>();
  // (#1072 R26: captures `out`, this build's own, written in this run alone: `drain` makes every goal of the build final,
  // its readers and tasks dropped, before it returns)
  start(Retained.closure("Frontier.collect", (node) => out.add(node)));
  drain(frontier);
  return [...out];
}

/** The interned set one step below a set, settled, once per set and step. */
export function star(frontier: Frontier, set: number, stepName: string): number {
  let bySteps = frontier.below.get(set);
  const known = bySteps?.get(stepName);
  if (known !== undefined) return known;
  const nodes = collect(frontier, (then) => {
    if (frontier.scoped) compose(frontier, frontier.members[set]!, [stepName], 0, then);
    else for (const node of frontier.members[set]!) below(frontier, node, [stepName], 0, then);
  });
  const id = intern(frontier, nodes);
  if (bySteps === undefined) frontier.below.set(set, (bySteps = Retained.map("Frontier.below[]")));
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
 * The leaves at each of `start`'s nodes and every node ε below it: Tarjan's components over states (a node, marked or
 * not: `stateOf`), one leaf list each, a marked state's leaves its node's own `marked`.
 */
export function leavesOf(frontier: Frontier, start: readonly number[]): Set<number> {
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
      if (bySteps === undefined)
        product.steps.set(id, (bySteps = Retained.map("Frontier.product.steps[]")));
      keep(frontier.contract.work, 1 + known.states.length);
      bySteps.set(s, known);
    }
    if (known.marked) return { marked: true, rest: -1 };
    for (const state of known.states) rest.add(state);
  }
  return { marked: false, rest: internPending(frontier, rest) };
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
    // (#1072 R26: captures the frontier (an owner), `next` and `at`, fixed when it is made, and `walk`, capturing the frontier, `then`
    // (registered), and `shapes`, `steps` and `from`, all fixed when it is made)
    const use = Retained.closure("Frontier.compose", (found: number): void =>
      walk(constrain(frontier, found, next), at + 1),
    );
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
 * #2005: a term goal's rules: a leaf or native value is its own term; a marked or held node its inner node's, marked
 * where marked; a key its live whole stores' values' terms; a literal index node its terms' leaves, its reads' terms
 * through their marks and its computed values. A value the graph declines is read natively, unless the decline left
 * goals of the build.
 */
function termRules(frontier: Frontier, goal: TermGoal): void {
  const node = frontier.nodes[goal.node]!;
  const { program, definitions, lists } = frontier.contract.pass;
  // (#1072 R26: captures the frontier (an owner) and `goal` (a record))
  const into = Retained.closure("Frontier.terms.into", (found: number): void =>
    termGain(frontier, goal, found),
  );
  step(frontier);
  const term = (at: number, mark = false): void =>
    termsAt(
      frontier,
      at,
      // (#1072 R26: captures the frontier (an owner), `into` (registered) and `mark`, a boolean)
      Retained.closure("Frontier.terms.term", (found) =>
        into(mark ? markedLeaf(frontier, found) : found),
      ),
    );
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
      eachValue(
        frontier,
        at,
        // (#1072 R26: captures `route`, fixed when it is made (`routeOf`'s), and `term`, capturing the frontier (an
        // owner) and `into` (registered))
        Retained.closure("Frontier.terms.value", (found) =>
          term(route === null ? found : route(found)),
        ),
      );
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
