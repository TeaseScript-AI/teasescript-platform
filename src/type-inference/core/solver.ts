import {
  checkReadDepth,
  countApart,
  DemandExhausted,
  joinParts,
  keep,
  keepText,
  READ_DEPTH_LIMIT,
  type WorkLedger,
} from "./budget.js";
import { itemsSignature, STOPPED, type IngressCell, type Item, type ItemScope } from "./items.js";

/*
 * The demand solver of the coarse core (checkpoint 9, TABLE §8; the port plan's S3 note §1). A demand is one answer the
 * analysis needs (a key's contract, the value at a definition, a value at a node); what it reads is discovered while
 * it runs, as other demands it yields. Demands run on an explicit frame stack, never the native one, and Tarjan's
 * algorithm finds the strongly connected components among them as they run: a demand that reads an unfinished one
 * closes a cycle. A demand outside every component reads only finished answers and is computed once. A component is
 * solved canonically: every member starts again from bottom (no items, no recorded reads, fresh ingress cells) and the
 * members run in a total order derived from the source (file, offset, demand kind, key), a member again only when a
 * member it read changed, until no member's `itemsSignature` changes. When a member's run reads a demand that belongs
 * to the component through others (expansion), the enlarged component starts again from bottom; when it reads an
 * unfinished demand outside the component, the component is part of a larger one and is solved with it. A component
 * being solved stays on the explicit stack too: its members' runs are frames above it, and a component one of them
 * closes is solved above that. So an answer depends on the final member set, never on the order the demands were
 * discovered in; the tests check that property (the component test re-solves every component from each member and in
 * the reverse order).
 *
 * That needs answers monotone in what they read. A choice that is not (a `Decision`: F18/F19's default without kinds
 * gives `unknown`; F19a's receiver that holds a reference kind has opaque members) is made on a completed input: at
 * once outside every component; inside one, the component is solved first with every choice open and, where a choice
 * then changes an answer, again from bottom with the choices held (r4.40, r4.44).
 *
 * A demand may prove more than its items (a `ProofDemand`, TABLE r4.164's proof payload): what a fold selected, where a
 * prefix's walk stands. Its proof is the solver's as its items are: provisional while its run or component is
 * unfinished, reset with them to none (`null`) at each start from bottom, compared by its semantic signature where its
 * items are (a changed proof under unchanged items reruns its readers; a new object or run with the same signature does
 * not), chosen on as they are (a `ProofDecision`, whose held choice may change the proof alone), and kept with them,
 * its slot charged before either is published. A stop forgets the unfinished proofs with the unfinished demands, and a
 * key's decision stopping the finished ones that read the key, with their answers (`forget`); a new pass has a new
 * solver, so nothing of an earlier pass's proofs is read (A6, S8's fresh finishing pass). A reader takes a proof only
 * through `proven`, which yields its demand.
 */

/** What a demand asks, which orders the members of one component at one site (S3 §1). */
export type DemandKind = "contract" | "exact" | "value";

const KIND_RANK: Readonly<Record<DemandKind, number>> = { contract: 0, exact: 1, value: 2 };

/** A choice a demand makes on what its run computes (its input) that is not monotone in it. */
export interface Decision {
  /** The choice on a completed input. */
  readonly choose: (input: readonly Item[]) => string;
  /** The answer under a choice, or an open one (`null`): monotone in the input either way. */
  readonly answer: (choice: string | null, input: readonly Item[]) => readonly Item[];
}

export interface Demand {
  /** The demand's identity: equal keys are one demand, computed once. */
  readonly key: string;
  readonly kind: DemandKind;
  /** Where it stands in the source: its file's index in project order and its offset; `-1` for no site. */
  readonly file: number;
  readonly offset: number;
  /** Computes its answer, or its decision's input. */
  readonly make: () => Work<readonly Item[]>;
  readonly decision?: Decision;
  readonly proves?: undefined;
}

