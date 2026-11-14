import type { PlaceId, TypeTerm } from "../../graph.js";
import type { Definition, DefinitionIndex } from "../definitions.js";
import { makeItem, REASON, type Item } from "../items.js";
import { selectsElement } from "../method-categories.js";
import type { CoreProgram } from "../program.js";
import { Retained } from "../retained/retained.js";

// #2764 (B): the nesting cut. A list nested a level deeper on each turn of a cycle of copies, arguments and results is
// known to a depth fixed by the program, and below it only when the script runs.

/**
 * The cut's answer (#2764, B): a value known only when the script runs (rule 1.7), opaque, at every step below a
 * growing component's cut depth.
 */
export const CUT: readonly Item[] = Object.freeze([
  makeItem("unknown", null, { reasons: REASON.opaque, context: "unmodelled", cert: "pos" }),
]);

/** A route from a producer into a receiver, with the element levels the producer's value gains there. */
interface Edge {
  readonly producer: PlaceId;
  readonly weight: number;
}

/** The depth of a place that holds no kind at all: a literal's cell nothing is stored in, an element of a scalar. */
const NOTHING = -1;

/** The depth a producer's value reaches in its receiver along a route of `weight`: none where it holds nothing there. */
function reach(depth: number, weight: number): number {
  return depth === NOTHING ? NOTHING : Math.max(NOTHING, depth + weight);
}

/**
 * The depth a place holds by itself, before any route: an expression's own value (a literal, an operation's result,
 * host data, a load) is a kind at its root; a variable, a parameter, a result, a literal's cell, a read, a projection
 * and a call's result hold only what reaches them.
 */
function ownDepth(program: CoreProgram, place: PlaceId): number {
  if (program.places[place]?.kind.kind !== "value") return NOTHING;
  if (program.occurrenceOf.has(place) || program.projOf.has(place)) return NOTHING;
  return program.opOf.get(place)?.kind === "call" ? NOTHING : 0;
}

/** The steps a projection takes into one element of its owner (`stepName`'s `element`). */
const ELEMENT_STEPS: ReadonlySet<string> = new Set(["element", "index", "iteration", "entry"]);

/** The element levels a written type spells: a list's, a set's or a dict's element below each, a union's deepest. */
function writtenDepth(term: TypeTerm): number {
  let depth = 0;
  const pending: { readonly term: TypeTerm; readonly at: number }[] = [{ term, at: 0 }];
  while (pending.length > 0) {
    const { term: next, at } = pending.pop()!;
    depth = Math.max(depth, at);
    if (next.kind === "list" || next.kind === "set" || next.kind === "dict")
      pending.push({ term: next.element, at: at + 1 });
    else if (next.kind === "union")
      for (const member of next.members) pending.push({ term: member, at });
  }
  return depth;
}

/** The type written at a place: a variable's, a parameter's or a result's; `null` where none is written. */
function writtenAt(program: CoreProgram, place: PlaceId): TypeTerm | null {
  const kind = program.places[place]?.kind;
  if (kind === undefined) return null;
  if (kind.kind === "binding" || kind.kind === "parameter" || kind.kind === "result")
    return kind.written;
  return null;
}

/** How many of a key's steps are element steps: its depth in nested lists. */
export function elementDepth(path: readonly string[]): number {
  let depth = 0;
  for (const step of path) if (step === "element") depth += 1;
  return depth;
}

/**
 * The nesting graph of one pass (ADR 0021 §1.1, #2764's rule B) and its cut depths. Its nodes are the program's places;
 * its edges run from a receiver to a producer, weighted by the element levels the producer's value gains in the
 * receiver: 0 for a whole copy, an argument, a return, a read, a call's result, a list `+`'s operand and either side
 * of `otherwise`; +1 for a list literal's element and an `add`; the receiver's path below its root for a store through
 * elements; −1 for an element, an index, a loop's element, a selection and a `get`'s element (its default: 0). A place with a written type takes no edge: the written type decides it.
 * A route the graph does not name makes no edge, so a cycle through it is never cut.
 *
 * A strongly connected component that holds a cycle of positive weight grows without end under F20 and F21. It is
 * followed one level deeper than what enters it, `M + 1`: `M` the deepest element level that enters it from outside (a
 * literal's structure, a written type's levels, an earlier component's depth); deeper, a value is known only when the
 * script runs. A cycle that gains more than one level a turn (`a = [[a]]`) turns unknown within its first turn.
 * Components are taken producers first, so `M` is finite. The cut depends on the graph alone, never on the order
 * anything is asked in (r4-44).
 */
