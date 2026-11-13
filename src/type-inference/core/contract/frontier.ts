import type { PlaceId } from "../../graph.js";
import { keptParts } from "../budget.js";
import type { Contract } from "../contract.js";
import { keyOf, keyPath, keyPlace } from "../definitions.js";
import { mergeItems, type Item } from "../items.js";
import type { Work } from "../solver.js";
import type { FlowSink } from "./contributions.js";
import { isKeyId, keyDepthIn, stepsArray, type PathRef } from "./key-ids.js";
import type { PrefixEntry } from "./model.js";
import { amend, Retained, retainedModule } from "../retained/retained.js";
import {
  type Reach,
  Decline,
  Frontier,
  step,
  rootNode,
  heldStopped,
  properties,
  propertiesOrElements,
  intern,
  setMembers,
  Activate,
} from "./frontier/nodes.js";
import { atomOf, covered } from "./frontier/shapes.js";
import { eachValue, collect, star, leavesOf } from "./frontier/walk.js";

/*
 * #1655: a read below a push, one step at a time. A prefix's key entry below its own root (`p1 = p1.q`, a copy cycle
 * through a projection) read at a rest is the key `p1.q·rest`, which reads that entry again at `q·rest`: every read
 * makes a longer key, and no two of them are one by their structure. Below such an entry's writing edge (`entryAt`'s
 * `withWriter`), the read is the join of the leaves its producers reach, found over a finite producer graph of the
 * pass: a binding's positions (`key`, its whole-copy cycle one node through the summaries' least solution), a
 * literal's index nodes (`lit`), and leaves (`leaf`: a missing property's `missing`, a host's unknown, a literal's
 * terms; `native`: a value the graph does not model, read natively where the path ends). `Sum(n, s)` is the nodes one
 * step `s` below `n` reaches (least solution, cycles closed by producer edges only, seedless ones empty); `Term(n)` the
 * leaves at `n`. The writing edge overwrites every writer but a pure `missing`'s, whose earliest token the join keeps,
 * and every other field the merge joins, so the join is the native nested answer there. A closure outside
 * the eligible grammar declines: the native reader answers.
 *
 * #1784: a route through a marking entry or literal read (its guard bit, or its holder's mark at the rest below it)
 * reaches `mark` nodes: the same nodes, their leaves `marked`. A holder's mark depends on the rest's first
 * `depthOf` steps, so its route is a `hold` node carrying the residual states of the mark automaton those steps leave,
 * until they decide it (or the path ends). Marking each leaf and then joining is native's join of marked answers exactly where no native-value leaf is
 * reached marked (`marked` commutes with `mergePair` per item unless a context ranked after `"branch"` meets a
 * null one, and only a native value carries one): such a leaf declines (`marks-native`).
 */

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

const FRONTIERS = retainedModule<Contract, Frontier>("frontier.FRONTIERS", "weakMap");

function frontierOf(contract: Contract): Frontier {
  let frontier = FRONTIERS().get(contract);
  if (frontier === undefined) FRONTIERS().set(contract, (frontier = new Frontier(contract)));
  return frontier;
}

/** Drops the goals of a build that declined or stopped: none of them is final. */
function rollback(frontier: Frontier): void {
  amend(frontier);
  for (const goal of frontier.pending) frontier.goals.get(goal.node)?.delete(goal.step);
  frontier.pending = Retained.arena("Frontier.pending");
  frontier.fresh = Retained.array("Frontier.fresh");
  frontier.tasks = Retained.array("Frontier.tasks");
  frontier.draining = false;
  // (#2005: its term goals, and the receiver-shape graph's build it stopped in)
  if (frontier.terms !== null) {
    for (const term of frontier.terms.pending) frontier.terms.goals.delete(term.node);
    frontier.terms.pending = Retained.arena("Frontier.terms.pending");
    frontier.terms.fresh = Retained.array("Frontier.terms.fresh");
  }
  if (frontier.product !== null) rollback(frontier.product.shapes);
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
  const frontier = FRONTIERS().get(contract);
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
  const frontier = FRONTIERS().get(contract);
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
 * models, with their leaves; built once per slot and pass as shared work
 * (docs/specifications/type-inference-accepted-record/solver-and-work.md#r4-349), a build that declines or stops
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
  // (a slot's build grows the frontier in place, in the run that asks it: its nodes, sets, pending sets and goals)
  amend(frontier);
  // (and its product's shapes, a frontier of their own, where a build before made them; a build that makes them marks
  // them as it does)
  if (frontier.product !== null) amend(frontier.product.shapes);
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
    // #1668: the demand's own run: its frame's flow, taken as it starts
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
