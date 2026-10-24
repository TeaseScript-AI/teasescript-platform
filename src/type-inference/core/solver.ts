import type { WorkLedger } from "./budget.js";
import { itemsSignature, type IngressCell, type Item, type ItemScope } from "./items.js";

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
 * unfinished demand outside the component, the component is part of a larger one and is solved with it. So an answer
 * depends on the final member set, never on the order the demands were discovered in; the tests check that property
 * (the component test re-solves every component from each member and in the reverse order).
 */

/** What a demand asks, which orders the members of one component at one site (S3 §1). */
export type DemandKind = "contract" | "exact" | "value";

const KIND_RANK: Readonly<Record<DemandKind, number>> = { contract: 0, exact: 1, value: 2 };

export interface Demand {
  /** The demand's identity: equal keys are one demand, computed once. */
  readonly key: string;
  readonly kind: DemandKind;
  /** Where it stands in the source: its file's index in project order and its offset; `-1` for no site. */
  readonly file: number;
  readonly offset: number;
  readonly make: () => Work<readonly Item[]>;
}

/** A computation that yields the demands it reads and receives their items. */
export type Work<T> = Generator<Demand, T, readonly Item[]>;

/** An unfinished demand. */
interface DemandNode {
  readonly demand: Demand;
  readonly index: number;
  /** Its answer so far: provisional until its component is solved. */
  value: readonly Item[];
  /** The component being solved that it is a member of. */
  component: Component | null;
}

