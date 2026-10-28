import type { CorePass } from "./answers.js";
import { joinParts, keepText, keptParts, type WorkLedger } from "./budget.js";
import {
  keptPrefixes,
  keyPlace,
  type Definition,
  type Key,
  type PositionRange,
} from "./definitions.js";
import type { FlowLoop, FlowNode } from "./flow-graph.js";
import { makeItem, type ContextWord, type Item, type ItemTag } from "./items.js";
import { locationOf, stablePath, type Narrowing, type NarrowingIndex } from "./narrowing.js";
import {
  copied,
  each,
  every,
  holds,
  mapped,
  passing,
  some,
  sorted,
  steps,
} from "./narrowing-iteration.js";
import { countIn, lowerBound } from "./narrowing-statements.js";
import type { Work } from "./solver.js";

/*
 * N2 and N5 of stage 3b (checkpoint 9, TABLE §13 N2, N5, §13.3): whether a narrowing definition G still answers a read
 * at n. X1, X4, X5 and X6 as §3 writes them, X7 as its flat veto, taken over G's dependency keys with N2's events: each
 * dependency key's own events (the location's key with the keys below it, each prefix's own definitions, each index or
 * key variable's), the call sites where an owner of one of them, or a callable holding an invalidation of a collection
 * of the path, lies outside its activation, and the invalidation lists of the path's collections. Another narrowing is
 * never an event. Every event is counted in intervals of the dominator walk by binary search in those existing lists,
 * never in a copy per (key × node). N5: for a read inside a loop that does not enclose G, and between G and the read, a
 * **preserving store** to the refined location itself is no event: a store whose value keeps its kinds within G's
 * filtered kinds. That value is the store's own value demand (`ExactPath.defVal`), whose reads of a component location
 * take their G (`Values`) and so ask this test again: the stores whose values depend on one another are one component
 * of the solver, solved from bottom (no items: every store preserving) to its greatest fixpoint and published only when
 * stable. A location's stores (its candidates, sorted) carry one tree of union demands, each node the kinds of its
 * range's values, whatever kind set asks: a query over a range checks O(log c) nodes, and a lost fact re-runs only the
 * nodes above its store and their readers.
 */

/** An event list of G with the word a first event in it gives (§3.4). */
interface EventList {
  readonly positions: readonly number[];
  readonly word: ContextWord;
  /** The location key's own list, whose candidates N5 decides. */
  readonly own: boolean;
}

/**
 * What G's lists answer in a range set before N5 (`NarrowingEvents.#static`): the first event's position and word, the
 * own list's events no candidate is counted in, and the own list's ranges that hold candidates.
 */
interface StaticEvents {
  readonly ranges: readonly PositionRange[];
  readonly candidates: boolean;
  readonly at: number;
  readonly word: ContextWord | null;
  readonly owned: readonly PositionRange[];
}

/** A refined location's stores (N5's candidates), by dominator position, with their positions. */
interface Candidates {
  readonly positions: readonly number[];
  readonly stores: readonly Definition[];
}

/**
 * Whether every kind of `items` lies within `kinds` (an integer within a number; anything within `unknown`): each item
 * compared with each kind, charged.
 */
function keptWithin(items: readonly Item[], kinds: readonly ItemTag[], work: WorkLedger): boolean {
  work.charge("exactValues");
  if (holds(work, "exactValues", kinds, "unknown")) return true;
  return every(
    work,
    "exactValues",
    items,
    (item) =>
      item.tag === "empty" ||
      holds(work, "exactValues", kinds, item.tag) ||
      (item.tag === "integer" && holds(work, "exactValues", kinds, "number")),
  );
}

/** `ranges` without the positions `cuts` cover, each range compared with each cut charged. */
function without(
  ranges: readonly PositionRange[],
  cuts: readonly PositionRange[],
  work: WorkLedger,
): PositionRange[] {
  work.charge("eventSteps");
  let left = copied(work, "eventSteps", ranges);
  for (const [cut, end] of each(work, "eventSteps", cuts)) {
    const next: PositionRange[] = [];
    for (const [low, high] of each(work, "eventSteps", left)) {
      if (high < cut || low > end) {
        next.push([low, high]);
        continue;
      }
      if (low < cut) next.push([low, cut - 1]);
      if (high > end) next.push([end + 1, high]);
    }
    left = next;
  }
  return left;
}

