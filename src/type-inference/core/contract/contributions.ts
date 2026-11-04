import { keep, type WorkLedger } from "../budget.js";

/*
 * #1668: which slots' answers each settled slot's answer includes (its contribution provenance), recorded where its
 * final selected run includes them and published with its answer, only in a pass that asks for it (`withContributions`).
 * A slot's flow is local: the slots it included, each by its demand key, never their own flows, so a key's edges to the
 * keys it includes are found by following included slots that are not contract slots (`edges`). An included read whose
 * route records no flow of its own (`opaque`) makes every edge set through it unavailable, never empty. Recording is
 * passive: nothing running reads it, so answers, demands and stops are the pass's whether it records or not; its
 * work is charged as shared work (`WorkLedger.shared`), to the analysis's total and to no demand's allowance.
 */

/** How an inclusion's answer was put into the including slot's: the existing transform applied before it was pushed. */
export type Qualifier =
  | "writer"
  | "annotated"
  | "marked"
  | "called"
  | "entered"
  | "groupFirst"
  | "withoutEmpty"
  | "belowReceiver"
  | "defaultChoice"
  | "summary"
  | "positioned"
  | "selected"
  | "operandFilter"
  | "default"
  | "unknown";

/** One slot's answer included in a run's: its demand key, `null` for a route that records no flow (`opaque`). */
export interface Inclusion {
  readonly slot: string | null;
  /** The route it came through (`entry`, `sub`, `value`, `literal`, `position`, `summary`, `stopped`). */
  readonly route: string;
  readonly qualifiers: readonly Qualifier[];
}

let recording = false;

/**
 * Runs `callback` with every solver made inside it recording contribution provenance (test-only today; #1646's
 * admitted builder will ask for it per pass). Every other pass records nothing and charges nothing for it.
 */
export function withContributions<T>(callback: () => T): T {
  if (recording) throw new Error("Contributions are already recorded.");
  recording = true;
  try {
    return callback();
  } finally {
    recording = false;
  }
}

/** Whether a solver made now records contribution provenance (`withContributions`). */
export function contributionsAsked(): boolean {
  return recording;
}

/** Test-only: what `withFlowCheck` hears of each published flow: its slot, its inclusions and the slots its run read. */
export type FlowCheck = (
  slot: string,
  inclusions: readonly Inclusion[],
  reads: ReadonlySet<string>,
) => void;

let flowCheck: FlowCheck | null = null;

/** Test-only: runs `callback` with every published flow given to `onPublish` beside the slots its run read. */
export function withFlowCheck<T>(onPublish: FlowCheck, callback: () => T): T {
  if (flowCheck !== null) throw new Error("Flows are already checked.");
  flowCheck = onPublish;
  try {
    return callback();
  } finally {
    flowCheck = null;
  }
}

/** The check `withFlowCheck` runs, or `null`. */
export function activeFlowCheck(): FlowCheck | null {
  return flowCheck;
}

/**
 * A run's inclusions as its code makes them (a frame's, or a branch's staged in a child until its caller keeps or
 * discards them, `child`, `attach`): each one retained slot, charged as shared work as it is made, kept or not.
 */
export class FlowSink {
  readonly #work: WorkLedger;
  readonly inclusions: Inclusion[] = [];
  /** Whether its run's code took it (`Solver.sink`): only such a run's flow is published, any other is unavailable. */
  rooted = false;
  /** Test-only (`withFlowCheck`): the slots its run read, every yield of a demand. */
  readonly reads: Set<string> | null = activeFlowCheck() === null ? null : new Set();

  public constructor(work: WorkLedger) {
    this.#work = work;
  }

  /** The answer of the slot `slot` (a demand key) included, through `route`. */
  public include(slot: string, route: string): void {
    this.#push({ slot, route, qualifiers: [] });
  }

  /** An answer included through a route that records no flow: every edge set through this run is unavailable. */
  public opaque(route: string): void {
    this.#push({ slot: null, route, qualifiers: [] });
  }

