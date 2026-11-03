import type { PlaceId } from "../../graph.js";
import type { Admission } from "../admission.js";
import { keep, textUnits, type WorkLedger } from "../budget.js";
import { writtenOf } from "../contract.js";
import type { Holding } from "../contract-descriptors.js";
import type { CoreProgram } from "../program.js";
import { copySources } from "./walk.js";

// The holdings of a store contract's levels (#1646, TABLE r4.278 (3)): the contract positions a level's key reads
// whole, through the copies admission follows (A4's `copySources`), so a contract walk proves a cycle of copies at once
// instead of walking it to the slice's depth.

/**
 * A contract position: a place and a path below it, one object per place and path (a trie per place). Its holding (the
 * positions its key reads whole) is made once, on the explicit stack of `Holdings.made`.
 */
class Position implements Holding {
  readonly next = new Map<string, Position>();
  /** The positions copied whole into this one: each a store's or a transfer's copy landing exactly here. */
  sources: Position[] | null = null;
  /** Whether a copy lands strictly below it, so a key below it reads more than its prefixes give it. */
  deeper = false;
  /** The positions its key reads whole (`Holdings.made`); `null` while they are being made. */
  held: readonly Position[] | null | undefined = undefined;
  /** Its reads but itself, as one number per distinct set (`Holding.state`), once its holding is made. */
  state: number | null = null;
  /** Whether its holding read every position it reads: none it depends on was still being made (a ring of copies). */
  whole = true;

  public constructor(
    private readonly holdings: Holdings,
    readonly id: number,
    readonly place: PlaceId,
    readonly parent: Position | null,
    readonly step: string,
  ) {}

  public get own(): object {
    return this;
  }

  public readsAny(open: ReadonlySet<object>): boolean {
    return this.holdings.shared(() => {
      for (const read of this.holdings.made(this).held!) {
        this.holdings.charge();
        if (read !== this && open.has(read)) return true;
      }
      return false;
    });
  }

  public child(step: string): Holding {
    return this.holdings.shared(() => this.holdings.made(this.holdings.below(this, step)));
  }
}

/**
 * The positions of one program: the copies' landings indexed once (the shared build, charged once to the total), each
 * position's holding made once. A position's key reads whole: itself; each position a copy lands at it from; for each
 * position its parent reads that a copy lands strictly below, the position one step below that one, since the contract
 * reads a prefix's whole stores at every key below it; and, of what those read, each position a copy lands strictly
 * below (the only reads a step further down can still reach through). A position asked again while its holding is being
 * made (a ring of copies) reads nothing more there: a holding under-reads, never over-reads.
 */
class Holdings {
  readonly #roots = new Map<PlaceId, Position>();
  readonly #states = new Map<string, number>();
  readonly #work: WorkLedger;
  #positions = 0;

  public constructor(work: WorkLedger) {
    this.#work = work;
  }

  /** A copy of `source` landing at `landing` (`holdingsOf`). */
  public land(landing: Position, source: Position): void {
    (landing.sources ??= []).push(source);
    for (let up = landing.parent; up !== null && !up.deeper; up = up.parent) up.deeper = true;
  }

  /** One unit of the holdings' work. */
  public charge(): void {
    this.#work.charge("structureSteps");
  }

  /** Runs `callback` as the holdings' work: a build every walk of the program shares, charged to no demand (S3 §5). */
  public shared<T>(callback: () => T): T {
    return this.#work.shared(callback);
  }

  /** The position of `place` at `path`. */
  public at(place: PlaceId, path: readonly string[]): Position {
    let position = this.#roots.get(place);
    if (position === undefined) {
      this.#work.charge("structureSteps");
      this.#roots.set(place, (position = new Position(this, this.#positions++, place, null, "")));
    }
    for (const step of path) position = this.below(position, step);
    return position;
  }

