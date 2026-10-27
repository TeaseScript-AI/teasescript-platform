import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import { joinParts, keepText, textUnits, type WorkLedger } from "./budget.js";
import { operatorOf } from "./contract.js";
import {
  keptPrefixes,
  keyPlace,
  sortCost,
  type Definition,
  type Key,
  type PositionRange,
} from "./definitions.js";
import { withoutEmpty } from "./exact-path.js";
import type { FlowLoop, FlowNode } from "./flow-graph.js";
import { makeItem, mergeItems, type ContextWord, type Item, type ItemTag } from "./items.js";
import { locationOf, stablePath, type Narrowing, type NarrowingIndex } from "./narrowing.js";
import { countIn, lowerBound } from "./narrowing-statements.js";
import { operationItems } from "./operator-table.js";
import type { Work } from "./solver.js";

/*
 * N2 and N5 of stage 3b (checkpoint 9, TABLE §13 N2, N5, §13.3): whether a narrowing definition G still answers a read
 * at n. X1, X4, X5 and X6 as §3 writes them, X7 as its flat veto, taken over G's dependency keys with N2's events: each
 * dependency key's own events (the location's key with the keys below it, each prefix's own definitions, each index or
 * key variable's), the call sites where an owner of one of them, or a callable holding an invalidation of a collection
 * of the path, lies outside its activation, and the invalidation lists of the path's collections. Another narrowing is
 * never an event. Every event is counted in intervals of the dominator walk by binary search in those existing lists,
 * never in a copy per (key × node). N5: for a read inside a loop that does not enclose G, and between G and the read, a
 * **preserving store** to the refined location itself is no event: a store whose value, evaluated with the location's
 * reads taken as G's filtered kinds, keeps its kinds within them. Each (store, filtered kind set) is evaluated once and
 * enters the sparse subset of its location and kind set, which is subtracted from the location key's own list only:
 * q(I) = count(E in I) − count(P in I).
 */

/** An event list of G with the word a first event in it gives (§3.4). */
interface EventList {
  readonly positions: readonly number[];
  readonly word: ContextWord;
  /** The location key's own list, from which the preserving subset is subtracted. */
  readonly own: boolean;
}

/**
 * Whether every kind of `items` lies within `kinds` (an integer within a number; anything within `unknown`): each item
 * compared with each kind, charged.
 */
function keptWithin(items: readonly Item[], kinds: readonly ItemTag[], work: WorkLedger): boolean {
  work.charge("exactValues", (items.length + 1) * Math.max(1, kinds.length));
  if (kinds.includes("unknown")) return true;
  return items.every(
    (item) =>
      item.tag === "empty" ||
      kinds.includes(item.tag) ||
      (item.tag === "integer" && kinds.includes("number")),
  );
}

/** The kind set's signature: its tags, each once, sorted (a sort charged). */
function kindsText(kinds: readonly ItemTag[], work: WorkLedger): string {
  work.charge("eventSteps", sortCost(kinds.length) + 1);
  return [...new Set(kinds)].sort().join(",");
}

export class NarrowingEvents {
  /** Per collection key, whether a callable ordinary code may run outside its activation holds an invalidation (N2). */
  readonly #outside = new Map<Key, boolean>();
  /** Per key, its assignments by the refined location they store, made on the key's first question (N5's candidates). */
  readonly #stored = new Map<Key, ReadonlyMap<string, readonly Definition[]>>();
  /** Per (store, filtered kind set): whether the store preserves the kinds (N5). */
  readonly #preserves = new Map<string, boolean>();
  /** Per (location, filtered kind set): the positions of its preserving stores, sorted (N5's sparse subset). */
  readonly #subsets = new Map<string, readonly number[]>();
  /** Per key (and per key with its descendants), its definitions' text offsets by file (an operand region's X6). */
  readonly #text = new Map<string, ReadonlyMap<number, readonly number[]>>();
  /** Per narrowing, its event lists (X6's, by position) and its prefixes' keys, made once. */
  readonly #eventsOf = new Map<Narrowing, readonly EventList[]>();
  readonly #prefixesOf = new Map<Narrowing, readonly Key[]>();
  /** Per loop head, its loop. */
  readonly #loops = new Map<FlowNode, FlowLoop>();

