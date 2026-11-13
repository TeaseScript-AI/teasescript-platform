// #1784: a holder's marks compiled once per pass into one shared automaton of path prefixes, and the residual states a
// path leaves in it.

import { joinSteps, splitPath } from "../budget.js";
import type { Contract } from "../contract.js";
import { keyOf, recordPath, sortCost } from "../definitions.js";
import { stepName } from "../program.js";
import { stepsOf } from "./literal-index.js";
import type { Holder } from "./model.js";
import { Retained, retainedModule } from "../retained/retained.js";

/**
 * #1784 (Sol's design D, the lead's ruling on Astra r1 B1): a holder's marks as a language of path prefixes, compiled
 * once per pass into one shared automaton: a marking prefix `w` stands for every path below it. Its local prefixes are
 * its guarded literal paths and the tested paths below each of its own reads whose regions hold the read
 * (`guardedBelow`); a reference at `where` to `J` seen from `shift` attaches, at `where`, the states `J`'s automaton
 * reaches past `shift` (an accepting one marks `where` itself). A pending mark is then one of these states, never a
 * holder and the steps taken: the states a path reaches mark it where one accepts, and none left marks nothing. For a
 * holder of finite depth, the states a path `p` leaves accept a further `t` iff `marksAt(holder, p.t)`.
 */
interface MarkState {
  readonly next: Map<string, number>;
  readonly epsilon: number[];
  accepting: boolean;
}

/** The states a path reaches: marked where one accepts; else those with a step further (sorted ids). */
export interface MarkResidual {
  readonly marked: boolean;
  readonly states: readonly number[];
}

/** A pass's mark automaton (per contract): its states, each holder's root, and its walks once per state and step. */
interface MarkAutomaton {
  readonly states: MarkState[];
  readonly roots: Map<Holder, number>;
  readonly starts: Map<Holder, Map<number, MarkResidual>>;
  readonly moves: Map<number, Map<string, MarkResidual>>;
  /** The guarded prefixes the holders' compilations visited (Astra r2 B3's growth test). */
  prefixVisits: number;
}

const AUTOMATA = retainedModule<Contract, MarkAutomaton>("marks.AUTOMATA", "weakMap");

const MARKED: MarkResidual = { marked: true, states: [] };
const NONE: MarkResidual = { marked: false, states: [] };

function automatonOf(contract: Contract): MarkAutomaton {
  let known = AUTOMATA().get(contract);
  if (known === undefined)
    AUTOMATA().set(
      contract,
      (known = Retained.record<MarkAutomaton>("MarkAutomaton", {
        states: Retained.arena("MarkAutomaton.states"),
        roots: Retained.map("MarkAutomaton.roots"),
        starts: Retained.map("MarkAutomaton.starts"),
        moves: Retained.map("MarkAutomaton.moves"),
        prefixVisits: 0,
      })),
    );
  return known;
}

/** Test-only: the states of a pass's mark automaton (Sol's R), `0` where none was compiled. */
export function markStates(contract: Contract): number {
  return AUTOMATA().get(contract)?.states.length ?? 0;
}

function newState(contract: Contract, automaton: MarkAutomaton): number {
  contract.pass.program.work.charge("eventSteps");
  contract.keep(3);
  automaton.states.push(
    Retained.record<MarkState>("MarkState", {
      next: Retained.map("MarkState.next"),
      epsilon: Retained.array("MarkState.epsilon"),
      accepting: false,
    }),
  );
  return automaton.states.length - 1;
}

/** The state at `steps` below `from`, made where none is (a prefix trie). */
function stateAt(
  contract: Contract,
  automaton: MarkAutomaton,
  from: number,
  steps: readonly string[],
): number {
  let at = from;
  for (const step of steps) {
    contract.pass.program.work.charge("eventSteps");
    let to = automaton.states[at]!.next.get(step);
    if (to === undefined) {
      to = newState(contract, automaton);
      contract.keepText(step.length);
      automaton.states[at]!.next.set(step, to);
    }
    at = to;
  }
  return at;
}