/** What a proof demand proves beside its items (TABLE r4.164's proof payload). */
export interface Proof {
  /**
   * Its semantic signature: equal for two proofs no reader can tell apart (the same chosen sources, roles, absences and
   * provenance), whatever objects or run made them; its work charged as it is made (`itemsSignature`'s `sigItems`).
   */
  signature(scope: ItemScope): string;
}

/** A proof demand's run's result: its items and its proof. */
export interface Proven<P extends Proof> {
  readonly items: readonly Item[];
  readonly proof: P;
}

/** A proof demand's answer: its items and its proof, `null` for none (after a stop, an unfinished demand's). */
export interface ProvenAnswer<P extends Proof> {
  readonly items: readonly Item[];
  readonly proof: P | null;
}

/**
 * A proof demand's choice that is not monotone in what its run computes (`Decision`'s, on its items and proof alike): a
 * choice may change its answer's proof alone, its items unchanged, and is held as an item demand's is.
 */
export interface ProofDecision<P extends Proof> {
  /** The choice on a completed input. */
  choose(input: Proven<P>): string;
  /** The answer under a choice, or an open one (`null`): monotone in the input either way. */
  answer(choice: string | null, input: ProvenAnswer<P>): ProvenAnswer<P>;
}

/**
 * A demand that proves a proof beside its items: one demand, one lifecycle (TABLE r4.164's ruling (1)). Its proof holds
 * no ingress of its own: external data it carries is in its items, which a component's cells anchor (C9).
 */
export interface ProofDemand<P extends Proof> {
  readonly key: string;
  readonly kind: DemandKind;
  readonly file: number;
  readonly offset: number;
  readonly make: () => Work<Proven<P>>;
  readonly proves: true;
  readonly decision?: ProofDecision<P>;
}

/** A computation that yields the demands it reads and receives their items. */
export type Work<T> = Generator<Demand | ProofDemand<Proof>, T, readonly Item[]>;

/** An unfinished demand. */
interface DemandNode {
  readonly demand: Demand | ProofDemand<Proof>;
  readonly index: number;
  /** Its answer so far: provisional until its component is solved. */
  value: readonly Item[];
  /** A proof demand's proof so far, provisional as its answer is; `null` before its run returns. */
  proof: Proof | null;
  /** What its last run computed: its decision's input, a proof demand's with its proof. */
  input: readonly Item[];
  inputProof: Proof | null;
  /** Its decision's choice while its component is solved with the choices held; `null` while open. */
  choice: string | null;
  /** The component being solved that it is a member of. */
  component: Component | null;
}

interface Frame {
  /** The demand a first run computes, or `null` for a member's run again or a top-level computation. */
  readonly node: DemandNode | null;
  /** Its run: a demand's items, a proof demand's items and proof (`Proven`). */
  readonly work: Work<readonly Item[] | Proven<Proof>>;
  pending: readonly Item[] | undefined;
  readonly index: number;
  low: number;
  /** The Tarjan stack's length when it started. */
  readonly base: number;
  /** It read itself. */
  selfRead: boolean;
  /** The ledger's total when it started: the work it and the demands it was the first to compute cost. */
  readonly started: number;
  /** A member's run again: the solving that takes its result. */
  readonly rerun: Rerun | null;
  /** The read chain its generators are inside (`enterRead`): its native depth when it runs again. */
  readDepth: number;
}

interface Rerun {
  readonly solving: Solving;
  readonly member: DemandNode;
  /** The members of its component it has read. */
  readonly reads: Set<DemandNode>;
}

interface Component {
  readonly index: number;
  members: DemandNode[];
  low: number;
  /** The Tarjan stack's length while it is solved: a member's run that leaves demands above it found new members. */
  readonly base: number;
  readonly dependents: Map<DemandNode, Set<DemandNode>>;
  readonly reads: Map<DemandNode, Set<DemandNode>>;
  cells: Map<string, IngressCell>;
}

