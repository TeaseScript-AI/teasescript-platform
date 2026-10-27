import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import { joinParts, keepText, type WorkLedger } from "./budget.js";
import {
  keyPath,
  keyPlace,
  prefixesOf,
  sortCost,
  type Definition,
  type Key,
} from "./definitions.js";
import type { FlowNode } from "./flow-graph.js";
import type { ItemTag } from "./items.js";
import {
  locationOf,
  pathKey,
  removes,
  stablePath,
  type NarrowingIndex,
  type StablePath,
} from "./narrowing.js";
import {
  countIn,
  lowerBound,
  type StatementTree,
  type TreeBlock,
  type TreeStatement,
} from "./narrowing-statements.js";
import { propertyName } from "./program.js";

/*
 * N3's route query of stage 3b (checkpoint 9, TABLE §13 N3, N3a, §13.3): a consumer of key k at node n that needs a
 * kind k's contract does not guarantee (`null`, or a member of a written union) has a route without a check when an
 * exact definition D′ of k certifies the offending item and reaches n through an open corridor. Per key and offending
 * kind, built once on the key's first question:
 * - the **sparse per-key layer**: the statements that kill k (a whole store of k or a prefix), the blocking tests of the
 *   needed form (every live arm starts with a narrowing that removes the kind, or is closed), and the branches and loops
 *   every live alternative of which those close beside the shared layer (`narrowing-statements.ts`), computed over the
 *   statements holding a definition or a test of k and their ancestors: events and tests times the nesting depth;
 * - the **candidates kept at the key they store**: k's own definitions that certify the kind, and each prefix's whole
 *   stores, projected only for the one candidate examined; each with the reach of its writer side (the outermost block
 *   its open writer segments reach), so a consumer finds the nearest candidate whose writer side reaches it by one
 *   binary search over a tree of reaches, never a backward scan.
 * A consumer's query examines that one candidate: its certification (a seed, a certified `otherwise`, a scalar copy
 * whose source read has a certified witness by this same query, memoised per node and key), then the corridor's
 * remaining segments (the middle and the consumer side), each one binary search per layer, and the consumer's own
 * statement's compulsory calls (the nearest call-in dominating n). An unsuitable candidate yields the warning.
 */

/** A candidate D′ of a key: its definition, where it stands, and the end of the block its writer side reaches. */
interface Candidate {
  readonly def: Definition;
  readonly chain: readonly Place[];
  readonly start: number;
  readonly reach: number;
}

/** Where a statement stands: its block and index, from a callable's body down (a definition before the body: -1). */
interface Place {
  readonly block: TreeBlock;
  readonly index: number;
}

/** A key's candidates in one callable's body, by where they start, with a tree of the maximum reach below each node. */
interface Candidates {
  readonly list: readonly Candidate[];
  readonly starts: readonly number[];
  readonly reaches: readonly number[];
  readonly size: number;
}

/** A key's per-key layer for one offending kind: per block, the indexes of the statements it closes, sorted. */
interface Layer {
  readonly closed: ReadonlyMap<number, readonly number[]>;
  /** The shared layer's applicability for the key: calls close only where an owner lies outside its activation. */
  readonly calls: boolean;
}

/** A literal's kind as N3's seeds read it: `null`, a whole or fractional number, text, a truth value. */
function literalTag(program: CorePass["program"], value: PlaceId): ItemTag | null {
  const kind = program.places[value]?.kind;
  if (kind?.kind !== "value") return null;
  if (kind.node === "nullLiteral") return "null";
  if (
    kind.node !== "numberLiteral" &&
    kind.node !== "stringLiteral" &&
    kind.node !== "booleanLiteral"
  )
    return null;
  for (const has of program.hasOf.get(value) ?? [])
    if (has.type.kind === "atom") return has.type.name;
  return null;
}