export class NarrowingEvents {
  /** Per collection key, whether a callable ordinary code may run outside its activation holds an invalidation (N2). */
  readonly #outside = new Map<Key, boolean>();
  /** Per key, its assignments by the refined location they store, made on the key's first question (N5's candidates). */
  readonly #stored = new Map<Key, ReadonlyMap<string, readonly Definition[]>>();
  /** Per refined location, its candidates by dominator position, sorted (N5). */
  readonly #candidates = new Map<string, Candidates>();
  /** Per key (and per key with its descendants), its definitions' text offsets by file (an operand region's X6). */
  readonly #text = new Map<string, ReadonlyMap<number, readonly number[]>>();
  /** Per narrowing, the word of its condition's window (`#inWindow`), and its lists' static answers per range set. */
  readonly #windowWords = new Map<Narrowing, ContextWord | null>();
  readonly #statics = new Map<Narrowing, Map<number, Map<number, StaticEvents[]>>>();
  /** Per narrowing, its event lists (X6's, by position) and its prefixes' keys, made once. */
  readonly #eventsOf = new Map<Narrowing, readonly EventList[]>();
  readonly #prefixesOf = new Map<Narrowing, readonly Key[]>();
  /** Per loop head, its loop. */
  readonly #loops = new Map<FlowNode, FlowLoop>();
  /** The program's ledger. */
  readonly #work: WorkLedger;

