import type { PlaceId } from "../../graph.js";
import type { Admission } from "../admission.js";
import type { WorkLedger } from "../budget.js";
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
  /** The position whose contract equals its own, where a ring of whole copies made them one (`Holdings.collapse`). */
  alias: Position | null = null;
  /** The positions its key reads whole (`Holdings.made`); `null` while they are being made. */
  held: readonly Position[] | null | undefined = undefined;

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
  readonly #work: WorkLedger;
  #positions = 0;

  public constructor(work: WorkLedger) {
    this.#work = work;
  }

  /** A copy of `source` landing at `landing` (`holdingsOf`). */
  public land(landing: Position, source: Position): void {
    (landing.sources ??= []).push(source);
    this.#deepen(landing);
  }

  /** Marks the positions above `landing` as having a copy below them. */
  #deepen(landing: Position): void {
    for (let up = landing.parent; up !== null && !up.deeper; up = up.parent) up.deeper = true;
  }

  /**
   * Makes each ring of whole copies one position (#1646, Codex r1 B2): positions that copy one another whole, each a
   * source of the next round the ring (a strongly connected component of the landings), have one contract, so their
   * landings, those below them included, become one position's (the member made first), and every later step into a
   * member is a step into it. Without this, each member read every other and a ring of k copies made k × k reads. Found
   * on an explicit stack (Tarjan's algorithm), each landing visited once.
   */
  public collapse(positions: readonly Position[]): void {
    const index = new Map<Position, number>();
    const low = new Map<Position, number>();
    const onStack = new Set<Position>();
    const stack: Position[] = [];
    for (const start of positions) {
      if (index.has(start)) continue;
      const frames: { readonly at: Position; next: number }[] = [{ at: start, next: 0 }];
      index.set(start, index.size);
      low.set(start, index.get(start)!);
      stack.push(start);
      onStack.add(start);
      while (frames.length > 0) {
        const frame = frames.at(-1)!;
        const sources = frame.at.sources ?? [];
        if (frame.next < sources.length) {
          this.charge();
          const source = sources[frame.next++]!;
          if (!index.has(source)) {
            index.set(source, index.size);
            low.set(source, index.get(source)!);
            stack.push(source);
            onStack.add(source);
            frames.push({ at: source, next: 0 });
          } else if (onStack.has(source))
            low.set(frame.at, Math.min(low.get(frame.at)!, index.get(source)!));
          continue;
        }
        frames.pop();
        const parent = frames.at(-1)?.at;
        if (parent !== undefined) low.set(parent, Math.min(low.get(parent)!, low.get(frame.at)!));
        if (low.get(frame.at) !== index.get(frame.at)) continue;
        const ring: Position[] = [];
        for (let member = stack.pop()!; ; member = stack.pop()!) {
          onStack.delete(member);
          ring.push(member);
          if (member === frame.at) break;
        }
        if (ring.length > 1) this.#merge(ring);
      }
    }
  }

  /** One position for a ring's members: the one made first, each other member's landings moved into it. */
  #merge(ring: readonly Position[]): void {
    const one = ring.reduce((a, b) => (a.id <= b.id ? a : b));
    const pending: [Position, Position][] = ring.filter((m) => m !== one).map((m) => [one, m]);
    while (pending.length > 0) {
      const [into, from] = pending.pop()!;
      const target = this.canonical(into);
      if (from === target || from.alias !== null) continue;
      this.charge();
      from.alias = target;
      if (from.sources !== null) {
        for (const source of from.sources) (target.sources ??= []).push(source);
        this.#deepen(target);
      }
      if (from.deeper) {
        target.deeper = true;
        this.#deepen(target);
      }
      for (const [step, child] of from.next) pending.push([this.below(target, step), child]);
    }
  }

  /** The position whose contract is `position`'s, past every ring that made it one with another. */
  public canonical(position: Position): Position {
    let at = position;
    while (at.alias !== null) at = at.alias;
    return at;
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
    position = this.canonical(position);
    for (const step of path) position = this.below(position, step);
    return position;
  }

  /** The position one `step` below `parent`. */
  public below(of: Position, step: string): Position {
    this.#work.charge("structureSteps");
    const parent = this.canonical(of);
    const known = parent.next.get(step);
    if (known !== undefined) return this.canonical(known);
    const position = new Position(this, this.#positions++, parent.place, parent, step);
    parent.next.set(step, position);
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

  /** `position`'s reads from `needs`: itself, each need, and of each need's reads those a copy lands below. */
  #reads(position: Position, needs: readonly Position[]): Set<Position> {
    const reads = new Set<Position>([position]);
    for (const need of needs) {
      this.#work.charge("structureSteps");
      reads.add(need);
      // (of its reads, those a copy lands below, which a step further down still reads; one still being made, in a
      // ring of copies, reads nothing more yet)
      for (const read of need.held ?? []) {
        this.#work.charge("structureSteps");
        if (read.deeper) reads.add(read);
      }
    }
    return reads;
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
      const reads = this.#reads(at, top.needs);
      // (complete only where its parent's reads, which it carries, and every one it reads were complete: a parent still
      // being made, `a=a.q`, carried nothing yet)
      at.held = [...reads];
      stack.pop();
    }
  }

  /**
   * What `position`'s holding is made from: the positions copied whole into it, and the position one step below each
   * position its parent reads that a copy lands strictly below (the parent's own step below is `position` itself).
   */
  #needs(position: Position): Position[] {
    // (each source past the rings that made it one with another, none the position itself: a copy into itself, `b=b`,
    // adds nothing it does not read)
    const found = new Set<Position>();
    for (const source of position.sources ?? []) {
      const at = this.canonical(source);
      if (at !== position) found.add(at);
    }
    const needs = [...found];
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
const NO_HOLDING: Holding = { own: {}, readsAny: () => false, child: () => NO_HOLDING };

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
  const landings: Position[] = [];
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
      landings.push(landing);
    }
  }
  made.collapse(landings);
  // (kept once whole: a stop while it ran indexes it anew where next asked)
  HOLDINGS.set(program, (holdings = made));
  return holdings;
}

