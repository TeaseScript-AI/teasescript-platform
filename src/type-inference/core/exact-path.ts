import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import {
  keyOf,
  keyPath,
  keyPlace,
  prefixesOf,
  recordPath,
  sortCost,
  type Definition,
  type Key,
} from "./definitions.js";
import type { Callable, FlowNode } from "./flow-graph.js";
import { marked } from "./guards.js";
import {
  alternatives,
  EMPTY,
  firstContext,
  mergeItems,
  REASON,
  weaken,
  type ContextWord,
  type Item,
  type Writer,
} from "./items.js";
import { dictList } from "./method-categories.js";
import type { WorkLedger } from "./budget.js";
import type { Work } from "./solver.js";
import type { ReadRoute } from "./values.js";

/*
 * The exact path of the coarse core (checkpoint 9, TABLE §3.1): a read of key k at node n is answered from one
 * definition D when X1–X7 and the receiver rule R hold: n and D are live (X1), D is the nearest dominating definition
 * over k and its prefixes (X2), D is an exact definition (X3), D and n share their nearest boundary (X4) and their
 * loops (X5), no own event of k lies strictly after D and not after n (X6), and no block can have interfered (X7).
 * Otherwise the read takes the contract, and the first condition that failed is the warning's context word (§3.4).
 * D's value at the path below its key is evaluated at D's node, once per (D, path).
 */

/** The exact path's answer: D with the path below its key, or the first failing condition's word. */
export type ExactAnswer =
  { readonly def: Definition; readonly rest: readonly string[] } | { readonly fail: ContextWord };

/** A path step no definition names: the exact path every path below a source shares that no key below it overlaps. */
const ANY_PATH = "*";

/*
 * Three tuning constants (TABLE r4.41): each picks which of two indexes answers a read, never the answer. Four keeps the
 * common shapes on the per-source path; W34's two known products stand where more than four sources, anchors or trees
 * meet at one path (PLAN §6b).
 */

/** The trees of the copy forest a source with several anchors is listed under one by one; beyond, under all. */
const FEW_TREES = 4;

/** The sources tested at one path that a read asks one by one; beyond, by the path's spans. */
const FEW_PLACES = 4;

/** The anchors of a source whose copies a path's spans hold run by run; beyond, the source is asked at the read. */
const FEW_ANCHORS = 4;

/**
 * A whole copy of a place (W34): the copy, the source it reads and where, and what the source holds there for every
 * path no key below it overlaps (`top`): the copy it comes from (`up`), another whole store, no exact definition (the
 * word), or something only the copy's own reads answer. The copies form a forest toward their origins, walked once.
 */
interface CopyLink {
  readonly d: Definition;
  readonly source: PlaceId;
  readonly read: FlowNode;
  up: CopyLink | null;
  top:
    | { readonly kind: "copy" | "own" }
    | { readonly kind: "origin"; readonly def: Definition }
    | { readonly kind: "fail"; readonly word: ContextWord };
  /** The definition its source answers with, if a whole store: its anchor. */
  anchor: number | null;
  depth: number;
  enter: number;
  exit: number;
  root: CopyLink | null;
  /** The tree of the forest it stands in. */
  tree: number;
  /** Whether an operand region of a test of its source holds its read (§3.2). */
  operand: boolean;
}

/**
 * A definition of a place that copies of the place read (a copy itself, or the origin of a chain), with those copies
 * in the order of their callables and their reads' dominator positions: the copies a guard's branch holds are
 * consecutive, so their subtrees are one interval of the walk.
 */
interface CopyAnchor {
  readonly place: PlaceId;
  /** Its copies' depth in the forest. */
  readonly depth: number;
  readonly copies: CopyLink[];
  readonly order: number[];
}

/** A source's copies in one callable by their reads' dominator positions, each with the end of its anchor's run. */
interface PlacedCopies {
  readonly links: CopyLink[];
  positions: number[];
  runEnd: number[];
}

/** An interval of the walk with what it stands for. */
interface Span<T> {
  readonly start: number;
  readonly end: number;
  readonly item: T;
}

/**
 * Intervals of the copy forest's walk that nest or lie apart, each with an item: the innermost one holding a point, by
 * a binary search and the holding intervals' jumps by powers of two.
 */
class NestedSpans<T> {
  readonly #start: number[] = [];
  readonly #end: number[] = [];
  readonly #item: T[] = [];
  /** Per power of two, the interval that many levels out from each, or -1. */
  readonly #jumps: number[][] = [];

