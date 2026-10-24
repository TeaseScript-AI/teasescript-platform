import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import {
  keyOf,
  keyPath,
  keyPlace,
  prefixesOf,
  sortCost,
  type Definition,
  type Key,
} from "./definitions.js";
import type { Callable, FlowNode } from "./flow-graph.js";
import { marked } from "./guards.js";
import {
  alternatives,
  EMPTY,
  mergeItems,
  REASON,
  weaken,
  type ContextWord,
  type Item,
  type Writer,
} from "./items.js";
import type { WorkLedger } from "./budget.js";
import type { Work } from "./solver.js";

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
  depth: number;
  enter: number;
  exit: number;
  root: CopyLink | null;
  /** The nearest copy at or above it whose read an operand region of a test of its source holds (§3.2), or `null`. */
  operand: CopyLink | null;
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
    let low = 0;
    let high = this.#start.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      this.work.charge("exactQueries");
      if (this.#start[middle]! <= point) low = middle + 1;
      else high = middle;
    }
    let at = low - 1;
    if (at < 0) return null;
    if (this.#end[at]! >= point) return this.#item[at]!;
    // the outermost interval out from it that ends before the point, then the one out from that
    for (let level = this.#jumps.length - 1; level >= 0; level -= 1) {
      this.work.charge("exactQueries");
      const out = this.#jumps[level]![at]!;
      if (out >= 0 && this.#end[out]! < point) at = out;
    }
    at = this.#jumps[0]![at]!;
    return at >= 0 && this.#end[at]! >= point ? this.#item[at]! : null;
  }
}

interface CopyForest {
  /** The copies by their definition. */
  readonly links: ReadonlyMap<number, CopyLink>;
  /** Per path below a source, the sources with a key at that path, and those with one at it or below it. */
  readonly at: ReadonlyMap<string, ReadonlySet<PlaceId>>;
  readonly below: ReadonlyMap<string, ReadonlySet<PlaceId>>;
  /** Per such path, the anchors of those sources as the spans of their copies (built as asked). */
  readonly atSpans: ReadonlyMap<string, readonly Span<CopyAnchor>[]>;
  readonly belowSpans: ReadonlyMap<string, readonly Span<CopyAnchor>[]>;
  /** Per path (`""` the source itself), the copies a test of their source at the path guards, as spans of the walk. */
  readonly markSpans: ReadonlyMap<string, readonly Span<number>[]>;
  /** The nested spans built so far, per index and path. */
  readonly anchorsBuilt: Map<string, NestedSpans<CopyAnchor>>;
  readonly marksBuilt: Map<string, NestedSpans<number>>;
}