  /** The position one `step` below `parent`. */
  public below(parent: Position, step: string): Position {
    this.#work.charge("structureSteps");
    let position = parent.next.get(step);
    if (position === undefined)
      parent.next.set(
        step,
        (position = new Position(this, this.#positions++, parent.place, parent, step)),
      );
    return position;
  }

  /** `position` with its holding made: its parent's first, then the positions it reads, on an explicit stack. */
  public made(position: Position): Position {
    if (position.held !== undefined) return position;
    const stack: { readonly position: Position; needs: Position[] | null }[] = [
      { position, needs: null },
    ];
    try {
      this.#make(stack);
    } catch (error) {
      // (a stop while it ran leaves no holding half made: each is made anew when next asked)
      for (const { position: at } of stack) if (at.held === null) at.held = undefined;
      throw error;
    }
    return position;
  }

  #make(stack: { readonly position: Position; needs: Position[] | null }[]): void {
    while (stack.length > 0) {
      const top = stack.at(-1)!;
      const at = top.position;
      if (top.needs === null) {
        if (at.held !== undefined) {
          stack.pop();
          continue;
        }
        // (its parent's reads decide what it carries: made first, as the walk makes them in order anyway)
        if (at.parent !== null && at.parent.held === undefined) {
          stack.push({ position: at.parent, needs: null });
          continue;
        }
        top.needs = this.#needs(at);
        at.held = null;
        for (const need of top.needs)
          if (need.held === undefined) stack.push({ position: need, needs: null });
        continue;
      }
      const reads = new Set<Position>([at]);
      at.whole = at.parent === null || at.parent.whole;
      for (const need of top.needs) {
        this.#work.charge("structureSteps");
        reads.add(need);
        if (need.held === null || !need.whole) at.whole = false;
        // (of its reads, those a copy lands below, which a step further down still reads; one still being made, in a
        // ring of copies, reads nothing more here)
        for (const read of need.held ?? []) {
          this.#work.charge("structureSteps");
          if (read.deeper) reads.add(read);
        }
      }
      at.state = this.#state(at, reads);
      at.held = [...reads];
      stack.pop();
    }
  }

  /**
   * `position`'s reads but itself as one number per distinct set, where no copy lands strictly below it, it reads
   * something and its holding is whole: then a key below it reads only what those reads give, so a level below with the
   * same state is a cycle of copies (`Holding.state`); `null` elsewhere, where an equal set would prove nothing.
   */
  #state(position: Position, reads: ReadonlySet<Position>): number | null {
    if (position.deeper || !position.whole || reads.size < 2) return null;
    const ids: number[] = [];
    for (const read of reads) {
      this.#work.charge("structureSteps");
      if (read !== position) ids.push(read.id);
    }
    const text = ids.sort((a, b) => a - b).join(",");
    keep(this.#work, textUnits(text.length));
    let state = this.#states.get(text);
    if (state === undefined) this.#states.set(text, (state = this.#states.size));
    return state;
  }

  /**
   * What `position`'s holding is made from: the positions copied whole into it, and the position one step below each
   * position its parent reads that a copy lands strictly below (the parent's own step below is `position` itself).
   */
  #needs(position: Position): Position[] {
    const needs: Position[] = [...(position.sources ?? [])];
    const parent = position.parent;
    if (parent !== null)
      for (const read of parent.held ?? []) {
        this.#work.charge("structureSteps");
        if (read !== parent && read.deeper) needs.push(this.below(read, position.step));
      }
    return needs;
  }
}

/** Each program's holdings, built once, from the first admission pass that asks. */
const HOLDINGS = new WeakMap<CoreProgram, Holdings>();

/** A holding that reads nothing (`withoutCycleCertificate`): every walk runs to the slice's depth, as before #1646. */
const NO_HOLDING: Holding = {
  own: {},
  state: null,
  readsAny: () => false,
  child: () => NO_HOLDING,
};

let certificate = true;

/**
 * Test-only: runs `callback` with no holdings built or read, so every contract walk runs to the slice's depth as it did
 * before #1646: the reference the cycle certificate's invariant compares with.
 */
export function withoutCycleCertificate<T>(callback: () => T): T {
  const outer = certificate;
  certificate = false;
  try {
    return callback();
  } finally {
    certificate = outer;
  }
}

/**
 * The program's holdings, the copies' landings indexed once: every live whole store's, add's and transfer's copies
 * (`copySources`, A4's), each landing where it puts the copied binding's path, into an unwritten place (a written type
 * is its place's contract, whatever is copied into it).
 */
function holdingsOf(admission: Admission): Holdings {
  const { definitions, lists, program } = admission.pass;
  let holdings = HOLDINGS.get(program);
  if (holdings !== undefined) return holdings;
  const made = new Holdings(program.work);
  for (const d of [...definitions.storeDefs, ...definitions.transferDefs]) {
    made.charge();
    if ((d.kind !== "whole" && d.kind !== "add") || d.value === undefined) continue;
    if (writtenOf(program.place(d.place).kind) !== null) continue;
    if (!lists.live(d) || !program.live(d.node)) continue;
    let at = made.at(d.place, d.path);
    if (d.kind === "add" && d.how !== "elements") at = made.below(at, "element");
    for (const { path, binding, strip } of copySources(admission, d.value)) {
      let landing = at;
      for (const step of path) landing = made.below(landing, step);
      made.land(landing, made.at(binding, strip));
    }
  }
  // (kept once whole: a stop while it ran indexes it anew where next asked)
  HOLDINGS.set(program, (holdings = made));
  return holdings;
}

/** The holding of `place` at `path` (#1646): the position a contract walk's cycle certificate reads. */
export function holdingAt(admission: Admission, place: PlaceId, path: readonly string[]): Holding {
  if (!certificate) return NO_HOLDING;
  return admission.pass.program.work.shared(() => {
    const holdings = holdingsOf(admission);
    return holdings.made(holdings.at(place, path));
  });
}