  public constructor(
    spans: readonly Span<T>[],
    private readonly work: WorkLedger,
  ) {
    const sorted = [...spans].sort((x, y) => x.start - y.start || y.end - x.end);
    work.charge("exactQueries", sortCost(sorted.length));
    const parent: number[] = [];
    const open: number[] = [];
    for (const span of sorted) {
      work.charge("exactQueries");
      while (open.length > 0 && this.#end[open.at(-1)!]! < span.start) open.pop();
      parent.push(open.at(-1) ?? -1);
      open.push(this.#start.length);
      this.#start.push(span.start);
      this.#end.push(span.end);
      this.#item.push(span.item);
    }
    this.#jumps.push(parent);
    for (let level = 0; this.#jumps[level]!.some((at) => at >= 0); level += 1) {
      const below = this.#jumps[level]!;
      work.charge("exactQueries", below.length);
      this.#jumps.push(below.map((at) => (at < 0 ? -1 : below[at]!)));
    }
  }

  /** The innermost interval holding `point`, its item; `null` if none does. */
  public innermost(point: number): T | null {
    const at = this.#innermost(point);
    return at < 0 ? null : this.#item[at]!;
  }

  #innermost(point: number): number {
    let low = 0;
    let high = this.#start.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      this.work.charge("exactQueries");
      if (this.#start[middle]! <= point) low = middle + 1;
      else high = middle;
    }
    let at = low - 1;
    if (at < 0) return -1;
    if (this.#end[at]! >= point) return at;
    // the outermost interval out from it that ends before the point, then the one out from that
    for (let level = this.#jumps.length - 1; level >= 0; level -= 1) {
      this.work.charge("exactQueries");
      const out = this.#jumps[level]![at]!;
      if (out >= 0 && this.#end[out]! < point) at = out;
    }
    at = this.#jumps[0]![at]!;
    return at >= 0 && this.#end[at]! >= point ? at : -1;
  }
}

interface CopyForest {
  /** The copies by their definition. */
  readonly links: ReadonlyMap<number, CopyLink>;
  /** Per path below a source, the sources with a key at that path, and those with one at it or below it. */
  readonly at: ReadonlyMap<string, ReadonlySet<PlaceId>>;
  readonly below: ReadonlyMap<string, ReadonlySet<PlaceId>>;
  /**
   * Per such path, the anchors of those sources as the spans of their copies (built as asked): a source's one anchor
   * directly; a source with several, per tree of the forest, by the source, whose anchors are nested once.
   */
  readonly atSpans: ReadonlyMap<string, readonly Span<CopyAnchor>[]>;
  readonly belowSpans: ReadonlyMap<string, readonly Span<CopyAnchor>[]>;
  readonly atSeveral: ReadonlyMap<string, ReadonlyMap<number, ReadonlySet<PlaceId>>>;
  readonly belowSeveral: ReadonlyMap<string, ReadonlyMap<number, ReadonlySet<PlaceId>>>;
  readonly anchorsOf: ReadonlyMap<PlaceId, readonly CopyAnchor[]>;
  readonly placesBuilt: Map<PlaceId, NestedSpans<CopyAnchor>>;
  /** Per path (`""` the source itself), the sources a branch tests at the path. */
  readonly markPlaces: ReadonlyMap<string, ReadonlySet<PlaceId>>;
  /** Per path with spans, per tree, the sources tested there with several anchors, asked one by one. */
  readonly markSeveral: ReadonlyMap<string, ReadonlyMap<number, ReadonlySet<PlaceId>>>;
  /**
   * Per path that more than a few sources are tested at, the copies a test of their source at the path guards, as
   * spans of the walk; a read at a path fewer sources are tested at asks each one's copy on its chain.
   */
  readonly markSpans: ReadonlyMap<string, readonly Span<number>[]>;
  /** Per path, the copies an operand region of a test of their source at the path holds, as spans of the walk. */
  readonly operandSpans: ReadonlyMap<string, readonly Span<number>[]>;
  /**
   * Per source and callable, the copies a chain leaves the callable from (each the source's last copy there on the walk
   * before a copy of the source in another callable), by their reads' dominator positions, with the runs of siblings.
   */
  readonly exits: ReadonlyMap<PlaceId, ReadonlyMap<Callable | null, PlacedExits>>;
  /** The nested spans built so far, per index and path. */
  readonly anchorsBuilt: Map<string, NestedSpans<CopyAnchor>>;
  readonly marksBuilt: Map<string, NestedSpans<number>>;
}

/**
 * A source's exits in one callable by their reads' dominator positions; a run is the exits from one on with its parent,
 * one interval of the walk with the siblings between them (whose reads stand between theirs).
 */
interface PlacedExits {
  readonly links: CopyLink[];
  positions: number[];
  runEnd: number[];
}

/** The exits per source and callable, sorted, with their runs. */
function exitsOf(
  exits: ReadonlySet<CopyLink>,
  program: CorePass["program"],
): Map<PlaceId, Map<Callable | null, PlacedExits>> {
  const work = program.work;
  const out = new Map<PlaceId, Map<Callable | null, PlacedExits>>();
  for (const exit of exits) {
    work.charge("exactQueries");
    let byCallable = out.get(exit.source);
    if (byCallable === undefined) out.set(exit.source, (byCallable = new Map()));
    const callable = program.callableAt(exit.read);
    const entry = byCallable.get(callable);
    if (entry === undefined) byCallable.set(callable, { links: [exit], positions: [], runEnd: [] });
    else entry.links.push(exit);
  }
  for (const byCallable of out.values())
    for (const entry of byCallable.values()) {
      work.charge("exactQueries", sortCost(entry.links.length));
      entry.links.sort((x, y) => program.position(x.read) - program.position(y.read));
      entry.positions = entry.links.map((link) => program.position(link.read));
      entry.runEnd = entry.links.map(() => 0);
      for (let index = entry.links.length - 1; index >= 0; index -= 1)
        entry.runEnd[index] =
          index + 1 < entry.links.length && entry.links[index + 1]!.up === entry.links[index]!.up
            ? entry.runEnd[index + 1]!
            : index;
    }
  return out;
}

export class ExactPath {
  readonly #memo = new Map<string, ExactAnswer>();
  #copies: CopyForest | null = null;
  /** Per source, its copies whose reads are reached, per callable (built once). */
  #bySource: Map<PlaceId, Map<Callable | null, CopyLink[]>> | null = null;
  /** Per source and callable, those copies' intervals of the walk, nested (built as asked). */
  readonly #sourceSpans = new Map<PlaceId, Map<Callable | null, NestedSpans<CopyLink>>>();
  /** The route of each definition's value at a path, recorded as it is answered (S3 §1). */
  readonly #defRoutes = new Map<string, ReadRoute>();
  /** Per tested key, its guarded exits, nested (built once its callables have been asked as often as it has exits). */
  readonly #exitSpans = new Map<Key, NestedSpans<number> | null>();
  /** Per tested key whose guarded exits are not built: its exits in its callables, and the callables asked so far. */
  readonly #exitBudget = new Map<Key, { readonly exits: number; asked: number }>();

  public constructor(readonly pass: CorePass) {}

  /** The exact path of a read of `key` at `node`; `before`: a definition at `node` itself does not count. */
  public exactPath(key: Key, node: FlowNode, before = false): ExactAnswer {
    const memoKey = `${key}|${node.id}|${before ? 1 : 0}`;
    let answer = this.#memo.get(memoKey);
    if (answer === undefined) {
      answer = this.#exactPath(key, node, before);
      this.#memo.set(memoKey, answer);
    }
    return answer;
  }

  #exactPath(key: Key, node: FlowNode, before: boolean): ExactAnswer {
    const { program, definitions, lists, handlers } = this.pass;
    program.work.charge("exactQueries");
    if (!program.live(node)) return { fail: "dead-code" }; // X1
    // F20: a function's result is never the exact path
    if (program.resultPlaces.has(keyPlace(key))) return { fail: "call" };
    const reaching = lists.reachingDef(key, node, before);
    // X2: no dominating definition; a key with stores is reached from another callable or file
    if (reaching === null)
      return {
        fail: [key, ...prefixesOf(key)].some(
          (prefix) => (definitions.byKey.get(prefix) ?? []).length > 0,
        )
          ? "call"
          : "unknown",
      };
    const d = reaching.def;
    // X3 with R: a declaration, a whole store, an add, a clear or a removal with a certain receiver, a loop
    // variable, the binding of a single-site non-recursive callee's parameter
    if (
      d.kind === "const"
        ? d.how !== "loop variable"
        : d.how === "return" ||
          d.weak ||
          (d.how === "argument" || d.how === "parameter default"
            ? !lists.singleSite(d.fn)
            : !lists.certain(d))
    )
      return { fail: "member" };
    // §3.4 (r4.11): D's value projected past an element step over a copy stops there (F12), X3's `member`, which
    // comes before any later condition's word
    const word = (found: ContextWord): ExactAnswer => ({
      fail: this.#overCopy(d, reaching.rest) ? "member" : found,
    });
    const boundary = program.dom.edom(node);
    // X4
    if (program.dom.edom(d.node) !== boundary)
      return word(boundary?.statement?.kind === "labelStatement" ? "label" : "call");
    // X5
    if (!node.loops.every((loop) => d.node.loops.includes(loop))) return word("loop");
    // X6
    const event = lists.eventBetween(key, d.node, node);
    if (event !== null) return word(event);
    // X7: a read in block code or code a block reaches takes the contract (O15); a handler store may have run
    if (program.blockReachable(node)) return word("handler");
    if (handlers.handlerTouches(key) && handlers.afterSomeCreation(node)) return word("handler");
    return reaching;
  }

  /** Whether a whole store's literal value, read at `rest`, passes an element step over a copy (`[seed, seed]`). */
  #overCopy(d: Definition, rest: readonly string[]): boolean {
    const { program, contract } = this.pass;
    if (
      d.kind !== "whole" ||
      d.value === undefined ||
      !(program.hasOf.has(d.value) || program.cellOwner.has(d.value))
    )
      return false;
    const index = contract.literalIndex(d.value);
    const inElement = program.cellOwner.get(d.value)?.kind === "cell";
    for (let length = 0; length < rest.length; length += 1) {
      program.work.charge("invSteps");
      const at = rest.slice(0, length);
      if ((inElement || at.includes("element")) && (index.reads.get(at.join("."))?.length ?? 0) > 0)
        return true;
    }
    return false;
  }

  /**
   * W34 (r4.33, r4.36–r4.38): the forest of whole copies of places, built once. A copy's source answers at the record
   * level for every path no key below the source overlaps (the exact path of a path no definition names), so a chain
   * is resolved once per copy and projected per field. A test on a source never splits it: the copies a test of their
   * source at a path guards are spans of the forest's walk, indexed per path, so a read finds its chain's marks by one
   * search per prefix of its path. A store below a source stops a chain only at the stored path: the sources with keys
   * at a path are spans of their anchors, indexed per path the same way.
   */
  #forest(): CopyForest {
    if (this.#copies !== null) return this.#copies;
    const { program, definitions, guards } = this.pass;
    const work = program.work;
    const links = new Map<number, CopyLink>();
    for (const list of [...definitions.byKey.values(), ...definitions.cellDefs.values()])
      for (const d of list) {
        work.charge("exactQueries");
        if (d.kind !== "whole" || d.weak || d.value === undefined) continue;
        const source = program.occurrenceOf.get(d.value);
        if (source === undefined || program.isHost(source)) continue;
        const read = program.occNode.get(d.value) ?? program.projOf.get(d.value)?.node ?? null;
        if (read === null || !program.reached(read)) continue;
        links.set(d.uid, {
          d,
          source,
          read,
          up: null,
          top: { kind: "own" },
          anchor: null,
          depth: 0,
          enter: 0,
          exit: 0,
          root: null,
          tree: 0,
          operand: false,
        });
      }
    // each copy's anchor: the definition its source answers with, a copy or an origin
    const callables = new Map(program.flow.callables.map((callable, index) => [callable, index]));
    const anchors = new Map<number, CopyAnchor>();
    const roots: CopyLink[] = [];
    for (const link of links.values()) {
      const answer = this.exactPath(keyOf(link.source, [ANY_PATH]), link.read);
      if (!("def" in answer)) link.top = { kind: "fail", word: answer.fail };
      else if (answer.def.kind === "whole" && answer.rest.length === 1) {
        const up = links.get(answer.def.uid);
        link.up = up ?? null;
        link.top = up === undefined ? { kind: "origin", def: answer.def } : { kind: "copy" };
        link.anchor = answer.def.uid;
        let anchor = anchors.get(answer.def.uid);
        if (anchor === undefined)
          anchors.set(
            answer.def.uid,
            (anchor = { place: link.source, depth: 0, copies: [], order: [] }),
          );
        anchor.copies.push(link);
      }
      if (link.up === null) roots.push(link);
    }
    const indexOf = (callable: Callable | null): number =>
      callable === null ? -1 : (callables.get(callable) ?? -1);
    const orderOf = (link: CopyLink): readonly [number, number] => [
      indexOf(program.callableAt(link.read)),
      program.position(link.read),
    ];
    for (const anchor of anchors.values()) {
      work.charge("exactQueries", sortCost(anchor.copies.length));
      anchor.copies.sort((x, y) => {
        const [cx, px] = orderOf(x);
        const [cy, py] = orderOf(y);
        return cx - cy || px - py;
      });
    }
    // one walk: the origins' copies in their anchors' order, each copy's own copies below it
    const children = (link: CopyLink): readonly CopyLink[] => anchors.get(link.d.uid)?.copies ?? [];
    let clock = 0;
    let trees = 0;
    // per source, its copies open on the walk, grouped by their reads' callables; a group's last copy before another
    // callable's is an exit
    const openCopies = new Map<
      PlaceId,
      { readonly callable: Callable | null; readonly links: CopyLink[] }[]
    >();
    const exitSet = new Set<CopyLink>();
    const walk = (top: readonly CopyLink[]): void => {
      const tree = trees++;
      const stack: { readonly list: readonly CopyLink[]; next: number }[] = [
        { list: top, next: 0 },
      ];
      while (stack.length > 0) {
        const level = stack.at(-1)!;
        const link = level.list[level.next];
        if (link === undefined) {
          stack.pop();
          const parent = stack.at(-1);
          if (parent !== undefined) {
            const closed = parent.list[parent.next - 1]!;
            closed.exit = clock - 1;
            const groups = openCopies.get(closed.source)!;
            groups.at(-1)!.links.pop();
            if (groups.at(-1)!.links.length === 0) groups.pop();
          }
          continue;
        }
        level.next += 1;
        work.charge("exactQueries");
        const up = link.up;
        link.enter = clock++;
        link.exit = link.enter;
        link.depth = up === null ? 0 : up.depth + 1;
        link.root = up === null ? link : up.root;
        link.tree = tree;
        link.operand = guards.operandAround(link.source, link.read);
        const callable = program.callableAt(link.read);
        let groups = openCopies.get(link.source);
        if (groups === undefined) openCopies.set(link.source, (groups = []));
        const last = groups.at(-1);
        if (last !== undefined && last.callable === callable) last.links.push(link);
        else {
          if (last !== undefined) exitSet.add(last.links.at(-1)!);
          groups.push({ callable, links: [link] });
        }
        stack.push({ list: children(link), next: 0 });
      }
    };
    // one tree per source of the origins and of the roots without a record-level definition, so a source redefined
    // many times stands in few trees
    const tops = new Map<PlaceId, CopyLink[]>();
    for (const [uid, anchor] of anchors)
      if (!links.has(uid)) {
        const list = tops.get(anchor.place);
        if (list === undefined) tops.set(anchor.place, [...anchor.copies]);
        else list.push(...anchor.copies);
      }
    const loose = new Map<PlaceId, CopyLink[]>();
    for (const root of roots)
      if (root.top.kind !== "origin") {
        const list = loose.get(root.source);
        if (list === undefined) loose.set(root.source, [root]);
        else list.push(root);
      }
    for (const list of [...tops.values(), ...loose.values()]) walk(list);
    const anchorsOf = new Map<PlaceId, CopyAnchor[]>();
    for (const [uid, anchor] of anchors) {
      const owner = links.get(uid);
      const placed: CopyAnchor = {
        ...anchor,
        depth: owner === undefined ? 0 : owner.depth + 1,
        order: anchor.copies.map((link) => link.enter),
      };
      const list = anchorsOf.get(anchor.place);
      if (list === undefined) anchorsOf.set(anchor.place, [placed]);
      else list.push(placed);
    }
    // the keys below each source, by their path and every prefix of it: as places, and as the spans of the anchors of
    // a source with one anchor, or per tree the sources with several (their anchors nested once per source)
    const at = new Map<string, Set<PlaceId>>();
    const below = new Map<string, Set<PlaceId>>();
    const atSpans = new Map<string, Span<CopyAnchor>[]>();
    const belowSpans = new Map<string, Span<CopyAnchor>[]>();
    const atSeveral = new Map<string, Map<number, Set<PlaceId>>>();
    const belowSeveral = new Map<string, Map<number, Set<PlaceId>>>();
    const treesOf = new Map<PlaceId, ReadonlySet<number>>();
    // the trees a source's anchors stand in; beyond a few, every tree (`-1`)
    const treesOfPlace = (place: PlaceId, own: readonly CopyAnchor[]): ReadonlySet<number> => {
      let trees = treesOf.get(place);
      if (trees === undefined) {
        const found = new Set(own.map((anchor) => anchor.copies[0]!.tree));
        work.charge("exactQueries", own.length);
        treesOf.set(place, (trees = found.size > FEW_TREES ? new Set([-1]) : found));
      }
      return trees;
    };
    const add = (
      places: Map<string, Set<PlaceId>>,
      spans: Map<string, Span<CopyAnchor>[]>,
      several: Map<string, Map<number, Set<PlaceId>>>,
      path: string,
      place: PlaceId,
    ): void => {
      work.charge("exactQueries");
      const set = places.get(path);
      if (set === undefined) places.set(path, new Set([place]));
      else if (set.has(place)) return;
      else set.add(place);
      const own = anchorsOf.get(place) ?? [];
      if (own.length === 1) {
        const anchor = own[0]!;
        const span = { start: anchor.order[0]!, end: anchor.copies.at(-1)!.exit, item: anchor };
        const list = spans.get(path);
        if (list === undefined) spans.set(path, [span]);
        else list.push(span);
        return;
      }
      // per tree its sources; a source whose anchors stand in more than a few trees under every tree (`-1`)
      let byTree = several.get(path);
      if (byTree === undefined) several.set(path, (byTree = new Map()));
      const inTrees = treesOfPlace(place, own);
      for (const tree of inTrees) {
        work.charge("exactQueries");
        const inTree = byTree.get(tree);
        if (inTree === undefined) byTree.set(tree, new Set([place]));
        else inTree.add(place);
      }
    };
    const sources = new Set([...links.values()].map((link) => link.source));
    for (const source of sources)
      for (const key of definitions.keysBelow(keyOf(source, []))) {
        const path = keyPath(key);
        add(at, atSpans, atSeveral, path.join("."), source);
        for (let length = 1; length <= path.length; length += 1)
          add(below, belowSpans, belowSeveral, path.slice(0, length).join("."), source);
      }
    // per source and callable, its anchored copies by dominator position, with the runs of one anchor's copies (an
    // anchor's copies in one callable are consecutive in its order, so a run is one interval of the walk)
    const placed = new Map<PlaceId, Map<number, PlacedCopies>>();
    for (const link of links.values()) {
      if (link.anchor === null) continue;
      work.charge("exactQueries");
      let byCallable = placed.get(link.source);
      if (byCallable === undefined) placed.set(link.source, (byCallable = new Map()));
      const callable = indexOf(program.callableAt(link.read));
      const entry = byCallable.get(callable);
      if (entry === undefined)
        byCallable.set(callable, { links: [link], positions: [], runEnd: [] });
      else entry.links.push(link);
    }
    for (const byCallable of placed.values())
      for (const entry of byCallable.values()) {
        work.charge("exactQueries", sortCost(entry.links.length));
        entry.links.sort((x, y) => program.position(x.read) - program.position(y.read));
        entry.positions = entry.links.map((link) => program.position(link.read));
        entry.runEnd = entry.links.map(() => 0);
        for (let index = entry.links.length - 1; index >= 0; index -= 1)
          entry.runEnd[index] =
            index + 1 < entry.links.length &&
            entry.links[index + 1]!.anchor === entry.links[index]!.anchor
              ? entry.runEnd[index + 1]!
              : index;
      }
    // the copies each tested key's branches hold: the branches merged into their outermost intervals per callable, and
    // per interval the runs of the copies of the key's place in it, once per place and interval whatever key tests it
    const markPlaces = new Map<string, Set<PlaceId>>();
    for (const { key } of guards.branchRegions()) {
      work.charge("exactQueries");
      const path = keyPath(key).join(".");
      const places = markPlaces.get(path);
      if (places === undefined) markPlaces.set(path, new Set([keyPlace(key)]));
      else places.add(keyPlace(key));
    }
    const markSpans = new Map<string, Span<number>[]>();
    const runs = new Map<string, readonly Span<number>[]>();
    // a source with several anchors is asked at the read, by its own nested anchors, per tree
    const markSeveral = new Map<string, Map<number, Set<PlaceId>>>();
    const register = (key: Key, callable: number, low: number, high: number): void => {
      if ((markPlaces.get(keyPath(key).join("."))?.size ?? 0) <= FEW_PLACES) return;
      const place = keyPlace(key);
      const own = anchorsOf.get(place) ?? [];
      if (own.length > FEW_ANCHORS) {
        const path = keyPath(key).join(".");
        let byTree = markSeveral.get(path);
        if (byTree === undefined) markSeveral.set(path, (byTree = new Map()));
        for (const tree of treesOfPlace(place, own)) {
          work.charge("exactQueries");
          const inTree = byTree.get(tree);
          if (inTree === undefined) byTree.set(tree, new Set([place]));
          else inTree.add(place);
        }
        return;
      }
      const id = `${place}|${callable}|${low}|${high}`;
      let found = runs.get(id);
      if (found === undefined) {
        const list: Span<number>[] = [];
        const entry = placed.get(place)?.get(callable);
        if (entry !== undefined) {
          const last = this.#lowerBound(entry.positions, high + 1) - 1;
          for (let index = this.#lowerBound(entry.positions, low); index <= last;) {
            work.charge("exactQueries");
            const end = Math.min(entry.runEnd[index]!, last);
            list.push({
              start: entry.links[index]!.enter,
              end: entry.links[end]!.exit,
              item: entry.links[index]!.depth,
            });
            index = end + 1;
          }
        }
        runs.set(id, (found = list));
      }
      if (found.length === 0) return;
      const path = keyPath(key).join(".");
      const list = markSpans.get(path);
      if (list === undefined) markSpans.set(path, [...found]);
      else list.push(...found);
    };
    let open: { key: Key; callable: number; low: number; high: number } | null = null;
    for (const { key, callable, entry } of guards.branchRegions()) {
      work.charge("exactQueries");
      const index = indexOf(callable);
      const low = program.position(entry);
      if (open !== null && open.key === key && open.callable === index && low <= open.high)
        continue;
      if (open !== null) register(open.key, open.callable, open.low, open.high);
      open = { key, callable: index, low, high: program.positionEnd(entry) };
    }
    if (open !== null) register(open.key, open.callable, open.low, open.high);
    // the copies each tested key's operand regions hold: per source and file, its copies read in an operand region by
    // their reads' offsets, with the runs of adjacent siblings (one interval of the walk); per key, its regions merged
    // into their outermost intervals, and per interval the runs in it, found by search
    const byOffset = new Map<
      PlaceId,
      Map<number, { readonly links: CopyLink[]; offsets: number[]; runEnd: number[] }>
    >();
    for (const link of links.values()) {
      if (!link.operand || link.read.span === null) continue;
      work.charge("exactQueries");
      let byFile = byOffset.get(link.source);
      if (byFile === undefined) byOffset.set(link.source, (byFile = new Map()));
      const entry = byFile.get(link.read.file);
      if (entry === undefined)
        byFile.set(link.read.file, { links: [link], offsets: [], runEnd: [] });
      else entry.links.push(link);
    }
    for (const byFile of byOffset.values())
      for (const entry of byFile.values()) {
        work.charge("exactQueries", sortCost(entry.links.length));
        entry.links.sort((x, y) => x.read.span!.start.offset - y.read.span!.start.offset);
        entry.offsets = entry.links.map((link) => link.read.span!.start.offset);
        entry.runEnd = entry.links.map(() => 0);
        for (let index = entry.links.length - 1; index >= 0; index -= 1) {
          const link = entry.links[index]!;
          const next = entry.links[index + 1];
          entry.runEnd[index] =
            next !== undefined && next.up === link.up && next.enter === link.exit + 1
              ? entry.runEnd[index + 1]!
              : index;
        }
      }
    const operandSpans = new Map<string, Span<number>[]>();
    for (const { key, file, regions } of guards.operandRegions()) {
      const entry = byOffset.get(keyPlace(key))?.get(file);
      if (entry === undefined) continue;
      const path = keyPath(key).join(".");
      for (let at = 0; at < regions.length;) {
        const start = regions[at]!.start;
        let end = regions[at]!.end;
        for (at += 1; at < regions.length && regions[at]!.start <= end; at += 1) {
          work.charge("exactQueries");
          end = Math.max(end, regions[at]!.end);
        }
        const last = this.#lowerBound(entry.offsets, end + 1) - 1;
        for (let index = this.#lowerBound(entry.offsets, start); index <= last;) {
          work.charge("exactQueries");
          const runEnd = Math.min(entry.runEnd[index]!, last);
          const span = {
            start: entry.links[index]!.enter,
            end: entry.links[runEnd]!.exit,
            item: entry.links[index]!.depth,
          };
          const list = operandSpans.get(path);
          if (list === undefined) operandSpans.set(path, [span]);
          else list.push(span);
          index = runEnd + 1;
        }
      }
    }
    this.#copies = {
      links,
      at,
      below,
      atSpans,
      belowSpans,
      atSeveral,
      belowSeveral,
      anchorsOf,
      placesBuilt: new Map(),
      markPlaces,
      markSeveral,
      markSpans,
      operandSpans,
      exits: exitsOf(exitSet, program),
      anchorsBuilt: new Map(),
      marksBuilt: new Map(),
    };
    return this.#copies;
  }