export class ExactPath {
  readonly #memo = new Map<string, ExactAnswer>();
  #copies: CopyForest | null = null;

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
          depth: 0,
          enter: 0,
          exit: 0,
          root: null,
          operand: null,
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
    const walk = (top: readonly CopyLink[]): void => {
      const stack: { readonly list: readonly CopyLink[]; next: number }[] = [
        { list: top, next: 0 },
      ];
      while (stack.length > 0) {
        const level = stack.at(-1)!;
        const link = level.list[level.next];
        if (link === undefined) {
          stack.pop();
          const parent = stack.at(-1);
          if (parent !== undefined) parent.list[parent.next - 1]!.exit = clock - 1;
          continue;
        }
        level.next += 1;
        work.charge("exactQueries");
        const up = link.up;
        link.enter = clock++;
        link.exit = link.enter;
        link.depth = up === null ? 0 : up.depth + 1;
        link.root = up === null ? link : up.root;
        link.operand = guards.operandAround(link.source, link.read) ? link : (up?.operand ?? null);
        stack.push({ list: children(link), next: 0 });
      }
    };
    const origins = [...anchors.entries()].filter(([uid]) => !links.has(uid));
    for (const [, anchor] of origins) walk(anchor.copies);
    walk(roots.filter((link) => link.top.kind !== "origin"));
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
    const spanOf = (anchor: CopyAnchor, from: number, to: number): Span<CopyAnchor> => ({
      start: anchor.copies[from]!.enter,
      end: anchor.copies[to]!.exit,
      item: anchor,
    });
    // the keys below each source, by their path and every prefix of it, as places and as the spans of their anchors
    const at = new Map<string, Set<PlaceId>>();
    const below = new Map<string, Set<PlaceId>>();
    const atSpans = new Map<string, Span<CopyAnchor>[]>();
    const belowSpans = new Map<string, Span<CopyAnchor>[]>();
    const add = (
      places: Map<string, Set<PlaceId>>,
      spans: Map<string, Span<CopyAnchor>[]>,
      path: string,
      place: PlaceId,
    ): void => {
      work.charge("exactQueries");
      const set = places.get(path);
      if (set === undefined) places.set(path, new Set([place]));
      else if (set.has(place)) return;
      else set.add(place);
      for (const anchor of anchorsOf.get(place) ?? []) {
        work.charge("exactQueries");
        const list = spans.get(path);
        const span = spanOf(anchor, 0, anchor.copies.length - 1);
        if (list === undefined) spans.set(path, [span]);
        else list.push(span);
      }
    };
    const sources = new Set([...links.values()].map((link) => link.source));
    for (const source of sources)
      for (const key of definitions.keysBelow(keyOf(source, []))) {
        const path = keyPath(key);
        add(at, atSpans, path.join("."), source);
        for (let length = 1; length <= path.length; length += 1)
          add(below, belowSpans, path.slice(0, length).join("."), source);
      }
    // the copies each test's branch holds: per anchor of the tested key's place, one span of consecutive copies
    const markSpans = new Map<string, Span<number>[]>();
    for (const { key, callable, entry } of guards.branchRegions()) {
      work.charge("exactQueries");
      const index = indexOf(callable);
      const low = program.position(entry);
      const high = program.positionEnd(entry);
      for (const anchor of anchorsOf.get(keyPlace(key)) ?? []) {
        const first = this.#firstCopy(anchor, orderOf, index, low);
        const last = this.#firstCopy(anchor, orderOf, index, high + 1) - 1;
        if (first > last) continue;
        const path = keyPath(key).join(".");
        const list = markSpans.get(path);
        const span = {
          start: anchor.copies[first]!.enter,
          end: anchor.copies[last]!.exit,
          item: anchor.depth,
        };
        if (list === undefined) markSpans.set(path, [span]);
        else list.push(span);
      }
    }
    this.#copies = {
      links,
      at,
      below,
      atSpans,
      belowSpans,
      markSpans,
      anchorsBuilt: new Map(),
      marksBuilt: new Map(),
    };
    return this.#copies;
  }

  /** The first of an anchor's copies at or after a callable and a dominator position: a binary search. */
  #firstCopy(
    anchor: CopyAnchor,
    orderOf: (link: CopyLink) => readonly [number, number],
    callable: number,
    position: number,
  ): number {
    let low = 0;
    let high = anchor.copies.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      this.pass.program.work.charge("exactQueries");
      const [c, p] = orderOf(anchor.copies[middle]!);
      if (c < callable || (c === callable && p < position)) low = middle + 1;
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
    let found: CopyAnchor | null = null;
    for (const candidate of candidates)
      if (candidate !== null && (found === null || candidate.depth > found.depth))
        found = candidate;
    if (found !== null) {
      // its copy on the chain: the last of its copies starting at or before the link
      let low = 0;
      let high = found.order.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        this.pass.program.work.charge("exactQueries");
        if (found.order[middle]! <= link.enter) low = middle + 1;
        else high = middle;
      }
      return found.copies[low - 1]!;
    }
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

  /**
   * §3.2: whether a test of its source at the path, or at a prefix of it, guards the read of a copy from `link` up to
   * `stop` (excluded): per prefix one search of the spans of the copies a branch holds, then the copies an operand region
   * may hold, walked.
   */
  #markedAlong(
    forest: CopyForest,
    link: CopyLink,
    rest: readonly string[],
    stop: CopyLink | null,
  ): boolean {
    const floor = stop === null ? -1 : stop.depth;
    for (let length = 0; length <= rest.length; length += 1) {
      const depth = this.#spans(
        forest.marksBuilt,
        "mark",
        rest.slice(0, length).join("."),
        forest.markSpans,
      )?.innermost(link.enter);
      if (depth !== undefined && depth !== null && depth > floor) return true;
    }
    const { guards } = this.pass;
    for (
      let copy = link.operand;
      copy !== null && copy.depth > floor;
      copy = copy.up?.operand ?? null
    )
      if (guards.narrowed(keyOf(copy.source, rest), copy.read)) return true;
    return false;
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
    if (forest !== null && link !== undefined) {
      const stop = this.#stopAt(forest, link, rest);
      const root = link.root!;
      let items: readonly Item[] | null = null;
      if (stop !== null && stop !== link) items = yield* this.defVal(stop.d, rest);
      else if (stop === null && root.top.kind === "origin") {
        if (!(yield* contract.refReceiver(keyOf(root.top.def.place, rest))))
          items = yield* this.defVal(root.top.def, rest);
      } else if (stop === null && root.top.kind === "fail") {
        if (!(yield* contract.refReceiver(keyOf(root.source, rest))))
          items = yield* contract.contractRead(keyOf(root.source, rest), root.read, root.top.word);
      }
      if (items !== null)
        return mergeItems(
          withWriter(this.#markedAlong(forest, link, rest, stop) ? marked(items) : items, writer),
          scope,
        );
    }
    if (d.kind === "whole")
      return mergeItems(
        withWriter(yield* values.valueItems(d.value!, d.node, rest), writer),
        scope,
      );
    const before = yield* values.keyItems(keyOf(d.place, [...d.path, ...rest]), d.node, true);
    // F5–F7: the collection's kind is unchanged
    if (rest.length === 0) return before;
    const element = rest.length === 1 && rest[0] === "element";
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
    // F5: an `add` makes the collection hold an element; an `addAll` leaves its M unchanged, whatever its source
    if (rest.length > 1) return alternatives([...before, ...own], scope);
    const empty = d.how === "elements" && before.some((item) => item.tag === "empty");
    return alternatives(
      [...withoutEmpty(before), ...withoutEmpty(own), ...(empty ? [EMPTY] : [])],
      scope,
    );
  }
}

/** The items without the emptiness mark: the kinds a value has. */
export function withoutEmpty(items: readonly Item[]): Item[] {
  return items.filter((item) => item.tag !== "empty");
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
