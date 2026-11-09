import type { WorkLedger } from "../budget.js";

/*
 * The receiving closure's cells and frontier (#1526 phase C steps 2–4; Sol's round 2 §1 and §5). The completion pass
 * (`Consumers.#completeFor`) is made from the settled pass's inputs without its frozen keys: a key an obligation's
 * proof reads is decided there, where it is first read, as a scoped decision from what is left of the total, in a fresh
 * `Admission`, so nothing is unfrozen and no cache holds a frozen key's answer. What the closure keeps is the cells
 * outside the solver whose outputs another read takes (a decision, a property listing, an assembled descriptor, a
 * capture request), the reads between them (a cache hit too), and the frontier that schedules them: a request or a
 * listing that needs a listing not yet made is parked with its stamp (those listings) and runs again once every one of
 * them is made, each listing taking the listings it reaches whole (step 4), so a chain of keys is listed once, not once
 * per key that reaches it.
 *
 * The graph is the completion lease: kept from the completion pass's start until `close`. A transaction (`change`)
 * invalidates every cell that read a changed one, once, with one visited set, a cell it invalidates leaving the graph
 * with its edges: it runs where a decision is made after a cell read it unmade, which no read in the completion pass
 * does (each decision is made where it is first read), so a transaction is a guard that counts, never a repair path.
 * Every semantic result comes from the existing admission, solver and descriptor service.
 */

/** What a cell of the closure stands for. */
export type CellKind =
  /** An admission decision of a key (the admitted level), by its canonical key. */
  | "decision"
  /** A decided object's property names, by the object's key. */
  | "listing"
  /** A contract assembled at a place's path by the descriptor service (an extent), by `place|path`. */
  | "extent"
  /** A receiving obligation's requirement, by its index in the stable source order. */
  | "request"
  /**
   * A fact of the pass a binding reads, by its name and version: its store targets and its rejected set (A6, #1275),
   * constant within a pass, so a change is a new pass, whose completion binds every slot anew.
   */
  | "fact";

const PREFIX: Readonly<Record<CellKind, string>> = {
  decision: "d",
  listing: "l",
  extent: "a",
  request: "x",
  fact: "f",
};

interface Cell {
  readonly kind: CellKind;
  readonly name: string;
  /** What it read: its direct dependencies, each once. */
  readonly out: Set<Cell>;
  /** What read it: the reverse relation, which owns invalidation. */
  readonly in: Set<Cell>;
  /** Whether its output is made (a decision recorded, a listing complete); a read of it before then read it unmade. */
  made: boolean;
}

/**
 * Why a completion decision leaves the obligations whose proofs read it lost (A6, #1275): it would reject a store, or
 * give a selecting store another target, than the settled pass's inputs, which the completion pass keeps.
 */
export type Unsettled = "rejection" | "retarget";

/** The closure's counters for the gates: every part of its work, apart from the units it charged. */
export interface ClosureCounts {
  /** Cells whose output was made (decisions, listings). */
  cells: number;
  /** Reads kept between cells (each charged where made). */
  edges: number;
  /** Decisions made in the completion pass, each where a level first asked for it. */
  decisions: number;
  /** Listing runs, the first of each listing included. */
  listings: number;
  /** Listing runs that deferred a key another listing finds (parked on it). */
  deferred: number;
  /** Listings taken whole by a search that reached them. */
  taken: number;
  /** Requests extracted, an extraction again included. */
  extractions: number;
  /** Extractions of a request again, once the listings it waited on were made. */
  reextractions: number;
  /** Parked items left waiting at the end (0 by construction). */
  unchanged: number;
  /** Transactions: a decision made after a cell read it unmade (0 by construction). */
  transactions: number;
  /** Cells a transaction invalidated. */
  invalidated: number;
  /** Visits of the transactions' walks. */
  visits: number;
  /** Completion decisions that would reject a store or retarget a selecting store (`mark`). */
  marked: number;
  /** Requests lost once a decision is marked (`unsettled`). */
  unsettled: number;
  /** Of those, the ones the completion had completed: what the whole loss leaves unpublished. */
  forgone: number;
  /** Whether a request reached the slice's depth, ending the completion with no result kept (`LeftSlice`). */
  leftSlice: number;
  /** Whether the completion reached its own allowance, twice the analysis's work before it (`CapReached`). */
  capped: number;
  /** The completion's units when it reached its allowance (0 where it did not). */
  cappedAt: number;
}