/** Each program's answer to `copiesCycle`. */
const CYCLES = new WeakMap<CoreProgram, boolean>();

/**
 * Whether the program's copies can make a contract hold itself below itself. Link each place to every binding that a
 * live whole store, add or transfer into it copies (`copySources`), weighted by how much deeper the copy lands than
 * the path it copies (`a.q=b`: 1; `a=b`: 0; `a=b.q`: -1). A contract holds itself below itself only round a cycle of
 * those links whose weights add up to more than 0. Here: only where some strongly connected set of places has links
 * whose weights no depth per place explains (a cycle that does not add up to 0); a ring of whole copies adds up to 0.
 * Without one no level reads a level above it, so no walk builds or reads a holding, and every walk is exactly main's,
 * its work included. Uncharged: it reads the copies the admission pass already found and charged (its constructor's A4
 * pass asks `copySources` of each such store), once each, and walks those links twice.
 */
function copiesCycle(admission: Admission): boolean {
  const { definitions, lists, program } = admission.pass;
  const known = CYCLES.get(program);
  if (known !== undefined) return known;
  const links = new Map<PlaceId, { readonly to: PlaceId; readonly weight: number }[]>();
  for (const d of [...definitions.storeDefs, ...definitions.transferDefs]) {
    if ((d.kind !== "whole" && d.kind !== "add") || d.value === undefined) continue;
    if (writtenOf(program.place(d.place).kind) !== null) continue;
    if (!lists.live(d) || !program.live(d.node)) continue;
    const depth = d.path.length + (d.kind === "add" && d.how !== "elements" ? 1 : 0);
    for (const { path, binding, strip } of copySources(admission, d.value)) {
      let out = links.get(d.place);
      if (out === undefined) links.set(d.place, (out = []));
      out.push({ to: binding, weight: depth + path.length - strip.length });
    }
  }
  // (the strongly connected sets of places, on an explicit stack: Tarjan's algorithm)
  const index = new Map<PlaceId, number>();
  const low = new Map<PlaceId, number>();
  const component = new Map<PlaceId, number>();
  const open: PlaceId[] = [];
  for (const start of links.keys()) {
    if (index.has(start)) continue;
    const frames: { readonly place: PlaceId; next: number }[] = [{ place: start, next: 0 }];
    index.set(start, index.size);
    low.set(start, index.get(start)!);
    open.push(start);
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const out = links.get(frame.place) ?? [];
      if (frame.next < out.length) {
        const { to } = out[frame.next++]!;
        if (!index.has(to)) {
          index.set(to, index.size);
          low.set(to, index.get(to)!);
          open.push(to);
          frames.push({ place: to, next: 0 });
        } else if (!component.has(to))
          low.set(frame.place, Math.min(low.get(frame.place)!, index.get(to)!));
        continue;
      }
      frames.pop();
      const parent = frames.at(-1)?.place;
      if (parent !== undefined) low.set(parent, Math.min(low.get(parent)!, low.get(frame.place)!));
      if (low.get(frame.place) !== index.get(frame.place)) continue;
      for (let member = open.pop()!; ; member = open.pop()!) {
        component.set(member, index.get(frame.place)!);
        if (member === frame.place) break;
      }
    }
  }
  // (a depth per place along each set's links, from its first place; a link the depths do not explain closes a cycle
  // that does not add up to 0)
  const depthOf = new Map<PlaceId, number>();
  let cycle = false;
  for (const place of links.keys()) {
    if (cycle) break;
    if (depthOf.has(place)) continue;
    depthOf.set(place, 0);
    const queue = [place];
    for (let at = 0; at < queue.length && !cycle; at += 1) {
      const from = queue[at]!;
      for (const { to, weight } of links.get(from) ?? []) {
        if (component.get(to) !== component.get(from)) continue;
        const depth = depthOf.get(from)! + weight;
        const known = depthOf.get(to);
        if (known === undefined) {
          depthOf.set(to, depth);
          queue.push(to);
        } else if (known !== depth) {
          cycle = true;
          break;
        }
      }
    }
  }
  CYCLES.set(program, cycle);
  return cycle;
}

/** The holding of `place` at `path` (#1646): the position a contract walk's cycle certificate reads. */
export function holdingAt(admission: Admission, place: PlaceId, path: readonly string[]): Holding {
  if (!certificate || !copiesCycle(admission)) return NO_HOLDING;
  return admission.pass.program.work.shared(() => {
    const holdings = holdingsOf(admission);
    return holdings.made(holdings.at(place, path));
  });
}
