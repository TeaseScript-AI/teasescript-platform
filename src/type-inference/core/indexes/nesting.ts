import type { PlaceId, TypeTerm } from "../../graph.js";
import type { WorkLedger } from "../budget.js";
import type { Operand } from "../carriers.js";
import type { Definition, DefinitionIndex } from "../definitions.js";
import { makeItem, REASON, type Item } from "../items.js";
import type { CoreProgram } from "../program.js";
import { Retained } from "../retained/retained.js";
import {
  closed,
  components,
  longestWithin,
  NOTHING,
  reach,
  type Edge,
} from "./nesting/components.js";
import { routesOf, writtenAt, type Route } from "./nesting/routes.js";

/**
 * The cut's answer (#2764): a value known only when the script runs (ADR 0021 rule 1.7), at every step below a
 * growing component's cut depth.
 */
export const CUT: readonly Item[] = Object.freeze([
  makeItem("unknown", null, { reasons: REASON.opaque, context: "unmodelled", cert: "pos" }),
]);

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

/**
 * Where a key's path lies in the nesting graph: the property it passes (`""` for none) and its element steps; `null` for
 * a path through two properties or more, which the graph does not follow by name and so never cuts.
 */
export function pathPosition(
  path: readonly string[],
): { readonly label: string; readonly depth: number } | null {
  let label = "";
  let depth = 0;
  for (const step of path)
    if (step === "element") depth += 1;
    else if (label === "") label = step;
    else return null;
  return { label, depth };
}

/**
 * Each component of a graph in its order, producers first, with the deepest element level each member reaches:
 * `base`, what reaches it from earlier components, and its own edges; a component that holds a cycle of positive weight
 * has the depth `growing` gives it, from what enters it and the gains on its edges.
 */
function layered<N>(
  work: WorkLedger,
  into: ReadonlyMap<N, readonly Edge<N>[]>,
  base: (node: N) => number,
  growing: (
    component: readonly N[],
    entering: number,
    gain: number,
    depth: ReadonlyMap<N, number>,
  ) => number,
): Map<N, number> {
  const depth = new Map<N, number>();
  for (const component of components(work, into)) {
    const members = new Set(component);
    const entry = new Map<N, number>();
    let entering = NOTHING;
    // (every gain inside: a simple path gains at most their sum, the bound of the positive-cycle test)
    let gain = 0;
    for (const node of component) {
      let at = base(node);
      for (const edge of into.get(node) ?? []) {
        work.charge("indexSteps");
        if (members.has(edge.producer)) gain += Math.max(0, edge.weight);
        else at = Math.max(at, reach(depth.get(edge.producer) ?? NOTHING, edge.weight));
      }
      entry.set(node, at);
      entering = Math.max(entering, at);
    }
    const longest = closed(component, into)
      ? longestWithin(work, into, members, entry, Math.max(entering, 0) + gain)
      : entry;
    if (longest === null) {
      const at = growing(component, entering, gain, depth);
      for (const node of component) depth.set(node, at);
    } else for (const node of component) depth.set(node, longest.get(node)!);
  }
  return depth;
}

/**
 * The nesting graph of one pass and its cut depths (#2764). Its nodes are the program's places,
 * its edges the routes (`routesOf`) from a receiver to a producer, weighted by the element levels the producer's value
 * gains in the receiver.
 *
 * A strongly connected component that holds a cycle of positive weight grows without end under F20 and F21. It is
 * followed one level deeper than what enters it, `M + 1`: `M` the deepest element level that enters it from outside (a
 * literal's structure, a written type's levels, an earlier component's depth); deeper, a value is known only when the
 * script runs. A cycle that gains more than one level a turn (`a = [[a]]`) turns unknown within its first turn.
 * Components are taken producers first, so `M` is finite. The cut depends on the graph alone, never on the order
 * anything is asked in (r4-44).
 *
 * Property routes are followed by name: a component that grows with every property alike is solved again with one
 * position per place and property its routes name, and only a cycle that grows there is cut, so a value put under one
 * property and read from another closes none. A route through two properties or more has no position, so no cycle
 * through it is cut; an `M` taken over every route, names ignored, never puts a cut above a level known without it.
 */
export class NestingIndex {
  /** Each position (`place|property`) of a growing component, with its cut depth. */
  readonly #cut = Retained.map<string, number>("NestingIndex.#cut");
  /** The places with a position cut: only their paths are looked at (`cuts`). */
  readonly #places = Retained.set<PlaceId>("NestingIndex.#places");