/** A closure's counters before it runs. */
export function closureCounts(): ClosureCounts {
  return {
    cells: 0,
    edges: 0,
    decisions: 0,
    listings: 0,
    deferred: 0,
    taken: 0,
    extractions: 0,
    reextractions: 0,
    unchanged: 0,
    transactions: 0,
    invalidated: 0,
    visits: 0,
    marked: 0,
    unsettled: 0,
    forgone: 0,
    leftSlice: 0,
    capped: 0,
    cappedAt: 0,
  };
}

/**
 * A request whose contract reaches the slice's depth: the program has left the slice, where main's lowering requests
 * nothing more, so the completion ends there (as phase B's capture does).
 */
export class LeftSlice extends Error {
  public constructor() {
    super("A receiving request reached the slice's depth.");
    this.name = "LeftSlice";
  }
}

/** A request whose extraction needed a listing not yet made: the listing, and the keys its search deferred. */
export class Unlisted extends Error {
  public constructor(
    readonly key: string,
    readonly deferred: readonly string[],
  ) {
    super(`The listing of ${key} waits on ${deferred.length} other listings.`);
    this.name = "Unlisted";
  }
}

/** A frontier item: a request (its index) or a listing (its key). */
type Item = { readonly request: number } | { readonly listing: string };

const itemId = (item: Item): string =>
  "listing" in item ? `l:${item.listing}` : `x:${item.request}`;

export class Closure {
  readonly #work: WorkLedger;
  readonly #cells = new Map<string, Cell>();
  /** The cells being made, the innermost last: a read is the innermost's. */
  readonly #stack: Cell[] = [];
  /** Per kind of cell, what clears its kept output (`handle`): its next read makes it anew. */
  readonly #handlers = new Map<CellKind, (name: string) => void>();
  #closed = false;
  readonly counts: ClosureCounts = closureCounts();

  public constructor(work: WorkLedger) {
    this.#work = work;
  }

  /**
   * The decisions the completion made (`decide`), in the order made: each key, its units and the allowance it had, what
   * was left of the total: recorded as the completion's, never among the settled pass's decisions.
   */
  readonly decisions: {
    readonly key: string;
    readonly units: number;
    readonly allowance: number;
  }[] = [];