export class NestingIndex {
  /** Each place of a growing component, with its cut depth. */
  readonly #cut = Retained.map<PlaceId, number>("NestingIndex.#cut");

  /** `live` says which of the pass's definitions take effect (admission's rejections, A6). */
  public constructor(
    program: CoreProgram,
    definitions: DefinitionIndex,
    live: (d: Definition) => boolean,
  ) {
    Retained.owner(this, "NestingIndex", (index) => ({ cut: index.#cut }));
    const into = edgesOf(program, definitions, live);
    const work = program.work;
    const depth = new Map<PlaceId, number>();
    for (const component of components(program, into)) {
      const members = new Set(component);
      // what enters from outside, and the base a written type gives
      const entry = new Map<PlaceId, number>();
      let entering = NOTHING;
      // (the +1 edges inside: a simple path gains at most these, the bound of the positive-cycle test)
      let gain = 0;
      for (const place of component) {
        const written = writtenAt(program, place);
        const edges = into.get(place) ?? [];
        let at = written !== null ? writtenDepth(written) : ownDepth(program, place);
        for (const edge of edges) {
          work.charge("indexSteps");
          if (members.has(edge.producer)) {
            if (edge.weight > 0) gain += 1;
          } else at = Math.max(at, reach(depth.get(edge.producer) ?? NOTHING, edge.weight));
        }
        entry.set(place, at);
        entering = Math.max(entering, at);
      }
      const closed =
        component.length > 1 ||
        (into.get(component[0]!) ?? []).some((edge) => edge.producer === component[0]);
      const longest = closed
        ? longestWithin(program, into, members, entry, Math.max(entering, 0) + gain)
        : entry;
      if (longest === null) {
        // a positive cycle: every member is known one level deeper than what enters it, and so is what reads it
        const cut = Math.max(entering, 0) + 1;
        for (const place of component) {
          this.#cut.set(place, cut);
          depth.set(place, cut);
        }
      } else for (const place of component) depth.set(place, longest.get(place)!);
    }
  }

  /** The cut depth of a place in a growing component; `null` for any other place, which is never cut. */
  public cutDepth(place: PlaceId): number | null {
    return this.#cut.get(place) ?? null;
  }
}

/** The graph's edges by receiver (`NestingIndex`), each route charged as it is read. */
function edgesOf(
  program: CoreProgram,
  definitions: DefinitionIndex,
  live: (d: Definition) => boolean,
): Map<PlaceId, Edge[]> {
  const work = program.work;
  const into = new Map<PlaceId, Edge[]>();
  const add = (receiver: PlaceId, producer: PlaceId, weight: number): void => {
    // a written type decides its place: no route into it counts
    if (writtenAt(program, receiver) !== null) return;
    const list = into.get(receiver);
    if (list === undefined) into.set(receiver, [{ producer, weight }]);
    else list.push({ producer, weight });
  };
  const store = (d: Definition): void => {
    work.charge("indexSteps");
    if (d.value === undefined || (d.kind !== "whole" && d.kind !== "add")) return;
    if (!program.live(d.node) || !live(d)) return;
    // (a store through a property moves the value off the element levels: no route the graph names)
    if (d.path.some((step) => step !== "element")) return;
    const added = d.kind === "add" ? (d.how === "elements" ? 0 : 1) : 0;
    add(d.place, d.value, d.path.length + added);
  };
  for (const list of definitions.byKey.values()) for (const d of list) store(d);
  for (const list of definitions.cellDefs.values()) for (const d of list) store(d);
  for (const [cell, owner] of program.cellOwner) {
    work.charge("indexSteps");
    if (owner.kind === "cell") add(owner.owner, cell, 1);
  }
  for (const constraint of program.constraints) {
    work.charge("indexSteps");
    switch (constraint.kind) {
      case "read":
        add(constraint.occurrence, constraint.binding, 0);
        break;
      case "project":
        if (
          typeof constraint.step === "string"
            ? ELEMENT_STEPS.has(constraint.step)
            : selectsElement(constraint.step.property)
        )
          add(constraint.into, constraint.owner, -1);
        break;
      case "call":
        add(constraint.result, program.functionOf(constraint.fn).result, 0);
        break;
      case "fallback":
        add(constraint.result, constraint.left, 0);
        add(constraint.result, constraint.right, 0);
        break;
      case "get":
        add(constraint.result, constraint.receiver, -1);
        add(constraint.result, constraint.fallback, 0);
        break;
      case "operation":
        if (constraint.contract.family === "operator" && constraint.contract.name === "+")
          for (const operand of constraint.arguments) add(constraint.result, operand, 0);
        break;
      default:
        break;
    }
  }
  return into;
}

/**
 * The strongly connected components of the graph, producers first: each one after every component its members read
 * (Tarjan's order along receiver-to-producer edges), iteratively, each node and edge charged once.
 */
function components(
  program: CoreProgram,
  into: ReadonlyMap<PlaceId, readonly Edge[]>,
): PlaceId[][] {
  const work = program.work;
  const index = new Map<PlaceId, number>();
  const low = new Map<PlaceId, number>();
  const onStack = new Set<PlaceId>();
  const stack: PlaceId[] = [];
  const out: PlaceId[][] = [];
  let counter = 0;
  for (const root of into.keys()) {
    if (index.has(root)) continue;
    const frames: { readonly place: PlaceId; next: number }[] = [{ place: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const edges = into.get(frame.place) ?? [];
      if (frame.next < edges.length) {
        work.charge("indexSteps");
        const producer = edges[frame.next++]!.producer;
        if (!index.has(producer)) {
          index.set(producer, counter);
          low.set(producer, counter++);
          stack.push(producer);
          onStack.add(producer);
          frames.push({ place: producer, next: 0 });
        } else if (onStack.has(producer))
          low.set(frame.place, Math.min(low.get(frame.place)!, index.get(producer)!));
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent !== undefined)
        low.set(parent.place, Math.min(low.get(parent.place)!, low.get(frame.place)!));
      if (low.get(frame.place) !== index.get(frame.place)) continue;
      const component: PlaceId[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === frame.place) break;
      }
      out.push(component);
    }
  }
  return out;
}

/**
 * The deepest element level each member of a closed component reaches from its entries, along the component's own
 * edges (`NOTHING` where it holds no kind); `null` where some member passes `bound`, which only a cycle of positive weight can make
 * happen: a simple path gains at most the component's +1 edges, and `bound` is the deepest entry plus them. Each
 * member rises at most `bound + 1` times, each rise's edges charged.
 */
function longestWithin(
  program: CoreProgram,
  into: ReadonlyMap<PlaceId, readonly Edge[]>,
  members: ReadonlySet<PlaceId>,
  entry: ReadonlyMap<PlaceId, number>,
  bound: number,
): Map<PlaceId, number> | null {
  const work = program.work;
  // the component's edges from each producer to its receivers
  const readers = new Map<PlaceId, { readonly receiver: PlaceId; readonly weight: number }[]>();
  for (const receiver of members)
    for (const edge of into.get(receiver) ?? []) {
      if (!members.has(edge.producer)) continue;
      work.charge("indexSteps");
      const list = readers.get(edge.producer);
      if (list === undefined) readers.set(edge.producer, [{ receiver, weight: edge.weight }]);
      else list.push({ receiver, weight: edge.weight });
    }
  const level = new Map(entry);
  const pending = [...members];
  const queued = new Set(pending);
  while (pending.length > 0) {
    const producer = pending.pop()!;
    queued.delete(producer);
    const from = level.get(producer)!;
    for (const { receiver, weight } of readers.get(producer) ?? []) {
      work.charge("indexSteps");
      const reached = reach(from, weight);
      if (reached <= level.get(receiver)!) continue;
      if (reached > bound) return null;
      level.set(receiver, reached);
      if (!queued.has(receiver)) {
        queued.add(receiver);
        pending.push(receiver);
      }
    }
  }
  return level;
}
