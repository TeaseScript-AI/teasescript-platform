import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import { keyOf, keyPath, keyPlace, prefixesOf, type Definition, type Key } from "./definitions.js";
import type { FlowNode } from "./flow-graph.js";
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
  /** The root of its tree, and the nearest copy at or above it that reads the same source. */
  root: CopyLink | null;
  same: CopyLink | null;
  /** The nearest copy at or above it whose read a test of its source may guard (§3.2), or `null`. */
  marked: CopyLink | null;
}

interface CopyForest {
  /** The copies by their definition. */
  readonly links: ReadonlyMap<number, CopyLink>;
  /** Per source, its copies in the walk's order. */
  readonly bySource: ReadonlyMap<PlaceId, readonly CopyLink[]>;
  /** Per path below a source, the sources with a key at that path, and those with one at it or below it. */
  readonly at: ReadonlyMap<string, ReadonlySet<PlaceId>>;
  readonly below: ReadonlyMap<string, ReadonlySet<PlaceId>>;
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
   * is resolved once per copy and projected per field: a test on a source never splits it (its marks are found at the
   * read), and a store below a source stops it only at the stored path. Per path below a source, the sources with keys
   * there; per copy, the nearest copy above it whose read a test may guard.
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
        if (read === null) continue;
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
          same: null,
          marked: null,
        });
      }
    const children = new Map<CopyLink, CopyLink[]>();
    const roots: CopyLink[] = [];
    for (const link of links.values()) {
      const answer = this.exactPath(keyOf(link.source, [ANY_PATH]), link.read);
      if (!("def" in answer)) link.top = { kind: "fail", word: answer.fail };
      else if (answer.def.kind === "whole" && answer.rest.length === 1) {
        const up = links.get(answer.def.uid);
        if (up === undefined) link.top = { kind: "origin", def: answer.def };
        else {
          link.up = up;
          link.top = { kind: "copy" };
          const list = children.get(up);
          if (list === undefined) children.set(up, [link]);
          else list.push(link);
        }
      }
      if (link.up === null) roots.push(link);
    }
    // one walk: each copy's interval, depth, root, nearest copy of its own source above it and nearest guarded read
    const bySource = new Map<PlaceId, CopyLink[]>();
    const open = new Map<PlaceId, CopyLink[]>();
    let clock = 0;
    for (const root of roots) {
      const stack: { readonly link: CopyLink; next: number }[] = [];
      const enter = (link: CopyLink): void => {
        work.charge("exactQueries");
        const parent = link.up;
        link.enter = clock++;
        link.depth = parent === null ? 0 : parent.depth + 1;
        link.root = parent === null ? link : parent.root;
        const same = open.get(link.source);
        link.same = same?.at(-1) ?? null;
        if (same === undefined) open.set(link.source, [link]);
        else same.push(link);
        link.marked = guards.testedAround(link.source, link.read) ? link : (parent?.marked ?? null);
        const list = bySource.get(link.source);
        if (list === undefined) bySource.set(link.source, [link]);
        else list.push(link);
        stack.push({ link, next: 0 });
      };
      enter(root);
      while (stack.length > 0) {
        const top = stack.at(-1)!;
        const child = children.get(top.link)?.[top.next++];
        if (child !== undefined) enter(child);
        else {
          stack.pop();
          top.link.exit = clock - 1;
          open.get(top.link.source)!.pop();
        }
      }
    }
    // the keys below each source, by their path and every prefix of it
    const at = new Map<string, Set<PlaceId>>();
    const below = new Map<string, Set<PlaceId>>();
    const add = (map: Map<string, Set<PlaceId>>, path: string, place: PlaceId): void => {
      work.charge("exactQueries");
      const set = map.get(path);
      if (set === undefined) map.set(path, new Set([place]));
      else set.add(place);
    };
    for (const source of bySource.keys())
      for (const key of definitions.keysBelow(keyOf(source, []))) {
        const path = keyPath(key);
        add(at, path.join("."), source);
        for (let length = 1; length <= path.length; length += 1)
          add(below, path.slice(0, length).join("."), source);
      }
    this.#copies = { links, bySource, at, below };
    return this.#copies;
  }

  /** The copy of `source` at or above `link`, the nearest, if any: a binary search in the source's copies. */
  #copyOf(forest: CopyForest, source: PlaceId, link: CopyLink): CopyLink | null {
    const list = forest.bySource.get(source) ?? [];
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      this.pass.program.work.charge("eventSteps");
      if (list[middle]!.enter <= link.enter) low = middle + 1;
      else high = middle;
    }
    let found = low > 0 ? list[low - 1]! : null;
    // one in a sibling tree walked before: the nearest of its own source's copies above it that holds the link
    while (found !== null && found.exit < link.enter) {
      this.pass.program.work.charge("eventSteps");
      found = found.same;
    }
    return found;
  }

  /**
   * Where a copy's chain stops at the path `rest` (r4.38): the nearest copy at or above it whose source has a key at
   * the path, above it or below it, whose own read answers there; a chain without a record-level answer stops at its
   * root; `null` where the chain's origin answers.
   */
  #stopAt(forest: CopyForest, link: CopyLink, rest: readonly string[]): CopyLink | null {
    const sources = [forest.below.get(rest.join("."))];
    for (let length = 1; length < rest.length; length += 1)
      sources.push(forest.at.get(rest.slice(0, length).join(".")));
    let stop: CopyLink | null = null;
    for (const set of sources)
      for (const source of set ?? []) {
        const found = this.#copyOf(forest, source, link);
        if (found !== null && (stop === null || found.depth > stop.depth)) stop = found;
      }
    return stop ?? (link.root!.top.kind === "own" ? link.root : null);
  }

  /** §3.2: whether a test of its source guards the read of a copy from `link` up to `stop` (excluded), at the path. */
  #markedAlong(link: CopyLink, rest: readonly string[], stop: CopyLink | null): boolean {
    const { guards } = this.pass;
    for (
      let copy = link.marked;
      copy !== null && (stop === null || copy.depth > stop.depth);
      copy = copy.up?.marked ?? null
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
    const forest = d.kind === "whole" && rest.length > 0 && !rest.includes("element");
    const link = forest ? this.#forest().links.get(d.uid) : undefined;
    if (link !== undefined) {
      const stop = this.#stopAt(this.#forest(), link, rest);
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
          withWriter(this.#markedAlong(link, rest, stop) ? marked(items) : items, writer),
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