  /** Makes the decision of `key` where a level first asks for it (`admitted.ts`'s pull), recorded (`decisions`). */
  public decide(key: string, make: () => void): void {
    const before = this.#work.own;
    const allowance = this.#work.allowance - this.#work.total;
    make();
    this.decisions.push({ key, units: this.#work.own - before, allowance });
  }

  /** The completion decisions that would reject a store or retarget a selecting store, by key, in the order marked. */
  readonly #marks = new Map<string, Unsettled>();

  /** Marks the decision of `key` as one that would reject a store or retarget a selecting store, once. */
  public mark(key: string, cause: Unsettled): void {
    if (this.#closed || this.#marks.has(key)) return;
    this.#marks.set(key, cause);
    this.counts.marked += 1;
  }

  /**
   * Every request of `requests`, lost, once a decision is marked or `beside` names a cause (a store moved whose receivers
   * no cell records): each with the cause of the first marked decision its proof read, directly or through the cells
   * between them (one walk over the readers with one visited set, each visit charged), else the first mark's. No cell
   * records what reaches a contract through copies, projections and wrappers, so a marked decision may reach any.
   */
  public unsettled(requests: number, beside: Unsettled | null): ReadonlyMap<number, Unsettled> {
    const out = new Map<number, Unsettled>();
    if (this.#closed) return out;
    const visited = new Set<Cell>();
    for (const [key, cause] of this.#marks) {
      const seed = this.#cells.get(`${PREFIX.decision}:${key}`);
      const pending = seed === undefined ? [] : [seed];
      for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
        if (visited.has(at)) continue;
        visited.add(at);
        this.#charge("closureVisits");
        if (at.kind === "request") out.set(Number(at.name), cause);
        for (const reader of at.in) if (!visited.has(reader)) pending.push(reader);
      }
    }
    const first = this.#marks.values().next().value ?? beside;
    if (first !== undefined && first !== null) {
      this.#charge("closureVisits", requests);
      for (let index = 0; index < requests; index += 1) if (!out.has(index)) out.set(index, first);
    }
    this.counts.unsettled += out.size;
    return out;
  }

  /** Whether the closure still keeps its records: from the completion pass's start until `close`. */
  public get open(): boolean {
    return !this.#closed;
  }

  /** `clear` clears a cell of `kind` a transaction invalidated (its kept output), so its next read makes it anew. */
  public handle(kind: CellKind, clear: (name: string) => void): void {
    this.#handlers.set(kind, clear);
  }

  /** The closure's own work, charged to the total as a structure the pass shares, never a decision's allowance. */
  #charge(counter: "closureEdges" | "closureVisits", units = 1): void {
    this.#work.shared(() => this.#work.charge(counter, units));
  }

  #cell(kind: CellKind, name: string): Cell {
    const id = `${PREFIX[kind]}:${name}`;
    let cell = this.#cells.get(id);
    if (cell === undefined) {
      cell = { kind, name, out: new Set(), in: new Set(), made: false };
      this.#cells.set(id, cell);
    }
    return cell;
  }

  /** The innermost cell being made read `to`: kept once, charged where made. */
  #read(to: Cell): void {
    const from = this.#stack.at(-1);
    if (from === undefined || from === to || from.out.has(to)) return;
    this.#charge("closureEdges");
    from.out.add(to);
    to.in.add(from);
    this.counts.edges += 1;
  }