/** The states `from` reaches through epsilon edges: marked where one accepts, else those with a step further. */
function closure(
  contract: Contract,
  automaton: MarkAutomaton,
  from: readonly number[],
): MarkResidual {
  const { work } = contract.pass.program;
  const seen = new Set<number>();
  const live: number[] = [];
  const open = [...from];
  work.charge("eventSteps", 1 + from.length);
  while (open.length > 0) {
    const id = open.pop()!;
    work.charge("eventSteps");
    if (seen.has(id)) continue;
    seen.add(id);
    const state = automaton.states[id]!;
    if (state.accepting) return MARKED;
    if (state.next.size > 0) live.push(id);
    for (const to of state.epsilon) open.push(to);
  }
  work.charge("eventSteps", sortCost(live.length));
  return live.length === 0 ? NONE : { marked: false, states: live.sort((a, b) => a - b) };
}

/** The states a set of states reaches one step further (each state's step once per pass). */
export function markStep(contract: Contract, from: readonly number[], asked: string): MarkResidual {
  const automaton = automatonOf(contract);
  const { work } = contract.pass.program;
  // (a choice's selection step as the record key it reads, as `marksAt` asks it)
  const step = recordPath([asked])[0]!;
  const into = new Set<number>();
  for (const id of from) {
    work.charge("eventSteps");
    let bySteps = automaton.moves.get(id);
    let moved = bySteps?.get(step);
    if (moved === undefined) {
      const to = automaton.states[id]!.next.get(step);
      moved = to === undefined ? NONE : closure(contract, automaton, [to]);
      if (bySteps === undefined)
        automaton.moves.set(id, (bySteps = Retained.map("MarkAutomaton.moves[]")));
      contract.keep(2 + moved.states.length);
      bySteps.set(step, moved);
    }
    if (moved.marked) return MARKED;
    for (const state of moved.states) into.add(state);
  }
  if (into.size === 0) return NONE;
  work.charge("eventSteps", sortCost(into.size));
  return { marked: false, states: [...into].sort((a, b) => a - b) };
}

/** The states `steps` below a state reach (`closure`, then `markStep` per step), stopping once marked or none. */
function walk(
  contract: Contract,
  automaton: MarkAutomaton,
  from: number,
  steps: readonly string[],
): MarkResidual {
  let at = closure(contract, automaton, [from]);
  for (const step of steps) {
    if (at.marked || at.states.length === 0) break;
    at = markStep(contract, at.states, step);
  }
  return at;
}

/**
 * The states a holder's mark is pending at, `path` (an arena id) below its entry: its automaton's root walked by the
 * path, once per holder and path. Its depth is finite (the caller declines `marks-depth` first).
 */
export function markStart(contract: Contract, holder: Holder, path: number): MarkResidual {
  const automaton = automatonOf(contract);
  contract.pass.program.work.charge("eventSteps");
  let byPath = automaton.starts.get(holder);
  const known = byPath?.get(path);
  if (known !== undefined) return known;
  const root = compiled(contract, automaton, holder);
  const steps = recordPath(stepsOf(contract, path));
  contract.pass.program.work.charge("eventSteps", 1 + steps.length);
  const residual = walk(contract, automaton, root, steps);
  if (byPath === undefined)
    automaton.starts.set(holder, (byPath = Retained.map("MarkAutomaton.starts[]")));
  contract.keep(2 + residual.states.length);
  byPath.set(path, residual);
  return residual;
}

/**
 * A holder's root state, compiled with every holder it refers to first (a finite holder's references reach no cycle:
 * `depthOf` is infinite on one), on an explicit stack.
 */
function compiled(contract: Contract, automaton: MarkAutomaton, holder: Holder): number {
  const known = automaton.roots.get(holder);
  if (known !== undefined) return known;
  const { work } = contract.pass.program;
  const open: Holder[] = [holder];
  const opened = new Set<Holder>();
  while (open.length > 0) {
    const top = open.at(-1)!;
    work.charge("eventSteps");
    if (automaton.roots.has(top)) {
      open.pop();
      continue;
    }
    const waiting = [...top.refsAt.values()]
      .flat()
      .map((reference) => reference.to)
      .filter((to) => !automaton.roots.has(to));
    if (waiting.length > 0 && !opened.has(top)) {
      opened.add(top);
      for (const to of waiting) open.push(to);
      continue;
    }
    open.pop();
    automaton.roots.set(top, compile(contract, automaton, top));
  }
  return automaton.roots.get(holder)!;
}