/** A component being solved: above the frame that reads the demand that closed it, below its members' runs. */
interface Solving {
  readonly component: Component;
  /** The first run that closed it. */
  readonly closing: Frame;
  /** The frame stack's length while no member runs. */
  readonly depth: number;
  /** The members in the order they run in, and each one's place in it. */
  members: DemandNode[];
  position: Map<DemandNode, number>;
  /** The places to run in this round, those that ran in it, and those for the next round. */
  now: PositionHeap;
  done: Set<number>;
  next: Set<number>;
  /** The members' choices are held: the second solve. */
  held: boolean;
}

/** A solved component's member: its key and its answer. */
export interface SolvedMember {
  readonly key: string;
  readonly items: readonly Item[];
}

/** The variations a test can ask of the solver (test-only). */
export interface SolverSeam {
  /** Solve every component's members in the reverse of the canonical order. */
  readonly reverseWorklist?: boolean;
  /**
   * Hears of every component solved: its members' keys in the order they were solved in, with their answers; and,
   * where a key holds a cursor, the names another pass replays them by and their packet (`exportNames`, #1422 B1).
   */
  readonly onComponent?: (
    members: readonly SolvedMember[],
    replay: { readonly names: readonly string[]; readonly packet: unknown } | null,
  ) => void;
}

let activeSeam: SolverSeam | null = null;

/** Test-only: runs `callback` with `seam` applied to every solver made inside it. */
export function withSolverSeam<T>(seam: SolverSeam, callback: () => T): T {
  if (activeSeam !== null) throw new Error("A solver seam is already active.");
  activeSeam = seam;
  try {
    return callback();
  } finally {
    activeSeam = null;
  }
}

/** The work one finished demand cost, the demands it was the first to compute included (S3 §5's counter). */
export interface DemandWork {
  readonly key: string;
  readonly units: number;
}

/**
 * The canonical order of two demands: their file, their offset, their kind, then their key, so that distinct demands
 * at one site still have one order. G3 stage 1: a key holding a cursor compares as the logical text it stands for
 * (`names`, the pass's: `compareDemandNames`), never by its ids (#1398).
 */