interface Frame {
  /** The demand a first run computes, or `null` for a member's run again or a top-level computation. */
  readonly node: DemandNode | null;
  readonly work: Work<readonly Item[]>;
  pending: readonly Item[] | undefined;
  readonly index: number;
  low: number;
  /** The Tarjan stack's length when it started. */
  readonly base: number;
  /** It read itself. */
  selfRead: boolean;
  /** The ledger's total when it started: the work it and the demands it was the first to compute cost. */
  readonly started: number;
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

/** A solved component's member: its key and its answer. */
export interface SolvedMember {
  readonly key: string;
  readonly items: readonly Item[];
}

/** The variations a test can ask of the solver (test-only). */
export interface SolverSeam {
  /** Solve every component's members in the reverse of the canonical order. */
  readonly reverseWorklist?: boolean;
  /** Hears of every component solved: its members' keys in the order they were solved in, with their answers. */
  readonly onComponent?: (members: readonly SolvedMember[]) => void;
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
 * at one site still have one order.
 */
function canonical(a: Demand, b: Demand): number {
  return (
    a.file - b.file ||
    a.offset - b.offset ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
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

export class Solver {
  readonly #memo = new Map<string, readonly Item[]>();
  readonly #active = new Map<string, DemandNode>();
  /** Tarjan's stack of unfinished demands outside the components being solved. */
  readonly #stack: DemandNode[] = [];
  readonly #frames: Frame[] = [];
  /** The member runs in progress, the innermost last, with what each has read of its component. */
  readonly #reruns: { readonly member: DemandNode; readonly reads: Set<DemandNode> }[] = [];
  readonly #work: WorkLedger;
  readonly #scope: ItemScope;
  readonly #seam: SolverSeam | null = activeSeam;
  readonly #units: DemandWork[] = [];
  #counter = 0;
  #running = false;

  public constructor(scope: ItemScope) {
    this.#scope = scope;
    this.#work = scope.work;
  }

  /** Runs a computation to its end and returns its result: a top-level demand, never memoised itself. */
  public run<T>(work: Work<T>): T {
    if (this.#running) throw new Error("The solver is already running a top-level demand.");
    this.#running = true;
    const results: T[] = [];
    const top = (function* (): Work<readonly Item[]> {
      results.push(yield* work);
      return [];
    })();
    try {
      this.#drive(this.#frame(null, top, this.#counter++));
    } finally {
      this.#running = false;
    }
    if (results.length !== 1) throw new Error("A top-level demand did not finish.");
    return results[0]!;
  }

  /** The answer of a finished demand, if it has one. */
  public answer(key: string): readonly Item[] | undefined {
    return this.#memo.get(key);
  }

  /** The finished demands with the work each cost, in the order they finished. */
  public demandWork(): readonly DemandWork[] {
    return this.#units;
  }

  #frame(node: DemandNode | null, work: Work<readonly Item[]>, index: number): Frame {
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
    };
  }

  /** Runs frames from `base` on until `base` itself returns, and returns its result. */
  #drive(base: Frame): readonly Item[] {
    const frames = this.#frames;
    const depth = frames.length;
    frames.push(base);
    for (;;) {
      const frame = frames.at(-1)!;
      const step = frame.work.next(frame.pending ?? []);
      frame.pending = undefined;
      this.#work.charge("yields");
      if (!step.done) {
        this.#read(frame, step.value);
        continue;
      }
      frames.pop();
      if (frame === base) {
        if (frames.length !== depth) throw new Error("The solver's frames are out of order.");
        return step.value;
      }
      const parent = frames.at(-1)!;
      parent.pending = this.#finish(frame, step.value, parent);
    }
  }

  /** A frame yields `demand`: its answer, a provisional one, or a new frame for it. */
  #read(frame: Frame, demand: Demand): void {
    const finished = this.#memo.get(demand.key);
    if (finished !== undefined) {
      frame.pending = finished;
      return;
    }
    const node = this.#active.get(demand.key);
    if (node === undefined) {
      const created: DemandNode = { demand, index: this.#counter++, value: [], component: null };
      this.#active.set(demand.key, created);
      const pushed = this.#frame(created, demand.make(), created.index);
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

  /** A demand's first run returned `items`: memoise it, solve the component it closes, or keep it provisional. */
  #finish(frame: Frame, items: readonly Item[], parent: Frame): readonly Item[] {
    const node = frame.node!;
    node.value = items;
    parent.low = Math.min(parent.low, frame.low);
    if (frame.low !== frame.index) return items;
    const members = this.#stack.splice(frame.base);
    if (members.length === 1 && !frame.selfRead) {
      this.#memo.set(node.demand.key, items);
      this.#active.delete(node.demand.key);
      this.#units.push({ key: node.demand.key, units: this.#work.total - frame.started });
      return items;
    }
    const outer = this.#solve(members, frame.index);
    if (outer !== null) {
      // part of a larger component: the reader belongs to it too
      parent.low = Math.min(parent.low, outer);
      return node.value;
    }
    this.#units.push({ key: node.demand.key, units: this.#work.total - frame.started });
    return this.#memo.get(node.demand.key)!;
  }

  /**
   * Solves a component canonically (S3 §1) and memoises its members; returns `null`, or the low link of the larger
   * component it turned out to belong to, whose root then solves it with the rest.
   */
  #solve(found: DemandNode[], index: number): number | null {
    const component: Component = {
      index,
      members: found,
      low: index,
      base: this.#stack.length,
      dependents: new Map(),
      reads: new Map(),
      cells: new Map(),
    };
    for (const member of found) member.component = component;
    this.#work.charge("sccMembers", found.length);
    const reverse = this.#seam?.reverseWorklist === true;
    restart: for (;;) {
      const members = [...component.members].sort((a, b) =>
        reverse ? canonical(b.demand, a.demand) : canonical(a.demand, b.demand),
      );
      const position = new Map(members.map((member, at) => [member, at]));
      component.dependents.clear();
      component.reads.clear();
      component.cells = new Map();
      for (const member of members) member.value = [];
      let next = new Set(members.map((_, at) => at));
      while (next.size > 0) {
        this.#work.charge("sccRounds");
        const now = new PositionHeap();
        for (const at of next) now.push(at);
        next = new Set();
        const done = new Set<number>();
        while (now.size > 0) {
          const at = now.pop();
          if (done.has(at)) continue;
          done.add(at);
          const member = members[at]!;
          const changed = this.#rerun(component, member);
          if (component.low < component.index) {
            this.#abandon(component);
            return component.low;
          }
          if (this.#stack.length > component.base) {
            // members found through a member's run: the enlarged component starts again from bottom
            const joined = this.#stack.splice(component.base);
            for (const found of joined) found.component = component;
            component.members = [...component.members, ...joined];
            this.#work.charge("sccMembers", joined.length);
            continue restart;
          }
          if (!changed) continue;
          for (const dependent of component.dependents.get(member) ?? []) {
            this.#work.charge("sccDeps");
            // a member after this one runs in this round, one before it in the next
            const later = position.get(dependent)!;
            if (later > at) now.push(later);
            else next.add(later);
          }
        }
      }
      const solved = members.map((member) => ({ key: member.demand.key, items: member.value }));
      for (const member of members) {
        member.component = null;
        this.#memo.set(member.demand.key, member.value);
        this.#active.delete(member.demand.key);
      }
      this.#seam?.onComponent?.(solved);
      return null;
    }
  }

  /** Runs a member again from its demand; returns whether its answer changed. */
  #rerun(component: Component, member: DemandNode): boolean {
    this.#work.charge("sccReruns");
    const reads = new Set<DemandNode>();
    this.#reruns.push({ member, reads });
    const frame = this.#frame(null, member.demand.make(), component.index);
    let items: readonly Item[];
    try {
      items = this.#anchored(component, member, this.#drive(frame));
    } finally {
      this.#reruns.pop();
    }
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
    const changed =
      itemsSignature(items, this.#scope) !== itemsSignature(member.value, this.#scope);
    // its ingress cells took this run's stores whether or not its kinds changed
    member.value = items;
    return changed;
  }

  /**
   * C9: a member's external items hold one ingress cell per member and kind, which takes the stores of each run, so a
   * boundary's ingress stores are complete when the component is stable (S2's shared cells).
   */
  #anchored(component: Component, member: DemandNode, items: readonly Item[]): readonly Item[] {
    return items.map((item) => {
      if (item.ingress === undefined) return item;
      const key = `${member.demand.key}|${item.tag}`;
      let cell = component.cells.get(key);
      if (cell === undefined) component.cells.set(key, (cell = this.#scope.ingress.cell()));
      if (item.ingress !== cell)
        cell.contents = this.#scope.ingress.union(cell.contents ?? undefined, item.ingress) ?? null;
      return { ...item, ingress: cell };
    });
  }

  /** A component that belongs to a larger one: its members wait, provisional, on Tarjan's stack. */
  #abandon(component: Component): void {
    const members = [...component.members].sort((a, b) => a.index - b.index);
    for (const member of members) member.component = null;
    this.#stack.splice(component.base, 0, ...members);
  }
}
