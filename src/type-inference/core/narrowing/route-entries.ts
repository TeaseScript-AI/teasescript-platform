/*
 * The route rule's ways into a use (the accepted record's r4-451): a `null` reaches a use without a check through a
 * loop's earlier round, a `goto` back to a label, a literal transfer to a file, or a block's body, which inherits no
 * check (ADR 0021 rule 5.5). Each way in is an entry: a loop's head (jumped into by its body's end and each `continue`
 * the graph keeps an edge of), a label (by each `goto` and by falling through), a file's start (by each literal
 * `goto "f.tease"` or `goto script("f.tease")`), a block's body's start. Per key, an entry carries a `null` when a jump
 * into it is seeded (the nearest certified store before the jump reaches it, nothing on the way holding the variable,
 * `RouteHolding`), or when an entry the jump's code is entered at carries and nothing from that entry to the jump holds
 * it; a use is the error when an entry it is entered at carries and nothing from that entry to the use holds it. No jump
 * is made from a block's code but a loop's own, nor by a computed or glob target, nor by a file's `call`.
 */
import type { Expression } from "../../../ast.js";
import { keepText, type WorkLedger } from "../budget.js";
import { each, holds, sorted, steps } from "../charged-iteration.js";
import type { Definition, Key } from "../definitions.js";
import type { FlowNode, FlowRegion } from "../flow-graph.js";
import type { SourceSite } from "../../graph.js";
import type { Work } from "../solver.js";
import { peel } from "./narrowings.js";
import { RouteCandidates, type Candidate, type Candidates } from "./route-candidates.js";
import { CALL, RouteHolding } from "./route-holding.js";
import type { Feasibility, Place } from "./route-tests.js";
import { countIn, type TreeBlock, type TreeStatement } from "./statement-tree.js";

/**
 * Where a segment ends: a place from a callable's body down; `own`, the last place's statement is on the route (the
 * use's own statement, a jump's), else the route ends before the last place's index (a loop body's end, a label's
 * fall-through). `node`: the flow node there; `at`: its offset in its file.
 */
export interface EntryPoint {
  readonly chain: readonly Place[];
  readonly own: boolean;
  readonly node: FlowNode;
  readonly at: number;
}

/**
 * The writer of a route to a use without a check (`NarrowingRoutes.required`): its site, or `null` where the route
 * starts at a block's body with no store of its own; then `block`, the statement registering that block.
 */
export interface RouteWriter {
  readonly writer: SourceSite | null;
  readonly block: SourceSite | null;
}

/** A way into code: its block, the index its code starts at, and a loop's statement, whose header a round evaluates. */
export interface Entry {
  readonly block: TreeBlock;
  readonly start: number;
  readonly header: TreeStatement | null;
}

/** A jump into an entry, at its point; `order`, its place in `Jumps.list`. */
interface Jump {
  readonly into: Entry;
  readonly point: EntryPoint;
  order: number;
}

/** The program's entries and jumps, key-independent, made on the first entry question. */
interface Jumps {
  /** In source order (file, offset). */
  readonly list: readonly Jump[];
  /** Per callable body (a file's top level, a function's or a block's body), its jumps in source order. */
  readonly byBody: ReadonlyMap<TreeBlock, readonly Jump[]>;
  /** Per entry, the jumps whose code it is a nearest entry of, with the level of the jump's chain it stands at. */
  readonly begun: ReadonlyMap<Entry, readonly { readonly jump: Jump; readonly level: number }[]>;
}

/** The entry side of the route query: entries, jumps, the carried relation and the segment rule; `NarrowingRoutes` extends it. */
export abstract class RouteEntries extends RouteCandidates {
  /** Per loop statement, label statement and file body, its entry. */
  readonly #entries = new Map<TreeStatement | TreeBlock, Entry>();
  /** Per block, the indexes of its labels (a file's top level holds them), sorted. */
  #labels: Map<number, number[]> | null = null;
  #jumps: Jumps | null = null;
  /** The bodies of the program's files (`#isFile`). */
  #files: Set<TreeBlock> | null = null;
  /** Per key, the entries that carry a `null` and the writer that seeded each. */
  readonly #carried = new Map<Key, ReadonlyMap<Entry, Definition>>();
  /** Under the program default, per loop or label statement, whether a run is proved to reach it (R2.2 item 1). */
  readonly #reaches = new Map<TreeStatement, boolean>();
  /** Under the program default, per store list and name, the jumps its stores' stretches hold (`#held`). */
  readonly #jumpsHeld = new Map<ReadonlyMap<TreeBlock, Candidates>, Map<string, readonly Jump[]>>();
  /** Which statements hold a variable (r4-451). */
  protected readonly holding: RouteHolding = new RouteHolding(
    this.pass.program.work,
    this.tree,
    functionNames(this.pass.program.flow.regions, this.pass.program.work),
  );
  /** The program's ledger. */
  readonly #work: WorkLedger = this.pass.program.work;