  /**
   * `live` says which of the pass's definitions take effect (A6); `operands` is the carrier table, given so that this
   * index does not depend on the contract the table reads.
   */
  public constructor(
    program: CoreProgram,
    definitions: DefinitionIndex,
    live: (d: Definition) => boolean,
    operands: (value: PlaceId) => readonly Operand[],
  ) {
    Retained.owner(this, "NestingIndex", (index) => ({ cut: index.#cut, places: index.#places }));
    const work = program.work;
    const routes = routesOf(program, definitions, live, operands);
    const graph = new Map<PlaceId, Edge<PlaceId>[]>();
    for (const [receiver, list] of routes)
      graph.set(
        receiver,
        list.map((route) => ({ producer: route.producer, weight: route.weight })),
      );
    layered(
      work,
      graph,
      (place) => {
        const written = writtenAt(program, place);
        return written !== null ? writtenDepth(written) : ownDepth(program, place);
      },
      (component, entering, gain, depth) => {
        // (a bound on every member's known levels, names ignored: what reads the component takes it)
        const bound = Math.max(entering, 0) + gain;
        this.#byName(program, routes, component, depth, Math.max(entering, 0), bound);
        return bound;
      },
    );
  }

  /**
   * A component that grows with every property alike (`members`, `entering` what enters it, names ignored), solved
   * again with one position per place and property its routes name; each position of a cycle that grows there is cut
   * one level below what enters it. `bound` is the deepest level any member reaches, names ignored.
   */
  #byName(
    program: CoreProgram,
    routes: ReadonlyMap<PlaceId, readonly Route[]>,
    members: readonly PlaceId[],
    depth: ReadonlyMap<PlaceId, number>,
    entering: number,
    bound: number,
  ): void {
    const work = program.work;
    const inside = new Set(members);
    const labels = new Set<string>([""]);
    for (const receiver of members)
      for (const route of routes.get(receiver) ?? [])
        if (route.kind === "property" && inside.has(route.producer)) {
          labels.add(route.from);
          labels.add(route.to);
        }
    const position = (place: PlaceId, label: string): string => `${place}|${label}`;
    const graph = new Map<string, Edge<string>[]>();
    const entry = new Map<string, number>();
    const edge = (receiver: string, producer: string, weight: number): void => {
      const list = graph.get(receiver);
      if (list === undefined) graph.set(receiver, [{ producer, weight }]);
      else list.push({ producer, weight });
    };
    const enter = (at: string, level: number): void => {
      entry.set(at, Math.max(entry.get(at) ?? NOTHING, level));
    };
    for (const receiver of members) {
      const written = writtenAt(program, receiver);
      enter(
        position(receiver, ""),
        written !== null ? writtenDepth(written) : ownDepth(program, receiver),
      );
      for (const route of routes.get(receiver) ?? []) {
        work.charge("indexSteps");
        const from = inside.has(route.producer)
          ? null
          : reach(depth.get(route.producer) ?? NOTHING, route.weight);
        if (route.kind === "plain")
          for (const label of labels)
            if (from === null)
              edge(position(receiver, label), position(route.producer, label), route.weight);
            else enter(position(receiver, label), from);
        else if (route.kind === "property")
          if (from === null)
            edge(position(receiver, route.to), position(route.producer, route.from), route.weight);
          else enter(position(receiver, route.to), from);
        // a loose route has no position: what it brings may reach any of the receiver's, at most `bound` inside
        else for (const label of labels) enter(position(receiver, label), from ?? bound);
      }
    }
    for (const at of entry.keys()) if (!graph.has(at)) graph.set(at, []);
    layered(
      work,
      graph,
      (at) => entry.get(at) ?? NOTHING,
      (component, inner) => {
        const cut = Math.max(inner, entering, 0) + 1;
        for (const at of component) {
          this.#cut.set(at, cut);
          this.#places.add(Number(at.slice(0, at.indexOf("|"))));
        }
        return cut;
      },
    );
  }

  /** Whether some position of `place` is cut: else none of its paths is. */
  public cuts(place: PlaceId): boolean {
    return this.#places.has(place);
  }

  /**
   * The cut depth of a place's position, at a property (`label`, `""` for none: `pathPosition`) in a growing component;
   * `null` for any other, which is never cut.
   */
  public cutDepth(place: PlaceId, label = ""): number | null {
    return this.#cut.get(`${place}|${label}`) ?? null;
  }
}