  public constructor(
    readonly pass: CorePass,
    readonly index: NarrowingIndex,
  ) {
    pass.program.work.charge("indexSteps", pass.program.flow.loops.length);
    for (const loop of pass.program.flow.loops) this.#loops.set(loop.head, loop);
  }

  get #work(): WorkLedger {
    return this.pass.program.work;
  }

  /**
   * N2: whether G answers a read at `node`, or the word of the first condition that fails: X1 (`dead-code`), X4
   * (`label`, `call`), X5 with N5 (`loop`), X6 with N5 (the first event's word), X7 (`handler`); a path through a
   * reference (a speaker, a handle, a value holding one) is never narrowed (N8, F19a: `unmodelled`). `kinds` are G's
   * filtered kinds, which N5's preserving test needs; without them no store is preserving.
   */
  public *holds(
    g: Narrowing,
    node: FlowNode,
    kinds: readonly ItemTag[] | null,
  ): Work<ContextWord | null> {
    const { program } = this.pass;
    program.work.charge("exactQueries");
    if (!program.live(node) || !program.live(g.node)) return "dead-code"; // X1
    if (yield* this.pass.contract.refReceiver(g.key)) return "unmodelled";
    if (g.region !== null) return this.#inOperand(g, node);
    if (!program.dom.dominates(g.node, node)) return "branch";
    const boundary = program.dom.edom(node);
    if (program.dom.edom(g.node) !== boundary)
      return boundary?.statement?.kind === "labelStatement" ? "label" : "call"; // X4
    const events = this.#events(g);
    // X5 with N5: every event of a dependency key inside a loop around the read that does not enclose G
    for (const head of node.loops) {
      program.work.charge("eventSteps", 1 + g.node.loops.length);
      if (g.node.loops.includes(head)) continue;
      const loop = this.#loops.get(head);
      if (loop === undefined) return "loop";
      if ((yield* this.#first(g, events, this.#inside(loop), kinds)) !== null) return "loop";
    }
    // X6 with N5: the events strictly after G and not after the read
    const word = yield* this.#first(g, events, this.pass.lists.spanBetween(g.node, node), kinds);
    if (word !== null) return word;
    // X7: block code, and the flat veto of a handler store with a registration before the read
    if (program.blockReachable(node)) return "handler";
    if (this.#touched(g) && this.#registered(node)) return "handler";
    return null;
  }

  /**
   * N2 in an operand region: the region is one expression's, which the read stands in, so X4 and X5 hold with its
   * test's, no store stands between them, and X6's events are its calls, adds, removals and invalidations completed
   * between the test's end and the read, left to right (a call after its arguments): each list's text offsets in that
   * range, a binary search each.
   */
  #inOperand(g: Narrowing, node: FlowNode): ContextWord | null {
    const { program } = this.pass;
    const region = g.region!;
    const at = node.span?.start.offset ?? -1;
    if (node.file !== region.file || at < region.start || at > region.end) return "branch";
    const boundary = program.dom.edom(node);
    if (program.dom.edom(g.node) !== boundary)
      return boundary?.statement?.kind === "labelStatement" ? "label" : "call"; // X4
    const lists: (readonly [ReadonlyMap<number, readonly number[]> | undefined, ContextWord])[] = [
      [this.#texts(g.key, true), "branch"],
      ...this.#prefixes(g).map((prefix) => [this.#texts(prefix, false), "branch"] as const),
      ...g.variables.map((variable) => [this.#texts(variable, true), "branch"] as const),
      ...g.collections.map(
        (collection) => [this.index.invalidations(collection)?.texts, "branch"] as const,
      ),
    ];
    if (this.#ownedAway(g)) lists.push([this.index.statements.callTexts, "call"]);
    let first = Infinity;
    let word: ContextWord | null = null;
    for (const [byFile, found] of lists) {
      const offsets = byFile?.get(region.file);
      program.work.charge("eventSteps");
      if (offsets === undefined) continue;
      const index = lowerBound(program.work, offsets, region.start);
      if (index < offsets.length && offsets[index]! < at && offsets[index]! < first) {
        first = offsets[index]!;
        word = found;
      }
    }
    if (word !== null) return word;
    if (program.blockReachable(node)) return "handler";
    if (this.#touched(g) && this.#registered(node)) return "handler";
    return null;
  }

  /**
   * A key's live definitions outside block code (with `below`, its descendants' too) by where their sites end, per
   * file, sorted: the order an expression completes them in (an operand region's X6).
   */
  #texts(key: Key, below: boolean): ReadonlyMap<number, readonly number[]> {
    const memo = below ? joinParts(key, "*") : key;
    const known = this.#text.get(memo);
    if (known !== undefined) return known;
    const { program, definitions, lists } = this.pass;
    const byFile = new Map<number, number[]>();
    for (const at of below ? [key, ...definitions.keysBelow(key)] : [key])
      for (const d of definitions.byKey.get(at) ?? []) {
        program.work.charge("eventSteps");
        if (!lists.live(d) || !program.live(d.node) || program.inBlockCode(d.node)) continue;
        // (a call's effect follows its arguments: where its site ends)
        const list = byFile.get(d.site.file);
        if (list === undefined) byFile.set(d.site.file, [d.site.end]);
        else list.push(d.site.end);
      }
    for (const list of byFile.values()) {
      program.work.charge("eventSteps", sortCost(list.length));
      list.sort((a, b) => a - b);
    }
    keepText(program.work, memo.length);
    this.#text.set(memo, byFile);
    return byFile;
  }

  /** The dominator ranges of a loop's own code: its entry's interval without its exit's (the code after the loop). */
  #inside(loop: FlowLoop): readonly PositionRange[] {
    const { program, lists } = this.pass;
    // (a loop entered at its head, or at its body where P7 runs the body before the head: whichever dominates)
    const entry =
      program.reached(loop.body) && program.dom.dominates(loop.body, loop.head)
        ? loop.body
        : loop.head;
    const ranges = program.reached(loop.exit)
      ? lists.spanBetween(entry, loop.exit)
      : [[program.position(entry) + 1, program.positionEnd(entry)] as const];
    return [[program.position(entry), program.position(entry)], ...ranges];
  }

  /** G's prefixes' keys, made (and charged) once per G. */
  #prefixes(g: Narrowing): readonly Key[] {
    const known = this.#prefixesOf.get(g);
    if (known !== undefined) return known;
    const made = keptPrefixes(this.#work, g.key);
    this.#prefixesOf.set(g, made);
    return made;
  }

  /**
   * G's event lists (N2), once per G: its dependency keys' own events, the call sites under the owner rule, the
   * invalidations.
   */
  #events(g: Narrowing): readonly EventList[] {
    const known = this.#eventsOf.get(g);
    if (known !== undefined) return known;
    const { definitions, lists } = this.pass;
    const events: EventList[] = [
      { positions: this.pass.lists.eventList(g.key), word: "branch", own: true },
    ];
    for (const prefix of this.#prefixes(g))
      events.push({
        positions: lists.definitionsOf(prefix).eventPositions,
        word: "branch",
        own: false,
      });
    for (const variable of g.variables)
      events.push({ positions: this.pass.lists.eventList(variable), word: "branch", own: false });
    for (const collection of g.collections) {
      const invalidations = this.index.invalidations(collection);
      if (invalidations !== undefined)
        events.push({ positions: invalidations.positions, word: "branch", own: false });
    }
    if (this.#ownedAway(g))
      events.push({ positions: definitions.sitePositions, word: "call", own: false });
    this.#work.charge("eventSteps", events.length);
    this.#eventsOf.set(g, events);
    return events;
  }

  /**
   * X6's owner rule over G's dependency keys: another callable stores the key, a prefix or a key below, or an index
   * variable; or a callable ordinary code may run, other than a collection's activation, holds an invalidation of it (N2).
   */
  #ownedAway(g: Narrowing): boolean {
    const { definitions } = this.pass;
    if (
      definitions.ownedAway(g.key) ||
      g.variables.some((variable) => definitions.ownedAway(variable))
    )
      return true;
    return g.collections.some((collection) => this.#invalidatedOutside(collection));
  }

  /** Whether a callable ordinary code may run, other than a collection's activation, holds an invalidation of it, once. */
  #invalidatedOutside(collection: Key): boolean {
    const known = this.#outside.get(collection);
    if (known !== undefined) return known;
    const { definitions, program } = this.pass;
    const own = definitions.declaringCallable(keyPlace(collection));
    const owners = this.index.invalidations(collection)?.owners ?? [];
    program.work.charge("ownerSteps", owners.length + 1);
    const outside = owners.some(
      (owner) => owner !== null && owner !== own && definitions.ordinary.has(owner),
    );
    keepText(program.work, collection.length);
    this.#outside.set(collection, outside);
    return outside;
  }

  /** X7's registration-before-read predicate (`afterSomeCreation`), its scan of the read's loops charged. */
  #registered(node: FlowNode): boolean {
    this.pass.program.work.charge("eventSteps", node.loops.length + 1);
    return this.pass.handlers.afterSomeCreation(node);
  }

  /** X7's handler-store predicate over G's dependency keys, a block holding an invalidation of a collection included. */
  #touched(g: Narrowing): boolean {
    const { handlers } = this.pass;
    return (
      handlers.handlerTouches(g.key) ||
      g.variables.some((variable) => handlers.handlerTouches(variable)) ||
      g.collections.some((collection) => this.index.invalidations(collection)?.inBlock === true)
    );
  }

  /**
   * The word of G's first event in `ranges` that is no preserving store, or `null`: per list two binary searches per
   * range, and for the location key's own list, where its count exceeds the preserving subset's, a binary search over
   * its ranks for the first event the subset does not hold.
   */
  *#first(
    g: Narrowing,
    events: readonly EventList[],
    ranges: readonly PositionRange[],
    kinds: readonly ItemTag[] | null,
  ): Work<ContextWord | null> {
    const work = this.#work;
    let at = Infinity;
    let word: ContextWord | null = null;
    for (const list of events)
      for (const [low, high] of ranges) {
        if (low > high) continue;
        work.charge("eventSteps");
        const from = lowerBound(work, list.positions, low);
        const to = lowerBound(work, list.positions, high + 1);
        if (from >= to || list.positions[from]! >= at) continue;
        let first = from;
        if (list.own && kinds !== null) {
          const subset = yield* this.#subset(g, kinds);
          const base = lowerBound(work, subset, low);
          if (to - from <= countIn(work, subset, low, high + 1)) continue;
          // the first rank j with more events than preserving stores up to its position
          let lo = from;
          let hi = to - 1;
          while (lo < hi) {
            const middle = (lo + hi) >> 1;
            work.charge("eventSteps");
            const preserving = lowerBound(work, subset, list.positions[middle]! + 1) - base;
            if (middle - from + 1 > preserving) hi = middle;
            else lo = middle + 1;
          }
          first = lo;
        }
        if (list.positions[first]! < at) {
          at = list.positions[first]!;
          word = list.word;
        }
      }
    return word;
  }

  /**
   * N5's sparse subset of a location and filtered kind set: the positions of the location's preserving stores, sorted,
   * built once: one evaluation per (store, kind set), asked only for stores whose path text is the location.
   */
  *#subset(g: Narrowing, kinds: readonly ItemTag[]): Work<readonly number[]> {
    const program = this.pass.program;
    const signature = joinParts(g.location, kindsText(kinds, program.work));
    const known = this.#subsets.get(signature);
    if (known !== undefined) return known;
    const positions: number[] = [];
    for (const store of this.#storesOf(g.key).get(g.location) ?? []) {
      program.work.charge("indexSteps");
      if (yield* this.preserves(store, g.location, kinds))
        positions.push(program.position(store.node));
    }
    program.work.charge("indexSteps", sortCost(positions.length));
    positions.sort((a, b) => a - b);
    keepText(program.work, signature.length);
    this.#subsets.set(signature, positions);
    return positions;
  }

  /** A key's live assignments outside block code by the refined location their target's path text names, once. */
  #storesOf(key: Key): ReadonlyMap<string, readonly Definition[]> {
    const known = this.#stored.get(key);
    if (known !== undefined) return known;
    const { program, definitions, lists } = this.pass;
    const byLocation = new Map<string, Definition[]>();
    for (const d of definitions.byKey.get(key) ?? []) {
      program.work.charge("indexSteps");
      const statement = d.node.statement;
      if (
        d.kind !== "whole" ||
        statement?.kind !== "assignmentStatement" ||
        !lists.live(d) ||
        !program.live(d.node) ||
        program.inBlockCode(d.node)
      )
        continue;
      const path = stablePath(program, d.node.file, statement.target, false, d.place);
      if (path === null) continue;
      const location = locationOf(path, 0, program.work);
      const list = byLocation.get(location);
      if (list === undefined) byLocation.set(location, [d]);
      else list.push(d);
    }
    keepText(program.work, key.length);
    this.#stored.set(key, byLocation);
    return byLocation;
  }

  /**
   * N5: whether a store to `location` preserves `kinds`: its value, evaluated through §2's transfers with every read of
   * the location taken as those kinds, has kinds within them. Once per (store, kind set).
   */
  public *preserves(store: Definition, location: string, kinds: readonly ItemTag[]): Work<boolean> {
    const memo = joinParts(store.uid, kindsText(kinds, this.#work));
    const known = this.#preserves.get(memo);
    if (known !== undefined) return known;
    this.#work.charge("exactQueries");
    const value =
      store.value === undefined ? [] : yield* this.#value(store.value, store.node, location, kinds);
    const preserving = store.value !== undefined && keptWithin(value, kinds, this.#work);
    keepText(this.#work, memo.length);
    this.#preserves.set(memo, preserving);
    return preserving;
  }

  /**
   * A value's items with every read of `location` taken as `kinds`: reads, operators and `otherwise` here, every other
   * value read through `Values`. Post-order with an explicit stack, so a long expression never deepens the native stack.
   */
  *#value(
    value: PlaceId,
    node: FlowNode,
    location: string,
    kinds: readonly ItemTag[],
  ): Work<readonly Item[]> {
    const { program, values } = this.pass;
    const done = new Map<PlaceId, readonly Item[]>();
    const pending: { readonly place: PlaceId; parts: readonly PlaceId[] | null }[] = [
      { place: value, parts: null },
    ];
    while (pending.length > 0) {
      const top = pending.at(-1)!;
      if (done.has(top.place)) {
        pending.pop();
        continue;
      }
      const c = program.opOf.get(top.place);
      const operator = c === undefined ? null : operatorOf(c);
      // an operation's operands and an `otherwise`'s two sides first
      if (top.parts === null) {
        program.work.charge("exactValues");
        const site = program.places[top.place]?.site ?? null;
        const at = site === null ? null : program.exprAt(site);
        const expression = at?.expression;
        const path =
          expression === undefined || at === null ? null : stablePath(program, at.file, expression);
        const text = path === null ? null : locationOf(path);
        if (text !== null) program.work.charge("exactValues", textUnits(text.length));
        if (text === location) {
          program.work.charge("exactValues", kinds.length);
          done.set(
            top.place,
            kinds.map((tag) => makeItem(tag, null, { cert: "pos" })),
          );
          continue;
        }
        top.parts =
          c?.kind === "operation" && operator !== null
            ? c.arguments
            : c?.kind === "fallback"
              ? [c.left, c.right]
              : [];
        if (top.parts.length === 0) {
          done.set(top.place, yield* values.valueItems(top.place, at ?? node, []));
          continue;
        }
        for (const part of top.parts) pending.push({ place: part, parts: null });
        continue;
      }
      pending.pop();
      // (each value's items merged by kind, so a chain's intermediate values stay as small as its kinds)
      if (c?.kind === "operation" && operator !== null) {
        const operands = top.parts.map((part) => withoutEmpty(done.get(part)!));
        done.set(
          top.place,
          mergeItems(operationItems(operator, operands, program.scope, c.site), program.scope),
        );
      } else {
        const [left, right] = top.parts.map((part) => done.get(part)!);
        program.work.charge("exactValues", left!.length + right!.length);
        done.set(
          top.place,
          left!.some((item) => item.tag === "null" || item.tag === "unknown")
            ? mergeItems([...left!.filter((item) => item.tag !== "null"), ...right!], program.scope)
            : left!,
        );
      }
    }
    return done.get(value)!;
  }
}