export class NarrowingRoutes {
  readonly #layers = new Map<string, Layer>();
  /** Per (key, offending kind) its certified own definitions, and per key (`*`) its whole stores, by callable body. */
  readonly #candidates = new Map<string, ReadonlyMap<TreeBlock, Candidates>>();
  /** Per (key, node, offending kind): the witness found, or `null`. */
  readonly #witnesses = new Map<string, Definition | null>();
  /** Per object literal: its properties' places by name, made on its first projection. */
  readonly #properties = new Map<PlaceId, ReadonlyMap<string, PlaceId>>();

  public constructor(
    readonly pass: CorePass,
    readonly index: NarrowingIndex,
    readonly tree: StatementTree,
  ) {}

  get #work(): WorkLedger {
    return this.pass.program.work;
  }

  /**
   * N3 (iii): an exact definition D′ of `key` that certifies `tag` and reaches `node` without a check, or `null` when the
   * compiler proves no such route (the consumer then warns with its check). The witness of a copy or an `otherwise`
   * asks this same query of its source, one memoised query per node and key, resolved without native recursion.
   */
  public witness(key: Key, tag: ItemTag, node: FlowNode): Definition | null {
    // a chain of copies: each query waits on its source's, the last first
    const waiting: { readonly memo: string; readonly found: Candidate }[] = [];
    let memo = joinParts(key, node.id, tag);
    let answer: Definition | null;
    for (;;) {
      const known = this.#witnesses.get(memo);
      if (known !== undefined) {
        answer = known;
        break;
      }
      // (a query met again on its own chain proves nothing)
      keepText(this.#work, memo.length);
      this.#witnesses.set(memo, null);
      const found = this.#examined(key, tag, node);
      const source = found === null ? false : this.#certificate(found, key, tag);
      if (found === null || source === false) {
        answer = null;
        break;
      }
      if (source === true) {
        this.#witnesses.set(memo, found.def);
        answer = found.def;
        break;
      }
      waiting.push({ memo, found });
      ({ key, tag, node } = source);
      memo = joinParts(key, node.id, tag);
    }
    // each copy is certified exactly when its source's read is
    while (waiting.length > 0) {
      const { memo: waited, found } = waiting.pop()!;
      answer = answer === null ? null : found.def;
      this.#witnesses.set(waited, answer);
    }
    return answer;
  }

  /**
   * The one candidate a consumer examines, when its corridor is open: the nearest of the key's own certified
   * definitions and each prefix's whole stores whose writer side reaches the read, then the corridor checked whole.
   */
  #examined(key: Key, tag: ItemTag, node: FlowNode): Candidate | null {
    const { program, handlers } = this.pass;
    program.work.charge("exactQueries");
    if (!program.live(node) || program.blockReachable(node) || node.span === null) return null;
    // X7 as the flat veto it is: a handler store of the key with a registration before the read
    if (handlers.handlerTouches(key) && handlers.afterSomeCreation(node)) return null;
    // positions and members are not facts: no element key and no reference member has a route
    if (keyPath(key).includes("element")) return null;
    const chain = this.#chainOf(node);
    if (chain === null) return null;
    const body = chain[0]!.block;
    const at = node.span.start.offset;
    let best: Candidate | null = null;
    const consider = (lists: ReadonlyMap<TreeBlock, Candidates>): void => {
      const candidates = lists.get(body);
      const found = candidates === undefined ? null : this.#last(candidates, at);
      if (found !== null && (best === null || found.start > best.start)) best = found;
    };
    consider(this.#ownCandidates(key, tag));
    for (const prefix of prefixesOf(key)) consider(this.#wholeStores(prefix));
    const found: Candidate | null = best;
    if (found === null) return null;
    return this.#open(key, tag, found, chain, node) ? found : null;
  }

  /**
   * Whether a candidate certifies the offending item for `key` (N3 (iii), N3a): `true` for a seed, `false` when it is
   * refused, or the read whose own witness certifies it (a scalar copy's source, an `otherwise`'s left operand).
   */
  #certificate(
    found: Candidate,
    key: Key,
    tag: ItemTag,
  ): boolean | { readonly key: Key; readonly tag: ItemTag; readonly node: FlowNode } {
    const { program, definitions, lists } = this.pass;
    const d = found.def;
    program.work.charge("exactQueries");
    // X3's exact definitions only: never a weak store, an element or dict key, a return, a multi-site argument
    if (
      d.kind !== "whole" ||
      d.weak ||
      d.value === undefined ||
      d.how === "return" ||
      ((d.how === "argument" || d.how === "parameter default") && !lists.singleSite(d.fn)) ||
      !lists.certain(d)
    )
      return false;
    // a whole store of a prefix answers below it only through its literal's properties, to a seed
    const rest = keyPath(key).slice(d.path.length);
    let value: PlaceId = d.value;
    for (const step of rest) {
      program.work.charge("exactQueries");
      const property = this.#property(value, propertyName(step));
      if (property === undefined) return false;
      value = property;
    }
    if (literalTag(program, value) === tag) {
      // a parameter's default is selected where the call omits the argument: its one call site binds none
      return (
        d.how !== "parameter default" ||
        !(definitions.byKey.get(d.key) ?? []).some((other) => other.how === "argument")
      );
    }
    const c = program.opOf.get(value);
    // `load(key, default: …)`: storage may lack the key on any run (the storage premise)
    if (c?.kind === "load") return c.fallback !== null && literalTag(program, c.fallback) === tag;
    if (rest.length > 0) return false;
    // `a otherwise <literal>`: live, and selected where `a`'s own `null` is certified at that node
    if (c?.kind === "fallback") {
      const right = program.places[c.right]?.site;
      const fallback = right === undefined || right === null ? null : program.exprAt(right);
      if (literalTag(program, c.right) !== tag || fallback === null || !program.live(fallback))
        return false;
      const read = this.#scalarRead(c.left);
      return read === null ? false : { key: read.key, tag: "null", node: read.node };
    }
    // a scalar copy whose source read has a certified witness
    const read = this.#scalarRead(value);
    return read === null ? false : { key: read.key, tag, node: read.node };
  }

  /** A read of a stable path without element steps: its key and node. */
  #scalarRead(value: PlaceId): { readonly key: Key; readonly node: FlowNode } | null {
    const program = this.pass.program;
    const site = program.places[value]?.site;
    const node = site === undefined || site === null ? null : program.exprAt(site);
    const expression = node?.expression;
    if (node === null || expression === undefined) return null;
    const path: StablePath | null = stablePath(program, node.file, expression);
    if (path === null || path.steps.some((step) => step.kind !== "property")) return null;
    return { key: pathKey(path), node };
  }

  /** An object literal's property's stored value, by name. */
  #property(literal: PlaceId, name: string): PlaceId | undefined {
    const { program, definitions } = this.pass;
    let known = this.#properties.get(literal);
    if (known === undefined) {
      const made = new Map<string, PlaceId>();
      for (const has of program.hasOf.get(literal) ?? []) {
        if (has.type.kind !== "object" || has.type.properties === null) continue;
        for (const property of has.type.properties) {
          program.work.charge("indexSteps");
          if (property.type.kind === "ref") made.set(property.name, property.type.place);
        }
      }
      this.#properties.set(literal, (known = made));
    }
    const place = known.get(name);
    return place === undefined ? undefined : definitions.cellDefs.get(place)?.[0]?.value;
  }

  /** Where a node's statement stands, from its callable's body down, or `null` outside the bodies. */
  #chainOf(node: FlowNode): Place[] | null {
    const tree = this.tree;
    const body = tree.root(node.region);
    if (body === undefined) return null;
    // a callable's parameters and their defaults stand before its body
    if (node.kind === "parameter" || node.span === null) return [{ block: body, index: -1 }];
    const statement = tree.statementAt(node.file, node.span.start.offset);
    const chain = statement === null ? [] : this.#up(statement);
    return chain.length > 0 && chain[0]!.block === body ? chain : [{ block: body, index: -1 }];
  }

  /** A statement's places from its callable's body down to it. */
  #up(statement: TreeStatement): Place[] {
    const chain: Place[] = [];
    for (let at: TreeStatement | null = statement; at !== null; at = at.block.owner) {
      this.#work.charge("eventSteps");
      chain.push({ block: at.block, index: at.index });
    }
    return chain.reverse();
  }

  /** Whether a segment of a block, statements `low` to `high` exclusive, holds a closed statement in either layer. */
  #closed(
    block: TreeBlock,
    low: number,
    high: number,
    layer: Layer | null,
    calls: boolean,
  ): boolean {
    this.#work.charge("eventSteps", 2);
    if (countIn(calls ? block.calls : block.leaves, low, high) > 0) return true;
    const own = layer?.closed.get(block.id);
    return own !== undefined && countIn(own, low, high) > 0;
  }

  /**
   * The end of the block a definition's open writer side reaches (N3 (a)): from its statement up, each block's
   * statements after the one left open; out of a loop's body only where its header leaves it, its header open.
   */
  #reach(chain: readonly Place[], layer: Layer | null, calls: boolean): number {
    for (let level = chain.length - 1; level >= 0; level -= 1) {
      const { block, index } = chain[level]!;
      if (this.#closed(block, index + 1, block.statements.length, layer, calls)) return block.end;
      const owner = block.owner;
      if (owner === null) return Infinity;
      if (!this.#leaves(owner, calls)) return block.end;
    }
    return Infinity;
  }

  /** Whether a round of a loop's body reaches the code after it: its header leaves it, and calls in it are open. */
  #leaves(owner: TreeStatement, calls: boolean): boolean {
    return owner.loop === null || (owner.exits && !(calls && owner.called));
  }

  /**
   * The corridor from a candidate to the read (N3 (a)–(e)): one boundary; the read's statement after the candidate's
   * in the lowest block they share; the writer side up to it, the statements between, and on the consumer side each
   * entered block's statements before the read's, all open in both layers; and no call-in a possible overwriter makes
   * between the read's top statement and the read on every route (the headers entered, the read's own statement).
   */
  #open(
    key: Key,
    tag: ItemTag,
    found: Candidate,
    chain: readonly Place[],
    node: FlowNode,
  ): boolean {
    const { program } = this.pass;
    const d = found.def;
    if (!program.live(d.node) || program.dom.edom(d.node) !== program.dom.edom(node)) return false;
    const layer = this.#layer(key, tag);
    const writer = found.chain;
    let level = 0;
    while (
      level < writer.length &&
      level < chain.length &&
      writer[level]!.block === chain[level]!.block &&
      writer[level]!.index === chain[level]!.index
    )
      level += 1;
    // (b): the read's statement after the candidate's in their lowest shared block, never a sibling arm
    if (level >= writer.length || level >= chain.length) return false;
    const shared = writer[level]!.block;
    if (chain[level]!.block !== shared || chain[level]!.index <= writer[level]!.index) return false;
    // (a): the writer side, from the candidate's block up to the shared one, out of a loop through its header
    for (let up = writer.length - 1; up > level; up -= 1) {
      const { block, index } = writer[up]!;
      if (this.#closed(block, index + 1, block.statements.length, layer, layer.calls)) return false;
      if (block.owner !== null && !this.#leaves(block.owner, layer.calls)) return false;
    }
    // (c): the statements between
    if (this.#closed(shared, writer[level]!.index + 1, chain[level]!.index, layer, layer.calls))
      return false;
    // (d): each entered block's statements before the read's
    for (let down = level + 1; down < chain.length; down += 1) {
      const { block, index } = chain[down]!;
      if (this.#closed(block, 0, index, layer, layer.calls)) return false;
    }
    // (d), (e): a compulsory call before the read inside its top statement (a header entered, an earlier operand)
    if (layer.calls) {
      const call = this.tree.nearestCall(node);
      const top = chain[level]!;
      const statement = top.block.statements[top.index];
      if (
        call !== null &&
        call.span !== null &&
        statement !== undefined &&
        call.file === statement.file &&
        call.span.start.offset >= statement.start &&
        call.span.start.offset <= statement.end
      )
        return false;
    }
    return true;
  }

  /**
   * The per-key layer of a key and offending kind (N3, §13.3): kills of the key and its prefixes, blocking tests of
   * the needed form, and the branches and loops they close beside the shared layer, built once.
   */
  #layer(key: Key, tag: ItemTag): Layer {
    const memo = joinParts(key, tag);
    const known = this.#layers.get(memo);
    if (known !== undefined) return known;
    const { program, definitions, lists } = this.pass;
    const work = program.work;
    const calls = definitions.ownedAway(key);
    const variant = calls ? "calls" : "leaves";
    const closed = new Set<TreeStatement>();
    const counts = new Map<number, number>();
    const location = this.#location(key);
    const armClosed = (arm: TreeBlock): boolean =>
      arm[variant].length > 0 || (counts.get(arm.id) ?? 0) > 0;
    const starts = (arm: TreeBlock): boolean =>
      location !== null &&
      arm.entry !== null &&
      this.index.atEntry(arm.entry).some((g) => g.location === location && removes(g.form, tag));
    const pending: TreeStatement[] = [];
    const mark = (statement: TreeStatement): void => {
      if (closed.has(statement) || statement[variant]) return;
      closed.add(statement);
      counts.set(statement.block.id, (counts.get(statement.block.id) ?? 0) + 1);
      if (statement.block.owner !== null) pending.push(statement.block.owner);
    };
    // the compound statements a kill or a test of the key stands in, until one stays open
    const check = (statement: TreeStatement): void => {
      work.charge("indexSteps", statement.arms.length + 1);
      if (
        closed.has(statement) ||
        statement[variant] ||
        statement.skip ||
        statement.arms.length === 0
      )
        return;
      const live = statement.arms.filter((arm) => arm.entry === null || program.live(arm.entry));
      if (live.every((arm) => armClosed(arm) || starts(arm))) mark(statement);
    };
    // kills: a whole store or fixed value of the key or a prefix where it stands
    for (const killed of [key, ...prefixesOf(key)])
      for (const d of definitions.byKey.get(killed) ?? []) {
        work.charge("indexSteps");
        if (
          (d.kind !== "whole" && d.kind !== "const") ||
          d.weak ||
          !lists.live(d) ||
          !program.live(d.node) ||
          d.node.span === null ||
          d.node.statement === undefined
        )
          continue;
        const statement = this.tree.statementAt(d.node.file, d.node.span.start.offset);
        if (statement !== null) mark(statement);
        while (pending.length > 0) check(pending.pop()!);
      }
    // blocking tests: the branches whose arms a narrowing of the key's location enters
    if (location !== null)
      for (const g of this.index.definitionsOf(location)) {
        work.charge("indexSteps");
        const owner = this.tree.armAt(g.node)?.owner;
        if (owner !== undefined && owner !== null) check(owner);
        while (pending.length > 0) check(pending.pop()!);
      }
    const byBlock = new Map<number, number[]>();
    for (const statement of closed) {
      work.charge("indexSteps");
      const list = byBlock.get(statement.block.id);
      if (list === undefined) byBlock.set(statement.block.id, [statement.index]);
      else list.push(statement.index);
    }
    for (const list of byBlock.values()) {
      work.charge("indexSteps", sortCost(list.length));
      list.sort((a, b) => a - b);
    }
    const layer: Layer = { closed: byBlock, calls };
    keepText(work, memo.length);
    this.#layers.set(memo, layer);
    return layer;
  }

  /** The refined location of a key without element steps: its properties' texts. */
  #location(key: Key): string | null {
    const steps = keyPath(key);
    if (steps.includes("element")) return null;
    return locationOf({
      root: keyPlace(key),
      steps: steps.map((step) => ({ kind: "property", name: propertyName(step) })),
    });
  }

  /** A key's own exact definitions that certify `tag` where they stand (a seed or a certified read), by callable body. */
  #ownCandidates(key: Key, tag: ItemTag): ReadonlyMap<TreeBlock, Candidates> {
    const memo = joinParts(key, tag);
    const known = this.#candidates.get(memo);
    if (known !== undefined) return known;
    const layer = this.#layer(key, tag);
    const made = this.#candidateLists(
      (this.pass.definitions.byKey.get(key) ?? []).filter((d) => this.#carries(d, tag)),
      layer,
      layer.calls,
    );
    keepText(this.#work, memo.length);
    this.#candidates.set(memo, made);
    return made;
  }

  /** Whether a definition's own expression could certify `tag` (the seeds, loads, `otherwise` and copies). */
  #carries(d: Definition, tag: ItemTag): boolean {
    const program = this.pass.program;
    this.#work.charge("indexSteps");
    if (d.kind !== "whole" || d.weak || d.value === undefined) return false;
    const literal = literalTag(program, d.value);
    if (literal !== null) return literal === tag;
    const c = program.opOf.get(d.value);
    if (c?.kind === "load") return c.fallback !== null && literalTag(program, c.fallback) === tag;
    if (c?.kind === "fallback") return literalTag(program, c.right) === tag;
    return this.#scalarRead(d.value) !== null;
  }

  /** A prefix's whole stores, by callable body, their reach by the shared layer alone (checked whole when examined). */
  #wholeStores(prefix: Key): ReadonlyMap<TreeBlock, Candidates> {
    const memo = joinParts(prefix, "*");
    const known = this.#candidates.get(memo);
    if (known !== undefined) return known;
    const made = this.#candidateLists(
      (this.pass.definitions.byKey.get(prefix) ?? []).filter(
        (d) => d.kind === "whole" && !d.weak && d.value !== undefined,
      ),
      null,
      false,
    );
    keepText(this.#work, memo.length);
    this.#candidates.set(memo, made);
    return made;
  }

  /** Candidates by callable body, sorted by where they start, with a tree of their reaches' maxima. */
  #candidateLists(
    definitions: readonly Definition[],
    layer: Layer | null,
    calls: boolean,
  ): ReadonlyMap<TreeBlock, Candidates> {
    const { program, lists } = this.pass;
    const work = program.work;
    const byBody = new Map<TreeBlock, Candidate[]>();
    for (const d of definitions) {
      work.charge("indexSteps");
      if (!lists.live(d) || !program.live(d.node) || program.inBlockCode(d.node)) continue;
      const chain = this.#chainOf(d.node);
      if (chain === null) continue;
      const last = chain.at(-1)!;
      const statement = last.index < 0 ? undefined : last.block.statements[last.index];
      const candidate: Candidate = {
        def: d,
        chain,
        start: statement?.start ?? -1,
        reach: this.#reach(chain, layer, calls),
      };
      const list = byBody.get(chain[0]!.block);
      if (list === undefined) byBody.set(chain[0]!.block, [candidate]);
      else list.push(candidate);
    }
    const made = new Map<TreeBlock, Candidates>();
    for (const [body, list] of byBody) {
      work.charge("indexSteps", sortCost(list.length) + 2 * list.length);
      list.sort((a, b) => a.start - b.start || a.def.site.start - b.def.site.start);
      let size = 1;
      while (size < list.length) size <<= 1;
      const reaches = new Array<number>(2 * size).fill(-Infinity);
      list.forEach((candidate, index) => (reaches[size + index] = candidate.reach));
      for (let index = size - 1; index >= 1; index -= 1)
        reaches[index] = Math.max(reaches[2 * index]!, reaches[2 * index + 1]!);
      made.set(body, { list, starts: list.map((candidate) => candidate.start), reaches, size });
    }
    return made;
  }

  /** The last candidate starting before `at` whose writer side reaches `at`: a binary search and a descent. */
  #last(candidates: Candidates, at: number): Candidate | null {
    const work = this.#work;
    const before = lowerBound(candidates.starts, at);
    work.charge("eventSteps", Math.ceil(Math.log2(candidates.list.length + 1)) + 1);
    const { reaches, size } = candidates;
    // the rightmost leaf below `before` whose reach is at least `at`
    const search = (node: number, low: number, high: number): number => {
      work.charge("eventSteps");
      if (low >= before || reaches[node]! < at) return -1;
      if (high - low === 1) return low;
      const middle = (low + high) >> 1;
      const right = search(2 * node + 1, middle, high);
      return right >= 0 ? right : search(2 * node, low, middle);
    };
    const found = search(1, 0, size);
    return found < 0 ? null : candidates.list[found]!;
  }
}