  /** A branch's staging: inclusions its caller keeps (`attach`) where it includes the branch's answer, else drops. */
  public child(): FlowSink {
    return new FlowSink(this.#work);
  }

  /** A child's inclusions kept, each under `qualifiers` (outermost first), each one charged as it is copied. */
  public attach(child: FlowSink, ...qualifiers: Qualifier[]): void {
    this.attachAll(child.inclusions, ...qualifiers);
  }

  /** Inclusions kept as `attach` keeps a child's: an answer kept elsewhere with the inclusions it was made of. */
  public attachAll(inclusions: readonly Inclusion[], ...qualifiers: Qualifier[]): void {
    for (const inclusion of inclusions)
      this.#push(
        qualifiers.length === 0
          ? inclusion
          : { ...inclusion, qualifiers: [...qualifiers, ...inclusion.qualifiers] },
      );
  }

  #push(inclusion: Inclusion): void {
    const work = this.#work;
    work.shared(() => keep(work, 1 + inclusion.qualifiers.length));
    this.inclusions.push(inclusion);
  }
}

/** A key's contribution edges in a settled pass, or why there are none to read. */
export type Contributions =
  | { readonly state: "complete"; readonly edges: readonly Inclusion[] }
  | { readonly state: "unavailable"; readonly reason: string };

/**
 * The contract slots a slot's answer includes, through the non-contract slots it includes (each by its own published
 * flow), from the published flows `flowOf` gives: `unavailable` where a slot on the way has none (unfinished, stopped,
 * forgotten or not recorded) or an included route recorded none (`opaque`). A contract slot reached ends that branch:
 * its own edges are its own (`edges` of it). Each slot visited, each inclusion followed and each edge's qualifiers
 * are charged to the analysis's total.
 */
export function edgesOf(
  start: string,
  flowOf: (slot: string) => readonly Inclusion[] | undefined,
  work: WorkLedger,
): Contributions {
  const out: Inclusion[] = [];
  // (a path's qualifiers as interned links, each to the list before it: a step adds only its inclusion's own, so a
  // deep path is never copied per step, and equal lists are one link. A slot reached under other qualifiers is
  // followed again under them: bounded by the qualifier lists the code makes)
  const links: { readonly before: number; readonly qualifier: Qualifier }[] = [];
  const linkOf = new Map<string, number>();
  const extended = (before: number, qualifiers: readonly Qualifier[]): number => {
    let at = before;
    for (const qualifier of qualifiers) {
      const name = `${at} ${qualifier}`;
      let next = linkOf.get(name);
      if (next === undefined) {
        next = links.length;
        links.push({ before: at, qualifier });
        linkOf.set(name, next);
      }
      at = next;
    }
    return at;
  };
  const listOf = (at: number): Qualifier[] => {
    const list: Qualifier[] = [];
    for (let link = at; link >= 0; link = links[link]!.before) list.push(links[link]!.qualifier);
    return list.reverse();
  };
  const seen = new Set<string>([`${start}\u0000-1`]);
  const todo: { readonly slot: string; readonly qualifiers: number }[] = [
    { slot: start, qualifiers: -1 },
  ];
  for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
    work.shared(() => work.charge("structureSteps"));
    const flow = flowOf(next.slot);
    if (flow === undefined) return { state: "unavailable", reason: `no flow for ${next.slot}` };
    for (const inclusion of flow) {
      if (inclusion.slot === null)
        return { state: "unavailable", reason: `${inclusion.route} records no flow` };
      // (each inclusion followed charged with the links it adds, an edge with the qualifier list it keeps)
      work.shared(() => keep(work, 1 + inclusion.qualifiers.length));
      const qualifiers = extended(next.qualifiers, inclusion.qualifiers);
      if (inclusion.slot.startsWith("c|")) {
        const list = listOf(qualifiers);
        work.shared(() => keep(work, list.length));
        out.push({ ...inclusion, qualifiers: list });
        continue;
      }
      const visit = `${inclusion.slot}\u0000${qualifiers}`;
      if (seen.has(visit)) continue;
      seen.add(visit);
      todo.push({ slot: inclusion.slot, qualifiers });
    }
  }
  return { state: "complete", edges: out };
}