  /**
   * The nearest certified store D′ before a jump's point, in the jump's own body, whose route reaches it with nothing
   * between holding the variable (the jump's seed), or `null`.
   */
  protected abstract seedAt(
    key: Key,
    name: string,
    point: EntryPoint,
    into: Entry,
  ): Work<Definition | null>;

  /**
   * In a program the default holds, the arms its corridors pass through none of (`RouteTests.feasibility`), set by the
   * first `required` there (`NarrowingRoutes`); `null` elsewhere, where every route query is main's. Under it an entry
   * route is taken only by R2.2 (`standsAt`, `reached`), and its relation carries no entry on (r4-451).
   */
  protected feasible: Feasibility | null = null;

  /** The candidates a seed may be, by body: the key's stores (`seedAt`'s). */
  protected abstract seedLists(key: Key): Work<readonly ReadonlyMap<TreeBlock, Candidates>[]>;

  /** Whether a candidate certifies `null` (`seedAt`'s certificate). */
  protected abstract certifies(found: Candidate, key: Key): Work<boolean>;

  /**
   * A way into a stable path's read of `null` at `node` (`key`): the writer of its route, the block registering a
   * block's body where the route starts there, `null` for none or for a reference member.
   */
  protected *entered(node: FlowNode, key: Key): Work<RouteWriter | null> {
    this.#work.charge("eventSteps");
    const { program, contract } = this.pass;
    if (node.expression === undefined || (yield* contract.refReceiver(key))) return null;
    const point = this.pointOf(node);
    const name = rootName(node.expression, this.#work);
    if (point === null || name === null) return null;
    const found = yield* this.entryRoute(key, name, point);
    if (found === null) return null;
    if (found === "body") {
      const creation = program.handlerOf(node)!.creation;
      return creation.span === null
        ? null
        : {
            writer: null,
            block: {
              file: creation.file,
              start: creation.span.start.offset,
              end: creation.span.end.offset,
            },
          };
    }
    const writer = found.value === undefined ? null : (program.places[found.value]?.site ?? null);
    return writer === null ? null : { writer, block: null };
  }

  /**
   * R2.2 under the program default (r4-451): whether a run is proved to reach the entry and, after it, a node at
   * `chain`: the entry a loop or a label (never a file or a block's body) a run reaches (`#reached`), the node standing
   * at it (`clear`). Outside the default, true; callers ask it only under the default.
   */
  protected standsAt(entry: Entry, node: FlowNode, chain: readonly Place[]): boolean {
    this.#work.charge("eventSteps");
    const feasible = this.feasible;
    if (feasible === null) return true;
    const at = entry.header ?? (entry.start > 0 ? entry.block.statements[entry.start - 1]! : null);
    return (
      at !== null &&
      this.#reached(feasible, at) &&
      this.clear(feasible, feasible.entryHazards, node, chain, at)
    );
  }

  /**
   * R2.2 item 1: a loop statement that stands where a route may promote (`clear` from the program's start), or a label
   * in the top level of the file the session starts in with nothing before it a route may not pass. One answer per
   * entry statement.
   */
  #reached(feasible: Feasibility, at: TreeStatement): boolean {
    this.#work.charge("eventSteps");
    const known = this.#reaches.get(at);
    if (known !== undefined) return known;
    const { program } = this.pass;
    const site = { file: at.file, start: at.start, end: at.end };
    let answer = false;
    if (at.loop !== null) {
      // (the node control reaches just before the loop, and the loop's own place)
      const before = program.flow.placeOf(site);
      answer =
        before !== null &&
        before !== undefined &&
        this.clear(feasible, feasible.entryHazards, before, this.placesOf(at), null);
    } else {
      const node = program.flow.statementAt(site);
      const before = node === undefined ? null : program.dom.idom(node);
      answer =
        feasible.files.has(at.block) &&
        before !== null &&
        program.dom.edom(before) === null &&
        countIn(this.#work, feasible.entryHazards.get(at.block.id) ?? [], 0, at.index) === 0;
    }
    this.#reaches.set(at, answer);
    return answer;
  }

  /**
   * Whether, in a program the default holds, a node at `chain` stands where a route may promote (#1938): at the program's
   * start (`at` `null`, `NarrowingRoutes.#plain`) or at the entry statement `at` (R2.2 items 2 and 3). Its chain starts
   * in a file's body and, after `at`, passes it (after a label, into a loop's body); its boundary is none or `at`'s
   * label; no arm on it is one a run is not proved to enter, none a loop's body but `at`'s own; no statement of it holds
   * a call in its own expressions (`headed`); and before it in each block nothing a route may not pass (`hazards`),
   * counted after `at` in `at`'s block.
   */
  protected clear(
    feasible: Feasibility,
    hazards: ReadonlyMap<number, readonly number[]>,
    node: FlowNode,
    chain: readonly Place[],
    at: TreeStatement | null,
  ): boolean {
    this.#work.charge("eventSteps");
    const { unentered, files, headed } = feasible;
    if (chain.length === 0 || !files.has(chain[0]!.block)) return false;
    const boundary = this.pass.program.dom.edom(node);
    const label =
      at === null || at.loop !== null
        ? null
        : (this.pass.program.flow.statementAt({ file: at.file, start: at.start, end: at.end }) ??
          null);
    if (boundary !== null && (label === null || boundary !== label)) return false;
    let level = at === null ? -1 : chain.length;
    if (at !== null) {
      let index = 0;
      for (const _ of steps(this.#work, "eventSteps", () => index < chain.length)) {
        if (chain[index]!.block === at.block) {
          level = index;
          break;
        }
        index += 1;
      }
      if (level === chain.length) return false;
      const here = chain[level]!.index;
      if (
        at.loop === null
          ? here <= at.index
          : here !== at.index || chain[level + 1]?.block !== at.arms[0]
      )
        return false;
    }
    let index = 0;
    for (const _ of steps(this.#work, "eventSteps", () => index < chain.length)) {
      const place = chain[index]!;
      const owner = place.block.owner;
      if (
        unentered.has(place.block) ||
        (owner !== null && owner.loop !== null && owner !== at) ||
        (place.index >= 0 && headed.has(place.block.statements[place.index]!)) ||
        countIn(
          this.#work,
          hazards.get(place.block.id) ?? [],
          index === level ? at!.index + 1 : 0,
          place.index,
        ) > 0
      )
        return false;
      index += 1;
    }
    return true;
  }

  /** A use's point: its place, its own statement on the route. */
  protected pointOf(node: FlowNode): EntryPoint | null {
    this.#work.charge("eventSteps");
    const chain = this.chainOf(node);
    return chain === null || node.span === null || chain[chain.length - 1]!.index < 0
      ? null
      : { chain, own: true, node, at: node.span.start.offset };
  }

  /** Whether a node stands in a block's body itself (not in a callable a block may run). */
  protected inBody(node: FlowNode): boolean {
    this.#work.charge("eventSteps");
    return this.pass.program.flow.regions[node.region]?.kind === "handler";
  }

  /**
   * The writer of an entry route to the use at `point` of `key` (its variable named `name`): the seed of the innermost
   * entry the use's code is entered at that carries with nothing from it to the use holding the variable; `"body"`
   * where only its block's body's start does so (the use's chain starts in a block's body); `null` for none.
   */
  protected *entryRoute(
    key: Key,
    name: string,
    point: EntryPoint,
  ): Work<Definition | "body" | null> {
    this.#work.charge("eventSteps");
    // (under the program default, the relation only once the use stands at an entry, R2.2)
    const fallback = this.feasible !== null;
    let carried = fallback ? null : yield* this.#relation(key, name);
    const calls = this.pass.definitions.ownedAway(key);
    let level = point.chain.length;
    for (const _ of steps(this.#work, "eventSteps", () => level > 0)) {
      level -= 1;
      const entry = this.#nearest(point.chain, level);
      if (entry === null || (fallback && !this.standsAt(entry, point.node, point.chain))) continue;
      carried ??= yield* this.#relation(key, name);
      const writer = carried.get(entry);
      if (writer !== undefined && this.#open(name, calls, entry, level, point)) return writer;
    }
    if (fallback) return null;
    const root = point.chain[0]!.block;
    const handler = this.pass.program.handlerOf(point.node);
    return handler !== null &&
      this.tree.root(handler.id) === root &&
      this.#open(name, calls, { block: root, start: 0, header: null }, 0, point)
      ? "body"
      : null;
  }

  /**
   * Whether a writer's segment, from the store at `from` to `point`, holds nothing of the variable: the rest of each
   * block it leaves (a loop's header too, which a round evaluates again), the statements between, and the headers and
   * statements before the point in each block it enters (r4-451's segment from D′ to J).
   */
  protected writerOpen(key: Key, name: string, from: readonly Place[], point: EntryPoint): boolean {
    this.#work.charge("eventSteps");
    const calls = this.pass.definitions.ownedAway(key);
    const to = point.chain;
    let level = 0;
    for (const _ of steps(
      this.#work,
      "eventSteps",
      () =>
        level < from.length &&
        level < to.length &&
        from[level]!.block === to[level]!.block &&
        from[level]!.index === to[level]!.index,
    ))
      level += 1;
    if (level >= from.length || level >= to.length || from[level]!.block !== to[level]!.block)
      return false;
    let up = from.length;
    for (const _ of steps(this.#work, "eventSteps", () => up - 1 > level)) {
      up -= 1;
      const { block, index } = from[up]!;
      if (this.#holdsIn(name, calls, block, index + 1, block.statements.length)) return false;
      const owner = block.owner;
      if (owner !== null && owner.loop !== null && this.#heldBy(name, calls, owner)) return false;
    }
    return this.#down(name, calls, level, from[level]!.index + 1, point);
  }

  /** Whether nothing from an entry at `level` of the point's chain to the point holds the variable (r4-451 on T → J). */
  #open(name: string, calls: boolean, entry: Entry, level: number, point: EntryPoint): boolean {
    this.#work.charge("eventSteps");
    const chain = point.chain;
    if (chain[level]?.block !== entry.block || chain[level]!.index < entry.start) return false;
    if (entry.header !== null && this.#heldBy(name, calls, entry.header)) return false;
    return this.#down(name, calls, level, entry.start, point);
  }

  /**
   * From index `low` of the point's chain's block at `level` down to the point: no statement before it holding the
   * variable or closed by the shared layer (it always leaves; a call, for a key a callee may store), every entered arm
   * live and its header holding nothing, and the point's own statement holding nothing.
   */
  #down(name: string, calls: boolean, level: number, low: number, point: EntryPoint): boolean {
    this.#work.charge("eventSteps");
    const chain = point.chain;
    let at = level;
    let from = low;
    for (const _ of steps(this.#work, "eventSteps", () => at < chain.length)) {
      const { block, index } = chain[at]!;
      if (at > level && !block.live) return false;
      if (
        this.closed(block, from, index, null, calls) ||
        this.#holdsIn(name, calls, block, from, index)
      )
        return false;
      const statement = block.statements[index];
      if ((at < chain.length - 1 || point.own) && statement !== undefined)
        if (this.#heldBy(name, calls, statement)) return false;
      at += 1;
      from = 0;
    }
    return true;
  }

  /** Whether a statement's own expressions hold the variable, or a call where a callee may store it. */
  #heldBy(name: string, calls: boolean, statement: TreeStatement): boolean {
    this.#work.charge("eventSteps");
    return this.holding.holds(name, statement) || (calls && this.holding.holds(CALL, statement));
  }

  /** Whether statements `low` to `high` of a block hold the variable in any part, or a call where a callee may store it. */
  #holdsIn(name: string, calls: boolean, block: TreeBlock, low: number, high: number): boolean {
    this.#work.charge("eventSteps");
    return (
      this.holding.holdsIn(name, block, low, high) ||
      (calls && this.holding.holdsIn(CALL, block, low, high))
    );
  }

  /**
   * Per key, the entries that carry a `null`: every jump tried as a seed in source order, then each carried entry
   * passed on, first reached first, to the jumps it begins whose segment from it holds nothing of the variable. Each
   * entry carries the writer of the seed that reached it first, whichever use asks first.
   */
  *#relation(key: Key, name: string): Work<ReadonlyMap<Entry, Definition>> {
    this.#work.charge("eventSteps");
    const known = this.#carried.get(key);
    if (known !== undefined) return known;
    const jumps = this.#jumpIndex();
    const calls = this.pass.definitions.ownedAway(key);
    const carried = new Map<Entry, Definition>();
    const queue: Entry[] = [];
    for (const jump of each(this.#work, "eventSteps", yield* this.#tries(key, name, calls))) {
      if (carried.has(jump.into)) continue;
      const writer = yield* this.seedAt(key, name, jump.point, jump.into);
      if (writer === null) continue;
      carried.set(jump.into, writer);
      queue.push(jump.into);
    }
    // (under the program default, a seed alone: R2.2 states one entry, so no entry carries on)
    let next = this.feasible === null ? 0 : queue.length;
    for (const _ of steps(this.#work, "eventSteps", () => next < queue.length)) {
      const entry = queue[next]!;
      next += 1;
      for (const { jump, level } of each(this.#work, "eventSteps", jumps.begun.get(entry) ?? [])) {
        if (carried.has(jump.into) || !this.#open(name, calls, entry, level, jump.point)) continue;
        carried.set(jump.into, carried.get(entry)!);
        queue.push(jump.into);
      }
    }
    this.#carried.set(key, carried);
    return carried;
  }

  /**
   * The jumps a key's seed may be found at, in source order: those after one of its certified `null` stores in that
   * store's body, before the first statement after it, in its block or a block around it, whose own expressions hold
   * the variable (or a call, where a callee may store it). A seed's store reaches its jump with nothing holding the
   * variable between, so no other jump has one; a key thus tries only its stores' own stretches, not every jump.
   */
  *#tries(key: Key, name: string, calls: boolean): Work<readonly Jump[]> {
    this.#work.charge("eventSteps");
    const { byBody } = this.#jumpIndex();
    // (a program without jumps: no store's search, no stretch)
    if (byBody.size === 0) return [];
    if (this.feasible !== null) {
      // (under the program default, every jump a store's stretch holds, the same for each key of a list, `seedAt`
      // certifying its writer: a writer it finds reaches its jump with nothing holding the variable between, so its
      // stretch holds that jump and it would be tried here; R2.2's jumps are few)
      const seen = new Set<Jump>();
      const tried: Jump[] = [];
      for (const lists of each(this.#work, "eventSteps", yield* this.seedLists(key)))
        for (const jump of each(this.#work, "eventSteps", this.#held(lists, name, calls, byBody)))
          if (!seen.has(jump)) {
            seen.add(jump);
            tried.push(jump);
          }
      return sorted(this.#work, "eventSteps", tried, (a, b) => a.order - b.order);
    }
    // (the key's stores in bodies that make a jump: each list's bodies or the jumps' bodies, whichever are fewer)
    const starts: Candidate[] = [];
    for (const lists of each(this.#work, "eventSteps", yield* this.seedLists(key)))
      if (lists.size < byBody.size) {
        for (const [body, { list }] of each(this.#work, "eventSteps", lists))
          if (byBody.get(body) !== undefined)
            for (const found of each(this.#work, "eventSteps", list)) starts.push(found);
      } else
        for (const [body] of each(this.#work, "eventSteps", byBody))
          for (const found of each(this.#work, "eventSteps", lists.get(body)?.list ?? []))
            starts.push(found);
    // (per body, its stores' stretches as offsets, merged so that each of its jumps is looked at once)
    const stretches = new Map<TreeBlock, { from: number; to: number }[]>();
    for (const start of each(this.#work, "eventSteps", starts)) {
      const body = start.chain[0]!.block;
      const jumps = byBody.get(body)!;
      const stretch = { from: start.start, to: this.#cut(name, calls, start.chain) };
      // (a store certified only where its stretch holds a jump: the certificate is the costly part)
      const first = this.#after(jumps, stretch.from, 0);
      if (
        first >= jumps.length ||
        jumps[first]!.point.at >= stretch.to ||
        !(yield* this.certifies(start, key))
      )
        continue;
      const known = stretches.get(body);
      if (known === undefined) stretches.set(body, [stretch]);
      else known.push(stretch);
    }
    const tried: Jump[] = [];
    for (const [body, known] of each(this.#work, "eventSteps", stretches)) {
      const jumps = byBody.get(body)!;
      sorted(this.#work, "eventSteps", known, (a, b) => a.from - b.from);
      let low = 0;
      for (const { from, to } of each(this.#work, "eventSteps", known)) {
        // (the first jump past the stretch's start, and not before where the last stretch's scan stopped)
        low = this.#after(jumps, from, low);
        for (const _ of steps(
          this.#work,
          "eventSteps",
          () => low < jumps.length && jumps[low]!.point.at < to,
        )) {
          tried.push(jumps[low]!);
          low += 1;
        }
      }
    }
    return sorted(this.#work, "eventSteps", tried, (a, b) => a.order - b.order);
  }

  /**
   * Under the program default, the jumps any store of a list holds in its stretch, uncertified (as `#tries` finds them
   * outside it), made once per list, name and `calls`: a prefix's whole stores serve each of its keys alike, so many
   * keys of one record never scan or certify its stores again.
   */
  #held(
    lists: ReadonlyMap<TreeBlock, Candidates>,
    name: string,
    calls: boolean,
    byBody: ReadonlyMap<TreeBlock, readonly Jump[]>,
  ): readonly Jump[] {
    this.#work.charge("eventSteps");
    const memo = `${name}${calls ? "\0calls" : ""}`;
    const byName = this.#jumpsHeld.get(lists);
    const known = byName?.get(memo);
    if (known !== undefined) return known;
    const stretches = new Map<TreeBlock, { from: number; to: number }[]>();
    for (const [body, jumps] of each(this.#work, "eventSteps", byBody))
      for (const start of each(this.#work, "eventSteps", lists.get(body)?.list ?? [])) {
        const stretch = { from: start.start, to: this.#cut(name, calls, start.chain) };
        const first = this.#after(jumps, stretch.from, 0);
        if (first >= jumps.length || jumps[first]!.point.at >= stretch.to) continue;
        const list = stretches.get(body);
        if (list === undefined) stretches.set(body, [stretch]);
        else list.push(stretch);
      }
    const made: Jump[] = [];
    for (const [body, known] of each(this.#work, "eventSteps", stretches)) {
      const jumps = byBody.get(body)!;
      // (the merge needs the stretches by start, which this sort gives whatever order the lists come in: |L| log |L|
      // charged, once per list, name and `calls`, never per key)
      sorted(this.#work, "eventSteps", known, (a, b) => a.from - b.from);
      let low = 0;
      for (const { from, to } of each(this.#work, "eventSteps", known)) {
        low = this.#after(jumps, from, low);
        for (const _ of steps(
          this.#work,
          "eventSteps",
          () => low < jumps.length && jumps[low]!.point.at < to,
        )) {
          made.push(jumps[low]!);
          low += 1;
        }
      }
    }
    keepText(this.#work, memo.length);
    if (byName === undefined) this.#jumpsHeld.set(lists, new Map([[memo, made]]));
    else byName.set(memo, made);
    return made;
  }

  /** The index of the first jump of a body's `jumps` from `low` on past offset `from` (a binary search). */
  #after(jumps: readonly Jump[], from: number, low: number): number {
    this.#work.charge("eventSteps");
    let first = low;
    let high = jumps.length;
    for (const _ of steps(this.#work, "eventSteps", () => first < high)) {
      const middle = (first + high) >> 1;
      if (jumps[middle]!.point.at <= from) first = middle + 1;
      else high = middle;
    }
    return first;
  }

  /**
   * Where a store's stretch ends: the start of the first statement after its own, in its block or the nearest block
   * around it that has one, whose own expressions hold the variable (or a call, where a callee may store it).
   */
  #cut(name: string, calls: boolean, chain: readonly Place[]): number {
    this.#work.charge("eventSteps");
    let level = chain.length;
    for (const _ of steps(this.#work, "eventSteps", () => level > 0)) {
      level -= 1;
      const { block, index } = chain[level]!;
      const held = this.holding.after(name, block, index);
      const call = calls ? this.holding.after(CALL, block, index) : null;
      const first = held === null || (call !== null && call < held) ? call : held;
      if (first !== null) return block.statements[first]!.start;
    }
    return Infinity;
  }

  /**
   * The entry a chain's code at `level` is entered at nearest: the last label before it in its block, else the loop
   * whose body the block is, else the file whose top level it is; `null` for none (an arm, a function's or a block's
   * body).
   */
  #nearest(chain: readonly Place[], level: number): Entry | null {
    this.#work.charge("eventSteps");
    const { block, index } = chain[level]!;
    const labels = this.#labelIndex().get(block.id);
    if (labels !== undefined) {
      let low = 0;
      let high = labels.length;
      for (const _ of steps(this.#work, "eventSteps", () => low < high)) {
        const middle = (low + high) >> 1;
        if (labels[middle]! < index) low = middle + 1;
        else high = middle;
      }
      if (low > 0) return this.#entry(block.statements[labels[low - 1]!]!);
    }
    if (block.owner !== null) return block.owner.loop === null ? null : this.#entry(block.owner);
    return level === 0 && this.#isFile(block) ? this.#entry(block) : null;
  }

  /** Whether a callable's body is a file's top level. */
  #isFile(block: TreeBlock): boolean {
    this.#work.charge("eventSteps");
    if (this.#files === null) {
      const files = new Set<TreeBlock>();
      for (const region of each(this.#work, "indexSteps", this.pass.program.flow.regions)) {
        const root = region.kind === "file" ? this.tree.root(region.id) : undefined;
        if (root !== undefined) files.add(root);
      }
      this.#files = files;
    }
    return this.#files.has(block);
  }

  /** The entry of a loop or a label statement, or of a file's body. */
  #entry(at: TreeStatement | TreeBlock): Entry {
    this.#work.charge("eventSteps");
    let entry = this.#entries.get(at);
    if (entry === undefined) {
      entry =
        "statements" in at
          ? { block: at, start: 0, header: null }
          : at.loop !== null
            ? { block: at.arms[0]!, start: 0, header: at }
            : { block: at.block, start: at.index + 1, header: null };
      this.#entries.set(at, entry);
    }
    return entry;
  }

  /** Per block, the indexes of its labels, from one walk of the tree's blocks. */
  #labelIndex(): Map<number, number[]> {
    this.#work.charge("indexSteps");
    if (this.#labels !== null) return this.#labels;
    const labels = new Map<number, number[]>();
    for (const block of each(this.#work, "indexSteps", this.tree.blocks))
      for (const statement of each(this.#work, "indexSteps", block.statements))
        if (statement.statement.kind === "labelStatement") {
          const list = labels.get(block.id);
          if (list === undefined) labels.set(block.id, [statement.index]);
          else list.push(statement.index);
        }
    this.#labels = labels;
    return labels;
  }

  /**
   * The program's jumps into entries (key-independent): each loop's back edges, each label's `goto`s and fall-through,
   * each literal transfer; and per entry the jumps whose code it is a nearest entry of.
   */
  #jumpIndex(): Jumps {
    this.#work.charge("indexSteps");
    if (this.#jumps !== null) return this.#jumps;
    const { program } = this.pass;
    const flow = program.flow;
    let list: Jump[] = [];
    // a jump made by block code is none, but a loop's own inside a block's body
    const outside = (node: FlowNode): boolean => {
      this.#work.charge("indexSteps");
      return (
        program.live(node) &&
        (!program.inBlockCode(node) || program.handlerOf(node) !== null) &&
        node.span !== null
      );
    };
    for (const block of each(this.#work, "indexSteps", this.tree.blocks))
      for (const statement of each(this.#work, "indexSteps", block.statements)) {
        const loop = statement.loop;
        if (loop === null) continue;
        const body = statement.arms[0]!;
        // (no round after a round where the graph has no way from the head into the body: P7's one round)
        // (nor after a `for` over a literal of one element, whose second round the graph keeps and no run has)
        const again =
          statement.statement.kind === "whileStatement"
            ? program.live(loop.body)
            : program.live(loop.body) &&
              holds(this.#work, "indexSteps", loop.head.successors, loop.body) &&
              !flow.isDeadEdge(loop.head, loop.body) &&
              !(
                statement.statement.kind === "forStatement" &&
                oneElement(statement.statement.iterable, this.#work)
              );
        if (!again) continue;
        for (const before of each(this.#work, "indexSteps", loop.head.predecessors)) {
          if (
            !program.live(before) ||
            flow.isDeadEdge(before, loop.head) ||
            !holds(this.#work, "indexSteps", before.loops, loop.head) ||
            (program.inBlockCode(before) && program.handlerOf(before) === null)
          )
            continue;
          const point: EntryPoint | null =
            before.statement?.kind === "continueStatement"
              ? this.#pointAt(before)
              : { chain: this.#bodyEnd(statement), own: false, node: before, at: body.end };
          if (point !== null) list.push({ into: this.#entry(statement), point, order: -1 });
        }
      }
    for (const jump of each(this.#work, "indexSteps", flow.jumps)) {
      if (!outside(jump.node)) continue;
      const point = this.#pointAt(jump.node);
      if (point === null) continue;
      if (jump.kind === "label") {
        for (const target of each(this.#work, "indexSteps", jump.targets)) {
          const label = this.#labelAt(target);
          if (label !== null && !flow.isDeadEdge(jump.node, target))
            list.push({ into: this.#entry(label), point, order: -1 });
        }
        continue;
      }
      const path = literalPath(jump.node, this.#work);
      // (a computed transfer enters no file: r4-451's give-up, so its files are not scanned)
      if (path === null) continue;
      for (const file of each(this.#work, "indexSteps", jump.files)) {
        const root = file.path === path ? this.tree.root(file.id) : undefined;
        if (root !== undefined && !flow.isDeadEdge(jump.node, file.entry))
          list.push({ into: this.#entry(root), point, order: -1 });
      }
    }
    // a label's fall-through: the code before it in its block goes on into it
    for (const [id, labels] of each(this.#work, "indexSteps", this.#labelIndex())) {
      const block = this.tree.blocks[id]!;
      for (const index of each(this.#work, "indexSteps", labels)) {
        const label = block.statements[index]!;
        const node = flow.statementAt({ file: label.file, start: label.start, end: label.end });
        const before = node?.fallthrough;
        if (node === undefined || before === undefined || before === null || !outside(before))
          continue;
        if (flow.isDeadEdge(before, node)) continue;
        const chain = this.placesOf(label);
        list.push({
          into: this.#entry(label),
          point: { chain, own: false, node: before, at: label.start },
          order: -1,
        });
      }
    }
    sorted(
      this.#work,
      "indexSteps",
      list,
      (a, b) => a.point.node.file - b.point.node.file || a.point.at - b.point.at,
    );
    // (under the program default, only the jumps that stand at the loop or label they enter a run reaches, R2.2: the
    // same for every key, so each key's relation tries no other)
    if (this.feasible !== null) {
      const standing: Jump[] = [];
      for (const jump of each(this.#work, "indexSteps", list))
        if (this.standsAt(jump.into, jump.point.node, jump.point.chain)) standing.push(jump);
      list = standing;
    }
    const begun = new Map<Entry, { readonly jump: Jump; readonly level: number }[]>();
    let order = 0;
    for (const jump of each(this.#work, "indexSteps", list)) {
      jump.order = order;
      order += 1;
      let level = jump.point.chain.length;
      for (const _ of steps(this.#work, "indexSteps", () => level > 0)) {
        level -= 1;
        const entry = this.#nearest(jump.point.chain, level);
        if (entry === null || entry === jump.into) continue;
        const known = begun.get(entry);
        if (known === undefined) begun.set(entry, [{ jump, level }]);
        else known.push({ jump, level });
      }
    }
    const byBody = new Map<TreeBlock, Jump[]>();
    for (const jump of each(this.#work, "indexSteps", list)) {
      const body = jump.point.chain[0]!.block;
      const known = byBody.get(body);
      if (known === undefined) byBody.set(body, [jump]);
      else known.push(jump);
    }
    this.#jumps = { list, begun, byBody };
    return this.#jumps;
  }

  /** A loop body's end as a place: the loop's places and its body's index past its last statement. */
  #bodyEnd(loop: TreeStatement): Place[] {
    this.#work.charge("indexSteps");
    const chain = this.placesOf(loop);
    const body = loop.arms[0]!;
    chain.push({ block: body, index: body.statements.length });
    return chain;
  }

  /** A statement node's point: its place, its own statement on the route; `null` outside the bodies. */
  #pointAt(node: FlowNode): EntryPoint | null {
    this.#work.charge("indexSteps");
    const chain = this.chainOf(node);
    if (chain === null || node.span === null || chain[chain.length - 1]!.index < 0) return null;
    return { chain, own: true, node, at: node.span.start.offset };
  }

  /** The label statement a `goto`'s target node is. */
  #labelAt(node: FlowNode): TreeStatement | null {
    this.#work.charge("indexSteps");
    if (node.span === null) return null;
    const statement = this.tree.statementAt(node.file, node.span.start.offset);
    return statement?.statement.kind === "labelStatement" ? statement : null;
  }
}

/** Whether an iterable is a literal of exactly one element: a list, a set or a dict literal, or a range of one number. */
function oneElement(iterable: Expression, work: WorkLedger): boolean {
  work.charge("indexSteps");
  const at = peel(iterable, work);
  if (at.kind === "listLiteral" || at.kind === "setLiteral") return at.elements.length === 1;
  if (at.kind === "dictLiteral") return at.entries.length === 1;
  if (at.kind !== "rangeExpression") return false;
  const start = peel(at.start, work);
  const end = peel(at.end, work);
  // (`a..b` leaves out `b`, `a..=b` takes it)
  return (
    start.kind === "numberLiteral" &&
    end.kind === "numberLiteral" &&
    end.value - start.value === (at.inclusive ? 0 : 1)
  );
}

/** The names of a program's functions. */
function functionNames(regions: readonly FlowRegion[], work: WorkLedger): ReadonlySet<string> {
  work.charge("indexSteps");
  const names = new Set<string>();
  for (const region of each(work, "indexSteps", regions))
    if (region.kind === "function") names.add(region.declaration.name.name);
  return names;
}

/** The variable a stable path's read starts at, by its name (`RouteHolding` keys by name), or `null`. */
export function rootName(expression: Expression, work: WorkLedger): string | null {
  work.charge("exactQueries");
  let at = peel(expression, work);
  for (const _ of steps(work, "exactQueries", () => at.kind === "propertyAccessExpression"))
    if (at.kind === "propertyAccessExpression") at = peel(at.object, work);
  return at.kind === "identifier" ? at.name : null;
}

/** The file a transfer names literally: `goto "f.tease"`, or `goto script("f.tease")` with a plain text; else `null`. */
function literalPath(node: FlowNode, work: WorkLedger): string | null {
  work.charge("indexSteps");
  const statement = node.statement;
  if (statement?.kind !== "gotoStatement") return null;
  const target = statement.target;
  if (target.kind === "fileTarget") return target.path;
  if (target.kind !== "scriptTarget") return null;
  let call: Expression = target.expression;
  for (const _ of steps(work, "indexSteps", () => call.kind === "parenthesizedExpression"))
    if (call.kind === "parenthesizedExpression") call = call.expression;
  if (
    call.kind !== "callExpression" ||
    call.callee.kind !== "identifier" ||
    call.callee.name !== "script" ||
    call.arguments.length !== 1 ||
    call.arguments[0]!.kind !== "positionalArgument"
  )
    return null;
  const text = call.arguments[0]!.value;
  if (text.kind !== "stringLiteral" || text.parts.length !== 1) return null;
  const part = text.parts[0]!;
  return part.kind === "stringText" ? part.value : null;
}