function canonical(
  a: Demand | ProofDemand<Proof>,
  b: Demand | ProofDemand<Proof>,
  names: ((a: string, b: string) => number) | null,
): number {
  return (
    a.file - b.file ||
    a.offset - b.offset ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    (names !== null ? names(a.key, b.key) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/** A binary heap of positions, the least first. */
class PositionHeap {
  readonly #items: number[] = [];

  public get size(): number {
    return this.#items.length;
  }

  public push(value: number): void {
    const items = this.#items;
    let at = items.length;
    items.push(value);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (items[parent]! <= value) break;
      items[at] = items[parent]!;
      at = parent;
    }
    items[at] = value;
  }

  public pop(): number {
    const items = this.#items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      let at = 0;
      for (;;) {
        const left = 2 * at + 1;
        if (left >= items.length) break;
        const right = left + 1;
        const child = right < items.length && items[right]! < items[left]! ? right : left;
        if (items[child]! >= last) break;
        items[at] = items[child]!;
        at = child;
      }
      items[at] = last;
    }
    return top;
  }
}

/** A run's result: its items, and a proof demand's proof (else `null`). */
/** The demand a frame runs, its first run or a member's run again; `null` for a top-level computation. */
function demandOf(frame: Frame | undefined): string | null {
  return frame?.node?.demand.key ?? frame?.rerun?.member.demand.key ?? null;
}

function resultOf(result: readonly Item[] | Proven<Proof>): {
  readonly items: readonly Item[];
  readonly proof: Proof | null;
} {
  return "items" in result ? result : { items: result, proof: null };
}

export class Solver {
  readonly #memo = new Map<string, readonly Item[]>();
  /** The finished proof demands' proofs, kept with their answers in `#memo`. */
  readonly #proofs = new Map<string, Proof>();
  /** Each demand's readers: the demands whose runs read it (`#read`), for `forget`. */
  readonly #readers = new Map<string, Set<string>>();
  readonly #active = new Map<string, DemandNode>();
  /** Tarjan's stack of unfinished demands outside the components being solved. */
  readonly #stack: DemandNode[] = [];
  readonly #frames: Frame[] = [];
  /** The components being solved, the innermost last. */
  readonly #solving: Solving[] = [];
  /** The member runs in progress, the innermost last. */
  readonly #reruns: Rerun[] = [];
  readonly #work: WorkLedger;
  readonly #scope: ItemScope;
  readonly #seam: SolverSeam | null = activeSeam;
  /** The order of demands' keys at one site and kind (`canonical`): the pass's, a cursor's by its logical text. */
  names: ((a: string, b: string) => number) | null = null;
  /** Test-only seam: a component's names as another pass replays them (`exportNames`). */
  replayOf:
    | ((
        names: readonly string[],
      ) => { readonly names: readonly string[]; readonly packet: unknown } | null)
    | null = null;
  readonly #units: DemandWork[] = [];
  #counter = 0;
  #running = false;
  /** The ledger's total past which the running demand stops (`demand`), or `null`. */
  #limit: number | null = null;
  /** The read chain the running frame's generators are inside: the levels of native calls a resumption runs through. */
  #readDepth = 0;

  public constructor(scope: ItemScope) {
    this.#scope = scope;
    this.#work = scope.work;
  }

  /**
   * Runs `work` as one demand with `allowance` units (S3 §5): past them it stops between two steps with
   * `DemandExhausted`, what it was the first to finish memoised, the rest, provisional answers included, forgotten.
   */
  public demand<T>(work: Work<T>, allowance: number): T {
    this.#limit = this.#work.own + allowance;
    try {
      return this.run(work);
    } finally {
      this.#limit = null;
    }
  }

  /** Runs a computation to its end and returns its result: a top-level demand, never memoised itself. */
  public run<T>(work: Work<T>): T {
    if (this.#running) throw new Error("The solver is already running a top-level demand.");
    // after a stop the analysis only finishes (D4 a′): no demand is computed, each answered as it finished or `STOPPED`
    if (this.#work.stopped !== null) return this.#stoppedRun(work);
    this.#running = true;
    const results: T[] = [];
    const top = (function* (): Work<readonly Item[]> {
      results.push(yield* work);
      return [];
    })();
    try {
      this.#drive(this.#frame(null, top, this.#counter++, null));
    } catch (error) {
      // a stop (the budget's) leaves demands unfinished: they are forgotten, the finished ones kept
      this.#active.clear();
      this.#stack.length = 0;
      this.#frames.length = 0;
      this.#solving.length = 0;
      this.#reruns.length = 0;
      throw error;
    } finally {
      this.#running = false;
    }
    if (results.length !== 1) throw new Error("A top-level demand did not finish.");
    return results[0]!;
  }

  /**
   * A read chain one level deeper in the running frame (`checkReadDepth`): a frame runs from the solver's loop, so its
   * native calls are its own chain's, and a demand it yields starts a new frame at none. Past the read depth the
   * analysis stops; after a stop, the deeper read is not settled (`false`: its generator answers `STOPPED`).
   */
  public enterRead(): boolean {
    if (this.#work.stopped !== null && this.#readDepth >= READ_DEPTH_LIMIT) return false;
    checkReadDepth(this.#readDepth + 1);
    this.#readDepth += 1;
    return true;
  }

  /** The read chain one level shallower again. */
  public leaveRead(): void {
    this.#readDepth -= 1;
  }

  /**
   * A computation after a stop: each demand it yields answered as it finished before the stop, else `STOPPED`
   * (through its decision's open answer); none is run.
   */
  #stoppedRun<T>(work: Work<T>): T {
    for (let step = work.next(); ;) {
      if (step.done === true) return step.value;
      const demand = step.value;
      step = work.next(this.#memo.get(demand.key) ?? this.#stopped(demand));
    }
  }

  /** An unfinished demand's items after a stop: `STOPPED`, through its decision's open answer (its proof none). */
  #stopped(demand: Demand | ProofDemand<Proof>): readonly Item[] {
    if (demand.decision === undefined) return STOPPED;
    return demand.proves === undefined
      ? demand.decision.answer(null, STOPPED)
      : demand.decision.answer(null, { items: STOPPED, proof: null }).items;
  }

  /** The answer of a finished demand, if it has one. */
  public answer(key: string): readonly Item[] | undefined {
    return this.#memo.get(key);
  }

  /** The demand whose run is reading (a first run's or a member's again), `null` outside one. */
  public get reading(): string | null {
    return this.#running ? demandOf(this.#frames.at(-1)) : null;
  }

  /**
   * The answers of `keys`, and of every demand that read one of them, directly or through others, forgotten with their
   * proofs between two runs (a key's decision stopped: `Contract.stop`): the next read of each computes it again.
   */
  public forget(keys: readonly string[]): void {
    if (this.#running) throw new Error("The solver cannot forget an answer while it runs.");
    const todo = [...keys];
    const seen = new Set(todo);
    for (let key = todo.pop(); key !== undefined; key = todo.pop()) {
      this.#memo.delete(key);
      this.#proofs.delete(key);
      for (const reader of this.#readers.get(key) ?? [])
        if (!seen.has(reader)) {
          seen.add(reader);
          todo.push(reader);
        }
      this.#readers.delete(key);
    }
  }

  /**
   * A proof demand's items and proof: the demand yielded, so its reader depends on it (and reruns on a changed proof)
   * as on any demand, and its proof as the solver holds it once the items are in: finished, a member's provisional one,
   * or `null`, none (no run of it returned yet; after a stop, any unfinished one: only looked up, nothing run).
   */
  public *proven<P extends Proof>(
    demand: ProofDemand<P>,
  ): Work<{ readonly items: readonly Item[]; readonly proof: P | null }> {
    const items = yield demand;
    const finished = this.#proofs.get(demand.key);
    const held = finished ?? (this.#running ? (this.#active.get(demand.key)?.proof ?? null) : null);
    // EVIDENCE: invariant: a key is one demand's identity, so the proof held under it is what its demand's runs return.
    const proof = held as P | null;
    return { items, proof };
  }

  /** The finished demands with the work each cost, in the order they finished. */
  public demandWork(): readonly DemandWork[] {
    return this.#units;
  }

  #frame(
    node: DemandNode | null,
    work: Work<readonly Item[] | Proven<Proof>>,
    index: number,
    rerun: Rerun | null,
  ): Frame {
    this.#work.charge("frames");
    return {
      node,
      work,
      pending: undefined,
      index,
      low: index,
      base: this.#stack.length,
      selfRead: false,
      started: this.#work.total,
      rerun,
      readDepth: 0,
    };
  }

  /** Runs frames, and solves the components they close, until `base` returns. */
  #drive(base: Frame): void {
    const frames = this.#frames;
    frames.push(base);
    for (;;) {
      // (between two steps every computation stands whole: a demand past its allowance stops here)
      if (this.#limit !== null && this.#work.own > this.#limit) throw new DemandExhausted();
      const solving = this.#solving.at(-1);
      if (solving !== undefined && solving.depth === frames.length) {
        this.#step(solving);
        continue;
      }
      const frame = frames.at(-1)!;
      this.#readDepth = frame.readDepth;
      const step = frame.work.next(frame.pending ?? []);
      frame.readDepth = this.#readDepth;
      frame.pending = undefined;
      this.#work.charge("yields");
      if (!step.done) {
        this.#read(frame, step.value);
        continue;
      }
      frames.pop();
      if (frame === base) {
        if (frames.length !== 0 || this.#solving.length !== 0)
          throw new Error("The solver's frames are out of order.");
        return;
      }
      if (frame.rerun !== null) this.#rerunDone(frame, step.value);
      else this.#finish(frame, step.value, frames.at(-1)!);
    }
  }

  /** A frame yields `demand`: its answer, a provisional one, or a new frame for it. */
  #read(frame: Frame, demand: Demand | ProofDemand<Proof>): void {
    // (its reader kept for `forget`, each new one counted apart from the allowance)
    const reader = demandOf(frame);
    if (reader !== null) {
      let readers = this.#readers.get(demand.key);
      if (readers === undefined) this.#readers.set(demand.key, (readers = new Set()));
      if (!readers.has(reader)) {
        readers.add(reader);
        countApart(this.#work, "readerRecords");
      }
    }
    const finished = this.#memo.get(demand.key);
    if (finished !== undefined) {
      frame.pending = finished;
      return;
    }
    const node = this.#active.get(demand.key);
    if (node === undefined) {
      // (a new demand keeps its key: its text charged first, TABLE r4.58)
      keepText(this.#work, demand.key.length);
      const created: DemandNode = {
        demand,
        index: this.#counter++,
        value: [],
        proof: null,
        input: [],
        inputProof: null,
        choice: null,
        component: null,
      };
      this.#active.set(demand.key, created);
      const pushed = this.#frame(created, demand.make(), created.index, null);
      this.#stack.push(created);
      this.#frames.push(pushed);
      return;
    }
    if (node.component !== null) {
      // a member of a component being solved: the reader belongs to that component
      frame.low = Math.min(frame.low, node.component.index);
      const rerun = this.#reruns.at(-1);
      if (rerun !== undefined && rerun.member.component === node.component) rerun.reads.add(node);
    } else {
      frame.low = Math.min(frame.low, node.index);
      if (node === frame.node) frame.selfRead = true;
    }
    frame.pending = node.value;
  }

  /**
   * A demand's first run returned `items`: memoise its answer, keep it provisional, or start solving the component it
   * closes; its reader `parent` takes the answer then.
   */
  #finish(frame: Frame, result: readonly Item[] | Proven<Proof>, parent: Frame): void {
    const node = frame.node!;
    const { items, proof } = resultOf(result);
    node.input = items;
    node.inputProof = proof;
    const open = this.#answered(node, null);
    node.value = open.items;
    node.proof = open.proof;
    parent.low = Math.min(parent.low, frame.low);
    if (frame.low !== frame.index) {
      parent.pending = node.value;
      return;
    }
    const members = this.#stack.splice(frame.base);
    if (members.length === 1 && !frame.selfRead) {
      if (node.demand.decision !== undefined) {
        const held = this.#answered(node, this.#choice(node));
        node.value = held.items;
        node.proof = held.proof;
      }
      // (its proof's slot charged before its answer and proof are kept: a stop here keeps neither)
      if (node.proof !== null) keep(this.#work, 1);
      this.#memo.set(node.demand.key, node.value);
      if (node.proof !== null) this.#proofs.set(node.demand.key, node.proof);
      this.#active.delete(node.demand.key);
      this.#units.push({ key: node.demand.key, units: this.#work.total - frame.started });
      parent.pending = node.value;
      return;
    }
    const component: Component = {
      index: frame.index,
      members,
      low: frame.index,
      base: this.#stack.length,
      dependents: new Map(),
      reads: new Map(),
      cells: new Map(),
    };
    for (const member of members) member.component = component;
    this.#work.charge("sccMembers", members.length);
    const solving: Solving = {
      component,
      closing: frame,
      depth: this.#frames.length,
      members: [],
      position: new Map(),
      now: new PositionHeap(),
      done: new Set(),
      next: new Set(),
      held: false,
    };
    this.#begin(solving);
    this.#solving.push(solving);
  }

  /**
   * Solving starts again from bottom: no items or proofs, no recorded reads, fresh ingress cells, every member to run.
   */
  #begin(solving: Solving): void {
    const { component } = solving;
    const reverse = this.#seam?.reverseWorklist === true;
    solving.members = [...component.members].sort((a, b) =>
      reverse
        ? canonical(b.demand, a.demand, this.names)
        : canonical(a.demand, b.demand, this.names),
    );
    solving.position = new Map(solving.members.map((member, at) => [member, at]));
    component.dependents.clear();
    component.reads.clear();
    component.cells = new Map();
    for (const member of solving.members) {
      member.value = [];
      member.proof = null;
    }
    solving.now = new PositionHeap();
    solving.done = new Set();
    solving.next = new Set(solving.members.map((_, at) => at));
  }

  /**
   * The next step of solving a component canonically (S3 §1): a member's run, the choices once the open solve is
   * stable, or the end.
   */
  #step(solving: Solving): void {
    for (;;) {
      if (solving.now.size === 0) {
        if (solving.next.size > 0) {
          this.#work.charge("sccRounds");
          for (const at of solving.next) solving.now.push(at);
          solving.next = new Set();
          solving.done = new Set();
          continue;
        }
        if (!solving.held && this.#choose(solving)) {
          solving.held = true;
          this.#begin(solving);
          continue;
        }
        this.#solved(solving);
        return;
      }
      const at = solving.now.pop();
      if (solving.done.has(at)) continue;
      solving.done.add(at);
      const member = solving.members[at]!;
      this.#work.charge("sccReruns");
      const rerun: Rerun = { solving, member, reads: new Set() };
      this.#reruns.push(rerun);
      this.#frames.push(this.#frame(null, member.demand.make(), solving.component.index, rerun));
      return;
    }
  }

  /**
   * The members' choices on their open answers' inputs: whether one changes an answer (the component is then solved
   * again with them held).
   */
  #choose(solving: Solving): boolean {
    let changes = false;
    for (const member of solving.members) {
      if (member.demand.decision === undefined) continue;
      member.choice = this.#choice(member);
      const held = this.#answered(member, member.choice);
      const open = this.#answered(member, null);
      if (
        itemsSignature(held.items, this.#scope) !== itemsSignature(open.items, this.#scope) ||
        (held.proof?.signature(this.#scope) ?? null) !==
          (open.proof?.signature(this.#scope) ?? null)
      )
        changes = true;
    }
    return changes;
  }

  /**
   * A member's run again returned `result`: record its reads, answer and proof, and go on solving as that requires; a
   * changed proof is a change as a changed answer is.
   */
  #rerunDone(frame: Frame, result: readonly Item[] | Proven<Proof>): void {
    const { solving, member, reads } = frame.rerun!;
    const { items: input, proof } = resultOf(result);
    const { component } = solving;
    this.#reruns.pop();
    component.low = Math.min(component.low, frame.low);
    for (const read of component.reads.get(member) ?? []) {
      this.#work.charge("sccDeps");
      component.dependents.get(read)?.delete(member);
    }
    for (const read of reads) {
      this.#work.charge("sccDeps");
      let dependents = component.dependents.get(read);
      if (dependents === undefined) component.dependents.set(read, (dependents = new Set()));
      dependents.add(member);
    }
    component.reads.set(member, reads);
    member.input = input;
    member.inputProof = proof;
    const answered = this.#answered(member, member.choice);
    const items = this.#anchored(component, member, answered.items);
    const changed =
      itemsSignature(items, this.#scope) !== itemsSignature(member.value, this.#scope) ||
      (answered.proof?.signature(this.#scope) ?? null) !==
        (member.proof?.signature(this.#scope) ?? null);
    // its ingress cells took this run's stores whether or not its kinds changed
    member.value = items;
    member.proof = answered.proof;
    if (component.low < component.index) {
      this.#abandon(solving);
      return;
    }
    if (this.#stack.length > component.base) {
      // members found through a member's run: the enlarged component starts again from bottom, its choices open
      const joined = this.#stack.splice(component.base);
      for (const found of joined) found.component = component;
      component.members = [...component.members, ...joined];
      this.#work.charge("sccMembers", joined.length);
      for (const each of component.members) each.choice = null;
      solving.held = false;
      this.#begin(solving);
      return;
    }
    if (!changed) return;
    const at = solving.position.get(member)!;
    for (const dependent of component.dependents.get(member) ?? []) {
      this.#work.charge("sccDeps");
      // a member after this one runs in this round, one before it in the next
      const later = solving.position.get(dependent)!;
      if (later > at) solving.now.push(later);
      else solving.next.add(later);
    }
  }

  /**
   * A component is stable: its members are memoised with their proofs, and the reader of the one that closed it takes
   * its answer. (Every proof's slot is charged before any member is kept: a stop here keeps none of them.)
   */
  #solved(solving: Solving): void {
    let proofs = 0;
    for (const member of solving.members) if (member.proof !== null) proofs += 1;
    keep(this.#work, proofs);
    this.#solving.pop();
    const solved = solving.members.map((member) => ({
      key: member.demand.key,
      items: member.value,
    }));
    for (const member of solving.members) {
      member.component = null;
      member.choice = null;
      this.#memo.set(member.demand.key, member.value);
      if (member.proof !== null) this.#proofs.set(member.demand.key, member.proof);
      this.#active.delete(member.demand.key);
    }
    if (this.#seam?.onComponent !== undefined)
      this.#seam.onComponent(solved, this.replayOf?.(solved.map((member) => member.key)) ?? null);
    const closing = solving.closing.node!;
    this.#units.push({
      key: closing.demand.key,
      units: this.#work.total - solving.closing.started,
    });
    this.#frames.at(-1)!.pending = closing.value;
  }

  /** A demand's choice on its completed input (it has a decision). */
  #choice(node: DemandNode): string {
    const { demand, input, inputProof } = node;
    if (demand.proves === undefined) return demand.decision!.choose(input);
    return demand.decision!.choose({ items: input, proof: inputProof! });
  }

  /** A demand's answer on its last run's input under a choice, or open (`null`): its decision's, else the input. */
  #answered(node: DemandNode, choice: string | null): ProvenAnswer<Proof> {
    const { demand, input, inputProof } = node;
    if (demand.decision === undefined) return { items: input, proof: inputProof };
    if (demand.proves === undefined)
      return { items: demand.decision.answer(choice, input), proof: null };
    return demand.decision.answer(choice, { items: input, proof: inputProof });
  }

  /**
   * C9: a member's external items hold one ingress cell per member and kind, which takes the stores of each run, so a
   * boundary's ingress stores are complete when the component is stable (S2's shared cells).
   */
  #anchored(component: Component, member: DemandNode, items: readonly Item[]): readonly Item[] {
    return items.map((item) => {
      if (item.ingress === undefined) return item;
      const key = joinParts(member.demand.key, item.tag);
      let cell = component.cells.get(key);
      if (cell === undefined) {
        keepText(this.#work, key.length);
        component.cells.set(key, (cell = this.#scope.ingress.cell()));
      }
      if (item.ingress !== cell)
        cell.contents = this.#scope.ingress.union(cell.contents ?? undefined, item.ingress) ?? null;
      return { ...item, ingress: cell };
    });
  }

  /**
   * A component that belongs to a larger one: its members wait, provisional, on Tarjan's stack, and the reader of the
   * one that closed it belongs to the larger one too.
   */
  #abandon(solving: Solving): void {
    this.#solving.pop();
    const { component } = solving;
    const members = [...component.members].sort((a, b) => a.index - b.index);
    for (const member of members) {
      member.component = null;
      member.choice = null;
    }
    // (one by one: a component's members grow with the source, past one call's arguments; the stack above the
    // component's base kept after them, in order)
    const above = this.#stack.splice(component.base);
    for (const member of members) this.#stack.push(member);
    for (const member of above) this.#stack.push(member);
    const parent = this.#frames.at(-1)!;
    parent.low = Math.min(parent.low, component.low);
    parent.pending = solving.closing.node!.value;
  }
}