  /** The cell being made now took a cell's kept output (a cache hit): its read. */
  public took(kind: CellKind, name: string): void {
    if (this.#closed) return;
    if (kind === "listing") this.counts.taken += 1;
    this.#read(this.#cell(kind, name));
  }

  /**
   * Enters a cell a generator makes (`within` for a task the compile runner drives): read by the cell being made now,
   * its reads its own; `leave` ends it, in a `finally`.
   */
  public enter(kind: CellKind, name: string): boolean {
    if (this.#closed) return false;
    const cell = this.#cell(kind, name);
    this.#read(cell);
    this.#stack.push(cell);
    return true;
  }

  public leave(entered: boolean): void {
    if (entered) this.#stack.pop();
  }

  /**
   * Makes a cell no cell reads yet (a listing's search: the reader that needs it takes it once it is made, `took`, so a
   * request that waits on it never read it unmade); its reads its own.
   */
  public alone<T>(kind: CellKind, name: string, make: () => T): T {
    if (this.#closed) return make();
    this.#stack.push(this.#cell(kind, name));
    try {
      return make();
    } finally {
      this.#stack.pop();
    }
  }

  /** Makes a cell: read by the cell being made now, its reads its own. */
  public within<T>(kind: CellKind, name: string, make: () => T): T {
    if (this.#closed) return make();
    const cell = this.#cell(kind, name);
    this.#read(cell);
    this.#stack.push(cell);
    try {
      return make();
    } finally {
      this.#stack.pop();
    }
  }

  /**
   * The output of a cell is made (a decision recorded, a listing complete): a cell that read it before then read it
   * unmade, so one transaction invalidates it and what read it (`change`); each decision is made where it is first
   * read, so none does. The requests invalidated, by index.
   */
  public made(kind: CellKind, name: string): readonly string[] {
    if (this.#closed) return [];
    const cell = this.#cell(kind, name);
    this.counts.cells += 1;
    if (kind === "decision") this.counts.decisions += 1;
    const stale = cell.made ? [] : [...cell.in].filter((reader) => !this.#stack.includes(reader));
    cell.made = true;
    return stale.length === 0 ? [] : this.#change(stale);
  }

  /**
   * One invalidation transaction: `seeds` and every cell that read one of them, transitively, once, with one visited
   * set; each visit charged before anything changes. Each leaves the graph with its edges and its output is cleared, so
   * it is made anew where it is read, and no later transaction reaches it before. The requests among them, by index.
   */
  #change(seeds: readonly Cell[]): readonly string[] {
    const visited = new Set<Cell>();
    const pending = [...seeds];
    const order: Cell[] = [];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (visited.has(at)) continue;
      visited.add(at);
      this.#charge("closureVisits");
      this.counts.visits += 1;
      order.push(at);
      for (const reader of at.in) if (!visited.has(reader)) pending.push(reader);
    }
    // (nothing changed before here: a stop in the walk leaves the graph and the pass as they were)
    for (const cell of order) {
      for (const child of cell.out) child.in.delete(cell);
      cell.out.clear();
      cell.in.clear();
      this.#cells.delete(`${PREFIX[cell.kind]}:${cell.name}`);
    }
    this.counts.transactions += 1;
    this.counts.invalidated += order.length;
    for (const cell of order) {
      this.#handlers.get(cell.kind)?.(cell.name);
      // (a request it invalidated is extracted again, after the listings)
      if (cell.kind === "request") this.#reready?.(Number(cell.name));
    }
    return order.filter((cell) => cell.kind === "request").map((cell) => cell.name);
  }

  /** While the frontier runs, what puts an invalidated request back among the ready ones. */
  #reready: ((index: number) => void) | null = null;

  /**
   * Closes the closure (`close()`): its records, the completion lease and the waiters released, once; the captured
   * results stay immutable, and nothing is invalidated again.
   */
  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cells.clear();
    this.#stack.length = 0;
  }

  /**
   * The frontier (`runReady`): every request once, in the stable source order. One whose extraction needs a listing not
   * yet made (`Unlisted`) is parked with its stamp, that listing, and the listing is scheduled; a listing whose search
   * deferred keys other listings find is parked on all of them, and they are scheduled. A parked item runs again only
   * once every listing of its stamp is made (its progress stamp: nothing else it read can change), listings first, the
   * latest scheduled first, so a chain is listed from its far end and each listing runs at most twice; a request
   * extracted again finds its listings made. A search follows a key whose listing is parked (`parked`), never defers
   * it, so a cycle of keys lists without waiting on itself.
   */
  public run(frontier: {
    readonly requests: number;
    /** Extracts request `index` (made anew only where it waited); throws `Unlisted` where a listing is not yet made. */
    extract(index: number): void;
    /** Lists `key`: its names, or the keys its search deferred. */
    list(key: string): ReadonlySet<string> | { readonly deferred: readonly string[] };
    /** Whether `key`'s listing is made. */
    listed(key: string): boolean;
  }): { readonly parked: (key: string) => boolean } {
    const ready = new MinHeap();
    const listings: string[] = [];
    const queued = new Set<string>();
    // (each parked item with the listings of its stamp not yet made: it wakes when the last of them is)
    const parked = new Map<string, { readonly item: Item; remaining: number }>();
    const waiting = new Map<string, Set<string>>();
    const extracted = new Set<number>();
    const view = { parked: (key: string): boolean => parked.has(`l:${key}`) };
    this.#parkedView = view;
    this.#reready = (index) => ready.push(index);
    const schedule = (key: string): void => {
      if (frontier.listed(key) || parked.has(`l:${key}`)) return;
      queued.add(key);
      listings.push(key);
    };
    const wake = (item: Item): void => {
      if ("listing" in item) {
        queued.add(item.listing);
        listings.push(item.listing);
      } else ready.push(item.request);
    };
    const park = (item: Item, stamp: readonly string[]): void => {
      const id = itemId(item);
      const entry = { item, remaining: 0 };
      parked.set(id, entry);
      // (each listing of the stamp once, charged: one waiter each, counted down as each is made)
      this.#charge("closureVisits", stamp.length);
      for (const key of stamp) {
        if (frontier.listed(key)) continue;
        let set = waiting.get(key);
        if (set === undefined) waiting.set(key, (set = new Set()));
        if (set.has(id)) continue;
        set.add(id);
        entry.remaining += 1;
      }
      if (entry.remaining === 0) {
        parked.delete(id);
        wake(item);
        return;
      }
      // (pushed in reverse: the first in the stamp's order is listed first)
      for (let at = stamp.length - 1; at >= 0; at -= 1) schedule(stamp[at]!);
    };
    const made = (key: string): void => {
      const waiters = waiting.get(key);
      if (waiters === undefined) return;
      waiting.delete(key);
      this.#charge("closureVisits", waiters.size);
      for (const id of waiters) {
        const entry = parked.get(id);
        if (entry === undefined) continue;
        // (woken once every listing of its stamp is made)
        entry.remaining -= 1;
        if (entry.remaining > 0) continue;
        parked.delete(id);
        wake(entry.item);
      }
    };
    const extract = (index: number): void => {
      this.counts.extractions += 1;
      if (extracted.has(index)) this.counts.reextractions += 1;
      extracted.add(index);
      try {
        frontier.extract(index);
      } catch (error) {
        if (!(error instanceof Unlisted)) throw error;
        // (the listing it needs parked on what its search deferred, the request on that listing)
        if (!parked.has(`l:${error.key}`) && !frontier.listed(error.key))
          park({ listing: error.key }, error.deferred);
        park({ request: index }, [error.key]);
      }
    };
    // (the views released however the run ends: a request that leaves the slice ends it, `LeftSlice`)
    try {
      for (let index = 0; index < frontier.requests; index += 1) extract(index);
      for (;;) {
        const key = listings.pop();
        if (key !== undefined) {
          if (!queued.has(key)) continue;
          queued.delete(key);
          if (!frontier.listed(key)) {
            this.counts.listings += 1;
            const found = frontier.list(key);
            if ("deferred" in found) {
              this.counts.deferred += 1;
              park({ listing: key }, found.deferred);
              continue;
            }
          }
          made(key);
          continue;
        }
        if (ready.size === 0) break;
        extract(ready.pop());
      }
    } finally {
      this.#parkedView = null;
      this.#reready = null;
    }
    // (every parked item woke: one left waiting is counted, never by construction)
    this.counts.unchanged += parked.size;
    return view;
  }

  #parkedView: { readonly parked: (key: string) => boolean } | null = null;

  /** Whether `key`'s listing is parked on the frontier now: a search that reaches it follows it, never defers it. */
  public parked(key: string): boolean {
    return this.#parkedView?.parked(key) ?? false;
  }
}

/** The ready requests by their index (their stable source order), the least first, each once. */
class MinHeap {
  readonly #items: number[] = [];
  readonly #held = new Set<number>();

  public get size(): number {
    return this.#items.length;
  }

  public push(value: number): void {
    if (this.#held.has(value)) return;
    this.#held.add(value);
    const items = this.#items;
    items.push(value);
    for (let at = items.length - 1; at > 0;) {
      const parent = (at - 1) >> 1;
      if (items[parent]! <= items[at]!) break;
      [items[parent], items[at]] = [items[at]!, items[parent]!];
      at = parent;
    }
  }

  public pop(): number {
    const items = this.#items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      for (let at = 0; ;) {
        const left = 2 * at + 1;
        const right = left + 1;
        let least = at;
        if (left < items.length && items[left]! < items[least]!) least = left;
        if (right < items.length && items[right]! < items[least]!) least = right;
        if (least === at) break;
        [items[least], items[at]] = [items[at]!, items[least]!];
        at = least;
      }
    }
    this.#held.delete(top);
    return top;
  }
}