  /** The first index of a sorted list whose value is at least `value`: a binary search. */
  #lowerBound(list: readonly number[], value: number): number {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      this.pass.program.work.charge("exactQueries");
      if (list[middle]! < value) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** A path's spans, nested for search, once per path and index. */
  #spans<T>(
    built: Map<string, NestedSpans<T>>,
    name: string,
    path: string,
    spans: ReadonlyMap<string, readonly Span<T>[]>,
  ): NestedSpans<T> | null {
    const list = spans.get(path);
    if (list === undefined) return null;
    const key = `${name}|${path}`;
    let nested = built.get(key);
    if (nested === undefined)
      built.set(key, (nested = new NestedSpans(list, this.pass.program.work)));
    return nested;
  }

  /**
   * Where a copy's chain stops at the path `rest` (r4.38): the nearest copy at or above it whose source has a key at
   * the path, above it or below it, whose own read answers there; a chain without a record-level answer stops at its
   * root; `null` where the chain's origin answers.
   */
  #stopAt(forest: CopyForest, link: CopyLink, rest: readonly string[]): CopyLink | null {
    const candidates = [
      this.#spans(forest.anchorsBuilt, "below", rest.join("."), forest.belowSpans),
      ...rest
        .slice(0, -1)
        .map((_, index) =>
          this.#spans(
            forest.anchorsBuilt,
            "at",
            rest.slice(0, index + 1).join("."),
            forest.atSpans,
          ),
        ),
    ].map((spans) => spans?.innermost(link.enter) ?? null);
    // the sources with several anchors in the link's tree, each by its anchors nested once
    const several = [
      forest.belowSeveral.get(rest.join(".")),
      ...rest
        .slice(0, -1)
        .map((_, index) => forest.atSeveral.get(rest.slice(0, index + 1).join("."))),
    ].flatMap((byTree) => [byTree?.get(link.tree), byTree?.get(-1)]);
    for (const places of several)
      for (const place of places ?? [])
        candidates.push(this.#placeAnchors(forest, place).innermost(link.enter));
    let found: CopyAnchor | null = null;
    for (const candidate of candidates)
      if (candidate !== null && (found === null || candidate.depth > found.depth))
        found = candidate;
    if (found !== null) return this.#copyOn(found, link);
    const root = link.root!;
    if (root.top.kind === "own") return root;
    if (root.top.kind === "fail") {
      // a root without an exact definition stops at a path its source has keys at, above or below
      if (forest.below.get(rest.join("."))?.has(root.source) === true) return root;
      for (let length = 1; length < rest.length; length += 1)
        if (forest.at.get(rest.slice(0, length).join("."))?.has(root.source) === true) return root;
    }
    return null;
  }

  /** A source's anchors as the spans of their copies, nested once per source. */
  #placeAnchors(forest: CopyForest, place: PlaceId): NestedSpans<CopyAnchor> {
    let nested = forest.placesBuilt.get(place);
    if (nested === undefined)
      forest.placesBuilt.set(
        place,
        (nested = new NestedSpans(
          (forest.anchorsOf.get(place) ?? []).map((anchor) => ({
            start: anchor.order[0]!,
            end: anchor.copies.at(-1)!.exit,
            item: anchor,
          })),
          this.pass.program.work,
        )),
      );
    return nested;
  }

  /** An anchor's copy on a link's chain: the last of its copies starting at or before the link. */
  #copyOn(anchor: CopyAnchor, link: CopyLink): CopyLink {
    let low = 0;
    let high = anchor.order.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      this.pass.program.work.charge("exactQueries");
      if (anchor.order[middle]! <= link.enter) low = middle + 1;
      else high = middle;
    }
    return anchor.copies[low - 1]!;
  }

  /**
   * §3.2: whether a test of its source at the path, or at a prefix of it, guards the read of a copy from `link` up to
   * `stop` (excluded): per prefix one search of the spans of the copies a branch holds, and one of those an operand region
   * holds; a choice's selection step as the record key it reads.
   */
  #markedAlong(
    forest: CopyForest,
    link: CopyLink,
    read: readonly string[],
    stop: CopyLink | null,
  ): boolean {
    const { guards } = this.pass;
    const rest = recordPath(read);
    const floor = stop === null ? -1 : stop.depth;
    for (let length = 0; length <= rest.length; length += 1) {
      const path = rest.slice(0, length).join(".");
      const places = forest.markPlaces.get(path);
      if (places === undefined) continue;
      if (places.size > FEW_PLACES) {
        const depth = this.#spans(forest.marksBuilt, "mark", path, forest.markSpans)?.innermost(
          link.enter,
        );
        if (depth !== undefined && depth !== null && depth > floor) return true;
      }
      // each source asked: its nearest copy on the chain, whose read every other copy's of it dominates there, so a
      // test's branch that holds one of them holds it
      const asked =
        places.size > FEW_PLACES
          ? [
              ...(forest.markSeveral.get(path)?.get(link.tree) ?? []),
              ...(forest.markSeveral.get(path)?.get(-1) ?? []),
            ]
          : places;
      for (const place of asked) {
        const anchor = this.#placeAnchors(forest, place).innermost(link.enter);
        if (anchor !== null && this.#guardedDepth(forest, this.#copyOn(anchor, link), path) > floor)
          return true;
      }
    }
    // a chain without an exact definition at its root: the root's own read, as its general walk marks it
    const root = link.root!;
    if (
      stop === null &&
      root.top.kind === "fail" &&
      guards.narrowed(keyOf(root.source, rest), root.read)
    )
      return true;
    // the copies an operand region of a test of their source at the path or a prefix holds: per prefix one search
    for (let length = 0; length <= rest.length; length += 1) {
      const depth = this.#spans(
        forest.marksBuilt,
        "operand",
        rest.slice(0, length).join("."),
        forest.operandSpans,
      )?.innermost(link.enter);
      if (depth !== undefined && depth !== null && depth > floor) return true;
    }
    return false;
  }

  /**
   * The depth of the nearest copy at or above `copy`, of its source, whose read a branch of a test of the source at the
   * path holds, or -1. A chain's reads in one callable are nested in the dominator tree and a branch is a dominator
   * subtree, so a branch that holds an earlier copy's read there holds the nearest one's; a chain enters a callable once
   * (a return to one closes a copy cycle, which the walk stops). So in each callable the nearest copy decides. Each
   * tested callable is asked by its nearest copy at or above `copy` until a key's callables have been asked as often as
   * the key has exits there; then the read's own callable is, and the others by the key's guarded exits (the copies a
   * chain leaves them from: the nearest copies there of every chain that reaches another callable), nested once per
   * key. A key so costs at most its exits before its index, and its index once.
   */
  #guardedDepth(forest: CopyForest, copy: CopyLink, path: string): number {
    const { guards, program } = this.pass;
    const key = keyOf(copy.source, path === "" ? [] : path.split("."));
    const callables = guards.branchCallables(key);
    if (callables === undefined) return -1;
    const exits = this.#exitsWhenDue(forest, key, callables);
    const asked = exits === undefined ? [...callables.keys()] : [program.callableAt(copy.read)];
    let found = -1;
    for (const callable of asked) {
      program.work.charge("exactQueries");
      const nearest = this.#copiesIn(forest, copy.source, callable)?.innermost(copy.enter) ?? null;
      if (nearest !== null && nearest.depth > found && guards.branchHolds(key, nearest.read))
        found = nearest.depth;
    }
    if (exits !== undefined) found = Math.max(found, exits?.innermost(copy.enter) ?? -1);
    return found;
  }

  /**
   * A key's guarded exits once its callables have been asked one by one more often than it has exits in them, else
   * `undefined` (the asks of this read counted).
   */
  #exitsWhenDue(
    forest: CopyForest,
    key: Key,
    callables: ReadonlyMap<Callable | null, unknown>,
  ): NestedSpans<number> | null | undefined {
    if (this.#exitSpans.has(key)) return this.#exitSpans.get(key)!;
    let budget = this.#exitBudget.get(key);
    if (budget === undefined) {
      let exits = 0;
      for (const callable of callables.keys()) {
        this.pass.program.work.charge("exactQueries");
        exits += forest.exits.get(keyPlace(key))?.get(callable)?.links.length ?? 0;
      }
      this.#exitBudget.set(key, (budget = { exits, asked: 0 }));
    }
    budget.asked += callables.size;
    if (budget.asked <= budget.exits) return undefined;
    this.#exitBudget.delete(key);
    return this.#guardedExits(forest, key, callables);
  }

  /**
   * A key's guarded exits: per callable its branches stand in, the branches merged into their outermost intervals, the
   * exits of its place in an interval found by a search of their positions and taken by runs; nested once per key.
   */
  #guardedExits(
    forest: CopyForest,
    key: Key,
    callables: ReadonlyMap<Callable | null, unknown>,
  ): NestedSpans<number> | null {
    const known = this.#exitSpans.get(key);
    if (known !== undefined) return known;
    const { guards, program } = this.pass;
    const work = program.work;
    const spans: Span<number>[] = [];
    for (const callable of callables.keys()) {
      const entry = forest.exits.get(keyPlace(key))?.get(callable);
      const regions = guards.branchesOf(key, callable);
      if (entry === undefined || regions === undefined) continue;
      for (let at = 0; at < regions.list.length;) {
        const low = program.position(regions.list[at]!);
        let high = program.positionEnd(regions.list[at]!);
        for (
          at += 1;
          at < regions.list.length && program.position(regions.list[at]!) <= high;
          at += 1
        ) {
          work.charge("exactQueries");
          high = Math.max(high, program.positionEnd(regions.list[at]!));
        }
        const last = this.#lowerBound(entry.positions, high + 1) - 1;
        for (let index = this.#lowerBound(entry.positions, low); index <= last;) {
          work.charge("exactQueries");
          const end = Math.min(entry.runEnd[index]!, last);
          spans.push({
            start: entry.links[index]!.enter,
            end: entry.links[end]!.exit,
            item: entry.links[index]!.depth,
          });
          index = end + 1;
        }
      }
    }
    const nested = spans.length === 0 ? null : new NestedSpans(spans, work);
    this.#exitSpans.set(key, nested);
    return nested;
  }

  /** A source's copies read in a callable, as their intervals of the walk, nested once per source and callable. */
  #copiesIn(
    forest: CopyForest,
    source: PlaceId,
    callable: Callable | null,
  ): NestedSpans<CopyLink> | null {
    const known = this.#sourceSpans.get(source)?.get(callable);
    if (known !== undefined) return known;
    const { program } = this.pass;
    if (this.#bySource === null) {
      const bySource = new Map<PlaceId, Map<Callable | null, CopyLink[]>>();
      for (const link of forest.links.values()) {
        if (!program.reached(link.read)) continue;
        program.work.charge("exactQueries");
        let byCallable = bySource.get(link.source);
        if (byCallable === undefined) bySource.set(link.source, (byCallable = new Map()));
        const at = program.callableAt(link.read);
        const list = byCallable.get(at);
        if (list === undefined) byCallable.set(at, [link]);
        else list.push(link);
      }
      this.#bySource = bySource;
    }
    const links = this.#bySource.get(source)?.get(callable);
    if (links === undefined) return null;
    const nested = new NestedSpans(
      links.map((link) => ({ start: link.enter, end: link.exit, item: link })),
      program.work,
    );
    let byCallable = this.#sourceSpans.get(source);
    if (byCallable === undefined) this.#sourceSpans.set(source, (byCallable = new Map()));
    byCallable.set(callable, nested);
    return nested;
  }

  /** The route D's value at a path took (S3 §1): `contract` where it is a chain root's contract or a copy's below. */
  public defRoute(d: Definition, rest: readonly string[]): ReadRoute {
    return this.#defRoutes.get(`${d.uid}|${rest.join(".")}`) ?? "exact";
  }

  /** D's value at the path `rest` below its key, at D's node (§3.1's answer): once per (D, path). */
  public *defVal(d: Definition, rest: readonly string[]): Work<readonly Item[]> {
    return yield {
      key: `def|${d.uid}|${rest.join(".")}`,
      kind: "exact",
      file: d.site.file,
      offset: d.site.start,
      make: () => this.#defVal(d, rest),
    };
  }

  *#defVal(d: Definition, rest: readonly string[]): Work<readonly Item[]> {
    const { program, definitions, values, contract } = this.pass;
    const scope = program.scope;
    program.work.charge("exactValues");
    if (d.kind === "const") return rest.length === 0 ? (d.items ?? []) : [];
    const writer = definitions.writerOf(d);
    // W34: a copy at a field is its chain's value there, with the marks of the copies' reads along the chain
    const copy = d.kind === "whole" && rest.length > 0 && !rest.includes("element");
    const forest = copy ? this.#forest() : null;
    const link = forest?.links.get(d.uid);
    const routeKey = `${d.uid}|${rest.join(".")}`;
    if (forest !== null && link !== undefined) {
      const stop = this.#stopAt(forest, link, rest);
      const root = link.root!;
      let items: readonly Item[] | null = null;
      if (stop !== null && stop !== link) {
        items = yield* this.defVal(stop.d, rest);
        this.#defRoutes.set(routeKey, this.defRoute(stop.d, rest));
      } else if (stop === null && root.top.kind === "origin") {
        if (!(yield* contract.refReceiver(keyOf(root.top.def.place, rest)))) {
          items = yield* this.defVal(root.top.def, rest);
          this.#defRoutes.set(routeKey, this.defRoute(root.top.def, rest));
        }
      } else if (stop === null && root.top.kind === "fail") {
        if (!(yield* contract.refReceiver(keyOf(root.source, rest)))) {
          items = yield* contract.contractRead(keyOf(root.source, rest), root.read, root.top.word);
          this.#defRoutes.set(routeKey, "contract");
        }
      }
      if (items !== null)
        return mergeItems(
          withWriter(this.#markedAlong(forest, link, rest, stop) ? marked(items) : items, writer),
          scope,
        );
    }
    if (d.kind === "whole") {
      const items = yield* values.valueItems(d.value!, d.node, rest);
      this.#defRoutes.set(routeKey, values.valueRoute(d.value!, d.node, rest));
      return mergeItems(withWriter(items, writer), scope);
    }
    const before = yield* values.keyItems(keyOf(d.place, [...d.path, ...rest]), d.node, true);
    // F5–F7: the collection's kind is unchanged, and a dict's `values` or `keys` still a list of what it holds, whose
    // element is the dict's (r4.46 (2))
    const listed = rest.length > 0 && dictList(rest[0]!) !== undefined ? 1 : 0;
    if (rest.length === listed) return before;
    const element = rest.length === listed + 1 && rest[listed] === "element";
    // F6: no element
    if (d.kind === "clear") return element ? [EMPTY] : [];
    // F7: every element possible, maybe none
    if (d.kind === "weaken")
      return element
        ? [...weaken(withoutEmpty(before), "member"), EMPTY]
        : weaken(before, "member");
    if (rest[0] !== "element") return before;
    const own = withWriter(
      yield* values.valueItems(
        d.value!,
        (d.orig ?? d).node,
        d.how === "elements" ? rest : rest.slice(1),
      ),
      writer,
    );
    // §3.4: the element read gathers the elements before and the added ones, several elements: `member`
    const several = withoutEmpty(before).length > 0 && withoutEmpty(own).length > 0;
    const worded = (items: readonly Item[]): readonly Item[] =>
      several
        ? items.map((item) =>
            item.tag === "unknown" || item.tag === "empty"
              ? item
              : { ...item, context: firstContext(item.context, "member") },
          )
        : items;
    // F5: an `add` makes the collection hold an element; an `addAll` leaves its M unchanged, whatever its source
    if (rest.length > 1) return alternatives(worded([...before, ...own]), scope);
    const empty = d.how === "elements" && before.some((item) => item.tag === "empty");
    return alternatives(
      worded([...withoutEmpty(before), ...withoutEmpty(own), ...(empty ? [EMPTY] : [])]),
      scope,
    );
  }
}

/** The items without the emptiness mark: the kinds a value has. */
export function withoutEmpty(items: readonly Item[]): Item[] {
  return items.filter((item) => item.tag !== "empty");
}

/**
 * The answer at `rest` below a collection's selected element (`get`, a loop's visit, a removal): a selection consumes
 * only its own emptiness mark, the element's; a demanded descendant's mark passes through (#1027's B1, F12).
 */
export function belowSelected(items: readonly Item[], rest: readonly string[]): readonly Item[] {
  return rest.length === 0 ? withoutEmpty(items) : items;
}

/**
 * F28: the store that put the kinds into the key explains them; a property's absence keeps the literal that lacks it
 * (F11), and the emptiness mark has no writer.
 */
export function withWriter(items: readonly Item[], writer: Writer | null): readonly Item[] {
  if (writer === null) return items;
  return items.map((item) =>
    item.tag === "empty" || (item.tag === "unknown" && item.reasons === REASON.missing)
      ? item
      : { ...item, writer },
  );
}