  public constructor(
    readonly pass: CorePass,
    readonly index: NarrowingIndex,
  ) {
    pass.program.work.charge("indexSteps");
    this.#work = pass.program.work;
    for (const loop of each(pass.program.work, "indexSteps", pass.program.flow.loops))
      this.#loops.set(loop.head, loop);
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
    this.#work.charge("exactQueries");
    const { program } = this.pass;
    if (!program.live(node) || !program.live(g.node)) return "dead-code"; // X1
    if (yield* this.pass.contract.refReceiver(g.key)) return "unmodelled";
    if (g.region !== null) return this.#inOperand(g, node);
    if (!program.dom.dominates(g.node, node)) return "branch";
    const boundary = program.dom.edom(node);
    if (program.dom.edom(g.node) !== boundary)
      return boundary?.statement?.kind === "labelStatement" ? "label" : "call"; // X4
    const events = this.#events(g);
    // X5 with N5: every event of a dependency key inside a loop around the read that does not enclose G; the code of
    // the loops it passes holds no event and no breaking store, so X6 asks its span without it
    const passed: PositionRange[] = [];
    for (const head of each(program.work, "eventSteps", node.loops)) {
      if (holds(program.work, "eventSteps", g.node.loops, head)) continue;
      const loop = this.#loops.get(head);
      if (loop === undefined) return "loop";
      const inside = this.#inside(loop);
      if ((yield* this.#first(g, events, inside, kinds, loop)) !== null) return "loop";
      for (const range of each(program.work, "eventSteps", inside)) passed.push(range);
    }
    // X6 with N5: the events after the test, in the rest of its condition, then strictly after G and not after the read
    const before = this.#inWindow(g);
    if (before !== null) return before;
    const span = without(this.pass.lists.spanBetween(g.node, node), passed, program.work);
    const word = yield* this.#first(g, events, span, kinds);
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
    this.#work.charge("eventSteps");
    const { program } = this.pass;
    const region = g.region!;
    const at = node.span?.start.offset ?? -1;
    if (node.file !== region.file || at < region.start || at > region.end) return "branch";
    const boundary = program.dom.edom(node);
    if (program.dom.edom(g.node) !== boundary)
      return boundary?.statement?.kind === "labelStatement" ? "label" : "call"; // X4
    const word = this.#textEvent(g, region.file, region.start, at);
    if (word !== null) return word;
    if (program.blockReachable(node)) return "handler";
    if (this.#touched(g) && this.#registered(node)) return "handler";
    return null;
  }

  /** X6 in G's condition after its test (`#textEvent`), once per G. */
  #inWindow(g: Narrowing): ContextWord | null {
    this.#work.charge("eventSteps");
    const known = this.#windowWords.get(g);
    if (known !== undefined) return known;
    const window = g.window;
    // (a call that ends the condition completes before the entry: the window holds its end)
    const word =
      window === null ? null : this.#textEvent(g, window.file, window.start, window.end + 1);
    this.#windowWords.set(g, word);
    return word;
  }

  /**
   * The word of G's first event completed in [`from`, `to`) of one file's text, or `null`: inside one expression (an
   * operand region, or a branch's condition after its test) the events are calls, adds, removals and invalidations, in
   * the order the expression completes them (a call after its arguments); a binary search in each of G's text lists.
   */
  #textEvent(g: Narrowing, file: number, from: number, to: number): ContextWord | null {
    this.#work.charge("eventSteps");
    const work = this.#work;
    let first = Infinity;
    let word: ContextWord | null = null;
    for (const [byFile, found] of each(work, "eventSteps", this.#textLists(g))) {
      const offsets = byFile?.get(file);
      if (offsets === undefined) continue;
      const index = lowerBound(work, offsets, from);
      if (index < offsets.length && offsets[index]! < to && offsets[index]! < first) {
        first = offsets[index]!;
        word = found;
      }
    }
    return word;
  }

  /** G's text lists (`#textEvent`), each with the word its first event gives. */
  #textLists(
    g: Narrowing,
  ): (readonly [ReadonlyMap<number, readonly number[]> | undefined, ContextWord])[] {
    this.#work.charge("eventSteps");
    const work = this.#work;
    const lists: (readonly [ReadonlyMap<number, readonly number[]> | undefined, ContextWord])[] = [
      [this.#texts(g.key, true), "branch"],
    ];
    for (const prefix of each(work, "eventSteps", this.#prefixes(g)))
      lists.push([this.#texts(prefix, false), "branch"]);
    for (const variable of each(work, "eventSteps", g.variables))
      lists.push([this.#texts(variable, true), "branch"]);
    for (const collection of each(work, "eventSteps", g.collections))
      lists.push([this.index.invalidations(collection)?.texts, "branch"]);
    if (this.#ownedAway(g)) lists.push([this.index.statements.callTexts, "call"]);
    return lists;
  }

  /**
   * What `holds` reads of G at `node` (S10 part 2b, the value classes' environment), as one text: what makes G's items
   * (its location, form and element steps, and its input's exact-path signature, `readSignature`), G's own and the
   * read's places among G's event lists (each one's dominator interval's two ends, as `aliasSignature` cuts them: the
   * events of every span between them), their loops, boundaries and liveness, G's window's word, and the read's block
   * reach, handlers' registration and, in an operand region, its place among G's text lists. Two reads with one
   * environment get one answer, whichever of two such narrowings each finds.
   */
  public environment(g: Narrowing, node: FlowNode): string {
    this.#work.charge("eventSteps");
    const work = this.#work;
    const { program, lists } = this.pass;
    const cuts: string[] = [];
    for (const [side, at] of each(work, "eventSteps", [
      ["g", g.node],
      ["r", node],
    ] as const)) {
      const begin = program.position(at);
      const end = program.positionEnd(at) + 1;
      cuts.push(`${side}${program.dom.edom(at)?.id ?? "-"}${program.live(at) ? "l" : ""}`);
      for (const loop of each(work, "eventSteps", at.loops)) cuts.push(`${side}l${loop.id}`);
      for (const list of each(work, "eventSteps", this.#events(g)))
        cuts.push(
          `${side}${lowerBound(work, list.positions, begin)},${lowerBound(work, list.positions, end)}`,
        );
    }
    if (g.region !== null && node.span !== null)
      for (const [byFile] of each(work, "eventSteps", this.#textLists(g)))
        cuts.push(`t${lowerBound(work, byFile?.get(node.file) ?? [], node.span.start.offset)}`);
    const form = g.form;
    return keptParts(
      work,
      g.location,
      form.kind,
      form.kind === "is" || form.kind === "is-not" ? form.kinds : [],
      form.kind === "is" && form.fractional === true ? "f" : "",
      g.elements,
      g.region?.start ?? -1,
      this.#inWindow(g) ?? "",
      lists.readSignature(g.key, g.input),
      program.blockReachable(node) ? "b" : "",
      this.#registered(node) ? "h" : "",
      cuts,
    );
  }

  /**
   * A key's live definitions outside block code (with `below`, its descendants' too) by where their sites end, per
   * file, sorted: the order an expression completes them in (an operand region's X6).
   */
  #texts(key: Key, below: boolean): ReadonlyMap<number, readonly number[]> {
    this.#work.charge("eventSteps");
    const memo = below ? joinParts(key, "*") : key;
    const known = this.#text.get(memo);
    if (known !== undefined) return known;
    const { program, definitions, lists } = this.pass;
    const byFile = new Map<number, number[]>();
    const keys = [key];
    if (below)
      for (const lower of each(program.work, "eventSteps", definitions.keysBelow(key)))
        keys.push(lower);
    for (const at of each(program.work, "eventSteps", keys))
      for (const d of each(program.work, "eventSteps", definitions.byKey.get(at) ?? [])) {
        if (!lists.live(d) || !program.live(d.node) || program.inBlockCode(d.node)) continue;
        // (a call's effect follows its arguments: where its site ends)
        const list = byFile.get(d.site.file);
        if (list === undefined) byFile.set(d.site.file, [d.site.end]);
        else list.push(d.site.end);
      }
    for (const list of each(program.work, "eventSteps", byFile.values()))
      sorted(program.work, "eventSteps", list, (a, b) => a - b);
    keepText(program.work, memo.length);
    this.#text.set(memo, byFile);
    return byFile;
  }

  /** The dominator ranges of a loop's own code: its entry's interval without its exit's (the code after the loop). */
  #inside(loop: FlowLoop): readonly PositionRange[] {
    this.#work.charge("eventSteps");
    const { program, lists } = this.pass;
    // (a loop entered at its head, or at its body where P7 runs the body before the head: whichever dominates)
    const entry =
      program.reached(loop.body) && program.dom.dominates(loop.body, loop.head)
        ? loop.body
        : loop.head;
    const ranges: PositionRange[] = [[program.position(entry), program.position(entry)]];
    if (!program.reached(loop.exit))
      ranges.push([program.position(entry) + 1, program.positionEnd(entry)]);
    // (X6's span is at most two ranges)
    else
      for (const range of each(program.work, "eventSteps", lists.spanBetween(entry, loop.exit)))
        ranges.push(range);
    return ranges;
  }

  /** G's prefixes' keys, made (and charged) once per G. */
  #prefixes(g: Narrowing): readonly Key[] {
    this.#work.charge("eventSteps");
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
    this.#work.charge("eventSteps");
    const known = this.#eventsOf.get(g);
    if (known !== undefined) return known;
    const { definitions, lists } = this.pass;
    const events: EventList[] = [
      { positions: this.pass.lists.eventList(g.key), word: "branch", own: true },
    ];
    for (const prefix of each(this.#work, "eventSteps", this.#prefixes(g)))
      events.push({
        positions: lists.definitionsOf(prefix).eventPositions,
        word: "branch",
        own: false,
      });
    for (const variable of each(this.#work, "eventSteps", g.variables))
      events.push({ positions: this.pass.lists.eventList(variable), word: "branch", own: false });
    for (const collection of each(this.#work, "eventSteps", g.collections)) {
      const invalidations = this.index.invalidations(collection);
      if (invalidations !== undefined)
        events.push({ positions: invalidations.positions, word: "branch", own: false });
    }
    if (this.#ownedAway(g))
      events.push({ positions: definitions.sitePositions, word: "call", own: false });
    this.#eventsOf.set(g, events);
    return events;
  }

  /**
   * X6's owner rule over G's dependency keys: another callable stores the key, a prefix or a key below, or an index
   * variable; or a callable ordinary code may run, other than a collection's activation, holds an invalidation of it (N2).
   */
  #ownedAway(g: Narrowing): boolean {
    this.#work.charge("ownerSteps");
    const { definitions } = this.pass;
    const work = this.#work;
    if (
      definitions.ownedAway(g.key) ||
      some(work, "ownerSteps", g.variables, (variable) => definitions.ownedAway(variable))
    )
      return true;
    return some(work, "ownerSteps", g.collections, (collection) =>
      this.#invalidatedOutside(collection),
    );
  }

  /** Whether a callable ordinary code may run, other than a collection's activation, holds an invalidation of it, once. */
  #invalidatedOutside(collection: Key): boolean {
    this.#work.charge("ownerSteps");
    const known = this.#outside.get(collection);
    if (known !== undefined) return known;
    const { definitions, program } = this.pass;
    const own = definitions.declaringCallable(keyPlace(collection));
    const owners = this.index.invalidations(collection)?.owners ?? [];
    const outside = some(
      program.work,
      "ownerSteps",
      owners,
      (owner) => owner !== null && owner !== own && definitions.ordinary.has(owner),
    );
    keepText(program.work, collection.length);
    this.#outside.set(collection, outside);
    return outside;
  }

  /** X7's registration-before-read predicate (`afterSomeCreation`), its scan of the read's loops charged. */
  #registered(node: FlowNode): boolean {
    this.#work.charge("eventSteps");
    this.#work.charge("eventSteps", node.loops.length);
    return this.pass.handlers.afterSomeCreation(node);
  }

  /** X7's handler-store predicate over G's dependency keys, a block holding an invalidation of a collection included. */
  #touched(g: Narrowing): boolean {
    this.#work.charge("eventSteps");
    const { handlers } = this.pass;
    const work = this.#work;
    return (
      handlers.handlerTouches(g.key) ||
      some(work, "eventSteps", g.variables, (variable) => handlers.handlerTouches(variable)) ||
      some(
        work,
        "eventSteps",
        g.collections,
        (collection) => this.index.invalidations(collection)?.inBlock === true,
      )
    );
  }

  /**
   * The word of G's first event in `ranges` that is no preserving store, or `null`: the lists' events (`#static`), and
   * which candidates preserve `kinds`, which N5 alone decides and only where the other events leave the word open:
   * then one query of the candidates in the own list's ranges (before the first call site where one comes first: the
   * own list wins a tie), the same set of nodes whatever the values. For X5 (`loop`) any event fails G, and the query is
   * the loop's one union (`#inLoop`).
   */
  *#first(
    g: Narrowing,
    events: readonly EventList[],
    ranges: readonly PositionRange[],
    kinds: readonly ItemTag[] | null,
    loop: FlowLoop | null = null,
  ): Work<ContextWord | null> {
    this.#work.charge("eventSteps");
    const work = this.#work;
    const { at, word, owned } = this.#static(g, events, ranges, kinds !== null);
    if (word === "branch" || owned.length === 0 || kinds === null) return word;
    if (loop !== null)
      return word !== null || keptWithin(yield* this.#inLoop(g, loop, ranges), kinds, work)
        ? word
        : "branch";
    const asked =
      word === "call"
        ? mapped(
            work,
            "eventSteps",
            passing(work, "eventSteps", owned, ([low]) => low <= at),
            ([low, high]): PositionRange => [low, high < at ? high : at],
          )
        : owned;
    return keptWithin(yield* this.#unionIn(g, asked), kinds, work) ? word : "branch";
  }

  /**
   * `#first` before N5: per list two binary searches per range, and for the own list (`candidates`: where N5 decides
   * its stores), where its count exceeds its candidates', a binary search over its ranks for the first event no
   * candidate is. Once per (G, range set): it rests on the program alone.
   */
  #static(
    g: Narrowing,
    events: readonly EventList[],
    ranges: readonly PositionRange[],
    candidates: boolean,
  ): StaticEvents {
    this.#work.charge("eventSteps");
    const work = this.#work;
    // (by the first range's two ends, then the ranges compared: no text kept)
    let byStart = this.#statics.get(g);
    if (byStart === undefined) this.#statics.set(g, (byStart = new Map()));
    const [start, end] = ranges.length === 0 ? [-1, -1] : ranges[0]!;
    let byEnd = byStart.get(start);
    if (byEnd === undefined) byStart.set(start, (byEnd = new Map()));
    let entries = byEnd.get(end);
    if (entries === undefined) byEnd.set(end, (entries = []));
    for (const entry of each(work, "eventSteps", entries))
      if (
        entry.candidates === candidates &&
        entry.ranges.length === ranges.length &&
        every(
          work,
          "eventSteps",
          entry.ranges.entries(),
          ([index, [low, high]]) => ranges[index]![0] === low && ranges[index]![1] === high,
        )
      )
        return entry;
    let at = Infinity;
    let word: ContextWord | null = null;
    // the own list's ranges that hold candidates, which only N5 decides
    const owned: PositionRange[] = [];
    for (const list of each(work, "eventSteps", events))
      for (const [low, high] of each(work, "eventSteps", ranges)) {
        if (low > high) continue;
        const from = lowerBound(work, list.positions, low);
        const to = lowerBound(work, list.positions, high + 1);
        if (from >= to || list.positions[from]! >= at) continue;
        let first = from;
        if (list.own && candidates) {
          const stores = this.#candidatesOf(g).positions;
          owned.push([low, high]);
          const base = lowerBound(work, stores, low);
          if (to - from <= countIn(work, stores, low, high + 1)) continue;
          // the first rank j with more events than candidates up to its position
          let lo = from;
          let hi = to - 1;
          for (const _ of steps(work, "eventSteps", () => lo < hi)) {
            const middle = (lo + hi) >> 1;
            const below = lowerBound(work, stores, list.positions[middle]! + 1) - base;
            if (middle - from + 1 > below) hi = middle;
            else lo = middle + 1;
          }
          first = lo;
        }
        if (list.positions[first]! < at) {
          at = list.positions[first]!;
          word = list.word;
        }
      }
    const made: StaticEvents = { ranges, candidates, at, word, owned };
    entries.push(made);
    return made;
  }

  /**
   * The kinds of G's location's candidates inside a loop's code (X5's N5 query), one demand per (location, loop): the
   * reads inside the loop ask one answer, which changes only when the loop's union does.
   */
  *#inLoop(g: Narrowing, loop: FlowLoop, ranges: readonly PositionRange[]): Work<readonly Item[]> {
    this.#work.charge("eventSteps");
    const head = loop.head;
    return yield {
      key: joinParts("n5-loop", head.id, g.location),
      kind: "value",
      file: head.file,
      offset: head.span?.start.offset ?? -1,
      make: () => {
        this.#work.charge("eventSteps");
        return this.#unionIn(g, ranges);
      },
    };
  }

  /**
   * Test-only (`answers.ts`'s `solveDemands`): a tree demand of `location`, its first narrowing standing for it: the
   * node over the candidates [lo, hi) (`#union`), or with `head` the loop's union (`#inLoop`).
   */
  public *treeDemand(
    location: string,
    lo: number,
    hi: number,
    head: FlowNode | null,
  ): Work<readonly Item[]> {
    this.#work.charge("eventSteps");
    const g = passing(
      this.#work,
      "eventSteps",
      this.index.all,
      (each) => each.location === location,
    )[0]!;
    if (head === null) return yield* this.#union(g, this.#candidatesOf(g), lo, hi);
    const loop = this.#loops.get(head)!;
    return yield* this.#inLoop(g, loop, this.#inside(loop));
  }

  /** G's location's candidates (N5): its stores (`#storesOf`) by dominator position, with their positions, once. */
  #candidatesOf(g: Narrowing): Candidates {
    this.#work.charge("indexSteps");
    const known = this.#candidates.get(g.location);
    if (known !== undefined) return known;
    const program = this.pass.program;
    const stores = sorted(
      program.work,
      "indexSteps",
      copied(program.work, "indexSteps", this.#storesOf(g.key).get(g.location) ?? []),
      (a, b) => program.position(a.node) - program.position(b.node),
    );
    const made: Candidates = {
      positions: mapped(program.work, "indexSteps", stores, (store) =>
        program.position(store.node),
      ),
      stores,
    };
    keepText(program.work, g.location.length);
    this.#candidates.set(g.location, made);
    return made;
  }

  /**
   * The kinds G's location's candidates in `ranges` hold (N5): each range's candidates as the O(log c) canonical nodes
   * of the location's union tree, with an explicit stack.
   */
  *#unionIn(g: Narrowing, ranges: readonly PositionRange[]): Work<readonly Item[]> {
    this.#work.charge("eventSteps");
    const work = this.#work;
    const candidates = this.#candidatesOf(g);
    const out: Item[] = [];
    for (const [low, high] of each(work, "eventSteps", ranges)) {
      if (low > high) continue;
      const from = lowerBound(work, candidates.positions, low);
      const to = lowerBound(work, candidates.positions, high + 1);
      const pending: (readonly [number, number])[] = [[0, candidates.stores.length]];
      for (const _ of steps(work, "eventSteps", () => from < to && pending.length > 0)) {
        const [lo, hi] = pending.pop()!;
        if (hi <= from || lo >= to) continue;
        if (from <= lo && hi <= to) {
          for (const item of each(work, "exactValues", yield* this.#union(g, candidates, lo, hi)))
            out.push(item);
          continue;
        }
        const middle = (lo + hi) >> 1;
        pending.push([middle, hi], [lo, middle]);
      }
    }
    return out;
  }

  /**
   * The union tree's node over the candidates [lo, hi): the kinds their values hold, one demand per node, whatever kind
   * set asks, so it changes only when one of them grows, and only the nodes above that store run again.
   */
  *#union(g: Narrowing, candidates: Candidates, lo: number, hi: number): Work<readonly Item[]> {
    this.#work.charge("eventSteps");
    const site = candidates.stores[lo]!.site;
    return yield {
      key: joinParts("n5", lo, hi, g.location),
      kind: "value",
      file: site.file,
      offset: site.start,
      make: () => {
        this.#work.charge("eventSteps");
        return this.#unionOf(candidates, g, lo, hi);
      },
    };
  }

  /** The demand of `#union`: a leaf, its store's value (`ExactPath.defVal`); an inner node, its children's kinds. */
  *#unionOf(candidates: Candidates, g: Narrowing, lo: number, hi: number): Work<readonly Item[]> {
    this.#work.charge("eventSteps");
    const work = this.#work;
    const parts: (readonly Item[])[] = [];
    if (hi - lo === 1) parts.push(yield* this.pass.exact.defVal(candidates.stores[lo]!, []));
    else {
      const middle = (lo + hi) >> 1;
      parts.push(yield* this.#union(g, candidates, lo, middle));
      parts.push(yield* this.#union(g, candidates, middle, hi));
    }
    const tags = new Set<ItemTag>();
    for (const items of each(work, "eventSteps", parts))
      for (const item of each(work, "exactValues", items))
        if (item.tag !== "empty") tags.add(item.tag);
    return mapped(
      work,
      "exactValues",
      sorted(work, "exactValues", copied(work, "exactValues", tags), (a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
      (tag) => makeItem(tag),
    );
  }

  /** A key's live assignments outside block code by the refined location their target's path text names, once. */
  #storesOf(key: Key): ReadonlyMap<string, readonly Definition[]> {
    this.#work.charge("indexSteps");
    const known = this.#stored.get(key);
    if (known !== undefined) return known;
    const { program, definitions, lists } = this.pass;
    const byLocation = new Map<string, Definition[]>();
    for (const d of each(program.work, "indexSteps", definitions.byKey.get(key) ?? [])) {
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
      const location = locationOf(path, program.work, 0, true);
      const list = byLocation.get(location);
      if (list === undefined) byLocation.set(location, [d]);
      else list.push(d);
    }
    keepText(program.work, key.length);
    this.#stored.set(key, byLocation);
    return byLocation;
  }
}