/** A holder's own automaton, the holders it refers to compiled. */
function compile(contract: Contract, automaton: MarkAutomaton, holder: Holder): number {
  const { program, guards } = contract.pass;
  const root = newState(contract, automaton);
  // its guarded literal paths
  for (const at of holder.guarded) {
    program.work.charge("eventSteps");
    automaton.states[stateAt(contract, automaton, root, stepsOf(contract, at))]!.accepting = true;
  }
  // its own reads: each tested path below a read's key whose region holds the read (`readsAt`'s hit), the paths of
  // reads `guardedBelow` answers alike asked once (Astra r2 B3: n copies under n tests visit n paths, not n²)
  const asked = new Set<string>();
  // (#2005: a prefix several groups' reads reach makes its states once; each candidate is still charged)
  const inserted = new Set<string>();
  for (const read of holder.reads) {
    program.work.charge("eventSteps");
    let current = read.value;
    const steps: string[] = [];
    for (let projection = program.projOf.get(current); projection !== undefined;) {
      program.work.charge("eventSteps");
      steps.push(projection.step === "iteration" ? "element" : stepName(projection.step));
      current = projection.owner;
      projection = program.projOf.get(current);
    }
    const binding = program.occurrenceOf.get(current);
    const node = program.occNode.get(current);
    if (binding === undefined || node === undefined || node === null) continue;
    const base = keyOf(binding, joinSteps(steps.reverse(), read.path));
    for (const text of guards.guardedBelowOnce(base, node, asked) ?? []) {
      program.work.charge("eventSteps");
      automaton.prefixVisits += 1;
      if (inserted.has(text)) continue;
      inserted.add(text);
      program.work.charge("eventSteps", text.length);
      automaton.states[stateAt(contract, automaton, root, splitPath(text))]!.accepting = true;
    }
  }
  // its references: the states each referred holder reaches past its shift, at the site
  for (const [where, references] of holder.refsAt) {
    const site = stateAt(contract, automaton, root, stepsOf(contract, where));
    for (const reference of references) {
      program.work.charge("eventSteps");
      const residual = walk(
        contract,
        automaton,
        automaton.roots.get(reference.to)!,
        reference.shift,
      );
      if (residual.marked) automaton.states[site]!.accepting = true;
      else {
        contract.keep(residual.states.length);
        automaton.states[site]!.epsilon.push(...residual.states);
      }
    }
  }
  return root;
}

/** Test-only: the guarded prefixes a pass's holder compilations visited (Astra r2 B3). */
export function markPrefixVisits(contract: Contract): number {
  return AUTOMATA().get(contract)?.prefixVisits ?? 0;
}

/** Test-only: the holders a pass's mark automaton compiled. */
export function markHolders(contract: Contract): readonly Holder[] {
  return [...(AUTOMATA().get(contract)?.roots.keys() ?? [])];
}

/** Test-only: the states `steps` below a holder's root leave (`walk`): marked, or those pending. */
export function markResidual(
  contract: Contract,
  holder: Holder,
  steps: readonly string[],
): MarkResidual {
  const automaton = automatonOf(contract);
  return walk(contract, automaton, compiled(contract, automaton, holder), recordPath(steps));
}

/**
 * Test-only: whether a holder's automaton answers `marksAt` at `steps` (the states the steps reach accepting), for the
 * truth checks over real holders (`marksAt` itself unchanged).
 */
export function markAccepts(contract: Contract, holder: Holder, steps: readonly string[]): boolean {
  const automaton = automatonOf(contract);
  return walk(contract, automaton, compiled(contract, automaton, holder), recordPath(steps)).marked;
}

/** #2005: a compiled state of the pass's mark automaton, read only: its steps, its epsilon edges and its acceptance. */
export function markState(
  contract: Contract,
  id: number,
): {
  readonly next: ReadonlyMap<string, number>;
  readonly epsilon: readonly number[];
  readonly accepting: boolean;
} {
  return automatonOf(contract).states[id]!;
}

/** #2005: whether a holder's mark holds at its own root, the empty rest (its automaton compiled). */
export function rootAccepts(contract: Contract, holder: Holder): boolean {
  const automaton = automatonOf(contract);
  return automaton.states[compiled(contract, automaton, holder)]!.accepting;
}
